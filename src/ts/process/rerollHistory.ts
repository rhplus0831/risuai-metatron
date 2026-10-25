import type { DeepReadonly } from "../../../shared/readonly.ts";
import type { Message } from "../storage/database.svelte";
import { editChatSync } from "../storage/chatEdits";
import {
    type ChatRef,
    chatHydrationHold,
    chatOwnerToken,
    findChat,
    isChatBehind,
    pinChat,
    restoreUnsentRemoval,
} from "../storage/chatStore.svelte";
import { flushResources, refreshStaleChat } from "../storage/resourceSync.svelte";
import { isChatBusy } from "./chatStatus.svelte";

type Slot = { anchor: string | null; bundles: Message[][]; cursor: number };

const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;
const sameIds = (left: DeepReadonly<Message[]>, right: DeepReadonly<Message[]>) =>
    left.length === right.length && left.every((message, index) => message.chatId === right[index].chatId);

/**
 * A screen's swipe history, bounded by chat and valid only while its current bundle is still the tail.
 * The bundle at the cursor is refreshed from the chat before the slot is kept or the tail swapped, so an
 * edit of a reply (or a prereroll swap) made since it was recorded is what a later back or forward brings.
 */
export function createRerollHistory() {
    const slots = new Map<string, Slot>();

    function store(key: string, slot: Slot) {
        slots.delete(key);
        slots.set(key, slot);
        if (slots.size > 16) {
            slots.delete(slots.keys().next().value!);
        }
    }

    function get(ref: ChatRef) {
        const key = keyOf(ref);
        const slot = slots.get(key);
        if (slot) {
            store(key, slot);
        }
        return slot;
    }

    function clear(ref: ChatRef): void {
        slots.delete(keyOf(ref));
    }

    function record(ref: ChatRef, anchor: string | null, bundle: DeepReadonly<Message[]>): void {
        const slot = get(ref);
        const owned = safeStructuredClone(bundle) as Message[];
        if (!slot || slot.anchor !== anchor) {
            store(keyOf(ref), { anchor, bundles: [owned], cursor: 0 });
            return;
        }
        slot.bundles.push(owned);
        slot.cursor = slot.bundles.length - 1;
    }

    function begin(ref: ChatRef, anchor: string | null, removed: DeepReadonly<Message[]>): void {
        const slot = get(ref);
        if (slot?.anchor === anchor && sameIds(slot.bundles[slot.cursor], removed)) {
            slot.bundles[slot.cursor] = safeStructuredClone(removed) as Message[];
            return;
        }
        store(keyOf(ref), { anchor, bundles: [safeStructuredClone(removed) as Message[]], cursor: 0 });
    }

    function canForward(ref: ChatRef): boolean {
        const slot = get(ref);
        return !!slot && slot.cursor < slot.bundles.length - 1;
    }

    function move(ref: ChatRef, offset: number): boolean {
        const slot = get(ref);
        if (!slot) {
            return false;
        }
        const cursor = slot.cursor + offset;
        if (cursor < 0 || cursor >= slot.bundles.length) {
            return false;
        }
        if (!findChat(ref)) {
            clear(ref);
            return false;
        }
        let applied = false;
        editChatSync(ref, (chat) => {
            const anchorIndex =
                slot.anchor === null ? -1 : chat.message.findIndex((message) => message.chatId === slot.anchor);
            if (
                (slot.anchor !== null && anchorIndex === -1) ||
                !sameIds(chat.message.slice(anchorIndex + 1), slot.bundles[slot.cursor])
            ) {
                clear(ref);
                return;
            }
            slot.bundles[slot.cursor] = safeStructuredClone(chat.message.slice(anchorIndex + 1));
            chat.message = [...chat.message.slice(0, anchorIndex + 1), ...safeStructuredClone(slot.bundles[cursor])];
            applied = true;
        });
        if (applied) {
            slot.cursor = cursor;
        }
        return applied;
    }

    function forward(ref: ChatRef): boolean {
        return move(ref, 1);
    }

    function back(ref: ChatRef): boolean {
        return move(ref, -1);
    }

    /**
     * `restoreRerolledReplies` for this history: a reply that only the chat's read brings (its job's end
     * had not applied) is recorded, so Undo Reroll reaches the removed replies.
     */
    function restore(
        ref: ChatRef,
        owner: string,
        anchor: string | null,
        removed: DeepReadonly<Message[]>,
        end: RerollSendEnd,
        syncChat?: (ref: ChatRef) => Promise<boolean>,
    ) {
        return restoreRerolledReplies(ref, owner, anchor, removed, end, {
            syncChat,
            onReply: (bundle) => record(ref, anchor, bundle),
        });
    }

    return { record, begin, canForward, forward, back, clear, restore };
}

