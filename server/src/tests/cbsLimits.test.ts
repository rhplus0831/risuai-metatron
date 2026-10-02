// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCbsEvaluator, type CbsEvaluator, type CbsParseArg } from "../../../shared/cbs/evaluator.ts";
import {
    CbsLimitError,
    type CbsLimits,
    type CbsUsage,
    createCbsBudget,
    replaceAllBound,
    spendCbsWork,
} from "../../../shared/cbs/limits.ts";
import type { Database, character, groupChat } from "../../../shared/database.ts";
import { SERVER_CBS_MAX_MS, SERVER_CBS_MAX_WORK, serverCbsLimits } from "../jobs/cbsHost.ts";
import { createNodeCbsHost } from "./cbsHost.ts";

// Phase 5 slice 9b: the cooperative limits of the shared CBS evaluator (`shared/cbs/limits.ts`,
// `CbsHost.limits`) over the Node test host with small limits and an injected clock: the budget
// arithmetic (an exact budget, the refusal before the scan, a function's result charged, a result
// never longer than the work limit on every output path), the sharing of one budget by the nested
// parses of a top-level call (the registry's, `call::`) and its reset after a result or an error,
// the clock (the threshold crossing, the check after the last function, a parse that ends after its
// deadline), the shared allowance of several evaluators (`total`), the registry's charges (`range`,
// `dice`, `cbr`, `replace`, `join`, `filter`, `#each`, `#pure_display`, the unfinished-syntax
// drain), the matcher letting the limit error through, and the browser-path parity: an evaluator
// without limits never reads the clock, and a bounded host answers the host-parity cases and the
// whitespace and coercion cases as the unbounded one does. The runaway templates run in a child
// process, so a broken limit cannot hang the test run. The server's wiring is in
// `cbsLimitsHost.test.ts` and `cbsLimitsJobs.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const parity = JSON.parse(readFileSync(path.join(FIXTURES, "cbs-parity.json"), "utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

type ParityCase = {
    name: string;
    input: string;
    expected: string;
    triggerId?: string;
    arg?: {
        chatID?: number;
        chatRef?: { chaId: string; chatId: string };
        charaId?: string;
        chara?: string;
        rmVar?: boolean;
        consistantChar?: boolean;
    };
};

/** A clock the test advances; `tick` is added at every read. */
function fakeClock(tick = 0) {
    const clock = {
        time: 0,
        tick,
        reads: 0,
        now: () => {
            clock.reads++;
            clock.time += clock.tick;
            return clock.time;
        },
    };
    return clock;
}

const limitError = (fn: () => unknown): CbsLimitError => {
    try {
        fn();
    } catch (error) {
        expect(error).toBeInstanceOf(CbsLimitError);
        return error as CbsLimitError;
    }
    throw new Error("expected a CbsLimitError");
};

let db: Database;
let sel: character;
beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = clone(parity.database) as Database;
    sel = db.characters[0] as character;
});
afterEach(() => {
    vi.restoreAllMocks();
});

/** An evaluator over the fixture database, with `limits` or none. */
function evaluator(limits?: CbsLimits, over: Partial<ReturnType<typeof createNodeCbsHost>> = {}): CbsEvaluator {
    return createCbsEvaluator({ ...createNodeCbsHost(db, { selectedCharID: 0 }), ...over, limits });
}
const bounded = (maxWork: number, extra: Partial<CbsLimits> = {}) =>
    evaluator({ maxWork, maxMs: 1_000_000, now: () => 0, ...extra });

