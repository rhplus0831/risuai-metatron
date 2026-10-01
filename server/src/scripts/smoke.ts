import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequestLimiter, type EgressDeps, serverLuaRequest } from "../lua/egress.ts";
import type { LuaRunOutput } from "../lua/runtime.ts";
import { createLuaBudget, createScriptWorkerPool, type LuaHost, type LuaTask } from "./workerPool.ts";

/**
 * The script worker spike's checks (Phase 5 slice 2), run under plain Node and inside the image:
 * `node server/src/scripts/smoke.ts [rootDir]`. Prints one line per check and a JSON summary, and
 * exits 1 when a check fails. Timings are measurements; the bounds are generous.
 */
type Check = { name: string; ok: boolean; ms: number; detail: unknown };

const rootDir = process.argv[2] ?? process.cwd();
const identity = { characterId: "c1", chatId: "chat1", presetId: "p1", personaId: null };
const checks: Check[] = [];
const ASYNC = `
function slowDone(ms)
    return slowHost(ms):await()
end
`;

async function check(name: string, run: () => Promise<{ ok: boolean; detail: unknown }>): Promise<void> {
    const start = performance.now();
    let entry: Check;
    try {
        const { ok, detail } = await run();
        entry = { name, ok, ms: Math.round(performance.now() - start), detail };
    } catch (error) {
        entry = { name, ok: false, ms: Math.round(performance.now() - start), detail: String(error) };
    }
    checks.push(entry);
    console.log(`${entry.ok ? "ok  " : "FAIL"} ${name} (${entry.ms} ms) ${JSON.stringify(entry.detail)}`);
}

const task = (code: string, mode = "probe", extra: Partial<LuaTask> = {}): LuaTask => ({
    code,
    mode,
    identity,
    ...extra,
});
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const start = performance.now();
    const value = await fn();
    return [value, Math.round(performance.now() - start)];
};
const slowHost: LuaHost = {
    async: { slowHost: ([ms]) => new Promise((resolve) => setTimeout(() => resolve("done"), Number(ms))) },
};
const brief = (r: LuaRunOutput) => ({
    res: r.res,
    error: r.error,
    timedOut: r.timedOut,
    aborted: r.aborted,
    cpuMs: r.cpuMs,
});

