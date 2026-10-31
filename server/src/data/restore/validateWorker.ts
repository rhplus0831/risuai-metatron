import { parentPort, workerData } from "node:worker_threads";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../kinds.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { stageValidatedSnapshot, type StagedFileReport } from "./stageValidatedSnapshot.ts";
import type { RestoreInput } from "./validateRunner.ts";

/**
 * The restore worker: one `worker_threads` thread per restore, started by `validateRunner.ts` under a
 * heap limit. It runs `stageValidatedSnapshot` over the default kinds and posts what the route needs,
 * never a row: progress, then one report or one error.
 */
export type RestoreWorkerData = {
    input: RestoreInput;
    /**
     * A test hook: the worker posts `held` and waits until `latch[0]` is no longer 0 before it starts,
     * so a test can hold a running worker without a timer.
     */
    latch?: Int32Array;
};

export type RestoreWorkerMessage =
    | { type: "held" }
    | { type: "progress"; done: number; total: number }
    | { type: "done"; report: StagedFileReport }
    /** `known`: a refusal of the file (its message is for the user); otherwise an unexpected failure. */
    | { type: "error"; message: string; known: boolean };

const port = parentPort!;
const { input, latch } = workerData as RestoreWorkerData;
const post = (message: RestoreWorkerMessage) => port.postMessage(message);

if (latch) {
    post({ type: "held" });
    Atomics.wait(latch, 0, 0);
}
try {
    const report = await stageValidatedSnapshot(
        input.source,
        input.output,
        createKindRegistry(DEFAULT_RESOURCE_KINDS),
        (done, total) => post({ type: "progress", done, total }),
    );
    post({ type: "done", report });
} catch (error) {
    post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        known: error instanceof ResourceValidationError,
    });
}
