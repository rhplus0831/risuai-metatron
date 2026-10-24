import { untrack } from "svelte";
import { fromStore } from "svelte/store";
import { language } from "src/lang";
import { alertError } from "../alert";
import { chatStatusKey, generatingChatKeys } from "../process/chatStatus.svelte";
import { isLocalSend, localSends } from "../process/localSends";
import { type ChatRef, currentChatRef, selectedChat } from "./chatStore.svelte";
import type { DeepReadonly } from "../../../shared/readonly.ts";

// Lazily observed by draft effects; structural actions can also read the current fence.
let sendsView: { current: ReadonlyMap<string, ChatRef | null> } | undefined;

/** Whether a send of this tab or a job this tab knows of runs in `ref` (reactive). */
export function loreWriteFenced(ref: ChatRef): boolean {
    return (
        isLocalSend(ref, (sendsView ??= fromStore(localSends)).current) || generatingChatKeys().has(chatStatusKey(ref))
    );
}

/**
 * Creates an independent, lazily started editing copy of the selected chat's array field. Editors
 * bind to and mutate `draft.value`, including nested fields; every change is saved through `write`.
 * A chat switch or another writer's change to the stored field replaces the copy. Synchronization
 * itself never writes, so opening a chat cannot create an absent optional field.
 *
 * While a send of this tab or a job this tab knows of runs in the chat, nothing is written. A job
 * can write the array from the chat as stored then (for example Lua `upsertLocalLoreBook` writes
 * the lorebook); writing the whole array from this copy afterwards would drop the job's entries.
 * A refused change is undone in the copy with the notice, never kept to be written later. The
 * job's write replaces the copy when it reaches the chat.
 */
export function createChatFieldDraft<T>(
    read: (chat: NonNullable<ReturnType<typeof selectedChat>>) => DeepReadonly<T[]>,
    write: (ref: ChatRef, value: T[]) => void,
) {
    const draft = $state({ value: [] as T[], key: "" });
    let synced = "";
    let started = false;
    function useDraft(): typeof draft {
        if (started) {
            return draft;
        }
        started = true;
        $effect.root(() => {
            $effect.pre(() => {
                const ref = currentChatRef();
                const chat = selectedChat();
                const key = ref && chat ? `${ref.chaId}\u0000${ref.chatId}` : "";
                const text = JSON.stringify($state.snapshot(chat ? read(chat) : []));
                untrack(() => {
                    if (key !== draft.key || text !== synced) {
                        draft.key = key;
                        synced = text;
                        draft.value = JSON.parse(text);
                    }
                });
            });
            $effect(() => {
                const text = JSON.stringify($state.snapshot(draft.value));
                const ref = currentChatRef();
                const fenced = ref !== null && loreWriteFenced(ref);
                untrack(() => {
                    if (text === synced || !ref || `${ref.chaId}\u0000${ref.chatId}` !== draft.key) {
                        return;
                    }
                    if (fenced) {
                        alertError(language.chatGenerating);
                        draft.value = JSON.parse(synced);
                        return;
                    }
                    synced = text;
                    write(ref, JSON.parse(text));
                });
            });
        });
        return draft;
    }
    return { draft, useDraft };
}
