import type { botPreset, ModelPreset, ModelProfile } from "../../../../shared/database.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../../shared/presets.ts";
import { requireArrayOfObjects } from "./shared.ts";

/**
 * The `presets` collection (`botPresets`, the prompt presets): `normalizePresets`, the same function
 * the client runs, so what the client sends is already its fixed point. Every preset gets the
 * canonical prompt fields and an id (a duplicate is re-keyed; model fields are dropped); an empty
 * list, or a missing record being materialized, becomes one default preset.
 */
export function normalizePresetCollection(input: unknown): botPreset[] {
    return normalizePresets(input === undefined ? [] : requireArrayOfObjects(input, "presets"));
}

/**
 * The `modelPresets` collection (`docs/plan/split-preset.md`): `normalizeModelPresets`, with the
 * same rules as the prompt presets over the model fields; never empty.
 */
export function normalizeModelPresetCollection(input: unknown): ModelPreset[] {
    return normalizeModelPresets(input === undefined ? [] : requireArrayOfObjects(input, "modelPresets"));
}

/** Shared model profiles: defaults, unique ids, and one materialized default profile; never empty. */
export function normalizeModelProfileCollection(input: unknown): ModelProfile[] {
    return normalizeModelProfiles(input === undefined ? [] : requireArrayOfObjects(input, "modelProfiles"));
}
