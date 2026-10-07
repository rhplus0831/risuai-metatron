// @vitest-environment node
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createTransformers,
    type TransformersRequest,
    type TransformersResponse,
    type TransformersService,
    type TransformersWorkerLike,
} from "../prompt/transformers.ts";

// Phase 5 slice 10: the local-model service (`server/src/prompt/transformers.ts`) over injected
// worker processes (`createTransformers({ spawn })`), so no model is loaded and nothing is forked
// except in the one real-process case at the end (a task kind the worker answers without a model).
// The queue: one task at a time in order, the process held only while busy; a task aborted while
// queued removed without a start; one aborted or timed out while running killing the process, the
// next task waiting for that exit before a new process starts (one process at a time; a late
// message of the killed one ignored); a failed task not affecting the next; a crash or a process
// that never started failing its task and the queue going on (a synchronous spawn failure for
// each queued task in turn); an error of a live process failing its task and killing it; a kill that
// is refused ending the service (every task fails, no second process beside the first); the idle
// kill; dispose rejecting every task, waiting for the exit, and refusing later tasks.

type FakeWorker = TransformersWorkerLike & {
    sent: TransformersRequest[];
    holds: boolean[];
    kills: number;
    alive: boolean;
    /** The listeners the service installed. */
    listeners: { message?: (m: TransformersResponse) => void; end?: (r: string) => void; fault?: (r: string) => void };
    answer(
        response:
            | { id?: number; ok: true; vectors?: Float32Array[]; text?: string }
            | { id?: number; ok: false; error: string },
    ): void;
    exit(reason?: string): void;
    /** Settles a deferred kill (the process is gone). */
    finishKill(): void;
};

type SpawnOptions = {
    /** How `kill()` behaves: gone at once, gone when `finishKill()` is called, or refused. */
    kill?: "immediate" | "deferred" | "reject";
    /** Spawn attempts (1-based) that throw synchronously. */
    throwOn?: number[];
    /** Spawn attempts whose process never starts: it ends right after the first `send`. */
    neverStartOn?: number[];
};

function harness(options: SpawnOptions & { idleMs?: number; taskTimeoutMs?: number } = {}) {
    const workers: FakeWorker[] = [];
    let attempts = 0;
    const spawn = (): TransformersWorkerLike => {
        attempts += 1;
        if (options.throwOn?.includes(attempts)) {
            throw new Error(`spawn failed (${attempts})`);
        }
        const attempt = attempts;
        let finish: (() => void) | null = null;
        const worker: FakeWorker = {
            sent: [],
            holds: [],
            kills: 0,
            alive: true,
            listeners: {},
            send(message) {
                worker.sent.push(message);
                if (options.neverStartOn?.includes(attempt)) {
                    queueMicrotask(() => worker.exit("The model worker failed: spawn ENOENT"));
                }
            },
            onMessage(listener) {
                worker.listeners.message = listener;
            },
            onEnd(listener) {
                worker.listeners.end = listener;
            },
            onFault(listener) {
                worker.listeners.fault = listener;
            },
            hold(busy) {
                worker.holds.push(busy);
            },
            kill() {
                worker.kills += 1;
                if (options.kill === "reject") {
                    return Promise.reject(new Error("kill refused"));
                }
                if (options.kill === "deferred") {
                    return new Promise<void>((resolve) => {
                        finish = () => {
                            worker.alive = false;
                            resolve();
                        };
                    });
                }
                worker.alive = false;
                return Promise.resolve();
            },
            answer(response) {
                worker.listeners.message?.({
                    ...response,
                    id: response.id ?? worker.sent.at(-1)!.id,
                } as TransformersResponse);
            },
            exit(reason = "The model worker exited (1)") {
                worker.alive = false;
                worker.listeners.end?.(reason);
            },
            finishKill() {
                finish?.();
            },
        };
        workers.push(worker);
        allWorkers.push(worker);
        return worker;
    };
    const service = createTransformers({
        cacheDir: "/unused",
        spawn,
        idleMs: options.idleMs ?? 60_000,
        taskTimeoutMs: options.taskTimeoutMs ?? 60_000,
    });
    services.push(service);
    return { service, workers, attempts: () => attempts };
}

