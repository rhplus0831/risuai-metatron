import { LLMFormat } from "../../../../shared/llm.ts";
import { migrateKeepOnSwitchFields } from "../../../../shared/presets.ts";
import type { SectionResource } from "../../../../shared/resources.ts";
import { normalizeSection, type SectionSpec } from "./shared.ts";

/**
 * The `providers` section: request and model options outside the preset, plus the keep-on-switch
 * root copies (`PRESET_KEEP_ON_SWITCH_FIELDS`) and their toggles. `ollamaModelSource` and
 * `ollamaCloudModel` were derived from `aiModel` and `subModel` in `setDatabase`; they are the
 * fresh-boot constants now (a fresh store shows the same values).
 */
const spec: SectionSpec<"providers"> = {
    loreBookToken: ["number", 8000],
    additionalPrompt: ["string", "The assistant must act as {{char}}. user is {{user}}."],
    descriptionPrefix: ["string", "description of {{char}}: "],
    requestRetrys: ["number", 2],
    useStreaming: ["boolean"],
    usePlainFetch: ["boolean"],
    openrouterMiddleOut: ["boolean", false],
    openrouterFallback: ["boolean", true],
    nanogptRequestModel: ["string", ""],
    nanogptRequestModelName: ["string", ""],
    nanogptProvider: ["string", ""],
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
    ollamaURL: ["string", ""],
    ollamaModel: ["string", ""],
    ollamaModelSource: ["string", "local"],
    ollamaInputMode: ["string", "manual"],
    ollamaRequestFormat: ["number", LLMFormat.Ollama],
    ollamaModelName: ["string", ""],
    ollamaCloudModel: ["string", ""],
    ollamaCloudModelName: ["string", ""],
    ollamaThinkingMode: ["string", "auto"],
    autoContinueChat: ["boolean", false],
    autoContinueMinTokens: ["number", 0],
    removeIncompleteResponse: ["boolean"],
    customTokenizer: ["string", "tik"],
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
    seperateModels: ["object"],
    seperateModelsForAxModels: ["boolean"],
    fallbackModels: ["object", { model: [], memory: [], emotion: [], translate: [], otherAx: [] }],
    fallbackWhenBlankResponse: ["boolean"],
    seperateParameters: ["object", { memory: {}, emotion: {}, translate: {}, otherAx: {}, overrides: {} }],
    doNotChangeSeperateModels: ["boolean", false],
    doNotChangeFallbackModels: ["boolean"],
    disableSeperateParameterChangeOnPresetChange: ["boolean"],
};

export function normalizeProviders(input: unknown): SectionResource<"providers"> {
    const record = normalizeSection("providers", spec, input);
    migrateKeepOnSwitchFields(record);
    return record as SectionResource<"providers">;
}
