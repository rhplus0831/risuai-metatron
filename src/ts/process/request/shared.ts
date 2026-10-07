import { settings, activePreset } from "../../storage/settingsViews.svelte";
import { parseAdditionalParamJsonValue } from "./additionalParams";

import type { LLMParameter } from "../../../../shared/llm.ts";

export type { LLMParameter };

export type ModelModeExtended = "model" | "submodel" | "memory" | "emotion" | "otherAx" | "translate";

const reasoningCapabilityParameters: LLMParameter[] = [
    "reasoning_effort_min_medium",
    "reasoning_effort_none",
    "reasoning_effort_xhigh",
];

export function isReasoningCapabilityParameter(parameter: LLMParameter): boolean {
    return reasoningCapabilityParameters.includes(parameter);
}

export function setObjectValue<T>(obj: T, key: string, value: any): T {
    const splitKey = key.split(".");
    if (splitKey.length > 1) {
        const firstKey = splitKey.shift();
        if (!obj[firstKey]) {
            obj[firstKey] = {};
        }
        obj[firstKey] = setObjectValue(obj[firstKey], splitKey.join("."), value);
        return obj;
    }

    obj[key] = value;
    return obj;
}

export function getAdditionalParameters(aiModel?: string): [string, string][] {
    if (!aiModel) {
        return [];
    }

    if (aiModel === "reverse_proxy") {
        return [...(settings.providers.additionalParams ?? [])];
    }

    if (!aiModel.startsWith("xcustom:::")) {
        return settings.providers.applyAdditionalParamsToAll ? [...(settings.providers.additionalParams ?? [])] : [];
    }

    const found = settings.customModels.find((model) => model.id === aiModel);
    const params = found?.params;
    if (!params) {
        return [];
    }

    const additionalParams: [string, string][] = [];
    for (const line of params.split("\n")) {
        const split = line.split("=");
        if (split.length >= 2) {
            additionalParams.push([split[0], split.slice(1).join("=")]);
        }
    }

    return additionalParams;
}

export function applyAdditionalParameters<T extends Record<string, any>>(
    body: T,
    headers: Record<string, string>,
    additionalParams: [string, string][],
): T {
    for (const [rawKey, rawValue] of additionalParams) {
        let key = rawKey;
        let value = rawValue;

        if (!key || !value) {
            continue;
        }

        if (value === "{{none}}") {
            if (key.startsWith("header::")) {
                delete headers[key.replace("header::", "")];
            } else {
                delete body[key];
            }
            continue;
        }

        if (key.startsWith("header::")) {
            headers[key.replace("header::", "")] = value;
            continue;
        }

        if (value.startsWith("json::")) {
            const parsedValue = parseAdditionalParamJsonValue(value.replace("json::", ""));
            if (parsedValue !== undefined) {
                body = setObjectValue(body, key, parsedValue);
            }
            continue;
        }

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            body = setObjectValue(body, key, value.slice(1, -1));
            continue;
        }

        if (value === "true" || value === "false") {
            body = setObjectValue(body, key, value === "true");
            continue;
        }

        if (value === "null") {
            body = setObjectValue(body, key, null);
            continue;
        }

        const num = Number(value);
        body = setObjectValue(body, key, isNaN(num) ? value : num);
    }

    return body;
}

