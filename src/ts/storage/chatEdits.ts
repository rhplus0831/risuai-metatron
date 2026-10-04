import type { Chat } from "../../../shared/database.ts";
import {
    applyChatResult,
    captureChatBaseline,
    type ChatRef,
    currentChatRef,
    findChat,
    setChatMeta,
} from "./chatStore.svelte";

/**
 * Helpers over the chat module for writers that work on a whole chat: they edit a detached copy,
 * and only what the edit changed is applied to the chat as it is afterwards (`applyChatResult`), so
 * changes made meanwhile by others (a stream, another handler, another tab) are kept.
 */

/** Runs `edit` on a copy of a chat (it may await) and applies its changes. Does nothing when the chat is gone. */
export async function editChat(ref: ChatRef, edit: (chat: Chat) => void | Promise<void>): Promise<void> {
    if (!findChat(ref)) {
        return;
    }
    const baseline = captureChatBaseline(ref);
    const draft = structuredClone(baseline.chat);
    await edit(draft);
    applyChatResult(baseline, draft);
}

/** `editChat` for a synchronous edit. */
export function editChatSync(ref: ChatRef, edit: (chat: Chat) => void) {
    if (!findChat(ref)) {
        return;
    }
    const baseline = captureChatBaseline(ref);
    const draft = structuredClone(baseline.chat);
    edit(draft);
    applyChatResult(baseline, draft);
}

/** `editChatSync` on the selected character's selected chat (nothing when there is none). */
export function editCurrentChat(edit: (chat: Chat) => void) {
    const ref = currentChatRef();
    if (ref) {
        editChatSync(ref, edit);
    }
}

/** Sets one field of the selected chat (nothing when there is none). */
export function setCurrentChatMeta(set: Partial<Chat>, unset: readonly string[] = []) {
    const ref = currentChatRef();
    if (ref) {
        setChatMeta(ref, set, unset);
    }
}
