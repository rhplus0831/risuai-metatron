import { isRecordId, newId } from "./ids.ts";
import type { HypaV3Preset, HypaV3Settings } from "./memory.ts";

/**
 * A HypaV3 preset with every setting filled: own, known keys of `existingSettings` with the right
 * type are kept. Numbers must also be finite, and `maxChatsPerSummary` and `queryChatCount` must be
 * integers >= 1. Invalid values take their defaults. `id` is kept when it is a valid record id,
 * otherwise a new one is assigned (a copy or an import passes none, so it gets a fresh id).
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
                if (typeof value === "number") {
                    if (!Number.isFinite(value)) {
                        continue;
                    }
                    if (
                        (key === "maxChatsPerSummary" || key === "queryChatCount") &&
                        (!Number.isInteger(value) || value < 1)
                    ) {
                        continue;
                    }
                }
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

/**
 * The selected HypaV3 preset: the one whose id is `hypaV3PresetId`, else the first (the server keeps
 * the list nonempty and the id valid; the fallback covers another client's deletion until reload).
 */
export function selectedHypaV3Preset(state: {
    hypaV3Presets?: HypaV3Preset[];
    hypaV3PresetId?: string;
}): HypaV3Preset | undefined {
    const presets = state.hypaV3Presets ?? [];
    return presets.find((preset) => preset.id === state.hypaV3PresetId) ?? presets[0];
}