export function applyParameters(
    data: Record<string, any>,
    parameters: LLMParameter[],
    rename: Partial<Record<LLMParameter, string>>,
    modelMode: ModelModeExtended,
    arg: {
        ignoreTopKIfZero?: boolean;
        modelId: string;
    },
): Record<string, any> {
    const reasoningDisabledEffort = parameters.includes("reasoning_effort_none") ? "none" : "minimal";
    const reasoningMinEffort = parameters.includes("reasoning_effort_min_medium") ? "medium" : "low";
    const supportsXHighReasoning = parameters.includes("reasoning_effort_xhigh");

    function getEffort(
        effort: number,
        disabledEffort: "minimal" | "none" = "minimal",
        supportsXHigh = false,
        minEffort: "low" | "medium" = "low",
    ) {
        switch (effort) {
            case -1: {
                return disabledEffort;
            }
            case 0: {
                return minEffort;
            }
            case 1: {
                return "medium";
            }
            case 2: {
                return "high";
            }
            case 3: {
                return supportsXHigh ? "xhigh" : "high";
            }
            default: {
                return "medium";
            }
        }
    }

    function getVerbosity(verbosity: number) {
        return ["low", "medium", "high"][verbosity] ?? "medium";
    }

    if (activePreset.seperateParametersEnabled && modelMode !== "model") {
        let sepParams = settings.providers.seperateParameters[modelMode];
        if (modelMode === "submodel") {
            sepParams = settings.providers.seperateParameters["otherAx"];
        }

        for (const parameter of parameters) {
            let value: number | string = 0;
            if (isReasoningCapabilityParameter(parameter)) {
                continue;
            }
            if (parameter === "top_k" && arg.ignoreTopKIfZero && sepParams[parameter] === 0) {
                continue;
            }

            switch (parameter) {
                case "temperature": {
                    value = sepParams.temperature === -1000 ? -1000 : sepParams.temperature / 100;
                    break;
                }
                case "top_k": {
                    value = sepParams.top_k;
                    break;
                }
                case "repetition_penalty": {
                    value = sepParams.repetition_penalty;
                    break;
                }
                case "min_p": {
                    value = sepParams.min_p;
                    break;
                }
                case "top_a": {
                    value = sepParams.top_a;
                    break;
                }
                case "top_p": {
                    value = sepParams.top_p;
                    break;
                }
                case "thinking_tokens": {
                    value = sepParams.thinking_tokens;
                    break;
                }
                case "frequency_penalty": {
                    value = sepParams.frequency_penalty === -1000 ? -1000 : sepParams.frequency_penalty / 100;
                    break;
                }
                case "presence_penalty": {
                    value = sepParams.presence_penalty === -1000 ? -1000 : sepParams.presence_penalty / 100;
                    break;
                }
                case "reasoning_effort": {
                    value = getEffort(
                        sepParams.reasoning_effort,
                        reasoningDisabledEffort,
                        supportsXHighReasoning,
                        reasoningMinEffort,
                    );
                    break;
                }
                case "verbosity": {
                    value = getVerbosity(sepParams.verbosity);
                    break;
                }
            }

            if (
                value === -1000 ||
                value === undefined ||
                value === null ||
                (typeof value === "number" && isNaN(value))
            ) {
                continue;
            }

            data = setObjectValue(data, rename[parameter] ?? parameter, value);
        }
        return data;
    }

    for (const parameter of parameters) {
        let value: number | string = 0;
        if (isReasoningCapabilityParameter(parameter)) {
            continue;
        }
        if (parameter === "top_k" && arg.ignoreTopKIfZero && activePreset.top_k === 0) {
            continue;
        }
        switch (parameter) {
            case "temperature": {
                value = activePreset.temperature === -1000 ? -1000 : activePreset.temperature / 100;
                break;
            }
            case "top_k": {
                value = activePreset.top_k;
                break;
            }
            case "repetition_penalty": {
                value = activePreset.repetition_penalty;
                break;
            }
            case "min_p": {
                value = activePreset.min_p;
                break;
            }
            case "top_a": {
                value = activePreset.top_a;
                break;
            }
            case "top_p": {
                value = activePreset.top_p;
                break;
            }
            case "reasoning_effort": {
                value = getEffort(
                    activePreset.reasonEffort,
                    reasoningDisabledEffort,
                    supportsXHighReasoning,
                    reasoningMinEffort,
                );
                break;
            }
            case "verbosity": {
                value = getVerbosity(activePreset.verbosity);
                break;
            }
            case "frequency_penalty": {
                value = activePreset.frequencyPenalty === -1000 ? -1000 : activePreset.frequencyPenalty / 100;
                break;
            }
            case "presence_penalty": {
                value = activePreset.PresensePenalty === -1000 ? -1000 : activePreset.PresensePenalty / 100;
                break;
            }
            case "thinking_tokens": {
                value = activePreset.thinkingTokens;
                break;
            }
        }

        if (value === -1000) {
            continue;
        }

        data = setObjectValue(data, rename[parameter] ?? parameter, value);
    }
    return data;
}
