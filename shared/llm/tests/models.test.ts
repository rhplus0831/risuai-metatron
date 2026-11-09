import { describe, expect, it } from "vitest";
import {
    BASE_LLM_MODELS,
    dynamicModelOf,
    isUnresolvedModelId,
    resolveModelInfo,
    type ModelResolution,
} from "../models.ts";
import {
    ClaudeParameters,
    OpenAIParameters,
    LLMFlags,
    LLMFormat,
    LLMProvider,
    LLMTokenizer,
    type LLMModel,
} from "../types.ts";

describe("unresolved model ids", () => {
    it.each([
        "retired-vendor-model",
        "xcustom:::deleted",
        "pluginmodel:::removed",
        "dynamic_google_",
        "dynamic_anthropic_",
        "gpt--response-api",
    ])("marks %s unresolved and preserves its as-is request descriptor", (id) => {
        const overrides = { enableCustomFlags: true, customFlags: [LLMFlags.hasImageInput] };
        expect(isUnresolvedModelId(id, overrides)).toBe(true);
        expect(resolveModelInfo(id, overrides)).toEqual({
            id,
            name: id,
            shortName: id,
            fullName: id,
            internalID: id,
            provider: LLMProvider.AsIs,
            format: LLMFormat.OpenAICompatible,
            flags: [],
            parameters: OpenAIParameters,
            tokenizer: LLMTokenizer.Unknown,
        });
    });

    it.each(["", null, undefined])("keeps the separate Unknown descriptor for %j resolved", (id) => {
        expect(isUnresolvedModelId(id)).toBe(false);
        expect(resolveModelInfo(id)).toEqual({
            id: "",
            name: "Unknown",
            shortName: "Unknown",
            fullName: "Unknown",
            internalID: "",
            provider: LLMProvider.AsIs,
            format: LLMFormat.OpenAICompatible,
            flags: [],
            parameters: OpenAIParameters,
            tokenizer: LLMTokenizer.Unknown,
        });
    });

    it.each([
        ["reverse_proxy", "reverse_proxy", LLMProvider.AsIs, LLMFormat.OpenAICompatible],
        ["hf:::local-model", "local-model", LLMProvider.WebLLM, LLMFormat.WebLLM],
        ["horde:::remote-model", "remote-model", LLMProvider.Horde, LLMFormat.Horde],
        ["dynamic_google_gemini-private", "gemini-private", LLMProvider.GoogleCloud, LLMFormat.GoogleCloud],
        ["dynamic_anthropic_claude-private", "claude-private", LLMProvider.Anthropic, LLMFormat.Anthropic],
        ["gpt-private-response-api", "gpt-private", LLMProvider.OpenAI, LLMFormat.OpenAIResponseAPI],
    ] as const)("recognizes %s without an extra registry entry", (id, internalID, provider, format) => {
        expect(isUnresolvedModelId(id)).toBe(false);
        expect(resolveModelInfo(id)).toMatchObject({ id, internalID, provider, format });
    });

    it("recognizes a supplied custom endpoint even with an AsIs provider and keeps its definition's flags", () => {
        const id = "xcustom:::private";
        const from: ModelResolution = {
            customModels: [
                {
                    id,
                    name: "Private endpoint",
                    internalId: "wire-private",
                    url: "https://private.example",
                    params: "",
                    flags: [LLMFlags.hasStreaming],
                    format: LLMFormat.Anthropic,
                    tokenizer: LLMTokenizer.Claude,
                },
            ],
            enableCustomFlags: true,
            customFlags: [],
        };
        expect(isUnresolvedModelId(id, from)).toBe(false);
        expect(resolveModelInfo(id, from)).toMatchObject({
            id,
            name: "Private endpoint",
            internalID: "wire-private",
            provider: LLMProvider.AsIs,
            format: LLMFormat.Anthropic,
            tokenizer: LLMTokenizer.Claude,
            flags: [LLMFlags.hasStreaming],
        });
        expect(isUnresolvedModelId(id, { customModels: [] })).toBe(true);
    });

    it("recognizes extra catalogue descriptors, clones them, and applies profile flags without changing the source", () => {
        const extra: LLMModel = {
            id: "private-listed-model",
            name: "Private list",
            internalID: "wire-extra",
            provider: LLMProvider.AsIs,
            format: LLMFormat.OpenAICompatible,
            tokenizer: LLMTokenizer.Unknown,
            flags: [LLMFlags.hasStreaming],
            parameters: ["temperature"],
            endpoint: "https://private.example/v1/chat/completions",
        };
        const from = { extraModels: [extra], enableCustomFlags: true, customFlags: [LLMFlags.hasImageInput] };
        expect(isUnresolvedModelId(extra.id, from)).toBe(false);
        const resolved = resolveModelInfo(extra.id, from);
        expect(resolved).toEqual({ ...extra, flags: [LLMFlags.hasImageInput] });
        expect(resolved).not.toBe(extra);
        expect(extra.flags).toEqual([LLMFlags.hasStreaming]);
        expect(isUnresolvedModelId(extra.id)).toBe(true);
    });

    it("recognizes a plugin descriptor and preserves its reference despite profile flag overrides", () => {
        const plugin: LLMModel = {
            id: "pluginmodel:::private",
            name: "Plugin",
            internalID: "plugin-wire",
            provider: LLMProvider.AsIs,
            format: LLMFormat.Plugin,
            tokenizer: LLMTokenizer.Unknown,
            flags: [LLMFlags.hasStreaming],
            parameters: [],
        };
        const from = { pluginModels: [plugin], enableCustomFlags: true, customFlags: [] };
        expect(isUnresolvedModelId(plugin.id, from)).toBe(false);
        expect(resolveModelInfo(plugin.id, from)).toBe(plugin);
        expect(plugin.flags).toEqual([LLMFlags.hasStreaming]);
        expect(isUnresolvedModelId(plugin.id)).toBe(true);
    });
});

