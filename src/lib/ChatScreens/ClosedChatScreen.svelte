<script lang="ts">
    import { StepForwardIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { changeChatTo } from "src/ts/globalApi.svelte";
    import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatEntry, selectedChatId } from "src/ts/storage/chatStore.svelte";
    import Button from "../UI/GUI/Button.svelte";

    interface Props {
        character: AnyClientCharacter;
    }

    /*
     * The chat screen of a selected character whose chat is not open (`selection.chatOpen`): the
     * character's name and a button that opens its last selected chat. A chat opens only from here or
     * from the sidebar's chat list.
     */
    let { character }: Props = $props();
    const recentId = $derived(selectedChatId(character.chaId));
    const recent = $derived(recentId === null ? undefined : chatEntry({ chaId: character.chaId, chatId: recentId }));
</script>

<div class="h-full w-full flex flex-col items-center justify-center text-center px-6">
    <h2 class="text-2xl font-bold mb-2 text-textcolor">{character.name || language.unnamedCharacter}</h2>
    <p class="text-textcolor2">{language.selectChatToOpen}</p>
    {#if recent}
        <Button
            className="mt-4 flex flex-col items-center gap-2 py-3 max-w-full"
            onclick={() => changeChatTo(recent.id)}
        >
            <span class="flex items-center gap-2">
                <StepForwardIcon size={18} />
                {language.openMostRecentChat}
            </span>
            <hr class="w-full border-darkborderc" />
            <span class="max-w-full truncate text-textcolor2">{recent.name}</span>
        </Button>
    {/if}
</div>
