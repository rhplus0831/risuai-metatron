// @vitest-environment node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createLuaBudget,
    createScriptWorkerPool,
    type HostContext,
    type LuaHost,
    type LuaTask,
    MAX_LUA_CODE_CHARS,
    MAX_QUEUED_TASKS,
    MAX_REGEX_PATTERN_CHARS,
    type ScriptWorkerPool,
} from "../scripts/workerPool.ts";

/**
 * The script worker pool (Phase 5 slice 2) under the real `worker.ts` workers. Timing bounds are
 * generous: a budget of a few hundred milliseconds is checked against seconds.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const identity = { characterId: "c1", chatId: "chat1", presetId: "p1", personaId: null };
const REDOS = { op: "test" as const, pattern: "(a+)+$", flags: "", input: "a".repeat(40) + "b" };
/** A C-level runaway: `string.find` with a pathological pattern never returns to the Lua hook. */
const C_RUNAWAY = `("a"):rep(30000):find(("a-"):rep(20) .. "b")`;
const ASYNC = `
function slowDone(ms)
    return slowHost(ms):await()
end
`;

const task = (code: string, mode = "probe", extra: Partial<LuaTask> = {}): LuaTask => ({
    code,
    mode,
    identity,
    ...extra,
});
/** Busy Lua for about `seconds` of CPU. */
const spin = (seconds: number) => `local t = os.clock() while os.clock() - t < ${seconds} do end`;
const slowHost: LuaHost = {
    async: { slowHost: ([ms]) => new Promise((resolve) => setTimeout(() => resolve("done"), Number(ms))) },
};
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const start = performance.now();
    const value = await fn();
    return [value, Math.round(performance.now() - start)];
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pools: ScriptWorkerPool[] = [];
function makePool(options: Omit<Parameters<typeof createScriptWorkerPool>[0], "rootDir"> & { rootDir?: string } = {}) {
    const pool = createScriptWorkerPool({ rootDir: REPO_ROOT, ...options });
    pools.push(pool);
    return pool;
}
afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.dispose()));
});

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
});

/** Runs a script with plain `node` (no flags, no `NODE_OPTIONS`) and returns its exit and output. */
async function runNode(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { code, stdout, stderr };
}

