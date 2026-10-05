import { untrack } from "svelte";
import { currentChatRef, selectedChat, setChatMeta } from "./chatStore.svelte";
import type { loreBook } from "./database.svelte";

/**
 * The selected chat's local lorebook as an editable copy. The lorebook editors bind to and mutate
 * `localLoreDraft.value` (nested fields included); every change is saved to the chat through the
 * chat module, and a change of the chat's own copy (another writer, a chat switch) replaces it.
 */
export const localLoreDraft = $state({ value: [] as loreBook[], key: "" });

let synced = "";
let started = false;

/** Starts keeping `localLoreDraft` in step with the selected chat (once; call before using it). */
export function useLocalLoreDraft(): typeof localLoreDraft {
    if (started) {
        return localLoreDraft;
    }
    started = true;
    $effect.root(() => {
        $effect.pre(() => {
            const ref = currentChatRef();
            const chat = selectedChat();
            const key = ref && chat ? `${ref.chaId}\u0000${ref.chatId}` : "";
            const text = JSON.stringify($state.snapshot(chat?.localLore ?? []));
            untrack(() => {
                if (key !== localLoreDraft.key || text !== synced) {
                    localLoreDraft.key = key;
                    synced = text;
                    localLoreDraft.value = JSON.parse(text);
                }
            });
        });
        $effect(() => {
            const text = JSON.stringify($state.snapshot(localLoreDraft.value));
            untrack(() => {
                const ref = currentChatRef();
                if (text === synced || !ref || `${ref.chaId}\u0000${ref.chatId}` !== localLoreDraft.key) {
                    return;
                }
                synced = text;
                setChatMeta(ref, { localLore: JSON.parse(text) });
            });
        });
    });
    return localLoreDraft;
}
