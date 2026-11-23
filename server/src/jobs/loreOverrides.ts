import type { character } from "../../../shared/database.ts";
import { orphanedOverrideEntries, type OrphanedOverrideEntry } from "../../../shared/lore/overrides.ts";
import type { ResourceStore } from "../data/resourceStore.ts";

/** Checks chat metadata against the owner already read at admission. The job scope handles a missing owner. */
export function readOrphanedOverrideEntries(
    store: ResourceStore,
    ref: { characterId: string; chatId: string },
    owner: Pick<character, "globalLore"> | null,
): OrphanedOverrideEntry[] {
    const overrides = store.chatMeta(ref.characterId, ref.chatId)?.data.loreOverrides ?? [];
    if (overrides.length === 0 || !owner) {
        return [];
    }
    return orphanedOverrideEntries(owner.globalLore ?? [], overrides);
}
