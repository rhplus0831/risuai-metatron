import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono, MiddlewareHandler } from "hono";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    MAX_UPSTREAM_STAGED,
    UPSTREAM_CHANGED_SINCE_REVIEW,
    UPSTREAM_IMPORT_CANCEL_PATH,
    UPSTREAM_IMPORT_COMMIT_PATH,
    UPSTREAM_IMPORT_EXPIRED,
    UPSTREAM_IMPORT_PREPARE_PATH,
    UPSTREAM_STAGED_TTL_MS,
    UPSTREAM_TOKEN_PATTERN,
    UPSTREAM_TOO_MANY_STAGED,
    type UpstreamImportCommitted,
    type UpstreamImportPrepared,
    type UpstreamImportProgress,
    type UpstreamImportSelection,
} from "../../../shared/upstreamBackup.ts";
import { ArchiveRejectedError } from "../data/archive.ts";
import { ResourceEpochError, type ResourceStore, ResourceValidationError } from "../data/resourceStore.ts";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import { planUpstreamArchive, type UpstreamArchivePlan } from "../data/upstream/archive.ts";
import {
    DEFAULT_MAX_UPSTREAM_DB_BYTES,
    defaultUpstreamImportHeapMb,
    UpstreamImportError,
    type UpstreamImportRunner,
    runUpstreamImportWorker,
} from "../data/upstream/importRunner.ts";
import { STAGED_ASSETS_DIR, STAGED_DATABASE_FILE } from "../data/upstream/importStage.ts";
import { UpstreamFormatError } from "../data/upstream/risuSave.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import { readJsonBody } from "../http/body.ts";
import { type FileImportStream, type ImportSlot, serveFileImport } from "../http/fileImport.ts";
import { ndjsonLine } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { backupErrorResponse, restoreValidated } from "./backups.ts";

/** The spooled `.bin` in its staging folder. */
const ARCHIVE_FILE = "archive.bin";

/** A prepared import waiting for its commit: its staging folder and what the commit installs and checks. */
type StagedUpstreamImport = {
    staging: string;
    /** The validated staged store (`importStage.ts`). */
    databaseFile: string;
    /** Every archive asset: its file under `save/assets` and its extracted copy in the staging folder. */
    assets: { target: string; staged: string }[];
    selection: UpstreamImportSelection;
    /** The live store's epoch and `writeCount()` when the prepare ended (D13). */
    epoch: string;
    writeCount: number;
};

/**
 * The prepared upstream imports (see `registerUpstreamImportRoutes`): each waits outside the import
 * slot for its commit or cancel, at most `ttlMs` (`UPSTREAM_STAGED_TTL_MS`) from its prepare's answer,
 * and at most `MAX_UPSTREAM_STAGED` at once (the Realm staging's pattern, `importRealm.ts`). Expiry,
 * cancel, and `close` remove the staging folder; a commit takes the import out (`take`) and removes it
 * itself. `close` (shutdown) also aborts a running prepare (`signal`), so shutdown does not wait for a
 * conversion, and waits for every removal it or an expiry started. What a crash leaves under
 * `save/.tmp` is emptied at the next start (`routes/storage.ts`).
 */
export type UpstreamImportStaging = ReturnType<typeof createUpstreamImportStaging>;