/** The settled state of a promise, read without awaiting it. */
function track<T>(promise: Promise<T>) {
    const state = { status: "pending" as "pending" | "resolved" | "rejected", value: undefined as unknown };
    promise.then(
        (value) => {
            state.status = "resolved";
            state.value = value;
        },
        (error: unknown) => {
            state.status = "rejected";
            state.value = error instanceof Error ? error.message : String(error);
        },
    );
    return state;
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const services: TransformersService[] = [];
const allWorkers: FakeWorker[] = [];
beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
    vi.useRealTimers();
    // Dispose waits for every kill: the deferred ones of this test's fake processes are settled here.
    const disposing = Promise.all(services.splice(0).map((service) => service.dispose()));
    await tick();
    for (const worker of allWorkers.splice(0)) {
        worker.finishKill();
    }
    await disposing;
});

describe("the queue", () => {
    it("runs one task at a time in order on one process, holding it only while busy, and answers each kind", async () => {
        const { service, workers, attempts } = harness();
        const embed = track(service.runEmbedding(["a", "b"], "Xenova/all-MiniLM-L6-v2"));
        const summary = track(service.runSummarizer("long text"));
        const caption = track(service.runImageCaption("data:image/png;base64,AA=="));
        const generated = track(service.runTextGeneration("prompt", "Xenova/opt-350m", { temperature: 0.5 }));
        await tick();
        expect(attempts()).toBe(1);
        const [worker] = workers;
        expect(worker.sent).toHaveLength(1);
        expect(worker.sent[0].task).toEqual({ kind: "embed", texts: ["a", "b"], model: "Xenova/all-MiniLM-L6-v2" });
        expect(worker.holds).toEqual([true]);
        worker.answer({ ok: true, vectors: [new Float32Array([1, 0]), new Float32Array([0, 1])] });
        await tick();
        expect(embed.status).toBe("resolved");
        expect((embed.value as Float32Array[]).map((v) => Array.from(v))).toEqual([
            [1, 0],
            [0, 1],
        ]);
        // The next task went out only after the answer, on the same process.
        expect(worker.sent).toHaveLength(2);
        expect(worker.sent[1].task).toEqual({ kind: "summarize", text: "long text" });
        expect(worker.sent[1].id).not.toBe(worker.sent[0].id);
        worker.answer({ ok: true, text: "a summary" });
        await tick();
        expect(summary.value).toBe("a summary");
        expect(worker.sent[2].task).toEqual({ kind: "caption", dataUrl: "data:image/png;base64,AA==" });
        worker.answer({ ok: true, text: "a cat" });
        await tick();
        expect(caption.value).toBe("a cat");
        expect(worker.sent[3].task).toEqual({
            kind: "generate",
            text: "prompt",
            model: "Xenova/opt-350m",
            config: { temperature: 0.5 },
        });
        worker.answer({ ok: true, text: "prompt and more" });
        await tick();
        expect(generated.value).toBe("prompt and more");
        // Idle: the process no longer holds the loop; it is not killed yet.
        expect(worker.holds.at(-1)).toBe(false);
        expect(worker.kills).toBe(0);
        expect(attempts()).toBe(1);
    });

    it("removes a task aborted while it waits without sending it, and refuses an already aborted one without a process", async () => {
        const { service, workers, attempts } = harness();
        const gone = new AbortController();
        gone.abort(new Error("already"));
        await expect(service.runSummarizer("x", gone.signal)).rejects.toThrow("already");
        expect(attempts()).toBe(0);
        const first = track(service.runSummarizer("first"));
        const queued = new AbortController();
        const second = track(service.runSummarizer("second", queued.signal));
        const third = track(service.runSummarizer("third"));
        await tick();
        queued.abort(new Error("changed my mind"));
        await tick();
        expect(second).toMatchObject({ status: "rejected", value: "changed my mind" });
        const [worker] = workers;
        worker.answer({ ok: true, text: "1" });
        await tick();
        expect(first.value).toBe("1");
        // The third followed the first directly: the second was never sent.
        expect(worker.sent.map((m) => (m.task as { text: string }).text)).toEqual(["first", "third"]);
        worker.answer({ ok: true, text: "3" });
        await tick();
        expect(third.value).toBe("3");
        expect(worker.kills).toBe(0);
    });

    it("a failed task does not affect the next, which runs on the same process", async () => {
        const { service, workers, attempts } = harness();
        const first = track(service.runEmbedding(["a"], "m"));
        const second = track(service.runSummarizer("ok"));
        await tick();
        workers[0].answer({ ok: false, error: "model file missing" });
        await tick();
        expect(first).toMatchObject({ status: "rejected", value: "model file missing" });
        workers[0].answer({ ok: true, text: "fine" });
        await tick();
        expect(second.value).toBe("fine");
        expect(attempts()).toBe(1);
        expect(workers[0].kills).toBe(0);
    });
});

