<script lang="ts">
    import { ChevronRightIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { chatEntry, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { chatBindingIds, chatBindingPatch, chatBindingTargetExists } from "src/ts/storage/chatBinding.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { openModelPresetList, openPersonaList, openPresetList } from "src/ts/stores.svelte";
    import type { ChatBindingField } from "../../../shared/chatBinding.ts";
    import Button from "../UI/GUI/Button.svelte";

    interface Props {
        chatRef: ChatRef;
    }

    /*
     * A chat's binding (`docs/plan/chat-binding.md`, slice 5): the model preset, prompt preset, and
     * persona it is sent with, each by name or as not set or deleted, and the confirmation an imported
     * chat waits for. A row opens its picker for this chat. The bound persona's note (never sent) shows
     * under the rows. It reads the chat's list entry only, so it works for a chat that is not loaded; a
     * chat that is not a member shows nothing.
     */
    let { chatRef }: Props = $props();
    const ids = $derived(chatBindingIds(chatRef));
    const note = $derived(personaNote(ids?.personaId ?? null));

    const fields: ChatBindingField[] = ["modelPresetId", "promptPresetId", "personaId"];

    /** The bound record's name (tracked: a rename or a deletion shows at once). */
    function recordName(field: ChatBindingField, id: string): string | undefined {
        const list: readonly { id?: string; name?: string }[] | undefined =
            field === "modelPresetId"
                ? settings.modelPresets
                : field === "promptPresetId"
                  ? settings.presets
                  : settings.personas;
        return list?.find((record) => record.id === id)?.name;
    }

    /** The bound persona's note, multi-line as written; `""` when unset, deleted, or blank. */
    function personaNote(id: string | null): string {
        if (id === null) {
            return "";
        }
        const note = settings.personas?.find((record) => record.id === id)?.note;
        return typeof note === "string" && note.trim() !== "" ? note : "";
    }

    function openPicker(field: ChatBindingField) {
        const store =
            field === "modelPresetId"
                ? openModelPresetList
                : field === "promptPresetId"
                  ? openPresetList
                  : openPersonaList;
        store.set({ chatRef });
    }

    function confirmReview() {
        // The chat can be gone by the click (the panel waits on the next render).
        if (chatEntry(chatRef)) {
            chatBindingPatch(chatRef, { review: false });
        }
    }
</script>

{#if ids}
    <div class="flex flex-col rounded-md border border-darkborderc mb-3" data-chat-binding-panel>
        {#each fields as field, i (field)}
            {@const id = ids[field]}
            {@const exists = id !== null && chatBindingTargetExists(field, id)}
            <button
                class="flex items-center gap-2 p-2 text-left hover:bg-selected cursor-pointer"
                class:border-t={i !== 0}
                class:border-darkborderc={i !== 0}
                data-chat-binding-field={field}
                onclick={() => openPicker(field)}
            >
                <span class="text-textcolor2 text-sm shrink-0">{language.chatBinding.fields[field]}</span>
                {#if id === null}
                    <span class="grow truncate text-right text-draculared">{language.chatBinding.unset}</span>
                {:else if !exists}
                    <span class="grow truncate text-right text-draculared">{language.chatBinding.gone}</span>
                {:else}
                    <span class="grow truncate text-right text-textcolor">{recordName(field, id) ?? ""}</span>
                {/if}
                <ChevronRightIcon size={16} class="shrink-0 text-textcolor2" />
            </button>
        {/each}
        {#if note}
            <div
                class="p-2 border-t border-darkborderc text-sm text-textcolor2 whitespace-pre-wrap break-words max-h-40 overflow-y-auto"
                aria-label={language.personaNote}
                data-chat-binding-persona-note
            >
                {note}
            </div>
        {/if}
        {#if ids.review}
            <div class="flex flex-col gap-2 p-2 border-t border-darkborderc">
                <span class="text-sm text-textcolor2">{language.chatBinding.review}</span>
                <Button size="sm" onclick={confirmReview}>{language.chatBinding.confirmReview}</Button>
            </div>
        {/if}
    </div>
{/if}
