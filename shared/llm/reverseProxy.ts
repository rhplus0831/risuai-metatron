import type { LLMFormat, LLMModel } from "../llm.ts";

/** Applies a reverse proxy's request model and format to its request-local descriptor. */
export function applyReverseProxyOverride(
    modelId: string,
    modelInfo: LLMModel,
    settings: { customProxyRequestModel: string; customAPIFormat: LLMFormat },
): void {
    if (modelId === "reverse_proxy") {
        modelInfo.internalID = settings.customProxyRequestModel;
        modelInfo.format = settings.customAPIFormat;
    }
}
