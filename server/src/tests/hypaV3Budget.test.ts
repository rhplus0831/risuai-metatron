// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseContextReport, type ContextReport } from "../../../shared/contextReport.ts";
import { createHypaV3Preset, resolveHypaV3Budget } from "../../../shared/hypaV3Presets.ts";
import { normalizeHypaV3Presets } from "../data/normalize/collections.ts";

describe("HypaV3 budget settings", () => {
    it("defaults unknown budget modes and accepts only nonnegative integer token amounts", () => {
        const defaults = {
            memoryBudgetTokens: 6000,
            lookaheadHeadroomTokens: 4000,
            extraSummarizationTokens: 0,
        };
        expect(createHypaV3Preset().settings).toMatchObject({ budgetMode: "ratio", ...defaults });
        for (const budgetMode of [undefined, null, "", "token", "Tokens", 1, false]) {
            expect(createHypaV3Preset("Imported", { budgetMode }).settings.budgetMode).toBe("ratio");
        }
        for (const [field, fallback] of Object.entries(defaults)) {
            for (const value of [-1, 1.5, NaN, Infinity, -Infinity, "12", null]) {
                expect(
                    createHypaV3Preset("Imported", { [field]: value }).settings,
                    `${field} = ${value}`,
                ).toMatchObject({
                    [field]: fallback,
                });
            }
            for (const value of [0, 17]) {
                expect(createHypaV3Preset("Imported", { [field]: value }).settings).toMatchObject({ [field]: value });
            }
        }
        for (const budgetMode of ["ratio", "tokens"] as const) {
            const settings = {
                budgetMode,
                memoryBudgetTokens: 123,
                lookaheadHeadroomTokens: 45,
                extraSummarizationTokens: 6,
                memoryTokensRatio: 0.25,
                lookaheadHeadroomRatio: 0.125,
                extraSummarizationRatio: 0.5,
            };
            expect(createHypaV3Preset("Switchable", settings).settings).toMatchObject(settings);
        }
    });

    it("keeps stored presets in ratio mode and seeds a missing collection in token mode", () => {
        const settings = { memoryTokensRatio: 0.25, lookaheadHeadroomRatio: 0.125, extraSummarizationRatio: 0.5 };
        const stored = { items: [{ id: "old", name: "Old", settings }], selectedId: "old" };
        const normalized = normalizeHypaV3Presets(stored);
        expect(normalized.items[0].settings).toMatchObject({ ...settings, budgetMode: "ratio" });
        expect(normalizeHypaV3Presets(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
        expect(stored.items[0].settings).not.toHaveProperty("budgetMode");
        const seeded = normalizeHypaV3Presets(undefined);
        expect(seeded.items).toHaveLength(1);
        expect(seeded.items[0].settings).toMatchObject({
            budgetMode: "tokens",
            memoryBudgetTokens: 6000,
            lookaheadHeadroomTokens: 4000,
            extraSummarizationTokens: 0,
        });
        expect(normalizeHypaV3Presets(JSON.parse(JSON.stringify(seeded)))).toEqual(seeded);
    });
});

describe("resolveHypaV3Budget", () => {
    it("preserves the ratio expressions and never reduces ratio budgets", () => {
        // Non-binary ratios deliberately preserve the old floating-point order of operations.
        const settings = createHypaV3Preset("Ratios", {
            budgetMode: "ratio",
            memoryTokensRatio: 0.333,
            lookaheadHeadroomRatio: 0.15,
            extraSummarizationRatio: 0.17,
            memoryBudgetTokens: 1,
            lookaheadHeadroomTokens: 2,
            extraSummarizationTokens: 3,
        }).settings;
        expect(resolveHypaV3Budget(settings, 1001, 1001)).toEqual({
            memoryTokens: 333,
            targetTokens: 1001 * (1 - 0.17),
            lookaheadTrigger: 1001 * (1 - 0.15),
            lookaheadTarget: 1001 * (1 - 0.15 - 0.17),
            reduced: [],
        });
        expect(
            resolveHypaV3Budget({ ...settings, lookaheadHeadroomRatio: 0.875, extraSummarizationRatio: 0.25 }, 1001, 0)
                .lookaheadTarget,
        ).toBe(0);
    });

    it("reduces token amounts to half the prompt budget, freeing headroom before extra", () => {
        // C = 1024, maxResponse = 129: P = 895, half = 447 (rounded down).
        const cases = [
            { amounts: [128, 64, 32], response: 129, expected: [128, 992, 960, 928], reduced: [] },
            {
                amounts: [600, 64, 32],
                response: 129,
                expected: [447, 992, 960, 928],
                reduced: [{ field: "memory", configured: 600, applied: 447 }],
            },
            {
                amounts: [128, 300, 200],
                response: 129,
                expected: [128, 824, 777, 577],
                reduced: [{ field: "headroom", configured: 300, applied: 247 }],
            },
            {
                amounts: [128, 0, 600],
                response: 129,
                expected: [128, 577, 1024, 577],
                reduced: [{ field: "extra", configured: 600, applied: 447 }],
            },
            {
                amounts: [600, 300, 600],
                response: 129,
                expected: [447, 577, 1024, 577],
                reduced: [
                    { field: "memory", configured: 600, applied: 447 },
                    { field: "headroom", configured: 300, applied: 0 },
                    { field: "extra", configured: 600, applied: 447 },
                ],
            },
            ...[1024, 1200].map((response) => ({
                amounts: [128, 64, 32],
                response,
                expected: [0, 1024, 1024, 1024],
                reduced: [
                    { field: "memory", configured: 128, applied: 0 },
                    { field: "headroom", configured: 64, applied: 0 },
                    { field: "extra", configured: 32, applied: 0 },
                ],
            })),
        ];
        for (const {
            amounts: [memory, headroom, extra],
            response,
            expected,
            reduced,
        } of cases) {
            const settings = createHypaV3Preset("Tokens", {
                budgetMode: "tokens",
                memoryBudgetTokens: memory,
                lookaheadHeadroomTokens: headroom,
                extraSummarizationTokens: extra,
            }).settings;
            const before = structuredClone(settings);
            const [memoryTokens, targetTokens, lookaheadTrigger, lookaheadTarget] = expected;
            expect(
                resolveHypaV3Budget(settings, 1024, response),
                JSON.stringify({ memory, headroom, extra, response }),
            ).toEqual({
                memoryTokens,
                targetTokens,
                lookaheadTrigger,
                lookaheadTarget,
                reduced,
            });
            expect(settings).toEqual(before);
        }
    });
});

describe("context report budget reductions", () => {
    it("accepts nonempty budget reductions and rejects malformed entries and containers", () => {
        const report: ContextReport = {
            v: 1,
            maxContext: 1024,
            maxResponse: 128,
            input: 0,
            sections: [],
            adjustment: 0,
            attributionExact: true,
            tokenScope: "test",
            historyDigest: "empty",
            history: { total: 0, kept: 0, totalUser: 0, keptUser: 0, droppedTokens: 0 },
            lore: { budgetUsed: 0, budget: 0, rejectedCount: 0, rejectedTokens: 0, active: 0 },
            memory: {
                kind: "hypaV3",
                tokens: 0,
                budget: 448,
                coverage: "covered",
                budgetReduced: [
                    { field: "memory", configured: 6000, applied: 448 },
                    { field: "headroom", configured: 4000, applied: 0 },
                    { field: "extra", configured: 500, applied: 448 },
                ],
            },
        };
        expect(parseContextReport(report)).toBe(report);
        expect(parseContextReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
        const valid = { field: "memory", configured: 6000, applied: 448 };
        const malformed: unknown[] = [
            [],
            {},
            "reduced",
            null,
            [{ ...valid, field: "response" }],
            [{ field: "memory", configured: 6000 }],
        ];
        for (const count of ["configured", "applied"]) {
            for (const value of [-1, NaN, Infinity, -Infinity, "448"]) {
                malformed.push([{ ...valid, [count]: value }]);
            }
        }
        for (const budgetReduced of malformed) {
            expect(
                parseContextReport({ ...report, memory: { ...report.memory, budgetReduced } }),
                String(budgetReduced),
            ).toBeNull();
        }
        const { budgetReduced: _omitted, ...memory } = report.memory!;
        expect(parseContextReport({ ...report, memory })).not.toBeNull();
    });
});