describe("the shared pool", () => {
    const pool = makePool();

    describe("hardening", () => {
        it("removes io, debug, the file searchers, os process functions, and binary chunks; keeps json, text load, and traceback", async () => {
            const r = await pool.runLua(
                task(`function probe(id)
                    local function try(f) local ok, v = pcall(f) return ok and tostring(v) or "error" end
                    return table.concat({
                        tostring(io), try(function() return require("io") end), tostring(package.loaded.io),
                        tostring(os.execute), tostring(os.getenv), tostring(os.remove), tostring(string.dump),
                        tostring(debug.getregistry), tostring(debug.sethook), tostring(debug.getupvalue),
                        tostring(#package.searchers), tostring(package.loadlib), try(function() return require("json.lua") end),
                        tostring(load(string.char(27) .. "Lua")), tostring(load("return 1")()),
                        tostring(dofile), tostring(loadfile),
                        type(require("json").encode), type(debug.traceback),
                    }, ",")
                end`),
            );
            expect(r.error).toBeUndefined();
            expect(r.res).toBe("nil,error,nil,nil,nil,nil,nil,nil,nil,nil,1,nil,error,nil,1,nil,nil,function,function");
        });

        it("sends print to the log sink and keeps the prelude's json round-trip", async () => {
            const logs: string[] = [];
            const r = await pool.runLua(
                task(
                    `print("a", 1, nil) function probe(id) log({ n = 1 }) return json.encode(json.decode("[1,2]")) end`,
                ),
                { host: { log: (value) => logs.push(value) } },
            );
            expect(r.res).toBe("[1,2]");
            expect(logs).toEqual(["a\t1\tnil", '{"n":1}']);
        });

        it("keeps no global from the previous run", async () => {
            await pool.runLua(task("leaked = 1 function probe(id) return leaked end"));
            const r = await pool.runLua(task("function probe(id) return tostring(leaked) end"));
            expect(r.res).toBe("nil");
        });
    });

    describe("values crossing into Lua", () => {
        const host: LuaHost = {
            async: {
                obj: async () => ({ a: 1 }),
                arr: async () => [1, 2],
                fail: async () => {
                    throw new Error("boom");
                },
            },
            sync: {
                sobj: () => ({ a: 1 }),
                sfail: () => {
                    throw new Error("sboom");
                },
            },
        };

        it("refuses an object or array host answer as the call's error, asynchronous and synchronous", async () => {
            const r = await pool.runLua(
                task(`probe = async(function(id)
                    local ok1, e1 = pcall(function() return obj():await() end)
                    local ok2, e2 = pcall(function() return arr():await() end)
                    local ok3, e3 = pcall(sobj)
                    return table.concat({ tostring(ok1), e1, tostring(ok2), e2, tostring(ok3), e3 }, "|")
                end)`),
                { host },
            );
            expect(r.error).toBeUndefined();
            expect(r.res).toBe(
                "false|obj: host function result must be a string, number, boolean, or nil|false|arr: host function result must be a string, number, boolean, or nil|false|sobj: host function result must be a string, number, boolean, or nil",
            );
        });

        it("refuses object onButtonClick data and passes a string", async () => {
            const object = await pool.runLua(
                task("function onButtonClick(id, data) return type(data) end", "onButtonClick", { data: { a: 1 } }),
            );
            expect(object.res).toBeUndefined();
            expect(object.error).toContain(
                "onButtonClick: a value passed to Lua must be a string, number, boolean, or nil",
            );
            const text = await pool.runLua(
                task("function onButtonClick(id, data) return data .. '!' end", "onButtonClick", { data: "s" }),
            );
            expect(text.res).toBe("s!");
        });

        it("turns errors into their message strings and objects into copied tables without a prototype", async () => {
            const r = await pool.runLua(
                task(`probe = async(function(id)
                    local _, a = pcall(function() return fail():await() end)
                    local _, b = pcall(sfail, id)
                    local _, c = pcall(Promise.resolve(1).next, nil)
                    local d = Promise.resolve({ x = 1 }):await()
                    local e = Promise.all({ 1, 2 }):await()
                    local _, f = pcall(function() return Promise.create(function(_, rej) rej({ y = 1 }) end):await() end)
                    return table.concat({
                        type(a), a, type(b), b, type(c),
                        type(d), tostring(d.x), tostring(rawget(d, "__proto__")), tostring(d.__proto__),
                        type(e), tostring(e[2]), type(f), tostring(f.y), tostring(f.__proto__),
                    }, ",")
                end)`),
                { host },
            );
            expect(r.error).toBeUndefined();
            expect(r.res).toBe("string,boom,string,sboom,string,table,1,nil,nil,table,2,table,1,nil");
        });

        it("hands no answer (undefined or null) to Lua as nil on both paths, and keeps false, zero, and the empty string", async () => {
            // Through wasmoon a JS `null` would be its truthy `null` userdata, which `json.encode`
            // refuses; the client's functions answer `undefined` (nil) for no answer (slice 8a).
            const nullish: LuaHost = {
                async: {
                    aundef: async () => undefined,
                    anull: async () => null,
                    afalse: async () => false,
                    azero: async () => 0,
                    aempty: async () => "",
                },
                sync: {
                    sundef: () => undefined,
                    snull: () => null,
                    sfalse: () => false,
                    szero: () => 0,
                    sempty: () => "",
                },
            };
            const r = await pool.runLua(
                task(`probe = async(function(id)
                    local a = aundef():await()
                    local b = anull():await()
                    local c = sundef()
                    local d = snull()
                    local f1 = afalse():await()
                    local z1 = azero():await()
                    local e1 = aempty():await()
                    local f2 = sfalse()
                    local z2 = szero()
                    local e2 = sempty()
                    return table.concat({
                        type(a), type(b), type(c), type(d),
                        tostring(a == nil and b == nil and c == nil and d == nil),
                        json.encode({ a = a, b = b, c = c, d = d, z = 1 }),
                        tostring(f1), tostring(z1), e1 == "" and "empty" or "?",
                        tostring(f2), tostring(z2), e2 == "" and "empty" or "?",
                    }, "|")
                end)`),
                { host: nullish },
            );
            expect(r.error).toBeUndefined();
            expect(r.res).toBe('nil|nil|nil|nil|true|{"z":1}|false|0|empty|false|0|empty');
        });

        it("lets no run change the worker's prototypes for a later run", async () => {
            const first = await pool.runLua(
                task(`probe = async(function(id)
                    local _, e = pcall(function() return fail():await() end)
                    local ok = pcall(function() e.__proto__.__proto__.polluted = "A" end)
                    local ok2 = pcall(function() local o = obj():await() o.__proto__.polluted = "A" end)
                    local ok3 = pcall(function() return stopChat.x end)
                    return tostring(ok) .. tostring(ok2) .. tostring(ok3)
                end)`),
                { host },
            );
            expect(first.res).toBe("falsefalsefalse");
            const second = await pool.runLua(
                task(`function probe(id)
                    local _, e = pcall(sfail, id)
                    local d = Promise.resolve({})
                    return type(e) .. "," .. tostring(({}).polluted)
                end`),
                { host },
            );
            expect(second.res).toBe("string,nil");
            expect(await pool.regex({ op: "test", pattern: "a", flags: "", input: "a" })).toEqual({ value: true });
        });
    });

    describe("budget and execution state", () => {
        it("stops a top-level runaway and a handler runaway at the per-run budget without a termination", async () => {
            const before = pool.stats().terminated;
            const [top, topMs] = await timed(() => pool.runLua(task("while true do end", "probe", { cpuMs: 300 })));
            expect(top.timedOut).toBe(true);
            expect(top.error).toBe("Lua CPU budget exceeded (timeout)");
            expect(top.cpuMs).toBeGreaterThanOrEqual(250);
            expect(topMs).toBeLessThan(3000);
            const [handler, handlerMs] = await timed(() =>
                pool.runLua(task("function onInput(id) while true do end end", "input", { cpuMs: 300 })),
            );
            expect(handler.timedOut).toBe(true);
            expect(handlerMs).toBeLessThan(3000);
            expect(pool.stats().terminated).toBe(before);
        });

        it("terminates a C-level runaway started after an unawaited host call", async () => {
            const host: LuaHost = { async: { hold: () => new Promise(() => {}) } };
            const [r, ms] = await timed(() =>
                pool.runLua(task(`function probe(id) hold(id) return ${C_RUNAWAY} end`, "probe", { cpuMs: 100 }), {
                    host,
                }),
            );
            expect(r.timedOut).toBe(true);
            expect(r.error).toBe("Lua execution limit exceeded (worker terminated)");
            expect(ms).toBeLessThan(4000);
        });

        it("charges the CPU spent between host calls, not the waits", async () => {
            const charged = await pool.runLua(
                task(
                    `${ASYNC} probe = async(function(id)
                        for i = 1, 30 do ${spin(0.04)} slowDone(1) end
                        return "finished"
                    end)`,
                    "probe",
                    { cpuMs: 300 },
                ),
                { host: slowHost },
            );
            expect(charged.timedOut).toBe(true);
            expect(charged.res).toBeUndefined();
            const [waited, ms] = await timed(() =>
                pool.runLua(
                    task(`${ASYNC} probe = async(function(id) return slowDone(1000) end)`, "probe", { cpuMs: 100 }),
                    {
                        host: slowHost,
                    },
                ),
            );
            expect(waited.res).toBe("done");
            expect(ms).toBeGreaterThanOrEqual(1000);
            expect(waited.cpuMs).toBeLessThan(100);
        });

        it("charges a coroutine resumed after a long wait only its own compute, in a handler and at the top level", async () => {
            const a = await pool.runLua(
                task(`${ASYNC} probe = async(function(id) slowDone(350) ${spin(0.02)} return "after" end)`, "probe", {
                    cpuMs: 100,
                }),
                { host: slowHost },
            );
            expect(a.res).toBe("after");
            const b = await pool.runLua(
                task(
                    `${ASYNC} pending = async(function() slowDone(350) ${spin(0.02)} return "top" end)()
                    probe = async(function(id) return pending:await() end)`,
                    "probe",
                    { cpuMs: 100 },
                ),
                { host: slowHost },
            );
            expect(b.res).toBe("top");
        });

        it("stops a runaway right after a resumption at the budget", async () => {
            const [r, ms] = await timed(() =>
                pool.runLua(
                    task(`${ASYNC} probe = async(function(id) slowDone(200) while true do end end)`, "probe", {
                        cpuMs: 200,
                    }),
                    {
                        host: slowHost,
                    },
                ),
            );
            expect(r.timedOut).toBe(true);
            expect(ms).toBeLessThan(4000);
        });

        it("serves concurrent host calls in their own completion order", async () => {
            const host: LuaHost = {
                async: { echo: ([, ms, tag]) => new Promise((resolve) => setTimeout(() => resolve(tag), Number(ms))) },
            };
            const [r, ms] = await timed(() =>
                pool.runLua(
                    task(
                        `probe = async(function(id)
                            local a = echo(id, 300, "a")
                            local b = echo(id, 50, "b")
                            return b:await() .. a:await()
                        end)`,
                        "probe",
                        { cpuMs: 100 },
                    ),
                    { host },
                ),
            );
            expect(r.res).toBe("ba");
            expect(ms).toBeGreaterThanOrEqual(300);
            expect(ms).toBeLessThan(1000);
        });

        it("does not charge a synchronous wait, even one longer than the budget", async () => {
            const host: LuaHost = {
                sync: { slow: () => new Promise((resolve) => setTimeout(() => resolve("v"), 1500)) },
            };
            const r = await pool.runLua(
                task(`local v = slow() ${spin(0.02)} function probe(id) return v end`, "probe", { cpuMs: 100 }),
                { host },
            );
            expect(r.res).toBe("v");
            expect(r.error).toBeUndefined();
            expect(r.cpuMs).toBeLessThan(100);
        });

        it("stops a huge string.rep at the Lua memory cap", async () => {
            const r = await pool.runLua(task(`local s = string.rep("x", 1000000000) return #s`));
            expect(r.error).toMatch(/not enough memory/);
        });
    });

    describe("abort and lifetimes", () => {
        it("returns an already-aborted signal without a run", async () => {
            const before = pool.stats();
            const r = await pool.runLua(task("function probe(id) return 1 end"), { signal: AbortSignal.abort() });
            expect(r.aborted).toBe(true);
            expect(pool.stats().busy).toBe(before.busy);
            expect(pool.stats().spawned).toBe(before.spawned);
        });

        it("stops a running loop on abort without terminating the worker", async () => {
            const before = pool.stats().terminated;
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 200);
            const [r, ms] = await timed(() =>
                pool.runLua(task("function probe(id) while true do end end"), { signal: controller.signal }),
            );
            expect(r.aborted).toBe(true);
            expect(r.res).toBeUndefined();
            expect(ms).toBeLessThan(1500);
            expect(pool.stats().terminated).toBe(before);
        });

        it("aborts the outstanding host call's signal and the run", async () => {
            const controller = new AbortController();
            let hostAborted = false;
            const host: LuaHost = {
                async: {
                    wait: (_args, ctx) =>
                        new Promise((resolve) => {
                            ctx.signal.addEventListener("abort", () => {
                                hostAborted = true;
                                resolve(null);
                            });
                        }),
                },
            };
            setTimeout(() => controller.abort(), 200);
            const r = await pool.runLua(task("probe = async(function(id) return wait():await() end)"), {
                host,
                signal: controller.signal,
            });
            expect(r.aborted).toBe(true);
            expect(hostAborted).toBe(true);
        });

        it("never dispatches the next host call after an abort during a synchronous one", async () => {
            const controller = new AbortController();
            let writes = 0;
            const host: LuaHost = {
                sync: {
                    readHost: () =>
                        new Promise((resolve) => {
                            setTimeout(() => controller.abort(), 20);
                            setTimeout(() => resolve("read"), 100);
                        }),
                    writeHost: () => {
                        writes++;
                        return "wrote";
                    },
                },
            };
            const r = await pool.runLua(task(`function probe(id) readHost(id) writeHost(id) return "done" end`), {
                host,
                signal: controller.signal,
            });
            expect(r.aborted).toBe(true);
            expect(r.res).toBeUndefined();
            expect(writes).toBe(0);
        });

        it("aborts an unawaited host call's signal when its run completes and drops the late answer", async () => {
            let settled: Promise<boolean> | null = null;
            const host: LuaHost = {
                async: {
                    slowHost: (_args, ctx) => {
                        settled = new Promise((resolve) => setTimeout(() => resolve(ctx.signal.aborted), 250));
                        return settled.then(() => "late");
                    },
                },
            };
            const r = await pool.runLua(task(`function probe(id) slowHost(id) return "done" end`), { host });
            expect(r.res).toBe("done");
            expect(await settled!).toBe(true);
            await sleep(50);
        });

        it("refuses a host context's regex after its run ended and leaves the next run alone", async () => {
            let kept: HostContext | null = null;
            const host: LuaHost = { async: { keep: async (_args, ctx) => ((kept = ctx), "kept") } };
            await pool.runLua(task(`probe = async(function(id) return keep():await() end)`), { host });
            // The call completed before the run ended, so its signal is no longer the run's; the
            // regex fence is what makes a kept context harmless.
            expect(await kept!.regex(REDOS)).toEqual({ error: "The Lua run has ended" });
            const next = await pool.runLua(task("function probe(id) return 'next' end"));
            expect(next.res).toBe("next");
        });

        it("kills only the owner when a spawned regex times out, and cancels that run's host calls", async () => {
            const two = makePool({ size: 2, maxSize: 2 });
            let hostAborted = false;
            const lore: LuaHost = {
                async: {
                    lore: async (_args, ctx) => {
                        ctx.signal.addEventListener("abort", () => (hostAborted = true));
                        return await ctx.regex(REDOS);
                    },
                },
            };
            const [victim, bystander] = await Promise.all([
                two.runLua(task("probe = async(function(id) return lore():await() end)"), { host: lore }),
                two.runLua(task(`${ASYNC} probe = async(function(id) return slowDone(1500) end)`), { host: slowHost }),
            ]);
            expect(victim.res).toBeUndefined();
            expect(victim.error).toBe("Regex timed out");
            expect(hostAborted).toBe(true);
            expect(bystander.res).toBe("done");
            expect(two.stats().terminated).toBe(1);
        });

        it("ignores a host answer that arrives after its worker was killed", async () => {
            let lateSignal: AbortSignal | null = null;
            const host: LuaHost = {
                async: {
                    hold: (_args, ctx) =>
                        new Promise((resolve) => {
                            lateSignal = ctx.signal;
                            setTimeout(() => resolve("late"), 1500);
                        }),
                },
            };
            const r = await pool.runLua(
                task(`function probe(id) hold(id) return ${C_RUNAWAY} end`, "probe", { cpuMs: 100 }),
                {
                    host,
                },
            );
            expect(r.timedOut).toBe(true);
            expect(lateSignal!.aborted).toBe(true);
            await sleep(1600);
            const next = await pool.runLua(task("function probe(id) return 'next' end"));
            expect(next.res).toBe("next");
        });

        it("runs a second task on another worker while one is suspended", async () => {
            const order: string[] = [];
            const first = pool
                .runLua(task(`${ASYNC} probe = async(function(id) return slowDone(800) end)`), { host: slowHost })
                .then((r) => (order.push("first"), r));
            await sleep(100);
            const second = await pool.runLua(task("function probe(id) return 'quick' end"));
            order.push("second");
            const r = await first;
            expect(order).toEqual(["second", "first"]);
            expect(r.res).toBe("done");
            expect(second.res).toBe("quick");
        });
    });

    describe("aggregate budgets", () => {
        it("refuses an exhausted budget before any worker is involved", async () => {
            const before = pool.stats().spawned;
            const budget = { ...createLuaBudget(100), usedMs: 100 };
            const r = await pool.runLua(task("while true do end"), { budget });
            expect(r.timedOut).toBe(true);
            expect(r.error).toBe("aggregate Lua execution budget exhausted");
            expect(pool.stats().spawned).toBe(before);
        });

        it("lets queued runs sharing a budget spend it once", async () => {
            const one = makePool({ size: 1, maxSize: 1 });
            const budget = createLuaBudget(100);
            const results = await Promise.all(
                Array.from({ length: 4 }, () =>
                    one.runLua(task(`function probe(id) ${spin(0.075)} return 'done' end`), { budget }),
                ),
            );
            expect(results.filter((r) => r.res === "done")).toHaveLength(1);
            expect(results.filter((r) => r.error === "aggregate Lua execution budget exhausted")).toHaveLength(3);
            expect(budget.reservedMs).toBe(0);
            expect(budget.usedMs).toBeLessThanOrEqual(200);
        });

        it("reserves each concurrent run's allowance so two workers cannot overspend", async () => {
            const two = makePool({ size: 2, maxSize: 2 });
            const budget = createLuaBudget(100);
            const results = await Promise.all(
                Array.from({ length: 4 }, () =>
                    two.runLua(task(`function probe(id) ${spin(0.075)} return 'done' end`, "probe", { cpuMs: 50 }), {
                        budget,
                    }),
                ),
            );
            expect(results.every((r) => r.timedOut === true)).toBe(true);
            expect(
                results.filter((r) => r.error === "aggregate Lua execution budget exhausted").length,
            ).toBeGreaterThanOrEqual(2);
            expect(budget.reservedMs).toBe(0);
            expect(budget.usedMs).toBeLessThanOrEqual(250);
        });

        it("releases the reservation of an aborted run", async () => {
            const budget = createLuaBudget(1000);
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 50);
            const aborted = await pool.runLua(task(`${ASYNC} probe = async(function(id) return slowDone(5000) end)`), {
                host: slowHost,
                budget,
                signal: controller.signal,
            });
            expect(aborted.aborted).toBe(true);
            expect(budget.reservedMs).toBe(0);
            expect(budget.usedMs).toBeLessThan(100);
            const next = await pool.runLua(task("function probe(id) return 'ok' end"), { budget });
            expect(next.res).toBe("ok");
        });

        it("charges a run whose result is dropped as invalid", async () => {
            const budget = createLuaBudget(1000);
            const r = await pool.runLua(
                task(`function onInput(id) ${spin(0.075)} return function() end end`, "input"),
                {
                    budget,
                },
            );
            expect(r.res).toBeUndefined();
            expect(r.error).toBeUndefined();
            expect(r.cpuMs).toBeGreaterThanOrEqual(50);
            expect(budget.usedMs).toBeGreaterThanOrEqual(50);
            expect(budget.reservedMs).toBe(0);
        });

        it("charges the job budget across runs and refuses the run past it", async () => {
            const budget = createLuaBudget(400);
            const first = await pool.runLua(task("while true do end", "probe", { cpuMs: 300 }), { budget });
            const second = await pool.runLua(task("while true do end", "probe", { cpuMs: 300 }), { budget });
            const third = await pool.runLua(task("function probe(id) return 1 end"), { budget });
            expect(first.timedOut).toBe(true);
            expect(first.cpuMs).toBeGreaterThanOrEqual(250);
            expect(second.timedOut).toBe(true);
            expect(second.cpuMs).toBeLessThan(250);
            expect(third.error).toBe("aggregate Lua execution budget exhausted");
            expect(budget.usedMs).toBeGreaterThanOrEqual(400);
            expect(budget.reservedMs).toBe(0);
        });
    });

    describe("transport and caps", () => {
        it("fails only the call for a host answer that cannot cross, with no unhandled rejection", async () => {
            const host: LuaHost = { async: { fn: async () => () => 42 } };
            const r = await pool.runLua(
                task(
                    `probe = async(function(id) local ok, e = pcall(function() return fn():await() end) return tostring(ok) .. e end)`,
                ),
                { host },
            );
            expect(r.res).toBe("falsefn: host function result must be a string, number, boolean, or nil");
            await sleep(20);
        });

        it("drops a non-primitive result in every dispatch mode", async () => {
            const cases: Array<[string, string, Partial<LuaTask>]> = [
                ["function onInput(id) return function() end end", "input", {}],
                ["function onOutput(id) return { x = 1 } end", "output", {}],
                ["function onStart(id) return { 1, 2 } end", "start", {}],
                ["function onButtonClick(id, data) return function() end end", "onButtonClick", { data: "d" }],
                ["function probe(id) return { x = 1 } end", "probe", {}],
            ];
            for (const [code, mode, extra] of cases) {
                const r = await pool.runLua(task(code, mode, extra));
                expect(r.res, mode).toBeUndefined();
                expect(r.error, mode).toBeUndefined();
            }
            const edit = await pool.runLua(
                task(`listenEdit("editDisplay", function(id, value) return function() end end)`, "editDisplay", {
                    data: "m",
                }),
            );
            expect(edit.res).toBeUndefined();
            const ok = await pool.runLua(
                task(
                    `listenEdit("editDisplay", function(id, value, meta) return value .. meta.tag end)`,
                    "editDisplay",
                    {
                        data: "m",
                        meta: { tag: "!" },
                    },
                ),
            );
            expect(ok.res).toBe("m!");
        });

        it("ignores a throwing log sink", async () => {
            const r = await pool.runLua(task(`function probe(id) log("x") return "fine" end`), {
                host: {
                    log: () => {
                        throw new Error("sink broke");
                    },
                },
            });
            expect(r.res).toBe("fine");
        });

        it("refuses an argument over the host-argument cap and a table argument", async () => {
            const host: LuaHost = { sync: { take: () => "ok" } };
            const r = await pool.runLua(
                task(`function probe(id)
                    local ok1, e1 = pcall(take, id, string.rep("x", 17 * 1024 * 1024))
                    local ok2, e2 = pcall(take, id, { 1 })
                    return tostring(ok1) .. "|" .. e1 .. "|" .. tostring(ok2) .. "|" .. e2
                end`),
                { host },
            );
            expect(r.res).toBe(
                "false|take: host function arguments too large|false|take: host function arguments must be strings, numbers, booleans, or nil",
            );
        });

        it("refuses tasks over the size caps and non-JSON input before a worker", async () => {
            const before = pool.stats().spawned;
            expect((await pool.runLua(task("x".repeat(MAX_LUA_CODE_CHARS + 1)))).error).toBe("Lua code too large");
            const cycle: Record<string, unknown> = {};
            cycle.self = cycle;
            expect((await pool.runLua(task("return 1", "probe", { data: cycle }))).error).toBe(
                "Lua input is not JSON data",
            );
            expect(
                await pool.regex({
                    op: "test",
                    pattern: "a".repeat(MAX_REGEX_PATTERN_CHARS + 1),
                    flags: "",
                    input: "",
                }),
            ).toEqual({
                error: "Regex pattern too large",
            });
            expect(pool.stats().spawned).toBe(before);
        });

        it("answers regex operations with groups, and caps amplified captures and entry counts", async () => {
            expect(await pool.regex({ op: "exec", pattern: "(?<word>b)(c)?", flags: "", input: "abc" })).toEqual({
                value: { index: 1, match: "bc", groups: ["b", "c"], named: { word: "b" } },
            });
            expect(await pool.regex({ op: "split", pattern: ",", flags: "", input: "a,b" })).toEqual({
                value: ["a", "b"],
            });
            expect(await pool.regex({ op: "matches", pattern: "a", flags: "g", input: "aXa" })).toEqual({
                value: [
                    { index: 0, match: "a", groups: [], named: null },
                    { index: 2, match: "a", groups: [], named: null },
                ],
            });
            expect(await pool.regex({ op: "matches", pattern: "a", flags: "", input: "aXa" })).toEqual({
                value: [{ index: 0, match: "a", groups: [], named: null }],
            });
            const invalid = await pool.regex({ op: "test", pattern: "(", flags: "", input: "" });
            expect("error" in invalid && /Invalid regular expression/.test(invalid.error)).toBe(true);
            const amplified = await pool.regex({
                op: "matches",
                pattern: "(?=(.{5000}))",
                flags: "g",
                input: "x".repeat(10_000),
            });
            expect("error" in amplified && /larger than/.test(amplified.error)).toBe(true);
            const parts = await pool.regex({ op: "split", pattern: "(b)", flags: "", input: "ab".repeat(200_000) });
            expect(parts).toEqual({ error: "More than 100000 parts" });
        });

        it("terminates a ReDoS regex at its deadline while HTTP stays responsive, and recovers", async () => {
            const server = http.createServer((_req, res) => res.end("ok"));
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const port = (server.address() as AddressInfo).port;
            try {
                const [runaway, ms] = await timed(async () => {
                    const pending = pool.regex(REDOS);
                    const latencies: number[] = [];
                    for (let i = 0; i < 10; i++) {
                        const [, latency] = await timed(() =>
                            fetch(`http://127.0.0.1:${port}/`).then((res) => res.text()),
                        );
                        latencies.push(latency);
                        await sleep(60);
                    }
                    expect(Math.max(...latencies)).toBeLessThan(500);
                    return pending;
                });
                expect(runaway).toEqual({ error: "Regex timed out", timedOut: true });
                expect(ms).toBeLessThan(3000);
                expect(await pool.regex({ op: "test", pattern: "b$", flags: "", input: "ab" })).toEqual({
                    value: true,
                });
            } finally {
                server.close();
            }
        });

        it("fails the task past the queue cap at once", async () => {
            const one = makePool({ size: 1, maxSize: 1 });
            let release!: () => void;
            const host: LuaHost = {
                async: { hold: () => new Promise<string>((resolve) => (release = () => resolve("go"))) },
            };
            const blocker = one.runLua(task("probe = async(function(id) return hold():await() end)"), { host });
            // The worker holds the slot once it called `hold` (a fixed wait is too short under load).
            for (let i = 0; i < 400 && release === undefined; i++) {
                await sleep(25);
            }
            expect(release).toBeDefined();
            const queued = Array.from({ length: MAX_QUEUED_TASKS }, () =>
                one.regex({ op: "test", pattern: "a", flags: "", input: "a" }),
            );
            expect(one.stats().queued).toBe(MAX_QUEUED_TASKS);
            expect(await one.regex({ op: "test", pattern: "a", flags: "", input: "a" })).toEqual({
                error: "The script queue is full",
            });
            release();
            expect((await blocker).res).toBe("go");
            const results = await Promise.all(queued);
            expect(results.every((r) => "value" in r && r.value === true)).toBe(true);
        });
    });

    describe("egress through the pool", () => {
        it("gives request to low-level runs only, through the guard and the pool's own window", async () => {
            let fetches = 0;
            const guarded = makePool({
                egress: {
                    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
                    fetchImpl: async () => (fetches++, { status: 200, data: "fetched" }),
                },
            });
            const code = `probe = async(function(id)
                local r = request(id, "https://public.example/")
                if r == nil then return "denied" end
                return json.decode(r:await()).data
            end)`;
            expect((await guarded.runLua(task(code))).res).toBe("denied");
            expect((await guarded.runLua(task(code, "probe", { lowLevelAccess: true }))).res).toBe("fetched");
            const burst = `probe = async(function(id)
                local last
                for i = 1, 29 do last = json.decode(request(id, "https://public.example/"):await()).status end
                return last
            end)`;
            expect((await guarded.runLua(task(burst, "probe", { lowLevelAccess: true }))).res).toBe(200);
            const over = await guarded.runLua(
                task(
                    `probe = async(function(id) return json.decode(request(id, "https://public.example/"):await()).status end)`,
                    "probe",
                    {
                        lowLevelAccess: true,
                    },
                ),
            );
            expect(over.res).toBe(429);
            expect(fetches).toBe(30);
        });

        it("caps sleep at 2 s per call and 6 s per run", { tags: ["slow"], timeout: 20_000 }, async () => {
            const [r, ms] = await timed(() =>
                pool.runLua(
                    task(`probe = async(function(id)
                        local a = sleep(id, 5000):await()
                        local b = sleep(id, 5000):await()
                        local c = sleep(id, 5000):await()
                        local d = sleep(id, 5000)
                        return tostring(a) .. tostring(b) .. tostring(c) .. tostring(d)
                    end)`),
                ),
            );
            expect(r.res).toBe("truetruetruefalse");
            expect(ms).toBeGreaterThanOrEqual(6000);
            expect(ms).toBeLessThan(9000);
        });

        it("caps sleep per call and per run at the pool's sleepCaps", async () => {
            const capped = makePool({ size: 1, maxSize: 1, sleepCaps: { perCallMs: 200, perRunMs: 600 } });
            const [r, ms] = await timed(() =>
                capped.runLua(
                    task(`probe = async(function(id)
                        local a = sleep(id, 500):await()
                        local b = sleep(id, 500):await()
                        local c = sleep(id, 500):await()
                        local d = sleep(id, 500)
                        return tostring(a) .. tostring(b) .. tostring(c) .. tostring(d)
                    end)`),
                ),
            );
            expect(r.res).toBe("truetruetruefalse");
            expect(ms).toBeGreaterThanOrEqual(600);
            expect(ms).toBeLessThan(1500);
        });
    });
});

