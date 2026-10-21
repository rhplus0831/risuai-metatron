<script lang="ts">
    import { settings, activePersona } from "src/ts/storage/settingsViews.svelte";
    import { XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { changeUserPersona } from "src/ts/persona";
    import { chatEntry, currentChatRef, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { pickedId } from "src/ts/storage/chatBinding.svelte";
    import { personaNoteFirstLine } from "../../../shared/personas.ts";

    interface Props {
        close?: any;
        /** The chat whose persona a pick binds (the binding panel's row); else the open chat, else the tab's selection. */
        chatRef?: ChatRef;
    }

    let { close = () => {}, chatRef }: Props = $props();
    /** The chat the list picks for: the given chat, else the open chat; null at home. */
    const shownRef = $derived(chatRef ?? currentChatRef());
    const shownChatName = $derived(shownRef ? chatEntry(shownRef)?.name : undefined);
    // Read once per render, not once per row.
    const selectedPersonaId = $derived(pickedId("personaId", shownRef, activePersona.id));

    // A list opened for a chat closes when that chat is gone; it never falls back to the open chat.
    $effect(() => {
        if (chatRef && !chatEntry(chatRef)) {
            close();
        }
    });
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0 font-bold">{language.persona}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24} />
                </button>
            </div>
        </div>
        {#if shownRef}
            <span class="text-textcolor2 text-sm mb-2">{language.chatBinding.forChat(shownChatName ?? "")}</span>
        {/if}
        {#each settings.personas as persona, i}
            {@const noteLine = personaNoteFirstLine(persona.note)}
            <button
                onclick={() => {
                    if (changeUserPersona(persona.id, chatRef)) {
                        close();
                    }
                }}
                class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer"
                class:bg-selected={persona.id === selectedPersonaId}
            >
                <span class="overflow-x-auto whitespace-nowrap w-full text-left">
                    <span class="font-medium">{persona.name}</span>
                    {#if noteLine}
                        <span class="opacity-75"> / {noteLine}</span>
                    {/if}
                </span>
            </button>
        {/each}
    </div>
</div>

<style>
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
