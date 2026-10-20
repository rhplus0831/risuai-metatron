<script lang="ts">
    import { untrack } from "svelte";
    import { characterAssetNames, matchingAssetIndices } from "src/ts/assetList";
    import { characterList, type AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { FileMusicIcon, PlusIcon } from "@lucide/svelte";
    import { type character, type groupChat } from "src/ts/storage/database.svelte";
    import { alertError } from "src/ts/alert";
    import { savePickedFiles } from "src/ts/storage/assetQueue";
    import { ASSET_LIST_PAGE, assetExtension, selectMultipleFileHandles } from "src/ts/util";
    import Button from "../UI/GUI/Button.svelte";
    import LazyFileSrc from "../UI/GUI/LazyFileSrc.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { language } from "../../lang";
    interface Props {
        currentCharacter: AnyClientCharacter;
        onSelect: (additionalAsset: readonly [string, string, string]) => void;
    }

    const { currentCharacter, onSelect }: Props = $props();

    // Search and paging reset per character; each query starts at the first page of matches.
    const ownerId = $derived(currentCharacter.chaId);
    let assetQuery = $derived.by(() => {
        ownerId;
        return "";
    });
    let shown = $derived.by(() => {
        ownerId;
        assetQuery;
        return ASSET_LIST_PAGE;
    });
    const matchedAssets = $derived.by(() => {
        const chaId = ownerId;
        const query = assetQuery.trim().toLowerCase();
        const list = currentCharacter.type === "character" ? currentCharacter.additionalAssets : undefined;
        const length = list?.length ?? 0;
        if (!query) return null;
        return length ? untrack(() => matchingAssetIndices(characterAssetNames(chaId, list), query)) : [];
    });
    const assetCount = $derived(
        matchedAssets?.length ??
            (currentCharacter.type === "character" ? (currentCharacter.additionalAssets?.length ?? 0) : 0),
    );
    const assetIndices = $derived(
        matchedAssets?.slice(0, shown) ?? Array.from({ length: Math.min(shown, assetCount) }, (_, index) => index),
    );
</script>

{#if currentCharacter.type === "character"}
    <div class="flex items-center w-full">
        <button
            class="hover:text-green-500 bg-textcolor2 flex justify-center items-center w-16 h-16 m-1 rounded-md"
            onclick={async () => {
                if (currentCharacter.type === "character") {
                    // The character this was opened for, found again after each await.
                    const chaId = currentCharacter.chaId;
                    const target = () => {
                        const found = characterList().find((entry) => entry?.chaId === chaId);
                        return found?.type === "character" ? found : undefined;
                    };
                    const da = await selectMultipleFileHandles(["png", "webp", "mp4", "mp3", "gif"]);
                    if (!target()) {
                        return;
                    }
                    target().additionalAssets = target().additionalAssets ?? [];
                    if (da.length === 0) {
                        return;
                    }
                    const extension = (f: File) => f.name.split(".").pop().toLowerCase();
                    let keys: string[];
                    try {
                        keys = await savePickedFiles(da, extension);
                    } catch (error) {
                        alertError(error);
                        return;
                    }
                    const char = target();
                    if (char) {
                        // The list is immutable: appended to the latest one, replaced whole.
                        char.additionalAssets = [
                            ...(char.additionalAssets ?? []),
                            ...da.map((f, i): [string, string, string] => [f.name, keys[i], extension(f)]),
                        ];
                    }
                }
            }}
        >
            <PlusIcon />
        </button>
        <TextInput className="m-1 min-w-0 flex-1" placeholder={language.search} bind:value={assetQuery} />
    </div>
    {#if matchedAssets?.length === 0}
        <div class="m-1 text-textcolor2">{language.noMatchingAssets}</div>
    {/if}
    {#if currentCharacter.additionalAssets}
        {#each assetIndices as index}
            {@const additionalAsset = currentCharacter.additionalAssets[index]}
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
        {#if assetCount > shown}
            <Button className="m-1" onclick={() => (shown += ASSET_LIST_PAGE)}>{language.loadMore}</Button>
        {/if}
    {/if}
{/if}
