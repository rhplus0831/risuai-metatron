// @vitest-environment node
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LuaRunInput } from "../lua/runtime.ts";
import type { RegexOp, ToWorker } from "../scripts/worker.ts";
import { createScriptWorkerPool, type LuaHost, type LuaTask } from "../scripts/workerPool.ts";
import { createTestServer } from "./testSupport.ts";

// The pool's configurable default limits (`ScriptWorkerPoolOptions` `luaCpuMs`, `regexScriptsCpuMs`,
// `regexDeadlineMs`, `luaBudgetMs`, and with `bootMs` through `createServerContext`'s
// `scriptWorkerOptions`, passed as one object), observed at the worker boundary: the allowance a task
// crosses with, the delay a regex deadline is armed with, and the budget `createBudget` hands out.
// No case waits for a limit to pass: the values are distinctive, not small, and the pools are warmed
// before their cases. Not observed here: `syncHostTimeoutMs` (the worker's own wait; a small one
// races the scheduler) and `prepareCpuMs`, which has no observable effect because the shipped
// hardening and prelude chunks run fewer instructions than the count hook's interval.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const identity = { characterId: "c1", chatId: "chat1", presetId: "p1", personaId: null };
/** A grace, boot cap, or deadline no case reaches. */
const LONG_MS = 60_000;
const BOOT_TIMEOUT_MS = 60_000;
const LUA_CPU_MS = 4321;
const REGEX_SCRIPTS_CPU_MS = 5432;
const REGEX_DEADLINE_MS = 123_456;
const LUA_BUDGET_MS = 7654;
const OK = "function probe(id) return 'ok' end";
const SANE: RegexOp = { op: "test", pattern: "b$", flags: "", input: "ab" };

const task = (code: string, extra: Partial<LuaTask> = {}): LuaTask => ({ code, mode: "probe", identity, ...extra });

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

/** A host function that resolves `entered` and answers only when the test releases it. */
function heldHost() {
    const entered = deferred<void>();
    const answer = deferred<string>();
    const host: LuaHost = {
        async: {
            hold: () => {
                entered.resolve();
                return answer.promise;
            },
        },
    };
    return { host, entered: entered.promise, release: () => answer.resolve("go") };
}

/** The Lua tasks posted to any worker while `fn` runs, as the worker receives them. */
async function postedLuaInputs<T>(fn: () => Promise<T>): Promise<{ result: T; inputs: LuaRunInput[] }> {
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    try {
        const result = await fn();
        const inputs = posts.mock.calls
            .map(([message]) => message as ToWorker)
            .filter((message) => message.type === "lua")
            .map((message) => message.input);
        return { result, inputs };
    } finally {
        posts.mockRestore();
    }
}

/** The delays of the timers armed while `fn` runs (a regex deadline among them). */
async function armedDelays<T>(fn: () => Promise<T>): Promise<{ result: T; delays: number[] }> {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
        const result = await fn();
        return { result, delays: timers.mock.calls.map(([, delay]) => Number(delay)) };
    } finally {
        timers.mockRestore();
    }
}

