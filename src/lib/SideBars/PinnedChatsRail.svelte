<script lang="ts">
    import { language } from "src/lang";
    import LazyCharImage from "../UI/GUI/LazyCharImage.svelte";
    import type { PinnedChatItem } from "./pinnedChats";

    interface Props {
        items: readonly PinnedChatItem[];
        selectedChaId: string | null;
        selectedChatId: string | null;
        rounded: boolean;
        onOpen: (item: PinnedChatItem) => void;
    }

    let { items, selectedChaId, selectedChatId, rounded, onOpen }: Props = $props();
</script>

{#if items.length > 0}
    <nav
        class="flex max-h-[35%] w-full shrink-0 flex-col items-center gap-2 overflow-x-hidden overflow-y-auto border-b border-darkborderc px-1 py-2"
        aria-label={language.pinnedChats}
        data-risu-pinned-chats
    >
        {#each items as item (JSON.stringify([item.chaId, item.chatId]))}
            {@const isCurrent = selectedChaId === item.chaId && selectedChatId === item.chatId}
            <div
                class="flex w-full shrink-0 cursor-pointer flex-col items-center rounded-md py-1 hover:bg-selected focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500"
                class:bg-selected={isCurrent}
                role="button"
                tabindex="0"
                aria-label={language.openPinnedChat(item.chatName, item.characterName)}
                aria-current={isCurrent ? "page" : undefined}
                data-risu-pinned-chat={item.chatId}
                onclick={() => onOpen(item)}
                onkeydown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onOpen(item);
                    }
                }}
            >
                <LazyCharImage path={item.characterImage} type="plain" class="h-[42px] w-[42px] shrink-0">
                    {#snippet children(image)}
                        {#await image}
                            <span
                                class="block h-full w-full rounded-md bg-selected"
                                class:rounded-full={rounded}
                                aria-hidden="true"
                            ></span>
                        {:then src}
                            <img
                                src={src || "/none.webp"}
                                alt=""
                                class="h-full w-full rounded-md object-cover object-top"
                                class:rounded-full={rounded}
                            />
                        {/await}
                    {/snippet}
                </LazyCharImage>
                <span class="mt-0.5 w-16 truncate text-center text-[10px] text-textcolor2" title={item.chatName}>
                    {item.chatName}
                </span>
            </div>
        {/each}
    </nav>
{/if}
