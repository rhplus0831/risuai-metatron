import type { botPreset } from "../../../../shared/database.ts";
import { normalizePresets } from "../../../../shared/presets.ts";
import { requireArrayOfObjects } from "./shared.ts";

/**
 * The `presets` collection (`botPresets`): `normalizePresets`, the same function the client runs
 * in `setDatabase`, so what the client sends is already its fixed point. Every preset gets the
 * canonical fields and an id (a duplicate is re-keyed); an empty list, or a missing record being
 * materialized, becomes one default preset.
 */
export function normalizePresetCollection(input: unknown): botPreset[] {
    return normalizePresets(input === undefined ? [] : requireArrayOfObjects(input, "presets"));
}
