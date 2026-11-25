<script lang="ts">
    import { language } from "src/lang";
    import { findChat, setChatMeta, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { draftHookOf } from "../../../shared/inputHooks.ts";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";

    interface Props {
        chatRef: ChatRef;
    }

    /**
     * Edits the loaded chat's Draft hook choice (`draftHookId`), shown when a Draft hook exists or
     * the chat holds a nonempty string id. None unsets the field; an id naming no Draft hook shows
     * as a missing entry that the user clears with None. Writes require this ref's chat to remain
     * loaded because `draftHookId` is not a list field.
     */
    let { chatRef }: Props = $props();
    const chat = $derived(findChat(chatRef));
    const hooks = $derived(settings.inputHooks ?? []);
    const draftHooks = $derived(hooks.filter((hook) => hook.type === "draft"));
    const storedId = $derived(typeof chat?.draftHookId === "string" ? chat.draftHookId : "");
    const missing = $derived(storedId !== "" && draftHookOf(hooks, storedId) === null);

    /** A late event takes no write once this ref's chat is no longer loaded. */
    function write(id: string) {
        if (!findChat(chatRef)) return;
        if (id === "") {
            setChatMeta(chatRef, {}, ["draftHookId"]);
        } else {
            setChatMeta(chatRef, { draftHookId: id });
        }
    }
</script>

{#if chat && (draftHooks.length > 0 || storedId !== "")}
    <div class="flex flex-col gap-2 rounded-md border border-darkborderc p-2 mb-3" data-chat-draft-hook-panel>
        <label for="chat-draft-hook" class="text-sm text-textcolor2">{language.inputHooks.panelTitle}</label>
        <SelectInput
            id="chat-draft-hook"
            className="w-full min-w-0"
            size="sm"
            value={storedId}
            onchange={(event) => write(event.currentTarget.value)}
        >
            <OptionInput value="">{language.inputHooks.none}</OptionInput>
            {#if missing}
                <OptionInput value={storedId}>{language.inputHooks.missingHook}</OptionInput>
            {/if}
            {#each draftHooks as hook (hook.id)}
                <OptionInput value={hook.id}>{hook.name}</OptionInput>
            {/each}
        </SelectInput>
    </div>
{/if}
