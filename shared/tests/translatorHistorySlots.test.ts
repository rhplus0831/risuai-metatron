// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Message, MessageTranslation } from "../database.ts";
import { translationSourceHash } from "../translation/hash.ts";
import { stripTranslatorReasoning } from "../translation/pipeline.ts";
import {
    buildTranslatorHistory,
    collectTranslatorHistory,
    DEFAULT_TRANSLATOR_HISTORY_MAX_TOKENS,
    TRANSLATOR_HISTORY_MAX_COUNT,
    translatorHistoryBlock,
    translatorHistoryCount,
    translatorHistoryMaxTokens,
} from "../translation/historySlots.ts";

// `docs/plan/translation.md` slice 3.3: the pure rules of the history slots. The count of a slot
// (all digits, 1 to 50), the budget in use (a finite number above 0, else 2048), the walk back from
// the row before the message (`allBefore` ends it before the comment skip, disabled and comment rows
// are skipped, the raw `data` and the fresh stored translation are taken), the block of an entry,
// and the build: per count the newest N entries, each entry's two blocks counted once (the empty
// translation block included), the oldest whole entries dropped while the sum passes the budget.

const fresh = (text: string, source: string, extra: Partial<MessageTranslation> = {}): MessageTranslation => ({
    text,
    sourceHash: translationSourceHash(source),
    targetLanguage: "ko",
    translatedAt: 1,
    ...extra,
});
const msg = (data: string, role: Message["role"] = "user", extra: Partial<Message> = {}): Message => ({
    role,
    data,
    chatId: data,
    ...extra,
});
const bodies = (text: string) => text.split("\n\n---\n\n").filter((part) => part !== "");

describe("translatorHistoryCount", () => {
    it("accepts all-digit counts from 1 to 50, leading zeros included, and nothing else", () => {
        expect(TRANSLATOR_HISTORY_MAX_COUNT).toBe(50);
        expect(translatorHistoryCount("1")).toBe(1);
        expect(translatorHistoryCount("50")).toBe(50);
        expect(translatorHistoryCount("05")).toBe(5);
        expect(translatorHistoryCount("007")).toBe(7);
        expect(translatorHistoryCount("050")).toBe(50);
        for (const raw of ["0", "00", "51", "999", "", " ", " 5", "5 ", "abc", "1.5", "-1", "+1", "1e1", "１", "5\n"]) {
            expect(translatorHistoryCount(raw), JSON.stringify(raw)).toBeNull();
        }
    });
});

describe("translatorHistoryMaxTokens", () => {
    it("keeps a finite number above 0 exactly, fractions included, and reads anything else as 2048", () => {
        expect(DEFAULT_TRANSLATOR_HISTORY_MAX_TOKENS).toBe(2048);
        for (const value of [1, 0.5, 0.0001, 100.25, 2048, 1e9]) {
            expect(translatorHistoryMaxTokens(value), String(value)).toBe(value);
        }
        for (const value of [undefined, null, "100", true, 0, -0, -1, -0.5, Number.NaN, Infinity, -Infinity, {}, []]) {
            expect(translatorHistoryMaxTokens(value), String(value)).toBe(2048);
        }
    });
});

