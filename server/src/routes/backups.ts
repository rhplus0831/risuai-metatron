import type { Dirent } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { DatabaseSync } from "node:sqlite";
import { type BackupArchiveManifest, RESOURCE_EPOCH_HEADER, RESOURCE_KIND } from "../../../shared/resources.ts";
import { selectPartialBackupAssets } from "../../../shared/backups.ts";
import {
    ArchiveFormatError,
    ArchiveRejectedError,
    copyRecordToFile,
    encodeRecordHeader,
    indexArchive,
    MAX_ARCHIVE_RECORD_BYTES,
    MAX_ARCHIVE_RECORDS,
    readRecord,
} from "../data/archive.ts";
import {
    ResourceEpochError,
    type ResourceStore,
    ResourceValidationError,
    type ValidatedSnapshot,
} from "../data/resourceStore.ts";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import { readJsonBody } from "../http/body.ts";
import { createImportSlot, type ImportSlot } from "../http/fileImport.ts";
import { fileRecord, iteratorStream } from "../http/recordStream.ts";
import { makeStaging, spool } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { decodeFileName, resolveStorageKey } from "./storage.ts";

export const BACKUP_IMPORT_PATH = "/api/backups/import";
/** Default cap on an uploaded archive or module file; `RISU_MAX_IMPORT_BYTES` overrides it. */
export const DEFAULT_MAX_IMPORT_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PARTIAL_ASSETS = 100_000;
const ASSET_PREFIX = "assets/";

/**
 * Server snapshots and local backup archives:
 * - `GET /api/backups`: the retained snapshots, newest first.
 * - `POST /api/backups/:id/restore`: replaces every resource with a snapshot (safety snapshot first,
 *   mutations closed, new epoch).
 * - `POST /api/backups/export` `{ partial?: true | string[] }`: streams an archive of a fresh snapshot
 *   and assets (all files, profiles selected from that snapshot for `true`, or the listed keys).
 * - `POST /api/backups/import`: an archive as the raw body, spooled to disk (exempt from the global
 *   body limit, capped by `maxImportBytes`), validated completely, then its missing assets are added
 *   (existing files are never overwritten) and the resources restored like a snapshot.
 * Restore and import are mutations: they need the current epoch in `x-resource-epoch`. The upstream
 * RisuAI import (`routes/backupsUpstream.ts`) shares the import's slot and its restore steps
 * (`restoreValidated`).
 */
