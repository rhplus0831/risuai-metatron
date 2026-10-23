import { type ResourceLimits, Worker } from "node:worker_threads";
import { ArchiveRejectedError } from "../archive.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import type { UpstreamExportStageInput, UpstreamExportStageResult } from "./exportStage.ts";
import type { UpstreamExportWorkerData, UpstreamExportWorkerMessage } from "./exportWorker.ts";
import { DEFAULT_MAX_UPSTREAM_DB_BYTES, defaultUpstreamImportHeapMb } from "./importRunner.ts";

/**
 * Starts and ends the upstream export worker from the server's thread. The mandatory heap limit
 * bounds the JavaScript heap during snapshot reading, projection, and encoding; it does not bound
 * Buffers or SQLite's own memory.
 */

/**
 * The export worker's default old-generation limit: 2048 MiB, the import's default for its default
 * decoded-database cap. It does not follow `RISU_MAX_UPSTREAM_DB_BYTES`;
 * `RISU_UPSTREAM_EXPORT_HEAP_MB` overrides it independently.
 */
export const DEFAULT_UPSTREAM_EXPORT_HEAP_MB = defaultUpstreamImportHeapMb(DEFAULT_MAX_UPSTREAM_DB_BYTES);

/** Reads `RISU_UPSTREAM_EXPORT_HEAP_MB`; an invalid value refuses server startup. */
export function upstreamExportHeapMb(raw: string | undefined): number {
    if (raw === undefined || raw === "") {
        return DEFAULT_UPSTREAM_EXPORT_HEAP_MB;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid RISU_UPSTREAM_EXPORT_HEAP_MB: ${raw}`);
    }
    return value;
}

/**
 * Runs one prepare in a new worker. Settles once, only after `terminate` has ended the worker, so
 * the caller can remove its folder safely. Restores reported rejection and validation errors;
 * unexpected failures stay plain errors. An abort rejects with the signal's reason. `latch` and
 * `onHeld` are the test hook of `UpstreamExportWorkerData`.
 */
export function runUpstreamExportWorker(
    input: UpstreamExportStageInput,
    options: {
        signal: AbortSignal;
        resourceLimits: ResourceLimits;
        latch?: Int32Array;
        onHeld?: () => void;
    },
): Promise<UpstreamExportStageResult> {
    const { signal } = options;
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        let worker: Worker;
        try {
            worker = new Worker(new URL("./exportWorker.ts", import.meta.url), {
                workerData: { input, latch: options.latch } satisfies UpstreamExportWorkerData,
                resourceLimits: options.resourceLimits,
            });
        } catch (error) {
            reject(error);
            return;
        }
        let settled = false;
        const settle = (outcome: { result: UpstreamExportStageResult } | { error: unknown }) => {
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
        worker.on("message", (message: UpstreamExportWorkerMessage) => {
            if (settled) {
                return;
            }
            switch (message.type) {
                case "held":
                    options.onHeld?.();
                    break;
                case "done":
                    settle({ result: message.result });
                    break;
                case "error":
                    if (message.kind === "failed") {
                        console.error("[Server] Upstream export failed:", message.message);
                    }
                    settle({
                        error:
                            message.kind === "rejected"
                                ? new ArchiveRejectedError(message.message)
                                : message.kind === "invalid"
                                  ? new ResourceValidationError(message.message)
                                  : new Error(message.message),
                    });
                    break;
            }
        });
        worker.on("error", (error: Error & { code?: string }) => {
            settle({
                error:
                    error.code === "ERR_WORKER_OUT_OF_MEMORY"
                        ? new ArchiveRejectedError(
                              "The database is too large for this server's export memory limit (RISU_UPSTREAM_EXPORT_HEAP_MB)",
                          )
                        : new Error(error.message),
            });
        });
        worker.on("exit", (code) => {
            settle({ error: new Error(`The export stopped before it finished (exit code ${code})`) });
        });
    });
}
