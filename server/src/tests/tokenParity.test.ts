// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { get_encoding, type Tiktoken } from "@dqbd/tiktoken";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTokenizers, TOKENIZER_FAMILIES, type TokenizerFamily } from "../prompt/tokenizers/index.ts";
import { loadAll } from "../prompt/tokenizers/loadAll.ts";
import { createTokenCounter, isTokenizerTextRefusal, type TokenCountScope } from "../prompt/tokens.ts";
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

describe.each(["cl100k_base", "o200k_base"] as const)("bounded tiktoken encoding: %s", (family) => {
    let native: Tiktoken;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    beforeAll(async () => {
        native = get_encoding(family);
        await tokenizers.load(family);
    });
    afterAll(() => native.free());
    afterEach(() => vi.restoreAllMocks());

    async function encodeWithCalls(text: string) {
        // Observe the real package boundary, including its ordinary-text fast path.
        const prototype = Object.getPrototypeOf(native) as Tiktoken;
        const encode = vi.spyOn(prototype, "encode");
        const ordinary = vi.spyOn(prototype, "encode_ordinary");
        const ids = Uint32Array.from(await tokenizers.encode(family, text));
        const pieces = [...encode.mock.calls, ...ordinary.mock.calls].map(([piece]) => piece);
        return { ids, pieces };
    }

    it.each([
        ["letters", "abcdefghijklmnop".repeat(128)],
        [
            family === "cl100k_base" ? "punctuation and marks" : "punctuation with a slash/newline tail",
            family === "cl100k_base" ? "!\u0301".repeat(700) : "!" + "/\n".repeat(1024),
        ],
        // An odd ASCII prefix exposes cuts that advance through individual surrogate code units.
        ["astral letters at an unaligned boundary", "abc" + "\u{10428}".repeat(600)],
    ])("encodes overlong %s in bounded pieces and decodes exactly", async (_name, text) => {
        const { ids, pieces } = await encodeWithCalls(text);
        expect(pieces.length).toBeGreaterThan(1);
        for (const piece of pieces) {
            expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(512);
        }
        expect(pieces.join("")).toBe(text);
        expect(decoder.decode(native.decode(ids))).toBe(text);
    });

    it.each([
        [
            "English prose",
            (
                "The editor reads the draft beside an open window. She checks each paragraph for clear examples, " +
                "then adds a note about the next review. Across the room, a colleague compares the revised story " +
                "with the original and writes down the questions they will discuss after lunch. "
            ).repeat(2),
        ],
        [
            "Korean prose",
            (
                "편집자는 창가에 앉아 원고를 읽습니다. 문장마다 예시가 분명한지 확인하고 다음 검토를 위한 메모를 남깁니다. " +
                "동료는 수정한 이야기와 원본을 비교하며 점심 뒤에 함께 이야기할 질문을 적습니다. "
            ).repeat(3),
        ],
        ["a run just below the byte limit", "a".repeat(511)],
        ["a Unicode long-s contraction between bounded runs", "a".repeat(509) + "'\u017f" + "a".repeat(510)],
    ])("keeps package ids and one whole-text call for %s", async (_name, text) => {
        const expected = native.encode(text);
        const { ids, pieces } = await encodeWithCalls(text);
        expect(ids).toEqual(expected);
        expect(pieces).toEqual([text]);
    });

    it.each([
        ["inside split text", "a".repeat(1024) + " <|endoftext|> " + "b".repeat(1024)],
        // Without whole-text validation, the punctuation piece cuts after the first '<'.
        ["across a cut", "!".repeat(511) + "<|endoftext|>" + "a".repeat(1024)],
    ])("refuses a special token %s with a recognized text refusal", async (_name, text) => {
        await expect(tokenizers.encode(family, text)).rejects.toSatisfy(isTokenizerTextRefusal);
        await expect(tokenizers.count(family, text)).rejects.toSatisfy(isTokenizerTextRefusal);
    });

    it("keeps the package path for a Unicode-table difference even beside overlong runs", async () => {
        // Sidetic is in the loader's measured package/Node Unicode-table differences.
        const text = "a".repeat(1025) + "\u{10940}" + "b".repeat(1025);
        const expected = native.encode(text);
        const { ids, pieces } = await encodeWithCalls(text);
        expect(ids).toEqual(expected);
        expect(pieces).toEqual([text]);
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
            "%s gives the captured family ids with corrected llama3 overrides",
            async (name) => {
                const entry = routing[name];
                for (const [textName, record] of Object.entries(entry.texts)) {
                    // These overrides now select Llama 3. Both captures use the same text fixtures.
                    const expected =
                        name === "reverse-proxy-llama3" || name === "plugin-legacy-llama3"
                            ? fixture.families.llama3[textName]
                            : record;
                    await expectBrowserRecord(
                        () => counter.encode(materialize(texts[textName]), scopeOf(name)),
                        expected,
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

    it("counts Llama 3 custom and legacy-plugin overrides against frozen ids with caching enabled", async () => {
        const counter = createTokenCounter({ tokenizers });
        const text = materialize(fixture.texts.mixed);
        const record = fixture.families.llama3.mixed;
        if (!("ids" in record)) throw new Error("The mixed Llama 3 fixture needs ids");
        for (const aiModel of ["reverse_proxy", "custom"]) {
            const selected = scope({
                aiModel,
                customTokenizer: "llama3",
                pluginTokenizer: "llama3",
                useTokenizerCaching: true,
            });
            expect(await counter.count(text, selected)).toBe(record.ids.length);
            await expectBrowserRecord(() => counter.encode(text, selected), record);
            expect(await counter.count(text, selected)).toBe(record.ids.length);
        }
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
    it(
        "counts the smoke strings for every family as the browser does",
        { tags: ["slow"], timeout: 60_000 },
        async () => {
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
        },
    );
});