describe("static model catalogue", () => {
    it("offers only reasoning_effort for Gemini 3.6 Flash", () => {
        expect(resolveModelInfo("gemini-3.6-flash").parameters).toEqual(["reasoning_effort"]);
    });

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
    it("inherits static Anthropic capabilities while preserving the saved dynamic and upstream ids", () => {
        // Cover adaptive-only, budget-capable, and legacy wire formats.
        for (const internalID of ["claude-opus-5", "claude-opus-4-6", "claude-2.1"]) {
            const catalogue = BASE_LLM_MODELS.find((model) => model.id === internalID)!;
            const id = `dynamic_anthropic_${internalID}`;
            for (const model of [dynamicModelOf(id), resolveModelInfo(id)]) {
                expect(model, id).toMatchObject({
                    id,
                    internalID,
                    provider: catalogue.provider,
                    flags: catalogue.flags,
                    parameters: catalogue.parameters,
                    format: catalogue.format,
                    tokenizer: catalogue.tokenizer,
                });
            }
        }
    });

    it("keeps the generic Anthropic capabilities without default-on thinking for an unknown dynamic id", () => {
        const id = "dynamic_anthropic_claude-unknown";
        for (const model of [dynamicModelOf(id), resolveModelInfo(id)]) {
            expect(model).toMatchObject({
                id,
                internalID: "claude-unknown",
                provider: LLMProvider.Anthropic,
                format: LLMFormat.Anthropic,
                tokenizer: LLMTokenizer.Claude,
                parameters: [...ClaudeParameters, "thinking_tokens"],
            });
            expect(model!.flags.toSorted()).toEqual(
                [
                    LLMFlags.hasImageInput,
                    LLMFlags.hasFirstSystemPrompt,
                    LLMFlags.hasStreaming,
                    LLMFlags.claudeThinking,
                    LLMFlags.claudeAdaptiveThinking,
                ].sort(),
            );
            expect(model!.flags).not.toContain(LLMFlags.claudeThinkingOnByDefault);
        }
    });

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
