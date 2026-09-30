import { isRecordId, newId } from "./ids.ts";
import type { TranslatorPreset } from "./settings.ts";

export const defaultTranslatorPrompt =
    "You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.";

export function getNormalizedTranslatorPresetName(name: unknown, index: number): string {
    if (typeof name === "string" && name.trim().length > 0) {
        return name;
    }

    return `Preset ${index + 1}`;
}

/**
 * A translator preset with `prompt` and `maxResponse` taken from `existing` when they have the right
 * type. `existing.id` is kept when it is a valid record id; otherwise a new id is assigned.
 */
export function createTranslatorPreset(
    name = "New Preset",
    existing: Partial<TranslatorPreset> = {},
): TranslatorPreset {
    return {
        id: isRecordId(existing.id) ? existing.id : newId(),
        name,
        prompt: typeof existing.prompt === "string" ? existing.prompt : "",
        maxResponse:
            typeof existing.maxResponse === "number" && Number.isFinite(existing.maxResponse)
                ? existing.maxResponse
                : 1000,
    };
}
