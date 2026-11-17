import { untrack } from "svelte";
import { chatEntry, chatOwnerToken, findChat, heldMessageById, onChatRemoved, type ChatRef } from "./chatStore.svelte";
import type { StoredTranslationEdit } from "../translator/storedTranslation.svelte";

type EditorKind = "message" | "translation";
export interface MessageEditorDraft {
    open: boolean;
    text: string;
    base: string;
    translation?: StoredTranslationEdit;
}

const drafts = new Map<string, { ref: ChatRef; owner: string; draft: MessageEditorDraft; dispose: () => void }>();
const keyOf = (ref: ChatRef, messageId: string, kind: EditorKind) =>
    JSON.stringify([ref.chaId, ref.chatId, messageId, kind]);

/** Row drafts and their open state live for this tab, including while Settings has destroyed the chat screen. */
export function findMessageEditorDraft(ref: ChatRef, messageId: string, kind: EditorKind) {
    const entry = drafts.get(keyOf(ref, messageId, kind));
    if (entry && entry.owner !== chatOwnerToken(ref.chaId)) {
        closeMessageEditorDraft(ref, messageId, kind);
        return undefined;
    }
    return entry?.draft;
}

export function openMessageEditorDraft(
    ref: ChatRef,
    messageId: string,
    kind: EditorKind,
    initial: Omit<MessageEditorDraft, "open">,
): MessageEditorDraft {
    const key = keyOf(ref, messageId, kind);
    const existing = findMessageEditorDraft(ref, messageId, kind);
    if (existing) {
        existing.open = true;
        return existing;
    }
    const owner = chatOwnerToken(ref.chaId);
    const draft = $state({ ...initial, open: true });
    const dispose = $effect.root(() => {
        $effect(() => {
            // Eviction is not deletion: an unloaded member keeps its editor until its next read.
            if (
                !chatEntry(ref) ||
                (findChat(ref) && !heldMessageById(ref, messageId)) ||
                owner !== chatOwnerToken(ref.chaId)
            ) {
                untrack(() => closeMessageEditorDraft(ref, messageId, kind));
            }
        });
    });
    drafts.set(key, { ref: { ...ref }, owner, draft, dispose });
    return draft;
}

export function closeMessageEditorDraft(ref: ChatRef, messageId: string, kind: EditorKind) {
    const key = keyOf(ref, messageId, kind);
    drafts.get(key)?.dispose();
    drafts.delete(key);
}

onChatRemoved((removal) => {
    for (const [key, entry] of drafts) {
        if (entry.ref.chaId === removal.chaId && (removal.chatId === null || entry.ref.chatId === removal.chatId)) {
            entry.dispose();
            drafts.delete(key);
        }
    }
});
