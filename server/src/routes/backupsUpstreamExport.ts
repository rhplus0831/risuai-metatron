import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { addUpstreamReportEntry, UPSTREAM_TOKEN_PATTERN } from "../../../shared/upstreamBackup.ts";
import {
    MAX_UPSTREAM_EXPORTS_STAGED,
    UPSTREAM_EXPORT_CANCEL_PATH,
    UPSTREAM_EXPORT_DOWNLOAD_PATH,
    UPSTREAM_EXPORT_EXPIRED,
    UPSTREAM_EXPORT_PREPARE_PATH,
    UPSTREAM_EXPORT_STAGED_TTL_MS,
    UPSTREAM_EXPORT_TOO_MANY_STAGED,
    type UpstreamExportPrepared,
    type UpstreamExportReport,
    type UpstreamExportRequest,
} from "../../../shared/upstreamExportReport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { ArchiveRejectedError, MAX_ARCHIVE_RECORD_BYTES, MAX_ARCHIVE_RECORDS } from "../data/archive.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import { UPSTREAM_DATABASE_RECORD, upstreamAssetRecordName } from "../data/upstream/archive.ts";
import { runUpstreamExportWorker, upstreamExportHeapMb } from "../data/upstream/exportRunner.ts";
import type { UpstreamExportStageResult } from "../data/upstream/exportStage.ts";
import { readJsonBody } from "../http/body.ts";
import { fileRecord, iteratorStream } from "../http/recordStream.ts";
import { makeStaging } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { backupErrorResponse, listAssetKeys } from "./backups.ts";
import { resolveStorageKey } from "./storage.ts";

/**
 * Upstream-compatible exports: copy the store and inventory assets on the serving thread, stage the
 * database in a heap-capped worker, then keep it under a token until download, cancel, or expiry.
 * A disconnect or shutdown terminates a running prepare's worker before its folder is removed.
 */

/** A prepared export waiting for its download: its staging folder, the encoded database, and the asset files. */
type StagedUpstreamExport = {
    staging: string;
    /** `database.risudat` as written into the backup. */
    databaseFile: string;
    /** The existing referenced assets: each record's name (the key without `assets/`) and its file. */
    assets: { name: string; file: string }[];
};

/**
 * The prepared upstream exports (see `registerUpstreamExportRoutes`): each waits for its download or
 * cancel at most `ttlMs` (`UPSTREAM_EXPORT_STAGED_TTL_MS`) from its prepare's answer, and at most
 * `MAX_UPSTREAM_EXPORTS_STAGED` at once (the upstream import staging's pattern, `backupsUpstream.ts`).
 * Expiry, cancel, and `close` remove the staging folder; a download takes the export out (`take`) and
 * removes it itself when its stream ends. `close` (shutdown) aborts running prepares' workers and
 * waits for every removal it or an expiry started; `snapshots.track` waits for prepares' cleanup.
 * What a crash leaves under `save/.tmp` is emptied at the next start (`routes/storage.ts`).
 */
export type UpstreamExportStaging = ReturnType<typeof createUpstreamExportStaging>;