/** How a reroll's send ended (`sendChatMain`'s result), for `restoreRerolledReplies`. */
export type RerollSendEnd = { ran: boolean; settled: boolean; blockedChats: readonly ChatRef[] };

type RestoreOptions = {
    syncChat?: (ref: ChatRef) => Promise<boolean>;
    onReply?: (bundle: DeepReadonly<Message[]>) => void;
};

/** Saves what is queued and reads the chat again when it is known to be behind; true when it is current. */
async function syncRerolledChat(ref: ChatRef): Promise<boolean> {
    await flushResources();
    return await refreshStaleChat(ref);
}

/**
 * Puts back the replies a reroll removed after `anchor` when its send brought none, so they are not
 * lost. A send that did not run first withdraws the removal while it is still unsent
 * (`restoreUnsentRemoval`). Otherwise, once nothing of the send writes to the chat any more (`settled`),
 * they are written back after the anchor while the character is the one the reroll removed them from
 * (`owner`), the chat still ends at the anchor and holds none of them, and the chat is free. Before
 * deciding, a chat whose mirror may lack the job's end (marked behind, or local work that kept the
 * job's chat copy from applying) is saved and read again (`syncChat`), the chat pinned meanwhile; a reply
 * that read brings goes to `onReply`.
 * `"unsafe"`: they stay removed because that could not be told (the chat stayed behind or its work
 * unsaved), or another send or generation writes into the chat (`isChatBusy`, a create refused as
 * busy, or a save the server refused for this chat's generation), so they would land beside its reply.
 */
export async function restoreRerolledReplies(
    ref: ChatRef,
    owner: string,
    anchor: string | null,
    removed: DeepReadonly<Message[]>,
    end: RerollSendEnd,
    options: RestoreOptions = {},
): Promise<"restored" | "unsafe" | "none"> {
    if (!end.ran && restoreUnsentRemoval(ref, owner, anchor, removed)) {
        return "restored";
    }
    if (!end.settled || removed.length === 0) {
        return "none";
    }
    // Kept loaded through the save and read below.
    const release = pinChat(ref);
    try {
        return await restorePinned(ref, owner, anchor, removed, end, options);
    } finally {
        release();
    }
}

async function restorePinned(
    ref: ChatRef,
    owner: string,
    anchor: string | null,
    removed: DeepReadonly<Message[]>,
    end: RerollSendEnd,
    { syncChat = syncRerolledChat, onReply }: RestoreOptions,
): Promise<"restored" | "unsafe" | "none"> {
    const ids = new Set(removed.map((message) => message.chatId));
    /** The chat's anchor index while it ends at the anchor and holds none of the removed replies, else null. */
    const anchorEnd = () => {
        const chat = chatOwnerToken(ref.chaId) === owner ? findChat(ref) : undefined;
        if (!chat) {
            return null;
        }
        const index = anchor === null ? -1 : chat.message.findIndex((message) => message.chatId === anchor);
        if (
            (anchor !== null && index === -1) ||
            index !== chat.message.length - 1 ||
            chat.message.some((message) => ids.has(message.chatId))
        ) {
            return null;
        }
        return index;
    };
    const current = () => !isChatBehind(ref) && chatHydrationHold(ref) === "none";
    if (anchorEnd() === null) {
        return "none";
    }
    if (!current()) {
        try {
            await syncChat(ref);
        } catch (error) {
            console.error("[Reroll]", error);
        }
        if (anchorEnd() === null) {
            // The read brought what the job left after the anchor: recorded as its reply unless it holds the
            // removed replies or a user turn (another send's, not this reroll's).
            const chat = chatOwnerToken(ref.chaId) === owner ? findChat(ref) : undefined;
            const index =
                anchor === null ? -1 : (chat?.message.findIndex((message) => message.chatId === anchor) ?? -1);
            const tail = chat && (anchor === null || index !== -1) ? chat.message.slice(index + 1) : [];
            if (tail.length > 0 && !tail.some((message) => ids.has(message.chatId) || message.role === "user")) {
                onReply?.(tail);
            }
            return "none";
        }
        if (!current()) {
            return "unsafe";
        }
    }
    if (
        isChatBusy(ref) ||
        end.blockedChats.some((blocked) => blocked.chaId === ref.chaId && blocked.chatId === ref.chatId)
    ) {
        return "unsafe";
    }
    const anchorIndex = anchorEnd()!;
    let applied = false;
    editChatSync(ref, (draft) => {
        if (draft.message.length === anchorIndex + 1) {
            draft.message.push(...(safeStructuredClone(removed) as Message[]));
            applied = true;
        }
    });
    return applied ? "restored" : "none";
}
