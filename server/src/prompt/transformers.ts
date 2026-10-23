import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export type TransformersTask =
    | { kind: "embed"; texts: string[]; model: string }
    | { kind: "summarize"; text: string }
    | { kind: "caption"; dataUrl: string }
    | { kind: "generate"; text: string; model: string; config: Record<string, unknown> };

export type TransformersRequest = { id: number; task: TransformersTask };

export type TransformersResponse =
    { id: number; ok: true; vectors?: Float32Array[]; text?: string } | { id: number; ok: false; error: string };

/**
 * The server's Transformers.js models (the client's `src/ts/process/transformers.ts`):
 * embeddings, the summarizer, the image captioner, and text generation, run in one child process
 * (`transformersWorker.ts`) so that model loading and inference do not hold the server's main thread
 * and a model's memory is not the server's.
 *
 * - One task runs at a time; the others wait in order. Two sends never load two models at once.
 * - Admission requires fewer than `maxQueuedTasks` queued plus active tasks (default 64,
 *   `RISU_LOCAL_MODEL_MAX_QUEUED_TASKS`) and queued payloads including the new task within
 *   `maxQueuedBytes` (default 256 Mi, `RISU_LOCAL_MODEL_MAX_QUEUED_BYTES`). Payload sizes are
 *   estimated in UTF-16 string length units, not heap bytes; active payloads are excluded.
 * - A queued task expires after `queueWaitMs` (default 5 minutes, `RISU_LOCAL_MODEL_QUEUE_WAIT_MS`)
 *   without affecting the worker. Options override the environment; invalid limits fail startup.
 *   The runtime timeout starts only when a task is dispatched.
 * - A task whose signal aborts while it waits is removed. One that aborts (or passes `taskTimeoutMs`)
 *   while it runs kills the process, which is the only way to stop native inference; the next task
 *   starts a new one once the killed one is gone. A failed task, a crashed process, or one that could
 *   not start does not affect the next. A process that cannot be ended (it does not exit within 10 s
 *   of its kill) ends the service: no second process is started beside it, and every task fails.
 * - The process ends after `idleMs` without a task, which releases its models' memory.
 * - Model files come from the package's default host (`huggingface.co`) and are kept under
 *   `cacheDir` (`save/models/transformers`); the browser's mirror and its Cache Storage are not used.
 *
 * It is not a memory bound: nothing limits what a model allocates in the child process, and under
 * memory pressure the system may end the server instead of it.
 */
