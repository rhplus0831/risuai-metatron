import { untrack } from "svelte";
import { textHash } from "../../../shared/textHash.ts";
import { chatEntry, chatOwnerToken, findChat, heldMessageById, onChatRemoved, type ChatRef } from "./chatStore.svelte";
import type { StoredTranslationEdit } from "../translator/storedTranslation.svelte";

type EditorKind = "message" | `message:${string}` | "translation" | `cache:${string}` | `partial:${number}`;
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
    saving?: boolean;
}

interface DraftEntry {
    ref: ChatRef;
    messageId: string | undefined;
    kind: EditorKind;
    owner: string;
    draft: MessageEditorDraft;
    reply?: string | null;
    selection?: PartialSelection;
    retention?: { holders: number; lastWrite: number };
    dispose: () => void;
}
const drafts = new Map<string, DraftEntry>();
const keyOf = (ref: ChatRef, messageId: string | undefined, kind: EditorKind) =>
    JSON.stringify([ref.chaId, ref.chatId, messageId, kind]);
const replyKey = (candidate: string | undefined, generation: string | undefined) =>
    candidate || generation ? JSON.stringify([candidate, generation]) : null;
const messageKind = (reply: string | null): EditorKind => (reply === null ? "message" : `message:${reply}`);

/** Candidate switches and in-place generations can replace the reply while preserving its message id. */
export function messageEditorReplyKey(ref: ChatRef | null, messageId: string | undefined) {
    const message = ref && messageId ? heldMessageById(ref, messageId) : undefined;
    const candidate = message?.candidates?.[message.selected ?? 0]?.id;
    const generation = message?.generationInfo?.generationId;
    return replyKey(candidate, generation);
}

function resolveEditorKind(ref: ChatRef, messageId: string | undefined, kind: EditorKind): EditorKind {
    if (kind !== "message" || !messageId) return kind;
    const message = heldMessageById(ref, messageId);
    if (message?.role !== "char") return kind;
    const first = message.candidates?.[0];
    if (first) {
        // When a standalone reply gains slots, the job stores that original as the first slot.
        const generation = first.generationInfo?.generationId;
        const oldKey = keyOf(ref, messageId, messageKind(replyKey(undefined, generation)));
        const firstKind = messageKind(replyKey(first.id, generation));
        const firstKey = keyOf(ref, messageId, firstKind);
        const original = drafts.get(oldKey);
        if (original && original.owner === chatOwnerToken(ref.chaId) && !drafts.has(firstKey)) {
            drafts.delete(oldKey);
            original.kind = firstKind;
            drafts.set(firstKey, original);
        }
    }
    return messageKind(messageEditorReplyKey(ref, messageId));
}

function dropDraft(entry: DraftEntry) {
    entry.draft.open = false;
    entry.dispose();
    drafts.delete(keyOf(entry.ref, entry.messageId, entry.kind));
}

function findDraftEntry(ref: ChatRef, messageId: string | undefined, kind: EditorKind) {
    const entry = drafts.get(keyOf(ref, messageId, kind));
    if (entry && entry.owner !== chatOwnerToken(ref.chaId)) {
        dropDraft(entry);
        return undefined;
    }
    return entry;
}

/** Row drafts and their open state live for this tab, including while Settings has destroyed the chat screen. */
export function findMessageEditorDraft(ref: ChatRef, messageId: string | undefined, kind: EditorKind) {
    return findDraftEntry(ref, messageId, resolveEditorKind(ref, messageId, kind))?.draft;
}

export function openMessageEditorDraft(
    ref: ChatRef,
    messageId: string | undefined,
    kind: EditorKind,
    initial: Omit<MessageEditorDraft, "open">,
): MessageEditorDraft {
    kind = resolveEditorKind(ref, messageId, kind);
    const key = keyOf(ref, messageId, kind);
    const existing = findDraftEntry(ref, messageId, kind)?.draft;
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
                untrack(() => dropDraft(entry));
            }
        });
    });
    const entry: DraftEntry = { ref: { ...ref }, messageId, kind, owner, draft, dispose };
    drafts.set(key, entry);
    return draft;
}

export function closeMessageEditorDraft(
    ref: ChatRef,
    messageId: string | undefined,
    kind: EditorKind,
    expected?: MessageEditorDraft,
) {
    const key = keyOf(ref, messageId, resolveEditorKind(ref, messageId, kind));
    const entry = drafts.get(key);
    if (!entry || (expected && entry.draft !== expected)) return;
    dropDraft(entry);
}

let partialSequence = 0;
let writeSequence = 0;
const MAX_INACTIVE_DRAFTS = 8;

function retainedDrafts(ref: ChatRef, messageId: string | undefined) {
    const owner = chatOwnerToken(ref.chaId);
    const entries: DraftEntry[] = [];
    for (const entry of drafts.values()) {
        if (
            entry.retention &&
            entry.owner === owner &&
            entry.messageId === messageId &&
            entry.ref.chaId === ref.chaId &&
            entry.ref.chatId === ref.chatId
        )
            entries.push(entry);
    }
    return entries;
}

