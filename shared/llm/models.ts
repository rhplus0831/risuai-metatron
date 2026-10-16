// The static model catalogue (Phase 5, `shared/llm/`): the provider arrays, the assembled base list
// with its derived Response API and Vertex variants, and `resolveModelInfo`, the client's
// `getModelInfo` resolution with its database reads and its dynamic and plugin models passed in.
// The client keeps its own copy of the list for the dynamic registry (`src/ts/model/modellist.ts`);
// the server reads this one. Keep it free of DOM types, runes, and non-relative imports.

import type { Database } from "../database.ts";
import {
    LLMFlags,
    LLMProvider,
    LLMFormat,
    LLMTokenizer,
    ProviderNames,
    OpenAIParameters,
    ClaudeParameters,
    type LLMModel,
    GPT5XHighParameters,
} from "./types.ts";
import { OpenAIModels } from "./providers/openai.ts";
import { AnthropicModels } from "./providers/anthropic.ts";
import { GoogleModels } from "./providers/google.ts";

function makeDeepInfraModels(id: string[]): LLMModel[] {
    return id.map((id) => {
        return {
            id: "deepinfra_" + id,
            name: id,
            internalID: id,
            provider: LLMProvider.DeepInfra,
            format: LLMFormat.OpenAICompatible,
            parameters: ["frequency_penalty", "presence_penalty", "temperature", "top_p"],
            flags: [
                LLMFlags.hasFirstSystemPrompt,
                LLMFlags.requiresAlternateRole,
                LLMFlags.mustStartWithUserInput,
                LLMFlags.hasPrefill,
                LLMFlags.deepSeekThinkingOutput,
                LLMFlags.hasStreaming,
            ],
            tokenizer: LLMTokenizer.DeepSeek,
            endpoint: "https://api.deepinfra.com/v1/openai/chat/completions",
            keyIdentifier: "deepinfra",
            recommended: true,
        } as LLMModel;
    });
}

