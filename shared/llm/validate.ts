import type { LLMModel } from "../llm.ts";
import { isPlainObject } from "../valueKinds.ts";

/**
 * Whether `model` carries the `LLMModel` fields the server reads (`shared/llm.ts`): the hook list's
 * provider descriptors (`server/src/jobs/channel.ts`) and a request's dynamic model
 * (`server/src/routes/llm.ts`) are checked with it.
 */
export function isModelDescriptor(model: unknown): model is LLMModel {
    if (!isPlainObject(model)) {
        return false;
    }
    const strings = ["id", "name", "internalID"] as const;
    return (
        strings.every((field) => typeof model[field] === "string") &&
        typeof model.provider === "number" &&
        typeof model.format === "number" &&
        typeof model.tokenizer === "number" &&
        Array.isArray(model.flags) &&
        model.flags.every((flag) => typeof flag === "number") &&
        Array.isArray(model.parameters) &&
        model.parameters.every((parameter) => typeof parameter === "string")
    );
}
