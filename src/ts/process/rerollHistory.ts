import type { DeepReadonly } from "../../../shared/readonly.ts";
import type { Message } from "../storage/database.svelte";
import { editChatSync } from "../storage/chatEdits";
import { type ChatRef, findChat } from "../storage/chatStore.svelte";

type Slot = { anchor: string | null; bundles: Message[][]; cursor: number };

const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;
const sameIds = (left: DeepReadonly<Message[]>, right: DeepReadonly<Message[]>) =>
    left.length === right.length && left.every((message, index) => message.chatId === right[index].chatId);

/** A screen's swipe history, bounded by chat and valid only while its current bundle is still the tail. */
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

    return { record, begin, canForward, forward, back, clear };
}
