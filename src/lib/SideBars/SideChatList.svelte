<script lang="ts">
    import { type AnyClientCharacter, characterList } from "src/ts/storage/characterStore.svelte";
    import { onDestroy, untrack } from "svelte";
    import { v4 } from "uuid";
    import Sortable from "sortablejs/modular/sortable.core.esm.js";
    import {
        DownloadIcon,
        PencilIcon,
        PinIcon,
        HardDriveUploadIcon,
        MenuIcon,
        TrashIcon,
        SplitIcon,
        FolderPlusIcon,
        BookmarkCheckIcon,
        CircleAlertIcon,
        TextSearchIcon,
    } from "@lucide/svelte";

    import type { Chat, ChatFolder, character, DeepReadonly, groupChat } from "src/ts/storage/database.svelte";
    import { chatBindingDialog, ReloadGUIPointer } from "src/ts/stores.svelte";
    import { chatBinding, initialChatBinding } from "src/ts/storage/chatBinding.svelte";
    import { initialChatToggles } from "src/ts/toggles/chatToggles.svelte";
    import { initialChatTranslation } from "src/ts/translator/chatTranslation.svelte";

    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";

    import { exportChat, importChat, exportAllChats } from "src/ts/characters";
    import { alertChatOptions, alertConfirm, alertError, alertSelect, alertStore } from "src/ts/alert";
    import { findCharacterbyId, sleep, sortableOptions } from "src/ts/util";
    import { bookmarkListOpen } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { changeChatTo, createChatCopyName } from "src/ts/globalApi.svelte";
    import {
        chatEntry,
        chatList,
        type ChatListEntry,
        createChat,
        deleteChat,
        ensureChatLoaded,
        findChat,
        isChatGenerating,
        reorderChats,
        selectedChatId,
        setChatMeta,
    } from "src/ts/storage/chatStore.svelte";
    import { chatFolderOf } from "./chatFolders";
    import { matchesAny, prepareQuery } from "src/ts/util/koreanSearch";
    import { openMessageSearch } from "src/ts/messageSearch.svelte";

    /** Sets a chat's folder (null or undefined: no folder) through the chat module. */
    function setChatFolder(chat: ChatListEntry, folderId: string | null | undefined) {
        const ref = { chaId: chara.chaId, chatId: chat.id };
        if (folderId) {
            setChatMeta(ref, { folderId });
        } else if (chat.folderId != null) {
            setChatMeta(ref, {}, ["folderId"]);
        }
    }

    interface Props {
        chara: AnyClientCharacter;
    }

    let { chara = $bindable() }: Props = $props();
    let editMode = $state(false);
    /** The character's chats as list entries (the chat module's; never whole chats). */
    const chats = $derived(chatList(chara.chaId));
    const selectedId = $derived(selectedChatId(chara.chaId));

    /** The filter field's text; it resets when the character changes. */
    let filterText = $state("");
    const filterQuery = $derived(prepareQuery(filterText));
    // The id as its own derived value: a refresh of the same character replaces the record and
    // would rerun an effect that read `chara.chaId` directly.
    const filterOwner = $derived(chara.chaId);
    $effect.pre(() => {
        void filterOwner;
        untrack(() => (filterText = ""));
    });

    /** Whether a chat shows under the filter: its name or its folder's name matches (all chats without a query). */
    function chatShown(chat: ChatListEntry): boolean {
        return (
            filterQuery === null || matchesAny([chat.name, chatFolderOf(chat, chara.chatFolders)?.name], filterQuery)
        );
    }

    /** A detached copy of a chat for a copy action, loaded first and found again after the load (null when it is gone). */
    async function chatCopySource(ref: { chaId: string; chatId: string }): Promise<Chat | null> {
        await ensureChatLoaded(ref);
        const chat = findChat(ref);
        return chat ? ($state.snapshot(chat) as Chat) : null;
    }

    /** Whether a row's chat cannot be sent until its binding is complete (from its list entry). */
    function bindingIncomplete(chat: ChatListEntry): boolean {
        return chatBinding({ chaId: chara.chaId, chatId: chat.id })?.ok === false;
    }

    /**
     * A chat row's options: copy the chat, or open its binding (chat settings). The chat (and its
     * character) are captured before the dialogs, so a selection change or a reorder meanwhile cannot
     * redirect them.
     */
    async function chatOptions(entry: ChatListEntry) {
        const ref = { chaId: chara.chaId, chatId: entry.id };
        const option = await alertChatOptions();
        switch (option) {
            case 0: {
                const source = await chatCopySource(ref);
                if (!source) {
                    break;
                }
                delete source.pinned;
                createChat(
                    ref.chaId,
                    { ...source, name: createChatCopyName(source.name, "Copy", ref.chaId), id: v4() },
                    { index: 0, select: true },
                );
                break;
            }
            case 1: {
                // The binding is in the list entry, so a chat that is not loaded opens too.
                if (chatEntry(ref)) {
                    chatBindingDialog.set(ref);
                }
                break;
            }
        }
    }

    /**
     * A drop's order (the rows as the DOM has them) with every listed chat it misses appended in
     * list order, so `reorderChats` always gets a permutation even when a chat has no row.
     */
    function completeOrder(ordered: string[], listed: readonly ChatListEntry[]): string[] {
        const seen = new Set(ordered);
        return [...ordered, ...listed.filter((chat) => !seen.has(chat.id)).map((chat) => chat.id)];
    }

    let chatsStb: Sortable[] = [];
    let folderStb: Sortable = null;

    function destroyStb() {
        for (const stb of [...chatsStb, folderStb]) {
            try {
                stb?.destroy();
            } catch (error) {}
        }
        chatsStb = [];
        folderStb = null;
    }

    let folderEles: HTMLDivElement = $state();
    let listEle: HTMLDivElement = $state();
    let sorted = $state(0);
    let opened = 0;

    const createStb = () => {
        destroyStb();
        if (!listEle || !folderEles) {
            return;
        }
        // A filtered view hides rows, so no drag may reorder it (the effect below toggles it later).
        const disabled = filterQuery !== null;
        for (let chat of listEle.querySelectorAll(".risu-chat")) {
            chatsStb.push(
                new Sortable(chat, {
                    group: "chats",
                    disabled,
                    onEnd: async (event) => {
                        // The list as rendered (the indexes in the DOM are into it), read once:
                        // a folder change below makes the derived list a new one.
                        const listed = chats;
                        const folders = chara.chatFolders;
                        const newChats: string[] = [];

                        listEle.querySelectorAll("[data-risu-chat-folder-idx]").forEach((folder) => {
                            const folderIdx = parseInt(folder.getAttribute("data-risu-chat-folder-idx"));
                            folder.querySelectorAll("[data-risu-chat-idx]").forEach((chatInFolder) => {
                                const chatIdx = parseInt(chatInFolder.getAttribute("data-risu-chat-idx"));
                                const newChat = listed[chatIdx];
                                if (newChat.folderId !== folders[folderIdx].id) {
                                    setChatFolder(newChat, folders[folderIdx].id);
                                }
                                newChats.push(newChat.id);
                            });
                        });

                        listEle.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
                            const idx = parseInt(chatEle.getAttribute("data-risu-chat-idx"));
                            const newChat = listed[idx];
                            if (newChats.includes(newChat.id) == false) {
                                // A root row leaves its folder; a dangling id (already unfiled) is not written.
                                if (chatFolderOf(newChat, folders) != null) {
                                    setChatFolder(newChat, null);
                                }
                                newChats.push(newChat.id);
                            }
                        });

                        // The selected chat stays selected (the selection is by id).
                        reorderChats(chara.chaId, completeOrder(newChats, listed));

                        try {
                            this.destroy();
                        } catch (e) {}
                        sorted += 1;
                        await sleep(1);
                        createStb();
                    },
                    ...sortableOptions,
                }),
            );
        }
        folderStb = Sortable.create(folderEles, {
            group: "folders",
            disabled,
            onEnd: async (event) => {
                const listed = chats;
                const newFolders: ChatFolder[] = [];
                const newChats: string[] = [];
                const folders: HTMLElement[] = Array.from<HTMLElement>(event.to.children);

                folders.forEach((folder) => {
                    const folderIdx = parseInt(folder.getAttribute("data-risu-chat-folder-idx"));
                    newFolders.push(chara.chatFolders[folderIdx]);

                    folder.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
                        const idx = parseInt(chatEle.getAttribute("data-risu-chat-idx"));
                        newChats.push(listed[idx].id);
                    });
                });

                listEle.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
                    const idx = parseInt(chatEle.getAttribute("data-risu-chat-idx"));
                    if (newChats.includes(listed[idx].id) == false) {
                        newChats.push(listed[idx].id);
                    }
                });

                chara.chatFolders = newFolders;
                reorderChats(chara.chaId, completeOrder(newChats, listed));
                try {
                    folderStb.destroy();
                } catch (e) {}
                sorted += 1;
                await sleep(1);
                createStb();
            },
            ...sortableOptions,
        });
    };

    // The folder list is unkeyed: a folder added or removed after mount (New Folder, an import, another character) changes the containers, so the instances are recreated once the DOM has them.
    $effect(() => {
        void chara.chatFolders?.length;
        untrack(createStb);
    });

    $effect(() => {
        const disabled = filterQuery !== null;
        for (const stb of [...chatsStb, folderStb]) {
            stb?.option("disabled", disabled);
        }
    });

    onDestroy(destroyStb);
