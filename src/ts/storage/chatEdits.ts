import type { Chat } from "../../../shared/database.ts";
import {
    applyChatResult,
    captureChatBaseline,
    type ChatRef,
    currentChatRef,
    ensureChatLoaded,
    findChat,
    orderChats,
    setChatMeta,
} from "./chatStore.svelte";
import { readRefs } from "./resourceClient";
import { flushResources } from "./resourceSync.svelte";

/**
 * Helpers over the chat module for writers that work on a whole chat: they edit a detached copy,
 * and only what the edit changed is applied to the chat as it is afterwards (`applyChatResult`), so
 * changes made meanwhile by others (a stream, another handler, another tab) are kept. Also the
 * detached bulk read for exports (`readChatsDetached`).
 */

/** Runs `edit` on a copy of a chat (it may await) and applies its changes. Does nothing when the chat is gone. */
export async function editChat(ref: ChatRef, edit: (chat: Chat) => void | Promise<void>): Promise<void> {
    await ensureChatLoaded(ref);
    // Found again after the load: a chat deleted meanwhile is left alone.
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

/** The most characters one detached read names (the read route's cap is far above it). */
const DETACHED_READ_CHUNK = 500;

/**
 * Every chat of the characters `chaIds`, as plain copies in their server order, read from the server
 * after saving what is queued (Phase 6 slice 9a: for exports; complete whatever this tab has
 * loaded). The save comes first, so the copies hold this tab's changes: when it fails, or a conflict
 * discarded a local change of one of these characters or their chats, nothing is read and this
 * throws (a stale server copy is never returned instead). A character the server has no chat order
 * for gets `[]`.
 */
export async function readChatsDetached(chaIds: readonly string[]): Promise<Map<string, Chat[]>> {
    const wanted = [...new Set(chaIds)];
    const result = new Map<string, Chat[]>();
    if (wanted.length === 0) {
        return result;
    }
    const { discarded } = await flushResources();
    const touched = discarded.filter((key) =>
        wanted.some(
            (chaId) => key === `characters/${chaId}` || key === `chats/${chaId}` || key.startsWith(`chats/${chaId}/`),
        ),
    );
    if (touched.length > 0) {
        throw new Error(`A conflict discarded local changes before the read: ${touched.join(", ")}`);
    }
    for (let start = 0; start < wanted.length; start += DETACHED_READ_CHUNK) {
        const read = await readRefs([], { chatCollections: wanted.slice(start, start + DETACHED_READ_CHUNK) });
        for (const collection of read.chatCollections ?? []) {
            result.set(
                collection.characterId,
                orderChats(collection.characterId, collection.chats, collection.order?.ids ?? []),
            );
        }
    }
    for (const chaId of wanted) {
        if (!result.has(chaId)) {
            result.set(chaId, []);
        }
    }
    return result;
}
