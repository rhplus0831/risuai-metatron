import { describe, expect, it } from "vitest";
import { type MemoryEvent, type MemoryManifestItem, memoryGrade, projectHypaV3Data } from "./structuredMemory.ts";

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
