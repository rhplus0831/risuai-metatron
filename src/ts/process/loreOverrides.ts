import { language } from "src/lang";
import { orphanedOverrideEntries, type OrphanedOverrideEntry } from "../../../shared/lore/overrides.ts";
import { characterList } from "../storage/characterStore.svelte";
import { findChat, type ChatRef } from "../storage/chatStore.svelte";

/** Orphans in the loaded chat's overrides of its owner's lore, including a group's own lore. */
export function chatOrphanedOverrideEntries(ref: ChatRef): OrphanedOverrideEntry[] {
    const chat = findChat(ref);
    if (!chat) {
        return [];
    }
    const overrides = chat.loreOverrides ?? [];
    if (overrides.length === 0) {
        return [];
    }
    const owner = characterList().find((character) => character?.chaId === ref.chaId);
    return owner ? orphanedOverrideEntries(owner.globalLore ?? [], overrides) : [];
}

export function chatLoreOverrideRefusalText(entries: readonly OrphanedOverrideEntry[]): string {
    const strings = language.chatLoreOverrides;
    return [strings.refused, ...entries.map((entry) => entry.name), "", strings.fixes].join("\n");
}
