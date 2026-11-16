<script lang="ts">
    import { language } from "src/lang";
    import { currentChatRef } from "src/ts/storage/chatStore.svelte";
    import { chatBindingIds, chatBindingTargetExists } from "src/ts/storage/chatBinding.svelte";
    import { pickBinding } from "src/ts/storage/chatBindingPick";
    import { editedModelPreset, editedPreset, editedPersona } from "src/ts/storage/settingsViews.svelte";
    import type { ChatBindingField } from "../../../shared/chatBinding.ts";

    /**
     * Compares the tab's shown record with the open chat's binding. A different bound record can be
     * shown by selecting it for the tab; the button never changes a chat's binding. Unset or deleted
     * bindings say "not set for this chat". Nothing at home.
     */

    interface Props {
        field: ChatBindingField;
    }

    let { field }: Props = $props();
    const ref = $derived(currentChatRef());
    const boundId = $derived(ref ? (chatBindingIds(ref)?.[field] ?? null) : null);
    const bound = $derived(boundId !== null && chatBindingTargetExists(field, boundId));
    const shownId = $derived(
        field === "modelPresetId"
            ? editedModelPreset.id
            : field === "promptPresetId"
              ? editedPreset.id
              : editedPersona.id,
    );
</script>

{#if ref}
    {#if bound && boundId === shownId}
        <span class="shrink-0 rounded-sm border border-darkborderc px-1.5 text-xs text-textcolor2">
            {language.chatBinding.thisChat}
        </span>
    {:else if bound}
        <span class="shrink-0 rounded-sm border border-warning-500/50 px-1.5 text-xs text-warning-500">
            {language.chatBinding.notThisChat}
        </span>
        <button
            type="button"
            data-binding-scope-show={field}
            class="text-xs text-textcolor2 underline hover:text-textcolor"
            onclick={() => {
                if (boundId !== null) {
                    pickBinding(field, boundId, null);
                }
            }}
        >
            {language.chatBinding.showThisChat}
        </button>
    {:else}
        <span class="shrink-0 rounded-sm border border-draculared px-1.5 text-xs text-draculared">
            {language.chatBinding.notSetForChat}
        </span>
    {/if}
{/if}