</script>

<div class="flex flex-col w-full h-[calc(100%-2rem)] max-h-[calc(100%-2rem)]">
    <Button
        className="relative bottom-2"
        onclick={() => {
            const cha = chara;
            const len = chats.length;
            const newChat: Chat = {
                // Read before the chat is created: it becomes the selected chat.
                ...initialChatBinding(cha.chaId),
                ...initialChatTranslation(cha.chaId),
                ...initialChatToggles(cha.chaId),
                message: [],
                note: "",
                name: `New Chat ${len + 1}`,
                localLore: [],
                fmIndex: -1,
                id: v4(),
            };
            if (cha.type === "group") {
                // A group chat starts with each member's first message (they went into the oldest
                // chat before, an indexing slip).
                newChat.message = cha.characters.map((c) => ({
                    saying: c,
                    role: "char" as const,
                    data: findCharacterbyId(c).firstMessage,
                }));
            }
            createChat(cha.chaId, newChat, { index: 0, select: true });
            changeChatTo(0);
            $ReloadGUIPointer += 1;
        }}>{language.newChat}</Button
    >
    <TextInput placeholder={language.search} bind:value={filterText} size="sm" fullwidth={true} />

    {#key sorted}
        <!-- Stretched over the sidebar's side padding so the scrollbar sits at the sidebar's edge. -->
        <div
            class="flex flex-col mt-2 overflow-y-auto grow -mr-(--sidebar-gutter) pr-(--sidebar-gutter)"
            bind:this={listEle}
        >
            <!-- folder div -->
            <div class="flex flex-col" bind:this={folderEles}>
                <!-- chat folder -->
                {#each chara.chatFolders as folder, i}
                    {@const inFolder = chats.filter((chat) => chatFolderOf(chat, chara.chatFolders)?.id === folder.id)}
                    <!-- Rows the filter hides stay in the DOM, so the drop handlers' indexes and the
                         SortableJS containers survive filtering (drag is off while filtered). -->
                    <div
                        data-risu-chat-folder-idx={i}
                        class="flex flex-col mb-2 border-solid border-1 border-darkborderc cursor-pointer rounded-md"
                        class:hidden={filterQuery !== null && !inFolder.some(chatShown)}
                    >
                        <!-- folder header -->
                        <button
                            onclick={() => {
                                // A filtered view shows every folder open, so a toggle would only change hidden state.
                                if (!editMode && filterQuery === null) {
                                    chara.chatFolders[i].folded = !folder.folded;
                                    $ReloadGUIPointer += 1;
                                }
                            }}
                            class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
                            class:bg-red-900={folder.color === "red"}
                            class:bg-yellow-900={folder.color === "yellow"}
                            class:bg-green-900={folder.color === "green"}
                            class:bg-blue-900={folder.color === "blue"}
                            class:bg-indigo-900={folder.color === "indigo"}
                            class:bg-purple-900={folder.color === "purple"}
                            class:bg-pink-900={folder.color === "pink"}
                        >
                            {#if editMode}
                                <TextInput
                                    bind:value={chara.chatFolders[i].name}
                                    className="grow min-w-0"
                                    padding={false}
                                />
                            {:else}
                                <span>{folder.name}</span>
                            {/if}
                            <div class="grow flex justify-end">
                                <div
                                    role="button"
                                    tabindex="0"
                                    onkeydown={(e) => {
                                        if (e.key === "Enter") {
                                            e.currentTarget.click();
                                        }
                                    }}
                                    class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                    onclick={async (e) => {
                                        e.stopPropagation();
                                        // By id, as the delete below: the row's item follows the folder
                                        // list and `chara` the selected character while the dialogs are open.
                                        const chaId = chara.chaId;
                                        const folderId = folder.id;
                                        const sel = parseInt(
                                            await alertSelect([language.changeFolderColor, language.cancel]),
                                        );
                                        switch (sel) {
                                            case 0:
                                                const colors = [
                                                    "red",
                                                    "green",
                                                    "blue",
                                                    "yellow",
                                                    "indigo",
                                                    "purple",
                                                    "pink",
                                                    "default",
                                                ];
                                                const sel = parseInt(await alertSelect(colors));
                                                const owner = characterList().find((entry) => entry?.chaId === chaId);
                                                const target = owner?.chatFolders?.find(
                                                    (entry) => entry.id === folderId,
                                                );
                                                if (target) {
                                                    target.color = colors[sel];
                                                }
                                                break;
                                        }
                                    }}
                                >
                                    <MenuIcon size={18} />
                                </div>
                                <div
                                    role="button"
                                    tabindex="0"
                                    onkeydown={(e) => {
                                        if (e.key === "Enter") {
                                            e.currentTarget.click();
                                        }
                                    }}
                                    class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                    onclick={() => {
                                        editMode = !editMode;
                                    }}
                                >
                                    <PencilIcon size={18} />
                                </div>
                                <div
                                    role="button"
                                    tabindex="0"
                                    onkeydown={(e) => {
                                        if (e.key === "Enter") {
                                            e.currentTarget.click();
                                        }
                                    }}
                                    class="text-textcolor2 hover:text-green-500 cursor-pointer"
                                    onclick={async (e) => {
                                        e.stopPropagation();
                                        // By id: the row's index and item follow the folder list, and
                                        // `chara` the selected character, either of which can change
                                        // while the confirm is open.
                                        const chaId = chara.chaId;
                                        const folderId = folder.id;
                                        const d = await alertConfirm(`${language.removeConfirm}${folder.name}`);
                                        const owner = characterList().find((entry) => entry?.chaId === chaId);
                                        if (d && owner) {
                                            $ReloadGUIPointer += 1;
                                            const folders = owner.chatFolders ?? [];
                                            const index = folders.findIndex((entry) => entry.id === folderId);
                                            if (index !== -1) {
                                                folders.splice(index, 1);
                                            }
                                            for (const chat of chatList(chaId)) {
                                                if (chat.folderId == folderId) {
                                                    setChatMeta({ chaId, chatId: chat.id }, {}, ["folderId"]);
                                                }
                                            }
                                            owner.chatFolders = folders;
                                        }
                                    }}
                                >
                                    <TrashIcon size={18} />
                                </div>
                            </div>
                        </button>
                        <!-- chats in folder -->
                        <div
                            class="risu-chat flex flex-col w-full text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md {folder.folded &&
                            filterQuery === null
                                ? 'hidden'
                                : ''}"
                        >
                            {#if inFolder.length == 0}
                                <span class="no-sort flex justify-center text-textcolor2">Empty</span>
                                <div></div>
                            {:else}
                                {#each inFolder as chat}
                                    <button
                                        data-risu-chat-idx={chats.indexOf(chat)}
                                        onclick={() => {
                                            if (!editMode) {
                                                changeChatTo(chat.id);
                                                $ReloadGUIPointer += 1;
                                            }
                                        }}
                                        class="risu-chats flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
                                        class:bg-selected={chat.id === selectedId}
                                        class:hidden={!chatShown(chat)}
                                    >
                                        {#if editMode}
                                            <TextInput
                                                value={chat.name}
                                                oninput={(e) =>
                                                    setChatMeta(
                                                        { chaId: chara.chaId, chatId: chat.id },
                                                        { name: e.currentTarget.value },
                                                    )}
                                                className="grow min-w-0"
                                                padding={false}
                                            />
                                        {:else}
                                            {#if chat.pinned === true}
                                                <PinIcon size={14} class="mr-1 shrink-0" aria-hidden="true" />
                                            {/if}
                                            <span>{chat.name}</span>
                                            {#if bindingIncomplete(chat)}
                                                <span
                                                    class="ml-1 shrink-0 text-draculared"
                                                    title={language.chatBinding.incomplete}
                                                    data-chat-binding-incomplete
                                                >
                                                    <CircleAlertIcon size={14} />
                                                </span>
                                            {/if}
                                        {/if}
                                        <div class="grow flex justify-end">
                                            <div
                                                role="button"
                                                tabindex="0"
                                                onkeydown={(e) => {
                                                    if (e.key === "Enter") {
                                                        e.currentTarget.click();
                                                    }
                                                }}
                                                class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                                onclick={() => chatOptions(chat)}
                                            >
                                                <MenuIcon size={18} />
                                            </div>
                                            <div
                                                role="button"
                                                tabindex="0"
                                                onkeydown={(e) => {
                                                    if (e.key === "Enter") {
                                                        e.currentTarget.click();
                                                    }
                                                }}
                                                class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                                onclick={() => {
                                                    editMode = !editMode;
                                                }}
                                            >
                                                <PencilIcon size={18} />
                                            </div>
                                            <div
                                                role="button"
                                                tabindex="0"
                                                onkeydown={(e) => {
                                                    if (e.key === "Enter") {
                                                        e.currentTarget.click();
                                                    }
                                                }}
                                                class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                                onclick={async (e) => {
                                                    e.stopPropagation();
                                                    exportChat(chat.id);
                                                }}
                                            >
                                                <DownloadIcon size={18} />
                                            </div>
                                            <div
                                                role="button"
                                                tabindex="0"
                                                onkeydown={(e) => {
                                                    if (e.key === "Enter") {
                                                        e.currentTarget.click();
                                                    }
                                                }}
                                                class="text-textcolor2 hover:text-green-500 cursor-pointer"
                                                onclick={async (e) => {
                                                    e.stopPropagation();
                                                    if (chats.length === 1) {
                                                        alertError(language.errors.onlyOneChat);
                                                        return;
                                                    }
                                                    const ref = { chaId: chara.chaId, chatId: chat.id };
                                                    if (isChatGenerating(ref)) {
                                                        alertError(language.chatGenerating);
                                                        return;
                                                    }
                                                    const d = await alertConfirm(
                                                        `${language.removeConfirm}${chat.name}`,
                                                    );
                                                    if (d) {
                                                        if (isChatGenerating(ref)) {
                                                            alertError(language.chatGenerating);
                                                            return;
                                                        }
                                                        deleteChat(ref);
                                                        $ReloadGUIPointer += 1;
                                                    }
                                                }}
                                            >
                                                <TrashIcon size={18} />
                                            </div>
                                        </div>
                                    </button>
                                {/each}
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
            <!-- chat without folder div -->
            <div class="risu-chat flex flex-col">
                {#each chats as chat, i}
                    <!-- Unfiled: no folder id, or one whose folder does not exist (`chatFolderOf`). -->
                    {#if chatFolderOf(chat, chara.chatFolders) == null}
                        <button
                            data-risu-chat-idx={i}
                            onclick={() => {
                                if (!editMode) {
                                    changeChatTo(chat.id);
                                    $ReloadGUIPointer += 1;
                                }
                            }}
                            class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
                            class:bg-selected={chat.id === selectedId}
                            class:hidden={!chatShown(chat)}
                        >
                            {#if editMode}
                                <TextInput
                                    value={chat.name}
                                    oninput={(e) =>
                                        setChatMeta(
                                            { chaId: chara.chaId, chatId: chat.id },
                                            { name: e.currentTarget.value },
                                        )}
                                    className="grow min-w-0"
                                    padding={false}
                                />
                            {:else}
                                {#if chat.pinned === true}
                                    <PinIcon size={14} class="mr-1 shrink-0" aria-hidden="true" />
                                {/if}
                                <span>{chat.name}</span>
                                {#if bindingIncomplete(chat)}
                                    <span
                                        class="ml-1 shrink-0 text-draculared"
                                        title={language.chatBinding.incomplete}
                                        data-chat-binding-incomplete
                                    >
                                        <CircleAlertIcon size={14} />
                                    </span>
                                {/if}
                            {/if}
                            <div class="grow flex justify-end">
                                <div
                                    role="button"
                                    tabindex="0"
                                    onkeydown={(e) => {
                                        if (e.key === "Enter") {
                                            e.currentTarget.click();
                                        }
                                    }}
                                    class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                    onclick={() => chatOptions(chat)}
                                >
                                    <MenuIcon size={18} />
                                </div>
                                <div
                                    role="button"
                                    tabindex="0"
                                    onkeydown={(e) => {
                                        if (e.key === "Enter") {
                                            e.currentTarget.click();
                                        }
                                    }}
                                    class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                    onclick={() => {
                                        editMode = !editMode;
                                    }}
                                >
                                    <PencilIcon size={18} />
                                </div>
                                <div
                                    role="button"
                                    tabindex="0"
                                    onkeydown={(e) => {
                                        if (e.key === "Enter") {
                                            e.currentTarget.click();
                                        }
                                    }}
                                    class="text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                                    onclick={async (e) => {
                                        e.stopPropagation();
                                        exportChat(chat.id);
                                    }}
                                >
                                    <DownloadIcon size={18} />
                                </div>
                                <div
                                    role="button"
                                    tabindex="0"
                                    onkeydown={(e) => {
                                        if (e.key === "Enter") {
                                            e.currentTarget.click();
                                        }
                                    }}
                                    class="text-textcolor2 hover:text-green-500 cursor-pointer"
                                    onclick={async (e) => {
                                        e.stopPropagation();
                                        if (chats.length === 1) {
                                            alertError(language.errors.onlyOneChat);
                                            return;
                                        }
                                        const ref = { chaId: chara.chaId, chatId: chat.id };
                                        if (isChatGenerating(ref)) {
                                            alertError(language.chatGenerating);
                                            return;
                                        }
                                        const d = await alertConfirm(`${language.removeConfirm}${chat.name}`);
                                        if (d) {
                                            if (isChatGenerating(ref)) {
                                                alertError(language.chatGenerating);
                                                return;
                                            }
                                            deleteChat(ref);
                                            $ReloadGUIPointer += 1;
                                        }
                                    }}
                                >
                                    <TrashIcon size={18} />
                                </div>
                            </div>
                        </button>
                    {/if}
                {/each}
            </div>
        </div>
    {/key}

    <div class="border-t border-selected mt-2">
        <div class="flex mt-2 ml-2 items-center">
            <button
                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                onclick={() => {
                    exportAllChats();
                }}
            >
                <DownloadIcon size={18} />
            </button>
            <button
                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                onclick={() => {
                    importChat();
                }}
            >
                <HardDriveUploadIcon size={18} />
            </button>
            <button
                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                onclick={() => {
                    editMode = !editMode;
                }}
            >
                <PencilIcon size={18} />
            </button>
            <button
                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                onclick={() => {
                    alertStore.set({
                        type: "branches",
                        msg: "",
                    });
                }}
            >
                <SplitIcon size={18} />
            </button>
            <button
                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                onclick={() => {
                    $bookmarkListOpen = true;
                }}
            >
                <BookmarkCheckIcon size={18} />
            </button>
            <button
                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                title={language.messageSearch.open}
                aria-label={language.messageSearch.open}
                data-message-search-open
                onclick={() => {
                    openMessageSearch({ kind: "character", chaId: chara.chaId });
                }}
            >
                <TextSearchIcon size={18} />
            </button>
            <button
                class="ml-auto text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                onclick={() => {
                    if (!chara.chatFolders) {
                        chara.chatFolders = [];
                    }
                    const folders = chara.chatFolders;
                    const length = chara.chatFolders.length;
                    folders.unshift({
                        id: v4(),
                        name: `New Folder ${length + 1}`,
                        folded: false,
                    });
                    chara.chatFolders = folders;
                    $ReloadGUIPointer += 1;
                }}
            >
                <FolderPlusIcon size={18} />
            </button>
        </div>
    </div>
    {#if chara.type === "group"}
        <div class="flex mt-2 items-center">
            <CheckInput bind:check={chara.orderByOrder} name={language.orderByOrder} />
        </div>
    {/if}
</div>
