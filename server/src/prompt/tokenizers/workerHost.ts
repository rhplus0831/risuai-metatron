import { type Transferable, Worker } from "node:worker_threads";
import type { Tokenizers } from "./index.ts";
import type { TokenizerRequest, TokenizerWorkerCall, TokenizerWorkerData, TokenizerWorkerMessage } from "./worker.ts";

/**
 * The server context starts ordinary and long tokenizer workers on demand. Each owns an in-thread
 * tokenizer set and takes one call at a time, in arrival order. Loads always use the ordinary lane.
 * A load resolves to `undefined`, a count to a number, and an encode to its ids. A worker reply
 * carrying an error rejects with `new Error(message)` so text refusals keep their meaning.
 *
 * Aborting removes a queued call. Once posted, an ordinary call holds its slot until answered or
 * the worker ends. Aborting a posted long call stops its thread. The long worker also stops after
 * an idle minute. Only exit starts a replacement for the queue. An unexpected end fails the
 * running call, and a failed start rejects one call. Each worker stays ref'ed while work waits or runs.
 * Disposal rejects calls on both lanes and shares one promise for the end of both workers.
 */

/** Texts longer than this many UTF-16 code units use the long worker. */
export const LONG_TEXT_UNITS = 131_072;
/** Time the long worker keeps its loaded encoders after its last call. */
export const LONG_WORKER_IDLE_MS = 60_000;

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

type LaneName = "ordinary" | "long";
type StartWorker = (workerData: TokenizerWorkerData, lane: LaneName) => TokenizerWorkerPort;

/** Starts the tokenizer thread with Node's default resource limits. */
export function startTokenizerWorker(workerData: TokenizerWorkerData, lane: LaneName = "ordinary"): Worker {
    return new Worker(new URL("./worker.ts", import.meta.url), { workerData, name: lane });
}

/** Schedules an idle deadline and returns its cancellation function. */
type IdleTimer = (expire: () => void, ms: number) => () => void;
const startIdleTimer: IdleTimer = (expire, ms) => {
    const timer = setTimeout(expire, ms).unref();
    return () => clearTimeout(timer);
};

type Result = void | number | Uint32Array;
type PendingCall = {
    message: TokenizerWorkerCall;
    signal?: AbortSignal;
    resolve: (result: Result) => void;
    reject: (error: unknown) => void;
};

type LaneWorker = {
    port: TokenizerWorkerPort;
    ending: boolean;
    termination?: Promise<unknown>;
};

function terminate(thread: LaneWorker) {
    thread.ending = true;
    if (!thread.termination) {
        // If an injected terminate rejects, wait for exit as evidence that the thread ended.
        const exited = new Promise<void>((resolve) => thread.port.on("exit", () => resolve()));
        thread.termination = thread.port.terminate().catch(() => exited);
    }
    return thread.termination;
}

