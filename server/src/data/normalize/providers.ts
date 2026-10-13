import type { SectionResource } from "../../../../shared/resources.ts";
import { REQUEST_HISTORY_DEFAULT_LIMIT } from "../requestHistory.ts";
import { normalizeSection, type SectionSpec } from "./shared.ts";

/** Global provider behavior; profile options and the retired model-to-key map are dropped. */
const spec: SectionSpec<"providers"> = {
    loreBookToken: ["number", 8000],
    additionalPrompt: ["string", "The assistant must act as {{char}}. user is {{user}}."],
    descriptionPrefix: ["string", "description of {{char}}: "],
    requestRetrys: ["number", 2],
    useStreaming: ["boolean"],
    usePlainFetch: ["boolean"],
    openrouterMiddleOut: ["boolean", false],
    openrouterFallback: ["boolean", true],
    nanogptUseSubscriptionEndpoint: ["boolean", false],
    nanogptSubscriptionState: ["string", ""],
    autofillRequestUrl: ["boolean", true],
    generationSeed: ["number", -1],
    newOAIHandle: ["boolean", true],
    gptVisionQuality: ["string", "low"],
    reverseProxyOobaMode: ["boolean"],
    chainOfThought: ["boolean"],
    genTime: ["number", 1],
    additionalParams: ["array", []],
    applyAdditionalParamsToAll: ["boolean"],
    ollamaThinkingMode: ["string", "auto"],
    autoContinueChat: ["boolean", false],
    autoContinueMinTokens: ["number", 0],
    removeIncompleteResponse: ["boolean"],
    useTokenizerCaching: ["boolean"],
    OAIPrediction: ["string", ""],
    vertexRegion: ["string", "global"],
    googleClaudeTokenizing: ["boolean"],
    banCharacterset: ["array", []],
    inlayErrorResponse: ["boolean"],
    antiServerOverloads: ["boolean"],
    automaticCachePoint: ["boolean"],
    claudeRetrivalCaching: ["boolean"],
    claudeBatching: ["boolean"],
    claude1HourCaching: ["boolean"],
    igpPrompt: ["string"],
    openAIFlexProcessing: ["boolean", false],
    rememberToolUsage: ["boolean", true],
    simplifiedToolUse: ["boolean", false],
    streamGeminiThoughts: ["boolean", false],
    echoMessage: ["string", "Echo Message"],
    echoDelay: ["number", 0],
    dynamicModelRegistry: ["boolean", true],
    saveSignatures: ["boolean", false],
    presetChain: ["string"],
    requestHistoryContent: ["boolean", true],
    requestHistoryLimit: ["number", REQUEST_HISTORY_DEFAULT_LIMIT],
};

export function normalizeProviders(input: unknown): SectionResource<"providers"> {
    const record = normalizeSection("providers", spec, input);
    return record as SectionResource<"providers">;
}
