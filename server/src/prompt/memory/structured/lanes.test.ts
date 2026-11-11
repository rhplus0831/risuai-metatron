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
    const flowCandidate = (id: string, tokens: number, full = false): LaneItem => ({
        id,
        kind: "event",
        lane: "flow",
        reason: full ? "timeline" : "recent",
        score: 0,
        order: 0,
        line: full ? `${id}: summary` : id,
        tokens,
    });

    it("stops the core timeline at the first oversized full line without skipping to a smaller older event", () => {
        const titles = ["newest", "blocked", "small"].map((id) => flowCandidate(id, 1));
        const result = spendLanes({
            maximum: 10,
            lanes: [
                {
                    lane: "flow",
                    target: 6,
                    items: titles,
                    flow: {
                        timeline: true,
                        titles: 1,
                        full: [
                            flowCandidate("newest", 4, true),
                            flowCandidate("blocked", 5, true),
                            flowCandidate("small", 1, true),
                        ],
                    },
                },
                { lane: "pages", target: 5, items: [{ ...flowCandidate("page", 5), lane: "pages", kind: "page" }] },
            ],
        });
        // Four full-line tokens leave two of the target; the next five-token line ends the run.
        // The title reserves one token before the page takes the remaining five, leaving no extension.
        expect(result.included.map(({ id, reason }) => [id, reason])).toEqual([
            ["newest", "timeline"],
            ["blocked", "recent"],
            ["page", "recent"],
        ]);
        expect(result.spend).toEqual([
            { lane: "flow", target: 6, spent: 5 },
            { lane: "pages", target: 5, spent: 5 },
        ]);
    });

    it("extends after other lanes lend, refunds promoted titles and moves their window past the run", () => {
        const flow: Lane = {
            lane: "flow",
            target: 4,
            items: ["newest", "recalled", "next", "blocked", "small"].map((id) => flowCandidate(id, 1)),
            flow: {
                timeline: true,
                titles: 2,
                full: [
                    flowCandidate("newest", 4, true),
                    flowCandidate("recalled", 4, true),
                    flowCandidate("next", 4, true),
                    flowCandidate("blocked", 20, true),
                    flowCandidate("small", 1, true),
                ],
            },
        };
        const lanes: Lane[] = [
            flow,
            {
                lane: "pages",
                target: 2,
                items: ["page-core", "page-loan"].map((id) => ({
                    ...flowCandidate(id, 2),
                    lane: "pages",
                    kind: "page",
                })),
            },
            {
                lane: "events",
                target: 4,
                items: ["newest", "recalled"].map((id) => ({
                    ...flowCandidate(id, 4, true),
                    lane: "events",
                    reason: "match",
                })),
            },
        ];
        const core = spendLanes({ maximum: 14, lanes });
        expect(core.included.map(({ lane, id, reason }) => [lane, id, reason])).toEqual([
            ["flow", "newest", "timeline"],
            ["flow", "recalled", "recent"],
            ["flow", "next", "recent"],
            ["pages", "page-core", "recent"],
            ["events", "recalled", "match"],
            ["pages", "page-loan", "recent"],
        ]);
        for (const maximum of [18, 19]) {
            const extended = spendLanes({ maximum, lanes });
            // The events lane owns recalled; extension passes it. Upgrading next costs 4 - 1,
            // leaving room for blocked's title. Even with one spare token, small cannot jump blocked.
            expect(extended.included.map(({ lane, id, reason }) => [lane, id, reason])).toEqual([
                ["flow", "newest", "timeline"],
                ["flow", "recalled", "recent"],
                ["pages", "page-core", "recent"],
                ["events", "recalled", "match"],
                ["pages", "page-loan", "recent"],
                ["flow", "next", "timeline"],
                ["flow", "blocked", "recent"],
            ]);
            expect(extended.spend).toEqual([
                { lane: "flow", target: 4, spent: 10 },
                { lane: "pages", target: 2, spent: 4 },
                { lane: "events", target: 4, spent: 4 },
            ]);
        }
    });

    it("keeps title-only flow spending and admission identical to the legacy lane", () => {
        // Retrieval represents a configured zero target with this sentinel and only the newest titles.
        const legacy: Lane = {
            lane: "flow",
            target: Number.MAX_SAFE_INTEGER,
            items: [flowCandidate("newest", 2), flowCandidate("older", 2)],
        };
        for (const [maximum, ids, spent] of [
            [7, ["newest", "older", "page"], 4],
            [3, ["newest"], 2],
        ] as const) {
            const page: Lane = {
                lane: "pages",
                target: 3,
                items: [{ ...flowCandidate("page", 3), lane: "pages", kind: "page" }],
            };
            const result = spendLanes({
                maximum,
                lanes: [{ ...legacy, flow: { timeline: false, titles: 2, full: [] } }, page],
            });
            expect(result).toEqual(spendLanes({ maximum, lanes: [legacy, page] }));
            expect(result.included.map(({ id }) => id)).toEqual(ids);
            expect(result.included.filter(({ lane }) => lane === "flow").map(({ reason }) => reason)).toEqual(
                ids.filter((id) => id !== "page").map(() => "recent"),
            );
            expect(result.spend[0]).toEqual({ lane: "flow", target: Number.MAX_SAFE_INTEGER, spent });
        }
    });

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
        const targets = { flow: 9, pages: 0, events: 17, evidence: 11, threads: 3 };
        const settings = createHypaV3Preset(
            "Read budget",
            {
                memoryTokensRatio: 0.25,
                memoryBudgetTokens: 900,
                structured: { laneSplit: "manual", laneTargets: targets },
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

    it("sets auto targets to floored shares of the applied maximum, ignoring stored counts including zero", () => {
        const settings = createHypaV3Preset(
            "Automatic lanes",
            {
                memoryTokensRatio: 0.25,
                memoryBudgetTokens: 903,
                structured: {
                    laneSplit: "auto",
                    laneTargets: { flow: 9, pages: 0, events: 17, evidence: 11, threads: 3 },
                    requiredCap: 731,
                },
            },
            "automatic-lanes",
        ).settings;
        for (const row of [
            {
                mode: "ratio",
                context: 1003,
                response: 203,
                maximum: 250,
                targets: { flow: 62, pages: 112, events: 37, evidence: 25, threads: 12 },
            },
            {
                mode: "tokens",
                context: 4000,
                response: 200,
                maximum: 903,
                targets: { flow: 225, pages: 406, events: 135, evidence: 90, threads: 45 },
            },
            {
                mode: "tokens",
                context: 1005,
                response: 203,
                maximum: 401,
                targets: { flow: 100, pages: 180, events: 60, evidence: 40, threads: 20 },
            },
        ] as const) {
            const budget = readBudget({ ...settings, budgetMode: row.mode }, row.context, row.response);
            expect(budget, `${row.mode}, context ${row.context}`).toMatchObject({
                maximum: row.maximum,
                targets: row.targets,
            });
            expect(budget.reduced.filter(({ field }) => field === "memory")).toEqual(
                row.maximum === 401 ? [{ field: "memory", configured: 903, applied: 401 }] : [],
            );
        }
    });

    it("sets auto targets from the preset's own shares, and manual targets ignore them", () => {
        const laneShares = { flow: 60, pages: 0, events: 33, evidence: 100, threads: 7 };
        const laneTargets = { flow: 9, pages: 8, events: 17, evidence: 11, threads: 3 };
        const preset = (laneSplit: "auto" | "manual") =>
            createHypaV3Preset(
                "Own shares",
                { budgetMode: "tokens", memoryBudgetTokens: 901, structured: { laneSplit, laneShares, laneTargets } },
                "own-shares",
            ).settings;
        expect(readBudget(preset("auto"), 4000, 200)).toMatchObject({
            maximum: 901,
            targets: { flow: 540, pages: 0, events: 297, evidence: 901, threads: 63 },
        });
        expect(readBudget(preset("manual"), 4000, 200).targets).toEqual(laneTargets);
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
