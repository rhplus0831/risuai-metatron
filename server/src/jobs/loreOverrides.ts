import type { character, groupChat } from "../../../shared/database.ts";
import { orphanedOverrideEntries, type OrphanedOverrideEntry } from "../../../shared/lore/overrides.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";

/** Reads no messages and reads the owner (a group's own record too) only when the chat has overrides. */
export function readOrphanedOverrideEntries(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    ref: { characterId: string; chatId: string },
): OrphanedOverrideEntry[] {
    const overrides = store.chatMeta(ref.characterId, ref.chatId)?.data.loreOverrides ?? [];
    if (overrides.length === 0) {
        return [];
    }
    const charactersKind = kinds.get(RESOURCE_KIND.characters);
    if (!charactersKind) {
        throw new Error(`Unknown resource kind ${RESOURCE_KIND.characters}`);
    }
    const ownerRead = store.readRefs([{ kind: charactersKind, id: ref.characterId }]).items[0];
    // A missing owner fails when the job loads its scope.
    if (ownerRead.data === null || ownerRead.revision === null) {
        return [];
    }
    const owner = ownerRead.data as character | groupChat;
    return orphanedOverrideEntries(owner.globalLore ?? [], overrides);
}
