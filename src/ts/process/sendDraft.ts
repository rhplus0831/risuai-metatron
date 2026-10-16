import { v4 } from "uuid";
import type { ChatRef } from "../storage/chatStore.svelte";

export type SendDraft = { input: string; userMessageId: string };
export type SendDraftOutcome = {
    landed: boolean;
    ok: boolean;
    selected: boolean;
    composerEmpty: boolean;
};

const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;

/** Retains failed sends' text and ids, including when an absent message may just be waiting for hydration. */
export function createSendDrafts() {
    const drafts = new Map<string, SendDraft & { placed: boolean }>();

    function idFor(ref: ChatRef, text: string): string {
        const key = keyOf(ref);
        const pending = drafts.get(key);
        const userMessageId = pending?.input === text ? pending.userMessageId : v4();
        // The active send owns the text until it settles; switching chats must not restore it early.
        drafts.set(key, { input: text, userMessageId, placed: true });
        return userMessageId;
    }

    function settle(ref: ChatRef, draft: SendDraft, outcome: SendDraftOutcome): "drop" | "restore" | "keep" {
        const key = keyOf(ref);
        if (outcome.landed || outcome.ok) {
            drafts.delete(key);
            return "drop";
        }
        // Refusals and accepted jobs that fail recover alike. Keep the id even if the mirror is behind.
        const placed = outcome.selected && outcome.composerEmpty;
        drafts.set(key, { ...draft, placed });
        return placed ? "restore" : "keep";
    }

    function takeUnplaced(ref: ChatRef): SendDraft | undefined {
        const draft = drafts.get(keyOf(ref));
        if (!draft || draft.placed) {
            return undefined;
        }
        draft.placed = true;
        return { input: draft.input, userMessageId: draft.userMessageId };
    }

    return { idFor, settle, takeUnplaced };
}
