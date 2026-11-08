import { currentChatRef, selectedChat } from "./storage/chatStore.svelte";

/**
 * Transient fold target for the selected chat in src/ts/storage/chatStore.svelte.ts. The target
 * carries character, chat and message ids; its displayed index is derived from loaded messages,
 * never retained as an address. Selection changes hide an old target synchronously and clear it
 * in an effect. src/lib/ChatScreens/DefaultChatScreen.svelte renders and expands the fold.
 */

/**
 * `data` is `{ targetCharacterId, targetChatId, targetMessageId }`, or null for no fold. This module's
 * selection effect clears it when the selected chat changes; `src/lib/ChatScreens/DefaultChatScreen.svelte`
 * also clears it for message jumps and when the user expands the folded messages.
 */
export const chatFoldedState = $state<{
    data: null | {
        targetCharacterId: string;
        targetChatId: string;
        targetMessageId: string;
    };
}>({
    data: null,
});

const foldedIndex = $derived.by(() => {
    const target = chatFoldedState.data;
    if (!target) return -1;
    const ref = currentChatRef();
    if (target.targetCharacterId !== ref?.chaId || target.targetChatId !== ref.chatId) {
        return -1;
    }
    return selectedChat()?.message.findIndex((message) => message.chatId === target.targetMessageId) ?? -1;
});

/** A synchronous read never exposes the previous chat's fold while switch effects are pending. */
export const chatFoldedStateMessageIndex: { index: number } = {
    get index(): number {
        return foldedIndex;
    },
};

$effect.root(() => {
    $effect(() => {
        const target = chatFoldedState.data;
        if (!target) return;
        const ref = currentChatRef();
        if (target.targetCharacterId !== ref?.chaId || target.targetChatId !== ref.chatId) {
            chatFoldedState.data = null;
        }
    });
});

/**
 * Targets the selected chat reference. Numeric targets require a loaded message with an id; string
 * ids are accepted without checking that the message is loaded. Missing ref or empty target is a no-op.
 */
export function foldChatToMessage(targetMessageIdOrIndex: string | number) {
    const targetMessageId =
        typeof targetMessageIdOrIndex === "number"
            ? selectedChat()?.message[targetMessageIdOrIndex]?.chatId
            : targetMessageIdOrIndex;
    const ref = currentChatRef();
    if (!ref || !targetMessageId) {
        return;
    }
    chatFoldedState.data = {
        targetCharacterId: ref.chaId,
        targetChatId: ref.chatId,
        targetMessageId,
    };
}