export function createUpstreamImportStaging(options: { ttlMs?: number } = {}) {
    const ttlMs = options.ttlMs ?? UPSTREAM_STAGED_TTL_MS;
    const waiting = new Map<string, StagedUpstreamImport & { timer: ReturnType<typeof setTimeout> }>();
    const removals = new Set<Promise<void>>();
    const shutdown = new AbortController();
    let closing: Promise<void> | null = null;
    const remove = (staged: StagedUpstreamImport): Promise<void> => {
        const removal = fs.rm(staged.staging, { recursive: true, force: true }).catch(() => {});
        removals.add(removal);
        void removal.then(() => removals.delete(removal));
        return removal;
    };
    const detach = (token: string): StagedUpstreamImport | null => {
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
        /** Aborted by `close`: a running prepare stops (its worker is terminated). */
        signal: shutdown.signal,
        /** Whether a prepare would be refused: `MAX_UPSTREAM_STAGED` imports wait, or the store is closed. */
        get full() {
            return closing !== null || waiting.size >= MAX_UPSTREAM_STAGED;
        },
        /** The prepared imports waiting (tests). */
        get size() {
            return waiting.size;
        },
        /** Stages a prepared import and answers its token; null once the store is full or closed. */
        add(staged: StagedUpstreamImport): string | null {
            if (closing !== null || waiting.size >= MAX_UPSTREAM_STAGED) {
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
        /** The import `token` names, still waiting (null when gone). */
        get(token: string): StagedUpstreamImport | null {
            return waiting.get(token) ?? null;
        },
        /** Takes the import `token` names out for its commit, which removes its folder. */
        take(token: string): StagedUpstreamImport | null {
            return detach(token);
        },
        /** Removes the import `token` names, if it still waits. */
        cancel,
        /**
         * Aborts a running prepare, removes every waiting import, refuses new ones, and waits for the
         * removals (an expiry's too). Calling it again returns the same promise.
         */
        close(): Promise<void> {
            closing ??= (async () => {
                shutdown.abort(new MaintenanceError("The server is shutting down"));
                await Promise.all([...waiting.keys()].map(cancel));
                await Promise.all([...removals]);
            })();
            return closing;
        },
    };
}

/**
 * The upstream RisuAI `.bin` import (`docs/plan/upstream-bin-compat.md` S5, `shared/upstreamBackup.ts`),
 * in two steps, so that the user reads the report before anything is replaced:
 *
 * `POST /api/backups/import-upstream/prepare`: the `.bin` as the raw body, under `serveFileImport`'s
 * lifecycle (`http/fileImport.ts`; the slot is the backup import's, so one import at a time): auth;
 * a declared length over `maxImportBytes` (413); another import (409); maintenance (503); then, before
 * the body is read, the epoch (412) and a prepared import already waiting (409
 * `UPSTREAM_TOO_MANY_STAGED`). The body is spooled to `save/.tmp/upstream-<uuid>/archive.bin` and
 * classified on this thread (`planUpstreamArchive`: the index and the names only), so a refused
 * archive (a Risu Account backup, a version-2 archive, no database) is a 400. The rest runs in a
 * worker (`importRunner.ts`, a heap-capped `worker_threads` thread; the event loop stays free): the
 * decode, the cold-storage reads, the conversion, the staged store and its validation, and the asset
 * extraction. The answer is NDJSON: `{ phase, done, total }` lines (coalesced to the latest while the
 * client reads), then `{ token, report, selection }`, or one `{ error }` line for a backup the worker refused or
 * could not finish (out of memory included). The live store is not written. A client that leaves, or
 * shutdown (`staging.close`), terminates the worker; the folder is removed once it has ended.
 *
 * `POST /api/backups/import-upstream/commit` `{ token, acceptWrites? }`: 404 `Import expired` for a
 * token that names no waiting import; 409 while another import runs, 503 during maintenance, 412 for
 * another epoch (the import kept); then the changed-since-review check (D13), before maintenance so a
 * refusal ends no job: when resources were written since the prepare and `acceptWrites` is not that
 * count, `409 { error: "changedSinceReview", writes }` (the import kept). Otherwise, under
 * maintenance: the epoch, `readSnapshot` of the staged store (here, inside the window where writes are
 * closed anyway; 400 when it fails, the jobs that maintenance ended stay ended), then
 * `restoreValidated` (the safety snapshot, the extracted assets linked where no file exists, the
 * epoch, `replaceAll`). Answers `{ epoch, assetsWritten, assetsSkipped, selection }`; the folder is
 * removed whatever happened.
 *
 * `POST /api/backups/import-upstream/cancel` `{ token }`: removes the waiting import; 204 either way.
 */
export function registerUpstreamImportRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        store: ResourceStore;
        snapshots: SnapshotManager;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maxImportBytes: number;
        /** The backup import's slot (`registerBackupRoutes`). */
        slot: ImportSlot;
        diagnostics?: DiagnosticsRecorder;
        /** The prepared imports (closed at shutdown by the caller); a store of its own without one. */
        staging?: UpstreamImportStaging;
        /** Cap of the decoded database (D1); default `DEFAULT_MAX_UPSTREAM_DB_BYTES`. */
        maxDatabaseBytes?: number;
        /** The worker's old-generation limit in MiB; default `defaultUpstreamImportHeapMb`. */
        heapMb?: number;
        /** Runs a prepare (tests inject one); default a new worker per import. */
        runner?: UpstreamImportRunner;
        /** The converter's clock (a character's missing `creation_date`); default `Date.now`. */
        now?: () => number;
    },
) {
    const { savePath, store, snapshots, auth, limiter, maxImportBytes, slot, diagnostics } = arg;
    const staging = arg.staging ?? createUpstreamImportStaging();
    const maxDatabaseBytes = arg.maxDatabaseBytes ?? DEFAULT_MAX_UPSTREAM_DB_BYTES;
    const heapMb = arg.heapMb ?? defaultUpstreamImportHeapMb(maxDatabaseBytes);
    const runner: UpstreamImportRunner =
        arg.runner ??
        ((input, options) =>
            runUpstreamImportWorker(input, {
                ...options,
                resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
            }));
    const now = arg.now ?? Date.now;
    const assetsPath = path.join(savePath, "assets");
    const deps = { savePath, snapshots, auth, maxImportBytes, slot };

    app.post(UPSTREAM_IMPORT_PREPARE_PATH, limiter, (c) =>
        serveFileImport<UpstreamArchivePlan>(c, deps, {
            stagingPrefix: "upstream",
            fileName: ARCHIVE_FILE,
            missingBody: "Backup body required",
            preflight: (c) => {
                try {
                    store.assertEpoch(c.req.header(RESOURCE_EPOCH_HEADER));
                } catch (error) {
                    return backupErrorResponse(c, error);
                }
                return staging.full ? c.json({ error: UPSTREAM_TOO_MANY_STAGED }, 409) : null;
            },
            abort: staging.signal,
            prepare: async (handle, _meta, signal) => {
                const plan = await planUpstreamArchive(handle, savePath, signal);
                signal.throwIfAborted();
                return plan;
            },
            refusal: (c, error) => {
                if (
                    error instanceof ArchiveRejectedError ||
                    error instanceof ResourceValidationError ||
                    error instanceof ResourceEpochError
                ) {
                    return backupErrorResponse(c, error);
                }
                if (error instanceof Error && error.name === "AbortError") {
                    return c.json({ error: "Request aborted" }, 400);
                }
                return null;
            },
            lines: (plan, stream) => prepareLines(plan, stream),
        }),
    );

    /**
     * The prepare's lines (see the route comment). Never throws. The staged import is handed over in
     * this order: added to `staging` (a refusal there removes the folder), then kept, then the slot
     * released (`finalize`), then the token sent. The worker has always ended before the finalizer
     * removes the folder.
     */
    async function* prepareLines(plan: UpstreamArchivePlan, stream: FileImportStream): AsyncGenerator<Uint8Array> {
        const { staging: folder, finalize, keep } = stream;
        const stop = new AbortController();
        const signal = AbortSignal.any([stream.signal, stop.signal]);
        // Written by the run's callbacks: the latest progress not sent yet, and the run's end.
        const state: {
            progress: UpstreamImportProgress | null;
            outcome:
                { ok: true; value: Awaited<ReturnType<UpstreamImportRunner>> } | { ok: false; error: unknown } | null;
            wake: (() => void) | null;
        } = { progress: null, outcome: null, wake: null };
        let run: Promise<unknown> | null = null;
        try {
            run = runner(
                {
                    archiveFile: path.join(folder, ARCHIVE_FILE),
                    staging: folder,
                    plan,
                    maxDecodedBytes: maxDatabaseBytes,
                    now: now(),
                },
                {
                    signal,
                    onProgress: (phase, done, total) => {
                        state.progress = { phase, done, total };
                        state.wake?.();
                    },
                },
            ).then(
                (value) => {
                    state.outcome = { ok: true, value };
                    state.wake?.();
                },
                (error: unknown) => {
                    state.outcome = { ok: false, error };
                    state.wake?.();
                },
            );
            let settled: NonNullable<typeof state.outcome>;
            while (true) {
                if (state.progress) {
                    const line = ndjsonLine(state.progress);
                    state.progress = null;
                    yield line;
                    continue;
                }
                if (state.outcome) {
                    settled = state.outcome;
                    break;
                }
                await new Promise<void>((resolve) => (state.wake = resolve));
                state.wake = null;
            }
            if (!settled.ok) {
                if (signal.aborted && !(settled.error instanceof UpstreamImportError)) {
                    await finalize();
                    if (staging.signal.aborted) {
                        yield ndjsonLine({ error: "The server is shutting down" });
                    }
                    return;
                }
                const line = ndjsonLine({ error: failureText(settled.error) });
                await finalize();
                yield line;
                return;
            }
            const token = signal.aborted
                ? null
                : staging.add({
                      staging: folder,
                      databaseFile: path.join(folder, STAGED_DATABASE_FILE),
                      assets: plan.assets.map((asset, index) => ({
                          target: asset.target,
                          staged: path.join(folder, STAGED_ASSETS_DIR, String(index)),
                      })),
                      selection: settled.value.selection,
                      epoch: store.epoch(),
                      writeCount: store.writeCount(),
                  });
            if (token === null) {
                await finalize();
                yield ndjsonLine({ error: "The server is shutting down" });
                return;
            }
            keep();
            const line = ndjsonLine({
                token,
                report: settled.value.report,
                selection: settled.value.selection,
            } satisfies UpstreamImportPrepared);
            await finalize();
            yield line;
        } finally {
            // The worker ends (terminated if it still runs) before the folder goes.
            stop.abort();
            await run?.catch(() => {});
            await finalize();
        }
    }

    app.post(UPSTREAM_IMPORT_COMMIT_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const { token, acceptWrites } = parsed.body as { token?: unknown; acceptWrites?: unknown };
        if (typeof token !== "string" || !UPSTREAM_TOKEN_PATTERN.test(token)) {
            return c.json({ error: "Invalid import token" }, 400);
        }
        if (acceptWrites !== undefined && !(Number.isSafeInteger(acceptWrites) && (acceptWrites as number) >= 0)) {
            return c.json({ error: "acceptWrites must be a count" }, 400);
        }
        // From here to the slot being taken, nothing awaits: the import found is the one taken.
        const staged = staging.get(token);
        if (!staged) {
            return c.json({ error: UPSTREAM_IMPORT_EXPIRED }, 404);
        }
        if (slot.busy) {
            return c.json({ error: "Another import is running" }, 409);
        }
        if (snapshots.gate.active) {
            return backupErrorResponse(c, new MaintenanceError());
        }
        const expectedEpoch = c.req.header(RESOURCE_EPOCH_HEADER);
        try {
            store.assertEpoch(expectedEpoch);
            // A restore since the prepare replaced the data it was compared with (the tab reloads).
            store.assertEpoch(staged.epoch);
        } catch (error) {
            return backupErrorResponse(c, error);
        }
        // D13: before maintenance, so a refusal ends no running job. Not repeated under the lock: the
        // jobs' own abort checkpoints there count as writes. The window until the gate closes is
        // accepted; the safety snapshot holds what lands in it.
        const writes = store.writeCount() - staged.writeCount;
        if (writes > 0 && writes !== acceptWrites) {
            return c.json({ error: UPSTREAM_CHANGED_SINCE_REVIEW, writes }, 409);
        }
        let release!: () => void;
        const lifetime = new Promise<void>((resolve) => (release = resolve));
        try {
            void snapshots.track(() => lifetime);
        } catch (error) {
            return backupErrorResponse(c, error);
        }
        slot.busy = true;
        const taken = staging.take(token)!;
        try {
            const result = await snapshots.withMaintenance(async ({ snapshot }) => {
                store.assertEpoch(expectedEpoch);
                const validated = store.readSnapshot(taken.databaseFile);
                return restoreValidated({
                    store,
                    assetsPath,
                    expectedEpoch,
                    snapshot,
                    validated,
                    assets: taken.assets.map((asset) => ({ target: asset.target, stage: async () => asset.staged })),
                });
            });
            recordSafely(diagnostics, { kind: "lifecycle", phase: "import" });
            return c.json({ ...result, selection: taken.selection } satisfies UpstreamImportCommitted);
        } catch (error) {
            return backupErrorResponse(c, error);
        } finally {
            await fs.rm(taken.staging, { recursive: true, force: true }).catch(() => {});
            slot.busy = false;
            release();
        }
    });

    app.post(UPSTREAM_IMPORT_CANCEL_PATH, limiter, async (c) => {
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
            return c.json({ error: "Invalid import token" }, 400);
        }
        await staging.cancel(token);
        return c.body(null, 204);
    });
}

/** The `{ error }` line's text for a failed prepare: a refusal's own message, else a generic one (logged). */
function failureText(error: unknown): string {
    if (
        error instanceof UpstreamImportError ||
        error instanceof UpstreamFormatError ||
        error instanceof ArchiveRejectedError ||
        error instanceof ResourceValidationError
    ) {
        return error.message;
    }
    console.error("[Server] Upstream import failed:", error);
    return `The backup could not be imported: ${error instanceof Error ? error.message : String(error)}`;
}
