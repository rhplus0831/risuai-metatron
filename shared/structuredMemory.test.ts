import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "./database.ts";
import {
    type MemoryEvent,
    type MemoryManifestItem,
    STRUCTURED_MEMORY_LIMITS,
    memoryChapterMark,
    memoryChapterUnits,
    memoryEventGroups,
    memoryGrade,
    memorySceneFieldLimit,
    memorySectionBudget,
    memorySectionOverBudget,
    sealHypaV3Data,
    isSealedHypaV3Data,
    sealedHypaV3DataIntact,
    projectHypaV3Data,
    memoryAnchorState,
    memoryRerecordTarget,
    memorySourceHashVersion,
    memorySourceText,
    parseStoryDate,
    formatStoryDate,
    isStoryDate,
    storyDateDistance,
    storyDateLabel,
    storedMemoryGreeting,
    greetingCited,
    memoryChatGreeting,
    memoryGreetingHashFields,
    coveredMessages,
    rawWindow,
    type ReadEntry,
} from "./structuredMemory.ts";

function event(id: string, overrides: Partial<MemoryEvent> = {}): MemoryEvent {
    return {
        id,
        title: `Title of ${id}`,
        summary: `Summary of ${id}`,
        participants: [],
        storyTime: { text: "That evening" },
        keyLines: [],
        stateChanges: [],
        knowledge: [],
        relationshipShifts: [],
        openThreads: { add: [], close: [], transitions: [] },
        sources: [],
        status: "active",
        writerRun: "run-1",
        createdRevision: 1,
        ...overrides,
    };
}

function item(
    id: string,
    lane: MemoryManifestItem["lane"],
    overrides: Partial<MemoryManifestItem> = {},
): MemoryManifestItem {
    return { id, lane, kind: "event", reason: "Selected for context", tokens: 10, verified: true, ...overrides };
}

describe("projectHypaV3Data", () => {
    it("puts the greeting's null memo before a greeting citation's message memos", () => {
        const early = event("early", { sources: [{ messageId: "m0", hash: "h0", index: 0 }] });
        const greeting = event("greeting", {
            greeting: { fmIndex: -1, hash: "recorded greeting" },
            sources: [{ messageId: "m9", hash: "h9", index: 9 }],
        });
        // Order is the caller's (`projectChatMemory`); this checks only the memos.
        expect(projectHypaV3Data([greeting, early]).summaries.map(({ chatMemos }) => chatMemos)).toEqual([
            [null, "m9"],
            ["m0"],
        ]);
    });
    it("marks grade six and pinned events important but leaves grade five and ungraded events ordinary", () => {
        expect(
            projectHypaV3Data([
                event("five", { grade: 5 }),
                event("six", { grade: 6 }),
                event("ungraded"),
                event("pinned", { pinned: true, grade: 0 }),
            ]).summaries.map(({ isImportant }) => isImportant),
        ).toEqual([false, true, false, true]);
    });

    it("projects active events in order with their summaries, all source ids, and pin or grade importance", () => {
        const events = [
            event("retracted", { status: "retracted", pinned: true, grade: 9 }),
            event("ordinary", {
                summary: "They arrived at the inn.",
                pinned: false,
                sources: [
                    { messageId: "message-8", hash: "hash-8", index: 8 },
                    { messageId: "missing-message", hash: null, index: null },
                    { messageId: "message-2", hash: "hash-2", index: 2 },
                ],
            }),
            event("stale", { status: "stale", grade: 8 }),
            event("pinned", { summary: "The host offered a room.", pinned: true }),
            event("zero-grade", { summary: "They unpacked.", pinned: false, grade: 0 }),
            event("graded", { summary: "They promised to meet at dawn.", grade: 7 }),
        ];

        expect(projectHypaV3Data(events).summaries).toStrictEqual([
            {
                text: "They arrived at the inn.",
                chatMemos: ["message-8", "missing-message", "message-2"],
                isImportant: false,
            },
            { text: "The host offered a room.", chatMemos: [], isImportant: true },
            { text: "They unpacked.", chatMemos: [], isImportant: false },
            { text: "They promised to meet at dawn.", chatMemos: [], isImportant: true },
        ]);
    });

    it("omits metrics without a manifest and includes only the four required arrays for an empty manifest", () => {
        const events = [event("ordinary", { summary: "A quiet evening." })];
        const summaries = [{ text: "A quiet evening.", chatMemos: [], isImportant: false }];

        for (const projected of [
            projectHypaV3Data(events),
            projectHypaV3Data(events, undefined),
            projectHypaV3Data(events, null),
        ]) {
            expect(projected).toStrictEqual({ summaries });
        }

        expect(projectHypaV3Data(events, { items: [] })).toStrictEqual({
            summaries,
            metrics: {
                lastImportantSummaries: [],
                lastRecentSummaries: [],
                lastSimilarSummaries: [],
                lastRandomSummaries: [],
            },
        });
    });

    it("records each verified event once per selected lane using projected summary indices", () => {
        const events = [
            event("retracted", { status: "retracted" }),
            event("flow-only", { pinned: true }),
            event("stale", { status: "stale" }),
            event("both", { grade: 0 }),
            event("similar-only"),
            event("ignored-items"),
            event("unused"),
        ];
        const manifest = {
            items: [
                item("both", "events"),
                item("similar-only", "events"),
                item("both", "flow"),
                item("flow-only", "flow"),
                item("both", "flow"),
                item("both", "events"),
                item("retracted", "flow"),
                item("stale", "events"),
                item("missing", "flow"),
                item("missing", "events"),
                item("ignored-items", "flow", { verified: false }),
                item("ignored-items", "events", { verified: false }),
                item("ignored-items", "flow", { kind: "page" }),
                item("ignored-items", "events", { kind: "thread" }),
                item("ignored-items", "flow", { kind: "evidence" }),
                item("ignored-items", "required"),
                item("ignored-items", "pages"),
                item("ignored-items", "evidence"),
                item("ignored-items", "threads"),
            ],
        };

        const { metrics } = projectHypaV3Data(events, manifest);

        expect(metrics).toStrictEqual({
            lastImportantSummaries: [],
            lastRecentSummaries: expect.arrayContaining([0, 1]),
            lastSimilarSummaries: expect.arrayContaining([1, 2]),
            lastRandomSummaries: [],
        });
        expect(metrics?.lastRecentSummaries).toHaveLength(2);
        expect(metrics?.lastSimilarSummaries).toHaveLength(2);
    });
});