describe("the budget", () => {
    it("validates the limits", () => {
        for (const bad of [0, -1, Number.NaN] as number[]) {
            expect(() => createCbsBudget({ maxWork: bad, maxMs: 10 })).toThrow(/positive numbers/);
            expect(() => createCbsBudget({ maxWork: 10, maxMs: bad })).toThrow(/positive numbers/);
            expect(() =>
                createCbsBudget({ maxWork: 10, maxMs: 10, total: { usage: { usedMs: 0 }, maxMs: bad } }),
            ).toThrow(/positive numbers/);
        }
        expect(() => createCbsBudget({ maxWork: 1, maxMs: 1 })).not.toThrow();
    });

    it("charges only positive finite units: NaN, negative and zero count nothing, an infinite charge reaches the limit", () => {
        const budget = createCbsBudget({ maxWork: 10, maxMs: 1000, now: () => 0 });
        budget.deadline = 1000;
        spendCbsWork(budget, Number.NaN);
        spendCbsWork(budget, -5);
        spendCbsWork(budget, 0);
        expect(budget.work).toBe(0);
        spendCbsWork(budget, 10);
        expect(budget.work).toBe(10);
        expect(limitError(() => spendCbsWork(budget, 1)).reason).toBe("work");
        const fresh = createCbsBudget({ maxWork: 10, maxMs: 1000, now: () => 0 });
        fresh.deadline = 1000;
        expect(limitError(() => spendCbsWork(fresh, Number.POSITIVE_INFINITY)).reason).toBe("work");
    });

    it("spends exactly one unit per plain character: a text of the limit's length passes, one more is refused before the scan", () => {
        expect(bounded(100).risuChatParser("a".repeat(100))).toBe("a".repeat(100));
        const userName = vi.fn(() => "User");
        const refused = limitError(() =>
            bounded(100, {}).risuChatParser("a".repeat(93) + "{{user}}", undefined as unknown as CbsParseArg),
        );
        expect(refused.reason).toBe("work");
        expect(refused.message).toBe("CBS limit reached: one template took more than 100 steps");
        // The text is longer than the budget, so nothing in it is evaluated.
        const ev = evaluator({ maxWork: 100, maxMs: 1_000_000, now: () => 0 }, { getUserName: userName });
        expect(() => ev.risuChatParser("a".repeat(93) + "{{user}}")).toThrow(CbsLimitError);
        expect(userName).not.toHaveBeenCalled();
    });

    it("charges a function's result: a result longer than the work limit is refused however short the template", () => {
        db.username = "U".repeat(60);
        expect(bounded(200).risuChatParser("{{user}}")).toBe("U".repeat(60));
        expect(limitError(() => bounded(50).risuChatParser("{{user}}")).reason).toBe("work");
        // The forced-return path (`{{return}}`) and an object-returning function are held to the same bound.
        expect(bounded(200).risuChatParser("x{{return::{{user}}}}y")).toBe("U".repeat(60));
        expect(limitError(() => bounded(50).risuChatParser("x{{return::{{user}}}}y")).reason).toBe("work");
        // A result that is exactly the limit passes.
        db.username = "U".repeat(42);
        expect(bounded(50).risuChatParser("{{user}}")).toBe("U".repeat(42));
    });

    it("is shared by the nested parses of one top-level call, and starts over at the next top-level call, after a result or an error", () => {
        // `{{description}}` parses the description in a nested call of the same budget.
        sel.desc = "d".repeat(120);
        expect(bounded(300).risuChatParser("{{description}}")).toBe("d".repeat(120));
        // The outer text (15) plus the nested scan (120) plus the result charged twice (nested and outer).
        const ev = bounded(200);
        expect(limitError(() => ev.risuChatParser("{{description}}")).reason).toBe("work");
        // The failed call left no debt: a fresh top-level call has the whole budget again.
        expect(ev.risuChatParser("a".repeat(200))).toBe("a".repeat(200));
        expect(ev.risuChatParser("a".repeat(200))).toBe("a".repeat(200));
        // A `call::` of a function defined in the text is a nested parse of the same budget too.
        const func = "{{#func f a}}<{{arg::1}}>{{/func}}{{call::f::hello}}";
        expect(bounded(200).risuChatParser(func)).toBe("<hello>");
        expect(limitError(() => bounded(60).risuChatParser(func)).reason).toBe("work");
    });

    it("lets the matcher's catch pass the limit error instead of leaving the function's literal text", () => {
        sel.desc = "{{range::[0,1,0]}}";
        const ev = bounded(5000);
        // Without the rethrow the stuck `range` would be swallowed and `{{description}}` left as it is.
        const error = limitError(() => ev.risuChatParser("[{{description}}]"));
        expect(error.reason).toBe("work");
        // An ordinary failing function still leaves its literal text, as before.
        const throwing = evaluator(
            { maxWork: 5000, maxMs: 1_000_000, now: () => 0 },
            {
                getViewport: () => {
                    throw new Error("no viewport");
                },
            },
        );
        expect(throwing.risuChatParser("a {{screenwidth}} b")).toBe("a {{screenwidth}} b");
    });
});

