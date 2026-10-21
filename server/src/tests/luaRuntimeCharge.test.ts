// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLuaRuntime, type LuaRunHooks } from "../lua/runtime.ts";

// The Lua runtime's CPU charge (`server/src/lua/runtime.ts`), in this process on a busy clock the
// test moves: a run is charged the thread's busy time since its code started
// (`performance.eventLoopUtilization().active`), summed across its awaited host calls, less the
// time of its synchronous host calls. The clock is a mock, so the charge is exact and no segment
// of real CPU can reach the allowance: a runtime that restarted its charge at each host call, or
// charged a synchronous answer, reports another number. The real worker's version of this
// contract (a run cut at its allowance) is `scriptWorker.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BOOT_TIMEOUT_MS = 60_000;
const identity = { characterId: null, chatId: null, presetId: null, personaId: null };
/** An allowance no run below reaches. */
const LONG_MS = 1_000_000;

const runtime = createLuaRuntime({ jsonLua: readFileSync(path.join(REPO_ROOT, "public/lua/json.lua"), "utf8") });

/** The thread's busy time as the runtime reads it: `active` ms, moved only by the test. */
function busyClock() {
    let active = 1000;
    const spy = vi
        .spyOn(performance, "eventLoopUtilization")
        .mockImplementation(
            () => ({ idle: 0, active, utilization: 1 }) as ReturnType<typeof performance.eventLoopUtilization>,
        );
    return {
        advance: (ms: number) => {
            active += ms;
        },
        restore: () => spy.mockRestore(),
    };
}

// The engines are the module's: this process ends with the file.
beforeAll(() => runtime.warm(), BOOT_TIMEOUT_MS);
afterEach(() => {
    vi.restoreAllMocks();
});

describe("the charge of a run", () => {
    it("sums the busy time between awaited host calls and leaves out a synchronous answer's", async () => {
        const clock = busyClock();
        try {
            const calls: string[] = [];
            const hooks: LuaRunHooks = {
                aborted: () => false,
                log: () => {},
                // Busy time right before the answer is between this call's checkpoint and the next one's.
                callAsync: async (name, [, ms]) => {
                    calls.push(`${name}:${ms}`);
                    clock.advance(Number(ms));
                    return "done";
                },
                // A synchronous answer blocks the worker; its time is the host's, not the run's.
                callSync: (name, [, ms]) => {
                    calls.push(`${name}:${ms}`);
                    clock.advance(Number(ms));
                    return "sync";
                },
            };
            const out = await runtime.run(
                {
                    identity,
                    mode: "probe",
                    cpuMs: LONG_MS,
                    asyncHost: ["spend"],
                    syncHost: ["answer"],
                    code: `probe = async(function(id)
                        local a = spend(id, 100):await()
                        local b = spend(id, 200):await()
                        local s = answer(id, 5000)
                        local c = spend(id, 300):await()
                        return a .. b .. s .. c
                    end)`,
                },
                hooks,
            );
            expect(out.error).toBeUndefined();
            expect(out.res).toBe("donedonesyncdone");
            expect(calls).toEqual(["spend:100", "spend:200", "answer:5000", "spend:300"]);
            // 100 + 200 + 300, nothing of the 5000 ms synchronous answer.
            expect(out.cpuMs).toBe(600);
            expect(out.timedOut).toBeUndefined();
        } finally {
            clock.restore();
        }
    });

    it("charges the busy time since the run started, not the thread's whole", async () => {
        const clock = busyClock();
        try {
            // Busy time before the run is the thread's history, none of it the run's.
            clock.advance(50_000);
            const out = await runtime.run(
                { identity, mode: "probe", cpuMs: LONG_MS, code: "function probe(id) return 'plain' end" },
                { aborted: () => false, log: () => {}, callAsync: async () => null, callSync: () => null },
            );
            expect(out.error).toBeUndefined();
            expect(out.res).toBe("plain");
            expect(out.cpuMs).toBe(0);
        } finally {
            clock.restore();
        }
    });
});