it("drops only an actively covered greeting outside the raw window, even after the greeting changes", () => {
    const greeting = { fmIndex: -1, hash: "original" };
    const recorded = event("recorded", { greeting });
    const entries: ReadEntry[] = [
        { messageId: undefined, greeting, text: "Original greeting", role: "char" },
        { messageId: "old", text: "Older reply", role: "char" },
        { messageId: "question", text: "Next question", role: "user" },
        { messageId: "recent", text: "Recent reply", role: "char" },
    ];
    for (const current of [greeting, { ...greeting, fmIndex: 0 }, { ...greeting, hash: "edited" }]) {
        expect(
            rawWindow(
                [
                    {
                        ...entries[0],
                        greeting: current,
                        text: current.hash === "edited" ? "Edited greeting" : "Original greeting",
                    },
                    ...entries.slice(1),
                ],
                {
                    windowTurns: 1,
                    covered: coveredMessages([recorded]),
                },
            ),
        ).toEqual({ start: 2, dropped: new Set([0]) });
    }
    // Two stored replies fit: the greeting must not become a third turn.
    expect(rawWindow(entries, { windowTurns: 2, covered: coveredMessages([recorded]) })).toEqual({
        start: 0,
        dropped: new Set(),
    });
    for (const events of [
        [],
        [event("legacy")],
        [{ ...recorded, status: "stale" as const }],
        [{ ...recorded, status: "retracted" as const }],
        [{ ...recorded, suppressed: true }],
    ]) {
        expect(
            rawWindow(entries, { windowTurns: 1, covered: coveredMessages(events) }),
            JSON.stringify(events),
        ).toEqual({ start: 2, dropped: new Set() });
    }
});

it("sums all three grade axes from zero through nine and has no grade without axes", () => {
    expect(memoryGrade({ persistence: 0, change: 0, reach: 0 })).toBe(0);
    expect(memoryGrade({ persistence: 1, change: 2, reach: 3 })).toBe(6);
    expect(memoryGrade({ persistence: 3, change: 3, reach: 3 })).toBe(9);
    expect(memoryGrade(undefined)).toBeUndefined();
});