export type TransformersService = {
    /** `runEmbedding`: one normalized, mean-pooled vector per text. */
    runEmbedding(texts: string[], model: string, signal?: AbortSignal): Promise<Float32Array[]>;
    /** `runSummarizer` (`Xenova/distilbart-cnn-6-6`). */
    runSummarizer(text: string, signal?: AbortSignal): Promise<string>;
    /** `runImageEmbedding` (`Xenova/vit-gpt2-image-captioning`): the caption of an image data URI. */
    runImageCaption(dataUrl: string, signal?: AbortSignal): Promise<string>;
    /** `runTransformers`: the generated text (the prompt included, as the pipeline returns it). */
    runTextGeneration(
        text: string,
        model: string,
        config: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<string>;
    /** Ends the worker process and rejects every task; later tasks are refused. */
    dispose(): Promise<void>;
};

/** The worker process as the service uses it (tests give their own). */
export type TransformersWorkerLike = {
    send(message: TransformersRequest): void;
    onMessage(listener: (message: TransformersResponse) => void): void;
    /** The process is gone: it exited or crashed, or it never started (once). */
    onEnd(listener: (reason: string) => void): void;
    /** An error of a process that is still there (its channel, a signal): the service kills it. */
    onFault?(listener: (reason: string) => void): void;
    /** Ends the process at once; resolves when it is gone, rejects when it could not be ended. */
    kill(): Promise<void>;
    /**
     * Whether the process keeps the server's event loop alive: true while a task runs (a pending
     * task is work), false while it idles (an idle model process never keeps the server from exiting).
     */
    hold?(busy: boolean): void;
};

/** Forks `transformersWorker.ts` with the server's own Node and flags. */
function forkWorker(cacheDir: string): TransformersWorkerLike {
    const child = fork(fileURLToPath(new URL("./transformersWorker.ts", import.meta.url)), [cacheDir], {
        serialization: "advanced",
    });
    // The process is gone when it exited, or when it never started (a failed spawn emits `error` and
    // no `exit`). Any other `error` (the channel, a signal) is a fault of a process that is still there.
    let gone = false;
    const endListeners: ((reason: string) => void)[] = [];
    const faultListeners: ((reason: string) => void)[] = [];
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
        resolveExited = resolve;
    });
    const end = (reason: string) => {
        if (gone) {
            return;
        }
        gone = true;
        resolveExited();
        for (const listener of endListeners) {
            listener(reason);
        }
    };
    child.on("exit", (code, signal) => end(`The model worker exited (${signal ?? code})`));
    child.on("error", (error) => {
        const reason = `The model worker failed: ${error.message}`;
        if (child.pid === undefined) {
            end(reason);
        } else if (!gone) {
            for (const listener of faultListeners) {
                listener(reason);
            }
        }
    });
    return {
        hold: (busy) => {
            if (busy) {
                child.ref();
                child.channel?.ref();
            } else {
                child.unref();
                child.channel?.unref();
            }
        },
        send: (message) => {
            child.send(message);
        },
        onMessage: (listener) => {
            child.on("message", (message) => listener(message as TransformersResponse));
        },
        onEnd: (listener) => {
            endListeners.push(listener);
        },
        onFault: (listener) => {
            faultListeners.push(listener);
        },
        kill: () => {
            if (gone || child.pid === undefined) {
                return Promise.resolve();
            }
            child.kill("SIGKILL");
            // A SIGKILL is not refused; an exit that never arrives means the process could not be signalled.
            return new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("The model process did not exit")), KILL_WAIT_MS);
                void exited.then(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        },
    };
}

/** How long a killed process may take to be gone before the service gives up on it. */
const KILL_WAIT_MS = 10 * 1000;
export const TRANSFORMERS_IDLE_MS = 5 * 60 * 1000;
/** A task's limit, the first model download included. */
export const TRANSFORMERS_TASK_TIMEOUT_MS = 15 * 60 * 1000;
export const TRANSFORMERS_MAX_QUEUED_TASKS = 64;
export const TRANSFORMERS_MAX_QUEUED_BYTES = 256 * 1024 * 1024;
export const TRANSFORMERS_QUEUE_WAIT_MS = 5 * 60 * 1000;

export class TransformersQueueFullError extends Error {
    readonly reason = "queueFull";
    constructor() {
        super("Local model queue is full");
        this.name = "TransformersQueueFullError";
    }
}

export class TransformersQueueWaitError extends Error {
    readonly reason = "queueWait";
    constructor() {
        super("Local model queue wait timed out");
        this.name = "TransformersQueueWaitError";
    }
}

export function localModelRefusal(error: unknown): {
    status: 429 | 503;
    message: string;
    reason: "queueFull" | "queueWait";
} | null {
    if (error instanceof TransformersQueueFullError) {
        return { status: 429, message: error.message, reason: error.reason };
    }
    if (error instanceof TransformersQueueWaitError) {
        return { status: 503, message: error.message, reason: error.reason };
    }
    return null;
}

function queueLimit(
    name: string,
    raw: number | string | undefined,
    fallback: number,
    max = Number.MAX_SAFE_INTEGER,
): number {
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
        throw new Error(`Invalid ${name}: ${raw}`);
    }
    return value;
}

/** String length units estimate the queued payload, not its heap allocation. */
function payloadSize(task: TransformersTask): number {
    switch (task.kind) {
        case "embed":
            return task.texts.reduce((size, text) => size + text.length, task.model.length);
        case "summarize":
            return task.text.length;
        case "caption":
            return task.dataUrl.length;
        case "generate":
            return task.text.length + task.model.length + JSON.stringify(task.config).length;
    }
}

type Pending = {
    task: TransformersTask;
    size: number;
    deadline: number;
    waitTimer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    resolve(response: TransformersResponse & { ok: true }): void;
    reject(error: unknown): void;
    onAbort?: () => void;
};