describe("the watchdog after a synchronous call timed out in the worker", () => {
    it(
        "charges a C-level runaway that follows the worker's own 10 s give-up",
        { tags: ["slow"], timeout: 40_000 },
        async () => {
            const one = makePool({ size: 1, maxSize: 1, wallMs: 30_000 });
            const [r, ms] = await timed(() =>
                one.runLua(
                    task(`function probe(id) pcall(never, id) return ${C_RUNAWAY} end`, "probe", { cpuMs: 100 }),
                    {
                        host: { sync: { never: () => new Promise(() => {}) } },
                    },
                ),
            );
            expect(r.error).toBe("Lua execution limit exceeded (worker terminated)");
            expect(r.timedOut).toBe(true);
            expect(ms).toBeGreaterThanOrEqual(10_000);
            expect(ms).toBeLessThan(16_000);
        },
    );

    it("charges a C-level runaway that follows a shortened give-up (syncHostTimeoutMs)", async () => {
        const one = makePool({ size: 1, maxSize: 1, wallMs: 30_000, syncHostTimeoutMs: 1000 });
        const [r, ms] = await timed(() =>
            one.runLua(task(`function probe(id) pcall(never, id) return ${C_RUNAWAY} end`, "probe", { cpuMs: 100 }), {
                host: { sync: { never: () => new Promise(() => {}) } },
            }),
        );
        expect(r.error).toBe("Lua execution limit exceeded (worker terminated)");
        expect(r.timedOut).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(1000);
        expect(ms).toBeLessThan(7000);
    }, 20_000);
});