describe("the clock", () => {
    it("is read at every {{ and }}, after a function, before the return, and at least every 4096 units of plain text", () => {
        const clock = fakeClock();
        const ev = evaluator({ maxWork: 1_000_000, maxMs: 1000, now: clock.now });
        ev.risuChatParser("a".repeat(100));
        // The entry, the final check.
        expect(clock.reads).toBe(2);
        clock.reads = 0;
        ev.risuChatParser("a".repeat(5000));
        // The entry, the 4096 threshold, the final check.
        expect(clock.reads).toBe(3);
        clock.reads = 0;
        ev.risuChatParser("{{user}}");
        // The entry, the `{{`, the `}}`, after the function, the final check.
        expect(clock.reads).toBe(5);
    });

    it("detects a crossed threshold under one large charge, not only an exact multiple", () => {
        db.username = "U".repeat(10_000);
        // The clock stands at 0 until the function ran (the entry, the `{{`, the `}}`), then at 10.
        let calls = 0;
        const now = () => (++calls >= 4 ? 10 : 0);
        const ev = evaluator({ maxWork: 1_000_000, maxMs: 5, now });
        // The function's result crosses 4096 in one charge: the clock is read there, past the deadline.
        const error = limitError(() => ev.risuChatParser("{{user}}"));
        expect(error.reason).toBe("time");
        expect(error.message).toBe("CBS limit reached: one template took more than 5 ms");
        expect(calls).toBe(4);
    });

    it("ends a parse whose last function ran past the deadline even when the result is tiny", () => {
        const clock = fakeClock();
        const ev = evaluator(
            { maxWork: 1_000_000, maxMs: 10, now: clock.now },
            {
                getUserName: () => {
                    clock.time += 11;
                    return "U";
                },
            },
        );
        expect(limitError(() => ev.risuChatParser("{{user}}")).reason).toBe("time");
        // Without the slow function the same evaluator answers.
        expect(ev.risuChatParser("{{char}}")).toBe("Sel");
    });

    it("never runs without limits: an evaluator without them does not read the clock", () => {
        const now = vi.spyOn(performance, "now");
        const ev = evaluator(undefined);
        expect(ev.risuChatParser("{{user}} {{char}} {{replace::aaa::a::$5}} {{range::[3]}} {{cbr::2}}")).toBe(
            'User Sel $5$5$5 ["0","1","2"] cbr::2cbr::2',
        );
        expect(ev.risuChatParser("{{#each [1,2] as x}}{{slot::x}}{{/each}}{{".repeat(3))).toBe("12{{12{{12{{");
        expect(now).not.toHaveBeenCalled();
    });
});

describe("the shared allowance (total)", () => {
    const share = (usage: CbsUsage, clock: ReturnType<typeof fakeClock>, maxMs = 15, userTick = 6) =>
        evaluator(
            { maxWork: 1_000_000, maxMs: 10, total: { usage, maxMs }, now: clock.now },
            {
                getUserName: () => {
                    clock.time += userTick;
                    return "U";
                },
            },
        );

    it("adds each top-level parse's time once, nested parses included, and refuses once it is spent", () => {
        const usage: CbsUsage = { usedMs: 0 };
        const clock = fakeClock();
        sel.desc = "{{user}}";
        const a = share(usage, clock);
        const b = share(usage, clock);
        // The nested `{{user}}` inside `{{description}}` counts once.
        expect(a.risuChatParser("{{description}}")).toBe("U");
        expect(usage.usedMs).toBe(6);
        expect(b.risuChatParser("{{user}}")).toBe("U");
        expect(usage.usedMs).toBe(12);
        // Three ms are left: the next parse starts and ends over the allowance (its time is counted).
        const over = limitError(() => a.risuChatParser("{{user}}"));
        expect(over.reason).toBe("total");
        expect(over.message).toBe("CBS limit reached: the templates took more than 15 ms in all");
        expect(usage.usedMs).toBe(18);
        // Spent: every evaluator sharing it refuses at the entry, before any scan.
        const userName = vi.fn(() => "U");
        const c = evaluator(
            { maxWork: 1_000_000, maxMs: 10, total: { usage, maxMs: 15 }, now: clock.now },
            { getUserName: userName },
        );
        expect(limitError(() => c.risuChatParser("{{user}}")).reason).toBe("total");
        expect(limitError(() => b.risuChatParser("ok")).reason).toBe("total");
        expect(userName).not.toHaveBeenCalled();
    });

    it("counts a parse that exceeded its own time limit, and leaves the rest of the allowance to the next one", () => {
        const usage: CbsUsage = { usedMs: 0 };
        const clock = fakeClock();
        const ev = share(usage, clock, 100, 11);
        expect(limitError(() => ev.risuChatParser("{{user}}")).reason).toBe("time");
        expect(usage.usedMs).toBe(11);
        expect(ev.risuChatParser("ok")).toBe("ok");
        expect(usage.usedMs).toBe(11);
    });

    it("takes the smaller of the parse's limit and what is left of the allowance as the deadline", () => {
        const usage: CbsUsage = { usedMs: 95 };
        const clock = fakeClock();
        // The parse's own limit is 10 ms, the allowance has 5 left: the 6 ms function crosses the allowance.
        const ev = share(usage, clock, 100, 6);
        expect(limitError(() => ev.risuChatParser("{{user}}")).reason).toBe("total");
    });
});

