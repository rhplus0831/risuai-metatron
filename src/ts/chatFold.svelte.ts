import { currentChatRef, selectedChat } from "./storage/chatStore.svelte";

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
