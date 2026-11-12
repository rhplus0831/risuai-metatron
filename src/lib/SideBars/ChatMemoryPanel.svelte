<script lang="ts">
    import { language } from "src/lang";
    import { chatMemoryEnabled } from "../../../shared/chatMemory.ts";
    import { chatEntry, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatMemorySettings, setChatMemoryEnabled } from "src/ts/storage/chatMemory.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";

    let { chatRef }: { chatRef: ChatRef } = $props();
    const entry = $derived(chatEntry(chatRef));
    const enabled = $derived(chatMemoryEnabled(entry, findCharacter(chatRef.chaId), chatMemorySettings()));

    function setEnabled(on: boolean) {
        if (chatEntry(chatRef)) setChatMemoryEnabled(chatRef, on);
    }
</script>

{#if entry}
    <div class="mb-3 min-w-0 rounded-md border border-darkborderc p-2" data-chat-memory-panel>
        <CheckInput check={enabled} name={language.chatMemory.enabled} onChange={setEnabled} className="min-w-0" />
    </div>
{/if}