describe("the registry's charges", () => {
    it("range: a stuck or huge range ends with the work limit; a finite one answers as without limits", () => {
        for (const stuck of [
            "{{range::[0,1,0]}}",
            "{{range::[0,1,-1]}}",
            "{{range::[0,1e18]}}",
            "{{range::[1e300]}}",
        ]) {
            expect(limitError(() => bounded(100_000).risuChatParser(stuck)).reason, stuck).toBe("work");
        }
        const unbounded = evaluator(undefined);
        for (const fine of [
            "{{range::[5]}}",
            "{{range::[2,8,2]}}",
            "{{range::[3,1]}}",
            '{{range::[0,1,"x"]}}',
            "{{range::[]}}",
        ]) {
            expect(bounded(100_000).risuChatParser(fine), fine).toBe(unbounded.risuChatParser(fine));
        }
        expect(bounded(100_000).risuChatParser("{{range::[2,8,2]}}")).toBe('["2","4","6"]');
    });

    it("dice, roll and rollp: a unit per roll ends an endless roll", () => {
        // The test host has no `pickHashRand` (`rollp` needs one).
        const ev = evaluator({ maxWork: 100_000, maxMs: 1_000_000, now: () => 0 }, { pickHashRand: () => 0.5 });
        for (const text of ["{{dice::1000000000d6}}", "{{roll::1000000000d6}}", "{{rollp::1000000000d6}}"]) {
            expect(limitError(() => ev.risuChatParser(text)).reason, text).toBe("work");
        }
        expect(ev.risuChatParser("{{dice::3d1}}")).toBe("3");
        expect(ev.risuChatParser("{{roll::2d1}}")).toBe("2");
        expect(ev.risuChatParser("{{rollp::3d1}}")).toBe("3");
    });

    it("cbr: NaN, infinite, fractional, negative and text counts answer as without limits and poison nothing", () => {
        const unbounded = evaluator(undefined);
        const cases = [
            "{{cbr::NaN}}",
            "{{cbr::Infinity}}",
            "{{cbr::-Infinity}}",
            "{{cbr::2.7}}",
            "{{cbr::-3}}",
            "{{cbr::0}}",
            "{{cbr::abc}}",
            "{{cbr::3}}",
            "{{cbr}}",
        ];
        for (const text of cases) {
            expect(bounded(1000).risuChatParser(text), text).toBe(unbounded.risuChatParser(text));
        }
        // After a NaN count the stuck range still ends (the budget's count stays a number).
        expect(limitError(() => bounded(100_000).risuChatParser("{{cbr::NaN}}{{range::[0,1,0]}}")).reason).toBe("work");
        // A huge repetition is refused before `repeat` runs: the one intended difference from the
        // unbounded evaluator, which lets `repeat` throw and leaves the literal text.
        expect(limitError(() => bounded(1000).risuChatParser("{{cbr::100000}}")).reason).toBe("work");
        expect(limitError(() => bounded(100_000).risuChatParser("{{cbr::1e9}}")).reason).toBe("work");
        expect(unbounded.risuChatParser("{{cbr::1e9}}")).toBe("{{cbr::1e9}}");
    });

    it("replace: the bound follows the replacement's tokens (a literal $5 is cheap), and a missing replacement is charged as the text undefined", () => {
        const unbounded = evaluator(undefined);
        const cases = [
            "{{replace::aaaa::a::$5}}",
            "{{replace::aaaa::a::$$}}",
            "{{replace::abab::a::[$&]}}",
            "{{replace::abc::b::$`}}",
            "{{replace::abc::b::$'}}",
            "{{replace::abc::b::$<x>}}",
            "{{replace::aaa::a}}",
            "{{replace::aaa}}",
            "{{replace::abc::::-}}",
            "{{replace::a::b::c}}",
        ];
        for (const text of cases) {
            expect(bounded(1000).risuChatParser(text), text).toBe(unbounded.risuChatParser(text));
        }
        expect(bounded(1000).risuChatParser("{{replace::aaaa::a::$5}}")).toBe("$5$5$5$5");
        expect(bounded(1000).risuChatParser("{{replace::aaa::a}}")).toBe("undefinedundefinedundefined");
        // The ninefold amplification of a missing replacement is charged before the allocation.
        const text = `{{replace::${"a".repeat(100)}::a}}`;
        expect(limitError(() => bounded(500).risuChatParser(text)).reason).toBe("work");
        expect(bounded(3000).risuChatParser(text)).toBe("undefined".repeat(100));
    });

    it("replaceAllBound never underestimates replaceAll's result", () => {
        const texts = ["", "a", "aaaa", "abcabc", "a$b", "x", "ab\u0000ab"];
        const patterns = ["", "a", "b", "ab", "$", "zz"];
        const replacements = ["", "$", "$$", "$&", "$`", "$'", "$5", "$<n>", "[$&]", "xx", "$$$&$'"];
        for (const text of texts) {
            for (const pattern of patterns) {
                for (const replacement of replacements) {
                    const actual = text.replaceAll(pattern, replacement).length;
                    expect(
                        replaceAllBound(text, pattern, replacement),
                        JSON.stringify([text, pattern, replacement]),
                    ).toBeGreaterThanOrEqual(actual);
                }
            }
        }
        // Without a contextual token it is the text plus the replacements (the matches are not subtracted).
        expect(replaceAllBound("aaaa", "a", "$5")).toBe(4 + 4 * 2);
        expect(replaceAllBound("aaaa", "a", "$$")).toBe(4 + 4 * 2);
        expect(replaceAllBound("aaaa", "a", "$&")).toBe(4 + 4 * 3);
        expect(replaceAllBound("abc", "b", "$`")).toBe(3 + 2 + 3);
        expect(replaceAllBound("abc", "z", "long")).toBe(3);
        expect(replaceAllBound("abc", "", "-")).toBe(3 + 4);
    });

    it("join: the separators are charged; the result answers as without limits", () => {
        const unbounded = evaluator(undefined);
        const list = JSON.stringify(Array(100).fill("a"));
        for (const text of [`{{join::${list}::-}}`, `{{join::${list}}}`, `{{join::${list}::}}`, "{{join::a§b§c::+}}"]) {
            expect(bounded(5000).risuChatParser(text), text).toBe(unbounded.risuChatParser(text));
        }
        // 100 elements with a 10-character separator: the separators alone exceed what is left.
        const text = `{{join::${list}::${"-".repeat(10)}}}`;
        expect(limitError(() => bounded(text.length + 200).risuChatParser(text)).reason).toBe("work");
    });

    it("filter: each search is charged by how far it went, so a list of duplicates is cheap and a long distinct list is not", () => {
        const unbounded = evaluator(undefined);
        const duplicates = `{{filter::${JSON.stringify(Array(2000).fill("apple"))}::unique}}`;
        const distinct = `{{filter::${JSON.stringify(Array.from({ length: 2000 }, (_, i) => `v${i}`))}::unique}}`;
        expect(bounded(25_000).risuChatParser(duplicates)).toBe('["apple"]');
        expect(limitError(() => bounded(25_000).risuChatParser(distinct)).reason).toBe("work");
        expect(bounded(100_000).risuChatParser(distinct)).toBe(unbounded.risuChatParser(distinct));
        for (const mode of ["", "::all", "::unique", "::nonempty"]) {
            const text = `{{filter::["a","","b","a",1,1,null,"a"]${mode}}}`;
            expect(bounded(1000).risuChatParser(text), text).toBe(unbounded.risuChatParser(text));
        }
    });

    it("#each: every iteration is charged, an empty body included, and the result is as without limits", () => {
        const unbounded = evaluator(undefined);
        const empty = `{{#each ${JSON.stringify(Array(3000).fill(1))} as x}}{{/each}}`;
        expect(unbounded.risuChatParser(empty)).toBe("");
        expect(bounded(12_000).risuChatParser(empty)).toBe("");
        // The text alone fits (6,025 characters); the 3,000 iterations do not.
        expect(limitError(() => bounded(7000).risuChatParser(empty)).reason).toBe("work");
        const cases = [
            "{{#each [1,2,3] as x}}<{{slot::x}}>{{/each}}",
            "{{#each::keep [1,2] as x}}\n {{slot::x}} \n{{/each}}",
            '{{#each ["a$5","b$&"] as x}}{{slot::x}}|{{/each}}',
            '{{#each [{"k":1},[2],null,true] as x}}{{slot::x}};{{/each}}',
            "{{#each a§b§c as x}}{{slot::x}}{{/each}}",
            "{{#each [1,2] x}}{{slot::x}}{{/each}}",
        ];
        for (const text of cases) {
            expect(bounded(1000).risuChatParser(text), text).toBe(unbounded.risuChatParser(text));
        }
        // A body that grows the text past the limit is refused.
        const growing = `{{#each ${JSON.stringify(Array(50).fill("x"))} as x}}${"y".repeat(100)}{{/each}}`;
        expect(limitError(() => bounded(2000).risuChatParser(growing)).reason).toBe("work");
        expect(bounded(50_000).risuChatParser(growing)).toBe("y".repeat(5000));
    });

    it("#pure_display: the escaped block is charged, and a result longer than the limit is refused", () => {
        const text = "{{#pure_display}}" + "{{x}}".repeat(12) + "{{/pure_display}}";
        expect(text.length).toBeLessThanOrEqual(100);
        expect(evaluator(undefined).risuChatParser(text)).toBe("\\{\\{x\\}\\}".repeat(12));
        expect(bounded(200).risuChatParser(text)).toBe("\\{\\{x\\}\\}".repeat(12));
        expect(limitError(() => bounded(100).risuChatParser(text)).reason).toBe("work");
    });

    it("the unfinished-syntax drain: unmatched {{ are charged and the literal result is as without limits", () => {
        const text = "{{".repeat(300) + "tail";
        expect(evaluator(undefined).risuChatParser(text)).toBe(text);
        expect(bounded(2000).risuChatParser(text)).toBe(text);
        // The scan fits (604 characters), the drain's steps do not.
        expect(limitError(() => bounded(650).risuChatParser(text)).reason).toBe("work");
        const mixed = "a{{b{{c}}d";
        expect(bounded(1000).risuChatParser(mixed)).toBe(evaluator(undefined).risuChatParser(mixed));
    });

    it("the calculator and the history read go through the same budget", () => {
        // The fixture's chat is a read-only mirror type; the test writes it directly.
        const chat = sel.chats[0] as unknown as { scriptstate: object; message: unknown[]; fmIndex?: number };
        chat.scriptstate = { $hp: "7" };
        expect(bounded(1000).risuChatParser("{{? $hp*2}} {{calc::1+2}}")).toBe("14 3");
        // A history over the bound: the nested message parses are charged.
        chat.message = Array.from({ length: 20 }, (_, i) => ({
            role: "user",
            data: "m".repeat(100) + i,
            chatId: `h${i}`,
        }));
        chat.fmIndex = -1;
        expect(limitError(() => bounded(1500).risuChatParser("{{history}}")).reason).toBe("work");
        expect(bounded(100_000).risuChatParser("{{history::role}}")).toBe(
            evaluator(undefined).risuChatParser("{{history::role}}"),
        );
    });
});