describe("a pool's configured default limits", () => {
    const pool = createScriptWorkerPool({
        rootDir: REPO_ROOT,
        size: 1,
        maxSize: 1,
        bootMs: LONG_MS,
        watchdogGraceMs: LONG_MS,
        abortGraceMs: LONG_MS,
        luaCpuMs: LUA_CPU_MS,
        regexScriptsCpuMs: REGEX_SCRIPTS_CPU_MS,
        regexDeadlineMs: REGEX_DEADLINE_MS,
        luaBudgetMs: LUA_BUDGET_MS,
    });
    beforeAll(() => pool.warm(), BOOT_TIMEOUT_MS);
    afterAll(() => pool.dispose());

    it("a Lua task crosses with luaCpuMs unless it names its own allowance", async () => {
        const defaulted = await postedLuaInputs(() => pool.runLua(task(OK)));
        expect(defaulted.result.res).toBe("ok");
        expect(defaulted.inputs.map((input) => input.cpuMs)).toEqual([LUA_CPU_MS]);
        const named = await postedLuaInputs(() => pool.runLua(task(OK, { cpuMs: 777 })));
        expect(named.result.res).toBe("ok");
        expect(named.inputs.map((input) => input.cpuMs)).toEqual([777]);
    });

    it("a regex script run crosses with regexScriptsCpuMs unless it names its own allowance", async () => {
        const host = { parse: (text: string) => text, repeatBack: () => "", effect: () => {} };
        const input = { data: "ab", scripts: [], mode: "editprocess" as const, chatID: 1, identity };
        const defaulted = await postedLuaInputs(() => pool.runScripts(input, { host }));
        expect(defaulted.result).toEqual({ data: "ab" });
        expect(defaulted.inputs.map((posted) => posted.cpuMs)).toEqual([REGEX_SCRIPTS_CPU_MS]);
        const named = await postedLuaInputs(() => pool.runScripts({ ...input, cpuMs: 888 }, { host }));
        expect(named.result).toEqual({ data: "ab" });
        expect(named.inputs.map((posted) => posted.cpuMs)).toEqual([888]);
    });

    it("a regex is armed with regexDeadlineMs unless it names a deadline, and a run's spawned regex with regexDeadlineMs", async () => {
        const defaulted = await armedDelays(() => pool.regex(SANE));
        expect(defaulted.result).toEqual({ value: true });
        expect(defaulted.delays).toContain(REGEX_DEADLINE_MS);
        const named = await armedDelays(() => pool.regex(SANE, { deadlineMs: 2468 }));
        expect(named.result).toEqual({ value: true });
        expect(named.delays).toContain(2468);
        expect(named.delays).not.toContain(REGEX_DEADLINE_MS);
        const spawned = await armedDelays(() =>
            pool.runLua(task("probe = async(function(id) return lore():await() end)"), {
                host: { async: { lore: async (_args, ctx) => JSON.stringify(await ctx.regex(SANE)) } },
            }),
        );
        expect(spawned.result.res).toBe('{"value":true}');
        expect(spawned.delays).toContain(REGEX_DEADLINE_MS);
    });

    it("createBudget hands out fresh budgets of luaBudgetMs, each reserving its runs' allowance on its own", async () => {
        const first = pool.createBudget();
        const second = pool.createBudget();
        expect(first).toEqual({ totalMs: LUA_BUDGET_MS, usedMs: 0, reservedMs: 0 });
        expect(second).toEqual(first);
        expect(second).not.toBe(first);
        const held = heldHost();
        const run = pool.runLua(task("probe = async(function(id) return hold():await() end)"), {
            host: held.host,
            budget: first,
        });
        await held.entered;
        expect(first.reservedMs).toBe(LUA_CPU_MS);
        expect(second.reservedMs).toBe(0);
        held.release();
        expect((await run).res).toBe("go");
        expect(first.reservedMs).toBe(0);
        expect(second).toEqual({ totalMs: LUA_BUDGET_MS, usedMs: 0, reservedMs: 0 });
    });
});

describe("the server context's pool", () => {
    const BOOT_MS = 234_000;
    let server: ReturnType<typeof createTestServer>;
    let bootDelays: number[] = [];
    beforeAll(async () => {
        server = createTestServer({
            scriptWorkerOptions: {
                bootMs: BOOT_MS,
                watchdogGraceMs: LONG_MS,
                abortGraceMs: LONG_MS,
                luaCpuMs: LUA_CPU_MS,
                regexDeadlineMs: REGEX_DEADLINE_MS,
                luaBudgetMs: LUA_BUDGET_MS,
            },
        });
        // The pool resolves `json.lua` under the server's root at its first spawn.
        mkdirSync(path.join(server.rootDir, "public"));
        symlinkSync(path.join(REPO_ROOT, "public/lua"), path.join(server.rootDir, "public/lua"), "dir");
        bootDelays = (await armedDelays(() => server.context.scriptWorkers.warm())).delays;
    }, BOOT_TIMEOUT_MS);
    afterAll(() => server.close());

    it("boots its workers under scriptWorkerOptions.bootMs", () => {
        // The pool's two workers, each with its boot cap.
        expect(bootDelays.filter((delay) => delay === BOOT_MS)).toHaveLength(2);
    });

    it("runs Lua under luaCpuMs, arms a regex with regexDeadlineMs, and hands out luaBudgetMs budgets", async () => {
        const pool = server.context.scriptWorkers;
        const posted = await postedLuaInputs(() => pool.runLua(task(OK)));
        expect(posted.result.res).toBe("ok");
        expect(posted.inputs.map((input) => input.cpuMs)).toEqual([LUA_CPU_MS]);
        const armed = await armedDelays(() => pool.regex(SANE));
        expect(armed.result).toEqual({ value: true });
        expect(armed.delays).toContain(REGEX_DEADLINE_MS);
        expect(pool.createBudget()).toEqual({ totalMs: LUA_BUDGET_MS, usedMs: 0, reservedMs: 0 });
    });
});
