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

/**
 * Whether `entry` is one piece of a tool's answer as the request adapters read it (the MCP content
 * the client's `callTool` returns): text, an image or audio with its data and MIME type, or a
 * resource.
 */
export function isToolContentEntry(entry: unknown): boolean {
    if (!entry || typeof entry !== "object") {
        return false;
    }
    const content = entry as Record<string, unknown>;
    return (
        (content.type === "text" && typeof content.text === "string") ||
        ((content.type === "image" || content.type === "audio") &&
            typeof content.data === "string" &&
            typeof content.mimeType === "string") ||
        (content.type === "resource" && !!content.resource && typeof content.resource === "object")
    );
}