describe("the browser path keeps its results", () => {
    const resolveArg = (entry: ParityCase): CbsParseArg => {
        const { charaId, ...rest } = entry.arg ?? {};
        const arg: CbsParseArg = { ...rest };
        if (charaId) {
            arg.chara = db.characters.find((candidate) => candidate.chaId === charaId) as character | groupChat;
        }
        return arg;
    };

    it("answers every host-parity case under the server's limits as the fixture expects", () => {
        vi.useFakeTimers({ now: new Date(parity.fixedTime), toFake: ["Date"] });
        const previousTz = process.env.TZ;
        process.env.TZ = "UTC";
        try {
            let triggerId: string | null = null;
            const host = createNodeCbsHost(db, {
                selectedCharID: parity.selectedCharID,
                viewport: parity.viewport,
                browserLanguage: parity.browserLanguage,
                triggerId: () => triggerId,
            });
            const usage: CbsUsage = { usedMs: 0 };
            const ev = createCbsEvaluator({ ...host, limits: serverCbsLimits(usage) });
            for (const entry of parity.cases as ParityCase[]) {
                triggerId = entry.triggerId ?? null;
                expect(ev.risuChatParser(entry.input, resolveArg(entry)), entry.name).toBe(entry.expected);
            }
            expect(usage.usedMs).toBeGreaterThan(0);
        } finally {
            vi.useRealTimers();
            if (previousTz === undefined) {
                delete process.env.TZ;
            } else {
                process.env.TZ = previousTz;
            }
        }
    });

    it("trims the blank lines of a #when block as before: else, keep, CRLF, all-blank, inline and empty cases", () => {
        const cases: [string, string][] = [
            ["{{#when 1}}\n\n  a  \n\n{{/when}}", "  a  "],
            ["{{#when 1}}\n\n\n{{/when}}", ""],
            ["{{#when 1}}\r\n\r\n a \r\n\r\n{{/when}}", " a \r"],
            ["{{#when 1}}a{{:else}}b{{/when}}", "a"],
            ["{{#when 0}}a{{:else}}b{{/when}}", "b"],
            ["{{#when 1}}\n\na\n{{:else}}\n\nb\n\n{{/when}}", "a"],
            ["{{#when 0}}\n\na\n{{:else}}\n\nb\n\n{{/when}}", "b"],
            ["{{#when::keep::1}}\n\n a \n\n{{/when}}", "\n\n a \n\n"],
            ["{{#when::1::keep}}\n\n a \n\n{{/when}}", ""],
            ["{{#when 0}}\n\n a \n\n{{/when}}", ""],
            ["x{{#when 1}}\n \n\t\n{{/when}}y", "xy"],
            ["{{#when 1}}{{/when}}", ""],
            ["{{#when 1}}\n{{/when}}", ""],
            ["{{#when 1}}\n\n{{:else}}\n\n{{/when}}", ""],
            ["{{#when 0}}\n\n{{:else}}\n\n{{/when}}", ""],
        ];
        const unbounded = evaluator(undefined);
        const limited = bounded(100_000);
        for (const [input, expected] of cases) {
            expect(unbounded.risuChatParser(input), JSON.stringify(input)).toBe(expected);
            expect(limited.risuChatParser(input), JSON.stringify(input)).toBe(expected);
        }
    });

    it("answers the coercion cases of the charged functions as the unbounded evaluator", () => {
        const unbounded = evaluator(undefined);
        const limited = bounded(100_000);
        const cases = [
            '{{range::[0,1,"x"]}}',
            '{{range::["a"]}}',
            "{{range::x}}",
            "{{dice::xd6}}",
            "{{dice::0d6}}",
            "{{roll::0d6}}",
            "{{roll::xd6}}",
            "{{cbr::1.9}}",
            "{{cbr::0.5}}",
            "{{replace::a.b::.::-}}",
            "{{replace::a::::X}}",
            "{{join::notjson}}",
            '{{join::[1,null,true,{"a":1}]::,}}',
            "{{filter::notjson::unique}}",
            "{{filter::[]::unique}}",
            "{{bkspc}}",
            "{{erase}}",
            "a b{{bkspc}}c",
            "hello{{erase::2}}",
            "{{#pure_display}}{{user}} {{/pure_display}}",
            "{{#each [] as x}}never{{/each}}end",
            "{{#each [1] as x}}{{slot::y}}{{/each}}",
        ];
        for (const text of cases) {
            expect(limited.risuChatParser(text), text).toBe(unbounded.risuChatParser(text));
        }
    });
});

