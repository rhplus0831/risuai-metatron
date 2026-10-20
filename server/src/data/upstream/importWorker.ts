import { parentPort, workerData } from "node:worker_threads";
import { ArchiveRejectedError } from "../archive.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { stageUpstreamImport, type UpstreamStageInput, type UpstreamStageResult } from "./importStage.ts";
import { UpstreamFormatError } from "./risuSave.ts";
import type { UpstreamImportPhase } from "../../../../shared/upstreamBackup.ts";

/**
 * The upstream import worker (`docs/plan/upstream-bin-compat.md` S5, D1): one `worker_threads` thread
 * per import, started by `importRunner.ts` under a heap limit. It runs `stageUpstreamImport` and posts
 * what the route needs, never the decoded database or the staged rows: progress, then one result or
 * one error.
 */
export type UpstreamImportWorkerData = {
    input: UpstreamStageInput;
    /**
     * A test hook: the worker posts `held` and waits until `latch[0]` is no longer 0 before it starts,
     * so a test can hold a running worker without a timer.
     */
    latch?: Int32Array;
};

export type UpstreamImportWorkerMessage =
    | { type: "held" }
    | { type: "progress"; phase: UpstreamImportPhase; done: number; total: number }
    | { type: "done"; result: UpstreamStageResult }
    /** `known`: a refusal of the backup (its message is for the user); otherwise an unexpected failure. */
    | { type: "error"; message: string; known: boolean };

const port = parentPort!;
const { input, latch } = workerData as UpstreamImportWorkerData;
const post = (message: UpstreamImportWorkerMessage) => port.postMessage(message);

if (latch) {
    post({ type: "held" });
    Atomics.wait(latch, 0, 0);
}
try {
    const result = await stageUpstreamImport(input, (phase, done, total) =>
        post({ type: "progress", phase, done, total }),
    );
    post({ type: "done", result });
} catch (error) {
    const known =
        error instanceof UpstreamFormatError ||
        error instanceof ArchiveRejectedError ||
        error instanceof ResourceValidationError;
    post({ type: "error", message: error instanceof Error ? error.message : String(error), known });
}
