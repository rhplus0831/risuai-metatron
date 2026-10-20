import { type ResourceLimits, Worker } from "node:worker_threads";
import type { UpstreamImportPhase } from "../../../../shared/upstreamBackup.ts";
import type { UpstreamStageInput, UpstreamStageResult } from "./importStage.ts";
import type { UpstreamImportWorkerData, UpstreamImportWorkerMessage } from "./importWorker.ts";

/**
 * Starts and ends the upstream import worker (`importWorker.ts`) from the server's thread
 * (`docs/plan/upstream-bin-compat.md` S5, D1). The worker's heap is always capped (`resourceLimits`):
 * msgpack headers can allocate past the decoded-size cap (S1 _Landed_), so an oversized database
 * ends the worker, not the server. The limit covers the JavaScript heap only (not Buffers or SQLite's
 * own memory), so it is a ceiling against a runaway decode, not process isolation.
 */

/** Default cap of the decoded database (D1); `RISU_MAX_UPSTREAM_DB_BYTES` overrides it. */
export const DEFAULT_MAX_UPSTREAM_DB_BYTES = 1024 * 1024 * 1024;

/**
 * The worker's default old-generation limit for a decoded-database cap: twice the cap in MiB (the
 * decoded objects and the conversion's output are held together), within 256 MiB to 4 GiB. 2 GiB for
 * the default 1 GiB cap. `RISU_UPSTREAM_IMPORT_HEAP_MB` overrides it.
 */
export function defaultUpstreamImportHeapMb(maxDecodedBytes: number): number {
    return Math.min(4096, Math.max(256, Math.ceil((2 * maxDecodedBytes) / (1024 * 1024))));
}

/** A failed prepare whose message is for the user: the backup was refused, or the worker ended. */
export class UpstreamImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UpstreamImportError";
    }
}

export type UpstreamImportRunOptions = {
    /** Aborting it terminates the worker; the run then rejects with the signal's reason. */
    signal: AbortSignal;
    onProgress: (phase: UpstreamImportPhase, done: number, total: number) => void;
};

/** What the import routes run a prepare with: the worker by default, an in-process call in tests. */
export type UpstreamImportRunner = (
    input: UpstreamStageInput,
    options: UpstreamImportRunOptions,
) => Promise<UpstreamStageResult>;

/**
 * Runs one prepare in a new worker. Settles once, and only after the worker has ended (`terminate`
 * awaited), so nothing writes into the staging folder afterwards: with the result, with an
 * `UpstreamImportError` (a refusal the worker reported, an out-of-memory end, any other failure or
 * exit before a result), or with the signal's reason on an abort. `latch` and `onHeld` are the test
 * hook of `UpstreamImportWorkerData`.
 */
export function runUpstreamImportWorker(
    input: UpstreamStageInput,
    options: UpstreamImportRunOptions & {
        resourceLimits: ResourceLimits;
        latch?: Int32Array;
        onHeld?: () => void;
    },
): Promise<UpstreamStageResult> {
    const { signal, onProgress } = options;
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        let worker: Worker;
        try {
            worker = new Worker(new URL("./importWorker.ts", import.meta.url), {
                workerData: { input, latch: options.latch } satisfies UpstreamImportWorkerData,
                resourceLimits: options.resourceLimits,
            });
        } catch (error) {
            reject(error);
            return;
        }
        let settled = false;
        const settle = (outcome: { result: UpstreamStageResult } | { error: unknown }) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener("abort", onAbort);
            void worker
                .terminate()
                .catch(() => {})
                .then(() => ("result" in outcome ? resolve(outcome.result) : reject(outcome.error)));
        };
        const onAbort = () => settle({ error: signal.reason });
        signal.addEventListener("abort", onAbort, { once: true });
        worker.on("message", (message: UpstreamImportWorkerMessage) => {
            if (settled) {
                return;
            }
            switch (message.type) {
                case "held":
                    options.onHeld?.();
                    break;
                case "progress":
                    onProgress(message.phase, message.done, message.total);
                    break;
                case "done":
                    settle({ result: message.result });
                    break;
                case "error":
                    if (!message.known) {
                        console.error("[Server] Upstream import failed:", message.message);
                    }
                    settle({
                        error: new UpstreamImportError(
                            message.known ? message.message : `The backup could not be imported: ${message.message}`,
                        ),
                    });
                    break;
            }
        });
        worker.on("error", (error: Error & { code?: string }) => {
            settle({
                error: new UpstreamImportError(
                    error.code === "ERR_WORKER_OUT_OF_MEMORY"
                        ? "The backup is too large for this server's import memory limit (RISU_UPSTREAM_IMPORT_HEAP_MB)"
                        : `The backup is unreadable: ${error.message}`,
                ),
            });
        });
        worker.on("exit", (code) => {
            settle({ error: new UpstreamImportError(`The import stopped before it finished (exit code ${code})`) });
        });
    });
}
