import type { Dirent } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { type BackupArchiveManifest, RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
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
import { mkdirDurable, syncDir, syncFile } from "../data/durableWrite.ts";
import { runExportScrubWorker } from "../data/exportScrub/runner.ts";
import { ResourceEpochError, type ResourceStore, ResourceValidationError } from "../data/resourceStore.ts";
import { type StagedFileReport, verifyStagedFile } from "../data/restore/stageValidatedSnapshot.ts";
import type { RestoreRunner } from "../data/restore/validateRunner.ts";
import {
    MaintenanceError,
    MAX_SNAPSHOT_LABEL_LENGTH,
    SnapshotConflictError,
    type SnapshotManager,
} from "../data/snapshots.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import { assetVerification, contentNameHash, hashAssetFile, holdsVerifiedAsset } from "../http/assetVerification.ts";
import { ensureFreeSpace, InsufficientStorageError, liveDatabaseBytes, type DiskStatfs } from "../http/diskSpace.ts";
import { readJsonBody } from "../http/body.ts";
import { createImportSlot, type ImportSlot } from "../http/fileImport.ts";
import { fileRecord, iteratorStream } from "../http/recordStream.ts";
import { makeStaging, spool } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { createExportHolds, type ExportHold, type ExportHolds } from "./backupsUpstreamExport.ts";
import { decodeFileName, resolveStorageKey } from "./storage.ts";

export const BACKUP_IMPORT_PATH = "/api/backups/import";
/** Default cap on an uploaded archive or module file; `RISU_MAX_IMPORT_BYTES` overrides it. */
export const DEFAULT_MAX_IMPORT_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PARTIAL_ASSETS = 100_000;
const ASSET_PREFIX = "assets/";
/** The trusted staged store of a restore or an import, in its staging folder. */
const STAGED_STORE_FILE = "staged.sqlite";
/** What an import runs the validation under: one admitted before shutdown finishes. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * Runs its turns one at a time, in call order, so one validation worker runs at a time. A turn settles
 * whatever happens to it, and the next one then starts, so every waiter settles. A snapshot restore
 * holds its turn through validation and installation; restoreSnapshot rechecks the epoch at the
 * turn before creating staging or a safety snapshot, so a stale waiter is 412 without doing work.
 * An archive import uses the same queue for validation only, releasing it before maintenance.
 */
function createRestoreQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    return {
        run<T>(turn: () => Promise<T>): Promise<T> {
            const run = tail.then(turn, turn);
            tail = run.catch(() => {});
            return run;
        },
    };
}

/**
 * Server snapshots and local backup archives:
 * - `GET /api/backups`: retained snapshots with pins and labels, newest first.
 * - `POST /api/backups/snapshot` `{ label? }`: an unpinned manual snapshot; 507 on short disk.
 * - `PATCH /api/backups/:id` `{ pinned?, label? }`: update metadata; 409 beyond 20 pins.
 * - `DELETE /api/backups/:id`: delete an unpinned snapshot; 409 while retained by a restore.
 *   These three operations are tracked, serialized with rotation, and need no resource epoch.
 * - `POST /api/backups/:id/restore`: replaces every resource with a snapshot. In a turn of the restore
 *   queue, which spans the validation and the install: the snapshot is linked into a staging folder
 *   (retention cannot take it), checked and staged by the runner outside maintenance, its staged file
 *   verified, and only then, with mutations closed, the safety snapshot taken and the staged store
 *   installed (new epoch). A request that leaves does not cancel it; `restoreSignal` (shutdown) does,
 *   at each of its checks, up to the install.
 * - `POST /api/backups/export` `{ partial?: true | string[] }`: streams an archive of a fresh snapshot
 *   and assets (all files, profiles selected from that snapshot for `true`, or the listed keys).
 * - `POST /api/backups/import`: an archive as the raw body, spooled to disk (exempt from the global
 *   body limit, capped by `maxImportBytes`), validated completely (its database staged by the runner
 *   in a turn of the restore queue that ends before maintenance), then its missing assets are added
 *   (an existing file is kept, unless it has a content name and does not hold those bytes while the
 *   archive's copy does) and the resources restored like a snapshot. An import admitted before
 *   shutdown finishes.
 * Restore and import are mutations: they need the current epoch in `x-resource-epoch`. The upstream
 * RisuAI import (`routes/backupsUpstream.ts`) shares the import's slot and its restore steps
 * (`restoreValidated`).
 */
