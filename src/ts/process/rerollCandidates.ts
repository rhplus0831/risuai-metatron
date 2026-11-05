import type { Chat, Message } from "../../../shared/database.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { isRerollCarrier } from "../../../shared/rerollCandidates.ts";
import { language } from "src/lang";
import {
    type ChatRef,
    chatHasUnackedWork,
    findChat,
    isChatBehind,
    isMessageLocked,
    pinChat,
    selectCandidate,
} from "../storage/chatStore.svelte";
import { flushResources, refreshStaleChat } from "../storage/resourceSync.svelte";
import { chatStatusKey, isChatBusy } from "./chatStatus.svelte";

const switching = new Set<string>();
const unsettled = new Set<string>();

/** The newest reply when it is the only reply in the turn; trailing comments do not hide it. */
export function rerollCarrier(chat: Pick<DeepReadonly<Chat>, "message">): DeepReadonly<Message> | null {
    const last = chat.message.findLast((message) => !message.isComment);
    return last?.chatId && isRerollCarrier(chat, last.chatId) ? last : null;
}

/** The neighboring candidate's stable id, or null at either end of the stored list. */
export function neighborCandidateId(message: DeepReadonly<Message> | null, step: -1 | 1): string | null {
    return message?.candidates?.[(message.selected ?? 0) + step]?.id ?? null;
}

/**
 * One switch per chat until saving and any required read settle. The store applies it optimistically;
 * a refusal replaces the mirror on the idle read. A failed read never retries the old selection.
 */
export async function switchCandidate(ref: ChatRef, messageId: string, candidateId: string): Promise<void> {
    const key = chatStatusKey(ref);
    if (switching.has(key) || (unsettled.has(key) && (chatHasUnackedWork(ref) || isChatBehind(ref))))
        throw new Error(language.rerollCandidatePending);
    if (isChatBusy(ref) || isMessageLocked(ref, messageId)) throw new Error(language.chatGenerating);
    const chat = findChat(ref);
    if (!chat || !isRerollCarrier(chat, messageId)) throw new Error(language.rerollCandidateUnavailable);
    unsettled.delete(key);
    switching.add(key);
    const release = pinChat(ref);
    try {
        selectCandidate(ref, messageId, candidateId);
        unsettled.add(key);
        await flushResources();
        if (!(await refreshStaleChat(ref)) || chatHasUnackedWork(ref))
            throw new Error(language.rerollCandidateRefreshFailed);
        unsettled.delete(key);
    } finally {
        release();
        switching.delete(key);
    }
}