it("names the seen anchor state independently of prefix shifts and targets only the newest eligible cited reply", () => {
    type Held = Pick<Message, "chatId" | "role" | "data">;
    const messages: Held[] = [
        { chatId: "u", role: "user", data: "Question" },
        { chatId: "a", role: "char", data: "Answer" },
    ];
    const sources = messages.map((m, index) => ({ messageId: m.chatId, index, hash: m.data }));
    const hash = (m: Held) => m.data;
    const seen = memoryAnchorState(sources, messages, hash);
    expect(memoryAnchorState(sources, [{ chatId: "prefix", role: "user", data: "Earlier" }, ...messages], hash)).toBe(
        seen,
    );
    const changes: Held[][] = [
        [messages[0], { ...messages[1], data: "Different answer" }],
        [messages[0]],
        [messages[1], messages[0]],
        [messages[0], { chatId: "inserted", role: "user", data: "Wait" }, messages[1]],
    ];
    for (const changed of changes) expect(memoryAnchorState(sources, changed, hash)).not.toBe(seen);
    expect(memoryRerecordTarget(sources, messages)).toEqual({ messageId: "a" });
    expect(memoryRerecordTarget(sources, [...messages, { chatId: "unrelated", role: "user", data: "Next" }])).toEqual({
        messageId: "a",
    });
    expect(memoryRerecordTarget(sources, [messages[1], messages[0]])).toBeNull();
    expect(memoryRerecordTarget(sources, [messages[0], { ...messages[1], disabled: true }])).toBeNull();
    expect(
        memoryRerecordTarget(sources, [...messages, { chatId: "reset", role: "user", disabled: "allBefore" }]),
    ).toBeNull();
});

it("seals every JSON field while accepting round trips and recursively reordered object keys", () => {
    const plain = {
        summaries: [{ text: "Arrival", chatMemos: ["m1", "m2"], isImportant: false }],
        categories: [{ id: "place", name: "Places", color: "blue" }],
        metrics: {
            lastImportantSummaries: [],
            lastRecentSummaries: [0],
            lastSimilarSummaries: [],
            lastRandomSummaries: [],
        },
    };
    expect(isSealedHypaV3Data(plain)).toBe(false);
    const sealed = sealHypaV3Data(plain);
    expect(isSealedHypaV3Data(sealed)).toBe(true);
    expect(sealedHypaV3DataIntact(JSON.parse(JSON.stringify(sealed)))).toBe(true);
    const reorder = (value: unknown): unknown =>
        Array.isArray(value)
            ? value.map(reorder)
            : value && typeof value === "object"
              ? Object.fromEntries(
                    Object.entries(value)
                        .reverse()
                        .map(([key, entry]) => [key, reorder(entry)]),
                )
              : value;
    expect(sealedHypaV3DataIntact(reorder(sealed))).toBe(true);
    for (const change of [
        (v: typeof sealed) => {
            v.summaries[0].text = "Changed";
        },
        (v: typeof sealed) => {
            v.summaries[0].chatMemos.reverse();
        },
        (v: typeof sealed) => {
            v.summaries[0].isImportant = true;
        },
        (v: typeof sealed) => {
            v.categories = [];
        },
        (v: typeof sealed) => {
            v.metrics!.lastRecentSummaries = [];
        },
        (v: typeof sealed) => {
            Object.assign(v, { pluginField: { added: true } });
        },
    ]) {
        const changed = JSON.parse(JSON.stringify(sealed));
        change(changed);
        expect(isSealedHypaV3Data(changed)).toBe(true);
        expect(sealedHypaV3DataIntact(changed)).toBe(false);
    }
    expect(plain).not.toHaveProperty("structuredMemoryProjection");
});

it("seals the memory revision so a whole-read baseline cannot be retagged", () => {
    const revision = "00000000-0000-4000-8000-000000000000:7:3";
    const value = sealHypaV3Data({ summaries: [] }, revision);
    expect(value.structuredMemoryRevision).toBe(revision);
    expect(sealedHypaV3DataIntact(JSON.parse(JSON.stringify(value)))).toBe(true);
    expect(sealedHypaV3DataIntact({ ...value, structuredMemoryRevision: revision.replace(/3$/, "4") })).toBe(false);
    const { structuredMemoryRevision: _revision, ...stripped } = value;
    expect(sealedHypaV3DataIntact(stripped)).toBe(false);
});

