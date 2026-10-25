import { describe, expect, it } from "vitest";
import type { Message } from "./database.ts";
import {
    type ContextReport,
    displacement,
    eligibleHistory,
    fixedShare,
    historyDigest,
    parseContextReport,
    turnCount,
} from "./contextReport.ts";

// The context report's reader side (`shared/contextReport.ts`): what `parseContextReport` accepts
// and refuses, the history digest's sensitivity, and the pure meter helpers. The server's writer is
// covered by `server/src/tests/assemble.test.ts`.

/** A complete valid report with every optional part; tests change one field at a time. */
function report(): ContextReport {
    return {
        v: 1,
        maxContext: 1000,
        maxResponse: 100,
        input: 640,
        sections: [
            { kind: "main", tokens: 200 },
            { kind: "description", tokens: 100 },
            { kind: "memory", tokens: 40 },
            { kind: "history", tokens: 300 },
        ],
        adjustment: -5,
        attributionExact: true,
        history: { total: 12, kept: 8, totalUser: 6, keptUser: 4, droppedTokens: 150 },
        trim: {
            headroom: 20,
            queue: [
                { tokens: 15, kind: "example", user: false },
                { tokens: 21, kind: "marker", user: false },
                { tokens: 30, kind: "message", user: true },
                { tokens: 25, kind: "message", user: false },
            ],
            replyPrefix: { messageId: "m9", tokens: 12 },
            perMessage: 3,
        },
        memory: { kind: "hypaV3", tokens: 40, budget: 200, coverage: "gap" },
        lore: { budgetUsed: 50, budget: 400, rejectedCount: 1, rejectedTokens: 30, active: 2 },
        tokenScope: '["gpt4o","","",false,"o200k",null,"none"]',
        historyDigest: "abc123",
    };
}

/** `report()` with `change` applied to a JSON copy (the stored form). */
function changed(change: (copy: Record<string, any>) => void): unknown {
    const copy = JSON.parse(JSON.stringify(report())) as Record<string, any>;
    change(copy);
    return copy;
}

const message = (chatId: string, role: Message["role"], data: string, disabled?: Message["disabled"]): Message => ({
    chatId,
    role,
    data,
    ...(disabled === undefined ? {} : { disabled }),
});

describe("parseContextReport", () => {
    it("accepts a stored report as written, with or without its optional parts", () => {
        const stored = JSON.parse(JSON.stringify(report()));
        expect(parseContextReport(stored)).toBe(stored);
        expect(parseContextReport(stored)).toEqual(report());
        const minimal = changed((copy) => {
            delete copy.trim;
            delete copy.memory;
        });
        expect(parseContextReport(minimal)).toBe(minimal);
        expect(parseContextReport(changed((copy) => delete copy.trim.replyPrefix))).not.toBeNull();
        expect(parseContextReport(changed((copy) => delete copy.memory.budget))).not.toBeNull();
        // Only `adjustment` is signed.
        expect(parseContextReport(changed((copy) => (copy.adjustment = -640)))).not.toBeNull();
        expect(parseContextReport(changed((copy) => (copy.sections = [])))).not.toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.queue = [])))).not.toBeNull();
    });

    it("reads old data, other shapes, and bad numbers as no report", () => {
        expect(parseContextReport(undefined)).toBeNull();
        expect(parseContextReport(null)).toBeNull();
        expect(parseContextReport("report")).toBeNull();
        expect(parseContextReport([])).toBeNull();
        expect(parseContextReport({})).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.v = 2)))).toBeNull();
        expect(parseContextReport(changed((copy) => delete copy.history))).toBeNull();
        expect(parseContextReport(changed((copy) => delete copy.lore))).toBeNull();
        expect(parseContextReport(changed((copy) => delete copy.historyDigest))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.tokenScope = 7)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.attributionExact = "yes")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.input = "640")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.maxContext = null)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.history.kept = -1)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.lore.budget = -1)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.headroom = -1)))).toBeNull();
        expect(parseContextReport(changed((copy) => delete copy.trim.perMessage))).toBeNull();
        // Non-finite numbers do not survive JSON; a live object can still carry them.
        const live = report();
        live.input = Number.NaN;
        expect(parseContextReport(live)).toBeNull();
        const infinite = report();
        infinite.history.droppedTokens = Number.POSITIVE_INFINITY;
        expect(parseContextReport(infinite)).toBeNull();
    });

    it("refuses bad sections: an unknown kind, a repeated kind, a negative count, a hole", () => {
        expect(parseContextReport(changed((copy) => (copy.sections[0].kind = "footer")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.sections[1].kind = "main")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.sections[0].tokens = -1)))).toBeNull();
        expect(parseContextReport(changed((copy) => copy.sections.push({ kind: "history" })))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.sections = {})))).toBeNull();
        const sparse = report() as unknown as { sections: unknown[] };
        sparse.sections = [{ kind: "main", tokens: 1 }, , { kind: "plain", tokens: 2 }];
        expect(parseContextReport(sparse)).toBeNull();
    });

    it("refuses a bad trim ledger, reply prefix, or memory block", () => {
        expect(parseContextReport(changed((copy) => (copy.trim = null)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.queue = "none")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.queue[0].kind = "greeting")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.queue[0].user = 1)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.queue[2].tokens = -30)))).toBeNull();
        expect(
            parseContextReport(
                changed((copy) => {
                    copy.trim.queue = Array.from({ length: 9 }, () => ({ tokens: 1, kind: "message", user: false }));
                }),
            ),
        ).toBeNull();
        const sparseQueue = report();
        (sparseQueue.trim!.queue as unknown[]) = [{ tokens: 1, kind: "message", user: false }, ,];
        expect(parseContextReport(sparseQueue)).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.replyPrefix = "m9")))).toBeNull();
        expect(parseContextReport(changed((copy) => delete copy.trim.replyPrefix.messageId))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.trim.replyPrefix.tokens = -1)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.memory.kind = "supaMemory")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.memory.coverage = "full")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.memory.tokens = -1)))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.memory.budget = "200")))).toBeNull();
        expect(parseContextReport(changed((copy) => (copy.memory = [])))).toBeNull();
    });
});

