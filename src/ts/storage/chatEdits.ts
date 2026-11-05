import type { Chat } from "../../../shared/database.ts";
import { language } from "src/lang";
import {
    applyChatResult,
    captureChatBaseline,
    chatOwnerToken,
    type ChatRef,
    currentChatRef,
    ensureChatLoaded,
    findChat,
    orderChats,
    pinChat,
    setChatMeta,
} from "./chatStore.svelte";
import { readWithDeadline } from "./readDeadline";
import { readRefs } from "./resourceClient";
import { flushResources } from "./resourceSync.svelte";

/**
 * Helpers over the chat module for writers that work on a whole chat: they edit a detached copy,
 * and only what the edit changed is applied to the chat as it is afterwards (`applyChatResult`), so
 * changes made meanwhile by others (a stream, another handler, another tab) are kept. Also the
 * detached bulk read for exports (`readChatsDetached`).
 */

/**
 * Runs `edit` on a copy of a chat (it may await) and applies its changes. Does nothing when the chat
 * is gone. The chat is pinned (kept loaded) from its load until the changes are applied.
 */
export async function editChat(ref: ChatRef, edit: (chat: Chat) => void | Promise<void>): Promise<void> {
    const owner = chatOwnerToken(ref.chaId);
    const release = pinChat(ref);
    try {
        // A chat deleted meanwhile, or whose character's chats were replaced (even under the same
        // ids), is left alone.
        if (!(await ensureChatLoaded(ref)) || chatOwnerToken(ref.chaId) !== owner || !findChat(ref)) {
            return;
        }
        const baseline = captureChatBaseline(ref);
        const draft = structuredClone(baseline.chat);
        await edit(draft);
        applyChatResult(baseline, draft);
    } finally {
        release();
    }
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

/**
 * Sets fields of the selected chat (nothing when there is none). While it loads only its list fields
 * can be set (`setChatMeta`).
 */
export function setCurrentChatMeta(set: Partial<Chat>, unset: readonly string[] = []) {
    const ref = currentChatRef();
    if (ref) {
        setChatMeta(ref, set, unset);
    }
}

/** The most characters or chat refs one detached read names (below the read route's cap). */
const DETACHED_READ_CHUNK = 500;
/** The bound of one chunk's read (`readWithDeadline`): whole chat lists can be large on a slow link. */
const DETACHED_READ_DEADLINE_MS = 60_000;

export type DetachedChatRead = { revision: string; data: Chat } | "gone" | "absent";

/**
 * Reads named chats across characters as plain server copies, without installing or pinning them.
 * The caller settles queued saves first. Each chunk has its own deadline, including continuations;
 * a missing answer is distinct from a chat the server says is gone. No store state is written.
 */
export async function readChatRefsDetached(
    refs: readonly ChatRef[],
): Promise<Map<string, Map<string, DetachedChatRead>>> {
    const result = new Map<string, Map<string, DetachedChatRead>>();
    const wanted: { characterId: string; id: string }[] = [];
    for (const { chaId, chatId } of refs) {
        let chats = result.get(chaId);
        if (!chats) {
            chats = new Map();
            result.set(chaId, chats);
        }
        if (!chats.has(chatId)) {
            chats.set(chatId, "absent");
            wanted.push({ characterId: chaId, id: chatId });
        }
    }
    for (let start = 0; start < wanted.length; start += DETACHED_READ_CHUNK) {
        const read = await readWithDeadline(DETACHED_READ_DEADLINE_MS, language.chatLoadTimedOut, (signal) =>
            readRefs([], { chats: wanted.slice(start, start + DETACHED_READ_CHUNK), signal }),
        );
        for (const chat of read.chats ?? []) {
            const chats = result.get(chat.characterId);
            if (chats?.has(chat.id)) {
                chats.set(
                    chat.id,
                    chat.revision === null || !chat.data ? "gone" : { revision: chat.revision, data: chat.data },
                );
            }
        }
    }
    return result;
}

/**
 * Every chat of the characters `chaIds`, as plain copies in their server order, read from the server
 * after saving what is queued (for exports; complete whatever this tab has
 * loaded). The save comes first, so the copies hold this tab's changes: when it fails, or a conflict
 * discarded a local change of one of these characters or their chats, or such a change remains refused,
 * nothing is read and this throws (a stale server copy is never returned instead). A character the
 * server has no chat order for gets `[]`.
 */
export async function readChatsDetached(chaIds: readonly string[]): Promise<Map<string, Chat[]>> {
    const wanted = [...new Set(chaIds)];
    const result = new Map<string, Chat[]>();
    if (wanted.length === 0) {
        return result;
    }
    const { discarded, refused } = await flushResources();
    // A key of a wanted character: its record, its chat order, or one of its chats.
    const concerns = (key: string) =>
        wanted.some(
            (chaId) => key === `characters/${chaId}` || key === `chats/${chaId}` || key.startsWith(`chats/${chaId}/`),
        );
    const touched = discarded.filter(concerns);
    if (touched.length > 0) {
        throw new Error(`A conflict discarded local changes before the read: ${touched.join(", ")}`);
    }
    // A change an earlier save left refused is held only in this tab: the server copy is behind it.
    const refusedKeys = refused.filter(concerns);
    if (refusedKeys.length > 0) {
        throw new Error(`The server refused local changes that are not saved yet: ${refusedKeys.join(", ")}`);
    }
    for (let start = 0; start < wanted.length; start += DETACHED_READ_CHUNK) {
        const read = await readWithDeadline(DETACHED_READ_DEADLINE_MS, "The export's chat read timed out", (signal) =>
            readRefs([], { chatCollections: wanted.slice(start, start + DETACHED_READ_CHUNK), signal }),
        );
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
