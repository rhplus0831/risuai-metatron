import { type ResourceLimits, Worker } from "node:worker_threads";
import type { ResourceKindRegistry } from "../kinds.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { type RestoreProgress, type StagedFileReport, stageValidatedSnapshot } from "./stageValidatedSnapshot.ts";
import type { RestoreWorkerData, RestoreWorkerMessage } from "./validateWorker.ts";

/**
 * Starts and ends the restore worker (`validateWorker.ts`) from the server's thread. The heap limit
 * covers the JavaScript heap only (not Buffers or SQLite's own memory), and a `--max-old-space-size`
 * the server inherited overrides it, so it is a ceiling against a runaway snapshot, not process
 * isolation.
 */

/** The worker's default old-generation limit; `RISU_RESTORE_HEAP_MB` overrides it. */
export const DEFAULT_RESTORE_HEAP_MB = 2048;

/** The snapshot file to check and the new staged store to write. */
export type RestoreInput = { source: string; output: string };

export type RestoreRunOptions = {
    /** Aborting it terminates the worker; the run then rejects with the signal's reason. */
    signal: AbortSignal;
    onProgress: RestoreProgress;
};

/** What the backup routes stage a snapshot with: the worker by default, an in-process call for other kinds. */
export type RestoreRunner = (input: RestoreInput, options: RestoreRunOptions) => Promise<StagedFileReport>;

/** Stages on the calling thread, with `kinds`: what a store with its own kinds needs, the worker has only the defaults. */
export function inProcessRestoreRunner(kinds: ResourceKindRegistry): RestoreRunner {
    return ({ source, output }, { signal, onProgress }) =>
        stageValidatedSnapshot(source, output, kinds, onProgress, signal);
}

/** The default runner: a new worker per restore, its old generation limited to `heapMb`. */
export function workerRestoreRunner(heapMb: number): RestoreRunner {
    return (input, options) =>
        runRestoreWorker(input, {
            ...options,
            resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
        });
}

/**
 * Runs one restore's staging in a new worker. Settles once, and only after the worker has ended
 * (`terminate` awaited), so nothing writes into the staging folder afterwards: with the report; with a
 * `ResourceValidationError` for a refusal the worker reported, an out-of-memory end, or an exit before
 * a report; with an `Error` for an unexpected failure, which is logged; or with the signal's reason on
 * an abort. `latch` and `onHeld` are the test hook of `RestoreWorkerData`.
 */
export function runRestoreWorker(
    input: RestoreInput,
    options: RestoreRunOptions & {
        resourceLimits: ResourceLimits;
        latch?: Int32Array;
        onHeld?: () => void;
    },
): Promise<StagedFileReport> {
    const { signal, onProgress } = options;
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        let worker: Worker;
        try {
            worker = new Worker(new URL("./validateWorker.ts", import.meta.url), {
                workerData: { input, latch: options.latch } satisfies RestoreWorkerData,
                resourceLimits: options.resourceLimits,
            });
        } catch (error) {
            reject(error);
            return;
        }
        let settled = false;
        const settle = (outcome: { report: StagedFileReport } | { error: unknown }) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener("abort", onAbort);
            void worker
                .terminate()
                .catch(() => {})
                .then(() => ("report" in outcome ? resolve(outcome.report) : reject(outcome.error)));
        };
        const onAbort = () => settle({ error: signal.reason });
        signal.addEventListener("abort", onAbort, { once: true });
        worker.on("message", (message: RestoreWorkerMessage) => {
            if (settled) {
                return;
            }
            switch (message.type) {
                case "held":
                    options.onHeld?.();
                    break;
                case "progress":
                    onProgress(message.done, message.total);
                    break;
                case "done":
                    settle({ report: message.report });
                    break;
                case "error":
                    if (!message.known) {
                        console.error("[Server] Restore validation failed:", message.message);
                    }
                    settle({
                        error: message.known
                            ? new ResourceValidationError(message.message)
                            : new Error(message.message),
                    });
                    break;
            }
        });
        worker.on("error", (error: Error & { code?: string }) => {
            if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
                settle({
                    error: new ResourceValidationError(
                        "The database is too large for this server's restore memory limit (RISU_RESTORE_HEAP_MB)",
                    ),
                });
                return;
            }
            console.error("[Server] Restore validation failed:", error);
            settle({ error: new Error(error.message) });
        });
        worker.on("exit", (code) => {
            settle({
                error: new ResourceValidationError(`The restore stopped before it finished (exit code ${code})`),
            });
        });
    });
}
