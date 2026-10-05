<script lang="ts">
    import { selectedCharacter, type AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { ParseMarkdown, risuChatParser } from "src/ts/parser/parser.svelte";
    import { type character, type groupChat } from "src/ts/storage/database.svelte";
    import { moduleBackgroundEmbedding, ReloadGUIPointer } from "src/ts/stores.svelte";

    const currentCharacter = $derived(selectedCharacter());
    let backgroundHTML = $derived(currentCharacter?.backgroundHTML);
    let currentChar: AnyClientCharacter = $derived(currentCharacter);
</script>

{#if backgroundHTML || $moduleBackgroundEmbedding}
    {#if currentCharacter !== undefined}
        {#key $ReloadGUIPointer}
            <div class="absolute top-0 left-0 w-full h-full">
                {#await ParseMarkdown(risuChatParser( (backgroundHTML || "") + "\n" + ($moduleBackgroundEmbedding || ""), { chara: currentChar } ), currentChar, "back") then md}
                    {@html md}
                {/await}
            </div>
        {/key}
    {/if}
{/if}