it("keeps the 800-character scene minimum, longer stored lengths, and the 4000-character ceiling", () => {
    expect(memorySectionOverBudget("scene", "state", "x".repeat(1520))).toBe(false);
    expect([500, 800, 801, 1520, 4000, 4200].map(memorySceneFieldLimit)).toEqual([800, 800, 801, 1520, 4000, 4000]);
    expect(memorySectionOverBudget("scene", "state", "x".repeat(4001))).toBe(true);
});

it("uses character slot budgets and keeps the page budget for other headings and types", () => {
    expect(memorySectionBudget("character", "knowledge")).toBe(1000);
    expect(memorySectionBudget("character", "relationships")).toBe(1200);
    expect(memorySectionBudget("character", "goals")).toBe(1600);
    expect(memorySectionBudget("location", "knowledge")).toBe(1200);
    expect(memorySectionBudget("character", "toString")).toBe(1600);
    expect(memorySectionOverBudget("character", "knowledge", "x".repeat(1000))).toBe(false);
    expect(memorySectionOverBudget("character", "knowledge", "x".repeat(1001))).toBe(true);
    expect(memorySectionOverBudget("character", "relationships", "x".repeat(1201))).toBe(true);
    expect(memorySectionOverBudget("character", "goals", "x".repeat(1001))).toBe(false);
});

describe("story dates", () => {
    it.each([
        ["2025-03-31", "2025-04-03", 3],
        ["12-25", "2025-04-03", 99],
        ["2024-12-25", "04-03", 99],
        ["12-31", "01-01", 1],
        ["02-29", "2025-02-28", 0],
        ["02-29", "2025-03-01", 1],
        ["2025-02-28", "02-29", 0],
        ["2024-03-01", "02-29", 364],
        ["02-29", "02-28", 365],
        ["2025-04-04", "2025-04-03", undefined],
        ["0099-12-31", "0100-01-01", 1],
        ["2024-12-31", "2025-01-01", 1],
    ] as const)("counts story days from %s to %s as %s", (from, now, days) => {
        expect(storyDateDistance(parseStoryDate(from)!, parseStoryDate(now)!)).toBe(days);
    });

    it.each([
        [0, "same day"],
        [1, "1 day ago"],
        [2, "2 days ago"],
        [13, "13 days ago"],
        [14, "2 weeks ago"],
        [59, "8 weeks ago"],
        [60, "2 months ago"],
        [76, "2 months ago"],
        [77, "3 months ago"],
        [729, "24 months ago"],
        [730, "2 years ago"],
        [1096, "3 years ago"],
    ] as const)("labels %i story days as %s", (days, label) => {
        expect(storyDateLabel(days)).toBe(label);
    });

    it.each([
        ["2025-04-03", { year: 2025, month: 4, day: 3 }],
        ["2025/4/3", { year: 2025, month: 4, day: 3 }],
        ["0001.01.1", { year: 1, month: 1, day: 1 }],
        ["10-15", { month: 10, day: 15 }],
        ["2/9", { month: 2, day: 9 }],
        ["02.29", { month: 2, day: 29 }],
        ["2024-02-29", { year: 2024, month: 2, day: 29 }],
        ["2000-02-29", { year: 2000, month: 2, day: 29 }],
        ["9999-12-31", { year: 9999, month: 12, day: 31 }],
    ] as const)("parses %s and accepts its stored date", (text, date) => {
        expect(parseStoryDate(text)).toStrictEqual(date);
        expect(isStoryDate(date)).toBe(true);
    });

    it.each([
        ["0000-01-01", { year: 0, month: 1, day: 1 }],
        ["10000-01-01", { year: 10000, month: 1, day: 1 }],
        ["00-01", { month: 0, day: 1 }],
        ["13-01", { month: 13, day: 1 }],
        ["01-00", { month: 1, day: 0 }],
        ["01-32", { month: 1, day: 32 }],
        ["04-31", { month: 4, day: 31 }],
        ["02-30", { month: 2, day: 30 }],
        ["2025-02-29", { year: 2025, month: 2, day: 29 }],
        ["1900-02-29", { year: 1900, month: 2, day: 29 }],
    ] as const)("refuses %s and its invalid stored date", (text, date) => {
        expect(parseStoryDate(text)).toBeUndefined();
        expect(isStoryDate(date)).toBe(false);
    });

    it.each(["025-04-03", "2025-004-03", "2025-04-003", "On 2025-04-03", "2025-04-03 at dawn"])(
        "refuses date text outside the supported forms: %s",
        (text) => {
            expect(parseStoryDate(text)).toBeUndefined();
        },
    );

    it("requires a stored object with whole numeric date fields", () => {
        for (const value of [
            null,
            "2025-04-03",
            { year: "2025", month: 4, day: 3 },
            { month: "4", day: 3 },
            { month: 4, day: 3.5 },
            { month: 4 },
        ]) {
            expect(isStoryDate(value), JSON.stringify(value)).toBe(false);
        }
    });

    it("formats dates with padded parts and leaves an unstated year out", () => {
        expect(formatStoryDate({ year: 2025, month: 4, day: 3 })).toBe("2025-04-03");
        expect(formatStoryDate({ month: 10, day: 15 })).toBe("10-15");
        expect(formatStoryDate({ year: 1, month: 2, day: 9 })).toBe("0001-02-09");
    });
});

