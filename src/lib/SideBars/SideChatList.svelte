<script lang="ts">
    import { initialChatMemory } from "src/ts/storage/chatMemory.svelte";
    import { type AnyClientCharacter, characterList, findCharacter } from "src/ts/storage/characterStore.svelte";
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
        FolderIcon,
        FolderPlusIcon,
        BookmarkCheckIcon,
        CircleAlertIcon,
        TextSearchIcon,
        ArrowLeftIcon,
    } from "@lucide/svelte";

    import { normalizeChatTrashDays } from "../../../shared/database.ts";
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
    import { confirmTrashChat, deleteChatForever, restoreChat } from "src/ts/checkpoints/chatTrash";
    import { changeChatTo, createChatCopyName } from "src/ts/globalApi.svelte";
    import {
        isActiveChat,
        activeChatList,
        trashedChatList,
        chatTrashRevision,
        type ChatListEntry,
        createChat,
        ensureChatLoaded,
        findChat,
        reorderActiveChats,
        selectedChatId,
        setChatMeta,
    } from "src/ts/storage/chatStore.svelte";
    import { chatSettingsCopy } from "src/ts/storage/chatSettingsCopy";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { chatFolderOf } from "./chatFolders";
    import { matchesAny, prepareQuery } from "src/ts/util/koreanSearch";
    import { openMessageSearch } from "src/ts/messageSearch.svelte";
    import { chatCheckpointsDialog } from "src/ts/checkpoints/chatCheckpoints.svelte";
    import { createInheritingChat } from "src/ts/process/chatMemoryInherit.svelte";

    /**
     * A character's chat list, its chat folders, and its trash view.
     *
     * - An active row action captures the row's chat ref before its first dialog and resolves it again afterward
     *   (`isActiveChat`), never the selection, so a selection change or a reorder meanwhile cannot
     *   redirect it.
     * - Chat structure (create, delete, rename, folder, order) goes through the chat module
     *   (`src/ts/storage/chatStore.svelte.ts`); the folder definitions are the character's `chatFolders`. A new chat
     *   opens through `changeChatTo`; imports go through `importChat` (`src/ts/characters.ts`), where a JSONL import
     *   opens its chat while the importing character is still selected and a JSON or HTML import only adds entries.
     * - A chat whose `folderId` names no folder lists at the root and keeps the id (`chatFolderOf`). A drop writes a
     *   complete chat order while preserving the slots of unlisted rows.
     * - The Korean-aware filter (`prepareQuery`, `matchesAny`) matches active rows by chat or folder name and trash
     *   rows by chat name. Filtering hides active rows in place and shows matching folders open without writing
     *   `folded`. The trash view hides the active list in place. SortableJS keeps its containers and indexes, and
     *   sorting is disabled while the list is filtered or hidden.
     * - Trash rows never select or open a chat. Trash actions capture the character, chat, and trash revision
     *   before any dialog or await. Empty trash captures every trashed chat of the character when pressed.
     *   Switching characters resets the view and filter.
     */

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
    let showTrash = $state(false);
    // A refresh can replace the same character's record. Reset the view only when its id changes.
    const characterId = $derived(chara.chaId);
    /** The character's chats as list entries (the chat module's; never whole chats). */
    const chats = $derived(activeChatList(characterId));
    const selectedId = $derived(selectedChatId(characterId));
    const trashedChats = $derived(trashedChatList(characterId).sort((a, b) => b.trashedAt - a.trashedAt));
    const retentionDays = $derived(normalizeChatTrashDays(settings.ui.chatTrashDays));

    let filterText = $state("");
    const filterQuery = $derived(prepareQuery(filterText));
    const listedTrash = $derived(
        filterQuery === null ? trashedChats : trashedChats.filter((chat) => matchesAny([chat.name], filterQuery)),
    );
    const sortingDisabled = $derived(showTrash || filterQuery !== null);
    $effect.pre(() => {
        void characterId;
        untrack(() => {
            filterText = "";
            showTrash = false;
        });
    });

    const DAY_MS = 86_400_000;
    let now = $state(Date.now());
    $effect(() => {
        if (!showTrash) return;
        now = Date.now();
        const timer = setInterval(() => (now = Date.now()), 60_000);
        return () => clearInterval(timer);
    });

    function restoreTrashedChat(chatId: string) {
        const ref = { chaId: characterId, chatId };
        const revision = chatTrashRevision(ref);
        return restoreChat(ref, revision);
    }

    async function permanentlyDeleteChat(chat: ChatListEntry) {
        const ref = { chaId: characterId, chatId: chat.id };
        const revision = chatTrashRevision(ref);
        if (await alertConfirm(language.chatTrash.confirmDeleteForever(chat.name))) {
            await deleteChatForever(ref, revision);
        }
    }

    async function emptyTrash() {
        const chaId = characterId;
        const targets = trashedChats.map((chat) => {
            const ref = { chaId, chatId: chat.id };
            return { ref, name: chat.name, revision: chatTrashRevision(ref) };
        });
        if (targets.length === 0 || !(await alertConfirm(language.chatTrash.confirmEmptyTrash(targets.length)))) return;

        const failed: string[] = [];
        for (const { ref, name, revision } of targets) {
            if (!(await deleteChatForever(ref, revision))) failed.push(name);
        }
        // The client queues its own errors. Queue the combined summary after all of them.
        if (failed.length > 0) alertError(language.chatTrash.emptyTrashFailed(failed));
    }

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

    /** The messages a new chat of `owner` starts with: each member's first message in a group, none otherwise. */
    function openingMessages(owner: DeepReadonly<AnyClientCharacter>): Chat["message"] {
        if (owner.type !== "group") {
            return [];
        }
        return owner.characters.map((member) => ({
            saying: member,
            role: "char" as const,
            data: findCharacterbyId(member).firstMessage,
        }));
    }

    /**
     * A chat row's options: copy the chat, copy only its settings into a chat without the conversation
     * (`chatSettingsCopy`), open its binding (chat settings), or its checkpoints. The chat (and its character) are
     * captured before the dialogs, so a selection change or a reorder meanwhile cannot redirect them. A copy is
     * selected in the list, never opened.
     */
    async function chatOptions(entry: ChatListEntry) {
        const ref = { chaId: chara.chaId, chatId: entry.id };
        const option = await alertChatOptions();
        switch (option) {
            case 0: {
                const source = await chatCopySource(ref);
                if (!source || !isActiveChat(ref)) {
                    break;
                }
                delete source.pinned;
                createInheritingChat(
                    ref,
                    { ...source, name: createChatCopyName(source.name, "Copy", ref.chaId), id: v4() },
                    { index: 0, select: true },
                );
                break;
            }
            case 1: {
                const source = await chatCopySource(ref);
                const owner = findCharacter(ref.chaId);
                if (!source || !owner || !isActiveChat(ref)) {
                    break;
                }
                // Plain `createChat`: the source's memory records describe a conversation this chat does not have.
                createChat(
                    ref.chaId,
                    {
                        ...chatSettingsCopy(source, createChatCopyName(source.name, "Settings", ref.chaId), v4()),
                        message: openingMessages(owner),
                    },
                    { index: 0, select: true },
                );
                break;
            }
            case 2: {
                // The binding is in the list entry, so a chat that is not loaded opens too.
                if (isActiveChat(ref)) {
                    chatBindingDialog.set(ref);
                }
                break;
            }
            case 3: {
                if (isActiveChat(ref)) {
                    chatCheckpointsDialog.set(ref);
                }
                break;
            }
        }
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
        const disabled = sortingDisabled;
        for (let chat of listEle.querySelectorAll(".risu-chat")) {
            chatsStb.push(
                new Sortable(chat, {
                    group: "chats",
                    disabled,
                    onEnd: async (event) => {
                        // Resolve the dragged rows by id even if membership changed during the drag.
                        const listed = new Map(chats.map((chat) => [chat.id, chat]));
                        const folders = chara.chatFolders;
                        const newChats: string[] = [];

                        listEle.querySelectorAll("[data-risu-chat-folder-idx]").forEach((folder) => {
                            const folderIdx = parseInt(folder.getAttribute("data-risu-chat-folder-idx"));
                            folder.querySelectorAll("[data-risu-chat-idx]").forEach((chatInFolder) => {
                                const newChat = listed.get(chatInFolder.getAttribute("data-risu-chat-id"));
                                if (!newChat) return;
                                if (newChat.folderId !== folders[folderIdx].id) {
                                    setChatFolder(newChat, folders[folderIdx].id);
                                }
                                newChats.push(newChat.id);
                            });
                        });

                        listEle.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
                            const newChat = listed.get(chatEle.getAttribute("data-risu-chat-id"));
                            if (!newChat) return;
                            if (newChats.includes(newChat.id) == false) {
                                // A root row leaves its folder; a dangling id (already unfiled) is not written.
                                if (chatFolderOf(newChat, folders) != null) {
                                    setChatFolder(newChat, null);
                                }
                                newChats.push(newChat.id);
                            }
                        });

                        // The selected chat stays selected (the selection is by id).
                        reorderActiveChats(chara.chaId, newChats);

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
                const newFolders: ChatFolder[] = [];
                const newChats: string[] = [];
                const folders: HTMLElement[] = Array.from<HTMLElement>(event.to.children);

                folders.forEach((folder) => {
                    const folderIdx = parseInt(folder.getAttribute("data-risu-chat-folder-idx"));
                    newFolders.push(chara.chatFolders[folderIdx]);

                    folder.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
                        const id = chatEle.getAttribute("data-risu-chat-id");
                        if (id) newChats.push(id);
                    });
                });

                listEle.querySelectorAll("[data-risu-chat-idx]").forEach((chatEle) => {
                    const id = chatEle.getAttribute("data-risu-chat-id");
                    if (id && !newChats.includes(id)) {
                        newChats.push(id);
                    }
                });

                chara.chatFolders = newFolders;
                reorderActiveChats(chara.chaId, newChats);
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
        const disabled = sortingDisabled;
        for (const stb of [...chatsStb, folderStb]) {
            stb?.option("disabled", disabled);
        }
    });

    onDestroy(destroyStb);
