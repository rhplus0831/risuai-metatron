// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTokenizers, TOKENIZER_FAMILIES, type TokenizerFamily } from "../prompt/tokenizers/index.ts";
import { loadAll } from "../prompt/tokenizers/loadAll.ts";
import { createTokenCounter, type TokenCountScope } from "../prompt/tokens.ts";
import { LLMTokenizer } from "../../../shared/llm.ts";
import {
    BASELINE_DIR,
    baselineCounts,
    baselineScenario,
    expectBrowserRecord,
    fixture,
    materialize,
    REPO_ROOT,
    scope,
    TEXT_NAMES,
} from "./tokenFixtures.ts";

/**
 * The server tokenizers against the browser's captured ids, in process: every family on every
 * fixture text, the counter's routing capture, the lore delta, and `loadAll`. One tokenizer set
 * serves the encode checks, so each family's payload loads once in this file (the cold and
 * concurrent loads are `tokenPlainNode.test.ts`'s).
 */
const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
afterAll(() => tokenizers.dispose());

describe("browser parity in process", () => {
    it.each(TOKENIZER_FAMILIES)(
        "%s gives the browser's ids for every fixture text",
        async (family) => {
            for (const name of TEXT_NAMES) {
                const text = materialize(fixture.texts[name]);
                await expectBrowserRecord(() => tokenizers.encode(family, text), fixture.families[family][name]);
            }
        },
        60_000,
    );

    it("count is the id count, and empty input counts zero everywhere", async () => {
        for (const family of TOKENIZER_FAMILIES) {
            expect(await tokenizers.count(family, "")).toBe(0);
            const record = fixture.families[family].mixed as { ids: number[] };
            expect(await tokenizers.count(family, materialize(fixture.texts.mixed))).toBe(record.ids.length);
        }
    });

    it("the tiktoken families reject special-token text as the client does, and stay usable", async () => {
        for (const family of ["cl100k_base", "o200k_base"] as const) {
            await expect(tokenizers.count(family, "a <|endoftext|> b")).rejects.toThrow("special token");
            expect(await tokenizers.count(family, "hello world")).toBe(2);
        }
    });
});

describe("createTokenCounter", () => {
    describe("against the browser's routing capture (token-counts.json `routing`)", () => {
        const counter = createTokenCounter({ tokenizers });
        const routing = baselineCounts.routing;
        const texts = baselineScenario.tokens.texts;

        /** The scope the capture's settings resolve to (the client resolved the catalogue family itself). */
        function scopeOf(name: string): TokenCountScope {
            const entry = routing[name];
            return scope({
                aiModel: entry.settings.aiModel,
                currentPluginProvider: entry.settings.currentPluginProvider ?? "",
                model: {
                    tokenizer: LLMTokenizer[entry.resolvedTokenizer],
                    internalID: entry.settings.customModels?.[0]?.internalId,
                },
                pluginTokenizer: entry.providerOptions?.tokenizer ?? "none",
                customTokenizer: entry.settings.customTokenizer ?? "tik",
                googleClaudeTokenizing: entry.settings.googleClaudeTokenizing ?? false,
            });
        }

        it("the capture covers the plugin branches and the Google toggle", () => {
            expect(Object.keys(routing)).toContain("plugin-legacy-custom-func");
            expect(Object.keys(routing)).toContain("plugin-legacy-no-options");
            expect(routing["gemini-no-google-count"].settings.googleClaudeTokenizing).toBe(false);
        });

        it.each(Object.keys(baselineCounts.routing).filter((name) => name !== "plugin-legacy-custom-func"))(
            "%s gives the browser's ids for every captured text",
            async (name) => {
                const entry = routing[name];
                for (const [textName, record] of Object.entries(entry.texts)) {
                    await expectBrowserRecord(
                        () => counter.encode(materialize(texts[textName]), scopeOf(name)),
                        record,
                    );
                }
            },
            60_000,
        );

        it("plugin-legacy-custom-func counts with cl100k_base instead of the plugin's function (the recorded difference)", async () => {
            const name = "plugin-legacy-custom-func";
            expect(routing[name].providerOptions?.tokenizer).toBe("custom");
            // The browser answered the plugin's own `tokenizerFunc` (three ids per text).
            expect((routing[name].texts.ascii as { ids: number[] }).ids).toHaveLength(3);
            const expected = routing["plugin-legacy-cl100k"].texts;
            for (const [textName, record] of Object.entries(expected)) {
                await expectBrowserRecord(() => counter.encode(materialize(texts[textName]), scopeOf(name)), record);
            }
        }, 60_000);
    });

    describe("the lore prompt's token delta (deltas/lore-regex-fix-token-counts.json)", () => {
        const delta = JSON.parse(
            readFileSync(path.join(BASELINE_DIR, "deltas/lore-regex-fix-token-counts.json"), "utf8"),
        ) as {
            prompts: {
                lore: {
                    insertAt: number;
                    inserted: { role: string; content: string }[];
                    families: Record<string, { inserted: number[]; perMessage: number[]; total: number }>;
                };
            };
        };
        const promptsDelta = JSON.parse(
            readFileSync(path.join(BASELINE_DIR, "deltas/lore-regex-fix-prompts.json"), "utf8"),
        ) as {
            fixtures: { lore: { insertAt: number; inserted: { role: string; content: string }[] } };
        };
        const lore = delta.prompts.lore;

        it("inserts the same two messages at the same index as the prompts delta, for every captured family", () => {
            expect(lore.inserted).toEqual(promptsDelta.fixtures.lore.inserted);
            expect(lore.insertAt).toBe(promptsDelta.fixtures.lore.insertAt);
            expect(Object.keys(lore.families).sort()).toEqual(Object.keys(baselineCounts.prompts.lore).sort());
            for (const [family, after] of Object.entries(lore.families)) {
                const before = baselineCounts.prompts.lore[family];
                expect(after.perMessage, family).toEqual([
                    ...before.perMessage.slice(0, lore.insertAt),
                    ...after.inserted,
                    ...before.perMessage.slice(lore.insertAt),
                ]);
                expect(after.total, family).toBe(before.total + after.inserted[0] + after.inserted[1]);
                expect(
                    after.perMessage.reduce((a, b) => a + b, 0),
                    family,
                ).toBe(after.total);
            }
        });

        it("the server's tokenizers count the two inserted messages as the delta records, per family", async () => {
            for (const [family, after] of Object.entries(lore.families)) {
                const counts = [];
                for (const message of lore.inserted) {
                    counts.push(await tokenizers.count(family as TokenizerFamily, message.content));
                }
                expect(counts, family).toEqual(after.inserted);
            }
        }, 60_000);
    });
});

describe("loadAll in process", () => {
    it("counts the smoke strings for every family as the browser does", async () => {
        const report = await loadAll(REPO_ROOT);
        expect(report.families).toHaveLength(TOKENIZER_FAMILIES.length);
        for (const entry of report.families) {
            expect(entry).not.toHaveProperty("error");
            if ("counts" in entry) {
                const expected = TEXT_NAMES.slice(0, 3).map(
                    (name) => (fixture.families[entry.family][name] as { ids: number[] }).ids.length,
                );
                expect(entry.counts, entry.family).toEqual(expected);
            }
        }
    }, 60_000);
});