describe("worker readiness", () => {
    const simpleRegex = { op: "test" as const, pattern: "a", flags: "", input: "a" };

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("gives a held regex its full deadline after readiness and still bounds a runaway", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const pool = makePool({ size: 1, maxSize: 1 });
        try {
            const held = pool.regex(simpleRegex, { deadlineMs: 100 });
            // Synchronous clock advancement cannot deliver the worker's ready message.
            vi.advanceTimersByTime(500);
            expect(pool.stats()).toMatchObject({ workers: 1, busy: 1, terminated: 0 });
            expect(await held).toEqual({ value: true });

            const runaway = pool.regex(REDOS, { deadlineMs: 100 });
            vi.advanceTimersByTime(99);
            expect(pool.stats()).toMatchObject({ busy: 1, terminated: 0 });
            vi.advanceTimersByTime(1);
            expect(await runaway).toEqual({ error: "Regex timed out", timedOut: true });
            expect(pool.stats()).toMatchObject({ workers: 0, terminated: 1 });
        } finally {
            await pool.dispose();
        }
    });

    it("reserves a held Lua budget at assignment but starts its watchdog after readiness", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        const now = vi.spyOn(performance, "now").mockReturnValue(0);
        const pool = makePool({ size: 1, maxSize: 1, wallMs: 100 });
        const budget = createLuaBudget(1000);
        try {
            const held = pool.runLua(task("function probe(id) return 'ready' end", "probe", { cpuMs: 100 }), {
                budget,
            });
            expect(budget).toMatchObject({ usedMs: 0, reservedMs: 100 });
            now.mockReturnValue(500);
            vi.advanceTimersByTime(500);
            expect(pool.stats()).toMatchObject({ workers: 1, busy: 1, terminated: 0 });
            const result = await held;
            expect(result.res).toBe("ready");
            expect(result.error).toBeUndefined();
            expect(budget.reservedMs).toBe(0);
        } finally {
            await pool.dispose();
        }
    });

    it.each(["regex", "Lua"] as const)(
        "fails a held %s at the boot cap and spawns again only on demand",
        async (kind) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const pool = makePool({ size: 1, maxSize: 1, bootMs: 1 });
            const budget = createLuaBudget(1000);
            const bootError = "Script worker did not start within 1 ms";
            try {
                const warming = pool.warm().catch((error: unknown) => error);
                const held =
                    kind === "regex"
                        ? pool.regex(simpleRegex)
                        : pool.runLua(task("function probe(id) return 1 end", "probe", { cpuMs: 100 }), { budget });
                vi.advanceTimersByTime(1);
                expect(pool.stats()).toMatchObject({ workers: 0, busy: 0, queued: 0, spawned: 1, terminated: 1 });
                const result = await held;
                if (kind === "regex") {
                    expect(result).toEqual({ error: bootError });
                } else {
                    expect(result).toMatchObject({ error: bootError, res: undefined, cpuMs: 0 });
                    expect(result).not.toHaveProperty("timedOut");
                    expect(budget).toMatchObject({ usedMs: 0, reservedMs: 0 });
                }
                expect(await warming).toMatchObject({ message: bootError });

                // Keep the parent clock still while the replacement boots on this new demand.
                expect(await pool.regex(simpleRegex)).toEqual({ value: true });
                vi.advanceTimersByTime(1);
                expect(pool.stats()).toMatchObject({ workers: 1, busy: 0, spawned: 2, terminated: 1 });
            } finally {
                await pool.dispose();
            }
        },
    );

    it("waits for all warm workers, including a repeated warm during boot, and clears their boot caps", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const pool = makePool({ size: 2, maxSize: 2, bootMs: 100 });
        try {
            let resolved = 0;
            const first = pool.warm().then(() => resolved++);
            const repeated = pool.warm().then(() => resolved++);
            // Flush promises without yielding to the workers' ready messages.
            await Promise.resolve();
            expect(resolved).toBe(0);
            expect(pool.stats()).toMatchObject({ workers: 2, spawned: 2, terminated: 0 });
            await Promise.all([first, repeated]);
            vi.advanceTimersByTime(100);
            expect(resolved).toBe(2);
            expect(pool.stats()).toMatchObject({ workers: 2, busy: 0, spawned: 2, terminated: 0 });
        } finally {
            await pool.dispose();
        }
    });

    it("rejects an awaited warm on broken setup and handles a fire-and-forget warm rejection", async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "risu-warm-no-json-lua-"));
        const pool = makePool({ rootDir: root, size: 1, maxSize: 1 });
        try {
            await expect(pool.warm()).rejects.toThrow(/json\.lua not found/);
            void pool.warm();
            // Let Node report any unhandled rejection to the suite's process listener.
            await nextTurn();
            expect(unhandled).toEqual([]);
            expect(pool.stats()).toMatchObject({ workers: 0, spawned: 0 });
        } finally {
            await pool.dispose();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("resolves warm and fails a held regex on disposal during boot, then warms without spawning", async () => {
        const pool = makePool({ size: 1, maxSize: 1 });
        let ready = false;
        const warming = pool.warm().then(() => (ready = true));
        const held = pool.regex(simpleRegex);
        // Dispose before yielding to any worker message.
        await pool.dispose();
        expect(ready).toBe(true);
        await warming;
        expect(await held).toEqual({ error: "The script workers are disposed" });
        await expect(pool.warm()).resolves.toBeUndefined();
        expect(pool.stats()).toMatchObject({ workers: 0, busy: 0, spawned: 1, terminated: 1 });
    });

    it("immediately aborts a held Lua run, releases its reservation, and reuses the booting worker", async () => {
        const pool = makePool({ size: 1, maxSize: 1 });
        const budget = createLuaBudget(1000);
        const controller = new AbortController();
        const logs: string[] = [];
        let result: Awaited<ReturnType<ScriptWorkerPool["runLua"]>> | undefined;
        const held = pool
            .runLua(task("print('must not run') function probe(id) return 1 end", "probe", { cpuMs: 100 }), {
                budget,
                signal: controller.signal,
                host: { log: (value) => logs.push(value) },
            })
            .then((value) => (result = value));
        expect(budget.reservedMs).toBe(100);
        controller.abort();
        // A promise microtask can settle the abort while ready is still undelivered.
        await Promise.resolve();
        expect(result).toMatchObject({ error: "request aborted", aborted: true, cpuMs: 0 });
        expect(budget).toMatchObject({ usedMs: 0, reservedMs: 0 });
        expect(pool.stats()).toMatchObject({ workers: 1, busy: 0, spawned: 1, terminated: 0 });
        await held;

        expect((await pool.runLua(task("function probe(id) return 'later' end"), { budget })).res).toBe("later");
        expect(logs).toEqual([]);
        expect(pool.stats()).toMatchObject({ workers: 1, busy: 0, spawned: 1, terminated: 0 });
    });
});