function createLane(name: LaneName, workerData: TokenizerWorkerData, startWorker: StartWorker, idleTimer: IdleTimer) {
    const queue: PendingCall[] = [];
    let nextId = 1;
    let running: PendingCall | undefined;
    let worker: LaneWorker | undefined;
    let starting = false;
    let disposed = false;
    let idleDeadline: { cancel: () => void } | undefined;

    function clearIdleTimer() {
        const deadline = idleDeadline;
        idleDeadline = undefined;
        deadline?.cancel();
    }

    function rejectRunning(error: unknown) {
        running?.reject(error);
        running = undefined;
    }

    function start(): LaneWorker {
        const port = startWorker(workerData, name);
        const thread: LaneWorker = { port, ending: false };
        port.on("message", (message) => {
            if (worker !== thread || "type" in message || running?.message.id !== message.id) return;
            if ("error" in message) {
                running.reject(new Error(message.error));
            } else {
                running.resolve(message.value);
            }
            running = undefined;
            pump();
        });
        port.on("error", (error) => {
            if (worker !== thread || thread.ending || disposed) return;
            // Node can silently drop a call posted between error and exit. Only exit can replace this port.
            thread.ending = true;
            clearIdleTimer();
            const reason = error instanceof Error ? error.message : String(error);
            rejectRunning(new Error(`The tokenizer worker stopped: ${reason}`));
            pump();
        });
        port.on("exit", (code) => {
            if (worker !== thread) return;
            worker = undefined;
            clearIdleTimer();
            if (disposed) return;
            rejectRunning(new Error(`The tokenizer worker stopped (exit code ${code})`));
            pump();
        });
        return thread;
    }

    function idle(thread: LaneWorker) {
        thread.port.unref();
        if (name !== "long" || thread.ending || idleDeadline) return;
        const expire = () => {
            if (
                idleDeadline !== deadline ||
                worker !== thread ||
                thread.ending ||
                disposed ||
                running ||
                queue.length
            ) {
                return;
            }
            idleDeadline = undefined;
            void terminate(thread);
            // Node's terminate() refs the port. Reapply the lane's ref policy until exit.
            pump();
        };
        const deadline = { cancel: idleTimer(expire, LONG_WORKER_IDLE_MS) };
        idleDeadline = deadline;
    }

    function pump() {
        while (!disposed && !starting && !running) {
            if (!queue.length) {
                if (worker) idle(worker);
                return;
            }
            if (worker?.ending) {
                worker.port.ref();
                return;
            }
            const call = queue[0];
            // An exit can dispatch the queue while a shared signal is still notifying its listeners.
            if (call.signal?.aborted) {
                queue.shift()!.reject(call.signal.reason);
                continue;
            }
            if (!worker) {
                // Keep the call queued during construction. A synchronous abort or dispose can remove it.
                starting = true;
                try {
                    worker = start();
                } catch (error) {
                    if (queue[0] === call) queue.shift()!.reject(error);
                } finally {
                    starting = false;
                }
                continue;
            }
            queue.shift();
            running = call;
            try {
                worker.port.ref();
                worker.port.postMessage(call.message);
                return;
            } catch (error) {
                rejectRunning(error);
            }
        }
    }

    function abort(call: PendingCall, reason: unknown) {
        call.reject(reason);
        if (running === call) {
            // The rejected promise ignores the ordinary worker's reply, which still releases its slot.
            if (name === "ordinary") return;
            running = undefined;
            void terminate(worker!);
        } else {
            queue.splice(queue.indexOf(call), 1);
        }
        pump();
    }

    function call(request: TokenizerRequest & { op: "load" }): Promise<void>;
    function call(request: TokenizerRequest & { op: "count" }, signal?: AbortSignal): Promise<number>;
    function call(request: TokenizerRequest & { op: "encode" }, signal?: AbortSignal): Promise<Uint32Array>;
    function call(request: TokenizerRequest, signal?: AbortSignal): Promise<Result> {
        if (disposed) return Promise.reject(new Error("The tokenizers are disposed"));
        if (signal?.aborted) return Promise.reject(signal.reason);
        clearIdleTimer();
        return new Promise((resolve, reject) => {
            const pending: PendingCall = {
                message: { ...request, id: nextId++ },
                signal,
                resolve(value) {
                    signal?.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                reject(error) {
                    signal?.removeEventListener("abort", onAbort);
                    reject(error);
                },
            };
            const onAbort = () => abort(pending, signal?.reason);
            signal?.addEventListener("abort", onAbort, { once: true });
            queue.push(pending);
            pump();
        });
    }

    function dispose() {
        disposed = true;
        clearIdleTimer();
        const error = new Error("The tokenizers are disposed");
        rejectRunning(error);
        for (const call of queue.splice(0)) call.reject(error);
        // Join an existing termination even if exit races disposal. A worker still in its
        // constructor will be available once both lanes have closed to new calls.
        const current = worker;
        return Promise.resolve().then(() => {
            if (!worker) return current?.termination;
            worker.port.ref();
            return terminate(worker);
        });
    }

    return { call, dispose };
}

/** Routes each text by length and serializes calls independently on each worker. */
export function createWorkerTokenizers({
    rootDir,
    latch,
    startWorker = startTokenizerWorker,
    idleTimer = startIdleTimer,
}: TokenizerWorkerData & { startWorker?: StartWorker; idleTimer?: IdleTimer }): Tokenizers {
    const data = { rootDir, latch };
    const ordinary = createLane("ordinary", data, startWorker, idleTimer);
    const long = createLane("long", data, startWorker, idleTimer);
    const lane = (text: string) => (text.length > LONG_TEXT_UNITS ? long : ordinary);
    let disposal: Promise<void> | undefined;
    return {
        load: (family) => ordinary.call({ op: "load", family }),
        count: (family, text, signal) => lane(text).call({ op: "count", family, text }, signal),
        encode: (family, text, signal) => lane(text).call({ op: "encode", family, text }, signal),
        dispose: () => (disposal ??= Promise.all([ordinary.dispose(), long.dispose()]).then(() => {})),
    };
}
