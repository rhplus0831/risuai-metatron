// @vitest-environment node
import { describe, expect, it } from "vitest";
import { admitAnalysis, parseAnalysis } from "./analysis.ts";

const draft = (overrides: Record<string, unknown> = {}) => ({
    title: "The promise",
    summary: "Cara promises to return.",
    participants: [],
    keyLines: [],
    stateChanges: [],
    knowledge: [],
    relationshipShifts: [],
    openThreads: { add: [], close: [], transitions: [] },
    ...overrides,
});

describe("analysis admission", () => {
    it("bounds strings and lists, reports discarded elements, and rounds and clamps axes", () => {
        const lines = Array.from({ length: 6 }, (_, i) => ({ speaker: "Cara", text: `Line ${i}` }));
        const threads = Array.from({ length: 9 }, (_, i) => ({ title: `Promise ${i}`, who: [] }));
        const parsed = parseAnalysis(
            `<Thoughts>{not JSON}</Thoughts>\n\`\`\`json\n${JSON.stringify({
                event: draft({
                    title: `${"t".repeat(119)}😀tail`,
                    summary: "s".repeat(801),
                    keyLines: [null, ...lines],
                    openThreads: { add: threads, close: [], transitions: [] },
                    axes: { persistence: -2, change: 1.6, reach: 20 },
                    grade: 99,
                    id: "model-owned-id",
                }),
                pageCandidates: [{ create: { type: "character", title: "Ignored" } }],
            })}\n\`\`\``,
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(parsed.error);
        expect(parsed.analysis.event).toMatchObject({
            title: "t".repeat(119),
            summary: "s".repeat(800),
            keyLines: lines.slice(0, 5),
            openThreads: { add: threads.slice(0, 8), close: [], transitions: [] },
            axes: { persistence: 0, change: 2, reach: 3 },
        });
        expect(parsed.analysis.event).not.toHaveProperty("grade");
        expect(parsed.analysis.event).not.toHaveProperty("id");
        expect(parsed.analysis.pageCandidates).toEqual([]);
        expect(parsed.warnings).toEqual([
            { kind: "malformed", detail: "keyLines: 1" },
            { kind: "capped", detail: "keyLines: 1" },
            { kind: "capped", detail: "openThreads.add: 1" },
        ]);
    });

    it("rejects missing or mistyped required fields with the offending field name", () => {
        for (const field of [
            "title",
            "summary",
            "participants",
            "keyLines",
            "stateChanges",
            "knowledge",
            "relationshipShifts",
            "openThreads",
        ]) {
            for (const invalid of [undefined, 42]) {
                expect(parseAnalysis(JSON.stringify(draft({ [field]: invalid }))), field).toEqual({
                    ok: false,
                    reason: "invalidField",
                    error: expect.stringContaining(`"${field}"`),
                });
            }
        }
        for (const field of ["add", "close", "transitions"]) {
            expect(
                parseAnalysis(
                    JSON.stringify(draft({ openThreads: { add: [], close: [], transitions: [], [field]: null } })),
                ),
            ).toEqual({
                ok: false,
                reason: "invalidField",
                error: expect.stringContaining(`"openThreads.${field}"`),
            });
        }
    });

    it("stores summed event and knowledge grades and leaves missing or incomplete axes ungraded", () => {
        for (const [axes, grade] of [
            [{ persistence: 1, change: 2, reach: 3 }, 6],
            [undefined, undefined],
            [{ persistence: 3, change: 3 }, undefined],
        ] as const) {
            const parsed = parseAnalysis(
                JSON.stringify(
                    draft({
                        axes,
                        grade: 9,
                        knowledge: [
                            {
                                pageId: "cara",
                                fact: "She will return",
                                stance: "knows",
                                quote: "I will return.",
                                axes,
                                grade: 9,
                            },
                        ],
                    }),
                ),
            );
            if (!parsed.ok) throw new Error(parsed.error);
            const admitted = admitAnalysis({
                draft: parsed.analysis.event,
                warnings: parsed.warnings,
                window: {
                    messages: [{ chatId: "m1", role: "char", data: "I will return." }],
                    sources: [{ messageId: "m1", hash: "raw-message-hash", index: 0 }],
                },
                runId: "run",
                pages: new Set(["cara"]),
                threads: new Map(),
                lastEvent: null,
                messages: [],
                newId: () => "event",
            });
            expect(admitted.event.knowledge).toHaveLength(1);
            for (const record of [admitted.event, admitted.event.knowledge[0]]) {
                if (grade === undefined) {
                    expect(record).not.toHaveProperty("axes");
                    expect(record).not.toHaveProperty("grade");
                } else {
                    expect(record).toMatchObject({ axes, grade: 6 });
                }
            }
        }
    });
});
