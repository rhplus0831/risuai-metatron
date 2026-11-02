import { describe, expect, it } from "vitest";
import type { Message } from "./database.ts";
import {
    type MemoryEvent,
    type MemoryManifestItem,
    memoryGrade,
    sealHypaV3Data,
    isSealedHypaV3Data,
    sealedHypaV3DataIntact,
    projectHypaV3Data,
    memoryAnchorState,
    memoryRerecordTarget,
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
    expect(memoryRerecordTarget(sources, messages)).toBe("a");
    expect(memoryRerecordTarget(sources, [...messages, { chatId: "unrelated", role: "user", data: "Next" }])).toBe("a");
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
