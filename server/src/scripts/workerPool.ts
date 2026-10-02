import { existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { MessageChannel, type MessagePort, type ResourceLimits, Worker } from "node:worker_threads";
import { createRequestLimiter, type EgressDeps, serverLuaRequest } from "../lua/egress.ts";
import type { RegexScriptEffect } from "../../../shared/scripts/regex.ts";
import { DEFAULT_LUA_CPU_MS, type HostAccess, type LuaRunInput, type LuaRunOutput } from "../lua/runtime.ts";
import {
    ABORTED_TASK,
    type FromWorker,
    REGEX_SCRIPTS_MODE,
    type RegexOp,
    type RegexOpResult,
    type RegexScriptsInput,
    type ScriptWorkerData,
    SYNC_HOST_TIMEOUT_MS,
    SYNC_REPLIES,
    type SyncHostReply,
    type SyncHostRequest,
    type ToWorker,
} from "./worker.ts";

/**
 * The server's script workers: Lua and user regexes run in `worker_threads` workers that the pool
 * can terminate, so a runaway script, a pathological pattern, or a heap runaway costs one worker
 * and never the server's event loop.
 *
 * - A worker runs one top-level task at a time (a Lua run or a regex). A regex that a Lua run's
 *   host call spawns (`HostContext.regex`) goes to that same worker, never to the queue: the
 *   worker's event loop is free while its Lua thread awaits, and queuing it could wait on a pool
 *   whose every worker is suspended the same way. A host context works only while its task runs.
 * - The watchdog reads the worker thread's busy time (`eventLoopUtilization`), less the main
 *   thread's synchronous answers and the spawned regexes, and terminates the worker past the run's
 *   CPU budget plus a grace (the runtime's hook stops ordinary runaways earlier, without a
 *   termination). A Lua task also has a wall cap, and a regex task a deadline. A terminated or
 *   crashed worker fails its tasks, aborts its outstanding host calls, and is replaced.
 * - `size` workers stay once started; while every worker is busy the pool grows to `maxSize`, and a
 *   worker above `size` exits after `idleMs` idle. The queue holds at most `MAX_QUEUED_TASKS`.
 */
export const DEFAULT_LUA_BUDGET_MS = 30_000;
export const DEFAULT_REGEX_DEADLINE_MS = 1000;
export const DEFAULT_LUA_WALL_MS = 10 * 60_000;
export const MAX_LUA_CODE_CHARS = 1_000_000;
export const MAX_TASK_JSON_CHARS = 16 * 1024 * 1024;
export const MAX_HOST_REPLY_CHARS = 16 * 1024 * 1024;
export const MAX_REGEX_PATTERN_CHARS = 100_000;
export const MAX_REGEX_INPUT_CHARS = 16 * 1024 * 1024;
export const MAX_QUEUED_TASKS = 1000;
/** The CPU limit of one regex script run (`runScripts`), its synchronous host answers excluded. */
export const DEFAULT_REGEX_SCRIPTS_CPU_MS = 5000;
const WATCHDOG_GRACE_MS = 1000;
const WATCHDOG_POLL_MS = 50;
const ABORT_GRACE_MS = 500;
const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
    maxOldGenerationSizeMb: 256,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4,
};

export type LuaIdentity = LuaRunInput["identity"];

export type HostContext = {
    identity: LuaIdentity;
    /** What the call's first argument (the access key) grants in this run. */
    access: HostAccess;
    /** Aborted when the task is aborted or ends, or its worker dies. */
    signal: AbortSignal;
    /** A regex on the calling run's own worker; refused once the run has ended. */
    regex(op: RegexOp): Promise<RegexOpResult>;
};

/**
 * The caller's host functions for one Lua task. A value they return must be a string, number,
 * boolean, or nil (structured data crosses as a JSON string); a synchronous one blocks the worker
 * until it answers.
 */
export type LuaHost = {
    async?: Record<string, (args: unknown[], ctx: HostContext) => Promise<unknown>>;
    sync?: Record<string, (args: unknown[], ctx: HostContext) => unknown>;
    log?: (value: string) => void;
};

export type LuaTask = Omit<LuaRunInput, "cpuMs" | "asyncHost" | "syncHost"> & { cpuMs?: number };

/**
 * The main-thread side of a regex script run (`runScripts`): CBS of a text, `@@repeat_back`'s source,
 * and an effect applied where its script matched. Each one blocks the worker until it answers; a
 * throw skips that script (the engine's per-script catch), so a fatal failure must also abort the
 * run's signal.
 */