describe("memoryEventGroups", () => {
    it("keeps undated events with the preceding day and starts a new group for a flashback or an unstated year", () => {
        const arrival = { year: 2025, month: 4, day: 3 };
        const departure = { year: 2025, month: 4, day: 4 };
        const yearless = { month: 4, day: 3 };
        const groups = memoryEventGroups(
            [
                { id: "prologue" },
                { id: "overture" },
                { id: "arrival", date: arrival },
                { id: "dinner" },
                { id: "bedtime", date: { ...arrival } },
                { id: "departure", date: departure },
                { id: "flashback", date: arrival },
                { id: "anniversary", date: yearless },
            ],
            10,
        );
        expect(groups.map(({ date, events }) => [date, events.map(({ id }) => id)])).toEqual([
            [null, ["prologue", "overture"]],
            [arrival, ["arrival", "dinner", "bedtime"]],
            [departure, ["departure"]],
            [arrival, ["flashback"]],
            [yearless, ["anniversary"]],
        ]);
    });

    it("splits a long day into balanced numbered parts and keeps a day at the size limit whole", () => {
        expect(STRUCTURED_MEMORY_LIMITS.eventsPerGroup).toBe(10);
        const firstDay = { month: 5, day: 1 };
        const nextDay = { month: 5, day: 2 };
        const events = Array.from({ length: 14 }, (_, i) => ({ id: String(i), date: i < 10 ? firstDay : nextDay }));
        const groups = memoryEventGroups(events, 4);
        expect(groups.map(({ date, part, partCount }) => [date, part, partCount])).toEqual([
            [firstDay, 1, 3],
            [firstDay, 2, 3],
            [firstDay, 3, 3],
            [nextDay, 1, 1],
        ]);
        expect(
            groups
                .slice(0, 3)
                .map(({ events }) => events.length)
                .sort((a, b) => a - b),
        ).toEqual([3, 3, 4]);
        expect(groups[3].events).toEqual(events.slice(10));
        expect(groups.flatMap(({ events }) => events)).toEqual(events);
    });
});

it("marks the title, summary and story date after normalizing missing or invalid fields", () => {
    const day = { month: 4, day: 3 };
    const mark = memoryChapterMark("Arrival", "They dock.", day);
    expect(memoryChapterMark("Arrival", "They dock.", { ...day })).toBe(mark);
    expect(memoryChapterMark("Departure", "They dock.", day)).not.toBe(mark);
    expect(memoryChapterMark("Arrival", "They sail.", day)).not.toBe(mark);
    expect(memoryChapterMark("Arrival", "They dock.", { ...day, day: 4 })).not.toBe(mark);
    expect(memoryChapterMark(42, "They dock.", day)).toBe(memoryChapterMark("", "They dock.", day));
    expect(memoryChapterMark("Arrival", null, day)).toBe(memoryChapterMark("Arrival", "", day));
    expect(memoryChapterMark("Arrival", "They dock.", { month: 4, day: 31 })).toBe(
        memoryChapterMark("Arrival", "They dock.", undefined),
    );
});

