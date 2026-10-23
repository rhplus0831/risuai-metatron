import { parentPort, workerData } from "node:worker_threads";
import { ArchiveRejectedError } from "../archive.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { stageUpstreamExport, type UpstreamExportStageInput, type UpstreamExportStageResult } from "./exportStage.ts";

/**
 * One upstream export worker per prepare, started by `exportRunner.ts` under a heap limit. It reads
 * and stages the database itself, then posts the report and references, never the database or secrets.
 */
export type UpstreamExportWorkerData = {
    input: UpstreamExportStageInput;
    /**
     * A test hook: the worker posts `held` and waits until `latch[0]` is no longer 0 before it starts,
     * so a test can hold a running worker without a timer.
     */
    latch?: Int32Array;
};

export type UpstreamExportWorkerMessage =
    | { type: "held" }
    | { type: "done"; result: UpstreamExportStageResult }
    /** Custom error prototypes do not cross the worker boundary; the runner restores them by kind. */
    | { type: "error"; message: string; kind: "rejected" | "invalid" | "failed" };

const port = parentPort!;
const { input, latch } = workerData as UpstreamExportWorkerData;
const post = (message: UpstreamExportWorkerMessage) => port.postMessage(message);

if (latch) {
    post({ type: "held" });
    while (Atomics.load(latch, 0) === 0) {
        Atomics.wait(latch, 0, 0);
    }
}
try {
    const result = await stageUpstreamExport(input);
    post({ type: "done", result });
} catch (error) {
    const kind =
        error instanceof ArchiveRejectedError
            ? "rejected"
            : error instanceof ResourceValidationError
              ? "invalid"
              : "failed";
    post({ type: "error", message: error instanceof Error ? error.message : String(error), kind });
}
