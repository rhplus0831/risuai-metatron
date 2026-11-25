import { language } from "src/lang";
import { alertError } from "../alert";
import { orphanedOverrideEntries, type OrphanedOverrideEntry } from "../../../shared/lore/overrides.ts";
import { characterList } from "../storage/characterStore.svelte";
import { findChat, type ChatRef } from "../storage/chatStore.svelte";

/**
 * Checks loaded chat overrides against their owner's current lore with
 * `shared/lore/overrides.ts` and formats the refusal shared with server-job errors. Callers that
 * clear history or append input must check before those writes; the server's later refusal cannot
 * undo them. Missing chats or owners yield no locally detected orphans.
 */

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

/**
 * The alert text of an orphaned-override refusal, the orphans named one per line. Both refusals show it:
 * the local check (`refuseOrphanedOverrides`) and the server's 409 `chatLoreOverrideOrphaned`
 * (`runPinnedServerJob` in `src/ts/process/serverCommands.ts`).
 */
export function chatLoreOverrideRefusalText(entries: readonly OrphanedOverrideEntry[]): string {
    const strings = language.chatLoreOverrides;
    return [strings.refused, ...entries.map((entry) => entry.name), "", strings.fixes].join("\n");
}

/**
 * Alerts the refusal and answers true when the chat has orphaned overrides. A caller that writes the
 * chat before its send (a cleared history, an appended user message) checks first, since the server
 * refuses the send only after that write.
 */
export function refuseOrphanedOverrides(ref: ChatRef): boolean {
    const orphans = chatOrphanedOverrideEntries(ref);
    if (orphans.length === 0) {
        return false;
    }
    alertError(chatLoreOverrideRefusalText(orphans));
    return true;
}
