import type { ChatLoreOverride, loreBook } from "../database.ts";
import type { DeepReadonly } from "../readonly.ts";

/**
 * Applies the first override for each id to the first matching entry in the original owner lore,
 * preserving owner order and leaving later owner entries with the same id untouched. Off entries
 * are removed; invalid or unmatched override ids are returned as orphans in override order.
 * Returns references without mutating or cloning the inputs; callers that mutate must copy first.
 */
export function mergeOwnerLore(
    ownerLore: DeepReadonly<loreBook[]>,
    overrides: DeepReadonly<ChatLoreOverride[]>,
): { lore: DeepReadonly<loreBook>[]; orphans: DeepReadonly<ChatLoreOverride>[] } {
    const ownerIndexes = new Map<string, number>();
    for (let i = 0; i < ownerLore.length; i++) {
        const id = ownerLore[i]?.id;
        if (typeof id === "string" && id.length > 0 && !ownerIndexes.has(id)) {
            ownerIndexes.set(id, i);
        }
    }

    const replacements = new Map<number, DeepReadonly<ChatLoreOverride>>();
    const orphans: DeepReadonly<ChatLoreOverride>[] = [];
    for (const override of overrides) {
        const id = override?.entry?.id;
        const index = typeof id === "string" && id.length > 0 ? ownerIndexes.get(id) : undefined;
        if (index === undefined) {
            orphans.push(override);
        } else if (!replacements.has(index)) {
            replacements.set(index, override);
        }
    }

    const lore: DeepReadonly<loreBook>[] = [];
    for (let i = 0; i < ownerLore.length; i++) {
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
 * Ids turned off following the merge's first-override-per-id rule. Only valid, non-empty ids
 * participate; an id need not match an owner entry, and later overrides for it are ignored.
 */
export function offOverrideIds(overrides: DeepReadonly<ChatLoreOverride[]>): Set<string> {
    const seen = new Set<string>();
    const offIds = new Set<string>();
    for (const override of overrides) {
        const id = override?.entry?.id;
        if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
            continue;
        }
        seen.add(id);
        if (override.off === true) {
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
    return mergeOwnerLore(ownerLore, overrides).orphans;
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
