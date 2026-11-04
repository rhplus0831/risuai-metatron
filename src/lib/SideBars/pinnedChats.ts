import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import type { ChatListEntry } from "src/ts/storage/chatStore.svelte";

/**
 * The pinned-chat projection, shared by the sidebar rail (`src/lib/SideBars/PinnedChatsRail.svelte`, from
 * `src/lib/SideBars/Sidebar.svelte`) and the home cards (`src/lib/UI/MainMenu.svelte`), so both list the same pins
 * in the same order. Both open a pin through `openPinnedChat` (`src/ts/globalApi.svelte.ts`), which selects the
 * chat before the character.
 */

/** How many pinned cards the home page shows before its show-all toggle. */
export const HOME_PINNED_CHAT_COLLAPSED_LIMIT = 6;

export interface PinnedChatItem {
    chaId: string;
    chatId: string;
    chatName: string;
    characterName: string;
    characterImage: string;
}

/**
 * Collects pins from list metadata only, expanding folders in place before unordered characters. A trashed
 * character's pins are left out.
 */
export function collectPinnedChats(
    characters: readonly AnyClientCharacter[],
    characterOrder: readonly (string | { data: readonly string[] })[] | null | undefined,
    chatListOf: (chaId: string) => ChatListEntry[],
    unnamedFallback: string,
): PinnedChatItem[] {
    const charactersById = new Map(characters.map((character) => [character.chaId, character]));
    const orderedIds = new Set<string>();
    for (const entry of characterOrder ?? []) {
        if (typeof entry === "string") {
            orderedIds.add(entry);
        } else {
            for (const id of entry.data ?? []) {
                orderedIds.add(id);
            }
        }
    }
    for (const character of characters) {
        orderedIds.add(character.chaId);
    }

    const pinned: PinnedChatItem[] = [];
    for (const chaId of orderedIds) {
        const character = charactersById.get(chaId);
        if (!character || !chaId || character.trashTime) {
            continue;
        }
        for (const chat of chatListOf(chaId)) {
            if (chat.pinned === true) {
                pinned.push({
                    chaId,
                    chatId: chat.id,
                    chatName: chat.name?.trim() ? chat.name : unnamedFallback,
                    characterName: character.name,
                    characterImage: character.image ?? "",
                });
            }
        }
    }
    return pinned;
}