const pool = createScriptWorkerPool({ rootDir });
try {
    await check("boot: json.lua and the prelude", async () => {
        const r = await pool.runLua(task("function probe(id) return json.encode({1, 2}) end"));
        return { ok: r.res === "[1,2]", detail: brief(r) };
    });

    await check("top-level while true do end stops near the limit", async () => {
        const [r, ms] = await timed(() => pool.runLua(task("while true do end")));
        return { ok: r.timedOut === true && ms < 4500, detail: { ...brief(r), ms } };
    });

    await check("a handler loop stops near the limit", async () => {
        const [r, ms] = await timed(() => pool.runLua(task("function onInput(id) while true do end end", "input")));
        return { ok: r.timedOut === true && ms < 4500, detail: { ...brief(r), ms } };
    });

    await check("a pathological Lua pattern is stopped by the watchdog", async () => {
        const [r, ms] = await timed(() => pool.runLua(task(`return ("a"):rep(30000):find(("a-"):rep(20) .. "b")`)));
        return { ok: r.timedOut === true && ms < 6000, detail: { ...brief(r), ms } };
    });

    await check("a huge string.rep hits the Lua memory cap", async () => {
        const [r, ms] = await timed(() => pool.runLua(task(`local s = string.rep("x", 1000000000) return #s`)));
        return { ok: /not enough memory/.test(r.error ?? "") && ms < 3000, detail: { ...brief(r), ms } };
    });

    await check("a ReDoS regex is terminated and the pool recovers", async () => {
        const [r, ms] = await timed(() =>
            pool.regex({ op: "test", pattern: "(a+)+$", flags: "", input: "a".repeat(40) + "b" }),
        );
        const after = await pool.regex({ op: "test", pattern: "b$", flags: "", input: "ab" });
        return {
            ok: "timedOut" in r && r.timedOut === true && ms < 2000 && "value" in after && after.value === true,
            detail: { r, ms, after },
        };
    });

    await check("a 5 s host wait completes under the 3 s CPU limit", async () => {
        const [r, ms] = await timed(() =>
            pool.runLua(task(`${ASYNC} probe = async(function(id) return slowDone(5000) end)`), { host: slowHost }),
        );
        return { ok: r.res === "done" && !r.error && ms >= 5000 && r.cpuMs < 3000, detail: { ...brief(r), ms } };
    });

    await check("a top-level 5 s host wait completes too", async () => {
        const [r, ms] = await timed(() =>
            pool.runLua(task(`${ASYNC} done = slowDone(5000) function probe(id) return done end`), {
                host: slowHost,
            }),
        );
        return { ok: r.res === "done" && !r.error && ms >= 5000, detail: { ...brief(r), ms } };
    });

    await check("CPU spent across host calls is charged", async () => {
        const code = `${ASYNC} probe = async(function(id)
            for i = 1, 20 do
                local t = os.clock() while os.clock() - t < 0.4 do end
                slowDone(1)
            end
            return "finished"
        end)`;
        const [r, ms] = await timed(() => pool.runLua(task(code), { host: slowHost }));
        return { ok: r.timedOut === true && r.res === undefined && ms < 5000, detail: { ...brief(r), ms } };
    });

    await check("a second run proceeds in another worker while one is suspended", async () => {
        const order: string[] = [];
        const first = pool
            .runLua(task(`${ASYNC} probe = async(function(id) return slowDone(3000) end)`), { host: slowHost })
            .then((r) => {
                order.push("first");
                return r;
            });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = await pool.runLua(task("function probe(id) return 'quick' end"));
        order.push("second");
        const r = await first;
        return { ok: order.join() === "second,first" && r.res === "done" && second.res === "quick", detail: order };
    });

    await check("30 transform targets with a Lua editDisplay hook", async () => {
        const code = `listenEdit("editDisplay", function(id, value) return value .. "!" end)`;
        const [results, ms] = await timed(() =>
            Promise.all(
                Array.from({ length: 30 }, (_, i) => pool.runLua(task(code, "editDisplay", { data: `m${i}` }))),
            ),
        );
        const ok = results.every((r, i) => r.res === `m${i}!`);
        return { ok, detail: { ms, perTarget: Math.round(ms / 30), workers: pool.stats().workers } };
    });

    await check("a warm engine sees no global from the previous run", async () => {
        await pool.runLua(task("leaked = 1 function probe(id) return leaked end"));
        const r = await pool.runLua(task("function probe(id) return tostring(leaked) end"));
        return { ok: r.res === "nil", detail: brief(r) };
    });

    await check("an already-aborted signal returns without a run", async () => {
        const before = pool.stats();
        const r = await pool.runLua(task("function probe(id) return 1 end"), { signal: AbortSignal.abort() });
        return { ok: r.aborted === true && pool.stats().busy === before.busy, detail: brief(r) };
    });

    await check("an abort stops a running loop", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const [r, ms] = await timed(() =>
            pool.runLua(task("function probe(id) while true do end end"), { signal: controller.signal }),
        );
        return { ok: r.aborted === true && ms < 1500, detail: { ...brief(r), ms } };
    });

    await check("an abort cancels the outstanding host call", async () => {
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
        return { ok: r.aborted === true && hostAborted, detail: { ...brief(r), hostAborted } };
    });

    await check("a terminated worker cancels its run's host calls", async () => {
        let hostAborted = false;
        const host: LuaHost = {
            async: {
                lore: async (_args, ctx) => {
                    ctx.signal.addEventListener("abort", () => (hostAborted = true));
                    return await ctx.regex({ op: "test", pattern: "(a+)+$", flags: "", input: "a".repeat(40) + "b" });
                },
            },
        };
        const r = await pool.runLua(task("probe = async(function(id) return lore():await() end)"), { host });
        return {
            ok: hostAborted && r.res === undefined && r.error !== undefined,
            detail: { ...brief(r), hostAborted },
        };
    });

    await check("two suspended runs invoking lore finish on their own workers", async () => {
        const small = createScriptWorkerPool({ rootDir, size: 2, maxSize: 2 });
        try {
            const host: LuaHost = {
                async: {
                    lore: async (_args, ctx) => {
                        await new Promise((resolve) => setTimeout(resolve, 300));
                        const results = [];
                        for (const pattern of ["^a", "b$", "c"]) {
                            results.push(await ctx.regex({ op: "test", pattern, flags: "", input: "ab" }));
                        }
                        return results.map((r) => ("value" in r ? String(r.value) : "error")).join(",");
                    },
                },
            };
            const code = "probe = async(function(id) return lore():await() end)";
            const [results, ms] = await timed(() =>
                Promise.all([small.runLua(task(code), { host }), small.runLua(task(code), { host })]),
            );
            return {
                ok: results.every((r) => r.res === "true,true,false") && ms < 3000,
                detail: { results: results.map(brief), ms, workers: small.stats().workers },
            };
        } finally {
            await small.dispose();
        }
    });

    await check("a synchronous host call answers from the main thread", async () => {
        let calls = 0;
        const host: LuaHost = { sync: { getVar: ([, name]) => (calls++, `value of ${String(name)}`) } };
        const [r, ms] = await timed(() =>
            pool.runLua(
                task(`function probe(id)
                    local last
                    for i = 1, 1000 do last = getVar(id, "v" .. i) end
                    return last
                end`),
                { host },
            ),
        );
        return { ok: r.res === "value of v1000" && calls === 1000, detail: { ...brief(r), ms, perCallMs: ms / 1000 } };
    });

    await check("sleep is capped at 2 s per call and 6 s per run", async () => {
        const code = `probe = async(function(id)
            local a = sleep(id, 5000):await()
            local b = sleep(id, 5000):await()
            local c = sleep(id, 5000):await()
            local d = sleep(id, 5000)
            return tostring(a) .. tostring(b) .. tostring(c) .. tostring(d)
        end)`;
        const [r, ms] = await timed(() => pool.runLua(task(code)));
        return { ok: r.res === "truetruetruefalse" && ms >= 6000 && ms < 7500, detail: { ...brief(r), ms } };
    });

    await check("stopChat, return false, the log sink, and the identity", async () => {
        const logs: string[] = [];
        let seen: unknown = null;
        const host: LuaHost = {
            log: (value) => logs.push(value),
            sync: { who: (_args, ctx) => ((seen = ctx.identity), "ok") },
        };
        const a = await pool.runLua(task(`function onInput(id) log({ n = 1 }) who(id) stopChat(id) end`, "input"), {
            host,
        });
        const b = await pool.runLua(task("function onOutput(id) return false end", "output"));
        return {
            ok:
                a.stopSending &&
                b.stopSending &&
                logs[0] === '{"n":1}' &&
                JSON.stringify(seen) === JSON.stringify(identity),
            detail: { a: a.stopSending, b: b.stopSending, logs, seen },
        };
    });

    await check("the hardening removes host and file-system access", async () => {
        const r = await pool.runLua(
            task(`function probe(id)
                local function try(f) local ok, v = pcall(f) return ok and tostring(v) or "error" end
                return table.concat({
                    tostring(io), try(function() return require("io") end), tostring(package.loaded.io),
                    tostring(os.execute), tostring(os.getenv), tostring(string.dump),
                    tostring(debug.getregistry), tostring(debug.sethook), tostring(debug.getupvalue),
                    tostring(#package.searchers), try(function() return require("json.lua") end),
                    tostring(load(string.char(27) .. "Lua")), tostring(load("return 1")()),
                    type(require("json").encode), type(debug.traceback),
                }, ",")
            end`),
        );
        const expected = "nil,error,nil,nil,nil,nil,nil,nil,nil,1,error,nil,1,function,function";
        return { ok: r.res === expected, detail: brief(r) };
    });

    await check("print goes to the log sink", async () => {
        const logs: string[] = [];
        const r = await pool.runLua(task(`print("a", 1, nil) function probe(id) return 1 end`), {
            host: { log: (value) => logs.push(value) },
        });
        return { ok: r.res === 1 && logs[0] === "a\t1\tnil", detail: { logs } };
    });

    await check("an unawaited host call does not pause the watchdog", async () => {
        const host: LuaHost = { async: { hold: () => new Promise(() => {}) } };
        const [r, ms] = await timed(() =>
            pool.runLua(
                task(`function probe(id) hold(id) return ("a"):rep(30000):find(("a-"):rep(20) .. "b") end`, "probe", {
                    cpuMs: 100,
                }),
                { host },
            ),
        );
        return { ok: r.timedOut === true && ms < 2000, detail: { ...brief(r), ms } };
    });

    await check("a coroutine computing after a long host wait is charged only its compute", async () => {
        const code = `${ASYNC} probe = async(function(id)
            slowDone(350)
            local t = os.clock() while os.clock() - t < 0.02 do end
            return "after"
        end)`;
        const a = await pool.runLua(task(code, "probe", { cpuMs: 100 }), { host: slowHost });
        // A coroutine started by the top-level chunk, awaited by the handler.
        const b = await pool.runLua(
            task(
                `${ASYNC} pending = async(function() slowDone(350) local t = os.clock() while os.clock() - t < 0.02 do end return "top" end)()
                probe = async(function(id) return pending:await() end)`,
                "probe",
                { cpuMs: 100 },
            ),
            { host: slowHost },
        );
        return { ok: a.res === "after" && b.res === "top", detail: [brief(a), brief(b)] };
    });

    await check("a synchronous wait is not charged", async () => {
        const host: LuaHost = { sync: { slow: () => new Promise((resolve) => setTimeout(() => resolve("v"), 350)) } };
        const r = await pool.runLua(
            task(
                `local v = slow() local t = os.clock() while os.clock() - t < 0.02 do end function probe(id) return v end`,
                "probe",
                {
                    cpuMs: 100,
                },
            ),
            { host },
        );
        return { ok: r.res === "v" && !r.error, detail: brief(r) };
    });

    await check("an abort during a synchronous call stops the next host effect", async () => {
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
        return { ok: r.aborted === true && r.res === undefined && writes === 0, detail: { ...brief(r), writes } };
    });

    await check("a host context stops working when its run ends", async () => {
        let kept: {
            regex: (op: { op: "test"; pattern: string; flags: string; input: string }) => Promise<unknown>;
        } | null = null;
        const host: LuaHost = { async: { keep: async (_args, ctx) => ((kept = ctx), "kept") } };
        await pool.runLua(task(`probe = async(function(id) return keep():await() end)`), { host });
        const late = await kept!.regex({ op: "test", pattern: "(a+)+$", flags: "", input: "a".repeat(40) + "b" });
        const next = await pool.runLua(task("function probe(id) return 'next' end"));
        return {
            ok: JSON.stringify(late).includes("ended") && next.res === "next",
            detail: { late, next: brief(next) },
        };
    });

    await check("a host reply that is not a primitive fails only that call", async () => {
        let unhandled = 0;
        const onUnhandled = () => unhandled++;
        process.on("unhandledRejection", onUnhandled);
        try {
            const host: LuaHost = { async: { fn: async () => () => 42 } };
            const r = await pool.runLua(
                task(
                    `probe = async(function(id) local ok, e = pcall(function() return fn():await() end) return tostring(ok) end)`,
                ),
                { host },
            );
            const viaResult = await pool.runLua(task("function onInput(id) return function() end end", "input"));
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
                ok: r.res === "false" && viaResult.res === undefined && !viaResult.error && unhandled === 0,
                detail: { r: brief(r), viaResult: brief(viaResult), unhandled },
            };
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    await check("an amplified regex capture is refused by size", async () => {
        const r = await pool.regex({ op: "matches", pattern: "(?=(.{5000}))", flags: "g", input: "x".repeat(10_000) });
        return { ok: "error" in r && /larger than/.test(r.error), detail: r };
    });

    await check("runs sharing a budget cannot overspend it", async () => {
        const one = createScriptWorkerPool({ rootDir, size: 1, maxSize: 1 });
        try {
            const budget = createLuaBudget(100);
            const spin =
                "function probe(id) local t = os.clock() while os.clock() - t < 0.075 do end return 'done' end";
            const results = await Promise.all(Array.from({ length: 4 }, () => one.runLua(task(spin), { budget })));
            return {
                ok:
                    budget.usedMs <= 130 &&
                    budget.reservedMs === 0 &&
                    results.filter((r) => r.res === "done").length === 1,
                detail: { budget, results: results.map(brief) },
            };
        } finally {
            await one.dispose();
        }
    });

    await check("the job budget is charged and refuses an exhausted run", async () => {
        const budget = createLuaBudget(4000);
        const first = await pool.runLua(task("while true do end"), { budget });
        const second = await pool.runLua(task("while true do end"), { budget });
        const third = await pool.runLua(task("function probe(id) return 1 end"), { budget });
        return {
            ok: first.timedOut === true && second.timedOut === true && third.timedOut === true && budget.usedMs >= 4000,
            detail: { first: brief(first), second: brief(second), third: brief(third), usedMs: budget.usedMs },
        };
    });

    await check("a regex result is capped before it reaches the main thread", async () => {
        const r = await pool.regex({ op: "split", pattern: "(b)", flags: "", input: "ab".repeat(8_000_000) });
        return { ok: "error" in r && /More than/.test(r.error), detail: r };
    });

    await check("a worker heap runaway costs only that worker", async () => {
        // A 16 MiB heap boots a worker but cannot hold 100,000 matches over a 16 MB input.
        const tight = createScriptWorkerPool({ rootDir, resourceLimits: { maxOldGenerationSizeMb: 16 } });
        try {
            const before = await tight.regex({ op: "test", pattern: "a", flags: "", input: "a" });
            const r = await tight.regex({ op: "matches", pattern: "(.)", flags: "g", input: "ab".repeat(8_000_000) });
            const after = await tight.regex({ op: "test", pattern: "a", flags: "", input: "a" });
            return {
                ok: "value" in before && "error" in r && /memory/.test(r.error) && "value" in after,
                detail: { r, after, stats: tight.stats() },
            };
        } finally {
            await tight.dispose();
        }
    });

    await check("HTTP requests answer while a worker is terminated", async () => {
        const server = http.createServer((_req, res) => res.end("ok"));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            const runaway = pool.regex({ op: "test", pattern: "(a+)+$", flags: "", input: "a".repeat(40) + "b" });
            const latencies: number[] = [];
            for (let i = 0; i < 15; i++) {
                const [, ms] = await timed(() => fetch(`http://127.0.0.1:${port}/`).then((res) => res.text()));
                latencies.push(ms);
                await new Promise((resolve) => setTimeout(resolve, 60));
            }
            const r = await runaway;
            return { ok: "timedOut" in r && Math.max(...latencies) < 200, detail: { max: Math.max(...latencies) } };
        } finally {
            server.close();
        }
    });

    await check("egress rejects what the guard forbids", async () => {
        const deps: EgressDeps = {
            lookup: async (host) =>
                host === "private.example"
                    ? [{ address: "10.0.0.5", family: 4 }]
                    : host === "mixed.example"
                      ? [
                            { address: "93.184.216.34", family: 4 },
                            { address: "::ffff:127.0.0.1", family: 6 },
                        ]
                      : [{ address: "93.184.216.34", family: 4 }],
            fetchImpl: async () => ({ status: 200, data: "fetched" }),
        };
        const limiter = createRequestLimiter();
        const status = async (url: string) =>
            (JSON.parse(await serverLuaRequest(url, { limiter, deps })) as { status: number }).status;
        const results = {
            http: await status("http://public.example/"),
            long: await status("https://public.example/" + "x".repeat(98)),
            localhost: await status("https://localhost/"),
            private: await status("https://private.example/"),
            mixed: await status("https://mixed.example/"),
            banned: await status("https://risuai.net/x"),
        };
        const window: number[] = [];
        for (let i = 0; i < 31; i++) {
            window.push(await status("https://public.example/"));
        }
        const ok =
            results.http === 400 &&
            results.long === 413 &&
            results.localhost === 403 &&
            results.private === 403 &&
            results.mixed === 403 &&
            results.banned === 400 &&
            window.slice(0, 30).every((s) => s === 200) &&
            window[30] === 429;
        return { ok, detail: { ...results, thirtyFirst: window[30] } };
    });

    await check("the address classifier blocks non-public ranges", async () => {
        const { isBlockedAddress } = await import("../lua/egress.ts");
        const blocked = [
            "ff02::1",
            "fec0::1",
            "64:ff9b:1::7f00:1",
            "2001:db8::1",
            "::7f00:1",
            "64:ff9b::a00:1",
            "2002:a00:1::",
            "2001::1",
            "198.18.0.1",
            "192.0.2.1",
            "fe80::1%eth0",
        ];
        const allowed = ["8.8.8.8", "2606:4700::1111", "64:ff9b::808:808", "::ffff:8.8.8.8"];
        const wrong = [...blocked.filter((a) => !isBlockedAddress(a)), ...allowed.filter((a) => isBlockedAddress(a))];
        return { ok: wrong.length === 0, detail: { wrong } };
    });

    await check("a stalled name lookup ends with the abort", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const [outcome, ms] = await timed(() =>
            serverLuaRequest("https://stalled.example/", {
                limiter: createRequestLimiter(),
                deps: { lookup: () => new Promise(() => {}) },
                signal: controller.signal,
            }).then(
                () => "answered",
                (error: Error) => error.message,
            ),
        );
        return { ok: outcome === "request aborted" && ms < 200, detail: { outcome, ms } };
    });

    await check("request needs low-level access and goes through the guard", async () => {
        const guarded = createScriptWorkerPool({
            rootDir,
            egress: {
                lookup: async () => [{ address: "93.184.216.34", family: 4 }],
                fetchImpl: async () => ({ status: 200, data: "fetched" }),
            },
        });
        try {
            const code = `probe = async(function(id)
                local r = request(id, "https://public.example/")
                if r == nil then return "denied" end
                return json.decode(r:await()).data
            end)`;
            const denied = await guarded.runLua(task(code));
            const allowed = await guarded.runLua(task(code, "probe", { lowLevelAccess: true }));
            return {
                ok: denied.res === "denied" && allowed.res === "fetched",
                detail: [brief(denied), brief(allowed)],
            };
        } finally {
            await guarded.dispose();
        }
    });
    await check("an object never reaches Lua as a live JS proxy", async () => {
        const host: LuaHost = { async: { obj: async () => ({ a: 1 }), arr: async () => [1, 2] } };
        const polluted = await pool.runLua(
            task(
                `probe = async(function(id)
                    local ok1 = pcall(function() local o = obj():await() o.__proto__.polluted = "A" end)
                    local ok2 = pcall(function() local a = arr():await() a.__proto__.push = function() end end)
                    return tostring(ok1) .. tostring(ok2)
                end)`,
            ),
            { host },
        );
        const button = await pool.runLua(
            task("function onButtonClick(id, data) return type(data) end", "onButtonClick", {
                data: { a: 1 },
            }),
        );
        // Errors (a host rejection or throw, wasmoon's own) arrive as strings, objects as copied tables.
        const errorHost: LuaHost = {
            async: {
                fail: async () => {
                    throw new Error("boom");
                },
            },
            sync: {
                sfail: () => {
                    throw new Error("sboom");
                },
            },
        };
        const values = await pool.runLua(
            task(
                `probe = async(function(id)
                    local _, a = pcall(function() return fail():await() end)
                    local _, b = pcall(sfail, id)
                    local _, c = pcall(Promise.resolve(1).next, nil)
                    local d = Promise.resolve({ x = 1 }):await()
                    local e = Promise.all({ 1, 2 }):await()
                    local _, f = pcall(function() return Promise.create(function(_, rej) rej({ y = 1 }) end):await() end)
                    return table.concat({ type(a), a, type(b), b, type(c), type(d), tostring(d.x),
                        tostring(rawget(d, "__proto__")), type(e), tostring(e[2]), type(f), tostring(f.y) }, ",")
                end)`,
            ),
            { host: errorHost },
        );
        const regex = await pool.regex({ op: "matches", pattern: "a", flags: "g", input: "aaa" });
        return {
            ok:
                values.res === "string,boom,string,sboom,string,table,1,nil,table,2,table,1" &&
                polluted.res === "falsefalse" &&
                button.res === undefined &&
                /primitive|string, number/.test(button.error ?? "") &&
                "value" in regex &&
                ({} as Record<string, unknown>).polluted === undefined,
            detail: { polluted: brief(polluted), values: brief(values), button: brief(button), regex },
        };
    });

    await check("dispose after warm leaves no worker behind", async () => {
        const warmPool = createScriptWorkerPool({ rootDir, size: 2, maxSize: 2 });
        warmPool.warm();
        await warmPool.runLua(task("function probe(id) return 1 end"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await warmPool.dispose();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const stats = warmPool.stats();
        return { ok: stats.workers === 0 && stats.spawned === stats.terminated, detail: stats };
    });

    await check("a runaway after a synchronous timeout is still charged", async () => {
        const one = createScriptWorkerPool({ rootDir, size: 1, maxSize: 1, wallMs: 30_000 });
        try {
            const [r, ms] = await timed(() =>
                one.runLua(
                    task(
                        `function probe(id) pcall(never, id) return ("a"):rep(30000):find(("a-"):rep(20) .. "b") end`,
                        "probe",
                        { cpuMs: 100 },
                    ),
                    { host: { sync: { never: () => new Promise(() => {}) } } },
                ),
            );
            return { ok: r.timedOut === true && ms < 15_000, detail: { r: brief(r), ms } };
        } finally {
            await one.dispose();
        }
    });
} finally {
    const stats = pool.stats();
    await pool.dispose();
    const failed = checks.filter((entry) => !entry.ok).map((entry) => entry.name);
    console.log(
        JSON.stringify({
            passed: checks.length - failed.length,
            failed,
            stats,
            node: process.version,
            arch: process.arch,
            rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
        }),
    );
    process.exitCode = failed.length > 0 ? 1 : 0;
}
