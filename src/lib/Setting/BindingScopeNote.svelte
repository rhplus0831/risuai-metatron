<script lang="ts">
    import { language } from "src/lang";
    import { currentChatRef } from "src/ts/storage/chatStore.svelte";
    import { chatBindingIds, chatBindingTargetExists } from "src/ts/storage/chatBinding.svelte";
    import type { ChatBindingField } from "../../../shared/chatBinding.ts";

    interface Props {
        field: ChatBindingField;
    }

    /*
     * Whose record a settings header shows: while a chat is open, "this chat's" when the chat binds the
     * field to a record that exists, else "not set for this chat" (the view then shows the tab's record).
     * Nothing at home, where the header shows the tab's selection.
     */
    let { field }: Props = $props();
    const ref = $derived(currentChatRef());
    const boundId = $derived(ref ? (chatBindingIds(ref)?.[field] ?? null) : null);
    const bound = $derived(boundId !== null && chatBindingTargetExists(field, boundId));
</script>

{#if ref}
    {#if bound}
        <span class="shrink-0 rounded-sm border border-darkborderc px-1.5 text-xs text-textcolor2">
            {language.chatBinding.thisChat}
        </span>
    {:else}
        <span class="shrink-0 rounded-sm border border-draculared px-1.5 text-xs text-draculared">
            {language.chatBinding.notSetForChat}
        </span>
    {/if}
{/if}