const abortReason = (signal: AbortSignal) => signal.reason ?? new Error("request aborted");

export function createTransformers(options: {
    cacheDir: string;
    idleMs?: number;
    taskTimeoutMs?: number;
    maxQueuedTasks?: number;
    maxQueuedBytes?: number;
    queueWaitMs?: number;
    spawn?: (cacheDir: string) => TransformersWorkerLike;
}): TransformersService {
    const idleMs = options.idleMs ?? TRANSFORMERS_IDLE_MS;
    const taskTimeoutMs = options.taskTimeoutMs ?? TRANSFORMERS_TASK_TIMEOUT_MS;
    const maxQueuedTasks = queueLimit(
        "RISU_LOCAL_MODEL_MAX_QUEUED_TASKS",
        options.maxQueuedTasks ?? process.env.RISU_LOCAL_MODEL_MAX_QUEUED_TASKS,
        TRANSFORMERS_MAX_QUEUED_TASKS,
    );
    const maxQueuedBytes = queueLimit(
        "RISU_LOCAL_MODEL_MAX_QUEUED_BYTES",
        options.maxQueuedBytes ?? process.env.RISU_LOCAL_MODEL_MAX_QUEUED_BYTES,
        TRANSFORMERS_MAX_QUEUED_BYTES,
    );
    const queueWaitMs = queueLimit(
        "RISU_LOCAL_MODEL_QUEUE_WAIT_MS",
        options.queueWaitMs ?? process.env.RISU_LOCAL_MODEL_QUEUE_WAIT_MS,
        TRANSFORMERS_QUEUE_WAIT_MS,
        2147483647,
    );
    const spawn = options.spawn ?? forkWorker;

    const queue: Pending[] = [];
    let worker: TransformersWorkerLike | null = null;
    let active: { id: number; pending: Pending; timer: ReturnType<typeof setTimeout> } | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let nextId = 1;
    let disposed = false;
    /** A process being killed: nothing starts until it is gone (one model process at a time). */
    let stopping: Promise<void> | null = null;
    /** A process could not be ended: no other one is started beside it, and every task fails. */
    let broken: Error | null = null;

    const removeQueued = (pending: Pending): boolean => {
        const at = queue.indexOf(pending);
        if (at === -1) {
            return false;
        }
        queue.splice(at, 1);
        clearTimeout(pending.waitTimer);
        pending.waitTimer = undefined;
        if (pending.onAbort) {
            pending.signal?.removeEventListener("abort", pending.onAbort);
            pending.onAbort = undefined;
        }
        return true;
    };

    const breakDown = () => {
        broken = new Error("The local model process could not be stopped; local models are unavailable");
        for (const pending of [...queue]) {
            if (removeQueued(pending)) {
                pending.reject(broken);
            }
        }
    };

    /**
     * Ends the worker process (its exit and late messages are ignored: `worker` no longer names it).
     * The promise settles when every process killed so far is gone; the queue continues then.
     */
    const endWorker = (): Promise<void> => {
        const current = worker;
        worker = null;
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        if (!current) {
            // No process to wait for (one that could not start): the queue goes on, not on this stack.
            if (!stopping) {
                queueMicrotask(pump);
            }
            return stopping ?? Promise.resolve();
        }
        // The exit is awaited (a shutdown waits for it): the process holds the loop until it is gone.
        current.hold?.(true);
        const killed = Promise.resolve()
            .then(() => current.kill())
            .catch(breakDown);
        const done: Promise<void> = Promise.all([stopping, killed]).then(() => {
            if (stopping === done) {
                stopping = null;
                pump();
            }
        });
        stopping = done;
        return done;
    };

    /** The running task ended (a result, a failure, an abort, the worker's end): its slot is free. */
    const settle = (finish: (pending: Pending) => void) => {
        const current = active;
        if (!current) {
            return;
        }
        active = null;
        clearTimeout(current.timer);
        if (current.pending.onAbort) {
            current.pending.signal?.removeEventListener("abort", current.pending.onAbort);
        }
        finish(current.pending);
    };

    const start = (): TransformersWorkerLike => {
        const created = spawn(options.cacheDir);
        created.onMessage((message) => {
            if (worker !== created || !active || active.id !== message.id) {
                return;
            }
            settle((pending) => (message.ok ? pending.resolve(message) : pending.reject(new Error(message.error))));
            pump();
        });
        created.onEnd((reason) => {
            if (worker !== created) {
                return;
            }
            worker = null;
            settle((pending) => pending.reject(new Error(reason)));
            pump();
        });
        // An error of a process that is still there is not its exit: its task fails and it is killed.
        created.onFault?.((reason) => {
            if (worker !== created) {
                return;
            }
            settle((pending) => pending.reject(new Error(reason)));
            void endWorker();
        });
        return created;
    };

    function pump(): void {
        if (active || disposed || stopping || broken) {
            return;
        }
        let pending = queue[0];
        while (pending) {
            removeQueued(pending);
            if (Date.now() < pending.deadline) {
                break;
            }
            pending.reject(new TransformersQueueWaitError());
            pending = queue[0];
        }
        if (!pending) {
            worker?.hold?.(false);
            if (worker && !idleTimer) {
                idleTimer = setTimeout(() => {
                    idleTimer = null;
                    if (!active && queue.length === 0) {
                        void endWorker();
                    }
                }, idleMs);
                idleTimer.unref?.();
            }
            return;
        }
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        const id = nextId++;
        /** Native inference cannot be interrupted: the process is killed, and the next task starts a new one. */
        const stop = (error: unknown) => {
            if (active?.id !== id) {
                return;
            }
            settle((ended) => ended.reject(error));
            void endWorker();
        };
        pending.onAbort = () => stop(abortReason(pending.signal!));
        pending.signal?.addEventListener("abort", pending.onAbort, { once: true });
        const timer = setTimeout(() => stop(new Error("The local model took too long")), taskTimeoutMs);
        timer.unref?.();
        active = { id, pending, timer };
        try {
            worker ??= start();
            worker.hold?.(true);
            worker.send({ id, task: pending.task });
        } catch (error) {
            stop(error);
        }
    }

    const run = (task: TransformersTask, signal?: AbortSignal): Promise<TransformersResponse & { ok: true }> =>
        new Promise((resolve, reject) => {
            if (disposed) {
                reject(new Error("The server is shutting down"));
                return;
            }
            if (broken) {
                reject(broken);
                return;
            }
            if (signal?.aborted) {
                reject(abortReason(signal));
                return;
            }
            if (queue.length + (active ? 1 : 0) >= maxQueuedTasks) {
                reject(new TransformersQueueFullError());
                return;
            }
            if (task.kind === "embed") {
                task = { ...task, texts: [...task.texts] };
            }
            const size = payloadSize(task);
            const queuedBytes = queue.reduce((total, pending) => total + pending.size, 0);
            if (queuedBytes + size > maxQueuedBytes) {
                reject(new TransformersQueueFullError());
                return;
            }
            const pending: Pending = { task, size, deadline: Date.now() + queueWaitMs, signal, resolve, reject };
            pending.onAbort = () => {
                if (removeQueued(pending)) {
                    reject(abortReason(signal!));
                    pump();
                }
            };
            signal?.addEventListener("abort", pending.onAbort, { once: true });
            pending.waitTimer = setTimeout(() => {
                if (removeQueued(pending)) {
                    reject(new TransformersQueueWaitError());
                    pump();
                }
            }, queueWaitMs);
            pending.waitTimer.unref?.();
            queue.push(pending);
            pump();
        });

    return {
        runEmbedding: async (texts, model, signal) =>
            (await run({ kind: "embed", texts, model }, signal)).vectors ?? [],
        runSummarizer: async (text, signal) => (await run({ kind: "summarize", text }, signal)).text ?? "",
        runImageCaption: async (dataUrl, signal) => (await run({ kind: "caption", dataUrl }, signal)).text ?? "",
        runTextGeneration: async (text, model, config, signal) =>
            (await run({ kind: "generate", text, model, config }, signal)).text ?? "",
        async dispose() {
            disposed = true;
            const error = new Error("The server is shutting down");
            for (const pending of [...queue]) {
                if (removeQueued(pending)) {
                    pending.reject(error);
                }
            }
            settle((pending) => pending.reject(error));
            await endWorker();
        },
    };
}