const LLMModels: LLMModel[] = [
    ...OpenAIModels,
    ...AnthropicModels,
    // AWS Bedrock Claude models
    {
        name: "Claude 4.6 Opus v1",
        id: "anthropic.claude-opus-4-6-v1",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [
            LLMFlags.hasPrefill, // actually it doesn't, but leaving it for compatibility
            LLMFlags.hasImageInput,
            LLMFlags.hasFirstSystemPrompt,
            LLMFlags.claudeThinking,
        ],
        parameters: [...ClaudeParameters, "thinking_tokens"],
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 4.5 Opus (20251101) v1",
        id: "anthropic.claude-opus-4-5-20251101-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt, LLMFlags.claudeThinking],
        parameters: [...ClaudeParameters, "thinking_tokens"],
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 4.5 Sonnet (20250929) v1",
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt, LLMFlags.claudeThinking],
        parameters: [...ClaudeParameters, "thinking_tokens"],
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 4.1 Opus (20250805) v1",
        id: "anthropic.claude-opus-4-1-20250805-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt, LLMFlags.claudeThinking],
        parameters: [...ClaudeParameters, "thinking_tokens"],
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 4 Opus (20250514) v1",
        id: "anthropic.claude-opus-4-20250514-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt, LLMFlags.claudeThinking],
        parameters: [...ClaudeParameters, "thinking_tokens"],
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 4 Sonnet (20250514) v1",
        id: "anthropic.claude-sonnet-4-20250514-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt, LLMFlags.claudeThinking],
        parameters: [...ClaudeParameters, "thinking_tokens"],
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 3.7 Sonnet (20250219) v1",
        id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt, LLMFlags.claudeThinking],
        parameters: [...ClaudeParameters, "thinking_tokens"],
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 3.5 Sonnet (20241022) v2",
        id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt],
        parameters: ClaudeParameters,
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 3.5 Sonnet (20240620) v1",
        id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt],
        parameters: ClaudeParameters,
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 3 Opus (20240229) v1",
        id: "anthropic.claude-3-opus-20240229-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt],
        parameters: ClaudeParameters,
        tokenizer: LLMTokenizer.Claude,
    },
    {
        name: "Claude 3 Sonnet (20240229) v1",
        id: "anthropic.claude-3-sonnet-20240229-v1:0",
        provider: LLMProvider.AWS,
        format: LLMFormat.AWSBedrockClaude,
        flags: [LLMFlags.hasPrefill, LLMFlags.hasImageInput, LLMFlags.hasFirstSystemPrompt],
        parameters: ClaudeParameters,
        tokenizer: LLMTokenizer.Claude,
    },
    // Other providers
    {
        name: "Ooba",
        id: "ooba",
        provider: LLMProvider.AsIs,
        format: LLMFormat.Ooba,
        flags: [LLMFlags.hasFirstSystemPrompt],
        recommended: true,
        parameters: [],
        tokenizer: LLMTokenizer.Llama,
    },
    {
        name: "Mancer",
        id: "mancer",
        provider: LLMProvider.AsIs,
        format: LLMFormat.OobaLegacy,
        flags: [LLMFlags.hasFirstSystemPrompt],
        parameters: [],
        tokenizer: LLMTokenizer.Llama,
    },
    {
        name: "OpenRouter",
        id: "openrouter",
        provider: LLMProvider.AsIs,
        format: LLMFormat.OpenAICompatible,
        flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.hasImageInput, LLMFlags.hasStreaming],
        parameters: [
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "repetition_penalty",
            "min_p",
            "top_a",
            "top_k",
        ],
        recommended: true,
        tokenizer: LLMTokenizer.Unknown,
    },
    // Mistral models
    {
        name: "Mistral Small Latest",
        id: "mistral-small-latest",
        shortName: "Mistral S",
        provider: LLMProvider.Mistral,
        format: LLMFormat.Mistral,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.mustStartWithUserInput, LLMFlags.requiresAlternateRole],
        recommended: true,
        parameters: ["temperature", "presence_penalty", "frequency_penalty", "top_p"],
        tokenizer: LLMTokenizer.Mistral,
    },
    {
        name: "Mistral Medium Latest",
        id: "mistral-medium-latest",
        shortName: "Mistral M",
        provider: LLMProvider.Mistral,
        format: LLMFormat.Mistral,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.mustStartWithUserInput, LLMFlags.requiresAlternateRole],
        recommended: true,
        parameters: ["temperature", "presence_penalty", "frequency_penalty", "top_p"],
        tokenizer: LLMTokenizer.Mistral,
    },
    {
        name: "Mistral Large 2411",
        id: "mistral-large-2411",
        shortName: "Mistral L 2411",
        provider: LLMProvider.Mistral,
        format: LLMFormat.Mistral,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.mustStartWithUserInput, LLMFlags.requiresAlternateRole],
        parameters: ["temperature", "presence_penalty", "frequency_penalty", "top_p"],
        tokenizer: LLMTokenizer.Mistral,
    },
    {
        name: "Mistral Nemo",
        id: "open-mistral-nemo",
        shortName: "Mistral Nemo",
        provider: LLMProvider.Mistral,
        format: LLMFormat.Mistral,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.mustStartWithUserInput, LLMFlags.requiresAlternateRole],
        parameters: ["temperature", "presence_penalty", "frequency_penalty", "top_p"],
        tokenizer: LLMTokenizer.Mistral,
    },
    {
        name: "Mistral Large Latest",
        id: "mistral-large-latest",
        shortName: "Mistral L",
        provider: LLMProvider.Mistral,
        format: LLMFormat.Mistral,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.mustStartWithUserInput, LLMFlags.requiresAlternateRole],
        parameters: ["temperature", "presence_penalty", "frequency_penalty", "top_p"],
        recommended: true,
        tokenizer: LLMTokenizer.Mistral,
    },
    // Google models
    ...GoogleModels,
    // Kobold
    {
        name: "Kobold",
        id: "kobold",
        provider: LLMProvider.AsIs,
        format: LLMFormat.Kobold,
        flags: [LLMFlags.hasFirstSystemPrompt],
        recommended: true,
        parameters: ["temperature", "top_p", "repetition_penalty", "top_k", "top_a"],
        tokenizer: LLMTokenizer.Unknown,
    },
    // NovelList
    {
        name: "SuperTrin",
        id: "novellist",
        provider: LLMProvider.NovelList,
        format: LLMFormat.NovelList,
        flags: [],
        parameters: [],
        tokenizer: LLMTokenizer.NovelList,
    },
    {
        name: "Damsel",
        id: "novellist_damsel",
        provider: LLMProvider.NovelList,
        format: LLMFormat.NovelList,
        flags: [],
        parameters: [],
        tokenizer: LLMTokenizer.NovelList,
    },
    // Cohere
    {
        name: "Command R",
        id: "cohere-command-r",
        internalID: "command-r",
        provider: LLMProvider.Cohere,
        format: LLMFormat.Cohere,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.requiresAlternateRole, LLMFlags.mustStartWithUserInput],
        recommended: true,
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.Cohere,
    },
    {
        name: "Command R Plus",
        id: "cohere-command-r-plus",
        internalID: "command-r-plus",
        provider: LLMProvider.Cohere,
        format: LLMFormat.Cohere,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.requiresAlternateRole, LLMFlags.mustStartWithUserInput],
        recommended: true,
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.Cohere,
    },
    {
        name: "Command R 08-2024",
        id: "cohere-command-r-08-2024",
        internalID: "command-r-08-2024",
        provider: LLMProvider.Cohere,
        format: LLMFormat.Cohere,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.requiresAlternateRole, LLMFlags.mustStartWithUserInput],
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.Cohere,
    },
    {
        name: "Command R 03-2024",
        id: "cohere-command-r-03-2024",
        internalID: "command-r-03-2024",
        provider: LLMProvider.Cohere,
        format: LLMFormat.Cohere,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.requiresAlternateRole, LLMFlags.mustStartWithUserInput],
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.Cohere,
    },
    {
        name: "Command R Plus 08-2024",
        id: "cohere-command-r-plus-08-2024",
        internalID: "command-r-plus-08-2024",
        provider: LLMProvider.Cohere,
        format: LLMFormat.Cohere,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.requiresAlternateRole, LLMFlags.mustStartWithUserInput],
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.Cohere,
    },
    {
        name: "Command R Plus 04-2024",
        id: "cohere-command-r-plus-04-2024",
        internalID: "command-r-plus-04-2024",
        provider: LLMProvider.Cohere,
        format: LLMFormat.Cohere,
        flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.requiresAlternateRole, LLMFlags.mustStartWithUserInput],
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.Cohere,
    },
    // NovelAI
    {
        name: "Clio",
        id: "novelai",
        provider: LLMProvider.NovelAI,
        format: LLMFormat.NovelAI,
        flags: [LLMFlags.hasFullSystemPrompt],
        recommended: true,
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.NovelAI,
    },
    {
        name: "Kayra",
        id: "novelai_kayra",
        provider: LLMProvider.NovelAI,
        format: LLMFormat.NovelAI,
        flags: [LLMFlags.hasFullSystemPrompt],
        recommended: true,
        parameters: ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        tokenizer: LLMTokenizer.NovelAI,
    },
    // Ollama
    {
        id: "ollama-hosted",
        name: "Local",
        fullName: "Ollama Local",
        provider: LLMProvider.Ollama,
        format: LLMFormat.Ollama,
        flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming],
        parameters: OpenAIParameters,
        tokenizer: LLMTokenizer.Unknown,
        recommended: true,
    },
    {
        id: "ollama-cloud",
        name: "Cloud",
        fullName: "Ollama Cloud",
        provider: LLMProvider.Ollama,
        format: LLMFormat.Ollama,
        flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming],
        parameters: OpenAIParameters,
        tokenizer: LLMTokenizer.Unknown,
        recommended: true,
    },
    // WebLLM
    {
        id: "hf:::Xenova/opt-350m",
        name: "opt-350m",
        provider: LLMProvider.WebLLM,
        format: LLMFormat.WebLLM,
        flags: [LLMFlags.hasFullSystemPrompt],
        parameters: OpenAIParameters,
        tokenizer: LLMTokenizer.Local,
    },
    {
        id: "hf:::Xenova/tiny-random-mistral",
        name: "tiny-random-mistral",
        provider: LLMProvider.WebLLM,
        format: LLMFormat.WebLLM,
        flags: [LLMFlags.hasFullSystemPrompt],
        parameters: OpenAIParameters,
        tokenizer: LLMTokenizer.Local,
    },
    {
        id: "hf:::Xenova/gpt2-large-conversational",
        name: "gpt2-large-conversational",
        provider: LLMProvider.WebLLM,
        format: LLMFormat.WebLLM,
        flags: [LLMFlags.hasFullSystemPrompt],
        parameters: OpenAIParameters,
        tokenizer: LLMTokenizer.Local,
    },
    // DeepSeek
    {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        provider: LLMProvider.DeepSeek,
        format: LLMFormat.OpenAICompatible,
        flags: [
            LLMFlags.hasFirstSystemPrompt,
            LLMFlags.requiresAlternateRole,
            LLMFlags.mustStartWithUserInput,
            LLMFlags.hasPrefill,
            LLMFlags.deepSeekPrefix,
            LLMFlags.deepSeekThinkingInput,
            LLMFlags.deepSeekThinkingOutput,
            LLMFlags.deepSeekThinkingToggle,
            LLMFlags.hasStreaming,
        ],
        parameters: ["frequency_penalty", "presence_penalty", "temperature", "top_p"],
        tokenizer: LLMTokenizer.DeepSeekV4,
        endpoint: "https://api.deepseek.com/beta/chat/completions",
        keyIdentifier: "deepseek",
        recommended: true,
    },
    {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        provider: LLMProvider.DeepSeek,
        format: LLMFormat.OpenAICompatible,
        flags: [
            LLMFlags.hasFirstSystemPrompt,
            LLMFlags.requiresAlternateRole,
            LLMFlags.mustStartWithUserInput,
            LLMFlags.hasPrefill,
            LLMFlags.deepSeekPrefix,
            LLMFlags.deepSeekThinkingInput,
            LLMFlags.deepSeekThinkingOutput,
            LLMFlags.deepSeekThinkingToggle,
            LLMFlags.hasStreaming,
        ],
        parameters: ["frequency_penalty", "presence_penalty", "temperature", "top_p"],
        tokenizer: LLMTokenizer.DeepSeekV4,
        endpoint: "https://api.deepseek.com/beta/chat/completions",
        keyIdentifier: "deepseek",
        recommended: true,
    },
    {
        id: "deepseek-reasoner",
        name: "Deepseek Reasoner",
        provider: LLMProvider.DeepSeek,
        format: LLMFormat.OpenAICompatible,
        flags: [
            LLMFlags.hasFirstSystemPrompt,
            LLMFlags.requiresAlternateRole,
            LLMFlags.mustStartWithUserInput,
            LLMFlags.hasPrefill,
            LLMFlags.deepSeekPrefix,
            LLMFlags.deepSeekThinkingInput,
            LLMFlags.deepSeekThinkingOutput,
            LLMFlags.hasStreaming,
        ],
        parameters: [],
        tokenizer: LLMTokenizer.DeepSeek,
        endpoint: "https://api.deepseek.com/beta/chat/completions",
        keyIdentifier: "deepseek",
    },
    {
        id: "deepseek-chat",
        name: "Deepseek Chat",
        provider: LLMProvider.DeepSeek,
        format: LLMFormat.OpenAICompatible,
        flags: [
            LLMFlags.hasFirstSystemPrompt,
            LLMFlags.requiresAlternateRole,
            LLMFlags.mustStartWithUserInput,
            LLMFlags.hasPrefill,
            LLMFlags.deepSeekPrefix,
            LLMFlags.hasStreaming,
        ],
        parameters: ["frequency_penalty", "presence_penalty", "temperature", "top_p"],
        tokenizer: LLMTokenizer.DeepSeek,
        endpoint: "https://api.deepseek.com/beta/chat/completions",
        keyIdentifier: "deepseek",
    },
    // DeepInfra
    ...makeDeepInfraModels([
        "deepseek-ai/DeepSeek-R1",
        "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
        "deepseek-ai/DeepSeek-V3",
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "meta-llama/Llama-3.3-70B-Instruct",
        "microsoft/phi-4",
        "meta-llama/Meta-Llama-3.1-70B-Instruct",
        "meta-llama/Meta-Llama-3.1-8B-Instruct",
        "meta-llama/Meta-Llama-3.1-405B-Instruct",
        "Qwen/QwQ-32B-Preview",
        "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
        "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
        "Qwen/Qwen2.5-Coder-32B-Instruct",
        "nvidia/Llama-3.1-Nemotron-70B-Instruct",
        "Qwen/Qwen2.5-72B-Instruct",
        "meta-llama/Llama-3.2-90B-Vision-Instruct",
        "meta-llama/Llama-3.2-11B-Vision-Instruct",
        "microsoft/WizardLM-2-8x22B",
        "01-ai/Yi-34B-Chat",
        "Austism/chronos-hermes-13b-v2",
        "Gryphe/MythoMax-L2-13b",
        "Gryphe/MythoMax-L2-13b-turbo",
        "Sao10K/L3.3-70B-Euryale-v2.3",
        "Sao10K/L3.1-70B-Euryale-v2.2",
        "Sao10K/L3-70B-Euryale-v2.1",
        "google/gemma-2-27b-it",
        "google/gemma-2-9b-it",
    ]),
    // NanoGPT — single provider entry; model list fetched on demand via getNanoGPTModels()
    {
        id: "nanogpt",
        name: "NanoGPT",
        fullName: "NanoGPT",
        provider: LLMProvider.NanoGPT,
        format: LLMFormat.NanoGPT,
        flags: [
            LLMFlags.hasFullSystemPrompt,
            LLMFlags.hasImageInput,
            LLMFlags.hasStreaming,
            LLMFlags.OAICompletionTokens,
        ],
        parameters: OpenAIParameters,
        tokenizer: LLMTokenizer.Unknown,
        recommended: true,
    },
    // Plugin and Custom API
    {
        id: "custom",
        name: "Plugin Legacy",
        provider: LLMProvider.AsIs,
        format: LLMFormat.Plugin,
        flags: [LLMFlags.hasFullSystemPrompt],
        parameters: [
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "repetition_penalty",
            "min_p",
            "top_a",
            "top_k",
            "thinking_tokens",
        ],
        tokenizer: LLMTokenizer.Unknown,
    },
    {
        id: "reverse_proxy",
        name: "Custom API",
        provider: LLMProvider.AsIs,
        format: LLMFormat.OpenAICompatible,
        flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming],
        recommended: true,
        parameters: [
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "repetition_penalty",
            "min_p",
            "top_a",
            "top_k",
            "thinking_tokens",
        ],
        tokenizer: LLMTokenizer.Unknown,
    },
    {
        id: "echo_model",
        name: "Echo",
        provider: LLMProvider.Echo,
        format: LLMFormat.Echo,
        flags: [LLMFlags.hasFullSystemPrompt],
        recommended: false,
        parameters: [],
        tokenizer: LLMTokenizer.Unknown,
    },
];