it("gathers whole day parts oldest first and leaves the open tail and newest ten events out", () => {
    expect(STRUCTURED_MEMORY_LIMITS.chapterRecentEvents).toBe(10);
    // Three events on day one, then ten on day two. The invalid date continues day two.
    const days = [1, 1, 1, 2, 2, 31, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3];
    const older = days.map((day, i) => ({ id: String(i), date: { month: 4, day }, chaptered: false }));
    const recent = Array.from({ length: 10 }, (_, i) => ({ id: `recent-${i}`, chaptered: false }));
    // At size four the ten-event day splits 4/3/3. Its first part closes the
    // preceding three-event group, and the two remaining parts close together.
    const units = memoryChapterUnits([...older, ...recent], 4, STRUCTURED_MEMORY_LIMITS.chapterRecentEvents);
    expect(units.map((unit) => unit.map(({ id }) => id))).toEqual([
        ["0", "1", "2", "3", "4", "5", "6"],
        ["7", "8", "9", "10", "11", "12"],
    ]);
});

it("closes a short gap at a covered event even when it is the first protected event", () => {
    const loose = (id: string) => ({ id, chaptered: false });
    const first = loose("first");
    const covered = { id: "already-covered", chaptered: true };
    const full = ["one", "two", "three"].map(loose);
    const tail = { ...loose("tail"), date: { month: 4, day: 3 } };
    const older = [first, covered, ...full, tail];
    const recent = Array.from({ length: 10 }, (_, i) => ({ id: `recent-${i}`, chaptered: i === 0 }));
    expect(memoryChapterUnits([...older, ...recent], 3, 10)).toEqual([[first], full, [tail]]);
    expect(memoryChapterUnits(older, 3, 0)).toEqual([[first], full]);
});

describe("memorySourceText", () => {
    it.each([
        ["bracketed status", "[Nu|2025년 4월 3일 목요일|아침|재원의 방]", "2025년 4월 3일"],
        ["inline status", "<status>date:2025/10/27 (월)|time:아침|place:재원의 방</status>", "2025/10/27"],
        ["status block", "<STATUS>\ntime=19:40\ndate=10월 15일 (목)\n</STATUS>", "10월 15일"],
    ])("keeps the stated calendar date in %s", (_form, text, dateText) => {
        expect(memorySourceText(text)).toContain(dateText);
    });

    const block =
        '<div class="am-illustration-projection" data-am-message-id="m" data-am-slot-index="12">' +
        '<span class="am-image" style="display: block"><img class="am-image__media" ' +
        'src="{{raw::한민재.__am__.chat.e6470a96}}" width="832" height="1216" alt="" loading="lazy"></span></div>';

    it("preserves the legacy markup replacement and searches an unclosed comment suffix only once", () => {
        const shapes = [
            "",
            "plain text &amp; {{user}}",
            "<!--",
            "<!-->",
            "before <!-- unclosed after",
            "before <!-->after",
            "<!-- a > b -->kept<!-- second -->",
            "<!-- unclosed <b>kept</b>",
            "<!-- <!-- -->tail<!--",
            "<<b>inner</b>>",
            "<a <b>text</a>",
            "<!><!DOCTYPE html></><br/>",
            '<tag attr="a > b">text</tag>',
            "a < b, 3<4, <3, <=, <Name>, <tag without end",
            "한글 😀 <é>kept</é>",
            "  <p>A</p>\n\n \t\n\r\nB  ",
        ];
        for (const data of shapes) {
            const legacy = data
                .replace(/<!--[\s\S]*?-->|<[A-Za-z/!][^<>]*>/g, "")
                .replace(/\n(?:[ \t\r]*\n){2,}/g, "\n\n")
                .trim();
            expect(memorySourceText(data), data).toBe(legacy);
        }

        const unclosed = "<!--".repeat(512);
        const searches = vi.spyOn(String.prototype, "indexOf");
        let terminatorSearches: number;
        let normalized: string;
        try {
            normalized = memorySourceText(unclosed);
            terminatorSearches = searches.mock.calls.filter(([needle]) => needle === "-->").length;
        } finally {
            searches.mockRestore();
        }
        expect(normalized).toBe(unclosed);
        expect(terminatorSearches).toBe(1);
    });

    it("removes tags and comments but keeps their inner text", () => {
        expect(memorySourceText('<p class="x">She <b>waits</b>.</p><!-- note: a > b --><br/>')).toBe("She waits.");
        expect(memorySourceText("<!DOCTYPE html>Text</P>")).toBe("Text");
    });

    it("keeps a < that opens no tag", () => {
        expect(memorySourceText("a < b and 3<4, <3 and x <= y")).toBe("a < b and 3<4, <3 and x <= y");
        expect(memorySourceText("open <tag with no end")).toBe("open <tag with no end");
        // The documented limit: text shaped like a tag goes too.
        expect(memorySourceText("Call me <Name> now")).toBe("Call me  now");
    });

    it("collapses blank-line runs to one blank line and trims the ends", () => {
        expect(memorySourceText("A\n\n\n\nB\n \t\n\nC")).toBe("A\n\nB\n\nC");
        expect(memorySourceText("A\n\nB")).toBe("A\n\nB");
        expect(memorySourceText("  \nA  \n\n")).toBe("A");
    });

    it("reads an inserted illustration block as the prose alone", () => {
        const prose = "He opened the door.\n\nThe hall was dark.";
        for (const marked of [
            `He opened the door.\n\n${block}\n\nThe hall was dark.`,
            `${block}\n\n${prose}`,
            `${prose}\n\n${block}\n${block}\n\n${block}\n`,
        ]) {
            expect(memorySourceText(marked)).toBe(prose);
        }
    });
});

