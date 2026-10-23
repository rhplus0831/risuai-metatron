<script lang="ts">
    import { characterList, type AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatCount } from "src/ts/storage/chatStore.svelte";
    import { type character, type groupChat } from "src/ts/storage/database.svelte";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import LazyCharImage from "../UI/GUI/LazyCharImage.svelte";
    import { addCharacter, changeChar } from "src/ts/characters";
    import { MessageSquareIcon, PlusIcon } from "@lucide/svelte";
    import { makeCharacterAgoText } from "../UI/mainMenuProjection";
    import { matchesAny, prepareQuery } from "src/ts/util/koreanSearch";

    interface Props {
        endGrid?: () => void;
        search?: string;
        hideTrash?: boolean;
    }

    const agoFormatter = new Intl.RelativeTimeFormat(navigator.languages, { style: "short" });

    let { endGrid = () => {}, search, hideTrash = false }: Props = $props();
    const query = $derived(prepareQuery(search ?? ""));

    function makeAgoText(time: number) {
        return makeCharacterAgoText(time, { agoFormatter, unknownText: "Unknown" });
    }

    function sortChar(char: AnyClientCharacter[]) {
        return char
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => {
                return !hideTrash || !c.trashTime;
            })
            .map(({ c }) => {
                return {
                    name: c.name || "Unnamed",
                    image: c.image,
                    chats: chatCount(c.chaId),
                    chaId: c.chaId,
                    interaction: c.lastInteraction || 0,
                    agoText: makeAgoText(c.lastInteraction || 0),
                };
            })
            .filter((char) => !query || matchesAny([char.name], query))
            .sort((a, b) => {
                if (a.interaction === b.interaction) {
                    return a.name.localeCompare(b.name);
                }
                return b.interaction - a.interaction;
            });
    }
</script>

<div class="flex flex-col items-center w-full overflow-y-auto h-full">
    {#each sortChar(characterList()) as char, i}
        <button
            class="flex p-2 border-t-darkborderc gap-2 w-full"
            class:border-t={i !== 0}
            onclick={() => {
                changeChar(char.chaId);
                endGrid();
            }}
        >
            <LazyCharImage path={char.image} type="css" thumb={256} class="shrink-0">
                {#snippet children(image)}
                    <BarIcon additionalStyle={image}></BarIcon>
                {/snippet}
            </LazyCharImage>
            <div class="flex flex-1 w-full flex-col justify-start items-start text-start">
                <span>{char.name}</span>
                <div class="text-sm text-textcolor2 flex items-center w-full flex-wrap">
                    <span class="mr-1">{char.chats}</span>
                    <MessageSquareIcon size={14} />
                    <span class="mr-1 ml-1">|</span>
                    <span>{char.agoText}</span>
                </div>
            </div>
        </button>
    {/each}
</div>

<button
    class="p-4 rounded-full absolute bottom-2 right-2 bg-borderc"
    onclick={() => {
        addCharacter();
    }}
>
    <PlusIcon size={24} />
</button>
