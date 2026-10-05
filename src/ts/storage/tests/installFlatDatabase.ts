import { FORWARDED_PRESET_KEYS } from "../../../../shared/sections.ts";
import { forwardedPresetField, installForwarding, reconcileSelection } from "../forwarding.svelte";
import { initializeRecords, takeRecordFields } from "../records.svelte";

/**
 * Takes the preset fields a flat fixture carries on its root (`FORWARDED_PRESET_KEYS`, by their
 * root names: `reasoningEffort`, `presetRegex`, ...) out of `raw`, and returns them under the
 * preset's own field names.
 */
export function takeRootPresetFields(raw: Record<string, unknown>): Record<string, unknown> {
    const preset: Record<string, unknown> = {};
    for (const rootKey of FORWARDED_PRESET_KEYS) {
        if (Object.hasOwn(raw, rootKey)) {
            preset[forwardedPresetField(rootKey)!] = raw[rootKey];
            delete raw[rootKey];
        }
    }
    return preset;
}

/**
 * Installs a flat database fixture (the shape the Node hosts and the pre-records tests read: the
 * selected preset's fields on the root) as `setDatabaseLite` installs a database, for a test that
 * mocks `database.svelte`: the root preset fields, if any, become the one preset's (`presetId`; a
 * fixture with `botPresets` has none on its root), every record field moves into the records, the
 * forwarding accessors go on `raw`, and the selection is resolved. Returns `raw`, now serving the
 * records.
 */
export function installFlatDatabase<T extends object>(raw: T, presetId = "fixture-preset"): T {
    const fields = raw as Record<string, unknown>;
    const preset = takeRootPresetFields(fields);
    if (Object.keys(preset).length > 0) {
        if (fields.botPresets !== undefined) {
            throw new Error("a fixture with presets carries its preset fields in them, not on its root");
        }
        fields.botPresets = [{ ...preset, id: presetId, name: presetId }];
    }
    initializeRecords(takeRecordFields(fields));
    installForwarding(raw);
    reconcileSelection(raw as never);
    return raw;
}