/** A slot can appear or disappear for a generation. Distinct explicit slots make that move ambiguous. */
function alternateReplyKey(entries: DraftEntry[], reply: string | null): string | undefined {
    if (!reply) return;
    const [candidate, generation]: [string | null, string | null] = JSON.parse(reply);
    if (!generation) return;
    let explicitReply = candidate === null ? undefined : reply;
    for (const entry of entries) {
        if (!entry.reply || entry.reply === explicitReply) continue;
        const [otherCandidate, otherGeneration]: [string | null, string | null] = JSON.parse(entry.reply);
        if (otherCandidate === null || otherGeneration !== generation) continue;
        if (explicitReply !== undefined) return;
        explicitReply = entry.reply;
    }
    return candidate === null ? explicitReply : JSON.stringify([null, generation]);
}

function trimInactiveDrafts(ref: ChatRef, messageId: string | undefined) {
    const inactive = retainedDrafts(ref, messageId).filter((entry) => entry.retention!.holders === 0);
    if (inactive.length <= MAX_INACTIVE_DRAFTS) return;
    inactive.sort((a, b) => a.retention!.lastWrite - b.retention!.lastWrite);
    for (const entry of inactive.slice(0, inactive.length - MAX_INACTIVE_DRAFTS)) {
        closeMessageEditorDraft(ref, messageId, entry.kind, entry.draft);
    }
}

function holdEditorDraft(
    ref: ChatRef,
    messageId: string | undefined,
    kind: EditorKind,
    initial: Pick<MessageEditorDraft, "base" | "text">,
    reply: string | null,
    selection?: PartialSelection,
) {
    const draft = openMessageEditorDraft(ref, messageId, kind, initial);
    const entry = drafts.get(keyOf(ref, messageId, kind))!;
    const retention = (entry.retention ??= { holders: 0, lastWrite: ++writeSequence });
    retention.holders++;
    entry.reply = reply;
    // An untouched reopen keeps matching against the source where the user last typed.
    if (entry.selection) draft.base = entry.selection.text;
    entry.selection ??= selection;
    let held = true;
    return {
        draft,
        setText(value: string) {
            if (draft.text === value) return;
            draft.text = value;
            retention.lastWrite = ++writeSequence;
            entry.selection = selection;
        },
        release() {
            if (!held) return;
            held = false;
            if (--retention.holders === 0 && draft.open) trimInactiveDrafts(ref, messageId);
        },
        close: () => closeMessageEditorDraft(ref, messageId, entry.kind, draft),
    };
}

const cacheKind = (key: string, reply: string | null): EditorKind =>
    `cache:${reply === null ? key : JSON.stringify([key, reply])}`;

export function openCachedTranslationDraft(
    ref: ChatRef,
    messageId: string | undefined,
    key: string,
    reply: string | null,
    cached: string | null,
) {
    const kind = cacheKind(key, reply);
    if (reply && !findMessageEditorDraft(ref, messageId, kind)) {
        const entries = retainedDrafts(ref, messageId);
        const alternate = alternateReplyKey(entries, reply);
        if (alternate !== undefined) {
            const oldKind = cacheKind(key, alternate);
            const entry = entries.find((entry) => entry.kind === oldKind);
            if (entry) {
                drafts.delete(keyOf(ref, messageId, oldKind));
                entry.kind = kind;
                drafts.set(keyOf(ref, messageId, kind), entry);
            }
        }
    }
    return holdEditorDraft(ref, messageId, kind, { text: cached ?? "", base: JSON.stringify(cached) }, reply);
}

function partialDraftKind(entries: DraftEntry[], reply: string | null, selection: PartialSelection) {
    let match: EditorKind | null | undefined;
    for (const entry of entries) {
        const old = entry.selection;
        if (!old || entry.reply !== reply || old.target !== selection.target) continue;
        // Both sides identify the same range even if another writer replaced the paragraph itself.
        if (old.before === selection.before && old.after === selection.after) {
            match = entry.kind;
            break;
        }
        if (old.text === selection.text && old.unique && selection.unique) {
            // The range moved. If several drafts fit the new location, keep them until one can be identified.
            match = match === undefined ? entry.kind : null;
        }
    }
    return match;
}

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
    const reply = messageEditorReplyKey(ref, messageId);
    const entries = retainedDrafts(ref, messageId);
    let match = partialDraftKind(entries, reply, selection);
    if (match === undefined) {
        const alternate = alternateReplyKey(entries, reply);
        if (alternate !== undefined) match = partialDraftKind(entries, alternate, selection);
    }
    const kind = match ?? (`partial:${++partialSequence}` as const);
    return holdEditorDraft(ref, messageId, kind, { base: text, text }, reply, selection);
}

onChatRemoved((removal) => {
    for (const entry of drafts.values()) {
        if (entry.ref.chaId === removal.chaId && (removal.chatId === null || entry.ref.chatId === removal.chatId)) {
            dropDraft(entry);
        }
    }
});
