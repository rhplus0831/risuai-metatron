import type { ChatLoreOverride, loreBook } from "../database.ts";
import type { DeepReadonly } from "../readonly.ts";

type OverrideMatch = {
    /** Owner index → the first override for that entry's id (only the first owner entry per id). */
    replacements: Map<number, DeepReadonly<ChatLoreOverride>>;
    orphans: DeepReadonly<ChatLoreOverride>[];
    /** Owner indexes of the entries inside an off folder, nested folders and their entries included. */
    offFolderMembers: Set<number>;
};

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function matchOverrides(
    ownerLore: DeepReadonly<loreBook[]>,
    overrides: DeepReadonly<ChatLoreOverride[]>,
): OverrideMatch {
    const ownerIndexes = new Map<string, number>();
    for (let i = 0; i < ownerLore.length; i++) {
        const id = ownerLore[i]?.id;
        if (isNonEmptyString(id) && !ownerIndexes.has(id)) {
            ownerIndexes.set(id, i);
        }
    }

    const replacements = new Map<number, DeepReadonly<ChatLoreOverride>>();
    const orphans: DeepReadonly<ChatLoreOverride>[] = [];
    for (const override of overrides) {
        const id = override?.entry?.id;
        const index = isNonEmptyString(id) ? ownerIndexes.get(id) : undefined;
        if (index === undefined) {
            orphans.push(override);
        } else if (!replacements.has(index)) {
            replacements.set(index, override);
        }
    }

    // Membership follows the owner's current folder keys, never the frozen copy's: an off folder
    // collects every owner entry whose `folder` equals its key, and a collected folder adds its own
    // key until nothing changes (the key set ends cycles). Only non-empty string keys count, so a
    // keyless folder collects no ungrouped entry.
    const keys = new Set<string>();
    const pending: string[] = [];
    function addKey(key: unknown) {
        if (isNonEmptyString(key) && !keys.has(key)) {
            keys.add(key);
            pending.push(key);
        }
    }
    for (const [index, override] of replacements) {
        const owner = ownerLore[index];
        if (override.off === true && owner?.mode === "folder") {
            addKey(owner.key);
        }
    }
    const offFolderMembers = new Set<number>();
    while (pending.length > 0) {
        const key = pending.pop();
        for (let i = 0; i < ownerLore.length; i++) {
            const entry = ownerLore[i];
            if (offFolderMembers.has(i) || !isNonEmptyString(entry?.folder) || entry.folder !== key) {
                continue;
            }
            offFolderMembers.add(i);
            if (entry.mode === "folder") {
                addKey(entry.key);
            }
        }
    }
    return { replacements, orphans, offFolderMembers };
}

/**
 * Applies the first override for each id to the first matching entry in the original owner lore,
 * preserving owner order and leaving later owner entries with the same id untouched. Off entries
 * are removed; invalid or unmatched override ids are returned as orphans in override order.
 * An off override of an owner folder (`mode: "folder"`) also removes every entry inside it by the
 * owner's current folder keys, nested folders included, whatever their own overrides; those
 * overrides are not orphans.
 * Returns references without mutating or cloning the inputs; callers that mutate must copy first.
 */
export function mergeOwnerLore(
    ownerLore: DeepReadonly<loreBook[]>,
    overrides: DeepReadonly<ChatLoreOverride[]>,
): { lore: DeepReadonly<loreBook>[]; orphans: DeepReadonly<ChatLoreOverride>[] } {
    const { replacements, orphans, offFolderMembers } = matchOverrides(ownerLore, overrides);
    const lore: DeepReadonly<loreBook>[] = [];
    for (let i = 0; i < ownerLore.length; i++) {
        if (offFolderMembers.has(i)) {
            continue;
        }
        const override = replacements.get(i);
        if (!override) {
            lore.push(ownerLore[i]);
        } else if (!override.off) {
            lore.push(override.entry);
        }
    }
    return { lore, orphans };
}

/**
 * Ids turned off following the merge's first-override-per-id rule, plus the non-empty owner ids of
 * every entry an off folder removes (`mergeOwnerLore`). Only valid, non-empty ids participate; an
 * off override's id need not match an owner entry, and later overrides for it are ignored.
 */
export function offOverrideIds(
    ownerLore: DeepReadonly<loreBook[]>,
    overrides: DeepReadonly<ChatLoreOverride[]>,
): Set<string> {
    const seen = new Set<string>();
    const offIds = new Set<string>();
    for (const override of overrides) {
        const id = override?.entry?.id;
        if (!isNonEmptyString(id) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        if (override.off === true) {
            offIds.add(id);
        }
    }
    for (const index of matchOverrides(ownerLore, overrides).offFolderMembers) {
        const id = ownerLore[index]?.id;
        if (isNonEmptyString(id)) {
            offIds.add(id);
        }
    }
    return offIds;
}

/** Overrides with invalid ids or no match in the original owner lore, in override order. */
export function findOrphanedOverrides(
    ownerLore: DeepReadonly<loreBook[]>,
    overrides: DeepReadonly<ChatLoreOverride[]>,
): DeepReadonly<ChatLoreOverride>[] {
    return matchOverrides(ownerLore, overrides).orphans;
}

export type OrphanedOverrideEntry = { id: string; name: string };

/** Orphans named for a refusal; persisted override comments and keys may be missing or non-strings. */
export function orphanedOverrideEntries(
    ownerLore: DeepReadonly<loreBook[]>,
    overrides: DeepReadonly<ChatLoreOverride[]>,
): OrphanedOverrideEntry[] {
    return findOrphanedOverrides(ownerLore, overrides).map((override) => {
        const entry = override?.entry;
        const id = typeof entry?.id === "string" ? entry.id : "";
        const comment = typeof entry?.comment === "string" ? entry.comment.trim() : "";
        const key = typeof entry?.key === "string" ? entry.key.trim() : "";
        return { id, name: comment || key || id };
    });
}
