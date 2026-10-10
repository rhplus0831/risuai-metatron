import { randomUUID } from "node:crypto";
import { normalizeModelProfile, MODEL_PROFILE_FIELDS } from "../../shared/presets.ts";
import { FORWARDED_MODEL_PRESET_KEYS } from "../../shared/sections.ts";

/** Build explicit profile/slot resource writes from a check's flat model configuration. */
export function modelFixtureOps(configuration, modelPresets, modelProfiles) {
    const options = Object.fromEntries(
        MODEL_PROFILE_FIELDS.filter((field) => field in configuration).map((field) => [field, configuration[field]]),
    );
    const profiles = new Map();
    const profileId = (modelId) => {
        if (!profiles.has(modelId))
            profiles.set(
                modelId,
                normalizeModelProfile({ ...options, id: randomUUID(), name: `Playwright ${modelId}`, modelId }),
            );
        return profiles.get(modelId).id;
    };
    const preset = {
        ...modelPresets.data[0],
        mainSlot: { profileId: profileId(configuration.aiModel) },
        subSlot: { profileId: profileId(configuration.subModel ?? configuration.aiModel) },
        auxSlots: {},
    };
    for (const mode of ["memory", "translate", "emotion", "otherAx"]) {
        const modelId = configuration.seperateModels?.[mode];
        if (modelId) preset.auxSlots[mode] = { profileId: profileId(modelId) };
    }
    if (configuration.seperateModelsForAxModels !== undefined)
        preset.seperateModelsForAxModels = configuration.seperateModelsForAxModels;
    return [
        {
            kind: "modelProfiles",
            id: "main",
            baseRevision: modelProfiles.revision,
            data: [...modelProfiles.data, ...profiles.values()],
        },
        {
            kind: "modelPresets",
            id: "main",
            baseRevision: modelPresets.revision,
            data: [preset, ...modelPresets.data.slice(1)],
        },
    ];
}

/**
 * The binding a seeded chat needs before it can be sent (`docs/plan/chat-binding.md`: a chat is sent
 * only with its own model preset, prompt preset, and persona, and never with the tab's selection):
 * the first model preset, whose slots `modelFixtureOps` points at the mock provider, the first prompt
 * preset, and the first persona, as the resource reads answer them. Spread into a chat's `create` op.
 */
export function chatBindingFixture(modelPresets, presets, personas) {
    return {
        modelPresetId: modelPresets.data[0].id,
        promptPresetId: presets.data[0].id,
        bindedPersona: personas.data[0].id,
    };
}

/** Keep the prompt half of a check's former combined preset fixture. */
export function promptFixture(preset) {
    const fields = { ...preset };
    for (const key of FORWARDED_MODEL_PRESET_KEYS) delete fields[key];
    return fields;
}
