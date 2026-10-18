import { untrack } from "svelte";
import { fromStore } from "svelte/store";
import { language } from "src/lang";
import { alertError } from "../alert";
import { chatStatusKey, generatingChatKeys } from "../process/chatStatus.svelte";
import { sendingChatRef } from "../process/index.svelte";
import { type ChatRef, currentChatRef, selectedChat, setChatMeta } from "./chatStore.svelte";
import type { loreBook } from "./database.svelte";

/**
 * The selected chat's local lorebook as an editable copy. The lorebook editors bind to and mutate
 * `localLoreDraft.value` (nested fields included); every change is saved to the chat through the
 * chat module, and a change of the chat's own copy (another writer, a chat switch) replaces it.
 *
 * While a send of this tab or a job this tab knows of runs in the chat, nothing is written: the job
 * writes the lorebook from the chat as stored then (Lua `upsertLocalLoreBook`), and a whole array
 * written from this copy afterwards would drop its entries. A refused change is undone in the copy
 * with the notice (never kept to be written later); the job's write replaces the copy when it
 * reaches the chat.
 */
export const localLoreDraft = $state({ value: [] as loreBook[], key: "" });

let synced = "";
let started = false;
// Lazy: subscribed by the effect below only.
let sendingView: { current: ChatRef | null } | undefined;

/** Whether a send of this tab or a job this tab knows of runs in `ref` (reactive). */
function loreWriteFenced(ref: ChatRef): boolean {
    const sending = (sendingView ??= fromStore(sendingChatRef)).current;
    return (
        (sending !== null && sending.chaId === ref.chaId && sending.chatId === ref.chatId) ||
        generatingChatKeys().has(chatStatusKey(ref))
    );
}

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
            const ref = currentChatRef();
            const fenced = ref !== null && loreWriteFenced(ref);
            untrack(() => {
                if (text === synced || !ref || `${ref.chaId}\u0000${ref.chatId}` !== localLoreDraft.key) {
                    return;
                }
                if (fenced) {
                    alertError(language.chatGenerating);
                    localLoreDraft.value = JSON.parse(synced);
                    return;
                }
                synced = text;
                setChatMeta(ref, { localLore: JSON.parse(text) });
            });
        });
    });
    return localLoreDraft;
}