export type RegexScriptsHost = {
    parse(text: string): string;
    repeatBack(): string;
    effect(effect: RegexScriptEffect): void;
};

export type RegexScriptsResult = { data: string } | { error: string; aborted?: boolean; timedOut?: boolean };

/**
 * A job's aggregate Lua budget. A run reserves its allowance when it starts and is charged its CPU
 * time when it ends, so runs sharing a budget, queued or concurrent, cannot overspend it.
 */
export type LuaBudget = { totalMs: number; usedMs: number; reservedMs: number };

export function createLuaBudget(totalMs = DEFAULT_LUA_BUDGET_MS): LuaBudget {
    return { totalMs, usedMs: 0, reservedMs: 0 };
}

export type ScriptWorkerPool = ReturnType<typeof createScriptWorkerPool>;

type LuaTop = {
    kind: "lua";
    taskId: number;
    task: LuaTask;
    perRunMs: number;
    host: LuaHost;
    budget?: LuaBudget;
    reservedMs: number;
    signal?: AbortSignal;
    /** Aborted when the task aborts or ends: every host call's signal follows it. */
    controller: AbortController;
    live: boolean;
    settle: (result: LuaRunOutput) => void;
    stopWatch?: () => void;
    usedMs?: () => number;
    abortTimer?: NodeJS.Timeout;
};

type RegexTop = {
    kind: "regex";
    taskId: number;
    op: RegexOp;
    deadlineMs: number;
    settle: (result: RegexOpResult) => void;
    timer?: NodeJS.Timeout;
};

type TopTask = LuaTop | RegexTop;

type Slot = {
    worker: Worker;
    syncPort: MessagePort;
    syncFlag: Int32Array;
    ready: boolean;
    top: TopTask | null;
    subs: Map<number, { settle: (result: RegexOpResult) => void; timer: NodeJS.Timeout }>;
    hostCalls: Map<number, AbortController>;
    /** Busy time of the main thread's synchronous answers and of spawned regexes, not the run's. */
    excludedMs: number;
    /**
     * The latest synchronous request and when its answer started. The worker is blocked on it
     * until it is answered or the worker's own timeout fails it, whichever comes first.
     */
    syncSince: number | null;
    syncSeq: number;
    idleTimer: NodeJS.Timeout | null;
    dead: boolean;
};

/** `public/lua/json.lua` for `pnpm runserver`, `dist/lua/json.lua` in the image (the tokenizer rule). */
export function resolveJsonLuaPath(rootDir: string): string {
    const candidates = ["public/lua/json.lua", "dist/lua/json.lua"].map((rel) => path.join(rootDir, rel));
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        throw new Error(`json.lua not found in ${candidates.join(" or ")}`);
    }
    return found;
}

