import type { SettingItem } from "./types";

/**
 * The items of `source` with the given ids, in the order of `ids`: the same objects, never copies, so a
 * section built from a leaf array keeps `getFullSettingsData` listing each item once. Throws on an id
 * `source` does not hold and on an id asked for twice. Kept apart from `utils.ts`, which imports the
 * leaf arrays that call this.
 */
export function itemsById(source: readonly SettingItem[], ids: readonly string[]): SettingItem[] {
    const byId = new Map(source.map((item) => [item.id, item]));
    const seen = new Set<string>();
    return ids.map((id) => {
        const item = byId.get(id);
        if (!item) throw new Error(`Unknown setting item id: ${id}`);
        if (seen.has(id)) throw new Error(`Duplicate setting item id: ${id}`);
        seen.add(id);
        return item;
    });
}