export function registerBackupRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        statfs?: DiskStatfs;
        store: ResourceStore;
        snapshots: SnapshotManager;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maxImportBytes: number;
        /** Shared roots for exports from their database copy through stream finalization. */
        exportHolds?: ExportHolds;
        /** The diagnostics journal: a `lifecycle` event after a restore or an import replaced the data. */
        diagnostics?: DiagnosticsRecorder;
        /** The backup import's slot, shared with the upstream import; a slot of its own without one. */
        slot?: ImportSlot;
        /** Most records of an imported archive (default `MAX_ARCHIVE_RECORDS`; tests lower it). */
        maxArchiveRecords?: number;
        /** Checks a snapshot and writes its trusted staged store (`validateRunner.ts`). */
        restoreRunner: RestoreRunner;
        /**
         * Aborted at shutdown, with the `MaintenanceError` a stopped restore answers (503). Checked at
         * the queue turn, during hashing, before and inside maintenance, and right before replaceAll;
         * a worker is terminated and staging removed on refusal. An install past the final check
         * completes. This signal does not cancel an admitted version-2 archive import.
         */
        restoreSignal: AbortSignal;
    },
) {
    const exportHolds = arg.exportHolds ?? createExportHolds();
    const { savePath, store, snapshots, auth, limiter, maxImportBytes, diagnostics, maxArchiveRecords } = arg;
    const { restoreRunner, restoreSignal } = arg;
    const tmpPath = path.join(savePath, ".tmp");
    const assetsPath = path.join(savePath, "assets");
    const slot = arg.slot ?? createImportSlot();
    const restoreQueue = createRestoreQueue();

    app.get("/api/backups", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        c.header("Cache-Control", "no-store");
        return c.json({ items: snapshots.list() });
    });

    /** Manual snapshots and metadata changes reject invalid bodies (400) and unknown ids (404). */
    app.post("/api/backups/snapshot", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        c.header("Cache-Control", "no-store");
        try {
            return await snapshots.track(async () => {
                const body = await readJsonBody(c);
                if (!body.ok) return body.response;
                const { label } = snapshotFields(body.body, false);
                return c.json({ snapshot: await snapshots.snapshotNow({ label }) });
            });
        } catch (error) {
            return backupErrorResponse(c, error);
        }
    });

    app.patch("/api/backups/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        c.header("Cache-Control", "no-store");
        try {
            return await snapshots.track(async () => {
                const body = await readJsonBody(c);
                if (!body.ok) return body.response;
                const snapshot = await snapshots.setPinned(c.req.param("id"), snapshotFields(body.body, true));
                return snapshot ? c.json({ snapshot }) : c.json({ error: "Snapshot not found" }, 404);
            });
        } catch (error) {
            return backupErrorResponse(c, error);
        }
    });

    app.delete("/api/backups/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        c.header("Cache-Control", "no-store");
        try {
            const deleted = await snapshots.track(() => snapshots.remove(c.req.param("id")));
            return deleted ? c.json({ deleted: true }) : c.json({ error: "Snapshot not found" }, 404);
        } catch (error) {
            return backupErrorResponse(c, error);
        }
    });

    /**
     * POST with x-resource-epoch; the request body is never read. Validates the staged snapshot in
     * a worker before maintenance, then takes a safety snapshot and replaces all resources → { epoch }.
     * 404 unknown id, 400 refused snapshot, 412 stale epoch, 503 with Retry-After: 5 on shutdown.
     * 507 when remaining allocations (including a fallback source copy) exceed available disk space.
     * The source stays retained through staging cleanup. Client disconnect does not cancel this operation;
     * restoreSignal does until installation starts.
     */
    app.post("/api/backups/:id/restore", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const expectedEpoch = c.req.header(RESOURCE_EPOCH_HEADER);
        try {
            store.assertEpoch(expectedEpoch);
            const id = c.req.param("id");
            const epoch = await snapshots.track(() => restoreQueue.run(() => restoreSnapshot(id, expectedEpoch)));
            if (epoch === null) {
                return c.json({ error: "Snapshot not found" }, 404);
            }
            recordSafely(diagnostics, { kind: "lifecycle", phase: "restore" });
            return c.json({ epoch });
        } catch (error) {
            return backupErrorResponse(c, error);
        }
    });

    /** A snapshot restore's turn of the queue (see `registerBackupRoutes`); null for an unlisted snapshot. */
    async function restoreSnapshot(id: string, expectedEpoch: string | undefined): Promise<string | null> {
        restoreSignal.throwIfAborted();
        // Again at the turn: a restore queued behind another one is stale, and nothing of it (a worker,
        // a safety snapshot) should run.
        store.assertEpoch(expectedEpoch);
        const release = snapshots.retain(id);
        let staging: string | null = null;
        try {
            const info = snapshots.list().find((item) => item.id === id);
            if (info) {
                const estimate = 2 * info.size + (await liveDatabaseBytes(savePath));
                await ensureFreeSpace(savePath, estimate, { statfs: arg.statfs });
            }
            // Unknown ids still queue at stageCopy behind maintenance, preserving restore admission order.
            staging = await makeStaging(tmpPath, "restore");
            const source = path.join(staging, "source.sqlite");
            if (
                !(await snapshots.stageCopy(id, source, {
                    beforeCopy: async (bytes) =>
                        ensureFreeSpace(savePath, 3 * bytes + (await liveDatabaseBytes(savePath)), {
                            statfs: arg.statfs,
                        }),
                }))
            ) {
                return null;
            }
            if (!info) {
                await ensureFreeSpace(
                    savePath,
                    2 * (await fs.stat(source)).size + (await liveDatabaseBytes(savePath)),
                    { statfs: arg.statfs },
                );
            }
            const stagedFile = path.join(staging, STAGED_STORE_FILE);
            const stagedReport = await restoreRunner(
                { source, output: stagedFile },
                { signal: restoreSignal, onProgress: () => {} },
            );
            await verifyStagedFile(stagedFile, stagedReport, restoreSignal);
            restoreSignal.throwIfAborted();
            return await snapshots.withMaintenance(async ({ snapshot }) => {
                // Again once the lock is held, and neither the snapshot nor the install below runs
                // past shutdown or for a restore that went stale meanwhile.
                restoreSignal.throwIfAborted();
                store.assertEpoch(expectedEpoch);
                const { epoch } = await restoreValidated({
                    store,
                    assetsPath,
                    expectedEpoch,
                    snapshot,
                    stagedFile,
                    stagedReport,
                    assets: [],
                    signal: restoreSignal,
                });
                return epoch;
            });
        } finally {
            if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
            release();
        }
    }

    /**
     * POST { partial?: true | string[] } streams a version-2 archive, no epoch required: a fresh
     * resources.sqlite snapshot followed by asset records, preceded by manifest.json. A worker removes
     * credentials and rewrites the copy with VACUUM INTO so no deleted credential bytes remain.
     * A disk preflight returns 507 before staging if the copy plus vacuum output cannot fit.
     * partial: true selects profile assets from that exact snapshot; a list selects explicit keys;
     * absent partial selects all assets. 400 invalid input or over 100,000 partial assets, 413 when
     * the database or asset count cannot fit the format. Authenticated before reading the body.
     */
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
        let assetHold: ExportHold | undefined;
        const prepare = async () => {
            await ensureFreeSpace(savePath, 2 * (await liveDatabaseBytes(savePath)), { statfs: arg.statfs });
            staging = await makeStaging(tmpPath, "export");
            if (signal.aborted) {
                return;
            }
            const copyFile = path.join(staging, "copy.sqlite");
            databaseFile = path.join(staging, "resources.sqlite");
            // Resources first, then assets: a blob is written before the metadata that names it, so
            // every asset the snapshot references already exists when the assets are listed.
            await snapshots.exclusive(() => {
                assetHold = exportHolds.hold();
                return store.backupTo(copyFile);
            });
            if (signal.aborted) {
                return;
            }
            // The worker removes llmSecrets and uses VACUUM INTO to write only live rows to the archive
            // database, leaving no deleted credential bytes in its pages. Server snapshots keep the record.
            const { selectedKeys } = await runExportScrubWorker({
                source: copyFile,
                output: databaseFile,
                partial: partial === true,
            });
            await fs.rm(copyFile);
            if ((await fs.stat(databaseFile)).size > MAX_ARCHIVE_RECORD_BYTES) {
                throw new ArchiveRejectedError("The resource database is too large for the archive format");
            }
            const keys =
                partial === undefined
                    ? await listAssetKeys(assetsPath)
                    : partial === true
                      ? selectedKeys
                      : [...new Set(partial as string[])];
            assetHold!.setKeys(keys);
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
                assetHold?.release();
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

    /**
     * POST /api/backups/import with x-resource-epoch: raw version-2 archive, exempt from the app's
     * 100 MiB limit, capped by maxImportBytes (RISU_MAX_IMPORT_BYTES, default 16 GiB). Authentication
     * and epoch checks precede reading; spools and validates completely before maintenance. The
     * database validation uses the restore queue, released before the safety snapshot and install.
     * Adds missing assets and repairs content-named files by restoreValidated's verified-byte rule.
     * Returns { epoch, assetsWritten, assetsSkipped }; 400 refused archive/store or missing body,
     * 409 another import, 412 stale epoch, 413 cap exceeded, 503 shutdown before admission.
     * Disk preflights answer 507 with needed/free bytes; after spooling, only assets to add or repair
     * are charged. A kept asset found missing or damaged under the lock is rechecked before staging.
     */
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
            const declaredLength = c.req.header("content-length");
            if (
                declaredLength !== undefined &&
                Number.isFinite(Number(declaredLength)) &&
                Number(declaredLength) >= 0
            ) {
                await ensureFreeSpace(savePath, Number(declaredLength), { statfs: arg.statfs });
            }
            staging = await makeStaging(tmpPath, "import");
            const archiveFile = path.join(staging, "archive.bin");
            if (!(await spool(body, archiveFile, maxImportBytes))) {
                return c.json({ error: "Archive too large" }, 413);
            }
            handle = await fs.open(archiveFile, "r");
            const plan = await planImport(handle, savePath, maxArchiveRecords);
            // Charge only assets to add or repair; kept assets are rechecked if they need staging later.
            const chargedAssets = new Set<number>();
            let remainingChargedAssetBytes = 0;
            for (const [index, asset] of plan.assets.entries()) {
                if ((await assetCopyDecision(asset.target)).action !== "keep") {
                    chargedAssets.add(index);
                    remainingChargedAssetBytes += asset.record.length;
                }
            }
            await ensureFreeSpace(
                savePath,
                3 * plan.database.length + (await liveDatabaseBytes(savePath)) + remainingChargedAssetBytes,
                { statfs: arg.statfs },
            );
            const databaseFile = path.join(staging, "resources.sqlite");
            await copyRecordToFile(handle, plan.database, databaseFile);
            const stagedFile = path.join(staging, STAGED_STORE_FILE);
            const stagedReport = await restoreQueue.run(() =>
                restoreRunner(
                    { source: databaseFile, output: stagedFile },
                    { signal: NEVER_ABORTED, onProgress: () => {} },
                ),
            );
            await verifyStagedFile(stagedFile, stagedReport);
            const importHandle = handle;
            const importStaging = staging;
            const stagedChargedAssets = new Set<number>();

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
                    stagedFile,
                    stagedReport,
                    assets: plan.assets.map((asset, index) => ({
                        target: asset.target,
                        stage: async () => {
                            if (chargedAssets.has(index)) {
                                if (!stagedChargedAssets.has(index)) {
                                    stagedChargedAssets.add(index);
                                    remainingChargedAssetBytes -= asset.record.length;
                                }
                            } else {
                                // Extraction, staging and the safety snapshot already exist; reserve the
                                // database install, this asset and charged assets not yet staged.
                                await ensureFreeSpace(
                                    savePath,
                                    plan.database.length + asset.record.length + remainingChargedAssetBytes,
                                    { statfs: arg.statfs },
                                );
                            }
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

/** One asset of an import: its file under `save/assets`, and how to get its staged copy (removed after placing). */
export type RestoreAsset = { target: string; stage(): Promise<string> };

/** Only a damaged content-named file is repaired; every other existing path, including a directory, is kept. */
async function assetCopyDecision(target: string): Promise<{
    action: "add" | "repair" | "keep";
    expectedHex: string | null;
}> {
    const name = decodeFileName(path.basename(target));
    const expectedHex = name === null ? null : contentNameHash(ASSET_PREFIX + name);
    const existing = await fs.lstat(target).catch(() => null);
    const repair =
        existing !== null &&
        expectedHex !== null &&
        (existing.isFile() || existing.isSymbolicLink()) &&
        !(await holdsVerifiedAsset(target, expectedHex));
    return { action: existing === null ? "add" : repair ? "repair" : "keep", expectedHex };
}

/**
 * The steps every restore runs inside `withMaintenance` once its staged store is verified and the
 * epoch checked under the lock: the safety snapshot, each asset whose file does not exist yet
 * flushed and added by hard link (a link fails instead of replacing a file that appeared meanwhile),
 * a content-named file (`assets/<sha256 hex>.<ext>`) that does not hold its bytes replaced by rename
 * when the staged copy does (any other existing path is kept), one assets directory sync, `signal`
 * and the epoch checked again, then `replaceAll`, which completes once it started. Shared by the
 * snapshot restore, the version-2 import, and the upstream commit.
 */
export async function restoreValidated(arg: {
    store: ResourceStore;
    assetsPath: string;
    expectedEpoch: string | undefined;
    snapshot: () => Promise<unknown>;
    stagedFile: string;
    stagedReport: StagedFileReport;
    assets: readonly RestoreAsset[];
    /** Aborted at shutdown: nothing is replaced past it. */
    signal?: AbortSignal;
}): Promise<{ epoch: string; assetsWritten: number; assetsSkipped: number }> {
    const { store, expectedEpoch } = arg;
    await arg.snapshot();
    await mkdirDurable(arg.assetsPath);
    let written = 0;
    let skipped = 0;
    for (const asset of arg.assets) {
        const { action, expectedHex } = await assetCopyDecision(asset.target);
        if (action === "keep") {
            skipped += 1;
            continue;
        }
        const staged = await asset.stage();
        try {
            const verification = expectedHex === null ? null : await hashAssetFile(staged);
            if (action === "repair" && verification?.hashHex !== expectedHex) {
                // The archive's copy is no better than the file in place.
                skipped += 1;
                continue;
            }
            await syncFile(staged);
            if (action === "repair") {
                await fs.rename(staged, asset.target);
            } else {
                // A hard link never replaces an existing file, unlike a rename.
                try {
                    await fs.link(staged, asset.target);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                        throw error;
                    }
                    skipped += 1;
                    continue;
                }
            }
            if (verification) {
                assetVerification.recordVerification(
                    asset.target,
                    verification.stat,
                    verification.hashHex === expectedHex,
                );
            }
            written += 1;
        } finally {
            await fs.rm(staged, { force: true });
        }
    }
    if (written > 0) {
        await syncDir(arg.assetsPath);
    }
    arg.signal?.throwIfAborted();
    store.assertEpoch(expectedEpoch);
    const epoch = store.replaceAll(arg.stagedFile, arg.stagedReport);
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

/** Regular asset files with codec identities; invalid file names are unmanaged, never candidates. */
export async function listAssetFiles(
    assetsPath: string,
    signal?: AbortSignal,
): Promise<{
    files: { key: string; bytes: number; mtimeMs: number }[];
    unmanaged: { name: string; bytes: number }[];
}> {
    signal?.throwIfAborted();
    const files: { key: string; bytes: number; mtimeMs: number }[] = [];
    const unmanaged: { name: string; bytes: number }[] = [];
    let entries: string[];
    try {
        entries = await fs.readdir(assetsPath);
    } catch (error) {
        signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { files, unmanaged };
        }
        throw error;
    }
    signal?.throwIfAborted();
    for (const entry of entries) {
        const stat = await fs.lstat(path.join(assetsPath, entry)).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return null;
            }
            throw error;
        });
        signal?.throwIfAborted();
        if (!stat?.isFile()) {
            continue;
        }
        const name = decodeFileName(entry);
        if (name === null) {
            unmanaged.push({ name: entry, bytes: stat.size });
        } else {
            files.push({ key: ASSET_PREFIX + name, bytes: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
    files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { files, unmanaged };
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

/** Snapshot controls accept only their named fields; omitted fields preserve existing metadata. */
function snapshotFields(body: unknown, allowPinned: boolean): { pinned?: boolean; label?: string | null } {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ResourceValidationError("Snapshot body must be an object");
    }
    const fields = body as Record<string, unknown>;
    if (Object.keys(fields).some((key) => key !== "label" && !(allowPinned && key === "pinned"))) {
        throw new ResourceValidationError("Unknown snapshot field");
    }
    const result: { pinned?: boolean; label?: string | null } = {};
    if (Object.hasOwn(fields, "pinned")) {
        if (typeof fields.pinned !== "boolean") throw new ResourceValidationError("Snapshot pinned must be a boolean");
        result.pinned = fields.pinned;
    }
    if (Object.hasOwn(fields, "label")) {
        if (fields.label !== null && typeof fields.label !== "string") {
            throw new ResourceValidationError("Snapshot label must be a string or null");
        }
        const label = fields.label === null ? null : fields.label.trim() || null;
        if (label !== null && label.length > MAX_SNAPSHOT_LABEL_LENGTH) {
            throw new ResourceValidationError(`Snapshot label must be at most ${MAX_SNAPSHOT_LABEL_LENGTH} characters`);
        }
        result.label = label;
    }
    return result;
}

/** Backup errors: space shortage 507, maintenance 503, epoch 412, snapshot conflict 409, refused input 400; otherwise thrown. */
export function backupErrorResponse(c: Context<AppEnv>, error: unknown): Response {
    if (error instanceof InsufficientStorageError) {
        return c.json({ error: "Insufficient Storage", needed: error.needed, free: error.free }, 507);
    }
    if (error instanceof MaintenanceError) {
        c.header("Retry-After", "5");
        return c.json({ error: error.message }, 503);
    }
    if (error instanceof ResourceEpochError) {
        return c.json({ error: "EpochMismatch", epoch: error.epoch }, 412);
    }
    if (error instanceof SnapshotConflictError) {
        return c.json({ error: error.message }, 409);
    }
    if (error instanceof ArchiveRejectedError || error instanceof ResourceValidationError) {
        return c.json({ error: error.message }, 400);
    }
    throw error;
}