describe("collectTranslatorHistory", () => {
    const messages: Message[] = [
        msg("m0"),
        msg("cut", "char", { disabled: "allBefore" }),
        msg("comment", "char", { isComment: true }),
        msg("off", "char", { disabled: true }),
        msg("hello", "user", { translation: fresh("안녕", "hello") }),
        msg("world {{char}} {{slot::content}}", "char"),
        msg("target", "char"),
        msg("later", "user"),
    ];

    it("walks back from the row before the message, skips disabled and comment rows, stops before an allBefore row, and returns the entries oldest first", () => {
        expect(collectTranslatorHistory(messages, 6, 10)).toEqual([
            { role: "user", source: "hello", translated: "안녕" },
            { role: "char", source: "world {{char}} {{slot::content}}" },
        ]);
        // The newest N: the count cuts the walk, not the result.
        expect(collectTranslatorHistory(messages, 6, 1)).toEqual([
            { role: "char", source: "world {{char}} {{slot::content}}" },
        ]);
        // The target and the rows after it are not history; a later message sees the target as history.
        expect(collectTranslatorHistory(messages, 7, 10).map((entry) => entry.source)).toEqual([
            "hello",
            "world {{char}} {{slot::content}}",
            "target",
        ]);
        // Nothing before the first row, a count of 0, or an index the walk cannot start from.
        expect(collectTranslatorHistory(messages, 0, 10)).toEqual([]);
        expect(collectTranslatorHistory(messages, 6, 0)).toEqual([]);
        expect(collectTranslatorHistory(messages, -1, 10)).toEqual([]);
        expect(collectTranslatorHistory([], 0, 10)).toEqual([]);
        // An index past the end walks from the last row.
        expect(collectTranslatorHistory(messages.slice(4, 6), 99, 10).map((entry) => entry.source)).toEqual([
            "hello",
            "world {{char}} {{slot::content}}",
        ]);
    });

    it("stops at an allBefore row that is also a comment, and takes neither it nor a skipped row", () => {
        const both: Message[] = [
            msg("a"),
            msg("b", "char", { disabled: "allBefore", isComment: true }),
            msg("c"),
            msg("t"),
        ];
        expect(collectTranslatorHistory(both, 3, 10).map((entry) => entry.source)).toEqual(["c"]);
        const skipped: Message[] = [
            msg("a"),
            msg("b", "char", { isComment: true }),
            msg("c", "char", { disabled: true }),
            msg("t"),
        ];
        expect(collectTranslatorHistory(skipped, 3, 10).map((entry) => entry.source)).toEqual(["a"]);
        // `disabled: false` is an ordinary row.
        expect(collectTranslatorHistory([msg("a", "user", { disabled: false }), msg("t")], 1, 10)).toEqual([
            { role: "user", source: "a" },
        ]);
    });

    it("takes the fresh stored translation only: an empty one is kept, a stale, malformed, or missing one is absent, whatever its language or preset", () => {
        const rows: Message[] = [
            msg("missing"),
            msg("empty", "char", { translation: fresh("", "empty") }),
            msg("stale", "user", { translation: fresh("오래된", "old text") }),
            msg("malformed", "char", { translation: { text: "x" } as unknown as MessageTranslation }),
            msg("edited", "user", {
                translation: fresh("고침", "edited", { edited: true, presetId: "gone", targetLanguage: "ja" }),
            }),
            msg("t"),
        ];
        const entries = collectTranslatorHistory(rows, 5, 10);
        expect(entries).toEqual([
            { role: "user", source: "missing" },
            { role: "char", source: "empty", translated: "" },
            { role: "user", source: "stale" },
            { role: "char", source: "malformed" },
            { role: "user", source: "edited", translated: "고침" },
        ]);
        for (const index of [0, 2, 3]) {
            expect(Object.hasOwn(entries[index], "translated"), entries[index].source).toBe(false);
        }
        expect(Object.hasOwn(entries[1], "translated")).toBe(true);
    });
});

describe("translatorHistoryBlock", () => {
    it("is the role, a colon and a space, the body, and the separator", () => {
        expect(translatorHistoryBlock("user", "hi")).toBe("user: hi\n\n---\n\n");
        expect(translatorHistoryBlock("char", "")).toBe("char: \n\n---\n\n");
        expect(translatorHistoryBlock("char", "two\n\nlines")).toBe(
            "char: two\n\n---\n\n".replace("two", "two\n\nlines"),
        );
    });
});

