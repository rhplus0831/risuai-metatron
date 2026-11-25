import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "../llm.ts";
import type { LLMParameter } from "../llm.ts";

/**
 * Shared provider display names and parameter presets alongside the vocabulary re-exported from `shared/llm.ts`.
 * These arrays advertise supported controls to catalogue entries; they do not hold request values. GPT-5 presets
 * build independent arrays from a common base, with capability markers distinguishing allowed reasoning levels.
 */

export { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer };
export type { LLMModel };

/** Display names keyed by the persisted provider codes. */
export const ProviderNames = new Map<LLMProvider, string>([
    [LLMProvider.OpenAI, "OpenAI"],
    [LLMProvider.Anthropic, "Anthropic"],
    [LLMProvider.GoogleCloud, "Google Cloud"],
    [LLMProvider.VertexAI, "Vertex AI"],
    [LLMProvider.AsIs, "As Is"],
    [LLMProvider.Mistral, "MistralAI"],
    [LLMProvider.NovelList, "NovelList"],
    [LLMProvider.Cohere, "Cohere"],
    [LLMProvider.NovelAI, "NovelAI"],
    [LLMProvider.WebLLM, "WebLLM"],
    [LLMProvider.Horde, "Horde"],
    [LLMProvider.AWS, "AWS"],
    [LLMProvider.DeepSeek, "DeepSeek"],
    [LLMProvider.DeepInfra, "DeepInfra"],
    [LLMProvider.Echo, "For Developer"],
    [LLMProvider.NanoGPT, "NanoGPT"],
    [LLMProvider.Ollama, "Ollama"],
]);

/** The common OpenAI sampling and penalty controls. */
export const OpenAIParameters: LLMParameter[] = ["temperature", "top_p", "frequency_penalty", "presence_penalty"];
const GPT5BaseParameters: LLMParameter[] = [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "reasoning_effort",
    "verbosity",
];
/** OpenAI sampling and penalty controls plus reasoning effort and verbosity. */
export const GPT5Parameters: LLMParameter[] = [...GPT5BaseParameters];
/** GPT-5 controls advertising the additional `none` reasoning level. */
export const GPT5NoneParameters: LLMParameter[] = [...GPT5BaseParameters, "reasoning_effort_none"];
/** GPT-5 controls advertising both `none` and `xhigh` reasoning levels. */
export const GPT5XHighParameters: LLMParameter[] = [...GPT5NoneParameters, "reasoning_effort_xhigh"];
/** GPT-5 controls advertising a minimum of medium reasoning and the `xhigh` level. */
export const GPT5ProParameters: LLMParameter[] = [
    ...GPT5BaseParameters,
    "reasoning_effort_min_medium",
    "reasoning_effort_xhigh",
];
/** The common Claude sampling controls, without a thinking budget. */
export const ClaudeParameters: LLMParameter[] = ["temperature", "top_k", "top_p"];