for (let model of LLMModels) {
    model.shortName ??= model.name;
    model.internalID ??= model.id;
    model.fullName ??=
        model.provider !== LLMProvider.AsIs
            ? `${ProviderNames.get(model.provider) ?? ""} ${model.name}`.trim()
            : model.name;
}

for (let i = 0; i < LLMModels.length; i++) {
    if (LLMModels[i].provider === LLMProvider.OpenAI && LLMModels[i].format === LLMFormat.OpenAICompatible) {
        LLMModels.push({
            ...LLMModels[i],
            format: LLMFormat.OpenAIResponseAPI,
            flags: [...LLMModels[i].flags, LLMFlags.hasPrefill],
            id: `${LLMModels[i].id}-response-api`,
            name: `${LLMModels[i].name} (Response API)`,
            fullName: `${LLMModels[i].fullName ?? LLMModels[i].name} (Response API)`,
            recommended: false,
        });
    }
    if (LLMModels[i].provider === LLMProvider.GoogleCloud) {
        LLMModels.push({
            ...LLMModels[i],
            id: `${LLMModels[i].id}-vertex`,
            name: `${LLMModels[i].name} Vertex`,
            fullName: `${LLMModels[i].fullName ?? LLMModels[i].name} Vertex`,
            flags: [...LLMModels[i].flags],
            recommended: !!LLMModels[i].recommended,
            provider: LLMProvider.VertexAI,
            format: LLMFormat.VertexAIGemini,
        });
    }
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const entry of Object.values(value)) {
            deepFreeze(entry);
        }
    }
    return value;
}

