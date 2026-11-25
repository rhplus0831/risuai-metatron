// A permanent chat deletion for the server tests (not a test file itself).
import type { ChatTrashAnswer } from "../../../shared/chats.ts";
import type { ResourceStore } from "../data/resourceStore.ts";

/**
 * Deletes a chat permanently the way the store allows it: trash at its current revision, then delete
 * with the token the trash returned (two commits). Throws on any refusal, such as `lastActiveChat`
 * when the character has no other active chat. Returns both answers.
 */
export function deleteChatThroughTrash(
    store: ResourceStore,
    characterId: string,
    chatId: string,
    chatHeld: (characterId: string, id: string) => boolean = () => false,
): { trashed: ChatTrashAnswer; deleted: ChatTrashAnswer } {
    const state = store.chatTrashState(characterId, chatId);
    if (!state) {
        throw new Error(`delete ${characterId}/${chatId}: no such chat`);
    }
    const trashed = store.changeChatTrash(
        "trash",
        { characterId, chatId, revision: state.revision },
        store.epoch(),
        chatHeld,
    );
    if ("error" in trashed) {
        throw new Error(`trash ${characterId}/${chatId}: ${JSON.stringify(trashed)}`);
    }
    const deleted = store.changeChatTrash(
        "delete",
        { characterId, chatId, revision: trashed.revision },
        store.epoch(),
        chatHeld,
    );
    if ("error" in deleted) {
        throw new Error(`delete ${characterId}/${chatId}: ${JSON.stringify(deleted)}`);
    }
    return { trashed, deleted };
}
