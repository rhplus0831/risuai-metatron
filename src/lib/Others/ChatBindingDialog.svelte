<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { chatEntry, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { onMount } from "svelte";
    import ChatBindingPanel from "../SideBars/ChatBindingPanel.svelte";

    interface Props {
        chatRef: ChatRef;
        close: () => void;
    }

    /*
     * A chat's binding panel as a dialog, for any chat: the chat list's "Chat settings" and the send
     * area's "Set up this chat" open it. An ordinary overlay like the picker lists: `App.svelte` mounts
     * it before them, so a picker opened from a row paints on top, and alerts (`z-50`) stay above both.
     * It closes when its chat stops being a member.
     */
    let { chatRef, close }: Props = $props();
    const entry = $derived(chatEntry(chatRef));
    let closeButton: HTMLButtonElement | undefined = $state();

    $effect(() => {
        if (!entry) {
            close();
        }
    });

    onMount(() => {
        closeButton?.focus();
    });
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div
        class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-binding-dialog-title"
    >
        <div class="flex items-center text-textcolor mb-1">
            <h2 id="chat-binding-dialog-title" class="mt-0 mb-0 font-bold">{language.chatBinding.chatSettings}</h2>
            <div class="grow flex justify-end">
                <button
                    bind:this={closeButton}
                    class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center"
                    aria-label={language.chatBinding.close}
                    onclick={close}
                >
                    <XIcon size={24} />
                </button>
            </div>
        </div>
        {#if entry}
            <span class="text-textcolor2 text-sm mb-3 truncate">{entry.name}</span>
            <ChatBindingPanel {chatRef} />
        {/if}
    </div>
</div>

<style>
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
