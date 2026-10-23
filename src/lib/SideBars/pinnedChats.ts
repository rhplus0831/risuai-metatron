import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import type { ChatListEntry } from "src/ts/storage/chatStore.svelte";

export const HOME_PINNED_CHAT_COLLAPSED_LIMIT = 6;

export interface PinnedChatItem {
    chaId: string;
    chatId: string;
    chatName: string;
    characterName: string;
    characterImage: string;
}

/** Collects pins from list metadata only, expanding folders in place before unordered characters. */
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
