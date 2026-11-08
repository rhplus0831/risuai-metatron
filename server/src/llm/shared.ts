// Port of `src/ts/process/request/shared.ts`: the database is the request's (`db` parameters).
import { parseAdditionalParamJsonValue } from "./additionalParams.ts";
import type { RequestDb } from "./settings.ts";

import type { LLMParameter } from "../../../shared/llm.ts";
import type { ModelModeExtended } from "../../../shared/llm/request.ts";

/**
 * Applies request-local preset parameters and provider-specific additional parameters to adapter bodies/headers.
 * Capability markers guide reasoning effort without becoming body fields; `-1000` omits a numeric setting, and
 * renamed parameter keys may address nested objects. The same preset values serve every request mode.
 *
 * Additional parameters run in order and mutate their targets, so later entries override earlier ones; adapters
 * may still force fields afterwards. Only body values are parsed, via server/src/llm/additionalParams.ts for `json::`.
 * Dotted writes create missing/falsy intermediates but do not validate key paths or replace truthy primitives, so
 * invalid traversals can throw. Provider-specific response/error handling remains in the adapters, with shared
 * user-facing strings in server/src/llm/messages.ts.
 */

export type { LLMParameter, ModelModeExtended };

const reasoningCapabilityParameters: LLMParameter[] = [
    "reasoning_effort_min_medium",
    "reasoning_effort_none",
    "reasoning_effort_xhigh",
];

/** Identifies the three reasoning-effort capability markers that are not emitted as request fields. */
export function isReasoningCapabilityParameter(parameter: LLMParameter): boolean {
    return reasoningCapabilityParameters.includes(parameter);
}

/**
 * Mutates and returns `obj` at a dot-separated path, replacing falsy intermediates with objects. Paths are unchecked:
 * inherited properties are followed, and traversal through a truthy primitive can throw.
 */
export function setObjectValue<T>(obj: T, key: string, value: any): T {
    const target = obj as any;
    const splitKey = key.split(".");
    if (splitKey.length > 1) {
        const firstKey = splitKey.shift()!;
        if (!target[firstKey]) {
            target[firstKey] = {};
        }
        target[firstKey] = setObjectValue(target[firstKey], splitKey.join("."), value);
        return obj;
    }

    target[key] = value;
    return obj;
}

/**
 * Returns preset pairs for reverse proxies or other non-custom models with `applyAdditionalParamsToAll` enabled.
 * Custom models use only their definition's newline-separated `key=value` pairs, splitting on the first `=` without
 * trimming. A missing model id, custom definition, or custom parameter text returns an empty list.
 */
export function getAdditionalParameters(db: RequestDb, aiModel?: string): [string, string][] {
    if (!aiModel) {
        return [];
    }

    if (aiModel === "reverse_proxy") {
        return [...(db.additionalParams ?? [])];
    }

    if (!aiModel.startsWith("xcustom:::")) {
        return db.applyAdditionalParamsToAll ? [...(db.additionalParams ?? [])] : [];
    }

    const found = db.customModels.find((model) => model.id === aiModel);
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

/**
 * The same rule as `src/ts/process/request/shared.ts` `applyAdditionalParameters`: it can override or delete body
 * fields and headers, an adapter may still set fields after it, and value parsing applies to body fields only.
 */
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

/**
 * The same rule as `src/ts/process/request/shared.ts` `applyParameters`, over the request's `db`: the caller's
 * parameters from the preset for every mode, never its stored `seperateParameters` fields.
 */
export function applyParameters(
    data: Record<string, any>,
    parameters: LLMParameter[],
    rename: Partial<Record<LLMParameter, string>>,
    arg: {
        ignoreTopKIfZero?: boolean;
        modelId: string;
    },
    db: RequestDb,
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

    for (const parameter of parameters) {
        let value: number | string = 0;
        if (isReasoningCapabilityParameter(parameter)) {
            continue;
        }
        if (parameter === "top_k" && arg.ignoreTopKIfZero && db.top_k === 0) {
            continue;
        }
        switch (parameter) {
            case "temperature": {
                value = db.temperature === -1000 ? -1000 : db.temperature / 100;
                break;
            }
            case "top_k": {
                value = db.top_k;
                break;
            }
            case "repetition_penalty": {
                value = db.repetition_penalty;
                break;
            }
            case "min_p": {
                value = db.min_p;
                break;
            }
            case "top_a": {
                value = db.top_a;
                break;
            }
            case "top_p": {
                value = db.top_p;
                break;
            }
            case "reasoning_effort": {
                value = getEffort(
                    db.reasoningEffort,
                    reasoningDisabledEffort,
                    supportsXHighReasoning,
                    reasoningMinEffort,
                );
                break;
            }
            case "verbosity": {
                value = getVerbosity(db.verbosity);
                break;
            }
            case "frequency_penalty": {
                value = db.frequencyPenalty === -1000 ? -1000 : db.frequencyPenalty / 100;
                break;
            }
            case "presence_penalty": {
                value = db.PresensePenalty === -1000 ? -1000 : db.PresensePenalty / 100;
                break;
            }
            case "thinking_tokens": {
                value = db.thinkingTokens;
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