describe("pool lifecycle", () => {
    it("grows to maxSize under load, admits in FIFO order at saturation, and retires idle workers", async () => {
        const pool = makePool({ size: 1, maxSize: 2, idleMs: 200 });
        const done: number[] = [];
        const runs = Array.from({ length: 4 }, (_, i) =>
            pool
                .runLua(task(`${ASYNC} probe = async(function(id) return slowDone(300) end)`), { host: slowHost })
                .then((r) => (done.push(i), r)),
        );
        await sleep(150);
        expect(pool.stats()).toMatchObject({ workers: 2, busy: 2, queued: 2 });
        const results = await Promise.all(runs);
        expect(results.every((r) => r.res === "done")).toBe(true);
        expect(done.slice(0, 2).sort()).toEqual([0, 1]);
        expect(done.slice(2).sort()).toEqual([2, 3]);
        await sleep(700);
        expect(pool.stats()).toMatchObject({ workers: 1, busy: 0, terminated: 1 });
        expect((await pool.runLua(task("function probe(id) return 'still' end"))).res).toBe("still");
    });

    it("leaves no worker behind when disposed after warm()", async () => {
        const pool = makePool({ size: 2, maxSize: 2 });
        pool.warm();
        expect((await pool.runLua(task("function probe(id) return 1 end"))).res).toBe(1);
        await sleep(200);
        expect(pool.stats()).toMatchObject({ workers: 2, spawned: 2, terminated: 0 });
        const first = pool.dispose();
        expect(pool.dispose()).toBe(first);
        await first;
        expect(pool.stats()).toMatchObject({ workers: 0, spawned: 2, terminated: 2 });
        await sleep(100);
        expect(pool.stats()).toMatchObject({ workers: 0, spawned: 2 });
    });

    it("fails the running and queued tasks on dispose and refuses new ones", async () => {
        const pool = makePool({ size: 1, maxSize: 1 });
        const running = pool.runLua(task(`${ASYNC} probe = async(function(id) return slowDone(5000) end)`), {
            host: slowHost,
        });
        await sleep(100);
        const queued = pool.regex({ op: "test", pattern: "a", flags: "", input: "a" });
        await pool.dispose();
        expect((await running).error).toBe("The script workers are disposed");
        expect(await queued).toEqual({ error: "The script workers are disposed" });
        expect((await pool.runLua(task("return 1"))).error).toBe("The script workers are disposed");
        expect(await pool.regex({ op: "test", pattern: "a", flags: "", input: "a" })).toEqual({
            error: "The script workers are disposed",
        });
    });

    it("replaces a terminated worker when the pool is warm", async () => {
        const pool = makePool({ size: 1, maxSize: 1 });
        pool.warm();
        // A Lua run waits for the worker's engines, so the worker has reported ready by its end; a
        // worker killed while still booting is not replaced ahead of demand.
        expect((await pool.runLua(task("function probe(id) return 1 end"))).res).toBe(1);
        expect(await pool.regex(REDOS)).toEqual({ error: "Regex timed out", timedOut: true });
        expect(pool.stats()).toMatchObject({ workers: 1, spawned: 2, terminated: 1 });
        expect(await pool.regex({ op: "test", pattern: "a", flags: "", input: "a" })).toEqual({ value: true });
    });

    it("reports a broken setup in the task's result instead of looping", async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "risu-no-json-lua-"));
        try {
            const pool = makePool({ rootDir: root });
            const r = await pool.runLua(task("function probe(id) return 1 end"));
            expect(r.error).toMatch(/json\.lua not found/);
            expect(await pool.regex({ op: "test", pattern: "a", flags: "", input: "a" })).toMatchObject({
                error: expect.stringMatching(/json\.lua not found/),
            });
            expect(pool.stats()).toMatchObject({ workers: 0, spawned: 0 });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("lets a plain Node process that never disposes the pool exit on its own", async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-pool-exit-"));
        try {
            const script = path.join(dir, "exit.mjs");
            writeFileSync(
                script,
                `import { createScriptWorkerPool } from ${JSON.stringify(path.join(REPO_ROOT, "server/src/scripts/workerPool.ts"))};
const pool = createScriptWorkerPool({ rootDir: ${JSON.stringify(REPO_ROOT)} });
const regex = await pool.regex({ op: "test", pattern: "a", flags: "", input: "a" });
const lua = await pool.runLua({ identity: { characterId: null, chatId: null, presetId: null, personaId: null }, code: "function probe(id) return 'ran' end", mode: "probe" });
console.log(JSON.stringify({ regex, lua: lua.res }));
`,
            );
            const [result, ms] = await timed(() => runNode([script], REPO_ROOT));
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            expect(JSON.parse(result.stdout.trim())).toEqual({ regex: { value: true }, lua: "ran" });
            expect(ms).toBeLessThan(15_000);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