function luaFailure(error: string, extra: Partial<LuaRunOutput> = {}): LuaRunOutput {
    return { res: undefined, stopSending: false, error, cpuMs: 0, memory: { used: 0, max: 0 }, ...extra };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function regexCapError(op: RegexOp): string | null {
    if (typeof op.pattern !== "string" || op.pattern.length > MAX_REGEX_PATTERN_CHARS) {
        return "Regex pattern too large";
    }
    if (typeof op.input !== "string" || op.input.length > MAX_REGEX_INPUT_CHARS) {
        return "Regex input too large";
    }
    if (typeof op.flags !== "string") {
        return "Regex flags must be a string";
    }
    return null;
}

/**
 * A host function's answer must be a primitive within the cap; anything else is the call's error.
 * A JS object would reach Lua as a live proxy of the worker's object (see the runtime).
 */
function checkHostReply(name: string, value: unknown): string | null {
    if (value !== null && value !== undefined && !["string", "number", "boolean"].includes(typeof value)) {
        return `${name}: host function result must be a string, number, boolean, or nil`;
    }
    return typeof value === "string" && value.length > MAX_HOST_REPLY_CHARS
        ? `${name}: host function result too large`
        : null;
}

/**
 * A host function's answer as it enters Lua: no answer (JS `undefined` or `null`) is `nil`. Through
 * wasmoon, JS `null` would arrive as its `null` userdata, which is truthy and no JSON value, while
 * the client's functions return `undefined` (`nil`) for no answer.
 */
function hostValue(value: unknown): unknown {
    return value ?? undefined;
}

/** The time the worker spent blocked on a synchronous call: never past the worker's own timeout. */
function blockedMs(since: number, until: number): number {
    return Math.min(Math.max(0, until - since), SYNC_HOST_TIMEOUT_MS);
}

export function createScriptWorkerPool(options: {
    rootDir: string;
    size?: number;
    maxSize?: number;
    idleMs?: number;
    resourceLimits?: ResourceLimits;
    egress?: EgressDeps;
    wallMs?: number;
}) {
    const size = options.size ?? 2;
    const maxSize = Math.max(size, options.maxSize ?? 6);
    const idleMs = options.idleMs ?? 30_000;
    const wallMs = options.wallMs ?? DEFAULT_LUA_WALL_MS;
    const limiter = createRequestLimiter();
    const slots = new Set<Slot>();
    const queue: TopTask[] = [];
    const terminations = new Set<Promise<number>>();
    let jsonLuaPath: string | null = null;
    let nextTaskId = 1;
    let disposing: Promise<void> | null = null;
    // Set before `dispose` kills anything, so no kill in it replaces its worker.
    let disposed = false;
    let warmed = false;
    const stats = { spawned: 0, terminated: 0 };

    const builtins: Record<string, (args: unknown[], ctx: HostContext) => Promise<unknown>> = {
        sleep: ([ms], ctx) =>
            new Promise<void>((resolve, reject) => {
                if (ctx.signal.aborted) {
                    reject(new Error("request aborted"));
                    return;
                }
                const timer = setTimeout(resolve, Number(ms) || 0);
                ctx.signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        reject(new Error("request aborted"));
                    },
                    { once: true },
                );
            }),
        request: ([url], ctx) =>
            serverLuaRequest(String(url ?? ""), { limiter, deps: options.egress, signal: ctx.signal }),
    };

    function spawn(): Slot {
        jsonLuaPath ??= resolveJsonLuaPath(options.rootDir);
        const { port1, port2 } = new MessageChannel();
        const syncFlag = new Int32Array(new SharedArrayBuffer(8));
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {
            workerData: { jsonLuaPath, syncPort: port2, syncFlag } satisfies ScriptWorkerData,
            transferList: [port2],
            resourceLimits: options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
        });
        const slot: Slot = {
            worker,
            syncPort: port1,
            syncFlag,
            ready: false,
            top: null,
            subs: new Map(),
            hostCalls: new Map(),
            excludedMs: 0,
            syncSince: null,
            syncSeq: 0,
            idleTimer: null,
            dead: false,
        };
        stats.spawned++;
        worker.on("message", (message: FromWorker) => onMessage(slot, message));
        worker.on("error", (error) => kill(slot, `Script worker failed: ${errorMessage(error)}`, "crash"));
        worker.on("exit", (code) => kill(slot, `Script worker exited (${code})`, "crash"));
        port1.on("message", (request: SyncHostRequest) => void answerSync(slot, request));
        // Listening refs a port, so the references are dropped after the listeners: an idle worker
        // never keeps the process alive.
        worker.unref();
        port1.unref();
        slots.add(slot);
        return slot;
    }

    function post(slot: Slot, message: ToWorker): void {
        slot.worker.postMessage(message);
    }

    /** Ends a Lua task once: its host calls are aborted and its context stops working. */
    function finishLua(top: LuaTop, result: LuaRunOutput): void {
        if (!top.live) {
            return;
        }
        top.live = false;
        top.stopWatch?.();
        clearTimeout(top.abortTimer);
        top.controller.abort();
        if (top.signal?.aborted && !result.aborted) {
            // An abort that raced the run's end still wins.
            result = { ...result, res: undefined, aborted: true, error: "request aborted" };
        }
        if (top.budget) {
            top.budget.reservedMs -= top.reservedMs;
            top.budget.usedMs += result.cpuMs;
        }
        top.settle(result);
    }

    /** Fails everything the worker holds and removes it. Safe to call more than once. */
    function kill(slot: Slot, error: string, reason: "timeout" | "abort" | "crash" | "dispose" | "idle"): void {
        if (slot.dead) {
            return;
        }
        slot.dead = true;
        slots.delete(slot);
        stats.terminated++;
        // Read before the worker goes: a terminated worker has no utilization to read.
        const top = slot.top;
        const cpuMs = top?.kind === "lua" ? Math.round(top.usedMs?.() ?? 0) : 0;
        if (slot.idleTimer) {
            clearTimeout(slot.idleTimer);
        }
        const termination = slot.worker.terminate();
        terminations.add(termination);
        void termination.finally(() => terminations.delete(termination));
        slot.syncPort.close();
        for (const controller of slot.hostCalls.values()) {
            controller.abort();
        }
        slot.hostCalls.clear();
        for (const sub of slot.subs.values()) {
            clearTimeout(sub.timer);
            sub.settle({ error: "Script worker terminated", timedOut: reason === "timeout" });
        }
        slot.subs.clear();
        slot.top = null;
        if (top?.kind === "lua") {
            finishLua(
                top,
                reason === "abort" || top.signal?.aborted
                    ? luaFailure("request aborted", { aborted: true, cpuMs })
                    : luaFailure(error, { timedOut: reason === "timeout", cpuMs }),
            );
        } else if (top?.kind === "regex") {
            clearTimeout(top.timer);
            top.settle({ error: reason === "timeout" ? "Regex timed out" : error, timedOut: reason === "timeout" });
        }
        if (!disposed && reason !== "idle") {
            // A warm pool replaces a worker that had booted, so the next task finds warm engines.
            // A worker that died booting is not replaced ahead of demand, so a broken setup does
            // not loop.
            if (warmed && slot.ready && slots.size < size) {
                try {
                    spawn();
                } catch {
                    // The next task reports the failure.
                }
            }
            pump();
        }
    }

    function idle(slot: Slot): boolean {
        return !slot.dead && !slot.top && slot.subs.size === 0;
    }

    /** Frees the slot for the next task once the task and the regexes it spawned are done. */
    function release(slot: Slot): void {
        slot.top = null;
        if (!idle(slot)) {
            return;
        }
        slot.excludedMs = 0;
        slot.worker.unref();
        slot.syncPort.unref();
        if (slots.size > size) {
            slot.idleTimer = setTimeout(() => {
                if (idle(slot) && slots.size > size) {
                    kill(slot, "idle", "idle");
                }
            }, idleMs);
            slot.idleTimer.unref();
        }
        pump();
    }

    /** Polls the worker's busy time; past `limitMs` of charged time, or the wall cap, it goes. */
    function watch(slot: Slot, top: LuaTop, limitMs: number): void {
        const baseline = slot.worker.performance.eventLoopUtilization();
        const startedAt = performance.now();
        slot.excludedMs = 0;
        slot.syncSince = null;
        const usedMs = () => {
            const blocked = slot.syncSince === null ? 0 : blockedMs(slot.syncSince, performance.now());
            return Math.max(
                0,
                slot.worker.performance.eventLoopUtilization(baseline).active - slot.excludedMs - blocked,
            );
        };
        top.usedMs = usedMs;
        const timer = setInterval(() => {
            if (usedMs() > limitMs) {
                kill(slot, "Lua execution limit exceeded (worker terminated)", "timeout");
            } else if (performance.now() - startedAt > wallMs) {
                kill(slot, "Lua run exceeded its wall time (worker terminated)", "timeout");
            }
        }, WATCHDOG_POLL_MS);
        top.stopWatch = () => clearInterval(timer);
    }

    function start(slot: Slot, task: TopTask): void {
        if (slot.idleTimer) {
            clearTimeout(slot.idleTimer);
            slot.idleTimer = null;
        }
        slot.top = task;
        slot.worker.ref();
        slot.syncPort.ref();
        if (task.kind === "regex") {
            task.timer = setTimeout(() => kill(slot, "Regex timed out", "timeout"), task.deadlineMs);
            post(slot, { type: "regex", taskId: task.taskId, op: task.op });
            return;
        }
        // The allowance is reserved now, against what the budget's other runs have reserved.
        const budget = task.budget;
        const available = budget ? budget.totalMs - budget.usedMs - budget.reservedMs : task.perRunMs;
        if (available <= 0) {
            finishLua(task, luaFailure("aggregate Lua execution budget exhausted", { timedOut: true }));
            release(slot);
            return;
        }
        const cpuMs = Math.max(1, Math.min(task.perRunMs, available));
        if (budget) {
            task.reservedMs = cpuMs;
            budget.reservedMs += cpuMs;
        }
        const input: LuaRunInput = {
            ...task.task,
            cpuMs,
            asyncHost: Object.keys(task.host.async ?? {}),
            syncHost: Object.keys(task.host.sync ?? {}),
        };
        watch(slot, task, cpuMs + WATCHDOG_GRACE_MS);
        try {
            post(slot, { type: "lua", taskId: task.taskId, input });
        } catch (error) {
            finishLua(task, luaFailure(`Lua task cannot cross to the worker: ${errorMessage(error)}`));
            release(slot);
        }
    }

    function pump(): void {
        while (queue.length > 0 && !disposed) {
            let slot = [...slots].find(idle);
            if (!slot) {
                if (slots.size >= maxSize) {
                    return;
                }
                try {
                    slot = spawn();
                } catch (error) {
                    for (const task of queue.splice(0)) {
                        failQueued(task, errorMessage(error));
                    }
                    return;
                }
            }
            start(slot, queue.shift()!);
        }
    }

    function failQueued(task: TopTask, error: string): void {
        if (task.kind === "lua") {
            finishLua(task, luaFailure(error, task.signal?.aborted ? { aborted: true } : {}));
        } else {
            task.settle({ error });
        }
    }

    function enqueue(task: TopTask): void {
        if (queue.length >= MAX_QUEUED_TASKS) {
            failQueued(task, "The script queue is full");
            return;
        }
        queue.push(task);
        pump();
    }

    function contextFor(slot: Slot, top: LuaTop, access: HostAccess, signal: AbortSignal, sync: boolean): HostContext {
        return {
            identity: top.task.identity,
            access,
            signal,
            regex: (op: RegexOp) => {
                if (!top.live || slot.top !== top) {
                    return Promise.resolve({ error: "The Lua run has ended" });
                }
                // The worker is blocked in a synchronous call, so it could not run the regex.
                if (sync) {
                    return Promise.resolve({ error: "A synchronous host function cannot run a regex" });
                }
                return subRegex(slot, op);
            },
        };
    }

    function subRegex(slot: Slot, op: RegexOp): Promise<RegexOpResult> {
        const capError = regexCapError(op);
        if (capError) {
            return Promise.resolve({ error: capError });
        }
        if (slot.dead) {
            return Promise.resolve({ error: "Script worker terminated" });
        }
        const taskId = nextTaskId++;
        return new Promise((settle) => {
            const timer = setTimeout(() => kill(slot, "Regex timed out", "timeout"), DEFAULT_REGEX_DEADLINE_MS);
            slot.subs.set(taskId, { settle, timer });
            post(slot, { type: "regex", taskId, op });
        });
    }

    async function answerHost(slot: Slot, message: Extract<FromWorker, { type: "host" }>): Promise<void> {
        const top = slot.top;
        if (top?.kind !== "lua" || top.taskId !== message.taskId || !top.live) {
            return;
        }
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        top.controller.signal.addEventListener("abort", onAbort, { once: true });
        slot.hostCalls.set(message.callId, controller);
        let reply: ToWorker;
        try {
            if (top.controller.signal.aborted) {
                throw new Error("request aborted");
            }
            const handler = builtins[message.name] ?? top.host.async?.[message.name];
            if (!handler) {
                throw new Error(`Unknown host function ${message.name}`);
            }
            const value = await handler(message.args, contextFor(slot, top, message.access, controller.signal, false));
            const replyError = checkHostReply(message.name, value);
            reply = replyError
                ? { type: "hostResult", callId: message.callId, ok: false, error: replyError }
                : { type: "hostResult", callId: message.callId, ok: true, value: hostValue(value) };
        } catch (error) {
            reply = { type: "hostResult", callId: message.callId, ok: false, error: errorMessage(error) };
        } finally {
            top.controller.signal.removeEventListener("abort", onAbort);
            slot.hostCalls.delete(message.callId);
        }
        if (slot.dead || slot.top !== top || !top.live) {
            return;
        }
        try {
            post(slot, reply);
        } catch (error) {
            post(slot, { type: "hostResult", callId: message.callId, ok: false, error: errorMessage(error) });
        }
    }

    async function answerSync(slot: Slot, request: SyncHostRequest): Promise<void> {
        const top = slot.top;
        const startedAt = performance.now();
        slot.syncSince = startedAt;
        slot.syncSeq = request.seq;
        let reply: SyncHostReply;
        if (top?.kind !== "lua" || top.taskId !== request.taskId || !top.live) {
            reply = { seq: request.seq, ok: false, error: "No active Lua task" };
        } else if (top.controller.signal.aborted) {
            reply = { seq: request.seq, ok: false, error: "request aborted" };
        } else {
            try {
                const handler = top.host.sync?.[request.name];
                if (!handler) {
                    throw new Error(`Unknown host function ${request.name}`);
                }
                const value = await handler(
                    request.args,
                    contextFor(slot, top, request.access, top.controller.signal, true),
                );
                const replyError = checkHostReply(request.name, value);
                reply = replyError
                    ? { seq: request.seq, ok: false, error: replyError }
                    : { seq: request.seq, ok: true, value: hostValue(value) };
            } catch (error) {
                reply = { seq: request.seq, ok: false, error: errorMessage(error) };
            }
            if (top.controller.signal.aborted) {
                reply = { seq: request.seq, ok: false, error: "request aborted" };
            }
        }
        if (slot.dead) {
            return;
        }
        // The worker was blocked until this answer or its own timeout; the run is not charged for
        // that. A later request supersedes this one, so only the latest clears the mark, and a late
        // answer to an ended task's call adjusts nothing of the task now on the slot.
        if (slot.top === top && slot.syncSeq === request.seq) {
            slot.syncSince = null;
        }
        if (slot.top === top) {
            slot.excludedMs += blockedMs(startedAt, performance.now());
        }
        try {
            slot.syncPort.postMessage(reply);
        } catch (error) {
            slot.syncPort.postMessage({ seq: request.seq, ok: false, error: errorMessage(error) });
        }
        Atomics.add(slot.syncFlag, SYNC_REPLIES, 1);
        Atomics.notify(slot.syncFlag, SYNC_REPLIES);
    }

    function onMessage(slot: Slot, message: FromWorker): void {
        if (slot.dead) {
            return;
        }
        switch (message.type) {
            case "ready":
                slot.ready = true;
                break;
            case "host":
                void answerHost(slot, message);
                break;
            case "log": {
                const top = slot.top;
                if (top?.kind === "lua" && top.taskId === message.taskId && top.live) {
                    try {
                        top.host.log?.(message.value);
                    } catch {
                        // A failing log sink does not fail the run.
                    }
                }
                break;
            }
            case "regexDone": {
                const sub = slot.subs.get(message.taskId);
                if (sub) {
                    clearTimeout(sub.timer);
                    slot.subs.delete(message.taskId);
                    slot.excludedMs += message.ms;
                    sub.settle(message.result);
                    if (!slot.top) {
                        // The run ended while this regex ran; the slot was draining.
                        release(slot);
                    }
                    break;
                }
                const top = slot.top;
                if (top?.kind === "regex" && top.taskId === message.taskId) {
                    clearTimeout(top.timer);
                    top.settle(message.result);
                    release(slot);
                }
                break;
            }
            case "luaDone": {
                const top = slot.top;
                if (top?.kind !== "lua" || top.taskId !== message.taskId) {
                    break;
                }
                finishLua(top, message.result);
                release(slot);
                break;
            }
        }
    }

    function abortLua(top: LuaTop): void {
        const index = queue.indexOf(top);
        if (index !== -1) {
            queue.splice(index, 1);
            finishLua(top, luaFailure("request aborted", { aborted: true }));
            return;
        }
        const slot = [...slots].find((candidate) => candidate.top === top);
        if (!slot || !top.live) {
            return;
        }
        top.controller.abort();
        // The hook and a blocked synchronous call read the flag without the message.
        Atomics.store(slot.syncFlag, ABORTED_TASK, top.taskId);
        Atomics.add(slot.syncFlag, SYNC_REPLIES, 1);
        Atomics.notify(slot.syncFlag, SYNC_REPLIES);
        post(slot, { type: "abort", taskId: top.taskId });
        // A run in C code does not reach the hook; its worker goes.
        top.abortTimer = setTimeout(() => kill(slot, "request aborted", "abort"), ABORT_GRACE_MS);
    }

    const api = {
        /**
         * Runs one Lua task. A failure is reported in the result, never thrown, as the client
         * swallows script errors. An exhausted budget, an aborted `signal`, or a task over the
         * size caps never reaches a worker.
         */
        runLua(task: LuaTask, run: { host?: LuaHost; signal?: AbortSignal; budget?: LuaBudget } = {}) {
            const { signal, budget } = run;
            if (disposed) {
                return Promise.resolve(luaFailure("The script workers are disposed"));
            }
            if (signal?.aborted) {
                return Promise.resolve(luaFailure("request aborted", { aborted: true }));
            }
            if (budget && budget.usedMs + budget.reservedMs >= budget.totalMs) {
                return Promise.resolve(luaFailure("aggregate Lua execution budget exhausted", { timedOut: true }));
            }
            if (typeof task.code !== "string" || task.code.length > MAX_LUA_CODE_CHARS) {
                return Promise.resolve(luaFailure("Lua code too large"));
            }
            try {
                if (JSON.stringify([task.data ?? null, task.meta ?? null]).length > MAX_TASK_JSON_CHARS) {
                    return Promise.resolve(luaFailure("Lua input too large"));
                }
            } catch {
                return Promise.resolve(luaFailure("Lua input is not JSON data"));
            }
            return new Promise<LuaRunOutput>((resolve) => {
                const onAbort = () => abortLua(top);
                const top: LuaTop = {
                    kind: "lua",
                    taskId: nextTaskId++,
                    task,
                    perRunMs: task.cpuMs ?? DEFAULT_LUA_CPU_MS,
                    host: run.host ?? {},
                    budget,
                    reservedMs: 0,
                    signal,
                    controller: new AbortController(),
                    live: true,
                    settle: (result) => {
                        signal?.removeEventListener("abort", onAbort);
                        resolve(result);
                    },
                };
                signal?.addEventListener("abort", onAbort, { once: true });
                enqueue(top);
            });
        },

        /**
         * Runs the regex script engine on a worker (Phase 5 slice 9: user regexes never run on the
         * main thread), under `cpuMs` of the worker's own time. A failure is reported, never thrown.
         */
        async runScripts(
            input: RegexScriptsInput & { identity: LuaIdentity; cpuMs?: number },
            run: { host: RegexScriptsHost; signal?: AbortSignal },
        ): Promise<RegexScriptsResult> {
            const { identity, cpuMs, ...data } = input;
            const { host } = run;
            const result = await api.runLua(
                { code: "", mode: REGEX_SCRIPTS_MODE, data, identity, cpuMs: cpuMs ?? DEFAULT_REGEX_SCRIPTS_CPU_MS },
                {
                    signal: run.signal,
                    host: {
                        sync: {
                            parse: ([text]) => host.parse(String(text ?? "")),
                            repeatBack: () => host.repeatBack(),
                            effect: ([json]) => {
                                host.effect(JSON.parse(String(json)) as RegexScriptEffect);
                                return undefined;
                            },
                        },
                    },
                },
            );
            if (
                result.error !== undefined ||
                typeof result.res !== "string" ||
                JSON.stringify(result.res).length > MAX_HOST_REPLY_CHARS
            ) {
                return {
                    error: result.error ?? "The regex scripts returned no text, or too much",
                    ...(result.aborted ? { aborted: true } : {}),
                    ...(result.timedOut ? { timedOut: true } : {}),
                };
            }
            return { data: result.res };
        },

        /** Runs one regex on any worker, under `deadlineMs` (1,000 ms by default). */
        regex(op: RegexOp, opts: { deadlineMs?: number } = {}): Promise<RegexOpResult> {
            if (disposed) {
                return Promise.resolve({ error: "The script workers are disposed" });
            }
            const capError = regexCapError(op);
            if (capError) {
                return Promise.resolve({ error: capError });
            }
            return new Promise((settle) => {
                enqueue({
                    kind: "regex",
                    taskId: nextTaskId++,
                    op,
                    deadlineMs: opts.deadlineMs ?? DEFAULT_REGEX_DEADLINE_MS,
                    settle,
                });
            });
        },

        /** Starts the `size` warm workers ahead of the first task. */
        warm(): void {
            if (disposed) {
                return;
            }
            warmed = true;
            while (slots.size < size) {
                spawn();
            }
        },

        stats: () => ({
            workers: slots.size,
            busy: [...slots].filter((slot) => !idle(slot)).length,
            queued: queue.length,
            ...stats,
        }),

        /** Terminates every worker; queued and running tasks fail. Every call returns the same promise. */
        dispose(): Promise<void> {
            disposed = true;
            disposing ??= (async () => {
                for (const task of queue.splice(0)) {
                    failQueued(task, "The script workers are disposed");
                }
                for (const slot of [...slots]) {
                    kill(slot, "The script workers are disposed", "dispose");
                }
                await Promise.allSettled([...terminations]);
            })();
            return disposing;
        },
    };
    return api;
}
