import { derived, get, writable, type Readable } from "svelte/store";
import type { ChatRef } from "../storage/chatStore.svelte";

/**
 * The sends this tab runs (`sendChat`), one entry per chat: chat key (`${chaId}\u0000${chatId}`,
 * the format of `chatStatusKey`) → that chat. A send without a chat (nothing selected) holds the
 * tab entry, key `""` → null: it counts for `anyLocalSend` and fences no chat. Each update replaces
 * the Map.
 *
 * A module of its own (no runes, type-only imports) so its readers are not reached by the
 * hand-written mocks of `index.svelte`.
 */
const sends = writable<ReadonlyMap<string, ChatRef | null>>(new Map());

const TAB_SEND_KEY = "";

function localSendKey(ref: ChatRef): string {
    return `${ref.chaId}\u0000${ref.chatId}`;
}

export const localSends: Readable<ReadonlyMap<string, ChatRef | null>> = { subscribe: sends.subscribe };

/**
 * Whether this tab runs any send. Derived, so a subscriber of `localSends` may read it one update
 * late; a synchronous admission check reads `localSends` itself.
 */
export const anyLocalSend: Readable<boolean> = derived(sends, (current) => current.size > 0);

/**
 * Takes `ref`'s entry (null: the tab entry) and returns its release, which removes it once (later
 * calls do nothing); null when that entry is already held. A held entry refuses a second take, so a
 * release never removes a newer send's entry.
 */
export function beginLocalSend(ref: ChatRef | null): (() => void) | null {
    const key = ref ? localSendKey(ref) : TAB_SEND_KEY;
    if (get(sends).has(key)) {
        return null;
    }
    const entry = ref ? { chaId: ref.chaId, chatId: ref.chatId } : null;
    let held = true;
    const release = () => {
        if (!held) {
            return;
        }
        held = false;
        sends.update((current) => {
            if (current.get(key) !== entry) {
                return current;
            }
            const next = new Map(current);
            next.delete(key);
            return next;
        });
    };
    try {
        sends.update((current) => new Map(current).set(key, entry));
    } catch (error) {
        // A throwing subscriber: the entry is in the store; leave nothing held.
        release();
        throw error;
    }
    return release;
}

/**
 * Whether this tab runs a send in `ref`'s chat. Pass the Map a reactive reader holds (`$localSends`,
 * a `fromStore(localSends)` view's `.current`) to track it; without it, the current registry is read
 * once.
 */
export function isLocalSend(ref: ChatRef, current: ReadonlyMap<string, ChatRef | null> = get(sends)): boolean {
    return current.has(localSendKey(ref));
}
