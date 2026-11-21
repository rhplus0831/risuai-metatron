import { type Transferable, Worker } from "node:worker_threads";
import type { Tokenizers } from "./index.ts";
import type { TokenizerRequest, TokenizerWorkerCall, TokenizerWorkerData, TokenizerWorkerMessage } from "./worker.ts";

/**
 * `createWorkerTokenizers` is the server context's tokenizer set. The worker itself, `loadAll.ts`,
 * `util/memoryEval.mjs`, and tests use the in-thread `createTokenizers` set.
 * The main thread starts the worker on the first call and posts one call at a time in arrival order.
 * A load resolves to `undefined`, a count to a number, and an encode to its ids. A failure rejects
 * with `new Error(message)` so `isTokenizerTextRefusal` still recognizes refused text.
 *
 * An unexpected worker end fails only the running call. At `exit`, a replacement starts with the
 * next queued call, skipping the failed one. Each failed start rejects one call. The worker stays
 * ref'ed while a call runs or waits, including while a replacement is owed, and unref'ed while idle.
 * Disposal is terminal. It rejects queued and running calls and returns one shared promise that
 * resolves after the thread ends. Tests can supply `startWorker` to observe or replace the port
 * and `latch` to hold a call inside the worker.
 */

/** The worker methods and events the host uses to dispatch calls and manage the thread's lifetime. */
export type TokenizerWorkerPort = {
    postMessage(call: TokenizerWorkerCall, transfer?: readonly Transferable[]): void;
    terminate(): Promise<unknown>;
    ref(): void;
    unref(): void;
    on(event: "message", listener: (message: TokenizerWorkerMessage) => void): void;
    on(event: "error", listener: (error: unknown) => void): void;
    on(event: "exit", listener: (code: number) => void): void;
};

type StartWorker = (workerData: TokenizerWorkerData) => TokenizerWorkerPort;

/** Starts the tokenizer thread with Node's default resource limits. */
export function startTokenizerWorker(workerData: TokenizerWorkerData): Worker {
    return new Worker(new URL("./worker.ts", import.meta.url), { workerData });
}

type Result = void | number | Uint32Array;
type PendingCall = {
    message: TokenizerWorkerCall;
    resolve: (result: Result) => void;
    reject: (error: unknown) => void;
};

function createLane(workerData: TokenizerWorkerData, startWorker: StartWorker) {
    const queue: PendingCall[] = [];
    let nextId = 1;
    let running: PendingCall | undefined;
    let worker: TokenizerWorkerPort | undefined;
    let awaitingExit = false;
    let disposal: Promise<void> | undefined;

    function rejectRunning(error: unknown) {
        running?.reject(error);
        running = undefined;
    }

    function start() {
        const port = startWorker(workerData);
        port.on("message", (message) => {
            if (port !== worker || "type" in message || running?.message.id !== message.id) return;
            if ("error" in message) {
                running.reject(new Error(message.error));
            } else {
                running.resolve(message.value);
            }
            running = undefined;
            pump();
        });
        port.on("error", (error) => {
            if (port !== worker || disposal) return;
            // Node can silently drop a call posted between error and exit. Only exit can replace this port.
            awaitingExit = true;
            const reason = error instanceof Error ? error.message : String(error);
            rejectRunning(new Error(`The tokenizer worker stopped: ${reason}`));
            pump();
        });
        port.on("exit", (code) => {
            if (port !== worker) return;
            worker = undefined;
            awaitingExit = false;
            if (disposal) return;
            rejectRunning(new Error(`The tokenizer worker stopped (exit code ${code})`));
            pump();
        });
        return port;
    }

    function pump() {
        while (!disposal && !running) {
            if (!queue.length) {
                worker?.unref();
                return;
            }
            if (awaitingExit) {
                worker?.ref();
                return;
            }
            const call = queue.shift()!;
            running = call;
            try {
                worker ??= start();
                if (disposal) return;
                worker.ref();
                worker.postMessage(call.message);
                return;
            } catch (error) {
                rejectRunning(error);
            }
        }
    }

    function call(request: TokenizerRequest & { op: "load" }): Promise<void>;
    function call(request: TokenizerRequest & { op: "count" }): Promise<number>;
    function call(request: TokenizerRequest & { op: "encode" }): Promise<Uint32Array>;
    function call(request: TokenizerRequest): Promise<Result> {
        if (disposal) return Promise.reject(new Error("The tokenizers are disposed"));
        return new Promise((resolve, reject) => {
            queue.push({ message: { ...request, id: nextId++ }, resolve, reject });
            pump();
        });
    }

    function dispose(): Promise<void> {
        if (!disposal) {
            // Read the port after startWorker returns, even when it calls dispose() during construction.
            disposal = Promise.resolve().then(async () => {
                await worker?.terminate();
            });
            const error = new Error("The tokenizers are disposed");
            rejectRunning(error);
            for (const call of queue.splice(0)) call.reject(error);
        }
        return disposal;
    }

    return { call, dispose };
}

/** Serializes calls in arrival order. The worker starts on demand and retains its loaded families while idle. */
export function createWorkerTokenizers({
    rootDir,
    latch,
    startWorker = startTokenizerWorker,
}: TokenizerWorkerData & { startWorker?: StartWorker }): Tokenizers {
    const lane = createLane({ rootDir, latch }, startWorker);
    return {
        load: (family) => lane.call({ op: "load", family }),
        count: (family, text) => lane.call({ op: "count", family, text }),
        encode: (family, text) => lane.call({ op: "encode", family, text }),
        dispose: lane.dispose,
    };
}