it("reads a source hash's version from its prefix, current when absent", () => {
    expect([undefined, "v3:ab", "v2:ab", "ab", "v4:ab"].map(memorySourceHashVersion)).toEqual([3, 3, 2, 1, 1]);
});

it("reads only a greeting citation with a numeric index and string hash", () => {
    const source = { fmIndex: -1, hash: "v3:stored" };
    expect(storedMemoryGreeting(source)).toEqual(source);
    expect(storedMemoryGreeting({ fmIndex: 2, hash: "v3:alternate" })).toEqual({ fmIndex: 2, hash: "v3:alternate" });
    for (const value of [
        undefined,
        null,
        {},
        [],
        { hash: "v3:x" },
        { fmIndex: -1 },
        { fmIndex: "0", hash: "v3:x" },
        { fmIndex: 0, hash: 7 },
        { fmIndex: 0.5, hash: "v3:x" },
        { fmIndex: -2, hash: "v3:x" },
        { ...source, extra: true },
    ]) {
        expect(storedMemoryGreeting(value), JSON.stringify(value)).toBeNull();
    }
});

it("matches the effective solo greeting by index and normalized stored text", () => {
    const owner = { firstMessage: "Hello {{user}}.", alternateGreetings: ["Welcome {{user}}."] };
    const chat = { fmIndex: 0, message: [] };
    const source = {
        fmIndex: 0,
        hash: `v3:${createHash("sha256")
            .update(JSON.stringify(["greeting", "Welcome {{user}}."]))
            .digest("hex")}`,
    };
    const current = (character: Parameters<typeof memoryChatGreeting>[0] = owner, held = chat) => {
        const greeting = memoryChatGreeting(character, held);
        return (
            greeting && {
                fmIndex: greeting.fmIndex,
                hash: `v3:${createHash("sha256").update(memoryGreetingHashFields(greeting.text)).digest("hex")}`,
            }
        );
    };
    expect(memoryChatGreeting(owner, chat)).toEqual({ fmIndex: 0, text: "Welcome {{user}}." });
    expect(memoryChatGreeting(owner, { ...chat, fmIndex: 99 })).toEqual({ fmIndex: -1, text: "Hello {{user}}." });
    expect(greetingCited(source, current())).toBe(true);
    expect(
        greetingCited(
            source,
            current({ ...owner, firstMessage: owner.alternateGreetings[0] }, { ...chat, fmIndex: -1 }),
        ),
    ).toBe(false);
    expect(greetingCited(source, current({ ...owner, alternateGreetings: ["Goodbye {{user}}."] }))).toBe(false);
    for (const text of ["<b>Welcome {{user}}.</b>", '<p class="changed">Welcome {{user}}.</p>']) {
        expect(greetingCited(source, current({ ...owner, alternateGreetings: [text] }))).toBe(true);
    }
    const group = current({ ...owner, type: "group" });
    expect(group).toBeNull();
    expect(greetingCited(source, group)).toBe(false);
    expect(greetingCited(null, source)).toBe(false);
});
