/** Runs export scrubbing off the serving thread and waits for the worker to end before staging can be removed. */
import { Worker } from "node:worker_threads";
import type { ExportScrubWorkerMessage } from "./worker.ts";

export type ExportScrubInput = { source: string; output: string; partial: boolean };
export type ExportScrubResult = { selectedKeys: string[] };

export function runExportScrubWorker(input: ExportScrubInput): Promise<ExportScrubResult> {
    return new Promise((resolve, reject) => {
        let worker: Worker;
        try {
            worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
        } catch (error) {
            console.error("[Server] Backup export scrub failed:", error);
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        let settled = false;
        const settle = (outcome: { result: ExportScrubResult } | { error: Error }) => {
            if (settled) {
                return;
            }
            settled = true;
            void worker
                .terminate()
                .catch(() => {})
                .then(() => ("result" in outcome ? resolve(outcome.result) : reject(outcome.error)));
        };
        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            console.error("[Server] Backup export scrub failed:", error);
            settle({ error });
        };
        worker.on("message", (message: ExportScrubWorkerMessage) => {
            switch (message.type) {
                case "done":
                    settle({ result: message.result });
                    break;
                case "error":
                    fail(new Error(message.message));
                    break;
            }
        });
        worker.on("error", (error) => fail(new Error(error.message)));
        worker.on("exit", (code) => fail(new Error(`The export scrub stopped before it finished (exit code ${code})`)));
    });
}
