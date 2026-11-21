import { untrack } from "svelte";
import { textHash } from "../../../shared/textHash.ts";
import { chatEntry, chatOwnerToken, findChat, heldMessageById, onChatRemoved, type ChatRef } from "./chatStore.svelte";
import type { StoredTranslationEdit } from "../translator/storedTranslation.svelte";

type EditorKind = "message" | "translation" | `cache:${string}` | `partial:${number}`;
interface PartialSelection {
    target: string | null;
    text: string;
    unique: boolean;
    before: string;
    after: string;
}
export interface MessageEditorDraft {
    open: boolean;
    text: string;
    base: string;
    translation?: StoredTranslationEdit;
}

const drafts = new Map<
    string,
    {
        ref: ChatRef;
        messageId: string | undefined;
        kind: EditorKind;
        owner: string;
        draft: MessageEditorDraft;
        selection?: PartialSelection;
        dispose: () => void;
    }
>();
const keyOf = (ref: ChatRef, messageId: string | undefined, kind: EditorKind) =>
    JSON.stringify([ref.chaId, ref.chatId, messageId, kind]);

/** Row drafts and their open state live for this tab, including while Settings has destroyed the chat screen. */
export function findMessageEditorDraft(ref: ChatRef, messageId: string | undefined, kind: EditorKind) {
    const entry = drafts.get(keyOf(ref, messageId, kind));
    if (entry && entry.owner !== chatOwnerToken(ref.chaId)) {
        closeMessageEditorDraft(ref, messageId, kind);
        return undefined;
    }
    return entry?.draft;
}

export function openMessageEditorDraft(
    ref: ChatRef,
    messageId: string | undefined,
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
                (messageId && findChat(ref) && !heldMessageById(ref, messageId)) ||
                owner !== chatOwnerToken(ref.chaId)
            ) {
                untrack(() => closeMessageEditorDraft(ref, messageId, kind));
            }
        });
    });
    drafts.set(key, { ref: { ...ref }, messageId, kind, owner, draft, dispose });
    return draft;
}

export function closeMessageEditorDraft(
    ref: ChatRef,
    messageId: string | undefined,
    kind: EditorKind,
    expected?: MessageEditorDraft,
) {
    const key = keyOf(ref, messageId, kind);
    const entry = drafts.get(key);
    if (!entry || (expected && entry.draft !== expected)) return;
    entry.draft.open = false;
    entry.dispose();
    drafts.delete(key);
}

let partialSequence = 0;
export function openPartialEditorDraft(
    ref: ChatRef,
    messageId: string,
    target: string | null,
    source: string,
    range: { start: number; end: number },
) {
    const text = source.slice(range.start, range.end);
    const selection = {
        target,
        text,
        unique: source.indexOf(text) === source.lastIndexOf(text),
        before: textHash(source.slice(0, range.start)),
        after: textHash(source.slice(range.end)),
    };
    let match: EditorKind | null | undefined;
    for (const entry of drafts.values()) {
        const old = entry.selection;
        if (
            entry.messageId !== messageId ||
            entry.ref.chaId !== ref.chaId ||
            entry.ref.chatId !== ref.chatId ||
            !old ||
            old.target !== target
        )
            continue;
        // Both sides identify the same range even if another writer replaced the paragraph itself.
        if (old.before === selection.before && old.after === selection.after) {
            match = entry.kind;
            break;
        }
        if (
            old.text === text &&
            (old.before === selection.before || old.after === selection.after || (old.unique && selection.unique))
        ) {
            // The range moved. If several drafts fit the new location, keep them until one can be identified.
            match = match === undefined ? entry.kind : null;
        }
    }
    const kind = match ?? (`partial:${++partialSequence}` as const);
    const draft = openMessageEditorDraft(ref, messageId, kind, { base: text, text });
    drafts.get(keyOf(ref, messageId, kind))!.selection = selection;
    return { draft, close: () => closeMessageEditorDraft(ref, messageId, kind, draft) };
}

onChatRemoved((removal) => {
    for (const entry of drafts.values()) {
        if (entry.ref.chaId === removal.chaId && (removal.chatId === null || entry.ref.chatId === removal.chatId)) {
            closeMessageEditorDraft(entry.ref, entry.messageId, entry.kind);
        }
    }
});