describe("buildTranslatorHistory", () => {
    const length = vi.fn(async (text: string) => text.length);
    const rows: Message[] = [msg("aa", "user", { translation: fresh("bb", "aa") }), msg("cccc", "char"), msg("t")];
    // user "aa" with "bb": 15 + 15; char "cccc" without a translation: 17 + 13 (the empty block).
    const COSTS = { aa: 30, cccc: 30 };

    it("renders the same entries in both slots, an empty block for an entry without a translation, and counts each block once, one after another", async () => {
        length.mockClear();
        let inFlight = 0;
        const sequential = vi.fn(async (text: string) => {
            expect(inFlight).toBe(0);
            inFlight++;
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight--;
            return text.length;
        });
        const history = await buildTranslatorHistory({
            messages: rows,
            messageIndex: 2,
            counts: [10],
            maxTokens: 2048,
            countTokens: sequential,
        });
        expect(history("history", 10)).toBe("user: aa\n\n---\n\nchar: cccc\n\n---\n\n");
        expect(history("historytrans", 10)).toBe("user: bb\n\n---\n\nchar: \n\n---\n\n");
        expect(sequential.mock.calls.map(([text]) => text)).toEqual([
            "user: aa\n\n---\n\n",
            "user: bb\n\n---\n\n",
            "char: cccc\n\n---\n\n",
            "char: \n\n---\n\n",
        ]);
        // A count it was not built for is empty.
        expect(history("history", 2)).toBe("");
        expect(history("historytrans", 1)).toBe("");
    });

    it("charges both blocks of an entry, keeps a sum equal to the budget, drops the oldest whole entries first, and leaves the slot empty when the newest entry alone passes it", async () => {
        const build = (maxTokens: unknown) =>
            buildTranslatorHistory({ messages: rows, messageIndex: 2, counts: [10], maxTokens, countTokens: length });
        const exact = await build(COSTS.aa + COSTS.cccc);
        expect(bodies(exact("history", 10))).toEqual(["user: aa", "char: cccc"]);
        const oneShort = await build(COSTS.aa + COSTS.cccc - 1);
        expect(bodies(oneShort("history", 10))).toEqual(["char: cccc"]);
        expect(bodies(oneShort("historytrans", 10))).toEqual(["char: "]);
        // The empty translation block counts: without it the second entry would fit in 17.
        const justSource = await build(17);
        expect(justSource("history", 10)).toBe("");
        expect(justSource("historytrans", 10)).toBe("");
        const newestAlone = await build(COSTS.cccc);
        expect(bodies(newestAlone("history", 10))).toEqual(["char: cccc"]);
    });

    it("builds every distinct valid count from one collection of the largest, trimming each to the budget on its own", async () => {
        const five: Message[] = [msg("e1"), msg("e2"), msg("e3"), msg("e4"), msg("e5"), msg("t")];
        const ten = vi.fn(async () => 5);
        const history = await buildTranslatorHistory({
            messages: five,
            messageIndex: 5,
            counts: [2, 5, 3, 2, 0, 51, 1.5, Number.NaN],
            maxTokens: 25,
            countTokens: ten,
        });
        // Five entries, two blocks each, counted once for every count together.
        expect(ten).toHaveBeenCalledTimes(10);
        expect(bodies(history("history", 2))).toEqual(["user: e4", "user: e5"]);
        expect(bodies(history("history", 5))).toEqual(["user: e4", "user: e5"]);
        expect(bodies(history("history", 3))).toEqual(["user: e4", "user: e5"]);
        for (const count of [0, 1, 4, 51]) {
            expect(history("history", count), String(count)).toBe("");
            expect(history("historytrans", count), String(count)).toBe("");
        }
        // Only the newest N are collected and counted when every count is small.
        ten.mockClear();
        const one = await buildTranslatorHistory({
            messages: five,
            messageIndex: 5,
            counts: [1],
            maxTokens: 25,
            countTokens: ten,
        });
        expect(ten).toHaveBeenCalledTimes(2);
        expect(bodies(one("history", 1))).toEqual(["user: e5"]);
    });

    it("counts nothing and renders nothing without a valid count", async () => {
        const never = vi.fn(async () => 1);
        for (const counts of [[], [0], [51, 1.5, Number.NaN, -1]]) {
            const history = await buildTranslatorHistory({
                messages: rows,
                messageIndex: 2,
                counts,
                maxTokens: 2048,
                countTokens: never,
            });
            expect(history("history", 10), JSON.stringify(counts)).toBe("");
            expect(history("historytrans", 1), JSON.stringify(counts)).toBe("");
        }
        expect(never).not.toHaveBeenCalled();
    });

    it("reads an invalid budget as 2048", async () => {
        const big: Message[] = [msg("x".repeat(2000), "user"), msg("y".repeat(100), "char"), msg("t")];
        for (const maxTokens of [undefined, null, 0, -5, Number.NaN, "big", Infinity]) {
            const history = await buildTranslatorHistory({
                messages: big,
                messageIndex: 2,
                counts: [10],
                maxTokens,
                countTokens: length,
            });
            // 2013 + 13 + 113 + 13 = 2152 > 2048: the oldest entry goes; the newest (126) stays.
            expect(bodies(history("history", 10)), String(maxTokens)).toEqual([`char: ${"y".repeat(100)}`]);
        }
        const kept = await buildTranslatorHistory({
            messages: big,
            messageIndex: 2,
            counts: [10],
            maxTokens: 2152,
            countTokens: length,
        });
        expect(bodies(kept("history", 10))).toHaveLength(2);
    });

    it("ends the build on the first counting error, without counting further", async () => {
        const failing = vi.fn(async (text: string) => {
            if (text.startsWith("user: bb")) {
                throw new Error("tokenizer down");
            }
            return text.length;
        });
        await expect(
            buildTranslatorHistory({
                messages: rows,
                messageIndex: 2,
                counts: [10],
                maxTokens: 2048,
                countTokens: failing,
            }),
        ).rejects.toThrow("tokenizer down");
        expect(failing).toHaveBeenCalledTimes(2);
    });
});