</script>

<div class="flex flex-col w-full h-[calc(100%-2rem)] max-h-[calc(100%-2rem)]">
    {#if !showTrash}
        <Button
            className="relative bottom-2"
            onclick={() => {
                const cha = chara;
                const len = chats.length;
                const newChat: Chat = {
                    // Read before the chat is created: it becomes the selected chat.
                    ...initialChatBinding(cha.chaId),
                    ...initialChatMemory(cha.chaId),
                    ...initialChatTranslation(cha.chaId),
                    ...initialChatToggles(cha.chaId),
                    message: openingMessages(cha),
                    note: "",
                    name: `New Chat ${len + 1}`,
                    localLore: [],
                    fmIndex: -1,
                    id: v4(),
                };
                createChat(cha.chaId, newChat, { index: 0, select: true });
                changeChatTo(0);
                $ReloadGUIPointer += 1;
            }}>{language.newChat}</Button
        >
    {/if}
    <TextInput placeholder={language.search} bind:value={filterText} size="sm" fullwidth={true} />

    {#key sorted}
        <!-- Stretched over the sidebar's side padding so the scrollbar sits at the sidebar's edge. -->
        <div
            class="flex-col mt-2 overflow-y-auto grow -mr-(--sidebar-gutter) pr-(--sidebar-gutter)"
            class:flex={!showTrash}
            class:hidden={showTrash}
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
                                    onclick={(e) => {
                                        e.stopPropagation();
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
                                            for (const chat of activeChatList(chaId)) {
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
                                        data-risu-chat-id={chat.id}
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
                                                onclick={(e) => {
                                                    e.stopPropagation();
                                                    chatOptions(chat);
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
                                                onclick={(e) => {
                                                    e.stopPropagation();
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
                                                    await confirmTrashChat(
                                                        { chaId: chara.chaId, chatId: chat.id },
                                                        chat.name,
                                                    );
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
                            data-risu-chat-id={chat.id}
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
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        chatOptions(chat);
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
                                    onclick={(e) => {
                                        e.stopPropagation();
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
                                        await confirmTrashChat({ chaId: chara.chaId, chatId: chat.id }, chat.name);
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

    {#if showTrash}
        <div class="flex flex-col gap-2 mt-2 overflow-y-auto grow -mr-(--sidebar-gutter) pr-(--sidebar-gutter)">
            <div class="flex items-center gap-2">
                <button
                    type="button"
                    class="p-2 rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor cursor-pointer"
                    title={language.goback}
                    aria-label={language.goback}
                    onclick={() => (showTrash = false)}
                >
                    <ArrowLeftIcon size={18} aria-hidden="true" />
                </button>
                <h2 class="text-lg font-semibold text-textcolor">{language.chatTrash.title(trashedChats.length)}</h2>
            </div>
            <p class="text-sm text-textcolor2">{language.chatTrash.retention(retentionDays)}</p>
            <ul class="flex flex-col gap-2">
                {#each listedTrash as chat (chat.id)}
                    {@const folder = chatFolderOf(chat, chara.chatFolders)}
                    {@const trashedAt = new Date(chat.trashedAt)}
                    {@const daysLeft = Math.max(0, Math.ceil((chat.trashedAt + retentionDays * DAY_MS - now) / DAY_MS))}
                    <li class="flex flex-col gap-1 p-2 rounded-md border border-darkborderc text-textcolor">
                        <div class="break-any">{chat.name}</div>
                        {#if folder}
                            <div class="flex items-center gap-1 text-sm text-textcolor2">
                                <FolderIcon size={14} class="shrink-0" aria-hidden="true" />
                                <span class="break-any">{folder.name}</span>
                            </div>
                        {/if}
                        <time class="text-sm text-textcolor2" datetime={trashedAt.toISOString()}>
                            {trashedAt.toLocaleString()}
                        </time>
                        <span class="text-sm text-textcolor2">{language.chatTrash.daysLeft(daysLeft)}</span>
                        <div class="flex flex-wrap gap-2 mt-1">
                            <Button styled="outlined" size="sm" onclick={() => restoreTrashedChat(chat.id)}>
                                {language.chatTrash.restore}
                            </Button>
                            <Button
                                styled="outlined"
                                size="sm"
                                className="hover:text-danger-500"
                                onclick={() => permanentlyDeleteChat(chat)}
                            >
                                {language.chatTrash.deleteForever}
                            </Button>
                        </div>
                    </li>
                {/each}
            </ul>
            <Button
                styled="outlined"
                size="sm"
                className="mt-auto self-start enabled:hover:text-danger-500"
                disabled={trashedChats.length === 0}
                onclick={emptyTrash}
            >
                {language.chatTrash.emptyTrash}
            </Button>
        </div>
    {/if}

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
                        chaId: chara.chaId,
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
                type="button"
                class="flex items-center gap-1 text-textcolor2 hover:text-textcolor mr-2 cursor-pointer"
                title={language.chatTrash.open}
                aria-label={language.chatTrash.open}
                onclick={() => (showTrash = true)}
            >
                <TrashIcon size={18} aria-hidden="true" />
                {#if trashedChats.length > 0}
                    <span class="rounded-full bg-selected px-1 text-xs text-textcolor">{trashedChats.length}</span>
                {/if}
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
