import {
    settings,
    activeModelPreset,
    isModelPresetRootKey,
    writeSettingsRoot,
} from "../../src/ts/storage/settingsViews.svelte.ts";
import {
    addModelProfile,
    updateModelProfile,
    setMainModelSlot,
    setSubModelSlot,
    setAuxModelSlot,
} from "../../src/ts/storage/collectionStore.svelte.ts";
import { MODEL_PROFILE_ROOT_FIELDS } from "../../shared/sections.ts";

/** A browser check selects tagged slots explicitly; legacy root model-id writes obey O8. */
export function applyModelFixtureSettings(configuration) {
    const presetId = activeModelPreset.id;
    const choose = (modelId) => {
        const matches = settings.modelProfiles.filter((profile) => profile.modelId === modelId);
        return matches.length === 1 ? matches[0].id : addModelProfile({ name: `Playwright ${modelId}`, modelId });
    };
    if (configuration.aiModel !== undefined) setMainModelSlot(presetId, choose(configuration.aiModel));
    if (configuration.subModel !== undefined) setSubModelSlot(presetId, choose(configuration.subModel));
    if (configuration.seperateModels) {
        for (const [mode, modelId] of Object.entries(configuration.seperateModels))
            setAuxModelSlot(presetId, mode, modelId ? choose(modelId) : null);
    }
    const mainProfileId = activeModelPreset.mainSlot.profileId;
    const options = Object.fromEntries(
        MODEL_PROFILE_ROOT_FIELDS.filter((field) => field in configuration).map((field) => [
            field,
            configuration[field],
        ]),
    );
    if (Object.keys(options).length) updateModelProfile(mainProfileId, options);
    for (const [key, value] of Object.entries(configuration)) {
        if (!isModelPresetRootKey(key) || key === "seperateModelsForAxModels") writeSettingsRoot(key, value);
    }
}