describe("killing the process", () => {
    it("an abort while running kills the process, and the next task starts a new one only once the killed one is gone", async () => {
        const { service, workers, attempts } = harness({ kill: "deferred" });
        const running = new AbortController();
        const first = track(service.runSummarizer("first", running.signal));
        const second = track(service.runSummarizer("second"));
        await tick();
        running.abort(new Error("stop it"));
        await tick(5);
        expect(first).toMatchObject({ status: "rejected", value: "stop it" });
        expect(workers[0].kills).toBe(1);
        // The exit is pending: no second process yet, the first still holds the loop for its exit.
        expect(attempts()).toBe(1);
        expect(second.status).toBe("pending");
        expect(workers[0].holds.at(-1)).toBe(true);
        // A late answer of the killed process is ignored.
        workers[0].answer({ ok: true, text: "too late" });
        await tick();
        expect(second.status).toBe("pending");
        workers[0].finishKill();
        await tick();
        expect(attempts()).toBe(2);
        expect(workers[1].sent[0].task).toEqual({ kind: "summarize", text: "second" });
        workers[1].answer({ ok: true, text: "2" });
        await tick();
        expect(second.value).toBe("2");
    });

    it("a task over its time limit is rejected and its process killed; the next task gets a new process", async () => {
        // The clock moves only when the test moves it, so the next task's own limit cannot pass before
        // its answer however slow the machine is.
        vi.useFakeTimers();
        const { service, workers, attempts } = harness({ taskTimeoutMs: 20 });
        const slow = track(service.runImageCaption("data:,"));
        const next = track(service.runSummarizer("next"));
        await vi.advanceTimersByTimeAsync(20);
        expect(slow).toMatchObject({ status: "rejected", value: "The local model took too long" });
        expect(workers[0].kills).toBe(1);
        expect(attempts()).toBe(2);
        workers[1].answer({ ok: true, text: "n" });
        await vi.advanceTimersByTimeAsync(0);
        expect(next.value).toBe("n");
    });

    it("a crash fails the running task and the next task forks again; a process that exits while idle is replaced too", async () => {
        const { service, workers, attempts } = harness();
        const first = track(service.runSummarizer("first"));
        const second = track(service.runSummarizer("second"));
        await tick();
        workers[0].exit("The model worker exited (SIGSEGV)");
        await tick();
        expect(first).toMatchObject({ status: "rejected", value: "The model worker exited (SIGSEGV)" });
        expect(attempts()).toBe(2);
        workers[1].answer({ ok: true, text: "2" });
        await tick();
        expect(second.value).toBe("2");
        // Idle, the process goes away on its own: the next task starts another.
        workers[1].exit("The model worker exited (0)");
        const third = track(service.runSummarizer("third"));
        await tick();
        expect(attempts()).toBe(3);
        workers[2].answer({ ok: true, text: "3" });
        await tick();
        expect(third.value).toBe("3");
        expect(workers.map((w) => w.kills)).toEqual([0, 0, 0]);
    });

    it("a process that never started fails its task, also when that task was aborted meanwhile, and the queue goes on", async () => {
        const { service, workers, attempts } = harness({ neverStartOn: [1] });
        const aborting = new AbortController();
        const first = track(service.runSummarizer("first", aborting.signal));
        const second = track(service.runSummarizer("second"));
        aborting.abort(new Error("cancel before the spawn error"));
        await tick(5);
        expect(first).toMatchObject({ status: "rejected", value: "cancel before the spawn error" });
        // The second was not stranded: a new process serves it.
        expect(attempts()).toBe(2);
        expect(workers[1].sent[0].task).toEqual({ kind: "summarize", text: "second" });
        workers[1].answer({ ok: true, text: "2" });
        await tick();
        expect(second.value).toBe("2");
    });

    it("a synchronous spawn failure fails the task it was for, and each queued task is tried in turn", async () => {
        const { service, workers, attempts } = harness({ throwOn: [2, 3] });
        const a = track(service.runSummarizer("a"));
        const b = track(service.runSummarizer("b"));
        const c = track(service.runSummarizer("c"));
        const d = track(service.runSummarizer("d"));
        await tick();
        workers[0].exit("The model worker exited (1)");
        await tick(5);
        expect(a).toMatchObject({ status: "rejected", value: "The model worker exited (1)" });
        expect(b).toMatchObject({ status: "rejected", value: "spawn failed (2)" });
        expect(c).toMatchObject({ status: "rejected", value: "spawn failed (3)" });
        expect(attempts()).toBe(4);
        expect(d.status).toBe("pending");
        workers[1].answer({ ok: true, text: "D" });
        await tick();
        expect(d.value).toBe("D");
    });

    it("an error of a live process fails its task and kills it; nothing starts until it is gone", async () => {
        const { service, workers, attempts } = harness({ kill: "deferred" });
        const first = track(service.runSummarizer("first"));
        const second = track(service.runSummarizer("second"));
        await tick();
        workers[0].listeners.fault!("The model worker failed: write EPIPE");
        await tick(5);
        expect(first).toMatchObject({ status: "rejected", value: "The model worker failed: write EPIPE" });
        expect(workers[0].kills).toBe(1);
        expect(attempts()).toBe(1);
        expect(second.status).toBe("pending");
        workers[0].finishKill();
        await tick();
        expect(attempts()).toBe(2);
        workers[1].answer({ ok: true, text: "2" });
        await tick();
        expect(second.value).toBe("2");
    });

    it("a kill that is refused ends the service: the queue and later tasks fail, no second process starts, dispose settles", async () => {
        const { service, workers, attempts } = harness({ kill: "reject" });
        const running = new AbortController();
        const first = track(service.runSummarizer("first", running.signal));
        const second = track(service.runSummarizer("second"));
        await tick();
        running.abort(new Error("stop"));
        await tick(5);
        expect(first).toMatchObject({ status: "rejected", value: "stop" });
        expect(second).toMatchObject({
            status: "rejected",
            value: "The local model process could not be stopped; local models are unavailable",
        });
        await expect(service.runSummarizer("later")).rejects.toThrow("could not be stopped");
        expect(attempts()).toBe(1);
        expect(workers[0].kills).toBe(1);
        await expect(service.dispose()).resolves.toBeUndefined();
    });

    it("kills the process after the idle time, and a task after that starts a new one", async () => {
        // The clock moves only when the test moves it, so a stall cannot pass the idle time early.
        vi.useFakeTimers();
        const { service, workers, attempts } = harness({ idleMs: 30 });
        const first = track(service.runSummarizer("first"));
        await vi.advanceTimersByTimeAsync(0);
        workers[0].answer({ ok: true, text: "1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(first.value).toBe("1");
        // A task within the idle time keeps the process.
        const second = track(service.runSummarizer("second"));
        await vi.advanceTimersByTimeAsync(15);
        workers[0].answer({ ok: true, text: "2" });
        await vi.advanceTimersByTimeAsync(0);
        expect(second.value).toBe("2");
        expect(workers[0].kills).toBe(0);
        await vi.advanceTimersByTimeAsync(50);
        expect(workers[0].kills).toBe(1);
        expect(workers[0].alive).toBe(false);
        const third = track(service.runSummarizer("third"));
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts()).toBe(2);
        workers[1].answer({ ok: true, text: "3" });
        await vi.advanceTimersByTimeAsync(0);
        expect(third.value).toBe("3");
    });
});

describe("dispose", () => {
    it("rejects the queued and the running task, waits for the process to be gone, and refuses later tasks", async () => {
        const { service, workers } = harness({ kill: "deferred" });
        const first = track(service.runSummarizer("first"));
        const second = track(service.runSummarizer("second"));
        await tick();
        const disposing = track(service.dispose());
        await tick(5);
        expect(first).toMatchObject({ status: "rejected", value: "The server is shutting down" });
        expect(second).toMatchObject({ status: "rejected", value: "The server is shutting down" });
        expect(workers[0].kills).toBe(1);
        expect(disposing.status).toBe("pending");
        workers[0].finishKill();
        await tick();
        expect(disposing.status).toBe("resolved");
        await expect(service.runSummarizer("late")).rejects.toThrow("The server is shutting down");
        await expect(service.dispose()).resolves.toBeUndefined();
    });

    it("waits for a kill that was already pending when it was called", async () => {
        const { service, workers, attempts } = harness({ kill: "deferred" });
        const running = new AbortController();
        const first = track(service.runSummarizer("first", running.signal));
        await tick();
        running.abort(new Error("stop"));
        await tick(5);
        expect(first.status).toBe("rejected");
        const disposing = track(service.dispose());
        await tick(5);
        expect(disposing.status).toBe("pending");
        workers[0].finishKill();
        await tick();
        expect(disposing.status).toBe("resolved");
        expect(attempts()).toBe(1);
    });
});

describe("the real worker process", () => {
    // A fork of the real `transformersWorker.ts` through an adapter of this test's own (the same
    // primitives as the service's: `fork` with advanced serialization, SIGKILL, the exit event) that
    // rewrites every task to a kind the worker does not know, which it answers `ok` without loading
    // the package or a model. So the fork, the IPC channel, the idle kill, the exit, and the restart
    // are the real ones, and nothing reaches the network.
    function realWorker(): TransformersWorkerLike & { pid(): number | undefined; signal(): string | null } {
        const child = fork(fileURLToPath(new URL("../prompt/transformersWorker.ts", import.meta.url)), ["/unused"], {
            serialization: "advanced",
            execArgv: [],
        });
        let gone = false;
        const ends: ((reason: string) => void)[] = [];
        let resolveExit!: () => void;
        const exited = new Promise<void>((resolve) => {
            resolveExit = resolve;
        });
        child.on("exit", (code, signal) => {
            gone = true;
            resolveExit();
            for (const end of ends) {
                end(`The model worker exited (${signal ?? code})`);
            }
        });
        child.on("error", () => {});
        return {
            pid: () => child.pid,
            signal: () => child.signalCode,
            send: (message) => child.send({ id: message.id, task: { kind: "noop" } }),
            onMessage: (listener) => child.on("message", (message) => listener(message as TransformersResponse)),
            onEnd: (listener) => ends.push(listener),
            hold: (busy) => (busy ? child.ref() : child.unref()),
            kill: () => {
                if (gone) {
                    return Promise.resolve();
                }
                child.kill("SIGKILL");
                return exited;
            },
        };
    }

    it("forks transformersWorker.ts, answers over IPC, is killed when idle, forks again for the next task, and is gone after dispose", async () => {
        const forked: ReturnType<typeof realWorker>[] = [];
        const service = createTransformers({
            cacheDir: "/unused",
            idleMs: 150,
            spawn: () => {
                const worker = realWorker();
                forked.push(worker);
                return worker;
            },
        });
        services.push(service);
        expect(await service.runSummarizer("unused")).toBe("");
        expect(forked).toHaveLength(1);
        expect(forked[0].pid()).toBeGreaterThan(0);
        // Idle past the limit: killed.
        await tick(600);
        expect(forked[0].signal()).toBe("SIGKILL");
        expect(await service.runSummarizer("unused again")).toBe("");
        expect(forked).toHaveLength(2);
        expect(forked[1].pid()).not.toBe(forked[0].pid());
        await service.dispose();
        expect(forked[1].signal()).toBe("SIGKILL");
    }, 30_000);
});