export function registerBackupRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        store: ResourceStore;
        snapshots: SnapshotManager;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maxImportBytes: number;
        /** The diagnostics journal: a `lifecycle` event after a restore or an import replaced the data. */
        diagnostics?: DiagnosticsRecorder;
        /** The backup import's slot, shared with the upstream import; a slot of its own without one. */
        slot?: ImportSlot;
        /** Most records of an imported archive (default `MAX_ARCHIVE_RECORDS`; tests lower it). */
        maxArchiveRecords?: number;
    },
) {
    const { savePath, store, snapshots, auth, limiter, maxImportBytes, diagnostics, maxArchiveRecords } = arg;
    const tmpPath = path.join(savePath, ".tmp");
    const assetsPath = path.join(savePath, "assets");
    const slot = arg.slot ?? createImportSlot();

    app.get("/api/backups", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        c.header("Cache-Control", "no-store");
        return c.json({ items: snapshots.list() });
    });

    app.post("/api/backups/:id/restore", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const expectedEpoch = c.req.header(RESOURCE_EPOCH_HEADER);
        try {
            store.assertEpoch(expectedEpoch);
            const epoch = await snapshots.track(() =>
                snapshots.withMaintenance(async ({ snapshot }) => {
                    // Again once the lock is held: a restore queued behind another one is stale, and
                    // nothing of it (safety snapshot, validation) should run.
                    store.assertEpoch(expectedEpoch);
                    const file = snapshots.resolve(c.req.param("id"));
                    if (file === null) {
                        return null;
                    }
                    const validated = store.readSnapshot(file);
                    await snapshot();
                    store.assertEpoch(expectedEpoch);
                    return store.replaceAll(validated);
                }),
            );
            if (epoch === null) {
                return c.json({ error: "Snapshot not found" }, 404);
            }
            recordSafely(diagnostics, { kind: "lifecycle", phase: "restore" });
            return c.json({ epoch });
        } catch (error) {
            return backupErrorResponse(c, error);
        }
    });

    app.post("/api/backups/export", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const partial = parsed.body.partial;
        if (
            partial !== undefined &&
            partial !== true &&
            (!Array.isArray(partial) ||
                partial.length > MAX_PARTIAL_ASSETS ||
                !partial.every(
                    (key) =>
                        typeof key === "string" &&
                        key.startsWith(ASSET_PREFIX) &&
                        resolveStorageKey(savePath, key) !== null,
                ))
        ) {
            return c.json({ error: "partial must be a list of asset keys" }, 400);
        }

        // The export's lifetime (preparation and streaming) is tracked, so shutdown waits for it.
        // Preparation always runs to its end (an abort meanwhile only asks it to stop early at its
        // next step), and one finalizer removes the staging folder and releases the lifetime after
        // it has settled: when it failed, when the client is gone (before or during the stream), or
        // when the stream ends or is cancelled.
        const signal = c.req.raw.signal;
        let release!: () => void;
        const lifetime = new Promise<void>((resolve) => (release = resolve));
        let staging: string | null = null;
        let databaseFile = "";
        const assets: { key: string; file: string }[] = [];
        const missing: string[] = [];
        const prepare = async () => {
            staging = await makeStaging(tmpPath, "export");
            if (signal.aborted) {
                return;
            }
            databaseFile = path.join(staging, "resources.sqlite");
            // Resources first, then assets: a blob is written before the metadata that names it, so
            // every asset the snapshot references already exists when the assets are listed.
            await snapshots.exclusive(() => store.backupTo(databaseFile));
            if (signal.aborted) {
                return;
            }
            // A downloaded archive carries no LLM credentials: the staged copy loses its `llmSecrets`
            // row, and `VACUUM` rewrites the file so no page keeps the deleted row (or an older
            // version of it). Snapshots on the server keep the record.
            const staged = new DatabaseSync(databaseFile);
            let selectedKeys: string[] = [];
            try {
                staged.prepare("DELETE FROM resources WHERE kind = ?").run(RESOURCE_KIND.llmSecrets);
                staged.exec("VACUUM");
                if (partial === true) {
                    // Select from the exact copy being archived, without reading or normalizing chats.
                    const rows = staged
                        .prepare("SELECT kind, id, data FROM resources WHERE kind IN (?, ?, ?, ?, ?)")
                        .all(
                            RESOURCE_KIND.characters,
                            RESOURCE_KIND.personas,
                            RESOURCE_KIND.ui,
                            RESOURCE_KIND.characterOrder,
                            RESOURCE_KIND.presets,
                        );
                    selectedKeys = selectPartialBackupAssets(
                        rows.map((row) => ({ kind: row.kind as string, data: JSON.parse(row.data as string) })),
                    ).map((asset) => asset.key);
                }
            } finally {
                staged.close();
            }
            if ((await fs.stat(databaseFile)).size > MAX_ARCHIVE_RECORD_BYTES) {
                throw new ArchiveRejectedError("The resource database is too large for the archive format");
            }
            const keys =
                partial === undefined
                    ? await listAssetKeys(assetsPath)
                    : partial === true
                      ? selectedKeys
                      : [...new Set(partial as string[])];
            if (partial !== undefined && keys.length > MAX_PARTIAL_ASSETS) {
                throw new ResourceValidationError("Too many assets for one partial backup");
            }
            if (keys.length > MAX_ARCHIVE_RECORDS - 2) {
                throw new ArchiveRejectedError("Too many assets for one archive");
            }
            for (const key of keys) {
                const file = resolveStorageKey(savePath, key);
                if (file === null) {
                    missing.push(key);
                    continue;
                }
                const stat = await fs.lstat(file).catch(() => null);
                if (stat?.isFile() && stat.size <= MAX_ARCHIVE_RECORD_BYTES) {
                    assets.push({ key, file });
                } else {
                    missing.push(key);
                }
            }
        };
        let prepared!: Promise<void>;
        try {
            // The tracked operation spans preparation and the finalizer.
            snapshots.track(() => {
                prepared = prepare();
                return prepared.then(
                    () => lifetime,
                    () => lifetime,
                );
            });
        } catch (error) {
            return backupErrorResponse(c, error);
        }
        let finalized: Promise<void> | null = null;
        const finalize = () =>
            (finalized ??= (async () => {
                await prepared.catch(() => {});
                if (staging) {
                    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
                }
                release();
            })());

        try {
            await prepared;
        } catch (error) {
            await finalize();
            if (error instanceof ArchiveRejectedError) {
                return c.json({ error: error.message }, 413);
            }
            return backupErrorResponse(c, error);
        }
        if (signal.aborted) {
            await finalize();
            return c.json({ error: "Request aborted" }, 400);
        }

        const manifest: BackupArchiveManifest = {
            version: 2,
            createdAt: new Date().toISOString(),
            partial: partial !== undefined,
            assets: assets.map((asset) => asset.key),
            missing,
        };

        async function* records(): AsyncGenerator<Uint8Array> {
            try {
                const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf-8");
                yield encodeRecordHeader("manifest.json", manifestBytes.length);
                yield manifestBytes;
                yield* fileRecord("resources.sqlite", databaseFile);
                for (const asset of assets) {
                    yield* fileRecord(asset.key, asset.file);
                }
            } finally {
                await finalize();
            }
        }
        // A client that leaves may never cancel the stream (the adapter can stop pulling with the
        // generator suspended at a `yield`), so the request-signal abort returns the generator: its
        // `finally` finalizes once the step it is in settles, and `finalize` covers one that never
        // started (it has no `finally` to run).
        const iterator = records();
        signal.addEventListener(
            "abort",
            () => {
                void iterator
                    .return(undefined)
                    .catch(() => {})
                    .finally(finalize);
            },
            { once: true },
        );

        c.header("Content-Type", "application/octet-stream");
        c.header("Cache-Control", "no-store");
        return c.body(iteratorStream(iterator, finalize), 200);
    });

    app.post(BACKUP_IMPORT_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const expectedEpoch = c.req.header(RESOURCE_EPOCH_HEADER);
        try {
            store.assertEpoch(expectedEpoch);
        } catch (error) {
            return backupErrorResponse(c, error);
        }
        const declared = Number(c.req.header("content-length") ?? "0");
        if (declared > maxImportBytes) {
            return c.json({ error: "Archive too large" }, 413);
        }
        if (slot.busy) {
            return c.json({ error: "Another import is running" }, 409);
        }
        const body = c.req.raw.body;
        if (!body) {
            return c.json({ error: "Archive body required" }, 400);
        }
        slot.busy = true;
        try {
            return await snapshots.track(() => runImport(c, body, expectedEpoch));
        } catch (error) {
            return backupErrorResponse(c, error);
        } finally {
            slot.busy = false;
        }
    });

    async function runImport(
        c: Context<AppEnv>,
        body: ReadableStream<Uint8Array>,
        expectedEpoch: string | undefined,
    ): Promise<Response> {
        let staging: string | null = null;
        let handle: FileHandle | null = null;
        try {
            staging = await makeStaging(tmpPath, "import");
            const archiveFile = path.join(staging, "archive.bin");
            if (!(await spool(body, archiveFile, maxImportBytes))) {
                return c.json({ error: "Archive too large" }, 413);
            }
            handle = await fs.open(archiveFile, "r");
            const plan = await planImport(handle, savePath, maxArchiveRecords);
            const databaseFile = path.join(staging, "resources.sqlite");
            await copyRecordToFile(handle, plan.database, databaseFile);
            const validated = store.readSnapshot(databaseFile);
            const importHandle = handle;
            const importStaging = staging;

            const result = await snapshots.withMaintenance(async ({ snapshot }) => {
                // Again once the lock is held, before the safety snapshot and any asset is written:
                // an import queued behind a restore is stale (the final check beside `replaceAll`
                // is the guarantee; this one avoids the side effects).
                store.assertEpoch(expectedEpoch);
                return restoreValidated({
                    store,
                    assetsPath,
                    expectedEpoch,
                    snapshot,
                    validated,
                    assets: plan.assets.map((asset, index) => ({
                        target: asset.target,
                        stage: async () => {
                            const staged = path.join(importStaging, `asset-${index}`);
                            await copyRecordToFile(importHandle, asset.record, staged);
                            return staged;
                        },
                    })),
                });
            });
            recordSafely(diagnostics, { kind: "lifecycle", phase: "import" });
            return c.json(result);
        } finally {
            await handle?.close().catch(() => {});
            if (staging) {
                await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
            }
        }
    }
}