export function createUpstreamExportStaging(options: { ttlMs?: number } = {}) {
    const ttlMs = options.ttlMs ?? UPSTREAM_EXPORT_STAGED_TTL_MS;
    const waiting = new Map<string, StagedUpstreamExport & { timer: ReturnType<typeof setTimeout> }>();
    const removals = new Set<Promise<void>>();
    const controller = new AbortController();
    let closing: Promise<void> | null = null;
    const remove = (staged: StagedUpstreamExport): Promise<void> => {
        const removal = fs.rm(staged.staging, { recursive: true, force: true }).catch(() => {});
        removals.add(removal);
        void removal.then(() => removals.delete(removal));
        return removal;
    };
    const detach = (token: string): StagedUpstreamExport | null => {
        const staged = waiting.get(token) ?? null;
        if (staged) {
            clearTimeout(staged.timer);
            waiting.delete(token);
        }
        return staged;
    };
    const cancel = async (token: string) => {
        const staged = detach(token);
        if (staged) {
            await remove(staged);
        }
    };
    return {
        /** Aborted at close: a running prepare's worker is terminated. */
        signal: controller.signal,
        /** Whether `close` was called: no export is added any more. */
        get closed() {
            return closing !== null;
        },
        /** Whether a prepare would be refused: `MAX_UPSTREAM_EXPORTS_STAGED` exports wait, or the store is closed. */
        get full() {
            return closing !== null || waiting.size >= MAX_UPSTREAM_EXPORTS_STAGED;
        },
        /** The prepared exports waiting (tests). */
        get size() {
            return waiting.size;
        },
        /** Stages a prepared export and answers its token; null once the store is full or closed. */
        add(staged: StagedUpstreamExport): string | null {
            if (closing !== null || waiting.size >= MAX_UPSTREAM_EXPORTS_STAGED) {
                return null;
            }
            const token = randomUUID();
            const timer = setTimeout(() => {
                const expired = detach(token);
                if (expired) {
                    void remove(expired);
                }
            }, ttlMs);
            timer.unref?.();
            waiting.set(token, { ...staged, timer });
            return token;
        },
        /** The export `token` names, still waiting (null when gone). */
        get(token: string): StagedUpstreamExport | null {
            return waiting.get(token) ?? null;
        },
        /** Takes the export `token` names out for its download, which removes its folder. */
        take(token: string): StagedUpstreamExport | null {
            return detach(token);
        },
        /** Removes the export `token` names, if it still waits. */
        cancel,
        /** Aborts running workers, removes waiting exports, refuses new ones, and waits for removals. */
        close(): Promise<void> {
            if (closing === null) {
                closing = (async () => {
                    await Promise.all([...waiting.keys()].map(cancel));
                    await Promise.all([...removals]);
                })();
                controller.abort();
            }
            return closing;
        },
    };
}

/** The prepare's body, checked; null when a field is missing or of the wrong kind. */
function parseExportRequest(body: unknown): UpstreamExportRequest | null {
    if (!isPlainObject(body)) {
        return null;
    }
    const { promptPresetId, modelPresetId, personaId, includeSecrets, selectedChat } = body;
    if (
        typeof promptPresetId !== "string" ||
        typeof modelPresetId !== "string" ||
        typeof personaId !== "string" ||
        typeof includeSecrets !== "boolean"
    ) {
        return null;
    }
    const request: UpstreamExportRequest = { promptPresetId, modelPresetId, personaId, includeSecrets };
    if (selectedChat !== undefined) {
        if (
            !isPlainObject(selectedChat) ||
            typeof selectedChat.characterId !== "string" ||
            typeof selectedChat.chatId !== "string"
        ) {
            return null;
        }
        request.selectedChat = { characterId: selectedChat.characterId, chatId: selectedChat.chatId };
    }
    return request;
}

/**
 * The upstream RisuAI-compatible `.bin` export (contract in `shared/upstreamExportReport.ts`), in
 * two steps, so the tab shows the report before the download. Neither step writes the live store,
 * so neither takes the archive import's slot: an export runs beside a waiting or running import as
 * the version-2 export does.
 *
 * `POST /api/backups/export-upstream/prepare` `UpstreamExportRequest`: auth; 400 for an invalid body;
 * 409 `UPSTREAM_EXPORT_TOO_MANY_STAGED` while that many prepared exports wait or are being prepared;
 * 503 once shutdown began. Tracked by `snapshots.track` up to the token's hand-over, so shutdown waits for it. One consistent copy of the store
 * (`snapshots.exclusive(() => store.backupTo(...))` into `save/.tmp/export-upstream-<uuid>/`), the
 * asset inventory listed after it (a blob is written before the record naming it), then a heap-capped
 * worker reads the copy, projects it with `buildUpstreamDatabase`, encodes it, checks its size, and
 * writes `database.risudat`. A disconnect or shutdown terminates the worker before cleanup. The copy
 * is removed after the worker ends, and references absent from the inventory are reported missing. Each
 * referenced asset becomes a record named by its key without `assets/` when such a record can hold it
 * (`upstreamAssetRecordName`; otherwise reported as `asset-names`) and its file is a regular file the
 * format can hold (otherwise reported missing). 413 when the database or the asset count does not fit
 * the archive format. Answers `{ token, report }`; a client gone meanwhile gets nothing staged.
 *
 * `GET /api/backups/export-upstream/download?token=`: 400 for a malformed token, 404 `Export expired`
 * for one that names no waiting export (expired, cancelled, or downloaded already). The token is used
 * up here. Streams one record per asset, then `database.risudat` last, with the version-2 export's
 * lifetime (`backups.ts`): tracked until the stream ends, is cancelled, or the client leaves, and the
 * folder removed then.
 *
 * `POST /api/backups/export-upstream/cancel` `{ token }`: removes the waiting export; 204 either way.
 */
