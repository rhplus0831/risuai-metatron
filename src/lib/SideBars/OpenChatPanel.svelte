<script lang="ts">
    import { ArrowLeftIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { currentChatRef, selectedChat } from "src/ts/storage/chatStore.svelte";
    import { setChatOpen } from "src/ts/storage/selection.svelte";
    import ChatNoteEditor from "./ChatNoteEditor.svelte";
    import Toggles from "./Toggles.svelte";

    interface Props {
        chara: AnyClientCharacter;
    }

    /*
     * The sidebar's chat tab while a chat is open (`selection.chatOpen`), in place of the chat list:
     * a way back to the list (the closed-chat screen), the chat's author note, and the toggles.
     */
    let { chara }: Props = $props();
    const currentChat = $derived(selectedChat());
    const currentRef = $derived(currentChatRef());
</script>

<div class="flex flex-col w-full h-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-y-auto">
    <button
        class="mb-3 flex min-h-10 items-center gap-2 rounded-md px-2 text-textcolor2 hover:bg-selected hover:text-textcolor cursor-pointer"
        onclick={() => setChatOpen(false)}
    >
        <ArrowLeftIcon size={18} />
        <span>{language.goback}</span>
    </button>

    <!-- The chat's fields wait while the selected chat loads; another chat gets its own editor. -->
    {#if currentChat && currentRef}
        {#key `${currentRef.chaId}\n${currentRef.chatId}`}
            <ChatNoteEditor chat={currentRef} />
        {/key}
    {/if}

    <Toggles {chara} noContainer />
</div>
