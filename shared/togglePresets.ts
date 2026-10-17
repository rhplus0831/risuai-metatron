import { isRecordId, newId } from "./ids.ts";
import {
    TOGGLE_KINDS,
    parseToggleSyntax,
    toggleDefault,
    toggleKindOf,
    toggleStorageKey,
    valueToggles,
    type ToggleKind,
} from "./prompt/toggles.ts";
import { isPlainObject } from "./valueKinds.ts";

/** Saved prompt-toggle values and kinds, both keyed by the bare toggle key. */
export type TogglePreset = {
    id: string;
    name: string;
    values: Record<string, string>;
    kinds: Record<string, ToggleKind>;
    createdAt: number;
    updatedAt: number;
};

/** Creates a preset with detached maps and one timestamp for creation and update. */
export function createTogglePreset(
    name: string,
    values: Record<string, string>,
    kinds: Record<string, ToggleKind>,
    id?: unknown,
): TogglePreset {
    const now = Date.now();
    return {
        id: isRecordId(id) ? id : newId(),
        name,
        values: { ...values },
        kinds: { ...kinds },
        createdAt: now,
        updatedAt: now,
    };
}

/** Capture resolved values, including defaults, using bare keys and the first definition of each. */
export function captureToggleValues(definitionsText: string, read: (storageKey: string) => string) {
    const toggles = valueToggles(parseToggleSyntax(definitionsText));
    return {
        values: Object.fromEntries(toggles.map((toggle) => [toggle.key, read(toggleStorageKey(toggle.key))])),
        kinds: Object.fromEntries(toggles.map((toggle) => [toggle.key, toggleKindOf(toggle)!])),
    };
}

function incompatibleValue(preset: TogglePreset, toggle: ReturnType<typeof valueToggles>[number]): boolean {
    if (Object.hasOwn(preset.kinds, toggle.key) && preset.kinds[toggle.key] !== toggleKindOf(toggle)) {
        return true;
    }
    if (toggle.type === "select" && Object.hasOwn(preset.values, toggle.key)) {
        const value = preset.values[toggle.key];
        const index = Number(value);
        return !/^\d+$/.test(value) || !Number.isInteger(index) || index < 0 || index >= toggle.options.length;
    }
    return false;
}

/** Only currently defined toggles are applied; missing or incompatible saved values use defaults. */
export function toggleValuesForChat(preset: TogglePreset, definitionsText: string): Record<string, string> {
    return Object.fromEntries(
        valueToggles(parseToggleSyntax(definitionsText)).map((toggle) => [
            toggleStorageKey(toggle.key),
            Object.hasOwn(preset.values, toggle.key) && !incompatibleValue(preset, toggle)
                ? preset.values[toggle.key]
                : toggleDefault(toggleKindOf(toggle)!),
        ]),
    );
}

/** Compare saved keys, kinds, and values without writing defaults or changing the preset. */
export function compareTogglePreset(
    preset: TogglePreset,
    definitionsText: string,
    read: (storageKey: string) => string,
) {
    const toggles = valueToggles(parseToggleSyntax(definitionsText));
    const defined = new Set(toggles.map((toggle) => toggle.key));
    const missing: string[] = [];
    const kindMismatch: string[] = [];
    const differing: string[] = [];
    for (const toggle of toggles) {
        const absent = !Object.hasOwn(preset.values, toggle.key);
        const incompatible = incompatibleValue(preset, toggle);
        if (absent) missing.push(toggle.key);
        if (incompatible) kindMismatch.push(toggle.key);
        if (absent || incompatible || preset.values[toggle.key] !== read(toggleStorageKey(toggle.key))) {
            differing.push(toggle.key);
        }
    }
    const stale = [...new Set([...Object.keys(preset.values), ...Object.keys(preset.kinds)])].filter(
        (key) => !defined.has(key),
    );
    return {
        missing,
        stale,
        kindMismatch,
        differing,
        hasMismatch: missing.length > 0 || stale.length > 0 || kindMismatch.length > 0,
        hasDifference: differing.length > 0 || stale.length > 0,
    };
}

/**
 * Normalizes plain data without mutating it: missing lists become empty, non-object entries are
 * dropped (the server rejects them first), and missing or duplicate ids get fresh ids. Timestamps
 * never read the clock, so normalizing the output again preserves its JSON.
 */
export function normalizeTogglePresets(input: unknown): TogglePreset[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const seen = new Set<string>();
    const presets: TogglePreset[] = [];
    for (const [index, entry] of input.entries()) {
        if (!isPlainObject(entry)) {
            continue;
        }
        const id = isRecordId(entry.id) && !seen.has(entry.id) ? entry.id : newId();
        seen.add(id);
        const createdAt = typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
        presets.push({
            id,
            name: typeof entry.name === "string" && entry.name.trim() ? entry.name : `Toggle Preset ${index + 1}`,
            values: Object.fromEntries(
                Object.entries(isPlainObject(entry.values) ? entry.values : {}).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
            ),
            kinds: Object.fromEntries(
                Object.entries(isPlainObject(entry.kinds) ? entry.kinds : {}).filter(
                    (entry): entry is [string, ToggleKind] => (TOGGLE_KINDS as readonly unknown[]).includes(entry[1]),
                ),
            ),
            createdAt,
            updatedAt:
                typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt,
        });
    }
    return presets;
}
