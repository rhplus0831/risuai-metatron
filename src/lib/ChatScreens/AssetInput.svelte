<script lang="ts">
    import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { FileMusicIcon, PlusIcon } from "@lucide/svelte";
    import { type character, type groupChat } from "src/ts/storage/database.svelte";
    import { saveAsset } from "src/ts/globalApi.svelte";
    import { ASSET_LIST_PAGE, assetExtension, selectMultipleFile } from "src/ts/util";
    import Button from "../UI/GUI/Button.svelte";
    import LazyFileSrc from "../UI/GUI/LazyFileSrc.svelte";
    import { language } from "../../lang";
    interface Props {
        currentCharacter: AnyClientCharacter;
        onSelect: (additionalAsset: [string, string, string]) => void;
    }

    const { currentCharacter, onSelect }: Props = $props();

    // The stickers rendered (each loads its preview once near the viewport); back to a page per character.
    const ownerId = $derived(currentCharacter.chaId);
    let shown = $derived.by(() => {
        ownerId;
        return ASSET_LIST_PAGE;
    });
</script>

{#if currentCharacter.type === "character"}
    <button
        class="hover:text-green-500 bg-textcolor2 flex justify-center items-center w-16 h-16 m-1 rounded-md"
        onclick={async () => {
            if (currentCharacter.type === "character") {
                const da = await selectMultipleFile(["png", "webp", "mp4", "mp3", "gif"]);
                currentCharacter.additionalAssets = currentCharacter.additionalAssets ?? [];
                if (!da) {
                    return;
                }
                for (const f of da) {
                    console.log(f);
                    const img = f.data;
                    const name = f.name;
                    const extension = name.split(".").pop().toLowerCase();
                    const imgp = await saveAsset(img, "", extension);
                    currentCharacter.additionalAssets.push([name, imgp, extension]);
                }
            }
        }}
    >
        <PlusIcon />
    </button>
    {#if currentCharacter.additionalAssets}
        {#each currentCharacter.additionalAssets.slice(0, shown) as additionalAsset}
            {@const extension = assetExtension(additionalAsset)}
            <button
                onclick={() => {
                    onSelect(additionalAsset);
                }}
            >
                {#if extension === "mp3"}
                    <div class="w-16 h-16 m-1 rounded-md bg-slate-500 flex flex-col justify-center items-center">
                        <FileMusicIcon />
                        <div class="w-16 px-1 text-ellipsis whitespace-nowrap overflow-hidden">
                            {additionalAsset[0]}
                        </div>
                    </div>
                {:else}
                    <LazyFileSrc path={additionalAsset[1]} class="w-16 h-16 m-1">
                        {#snippet children(src)}
                            {#if extension === "mp4"}
                                <!-- svelte-ignore a11y_media_has_caption -->
                                <video class="w-16 h-16 rounded-md"><source {src} type="video/mp4" /></video>
                            {:else}
                                <img {src} class="w-16 h-16 rounded-md" alt={additionalAsset[0]} />
                            {/if}
                        {/snippet}
                    </LazyFileSrc>
                {/if}
            </button>
        {/each}
        {#if currentCharacter.additionalAssets.length > shown}
            <Button className="m-1" onclick={() => (shown += ASSET_LIST_PAGE)}>{language.loadMore}</Button>
        {/if}
    {/if}
{/if}