export function registerUpstreamExportRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        store: ResourceStore;
        snapshots: SnapshotManager;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        /** The prepared exports (closed at shutdown by the caller); a store of its own without one. */
        staging?: UpstreamExportStaging;
        /** The exporter's clock (the trash times); default `Date.now`. */
        now?: () => number;
        /** The worker's old-generation heap cap; default `RISU_UPSTREAM_EXPORT_HEAP_MB`, read at registration. */
        heapMb?: number;
    },
) {
    const { savePath, store, snapshots, auth, limiter } = arg;
    const staging = arg.staging ?? createUpstreamExportStaging();
    const now = arg.now ?? Date.now;
    const heapMb = arg.heapMb ?? upstreamExportHeapMb(process.env.RISU_UPSTREAM_EXPORT_HEAP_MB);
    const tmpPath = path.join(savePath, ".tmp");
    const assetsPath = path.join(savePath, "assets");

    /** Builds a prepared export in a new staging folder; null when `signal` aborted (the folder removed). */
    async function prepare(
        request: UpstreamExportRequest,
        signal: AbortSignal,
    ): Promise<{ staged: StagedUpstreamExport; report: UpstreamExportReport } | null> {
        const folder = await makeStaging(tmpPath, "export-upstream");
        let kept = false;
        try {
            const copy = path.join(folder, "resources.sqlite");
            await snapshots.exclusive(() => store.backupTo(copy));
            if (signal.aborted) {
                return null;
            }
            const onDisk = new Set(await listAssetKeys(assetsPath));
            if (signal.aborted) {
                return null;
            }
            const databaseFile = path.join(folder, UPSTREAM_DATABASE_RECORD);
            let result: UpstreamExportStageResult;
            try {
                result = await runUpstreamExportWorker(
                    { copyFile: copy, databaseFile, request, now: now() },
                    {
                        signal: AbortSignal.any([signal, staging.signal]),
                        resourceLimits: {
                            maxOldGenerationSizeMb: heapMb,
                            maxYoungGenerationSizeMb: 64,
                            stackSizeMb: 4,
                        },
                    },
                );
            } catch (error) {
                if (staging.closed) {
                    throw new MaintenanceError("The server is shutting down");
                }
                if (signal.aborted) {
                    return null;
                }
                throw error;
            }
            // The copy holds every credential; only the encoded database is kept.
            await fs.rm(copy, { force: true });
            if (signal.aborted) {
                return null;
            }
            const { assetKeys, report } = result;
            for (const reference of assetKeys) {
                if (!onDisk.has(reference.key)) {
                    report.missing.push(reference);
                }
            }
            const assets: StagedUpstreamExport["assets"] = [];
            for (const reference of assetKeys) {
                if (!onDisk.has(reference.key)) {
                    continue;
                }
                const name = upstreamAssetRecordName(reference.key);
                const file = name === null ? null : resolveStorageKey(savePath, reference.key);
                if (name === null || file === null) {
                    addUpstreamReportEntry(report.excluded, "asset-names", reference.key);
                    continue;
                }
                const stat = await fs.lstat(file).catch(() => null);
                if (stat?.isFile() && stat.size <= MAX_ARCHIVE_RECORD_BYTES) {
                    assets.push({ name, file });
                } else {
                    report.missing.push(reference);
                }
            }
            report.counts.assets = assets.length;
            if (assets.length > MAX_ARCHIVE_RECORDS - 1) {
                throw new ArchiveRejectedError("Too many assets for one RisuAI backup");
            }
            if (signal.aborted) {
                return null;
            }
            kept = true;
            return { staged: { staging: folder, databaseFile, assets }, report };
        } finally {
            if (!kept) {
                await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    /** A prepare `staging` cannot take: 503 once it is closed (shutdown), else 409 (full). */
    const refuseStaging = (c: Context<AppEnv>) =>
        staging.closed
            ? backupErrorResponse(c, new MaintenanceError("The server is shutting down"))
            : c.json({ error: UPSTREAM_EXPORT_TOO_MANY_STAGED }, 409);
    // Prepares running now count toward `MAX_UPSTREAM_EXPORTS_STAGED`, so a burst is refused before it
    // copies the store, not after.
    let preparing = 0;

    app.post(UPSTREAM_EXPORT_PREPARE_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const request = parseExportRequest(parsed.body);
        if (request === null) {
            return c.json(
                { error: "promptPresetId, modelPresetId, personaId, includeSecrets, and selectedChat are invalid" },
                400,
            );
        }
        if (staging.closed || staging.size + preparing >= MAX_UPSTREAM_EXPORTS_STAGED) {
            return refuseStaging(c);
        }
        const signal = c.req.raw.signal;
        let outcome: { token: string; report: UpstreamExportReport } | "aborted" | "refused";
        preparing += 1;
        try {
            // The hand-over to `staging` and a refusal's removal are inside the tracked operation, so
            // shutdown (`snapshots.stop`) waits for them.
            outcome = await snapshots.track(async () => {
                const prepared = await prepare(request, signal);
                if (prepared === null) {
                    return "aborted";
                }
                const token = staging.add(prepared.staged);
                if (token === null) {
                    await fs.rm(prepared.staged.staging, { recursive: true, force: true }).catch(() => {});
                    return "refused";
                }
                return { token, report: prepared.report };
            });
        } catch (error) {
            if (error instanceof ArchiveRejectedError) {
                return c.json({ error: error.message }, 413);
            }
            return backupErrorResponse(c, error);
        } finally {
            preparing -= 1;
        }
        if (outcome === "aborted") {
            return c.json({ error: "Request aborted" }, 400);
        }
        if (outcome === "refused") {
            return refuseStaging(c);
        }
        c.header("Cache-Control", "no-store");
        return c.json(outcome satisfies UpstreamExportPrepared);
    });

    app.get(UPSTREAM_EXPORT_DOWNLOAD_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const token = c.req.query("token");
        if (typeof token !== "string" || !UPSTREAM_TOKEN_PATTERN.test(token)) {
            return c.json({ error: "Invalid export token" }, 400);
        }
        // From here to the export being taken, nothing awaits: the export found is the one taken.
        if (staging.get(token) === null) {
            return c.json({ error: UPSTREAM_EXPORT_EXPIRED }, 404);
        }
        let release!: () => void;
        const lifetime = new Promise<void>((resolve) => (release = resolve));
        try {
            void snapshots.track(() => lifetime);
        } catch (error) {
            return backupErrorResponse(c, error);
        }
        const staged = staging.take(token)!;
        let finalized: Promise<void> | null = null;
        const finalize = () =>
            (finalized ??= (async () => {
                await fs.rm(staged.staging, { recursive: true, force: true }).catch(() => {});
                release();
            })());
        const signal = c.req.raw.signal;
        if (signal.aborted) {
            await finalize();
            return c.json({ error: "Request aborted" }, 400);
        }

        async function* records(): AsyncGenerator<Uint8Array> {
            try {
                for (const asset of staged.assets) {
                    yield* fileRecord(asset.name, asset.file);
                }
                yield* fileRecord(UPSTREAM_DATABASE_RECORD, staged.databaseFile);
            } finally {
                await finalize();
            }
        }
        // As the version-2 export: a client that leaves may never cancel the stream, so the request
        // signal returns the generator, and `finalize` covers one that never started.
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

    app.post(UPSTREAM_EXPORT_CANCEL_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const { token } = parsed.body as { token?: unknown };
        if (typeof token !== "string" || !UPSTREAM_TOKEN_PATTERN.test(token)) {
            return c.json({ error: "Invalid export token" }, 400);
        }
        await staging.cancel(token);
        return c.body(null, 204);
    });
}
