import { isRecordId, newId } from "./ids.ts";
import type { HypaV3Preset, HypaV3Settings } from "./memory.ts";

/**
 * A HypaV3 preset with every setting filled: known keys of `existingSettings` with the right type
 * are kept, the rest take their defaults. `id` is kept when it is a valid record id, otherwise a new
 * one is assigned (a copy or an import passes none, so it gets a fresh id).
 */
export function createHypaV3Preset(name = "New Preset", existingSettings = {}, id?: unknown): HypaV3Preset {
    const settings: HypaV3Settings = {
        summarizationModel: "subModel",
        summarizationPrompt: "",
        reSummarizationPrompt: "",
        memoryTokensRatio: 0.2,
        extraSummarizationRatio: 0,
        maxChatsPerSummary: 6,
        recentMemoryRatio: 0.4,
        similarMemoryRatio: 0.4,
        enableSimilarityCorrection: false,
        preserveOrphanedMemory: false,
        processRegexScript: false,
        doNotSummarizeUserMessage: false,
        summaryChunkSeparator: "\\n\\n",
        // Experimental
        useExperimentalImpl: false,
        summarizationRequestsPerMinute: 20,
        summarizationMaxConcurrent: 1,
        embeddingRequestsPerMinute: 100,
        embeddingMaxConcurrent: 1,
        alwaysToggleOn: false,
        queryChatCount: 3,
    };

    if (existingSettings && typeof existingSettings === "object" && !Array.isArray(existingSettings)) {
        const target = settings as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(existingSettings)) {
            // Own keys only: `in` also matches `__proto__`, whose assignment would swap the prototype.
            if (Object.hasOwn(target, key) && typeof value === typeof target[key]) {
                target[key] = value;
            }
        }
    }

    return {
        id: isRecordId(id) ? id : newId(),
        name,
        settings,
    };
}
