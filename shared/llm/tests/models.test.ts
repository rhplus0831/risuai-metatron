import { describe, expect, it } from "vitest";
import { BASE_LLM_MODELS, dynamicModelOf, resolveModelInfo } from "../models.ts";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "../types.ts";

describe("static model catalogue", () => {
    it("has unique ids including generated Responses API and Vertex variants", () => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const { id } of BASE_LLM_MODELS) {
            if (seen.has(id)) duplicates.add(id);
            seen.add(id);
        }
        expect([...duplicates].sort()).toEqual([]);
    });

    it.each([
        ["gemini-flash-latest", "Gemini Flash Latest"],
        ["gemini-4-argon", "Gemini 4 Argon"],
    ])("resolves %s with its Gemini API capabilities", (id, name) => {
        const model = resolveModelInfo(id);
        expect(model).toMatchObject({
            id,
            name,
            internalID: id,
            provider: LLMProvider.GoogleCloud,
            format: LLMFormat.GoogleCloud,
            tokenizer: LLMTokenizer.GoogleCloud,
            parameters: ["reasoning_effort"],
            recommended: true,
        });
        expect(model.flags.toSorted()).toEqual(
            [
                LLMFlags.hasImageInput,
                LLMFlags.poolSupported,
                LLMFlags.hasAudioInput,
                LLMFlags.hasVideoInput,
                LLMFlags.hasStreaming,
                LLMFlags.requiresAlternateRole,
                LLMFlags.geminiThinking,
                LLMFlags.geminiThinkingNoMinimal,
                LLMFlags.hasFirstSystemPrompt,
            ].sort(),
        );
    });

    it("recommends Flash Latest and Argon instead of the Gemini 3 series", () => {
        const recommended = BASE_LLM_MODELS.filter(
            (model) =>
                model.provider === LLMProvider.GoogleCloud &&
                (model.id.startsWith("gemini-3") ||
                    model.id === "gemini-flash-latest" ||
                    model.id === "gemini-4-argon") &&
                model.recommended,
        ).map((model) => model.id);
        expect(recommended.sort()).toEqual(["gemini-4-argon", "gemini-flash-latest"]);
    });

    it("resolves dated and undated GPT 5 ids to their own names and wire ids", () => {
        expect(resolveModelInfo("gpt-5-2025-08-07")).toMatchObject({
            internalID: "gpt-5-2025-08-07",
            name: "GPT 5 (2025-08-07)",
        });
        expect(resolveModelInfo("gpt-5")).toMatchObject({ internalID: "gpt-5", name: "GPT 5" });
    });
});

describe("discovered model ids", () => {
    it.each([
        [
            "dynamic_google_gemini-future",
            "gemini-future",
            LLMProvider.GoogleCloud,
            LLMFormat.GoogleCloud,
            LLMTokenizer.GoogleCloud,
            LLMFlags.geminiThinking,
            "thinking_tokens",
        ],
        [
            "dynamic_google_models/gemini-future",
            "gemini-future",
            LLMProvider.GoogleCloud,
            LLMFormat.GoogleCloud,
            LLMTokenizer.GoogleCloud,
            LLMFlags.geminiThinking,
            "thinking_tokens",
        ],
        [
            "dynamic_anthropic_claude-future",
            "claude-future",
            LLMProvider.Anthropic,
            LLMFormat.Anthropic,
            LLMTokenizer.Claude,
            LLMFlags.claudeAdaptiveThinking,
            "thinking_tokens",
        ],
        [
            "gpt-future",
            "gpt-future",
            LLMProvider.OpenAI,
            LLMFormat.OpenAICompatible,
            LLMTokenizer.tiktokenO200Base,
            LLMFlags.DeveloperRole,
            "reasoning_effort",
        ],
        [
            "gpt-future-response-api",
            "gpt-future",
            LLMProvider.OpenAI,
            LLMFormat.OpenAIResponseAPI,
            LLMTokenizer.tiktokenO200Base,
            LLMFlags.hasPrefill,
            "reasoning_effort",
        ],
    ] as const)(
        "resolves %s without a registry or descriptor",
        (id, internalID, provider, format, tokenizer, flag, parameter) => {
            for (const model of [dynamicModelOf(id), resolveModelInfo(id)]) {
                expect(model).toMatchObject({ id, name: id, internalID, provider, format, tokenizer });
                expect(model!.flags).toEqual(
                    expect.arrayContaining([LLMFlags.hasImageInput, LLMFlags.hasStreaming, flag]),
                );
                expect(model!.parameters).toContain(parameter);
                expect(model!.endpoint).toBeUndefined();
                expect(model!.keyIdentifier).toBeUndefined();
            }
        },
    );

    it("applies profile flags to a dynamic model without changing the next resolution", () => {
        expect(
            resolveModelInfo("dynamic_google_gemini-future", { enableCustomFlags: true, customFlags: [] }).flags,
        ).toEqual([]);
        expect(resolveModelInfo("dynamic_google_gemini-future").flags).toContain(LLMFlags.hasImageInput);
    });

    const extra: LLMModel = {
        id: "gpt-future",
        name: "Registered name",
        internalID: "registered-wire-id",
        provider: LLMProvider.Anthropic,
        format: LLMFormat.Anthropic,
        tokenizer: LLMTokenizer.Claude,
        flags: [],
        parameters: [],
    };
    it("keeps the static catalogue ahead of discovery and extra models", () => {
        expect(resolveModelInfo("gpt-5.5", { extraModels: [{ ...extra, id: "gpt-5.5" }] })).toMatchObject({
            name: "GPT 5.5",
            provider: LLMProvider.OpenAI,
        });
    });
    it("keeps a tab registry entry ahead of the dynamic template", () => {
        expect(resolveModelInfo(extra.id, { extraModels: [extra] })).toMatchObject({
            name: "Registered name",
            internalID: "registered-wire-id",
            format: LLMFormat.Anthropic,
        });
    });
    it.each([
        ["hf:::gpt-future", LLMFormat.WebLLM],
        ["horde:::gpt-future", LLMFormat.Horde],
        ["xcustom:::gpt-future", LLMFormat.Anthropic],
        ["pluginmodel:::gpt-future", LLMFormat.Plugin],
    ] as const)("keeps the explicit kind of %s", (id, format) => {
        expect(dynamicModelOf(id)).toBeNull();
        expect(
            resolveModelInfo(id, {
                customModels: [
                    {
                        id: "xcustom:::gpt-future",
                        name: "Custom",
                        internalId: "custom-wire",
                        url: "https://custom.example",
                        params: "",
                        format: LLMFormat.Anthropic,
                        flags: [],
                        tokenizer: LLMTokenizer.Claude,
                    },
                ],
                pluginModels: [{ ...extra, id: "pluginmodel:::gpt-future", format: LLMFormat.Plugin }],
            }).format,
        ).toBe(format);
    });
    it.each(["vendor-future", "dynamic_google_", "dynamic_anthropic_", "gpt-", "gpt--response-api"])(
        "leaves %s as an as-is compatible model",
        (id) => {
            expect(dynamicModelOf(id)).toBeNull();
            expect(resolveModelInfo(id)).toMatchObject({
                internalID: id,
                provider: LLMProvider.AsIs,
                format: LLMFormat.OpenAICompatible,
                tokenizer: LLMTokenizer.Unknown,
            });
        },
    );
});