describe("eligibleHistory and historyDigest", () => {
    const base = [
        message("g", "char", "Hello"),
        message("u1", "user", "hi"),
        message("c1", "char", "how are you"),
        message("u2", "user", "fine"),
    ];

    it("reads back to the last allBefore message, skipping disabled ones", () => {
        expect(eligibleHistory(base)).toEqual({ messages: base, reset: false });
        const cut = [base[0], message("u1", "user", "hi", "allBefore"), base[2], message("u2", "user", "fine", true)];
        expect(eligibleHistory(cut)).toEqual({ messages: [cut[2]], reset: true });
        expect(eligibleHistory([])).toEqual({ messages: [], reset: false });
    });

    it("is stable for equal histories and changes on an edit, a deletion, or a disabled flag", () => {
        const digest = historyDigest(base);
        expect(digest).toMatch(/^[0-9a-z]+$/);
        expect(historyDigest(base.map((entry) => ({ ...entry })))).toBe(digest);
        expect(historyDigest([...base.slice(0, 3), message("u2", "user", "fine!")])).not.toBe(digest);
        expect(historyDigest(base.slice(0, 3))).not.toBe(digest);
        expect(historyDigest([...base.slice(0, 2), message("c1", "user", "how are you"), base[3]])).not.toBe(digest);
        expect(historyDigest([...base.slice(0, 3), message("u2", "user", "fine", true)])).not.toBe(digest);
        // A disabled message is not read, so its text does not matter.
        const withDisabled = [...base, message("x", "user", "ignored", true)];
        expect(historyDigest(withDisabled)).toBe(historyDigest([...base, message("x", "user", "other", true)]));
        expect(historyDigest(withDisabled)).toBe(historyDigest(base));
    });

    it("tells a cut history from the same messages without the cut", () => {
        const [first, ...rest] = base;
        expect(historyDigest([message(first.chatId!, first.role, first.data, "allBefore"), ...rest])).not.toBe(
            historyDigest(rest),
        );
        // The cut message's own text is not read.
        expect(historyDigest([message("g", "char", "A", "allBefore"), ...rest])).toBe(
            historyDigest([message("g", "char", "B", "allBefore"), ...rest]),
        );
    });
});

describe("the meter helpers", () => {
    it("turnCount reads user turns or every kept message", () => {
        expect(turnCount(report(), "user")).toEqual({ kept: 4, total: 6 });
        expect(turnCount(report(), "message")).toEqual({ kept: 8, total: 12 });
    });

    it("fixedShare is the fixed sections over the prompt budget, without history, memory, or the adjustment", () => {
        // (200 + 100) / (1000 − 100)
        expect(fixedShare(report())).toBeCloseTo(300 / 900, 10);
        const big = report();
        big.sections = [{ kind: "main", tokens: 2000 }];
        expect(fixedShare(big)).toBe(1);
        const none = report();
        none.sections = [];
        expect(fixedShare(none)).toBe(0);
        const noBudget = report();
        noBudget.maxResponse = 1000;
        expect(fixedShare(noBudget)).toBe(1);
    });

    it("displacement pops the queue only past the headroom, in the loop's order", () => {
        const r = report();
        // Within the headroom, and exactly at it: nothing is dropped.
        expect(displacement(r, 0)).toEqual({ messages: 0, userMessages: 0 });
        expect(displacement(r, 20)).toEqual({ messages: 0, userMessages: 0 });
        // One token over: the example goes, which is not a message.
        expect(displacement(r, 21)).toEqual({ messages: 0, userMessages: 0 });
        // Past the example and the marker (15 + 21 = 36 over 20): still no message.
        expect(displacement(r, 56)).toEqual({ messages: 0, userMessages: 0 });
        // One more: the user message goes.
        expect(displacement(r, 57)).toEqual({ messages: 1, userMessages: 1 });
        // Exactly the whole queue (20 + 15 + 21 + 30 + 25 = 111): both messages, still a known answer.
        expect(displacement(r, 111)).toEqual({ messages: 2, userMessages: 1 });
        expect(displacement(r, 112)).toBe("beyondQueue");
        const empty = report();
        empty.trim!.queue = [];
        expect(displacement(empty, 20)).toEqual({ messages: 0, userMessages: 0 });
        expect(displacement(empty, 21)).toBe("beyondQueue");
    });

    it("displacement is unavailable without a trim ledger (memory on)", () => {
        const memoryOnly = report();
        delete memoryOnly.trim;
        expect(displacement(memoryOnly, 0)).toBe("unavailable");
    });
});