describe("runaway templates end (in a child process, so a broken limit cannot hang the run)", () => {
    let dir = "";
    afterAll(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /** Evaluates `text` under the server's limits in a fresh Node process; the error or the result length. */
    function probe(text: string): { error?: string; reason?: string; length?: number; ms: number } {
        dir ||= mkdtempSync(path.join(os.tmpdir(), "risu-cbs-limits-"));
        const script = path.join(dir, "probe.mts");
        const toImport = (file: string) => JSON.stringify(path.join(REPO_ROOT, file));
        writeFileSync(
            script,
            [
                `import { readFileSync } from "node:fs";`,
                `import { createCbsEvaluator } from ${toImport("shared/cbs/evaluator.ts")};`,
                `import { serverCbsLimits } from ${toImport("server/src/jobs/cbsHost.ts")};`,
                `import { createNodeCbsHost } from ${toImport("server/src/tests/cbsHost.ts")};`,
                `console.log = () => {};`,
                `const db = JSON.parse(readFileSync(${toImport("server/src/tests/fixtures/cbs-parity.json")}, "utf8")).database;`,
                `const ev = createCbsEvaluator({ ...createNodeCbsHost(db, { selectedCharID: 0 }), limits: serverCbsLimits({ usedMs: 0 }) });`,
                `const text = readFileSync(process.argv[2], "utf8");`,
                `const started = performance.now();`,
                `let out;`,
                `try { out = { length: ev.risuChatParser(text).length }; } catch (e) { out = { error: e.message, reason: e.reason }; }`,
                `process.stdout.write(JSON.stringify({ ...out, ms: performance.now() - started }));`,
            ].join("\n"),
        );
        const input = path.join(dir, "input.txt");
        writeFileSync(input, text);
        const run = spawnSync(process.execPath, [script, input], { encoding: "utf8", timeout: 60_000 });
        if (run.error) {
            throw run.error;
        }
        expect(run.status, run.stderr).toBe(0);
        return JSON.parse(run.stdout);
    }

    it("the stuck range, an endless roll, a huge repetition, a deep nesting and a quadratic filter all end with the limit error", () => {
        const cases: [string, RegExp][] = [
            ["{{range::[0,1,0]}}", /more than 10000000 steps/],
            ["{{range::[5000000]}}", /more than 10000000 steps/],
            ["{{dice::100000000d6}}", /more than 10000000 steps/],
            ["{{cbr::10000000}}", /more than 10000000 steps/],
            [`{{replace::${"a".repeat(20_000)}::a::${"b".repeat(5000)}}}`, /more than 10000000 steps/],
            ["{{".repeat(2_000_000), /more than 10000000 steps/],
            [
                `{{filter::${JSON.stringify(Array.from({ length: 200_000 }, (_, i) => `v${i}`))}::unique}}`,
                /more than 10000000 steps/,
            ],
            [
                `{{#each ${JSON.stringify(Array(20_000).fill("x"))} as x}}${"y".repeat(1000)}{{/each}}`,
                /more than 10000000 steps/,
            ],
        ];
        for (const [text, message] of cases) {
            const result = probe(text);
            expect(result.error, text.slice(0, 40)).toMatch(message);
            expect(result.reason, text.slice(0, 40)).toBe("work");
            // Cooperative, not instant: well inside the 5 s wall limit all the same.
            expect(result.ms, text.slice(0, 40)).toBeLessThan(SERVER_CBS_MAX_MS);
        }
    }, 120_000);

    it("an ordinary large text passes under the server's limits", () => {
        const result = probe("{{char}} ".repeat(100_000) + "x".repeat(SERVER_CBS_MAX_WORK / 4));
        expect(result.error).toBeUndefined();
        expect(result.length).toBe("Sel ".length * 100_000 + SERVER_CBS_MAX_WORK / 4);
    }, 120_000);
});