/**
 * The assembled static catalogue, frozen: `resolveModelInfo` hands out clones, and the client
 * copies it (`structuredClone`) before its dynamic registry appends.
 */
export const BASE_LLM_MODELS: readonly LLMModel[] = deepFreeze(LLMModels);

/** Discovery templates shared by the tab registry and every server model scope. */
export function dynamicModelOf(id: string): LLMModel | null {
    const base = { id, name: id, shortName: id, fullName: id };
    if (id.startsWith("dynamic_google_")) {
        const internalID = id.slice("dynamic_google_".length).replace(/^models\//, "");
        if (!internalID) return null;
        return {
            ...base,
            internalID,
            provider: LLMProvider.GoogleCloud,
            format: LLMFormat.GoogleCloud,
            flags: [
                LLMFlags.hasImageInput,
                LLMFlags.poolSupported,
                LLMFlags.hasAudioInput,
                LLMFlags.hasVideoInput,
                LLMFlags.hasStreaming,
                LLMFlags.requiresAlternateRole,
                LLMFlags.geminiThinking,
            ],
            parameters: ["thinking_tokens", "temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
            tokenizer: LLMTokenizer.GoogleCloud,
        };
    }
    if (id.startsWith("dynamic_anthropic_")) {
        const internalID = id.slice("dynamic_anthropic_".length);
        if (!internalID) return null;
        return {
            ...base,
            internalID,
            provider: LLMProvider.Anthropic,
            format: LLMFormat.Anthropic,
            flags: [
                LLMFlags.hasImageInput,
                LLMFlags.hasFirstSystemPrompt,
                LLMFlags.hasStreaming,
                LLMFlags.claudeThinking,
                LLMFlags.claudeAdaptiveThinking,
            ],
            parameters: [...ClaudeParameters, "thinking_tokens"],
            tokenizer: LLMTokenizer.Claude,
        };
    }
    if (id.startsWith("gpt-")) {
        const responses = id.endsWith("-response-api");
        const internalID = responses ? id.slice(0, -"-response-api".length) : id;
        if (internalID.length <= "gpt-".length) return null;
        return {
            ...base,
            internalID,
            provider: LLMProvider.OpenAI,
            format: responses ? LLMFormat.OpenAIResponseAPI : LLMFormat.OpenAICompatible,
            flags: [
                LLMFlags.hasStreaming,
                LLMFlags.OAICompletionTokens,
                LLMFlags.hasFullSystemPrompt,
                LLMFlags.hasImageInput,
                LLMFlags.DeveloperRole,
                ...(responses ? [LLMFlags.hasPrefill] : []),
            ],
            parameters: [...GPT5XHighParameters],
            tokenizer: LLMTokenizer.tiktokenO200Base,
        };
    }
    return null;
}

export type ModelResolution = {
    enableCustomFlags?: boolean;
    customFlags?: LLMFlags[];
    customModels?: Database["customModels"];
    /** Models searched together with the static list (the client's dynamic registrations). */
    extraModels?: readonly LLMModel[];
    /** The `pluginmodel:::` descriptors (the client's plugin provider store). */
    pluginModels?: readonly LLMModel[];
};

/**
 * The client's `getModelInfo` (`src/ts/model/modellist.ts`), with its reads passed in: the static
 * list, then `extraModels` (a found model is cloned and takes `customFlags` when
 * `enableCustomFlags` is on), `hf:::`, `horde:::`, `xcustom:::` (`customModels`),
 * `pluginmodel:::` (`pluginModels`, returned as stored), dynamic ids, then an unknown OpenAI-compatible model.
 */
export function resolveModelInfo(id: string | null | undefined, from: ModelResolution = {}): LLMModel {
    if (!id) {
        return {
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
        };
    }
    const listed = LLMModels.find((model) => model.id === id) ?? from.extraModels?.find((model) => model.id === id);
    if (listed) {
        const found: LLMModel = structuredClone(listed);
        if (from.enableCustomFlags) {
            found.flags = from.customFlags as LLMFlags[];
        }
        return found;
    }

    if (id.startsWith("hf:::")) {
        const withoutPrefix = id.replace("hf:::", "");
        return {
            id,
            name: withoutPrefix,
            shortName: withoutPrefix,
            fullName: withoutPrefix,
            internalID: withoutPrefix,
            provider: LLMProvider.WebLLM,
            format: LLMFormat.WebLLM,
            flags: [],
            parameters: OpenAIParameters,
            tokenizer: LLMTokenizer.Local,
        };
    }
    if (id.startsWith("horde:::")) {
        const withoutPrefix = id.replace("horde:::", "");
        return {
            id,
            name: withoutPrefix,
            shortName: withoutPrefix,
            fullName: withoutPrefix,
            internalID: withoutPrefix,
            provider: LLMProvider.Horde,
            format: LLMFormat.Horde,
            flags: [],
            parameters: OpenAIParameters,
            tokenizer: LLMTokenizer.Unknown,
        };
    }
    if (id.startsWith("xcustom:::")) {
        const customModels = from.customModels || [];
        const found = customModels.find((model) => model.id === id);
        if (found) {
            return {
                id: found.id,
                name: found.name,
                shortName: found.name,
                fullName: found.name,
                internalID: found.internalId,
                provider: LLMProvider.AsIs,
                format: found.format,
                flags: found.flags,
                parameters: [
                    "temperature",
                    "top_p",
                    "frequency_penalty",
                    "presence_penalty",
                    "repetition_penalty",
                    "min_p",
                    "top_a",
                    "top_k",
                    "thinking_tokens",
                ],
                tokenizer: found.tokenizer,
            };
        }
    }

    if (id.startsWith("pluginmodel:::")) {
        const pluginModel = from.pluginModels?.find((model) => model.id === id);
        if (pluginModel) {
            return pluginModel;
        }
    }

    const dynamic = dynamicModelOf(id);
    if (dynamic) {
        if (from.enableCustomFlags) dynamic.flags = structuredClone(from.customFlags) as LLMFlags[];
        return dynamic;
    }

    return {
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
    };
}
