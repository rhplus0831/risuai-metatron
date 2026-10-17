import { isRecordId, newId } from "./ids.ts";
import { TOGGLE_KINDS, type ToggleKind } from "./prompt/toggles.ts";
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
