import { on } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { createTokenizers, type TokenizerFamily } from "./index.ts";

/**
 * Owns one tokenizer set and handles each `{ id, op, family, text? }` call in turn. A load answers
 * with `{ id }`. A count or encode answers with `{ id, value }`, carrying a number or a fresh
 * `Uint32Array` whose buffer is transferred to the host. A failure sends its message in `{ id, error }`.
 * When the test latch holds a call, the worker posts `{ type: "held", id }` and waits before running it.
 */

export type TokenizerWorkerData = {
    rootDir: string;
    /** Tests can hold a call in the worker until they release the latch or terminate the thread. */
    latch?: Int32Array;
};

export type TokenizerRequest = { family: TokenizerFamily } & (
    { op: "load" } | { op: "count" | "encode"; text: string }
);
export type TokenizerWorkerCall = TokenizerRequest & { id: number };
export type TokenizerWorkerMessage =
    { type: "held"; id: number } | { id: number; value?: number | Uint32Array } | { id: number; error: string };

const port = parentPort!;
const { rootDir, latch } = workerData as TokenizerWorkerData;
const tokenizers = createTokenizers({ rootDir });
const post = (message: TokenizerWorkerMessage, transfer?: ArrayBuffer[]) => port.postMessage(message, transfer);

async function answer(call: TokenizerWorkerCall): Promise<void> {
    const { id, family } = call;
    if (latch && Atomics.load(latch, 0) === 0) {
        post({ type: "held", id });
        while (Atomics.load(latch, 0) === 0) {
            Atomics.wait(latch, 0, 0);
        }
    }
    try {
        switch (call.op) {
            case "load":
                await tokenizers.load(family);
                post({ id });
                break;
            case "count":
                post({ id, value: await tokenizers.count(family, call.text) });
                break;
            case "encode": {
                const ids = new Uint32Array(await tokenizers.encode(family, call.text));
                post({ id, value: ids }, [ids.buffer]);
                break;
            }
        }
    } catch (error) {
        post({ id, error: error instanceof Error ? error.message : String(error) });
    }
}

for await (const [call] of on(port, "message")) {
    await answer(call);
}
