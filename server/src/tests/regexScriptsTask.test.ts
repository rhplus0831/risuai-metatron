// @vitest-environment node
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { customscript } from "../../../shared/database.ts";
import type { RegexScriptEffect } from "../../../shared/scripts/regex.ts";
import { createScriptWorkerPool, type RegexScriptsHost } from "../scripts/workerPool.ts";
import { UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

// The regex script engine as a worker task (`workerPool.ts` `runScripts`, `worker.ts`
// `REGEX_SCRIPTS_MODE`) under the real workers: the synchronous hosts (`parse` on the replaced text,
// `repeatBack`, `effect`) answered on the main thread in script order, each effect exactly once where
// its script matched; an abort inside a host effect ending the task with no later host call; the
// bounds shared with Lua tasks as JSON (a CBS argument over 16 MiB failing the task with no later
// host call, not even a later script's effect; a result over 16 MiB as JSON refused whether the raw
// text or its escaping crosses the cap, also for a `@@repeat_back` that never reaches `parse`); and
// the worker reused by a plain run afterwards. The engine's own semantics are pinned in
// `regex.test.ts`; the send that runs this task in `promptRunner.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const identity = { characterId: "c", chatId: "k", presetId: "p", personaId: null };
const MIB = 1024 * 1024;
const script = (fields: Partial<customscript>): customscript => ({
    comment: "",
    in: "",
    out: "",
    type: "editprocess",
    ableFlag: true,
    flag: "g",
    ...fields,
});

// Booted once, with ten-minute allowances: the subjects here are the caps and the host order, not
// the CPU allowance or a regex deadline.
const pool = createScriptWorkerPool({ rootDir: REPO_ROOT, size: 1, ...UNHURRIED_SCRIPT_WORKERS });
beforeAll(() => pool.warm(), 60_000);
afterAll(async () => {
    await pool.dispose();
});

/** A recording host: `parse` records and returns the text, `repeatBack` answers a fixed text. */
function recordingHost(over: Partial<RegexScriptsHost> = {}) {
    const calls: string[] = [];
    const effects: RegexScriptEffect[] = [];
    const host: RegexScriptsHost = {
        parse: (text) => {
            calls.push(`parse:${text.length > 40 ? `${text.length} chars` : text}`);
            return text;
        },
        repeatBack: () => {
            calls.push("repeatBack");
            return "the previous z";
        },
        effect: (effect) => {
            calls.push(`effect:${effect.kind}`);
            effects.push(effect);
        },
        ...over,
    };
    return { host, calls, effects };
}
const run = (data: string, scripts: customscript[], host: RegexScriptsHost, signal?: AbortSignal) =>
    pool.runScripts({ data, scripts, mode: "editprocess", chatID: 1, identity }, { host, signal });

describe("the regex scripts task", () => {
    it("runs the scripts in order with the hosts answered on the main thread, each effect once where it matched", async () => {
        const { host, calls, effects } = recordingHost();
        const result = await run(
            "a b c",
            [
                script({ in: "a", out: "x" }),
                script({ in: "b", out: "@@emo happy" }),
                script({ in: "c", out: "@@inject" }),
                script({ in: "z", out: "@@repeat_back" }),
            ],
            host,
        );
        // `a` -> `x` through `parse`; the emotion; the inject of the text as it is then, its match
        // removed; `@@repeat_back` (no `z` in the text) appends the previous reply's `z`.
        expect(result).toEqual({ data: "x b z" });
        expect(calls).toEqual(["parse:x b c", "effect:emotion", "effect:inject", "repeatBack"]);
        expect(effects).toEqual([
            { kind: "emotion", name: "happy" },
            { kind: "inject", text: "x b c" },
        ]);
    }, 30_000);

    it("ends the task as aborted when a host effect aborts the run, with no later host call", async () => {
        const controller = new AbortController();
        const { host, calls, effects } = recordingHost({
            effect: (effect) => {
                effects.push(effect);
                calls.push(`effect:${effect.kind}`);
                controller.abort();
                throw new Error("fatal probe");
            },
        });
        const result = await run(
            "ab",
            [script({ in: "a", out: "@@inject" }), script({ in: "b", out: "@@emo sad" })],
            host,
            controller.signal,
        );
        expect(result).toEqual({ error: "request aborted", aborted: true });
        expect(effects).toEqual([{ kind: "inject", text: "ab" }]);
        expect(calls).toEqual(["effect:inject"]);
    }, 30_000);

    it("fails the task for a CBS argument over the cap and dispatches no host call after it, not even a later effect", async () => {
        const { host, calls, effects } = recordingHost();
        const result = await run(
            "x".repeat(9 * MIB),
            [
                // The replacement doubles the text past 16 MiB before it reaches `parse`.
                script({ in: "^.*$", out: "$&$&" }),
                // The engine goes on scanning after the failure (its per-script catch): these would
                // call the hosts, and `@@repeat_back` on a text without a match reads its source.
                script({ in: "x", out: "@@emo happy" }),
                script({ in: "x", out: "@@inject" }),
                script({ in: "zzz", out: "@@repeat_back" }),
            ],
            host,
        );
        expect(result).toEqual({ error: "Regex scripts: a CBS input too large" });
        expect(calls).toEqual([]);
        expect(effects).toEqual([]);
    }, 60_000);

    it("refuses a result over the cap as JSON, whether by its length or by its escaping, also without a parse round trip", async () => {
        // `@@repeat_back` appends the previous reply's match (`y` or `\\` runs, absent from the text)
        // with no `parse`.
        const appending = (previous: string) =>
            recordingHost({ parse: (text) => text, repeatBack: () => previous }).host;
        // 9 MiB of text and 9 MiB appended: 18 MiB of text.
        const raw = await run(
            "x".repeat(9 * MIB),
            [script({ in: "y+", out: "@@repeat_back end" })],
            appending("y".repeat(9 * MIB)),
        );
        expect(raw).toEqual({ error: "Regex scripts: the result is too large" });
        // 5 MiB of quotes and 5 MiB of backslashes: 10 MiB of text, over 20 MiB once escaped as JSON.
        const escaped = await run(
            '"'.repeat(5 * MIB),
            [script({ in: "\\\\+", out: "@@repeat_back end" })],
            appending("\\".repeat(5 * MIB)),
        );
        expect(escaped).toEqual({ error: "Regex scripts: the result is too large" });
        // The same append on a small text is fine, on the same worker.
        expect(await run("ab", [script({ in: "y+", out: "@@repeat_back end" })], appending("yy"))).toEqual({
            data: "abyy",
        });
    }, 60_000);

    it("reports a script's own failure the engine's way (skipped) and keeps the worker for the next run", async () => {
        const { host } = recordingHost({ parse: (text) => text });
        // An unclosed pattern is skipped by the engine; the later script still runs.
        expect(
            await run("hello", [script({ in: "(unclosed", out: "X" }), script({ in: "hello", out: "bye" })], host),
        ).toEqual({
            data: "bye",
        });
        expect(await pool.regex({ op: "test", pattern: "b$", flags: "", input: "ab" })).toEqual({ value: true });
    }, 30_000);
});
