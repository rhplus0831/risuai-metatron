<script lang="ts">
    import { language } from "src/lang";
    import LazyCharImage from "../UI/GUI/LazyCharImage.svelte";
    import ChatStatusBadge from "./ChatStatusBadge.svelte";
    import { chatStatusLabel, type ChatStatus, type MemoryCount } from "./chatStatus";
    import type { PinnedChatItem } from "./pinnedChats";

    interface Props {
        items: readonly PinnedChatItem[];
        selectedChaId: string | null;
        selectedChatId: string | null;
        rounded: boolean;
        onOpen: (item: PinnedChatItem) => void;
        statuses?: ReadonlyMap<string, ChatStatus>;
        /** The summarizing chats' counts (`summarizingChats`), keyed like `statuses`. */
        memoryCounts?: ReadonlyMap<string, MemoryCount | null>;
    }

    let {
        items,
        selectedChaId,
        selectedChatId,
        rounded,
        onOpen,
        statuses = new Map(),
        memoryCounts = new Map(),
    }: Props = $props();
</script>

{#if items.length > 0}
    <nav
        class="flex max-h-[35%] w-full shrink-0 flex-col items-center gap-2 overflow-x-hidden overflow-y-auto border-b border-darkborderc px-1 py-2"
        aria-label={language.pinnedChats}
        data-risu-pinned-chats
    >
        {#each items as item (JSON.stringify([item.chaId, item.chatId]))}
            {@const isCurrent = selectedChaId === item.chaId && selectedChatId === item.chatId}
            {@const statusKey = `${item.chaId}\u0000${item.chatId}`}
            {@const status = statuses.get(statusKey)}
            {@const statusCount = status === "memory" ? (memoryCounts.get(statusKey) ?? null) : null}
            {@const statusLabel = status ? chatStatusLabel(status, item.chatName, statusCount) : ""}
            {@const label =
                language.openPinnedChat(item.chatName, item.characterName) + (status ? ` · ${statusLabel}` : "")}
            <div
                class="relative flex w-full shrink-0 cursor-pointer flex-col items-center rounded-md py-1 hover:bg-selected focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500"
                class:bg-selected={isCurrent}
                role="button"
                tabindex="0"
                aria-label={label}
                aria-current={isCurrent ? "page" : undefined}
                title={status ? label : undefined}
                data-risu-pinned-chat={item.chatId}
                data-risu-chat-status={status}
                onclick={() => onOpen(item)}
                onkeydown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onOpen(item);
                    }
                }}
            >
                <LazyCharImage
                    path={item.characterImage}
                    type="plain"
                    thumb={256}
                    class="relative h-[42px] w-[42px] shrink-0"
                >
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
                        {#if status}
                            <ChatStatusBadge {status} label={statusLabel} count={statusCount} />
                        {/if}
                    {/snippet}
                </LazyCharImage>
                <span
                    class="mt-0.5 w-16 truncate text-center text-[10px] text-textcolor2"
                    title={status ? label : item.chatName}
                >
                    {item.chatName}
                </span>
            </div>
        {/each}
    </nav>
{/if}
