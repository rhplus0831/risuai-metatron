import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "../../../shared/llm.ts";
import type { LLMParameter } from "../../../shared/llm.ts";

export { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer };
export type { LLMModel };

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

export const OpenAIParameters: LLMParameter[] = ["temperature", "top_p", "frequency_penalty", "presence_penalty"];
const GPT5BaseParameters: LLMParameter[] = [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "reasoning_effort",
    "verbosity",
];
export const GPT5Parameters: LLMParameter[] = [...GPT5BaseParameters];
export const GPT5NoneParameters: LLMParameter[] = [...GPT5BaseParameters, "reasoning_effort_none"];
export const GPT5XHighParameters: LLMParameter[] = [...GPT5NoneParameters, "reasoning_effort_xhigh"];
export const GPT5ProParameters: LLMParameter[] = [
    ...GPT5BaseParameters,
    "reasoning_effort_min_medium",
    "reasoning_effort_xhigh",
];
export const ClaudeParameters: LLMParameter[] = ["temperature", "top_k", "top_p"];
