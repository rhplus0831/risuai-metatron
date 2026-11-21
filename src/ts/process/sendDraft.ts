import { v4 } from "uuid";
import { heldMessageById, type ChatRef } from "../storage/chatStore.svelte";
import type { ComposerDraft } from "./composerDrafts.svelte";

/**
 * Serializes the sent box and ordered attachments, and retains send identities per chat. Draft sends
 * retain the whole raw composer for recovery; ordinary sends retain only their serialized input.
 * `createSendDrafts` keeps message ids for unchanged retries and request ids only while admission
 * remains uncertain. A landed or successful send drops its draft; other ends restore it only into
 * the selected empty composer, otherwise retaining it for later. Browser journaling is handled
 * by `src/ts/process/composerDrafts.svelte.ts`, not by this in-memory registry.
 */

/**
 * A send's input and ids; `requestUncertain`: the request id is reused from an attempt that may have
 * reached the server.
 */
export type SendDraft = {
    input: string;
    /** The raw main text for this draft send's translation, read anew at each press and never retained for retry. */
    inputOriginal?: string;
    userMessageId: string;
    requestId?: string;
    requestUncertain?: boolean;
    composer?: ComposerDraft;
};
export type ComposerRetry = Pick<SendDraft, "userMessageId" | "requestId"> & { sent?: "draft" };
/** How a send ended, for `settle`: `selected` and `composerEmpty` decide whether its text goes back at once. */
export type SendDraftOutcome = {
    landed: boolean;
    ok: boolean;
    selected: boolean;
    composerEmpty: boolean;
    requestUncertain?: boolean;
};

const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;

export function sameComposerSnapshot(
    a: Omit<ComposerDraft, "draft"> & { draft?: string },
    b: Omit<ComposerDraft, "draft"> & { draft?: string },
): boolean {
    return (
        a.input === b.input &&
        (a.draft ?? "") === (b.draft ?? "") &&
        a.translate === b.translate &&
        a.files.length === b.files.length &&
        a.files.every((file, index) => file === b.files[index])
    );
}

/**
 * The text submitted by the composer, including its queued attachments in order (`{{inlayed::id}}`).
 * The one serialization of a composer into send text: the screen's send, the journal's retry lookup,
 * and a restored draft's text all use it, so the same composer always maps to the same send.
 */
export function composerSendText(
    composer: { input: string; draft?: string; files: readonly string[] },
    sent?: "draft",
): string {
    return (
        (sent === "draft" ? (composer.draft ?? "") : composer.input) +
        composer.files.map((file) => `{{inlayed::${file}}}`).join("")
    );
}

/**
 * Retains failed sends' text and ids, including when an absent message may just be waiting for hydration.
 * `idsFor` captures a send's ids before its dispatch: the same text keeps its `userMessageId`, and an
 * ordinary Send (`reuseRequest`) also reuses a retained request id, marked `requestUncertain`; else a
 * fresh one. `settle` keeps the request id only after an uncertain end, and keeps the text and message
 * id for any end that neither landed nor succeeded.
 */
export function createSendDrafts() {
    const drafts = new Map<string, SendDraft & { placement: "sending" | "placed" | "unplaced" | "restoredSharedId" }>();

    function matches(ref: ChatRef, text: string, composer?: ComposerDraft) {
        const pending = drafts.get(keyOf(ref));
        if (!pending || pending.input !== text) return;
        // Until a draft has been offered back, equal outgoing text can belong to two different originals.
        const original = pending.composer;
        if (original && pending.placement !== "placed" && (!composer || !sameComposerSnapshot(original, composer)))
            return;
        return pending;
    }

    function retryIdFor(ref: ChatRef, composer: ComposerDraft): ComposerRetry | undefined {
        const sent = drafts.get(keyOf(ref))?.composer ? "draft" : undefined;
        const draft = matches(ref, composerSendText(composer, sent), composer);
        return draft
            ? {
                  userMessageId: draft.userMessageId,
                  ...(draft.requestId === undefined ? {} : { requestId: draft.requestId }),
                  ...(sent ? { sent } : {}),
              }
            : undefined;
    }

    function adopt(ref: ChatRef, draft: SendDraft, sharedId = false): void {
        const { inputOriginal, ...retained } = draft;
        drafts.set(keyOf(ref), { ...retained, placement: sharedId ? "restoredSharedId" : "placed" });
    }

    function clearRetry(ref: ChatRef): void {
        drafts.delete(keyOf(ref));
    }

    function idFor(ref: ChatRef, text: string, composer?: ComposerDraft): string {
        const key = keyOf(ref);
        let retry = matches(ref, text, composer);
        // Keep a legacy shared id on the editable row, but send under it only to deduplicate a confirmed message.
        if (retry?.placement === "restoredSharedId" && heldMessageById(ref, retry.userMessageId)?.role !== "user")
            retry = undefined;
        const userMessageId = retry?.userMessageId ?? v4();
        // The active send owns the text until it settles; switching chats must not restore it early.
        drafts.set(key, { input: text, userMessageId, ...(composer ? { composer } : {}), placement: "sending" });
        return userMessageId;
    }

    function idsFor(
        ref: ChatRef,
        text: string,
        reuseRequest = true,
        composer?: ComposerDraft,
    ): Pick<SendDraft, "userMessageId" | "requestId" | "requestUncertain"> {
        const previous = drafts.get(keyOf(ref));
        const userMessageId = idFor(ref, text, composer);
        const requestId = reuseRequest && previous?.userMessageId === userMessageId ? previous.requestId : undefined;
        return { userMessageId, requestId: requestId ?? v4(), requestUncertain: requestId !== undefined };
    }

    function settle(ref: ChatRef, draft: SendDraft, outcome: SendDraftOutcome): "drop" | "restore" | "keep" {
        const key = keyOf(ref);
        if (outcome.landed || outcome.ok) {
            drafts.delete(key);
            return "drop";
        }
        // Refusals and accepted jobs that fail recover alike. Keep the id even if the mirror is behind.
        const placed = outcome.selected && outcome.composerEmpty;
        const { requestId, requestUncertain, inputOriginal, ...message } = draft;
        drafts.set(key, {
            ...message,
            ...(outcome.requestUncertain && requestId ? { requestId } : {}),
            placement: placed ? "placed" : "unplaced",
        });
        return placed ? "restore" : "keep";
    }

    function takeUnplaced(ref: ChatRef, canPlace?: (send: SendDraft) => boolean): SendDraft | undefined {
        const draft = drafts.get(keyOf(ref));
        if (draft?.placement !== "unplaced" || !(canPlace ? canPlace(draft) : !draft.composer)) {
            return undefined;
        }
        draft.placement = "placed";
        const { placement, ...send } = draft;
        return send;
    }

    return { idFor, idsFor, settle, takeUnplaced, retryIdFor, adopt, clearRetry };
}