/** One asset of an import: its file under `save/assets`, and how to get its staged copy (removed after linking). */
export type RestoreAsset = { target: string; stage(): Promise<string> };

/**
 * The steps every archive import runs inside `withMaintenance` once its snapshot is validated and
 * the epoch checked under the lock: the safety snapshot, each asset whose file does not exist yet
 * added by hard link (an existing file is never overwritten: a link fails instead of replacing), the
 * epoch checked again, then `replaceAll`. Shared by the version-2 import and the upstream commit.
 */
export async function restoreValidated(arg: {
    store: ResourceStore;
    assetsPath: string;
    expectedEpoch: string | undefined;
    snapshot: () => Promise<unknown>;
    validated: ValidatedSnapshot;
    assets: readonly RestoreAsset[];
}): Promise<{ epoch: string; assetsWritten: number; assetsSkipped: number }> {
    const { store, expectedEpoch } = arg;
    await arg.snapshot();
    await fs.mkdir(arg.assetsPath, { recursive: true });
    let written = 0;
    let skipped = 0;
    for (const asset of arg.assets) {
        if (await fs.lstat(asset.target).catch(() => null)) {
            skipped += 1;
            continue;
        }
        const staged = await asset.stage();
        try {
            // A hard link never replaces an existing file, unlike a rename.
            await fs.link(staged, asset.target);
            written += 1;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
            skipped += 1;
        } finally {
            await fs.rm(staged, { force: true });
        }
    }
    store.assertEpoch(expectedEpoch);
    const epoch = store.replaceAll(arg.validated);
    return { epoch, assetsWritten: written, assetsSkipped: skipped };
}

