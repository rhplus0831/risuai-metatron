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

/** Keep the prompt half of a check's former combined preset fixture. */
export function promptFixture(preset) {
    const fields = { ...preset };
    for (const key of FORWARDED_MODEL_PRESET_KEYS) delete fields[key];
    return fields;
}
