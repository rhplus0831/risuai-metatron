<script lang="ts">
    import { characterList, selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { changeChar, removeChar, restoreChar } from "../../ts/characters";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ArrowLeft, User, Users, SquareMousePointer, TrashIcon, Undo2Icon } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { parseMultilangString } from "src/ts/util";
    import { matchesAny, prepareQuery, type PreparedQuery } from "src/ts/util/koreanSearch";
    import MobileCharacters from "../Mobile/MobileCharacters.svelte";
    import LazyCharImage from "../UI/GUI/LazyCharImage.svelte";
    interface Props {
        endGrid?: any;
    }

    let { endGrid = () => {} }: Props = $props();
    let search = $state("");
    const query = $derived(prepareQuery(search));
    let selected = $state(3);

    function formatChars(query: PreparedQuery | null, trash = false) {
        let charas: {
            image: string;
            index: number;
            type: string;
            name: string;
            desc: string;
            chaId: string;
        }[] = [];

        const characters = characterList();
        for (let i = 0; i < characters.length; i++) {
            const c = characters[i];
            if (c.trashTime && !trash) {
                continue;
            }
            if (!c.trashTime && trash) {
                continue;
            }
            if (!query || matchesAny([c.name], query)) {
                charas.push({
                    image: c.image,
                    index: i,
                    type: c.type,
                    name: c.name,
                    desc: c.creatorNotes ?? "No description",
                    chaId: c.chaId,
                });
            }
        }
        return charas;
    }
</script>

<div class="h-full w-full flex justify-center">
    <div class="h-full p-6 bg-darkbg max-w-full w-2xl flex flex-col overflow-y-auto">
        <div class="mx-4 mb-6 flex flex-col">
            <div class="flex items-center gap-3 mb-2">
                <button
                    class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0"
                    onclick={() => endGrid()}
                    title="Back"
                >
                    <ArrowLeft size={20} />
                </button>
                <div class="flex-1">
                    <TextInput placeholder="Search" bind:value={search} size="lg" autocomplete="off" fullwidth={true} />
                </div>
            </div>
            <div class="flex flex-wrap gap-2 mt-2">
                <Button
                    styled={selected === 3 ? "primary" : "outlined"}
                    size="sm"
                    onclick={() => {
                        selected = 3;
                    }}
                >
                    {language.simple}
                </Button>
                <Button
                    styled={selected === 0 ? "primary" : "outlined"}
                    size="sm"
                    onclick={() => {
                        selected = 0;
                    }}
                >
                    {language.grid}
                </Button>
                <Button
                    styled={selected === 1 ? "primary" : "outlined"}
                    size="sm"
                    onclick={() => {
                        selected = 1;
                    }}
                >
                    {language.list}
                </Button>
                <Button
                    styled={selected === 2 ? "primary" : "outlined"}
                    size="sm"
                    onclick={() => {
                        selected = 2;
                    }}
                >
                    {language.trash}
                </Button>
                <div class="grow"></div>
                <span class="text-textcolor2 text-sm">
                    {formatChars(query).length}
                    {language.character}
                </span>
            </div>
        </div>
        {#if selected === 0}
            <div class="w-full flex justify-center">
                <div class="flex flex-wrap gap-2 w-full justify-center">
                    {#each formatChars(query) as char}
                        <div class="flex items-center text-textcolor">
                            {#if char.image}
                                <LazyCharImage path={char.image} type="css">
                                    {#snippet children(image)}
                                        <BarIcon
                                            onClick={() => {
                                                changeChar(char.chaId);
                                            }}
                                            additionalStyle={image}
                                        ></BarIcon>
                                    {/snippet}
                                </LazyCharImage>
                            {:else}
                                <BarIcon
                                    onClick={() => {
                                        changeChar(char.chaId);
                                    }}
                                    additionalStyle={char.chaId === selectedCharacter()?.chaId
                                        ? "background:var(--risu-theme-selected)"
                                        : ""}
                                >
                                    {#if char.type === "group"}
                                        <Users />
                                    {:else}
                                        <User />
                                    {/if}
                                </BarIcon>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>
        {:else if selected === 1}
            {#each formatChars(query) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2">
                    <LazyCharImage path={char.image} type="css" class="shrink-0">
                        {#snippet children(image)}
                            <BarIcon
                                onClick={() => {
                                    changeChar(char.chaId);
                                }}
                                additionalStyle={image}
                            ></BarIcon>
                        {/snippet}
                    </LazyCharImage>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">{char.name || "Unnamed"}</h4>
                        <span class="text-textcolor2"
                            >{parseMultilangString(char.desc)["en"] ||
                                parseMultilangString(char.desc)["xx"] ||
                                "No description"}</span
                        >
                        <div class="flex gap-2 justify-end">
                            <button
                                class="hover:text-textcolor text-textcolor2"
                                onclick={() => {
                                    changeChar(char.chaId);
                                }}
                            >
                                <SquareMousePointer />
                            </button>
                            <button
                                class="hover:text-textcolor text-textcolor2"
                                onclick={() => {
                                    removeChar(char.chaId, char.name);
                                }}
                            >
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 2}
            <span class="text-textcolor2 text-sm mb-2">{language.trashDesc}</span>
            {#each formatChars(query, true) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2">
                    <LazyCharImage path={char.image} type="css" class="shrink-0">
                        {#snippet children(image)}
                            <BarIcon
                                onClick={() => {
                                    changeChar(char.chaId);
                                }}
                                additionalStyle={image}
                            ></BarIcon>
                        {/snippet}
                    </LazyCharImage>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">{char.name || "Unnamed"}</h4>
                        <span class="text-textcolor2"
                            >{parseMultilangString(char.desc)["en"] ||
                                parseMultilangString(char.desc)["xx"] ||
                                "No description"}</span
                        >
                        <div class="flex gap-2 justify-end">
                            <button
                                class="hover:text-textcolor text-textcolor2"
                                onclick={() => {
                                    restoreChar(char.chaId);
                                }}
                            >
                                <Undo2Icon />
                            </button>
                            <button
                                class="hover:text-textcolor text-textcolor2"
                                onclick={() => {
                                    removeChar(char.chaId, char.name, "permanent");
                                }}
                            >
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 3}
            <MobileCharacters {endGrid} {search} hideTrash={true} />
        {/if}
    </div>
</div>
