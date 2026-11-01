// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { MemoryEvent } from "../../../../../shared/structuredMemory.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import {
    coveredMessages,
    rawWindow,
    readBudget,
    spendLanes,
    type Lane,
    type LaneItem,
    type ReadEntry,
} from "./lanes.ts";

describe("structured memory lanes", () => {
    it("keeps stored assistant turns and their leading users raw, dropping only active covered history", () => {
        const entries: ReadEntry[] = [
            { messageId: undefined, role: undefined, text: "Greeting" },
            ...["u1", "a1", "u2", "a2", "u3", "a3", "u4", "blank", "u5", "a5", "u6"].map((id): ReadEntry => ({
                messageId: id,
                role: id.startsWith("u") ? "user" : "char",
                text: id === "blank" ? " \n\t" : id,
            })),
        ];
        const events = memoryRecords(["active", "retracted", "stale", "suppressed"]).events.map(
            (event, index): MemoryEvent => ({
                ...event,
                createdRevision: 1,
                status: index === 1 ? "retracted" : index === 2 ? "stale" : "active",
                suppressed: index === 3,
                sources: (index === 0 ? ["u1", "a1", "a2", "u3", "a3", "a5"] : [["u2"], ["u4"], ["u5"]][index - 1]).map(
                    (messageId) => ({ messageId, hash: "stored-hash", index: 99 }),
                ),
            }),
        );
        const covered = coveredMessages(events);
        expect(covered).toEqual(new Set(["u1", "a1", "a2", "u3", "a3", "a5"]));
        for (const row of [
            { turns: 2, start: 5, dropped: [1, 2, 4] },
            { turns: 1, start: 7, dropped: [1, 2, 4, 5, 6] },
            { turns: 10, start: 0, dropped: [] },
        ]) {
            const window = rawWindow(entries, { windowTurns: row.turns, covered });
            expect(window.start, `${row.turns} turns`).toBe(row.start);
            expect(window.dropped, `${row.turns} turns`).toEqual(new Set(row.dropped));
        }
        // A turn holds one assistant message and what came since the previous assistant: a2 has no user.
        // These stored char roles count as replies even when group assembly rewrites their prompt roles.
        const group: ReadEntry[] = ["u1", "a1", "a2", "u2", "a3", "u3"].map((messageId) => ({
            messageId,
            role: messageId.startsWith("u") ? "user" : "char",
            text: messageId,
        }));
        const window = rawWindow(group, { windowTurns: 2, covered: new Set(["u1", "a1"]) });
        expect(window.start).toBe(2);
        expect(window.dropped).toEqual(new Set([0, 1]));
    });

    it("uses the HypaV3 maximum in ratio and response-limited token modes", () => {
        const targets = { pages: 0, events: 17, evidence: 11, threads: 3 };
        const settings = createHypaV3Preset(
            "Read budget",
            {
                memoryTokensRatio: 0.25,
                memoryBudgetTokens: 900,
                structured: { laneTargets: targets },
            },
            "read-budget",
        ).settings;
        for (const row of [
            { mode: "ratio" as const, context: 1003, response: 203, maximum: 250, reduced: [] },
            {
                mode: "tokens" as const,
                context: 1003,
                response: 203,
                maximum: 400,
                reduced: [expect.objectContaining({ field: "memory", configured: 900, applied: 400 })],
            },
            { mode: "tokens" as const, context: 4000, response: 200, maximum: 900, reduced: [] },
        ]) {
            expect(readBudget({ ...settings, budgetMode: row.mode }, row.context, row.response)).toEqual({
                maximum: row.maximum,
                reduced: expect.arrayContaining(row.reduced),
                targets,
            });
        }
    });

    it("gives lanes their core before lending by score, keeping items whole and disabled lanes empty", () => {
        const item = (lane: LaneItem["lane"], id: string, tokens: number, score: number): LaneItem => ({
            lane,
            id,
            tokens,
            score,
            kind: lane === "events" ? "event" : "evidence",
            reason: "match",
            order: 0,
            line: id,
        });
        const lanes: Lane[] = [
            {
                lane: "events",
                target: 4,
                items: [
                    item("events", "too-large", 20, 100),
                    item("events", "event-core", 4, 0.1),
                    item("events", "event-loan", 3, 0.8),
                ],
            },
            {
                lane: "evidence",
                target: 4,
                limit: 2,
                items: [
                    item("evidence", "evidence-core", 4, 0.05),
                    item("evidence", "evidence-loan", 2, 0.9),
                    item("evidence", "over-count", 1, 0.7),
                ],
            },
            { lane: "threads", target: 0, items: [{ ...item("threads", "disabled", 1, 1000), kind: "thread" }] },
        ];
        const result = spendLanes({ maximum: 14, lanes });
        expect(result.included.slice(0, 2).map(({ id }) => id)).toEqual(["event-core", "evidence-core"]);
        expect(new Set(result.included.map(({ id }) => id))).toEqual(
            new Set(["event-core", "evidence-core", "evidence-loan", "event-loan"]),
        );
        expect(result.included.reduce((sum, { tokens }) => sum + tokens, 0)).toBe(13);
        expect(result.spend).toEqual([
            { lane: "events", target: 4, spent: 7 },
            { lane: "evidence", target: 4, spent: 6 },
            { lane: "threads", target: 0, spent: 0 },
        ]);
        expect(result.excluded).toHaveLength(3);
        expect(result.excluded).toEqual(
            expect.arrayContaining([
                { lane: "events", id: "too-large", kind: "event", reason: "budget" },
                { lane: "evidence", id: "over-count", kind: "evidence", reason: "budget" },
                { lane: "threads", id: "disabled", kind: "thread", reason: "budget" },
            ]),
        );
        // Only one loan fits: the higher score in the later lane wins the remaining room.
        const tight = spendLanes({ maximum: 12, lanes });
        expect(tight.included.map(({ id }) => id)).toEqual(["event-core", "evidence-core", "evidence-loan"]);
        expect(tight.excluded).toContainEqual({ lane: "events", id: "event-loan", kind: "event", reason: "budget" });
    });

    it("admits source evidence only after its events item, never on the strength of a flow title", () => {
        const event: LaneItem = {
            id: "e",
            kind: "event",
            lane: "events",
            reason: "match",
            score: 0.9,
            order: 0,
            line: "event",
            tokens: 4,
        };
        const evidence: LaneItem = {
            id: "source",
            kind: "evidence",
            lane: "evidence",
            reason: "eventSource",
            score: 0.8,
            order: 0,
            line: "source",
            tokens: 2,
            requires: "events:e",
        };
        const lanes: Lane[] = [
            { lane: "flow", target: 1, items: [{ ...event, lane: "flow", tokens: 1 }] },
            { lane: "events", target: 1, items: [event] },
            { lane: "evidence", target: 2, items: [evidence] },
        ];
        for (const [maximum, expected] of [
            [3, ["flow:e"]],
            [7, ["flow:e", "events:e", "evidence:source"]],
        ] as const) {
            const result = spendLanes({ maximum, lanes });
            expect(result.included.map(({ lane, id }) => `${lane}:${id}`)).toEqual(expected);
            expect(result.excluded.every(({ reason }) => reason === "budget")).toBe(true);
        }
    });
});
