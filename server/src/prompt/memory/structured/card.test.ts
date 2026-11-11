// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MemoryTokenizer } from "../host.ts";
import { buildMemoryCard, eventLine, evidenceLine, flowEventLine, flowLine, itemTag, threadLine } from "./card.ts";
import type { Lane, LaneCandidate } from "./lanes.ts";

const candidate = (lane: LaneCandidate["lane"], id: string, line: string, order = 0): LaneCandidate => ({
    lane,
    id,
    line,
    order,
    kind: lane === "threads" ? "thread" : lane === "evidence" ? "evidence" : "event",
    reason: "selected",
    score: 1,
});

async function spentCard(...args: Parameters<typeof buildMemoryCard>) {
    const card = await buildMemoryCard(...args);
    if (card.type !== "card") throw new Error("The required lane refused");
    return card;
}

describe("structured memory card", () => {
    it("renders chronological full flow lines with story time, summaries and the supplied key lines", async () => {
        const older = {
            id: "gate",
            title: "Gate opened",
            summary: "Ada unlocked the gate.",
            storyTime: { text: "Dawn" },
            keyLines: [],
        };
        const newest = {
            id: "promise",
            title: "Promise",
            summary: "Ben agreed to return.",
            storyTime: { text: "Noon" },
            keyLines: [
                { speaker: "Ben", text: "I will return." },
                { speaker: "", text: "Before sunset." },
            ],
        };
        const full = [
            { ...candidate("flow", "promise", flowEventLine(newest, 2), 2), reason: "timeline" },
            { ...candidate("flow", "gate", flowEventLine(older, 3), 1), reason: "timeline" },
        ];
        const card = await spentCard(
            { tokenizeChat: async ({ content }) => content.length },
            {
                maximum: 10000,
                lanes: [
                    {
                        lane: "flow",
                        target: 1500,
                        items: [
                            candidate("flow", "promise", flowLine(newest, 2), 2),
                            candidate("flow", "gate", flowLine(older, 3), 1),
                        ],
                        flow: { timeline: true, titles: 0, full },
                    },
                ],
            },
        );
        expect(card.stable).toBe(
            [
                "These records are authoritative for the past, and the scene for the present; recent messages win over both.",
                "",
                "Recent events (oldest first; the last is just before the messages below):",
                "[m:flow:gate] 3 turns ago: (Dawn) Gate opened: Ada unlocked the gate.",
                '[m:flow:promise] 2 turns ago: (Noon) Promise: Ben agreed to return. "I will return." (Ben) "Before sunset."',
            ].join("\n"),
        );
        expect(card.volatile).toBe("");
        expect(card.items.map(({ id, reason }) => [id, reason])).toEqual([
            ["promise", "timeline"],
            ["gate", "timeline"],
        ]);
    });

    it("counts optional plain forms once and keeps fitting key lines on the card", async () => {
        const newestTitle = "[m:flow:newest] 2 turns ago: Promise";
        const olderTitle = "[m:flow:older] 3 turns ago: Arrival";
        const newestPlain = "[m:flow:newest] 2 turns ago: (Noon) Promise: Return tomorrow.";
        const newestKeyed = `${newestPlain} "I will return." (Ben)`;
        const older = "[m:flow:older] 3 turns ago: (Dawn) Arrival: Reached the gate.";
        const costs = new Map([
            [newestTitle, 1],
            [olderTitle, 1],
            [newestPlain, 3],
            [newestKeyed, 9],
            [older, 2],
        ]);
        for (const { maximum, newestLine, newestTokens } of [
            { maximum: 5, newestLine: newestPlain, newestTokens: 3 },
            { maximum: 11, newestLine: newestKeyed, newestTokens: 9 },
        ]) {
            const countedLines: string[] = [];
            const card = await spentCard(
                {
                    tokenizeChat: async ({ content }) => {
                        if (content.startsWith("[m:")) countedLines.push(content);
                        // Headers cost zero; rendered parts cost the sum of their whole lines.
                        return content.split("\n").reduce((sum, line) => sum + (costs.get(line) ?? 0), 0);
                    },
                },
                {
                    maximum,
                    lanes: [
                        {
                            lane: "flow",
                            target: maximum,
                            items: [
                                candidate("flow", "newest", newestTitle, 2),
                                candidate("flow", "older", olderTitle, 1),
                            ],
                            flow: {
                                timeline: true,
                                titles: 0,
                                full: [
                                    {
                                        ...candidate("flow", "newest", newestKeyed, 2),
                                        reason: "timeline",
                                        plain: { line: newestPlain },
                                    },
                                    { ...candidate("flow", "older", older, 1), reason: "timeline" },
                                ],
                            },
                        },
                    ],
                },
            );
            expect(card.stable).toBe(
                [
                    "These records are authoritative for the past, and the scene for the present; recent messages win over both.",
                    "",
                    "Recent events (oldest first; the last is just before the messages below):",
                    older,
                    newestLine,
                ].join("\n"),
            );
            expect(card.volatile).toBe("");
            expect(card.items.map(({ id, reason, tokens }) => [id, reason, tokens])).toEqual([
                ["newest", "timeline", newestTokens],
                ["older", "timeline", 2],
            ]);
            expect(card.tokens).toBe(maximum);
            expect(card.excluded).toEqual([]);
            expect(countedLines.toSorted()).toEqual([...costs.keys()].toSorted());
        }
    });

    it("keeps the title-only heading, exact legacy text and last-admitted trimming when the flow target is zero", async () => {
        const titles = [
            { ...candidate("flow", "newest", "[m:flow:newest] 2 turns ago: Promise", 2), reason: "recent" },
            { ...candidate("flow", "older", "[m:flow:older] 3 turns ago: Arrival", 1), reason: "recent" },
        ];
        const lane: Lane<LaneCandidate> = {
            lane: "flow",
            target: Number.MAX_SAFE_INTEGER,
            items: titles,
            flow: { timeline: false, titles: 2, full: [] },
        };
        // Two titles cost 70 when rendered, one costs 25; individually each costs one.
        const tokenizer: MemoryTokenizer = {
            tokenizeChat: async ({ content }) =>
                content.startsWith("[m:") ? 1 : 10 + 15 * (content.match(/\[m:/g)?.length ?? 0) ** 2,
        };
        for (const maximum of [70, 40, 5]) {
            const card = await spentCard(tokenizer, { maximum, lanes: [lane] });
            expect(card).toEqual(
                await spentCard(tokenizer, {
                    maximum,
                    lanes: [{ lane: "flow", target: Number.MAX_SAFE_INTEGER, items: titles }],
                }),
            );
            const lines =
                maximum === 70
                    ? ["[m:flow:older] 3 turns ago: Arrival", "[m:flow:newest] 2 turns ago: Promise"]
                    : maximum === 40
                      ? ["[m:flow:newest] 2 turns ago: Promise"]
                      : [];
            expect(card.stable).toBe(
                lines.length
                    ? [
                          "These records are authoritative for the past, and the scene for the present; recent messages win over both.",
                          "",
                          "Recent events:",
                          ...lines,
                      ].join("\n")
                    : "",
            );
            expect(card.volatile).toBe("");
            expect(card.tokens).toBe(maximum === 70 ? 70 : maximum === 40 ? 25 : 0);
            expect(card.spend).toEqual([{ lane: "flow", target: Number.MAX_SAFE_INTEGER, spent: lines.length }]);
            expect(card.items.map(({ id, reason }) => [id, reason])).toEqual(
                maximum === 70
                    ? [
                          ["newest", "recent"],
                          ["older", "recent"],
                      ]
                    : maximum === 40
                      ? [["newest", "recent"]]
                      : [],
            );
            expect(card.excluded).toEqual(
                maximum === 70
                    ? []
                    : maximum === 40
                      ? [{ id: "older", lane: "flow", kind: "event", reason: "budget" }]
                      : ["newest", "older"].map((id) => ({ id, lane: "flow", kind: "event", reason: "budget" })),
            );
        }
    });

    it("trims an evidence excerpt before the full flow line that satisfies its event requirement", async () => {
        const full = {
            ...candidate("flow", "promise", "[m:flow:promise] 2 turns ago: (Noon) Promise: Return tomorrow"),
            reason: "timeline",
        };
        const lanes: Lane<LaneCandidate>[] = [
            {
                lane: "flow",
                target: 4,
                items: [candidate("flow", "promise", "[m:flow:promise] 2 turns ago: Promise")],
                flow: { timeline: true, titles: 0, full: [full] },
            },
            {
                lane: "evidence",
                target: 2,
                items: [
                    {
                        ...candidate("evidence", "source", '[m:source] user: "Return tomorrow"'),
                        reason: "eventSource",
                        requires: "events:promise",
                    },
                ],
            },
        ];
        // Admission costs 4 + 2, but rendering costs ten for each nonempty part.
        const tokenizer: MemoryTokenizer = {
            tokenizeChat: async ({ content }) =>
                content.startsWith("[m:") ? (content.startsWith("[m:flow:") ? 4 : 2) : content.includes("[m:") ? 10 : 0,
        };
        const roomy = await spentCard(tokenizer, { maximum: 20, lanes });
        expect(roomy.items.map(({ lane, id }) => [lane, id])).toEqual([
            ["flow", "promise"],
            ["evidence", "source"],
        ]);
        const tight = await spentCard(tokenizer, { maximum: 10, lanes });
        expect(tight.items.map(({ lane, id, reason }) => [lane, id, reason])).toEqual([
            ["flow", "promise", "timeline"],
        ]);
        expect(tight.stable).toContain(full.line);
        expect(tight.volatile).toBe("");
        expect(tight.excluded).toEqual([{ id: "source", kind: "evidence", lane: "evidence", reason: "budget" }]);
        expect(tight.tokens).toBe(10);
    });

    it("trims a promoted extension line before core titles and evidence without admitting its late source", async () => {
        const newest = {
            ...candidate("flow", "newest", "[m:flow:newest] 2 turns ago: (Noon) Promise: Return tomorrow", 2),
            reason: "timeline",
        };
        const extension = {
            ...candidate("flow", "extension", "[m:flow:extension] 3 turns ago: (Dawn) Arrival: Reached the gate", 1),
            reason: "timeline",
        };
        const lanes: Lane<LaneCandidate>[] = [
            {
                lane: "flow",
                target: 4,
                items: [
                    { ...candidate("flow", "raw", "[m:flow:raw] 1 turn ago: Still here", 3), reason: "recent" },
                    candidate("flow", "newest", "[m:flow:newest] 2 turns ago: Promise", 2),
                    candidate("flow", "extension", "[m:flow:extension] 3 turns ago: Arrival", 1),
                ],
                flow: { timeline: true, titles: 2, full: [newest, extension] },
            },
            {
                lane: "evidence",
                target: 4,
                items: ["newest", "extension"].map((id) => ({
                    ...candidate("evidence", `source-${id}`, `[m:source-${id}] user: "Original ${id}"`),
                    reason: "eventSource",
                    requires: `events:${id}`,
                })),
            },
        ];
        const tokenizer: MemoryTokenizer = {
            tokenizeChat: async ({ content }) =>
                content.startsWith("[m:")
                    ? content.includes("turns ago: (")
                        ? 4
                        : content.startsWith("[m:source-")
                          ? 2
                          : 1
                    : 2 + 4 * (content.match(/\[m:/g)?.length ?? 0) ** 2,
        };
        const roomy = await spentCard(tokenizer, { maximum: 44, lanes });
        expect(roomy.items.map(({ id }) => id)).toEqual(["newest", "raw", "source-newest", "extension"]);
        expect(roomy.excluded).toEqual([
            { id: "source-extension", kind: "evidence", lane: "evidence", reason: "budget" },
        ]);
        // Three stable lines cost 38 and evidence costs 6. Removing the last admission leaves 18 + 6.
        const tight = await spentCard(tokenizer, { maximum: 35, lanes });
        expect(tight.items.map(({ id, reason }) => [id, reason])).toEqual([
            ["newest", "timeline"],
            ["raw", "recent"],
            ["source-newest", "eventSource"],
        ]);
        expect(tight.excluded).toEqual([
            { id: "source-extension", kind: "evidence", lane: "evidence", reason: "budget" },
            { id: "extension", kind: "event", lane: "flow", reason: "budget" },
        ]);
        expect(tight.stable).toContain(newest.line);
        expect(tight.stable).not.toContain("Arrival");
        expect(tight.volatile).toContain('[m:source-newest] user: "Original newest"');
        expect(tight.tokens).toBe(24);
    });

    const pageItem = (lane: "required" | "pages", id: string, body: string): LaneCandidate => ({
        ...candidate(lane, id, `[m:${id}] ${body}`),
        kind: "page",
    });

    it("refuses the entire required lane above its cap and names every page", async () => {
        const required = [
            pageItem("required", "scene", "At the gate"),
            pageItem("required", "charter", "Keep the promise"),
        ];
        const tokens = required.reduce((sum, { line }) => sum + line.length, 0);
        const result = await buildMemoryCard(
            { tokenizeChat: async ({ content }) => content.length },
            {
                maximum: 10000,
                lanes: [{ lane: "required", target: tokens - 1, items: required }],
            },
        );
        expect(result).toEqual({
            type: "requiredOverLimit",
            tokens,
            limit: tokens - 1,
            pages: [
                { id: "scene", tokens: "[m:scene] At the gate".length },
                { id: "charter", tokens: "[m:charter] Keep the promise".length },
            ],
        });
        const exact = await spentCard(
            { tokenizeChat: async ({ content }) => content.length },
            {
                maximum: 10000,
                lanes: [{ lane: "required", target: tokens, items: required }],
            },
        );
        expect(exact.items.map(({ id }) => id)).toEqual(["scene", "charter"]);
    });

    it("refuses required pages that fit their cap but exceed the memory maximum with the card frame", async () => {
        // Required lines cost 10 each; their rendered card, including its header, costs 25.
        const tokenizer = {
            tokenizeChat: async ({ content }: { content: string }) => (content.startsWith("[m:") ? 10 : 25),
        };
        const lanes: Lane<LaneCandidate>[] = [
            {
                lane: "required",
                target: 20,
                items: [pageItem("required", "scene", "Dawn"), pageItem("required", "charter", "Be kind")],
            },
        ];
        expect(await buildMemoryCard(tokenizer, { maximum: 24, lanes })).toEqual({
            type: "requiredOverLimit",
            tokens: 25,
            limit: 24,
            pages: [
                { id: "scene", tokens: 10 },
                { id: "charter", tokens: 10 },
            ],
        });
        const exact = await spentCard(tokenizer, { maximum: 25, lanes });
        expect(exact.stable).toContain("[m:scene] Dawn");
        expect(exact.stable).toContain("[m:charter] Be kind");
    });

    it("reserves required pages before lending and skips an oversized related page whole", async () => {
        const large = pageItem("pages", "large", "First section | Last section");
        const small = pageItem("pages", "small", "Complete small page");
        const tokenizer = {
            tokenizeChat: async ({ content }: { content: string }) => {
                if (content.startsWith("[m:large]")) return 90;
                if (content.startsWith("[m:")) return 10;
                return 5 + (content.match(/\[m:/g)?.length ?? 0) * 10;
            },
        };
        const card = await spentCard(tokenizer, {
            maximum: 40,
            lanes: [
                { lane: "required", target: 10, items: [pageItem("required", "scene", "Whole scene")] },
                { lane: "pages", target: 5, items: [large, small] },
            ],
        });
        expect(card.stable).toContain("[m:scene] Whole scene");
        expect(card.volatile).toContain("[m:small] Complete small page");
        expect(card.volatile).not.toMatch(/large|First section|Last section/);
        expect(card.items.map(({ id, lane, kind }) => ({ id, lane, kind }))).toEqual([
            { id: "scene", lane: "required", kind: "page" },
            { id: "small", lane: "pages", kind: "page" },
        ]);
        expect(card.excluded).toEqual([{ id: "large", kind: "page", lane: "pages", reason: "budget" }]);
        expect(card.spend).toEqual([
            { lane: "required", target: 10, spent: 10 },
            { lane: "pages", target: 5, spent: 10 },
        ]);
    });

    it("separates stable flow from volatile items with single-line, safe, distinct tags", async () => {
        const event = {
            id: "a ] [m:forged]\ud800",
            title: "문을\n열다",
            summary: "약속을\n기억한다",
            storyTime: { text: "그날" },
            keyLines: [{ speaker: "민수", text: "다시\n만나자" }],
        };
        const encoded = "a%20%5D%20%5Bm%3Aforged%5D%EF%BF%BD";
        expect(itemTag({ lane: "events", id: event.id })).toBe(`[m:${encoded}]`);
        expect(itemTag({ lane: "flow", id: event.id })).toBe(`[m:flow:${encoded}]`);
        const result = await spentCard(
            { tokenizeChat: async ({ content }) => content.length },
            {
                maximum: 10000,
                lanes: [
                    { lane: "flow", target: 1000, items: [candidate("flow", event.id, flowLine(event, 3))] },
                    { lane: "events", target: 1000, items: [candidate("events", event.id, eventLine(event))] },
                    {
                        lane: "evidence",
                        target: 1000,
                        items: [candidate("evidence", "message", evidenceLine("message", "user", "다시\n만나자"))],
                    },
                    {
                        lane: "threads",
                        target: 1000,
                        items: [
                            candidate(
                                "threads",
                                "thread",
                                threadLine({ id: "thread", title: "기다림\n계속", state: "paused" }),
                            ),
                        ],
                    },
                ],
            },
        );
        expect(result.stable).toMatch(/authoritative for the past.*scene for the present; recent messages win/);
        expect(result.stable.split("\n").filter((line) => line.startsWith("[m:"))).toEqual([
            `[m:flow:${encoded}] 3 turns ago: 문을 열다`,
        ]);
        expect(result.volatile.split("\n").filter((line) => line.startsWith("[m:"))).toEqual([
            `[m:${encoded}] (그날) 문을 열다: 약속을 기억한다 "다시 만나자" (민수)`,
            '[m:message] user: "다시 만나자"',
            "[m:thread] 기다림 계속 (paused)",
        ]);
        expect(result.stable + result.volatile).not.toContain("[m:forged]");
        expect(result.items.map(({ lane, id }) => ({ lane, id }))).toEqual([
            { lane: "flow", id: event.id },
            { lane: "events", id: event.id },
            { lane: "evidence", id: "message" },
            { lane: "threads", id: "thread" },
        ]);
    });

    it("recounts each rendered part as one system chat and removes whole items until the maximum holds", async () => {
        // Independent line costs undercount a rendered part: combining two tagged lines costs 70.
        const cost = (content: string) =>
            content.startsWith("[m:") ? 1 : 10 + 15 * (content.match(/\[m:/g)?.length ?? 0) ** 2;
        const tokenizer: MemoryTokenizer = {
            tokenizeChat: async (chat) => {
                expect(chat.role).toBe("system");
                return cost(chat.content);
            },
        };
        const lanes: Lane<LaneCandidate>[] = [
            { lane: "flow", target: 100, items: [candidate("flow", "e", "[m:flow:e] 2 turns ago: Promise")] },
            { lane: "events", target: 100, items: [candidate("events", "e", "[m:e] Promise: return tomorrow")] },
            {
                lane: "evidence",
                target: 100,
                items: [
                    {
                        ...candidate("evidence", "u", '[m:u] user: "return tomorrow"'),
                        requires: "events:e",
                        score: 0.9,
                    },
                ],
            },
        ];
        const result = await spentCard(tokenizer, { maximum: 70, lanes });
        expect(result.items.map(({ lane }) => lane)).toEqual(["flow", "events"]);
        expect(result.stable).toContain("[m:flow:e] 2 turns ago: Promise");
        expect(result.volatile).toContain("[m:e] Promise: return tomorrow");
        expect(result.volatile).not.toContain("[m:u]");
        expect(result.tokens).toBe(50);
        expect(cost(result.stable) + cost(result.volatile)).toBeLessThanOrEqual(70);
        expect(result.excluded).toEqual([{ id: "u", kind: "evidence", lane: "evidence", reason: "budget" }]);
        expect(result.spend.find(({ lane }) => lane === "evidence")?.spent).toBe(0);
        const empty = await spentCard(tokenizer, { maximum: 5, lanes });
        expect({ stable: empty.stable, volatile: empty.volatile, tokens: empty.tokens, items: empty.items }).toEqual({
            stable: "",
            volatile: "",
            tokens: 0,
            items: [],
        });
    });
});