// `docs/plan/translation.md` slice 3.4: `transformText` (Exclude Chain-of-Thought) is applied by
// the collector to each entry's source and fresh translation, once each, after the freshness check
// on the stored text; the build forwards it, so the blocks are rendered and counted as transformed.
describe("transformText", () => {
    const rows: Message[] = [
        msg("hello <think>h</think>", "user", {
            translation: fresh("안녕 <think>t</think>", "hello <think>h</think>"),
        }),
        msg("<think>only</think>", "char"),
        // A translation hashed on the stripped text: stale, since freshness is the stored text's.
        msg("<think>s</think>stale", "user", { translation: fresh("오래", "stale") }),
        msg("e", "char", { translation: fresh("", "e") }),
        msg("t"),
    ];

    it("collectTranslatorHistory applies it to each source and fresh translation once, after the freshness check: a translation of the stripped text is stale, an entry left empty is kept", () => {
        const strip = vi.fn(stripTranslatorReasoning);
        expect(collectTranslatorHistory(rows, 4, 10, strip)).toEqual([
            { role: "user", source: "hello", translated: "안녕" },
            { role: "char", source: "" },
            { role: "user", source: "stale" },
            { role: "char", source: "e", translated: "" },
        ]);
        expect(strip.mock.calls.map(([text]) => text).sort()).toEqual(
            [
                "hello <think>h</think>",
                "안녕 <think>t</think>",
                "<think>only</think>",
                "<think>s</think>stale",
                "e",
                "",
            ].sort(),
        );
        // Without it, the texts as stored.
        expect(collectTranslatorHistory(rows, 4, 10).map((entry) => entry.source)).toEqual([
            "hello <think>h</think>",
            "<think>only</think>",
            "<think>s</think>stale",
            "e",
        ]);
    });

    it("buildTranslatorHistory hands it to the collection, so the blocks are rendered and counted as transformed", async () => {
        const length = vi.fn(async (text: string) => text.length);
        const two: Message[] = [
            msg("aa <think>x</think>", "user", { translation: fresh("bb <think>y</think>", "aa <think>x</think>") }),
            msg("<think>c</think>cccc", "char"),
            msg("t"),
        ];
        const build = (maxTokens: number, transformText?: (text: string) => string) =>
            buildTranslatorHistory({
                messages: two,
                messageIndex: 2,
                counts: [10],
                maxTokens,
                countTokens: length,
                transformText,
            });
        // The stripped blocks cost 15 + 15 and 17 + 13: a budget of 60 keeps both entries.
        const both = await build(60, stripTranslatorReasoning);
        expect(both("history", 10)).toBe("user: aa\n\n---\n\nchar: cccc\n\n---\n\n");
        expect(both("historytrans", 10)).toBe("user: bb\n\n---\n\nchar: \n\n---\n\n");
        expect(length.mock.calls.map(([text]) => text)).toEqual([
            "user: aa\n\n---\n\n",
            "user: bb\n\n---\n\n",
            "char: cccc\n\n---\n\n",
            "char: \n\n---\n\n",
        ]);
        const oneShort = await build(59, stripTranslatorReasoning);
        expect(bodies(oneShort("history", 10))).toEqual(["char: cccc"]);
        // Without it the stored blocks (32 + 32 and 33 + 13) are what is counted: 60 keeps the newest alone.
        const raw = await build(60);
        expect(bodies(raw("history", 10))).toEqual(["char: <think>c</think>cccc"]);
    });
});