/** Every logical key of the `assets` namespace, sorted (also the upstream export's inventory). */
export async function listAssetKeys(assetsPath: string): Promise<string[]> {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(assetsPath, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const keys: string[] = [];
    for (const entry of entries) {
        const name = entry.isFile() ? decodeFileName(entry.name) : null;
        if (name !== null) {
            keys.push(ASSET_PREFIX + name);
        }
    }
    return keys.sort();
}

/**
 * Checks a whole archive before anything is written: `manifest.json` (version 2) first, exactly one
 * `resources.sqlite`, and otherwise only unique `assets/` keys. A Risu Account archive and an upstream
 * RisuAI backup (`database.risudat`) are refused with their own message; cold-storage records of old
 * archives are ignored.
 */
async function planImport(handle: FileHandle, savePath: string, maxRecords?: number) {
    let records;
    try {
        records = await indexArchive(handle, undefined, maxRecords);
    } catch (error) {
        if (error instanceof ArchiveFormatError) {
            throw new ArchiveRejectedError(error.message);
        }
        throw error;
    }
    const names = new Set<string>();
    for (const record of records) {
        if (record.name === "encryption.risudat") {
            throw new ArchiveRejectedError("This backup was encrypted with a Risu Account and cannot be restored");
        }
        if (names.has(record.name)) {
            throw new ArchiveRejectedError(`The archive holds ${record.name} twice`);
        }
        names.add(record.name);
    }
    if (names.has("database.risudat")) {
        // An upstream RisuAI backup (or one of this fork's from before the resource records): the
        // client sends it to the upstream import (`data/upstream/archive.ts`); only a client older
        // than that posts it here.
        throw new ArchiveRejectedError("This is a RisuAI backup; choose it again and it will be imported as one");
    }
    const [first] = records;
    if (!first || first.name !== "manifest.json" || first.length > MAX_MANIFEST_BYTES) {
        throw new ArchiveRejectedError("The archive has no manifest");
    }
    let manifest: unknown;
    try {
        manifest = JSON.parse((await readRecord(handle, first)).toString("utf-8"));
    } catch {
        throw new ArchiveRejectedError("The archive manifest is not JSON");
    }
    if ((manifest as { version?: unknown } | null)?.version !== 2) {
        throw new ArchiveRejectedError("Unsupported archive version");
    }
    const declared = (manifest as { assets?: unknown }).assets;
    if (!Array.isArray(declared) || !declared.every((key) => typeof key === "string")) {
        throw new ArchiveRejectedError("The archive manifest has no asset list");
    }
    if (new Set(declared).size !== declared.length) {
        throw new ArchiveRejectedError("The archive manifest lists an asset twice");
    }
    let database: (typeof records)[number] | null = null;
    const assets: { record: (typeof records)[number]; target: string }[] = [];
    for (const record of records.slice(1)) {
        if (record.name === "resources.sqlite") {
            database = record;
            continue;
        }
        if (record.name.startsWith("coldstorage_") && record.name.endsWith(".json")) {
            continue;
        }
        const target = record.name.startsWith(ASSET_PREFIX) ? resolveStorageKey(savePath, record.name) : null;
        if (target === null) {
            throw new ArchiveRejectedError(`The archive holds an unexpected record: ${record.name}`);
        }
        assets.push({ record, target });
    }
    if (!database) {
        throw new ArchiveRejectedError("The archive holds no resource database");
    }
    // Record names are unique (checked above) and the declared names too, so equal sizes plus
    // membership one way is set equality: exactly the declared assets are stored.
    const stored = new Set(assets.map((asset) => asset.record.name));
    if (declared.length !== stored.size || !declared.every((key) => stored.has(key))) {
        throw new ArchiveRejectedError("The archive does not hold the assets its manifest lists");
    }
    return { database, assets };
}

/** The answer to a backup route's error: maintenance 503, epoch 412, a refused archive or snapshot 400; anything else is thrown. */
export function backupErrorResponse(c: Context<AppEnv>, error: unknown): Response {
    if (error instanceof MaintenanceError) {
        c.header("Retry-After", "5");
        return c.json({ error: error.message }, 503);
    }
    if (error instanceof ResourceEpochError) {
        return c.json({ error: "EpochMismatch", epoch: error.epoch }, 412);
    }
    if (error instanceof ArchiveRejectedError || error instanceof ResourceValidationError) {
        return c.json({ error: error.message }, 400);
    }
    throw error;
}
