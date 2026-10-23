<script lang="ts">
    import { selectCharacter, selection } from "src/ts/storage/selection.svelte";
    import { selectedCharacter, characterList } from "src/ts/storage/characterStore.svelte";
    import { chatList, selectedChatId } from "src/ts/storage/chatStore.svelte";
    import {
        chatStatusKey,
        generatingChatKeys,
        recoveryChatKeys,
        unseenChatKeys,
    } from "src/ts/process/chatStatus.svelte";
    import { summarizingChats } from "src/ts/process/memoryTasks.svelte";
    import { refusedItems } from "src/ts/storage/resourceSync.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import {
        CharEmotion,
        DynamicGUI,
        botMakerMode,
        settingsOpen,
        sideBarClosing,
        sideBarStore,
        OpenRealmStore,
        PlaygroundStore,
        additionalHamburgerMenu,
    } from "../../ts/stores.svelte";
    import type { folder } from "../../ts/storage/database.svelte";
    import BarIcon from "./BarIcon.svelte";
    import SidebarIndicator from "./SidebarIndicator.svelte";
    import {
        ShellIcon,
        Settings,
        ListIcon,
        LayoutGridIcon,
        FolderIcon,
        FolderOpenIcon,
        HomeIcon,
        WrenchIcon,
        User2Icon,
    } from "@lucide/svelte";
    import { addCharacter, changeChar } from "../../ts/characters";
    import CharConfig from "./CharConfig.svelte";
    import { language } from "../../lang";
    import isEqual from "lodash/isEqual";
    import SidebarAvatar from "./SidebarAvatar.svelte";
    import LazyCharImage from "../UI/GUI/LazyCharImage.svelte";
    import BaseRoundedButton from "../UI/BaseRoundedButton.svelte";
    import { getCharacterIndexObject, selectSingleFile } from "src/ts/util";
    import { v4 } from "uuid";
    import { checkCharOrder, openPinnedChat, saveAsset } from "src/ts/globalApi.svelte";
    import { alertInput, alertSelect } from "src/ts/alert";
    import SideChatList from "./SideChatList.svelte";
    import PinnedChatsRail from "./PinnedChatsRail.svelte";
    import { collectPinnedChats } from "./pinnedChats";
    import ChatStatusBadge from "./ChatStatusBadge.svelte";
    import {
        chatStatusLabel,
        collectCharacterStatuses,
        collectMemoryProgress,
        folderStatus,
        groupMemoryCount,
        resolveChatStatus,
        refusedChatKeys,
        type ChatStatus,
        type MemoryCount,
    } from "./chatStatus";
    import OpenChatPanel from "./OpenChatPanel.svelte";
    import { sideBarSize } from "src/ts/gui/guisize";
    import DevTool from "./DevTool.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import { RISU_SIDEBAR_DRAG_TYPE } from "src/ts/dragTypes";

    const currentCharacter = $derived(selectedCharacter());
    const pinnedChats = $derived(
        collectPinnedChats(characterList(), settings.characterOrder, chatList, language.unnamedPinnedChat),
    );
    const summarizing = $derived(summarizingChats());
    const statusSets = $derived({
        recovery: $recoveryChatKeys,
        refused: refusedChatKeys(refusedItems()),
        generating: generatingChatKeys(),
        memory: summarizing,
        unseen: $unseenChatKeys,
    });
    const characterStatuses = $derived(collectCharacterStatuses(statusSets));
    const memoryProgress = $derived(collectMemoryProgress(summarizing));
    const pinnedStatuses = $derived.by(() => {
        const statuses = new Map<string, ChatStatus>();
        for (const item of pinnedChats) {
            const key = chatStatusKey(item);
            const status = resolveChatStatus(statusSets, key);
            if (status) {
                statuses.set(key, status);
            }
        }
        return statuses;
    });
    /** A character's or folder's memory count, only when memory is the status it shows. */
    function memoryCountOf(status: ChatStatus | null, chaIds: readonly string[]): MemoryCount | null {
        return status === "memory" ? groupMemoryCount(memoryProgress, chaIds) : null;
    }
    let sideBarMode = $state(0);
    let editMode = $state(false);
    let menuMode = $state(0);
    let devTool = $state(false);

    function reseter() {
        menuMode = 0;
        sideBarMode = 0;
        editMode = false;
        settingsOpen.set(false);
        CharEmotion.set({});
    }

    type sortTypeNormal = { type: "normal"; img: string; chaId: string; name: string; orderIndex: number };
    type sortType =
        | sortTypeNormal
        | {
              type: "folder";
              folder: sortTypeNormal[];
              id: string;
              name: string;
              color: string;
              img?: string;
              orderIndex: number;
          };
    let charImages: sortType[] = $state([]);
    let IconRounded = $state(false);
    let openFolders: string[] = $state([]);
    let currentDrag: DragData | null = $state(null);
    interface Props {
        openGrid?: any;
        hidden?: boolean;
    }

    let { openGrid = () => {}, hidden = false }: Props = $props();

    sideBarClosing.set(false);

    $effect(() => {
        let newCharImages: sortType[] = [];
        const idObject = getCharacterIndexObject();
        // Keep persisted positions: hidden ids still occupy root and folder slots.
        for (const [orderIndex, id] of settings.characterOrder.entries()) {
            if (typeof id === "string") {
                const index = Object.hasOwn(idObject, id) ? idObject[id] : -1;
                if (index !== -1) {
                    const cha = characterList()[index];
                    if (cha.trashTime) continue;
                    newCharImages.push({
                        img: cha.image ?? "",
                        chaId: cha.chaId,
                        type: "normal",
                        name: cha.name,
                        orderIndex,
                    });
                }
            } else {
                const folder = id;
                let folderCharImages: sortTypeNormal[] = [];
                for (const [orderIndex, id] of folder.data.entries()) {
                    const index = Object.hasOwn(idObject, id) ? idObject[id] : -1;
                    if (index !== -1) {
                        const cha = characterList()[index];
                        if (cha.trashTime) continue;
                        folderCharImages.push({
                            img: cha.image ?? "",
                            chaId: cha.chaId,
                            type: "normal",
                            name: cha.name,
                            orderIndex,
                        });
                    }
                }
                newCharImages.push({
                    folder: folderCharImages,
                    type: "folder",
                    id: folder.id,
                    name: folder.name,
                    color: folder.color,
                    img: folder.imgFile,
                    orderIndex,
                });
            }
        }
        if (!isEqual(charImages, newCharImages)) {
            charImages = newCharImages;
        }
        if (IconRounded !== settings.ui.roundIcons) {
            IconRounded = settings.ui.roundIcons;
        }
    });

    const inserter = (mainIndex: DragData, targetIndex: DragData) => {
        if (mainIndex.index === targetIndex.index && mainIndex.folder === targetIndex.folder) {
            return;
        }
        const order = settings.characterOrder;
        let mainFolderIndex = mainIndex.folder ? getFolderIndex(mainIndex.folder) : null;
        let targetFolderIndex = targetIndex.folder ? getFolderIndex(targetIndex.folder) : null;
        let mainFolderId = mainIndex.folder ? (order[mainFolderIndex] as folder).id : "";
        let movingFolder: folder | false = false;
        let mainId = "";
        if (mainIndex.folder) {
            mainId = (order[mainFolderIndex] as folder).data[mainIndex.index];
        } else {
            const da = order[mainIndex.index];
            if (typeof da !== "string") {
                mainId = da.id;
                movingFolder = $state.snapshot(da);
                if (targetIndex.folder) {
                    return;
                }
            } else {
                mainId = da;
            }
        }
        if (targetIndex.folder) {
            const folder = order[targetFolderIndex] as folder;
            folder.data.splice(targetIndex.index, 0, mainId);
            order[targetFolderIndex] = folder;
        } else if (movingFolder) {
            order.splice(targetIndex.index, 0, movingFolder);
        } else {
            order.splice(targetIndex.index, 0, mainId);
        }
        if (mainIndex.folder) {
            mainFolderIndex = -1;
            for (let i = 0; i < order.length; i++) {
                const a = order[i];
                if (typeof a !== "string") {
                    if (a.id === mainFolderId) {
                        mainFolderIndex = i;
                        break;
                    }
                }
            }
            if (mainFolderIndex !== -1) {
                const folder: folder = order[mainFolderIndex] as folder;
                const ind =
                    mainIndex.index > targetIndex.index ? folder.data.lastIndexOf(mainId) : folder.data.indexOf(mainId);
                if (ind !== -1) {
                    folder.data.splice(ind, 1);
                }
                order[mainFolderIndex] = folder;
            } else {
                console.log("folder not found");
            }
        } else if (movingFolder) {
            let idList: string[] = [];
            for (const ord of order) {
                idList.push(typeof ord === "string" ? ord : ord.id);
            }
            const ind = mainIndex.index > targetIndex.index ? idList.lastIndexOf(mainId) : idList.indexOf(mainId);
            if (ind !== -1) {
                order.splice(ind, 1);
            }
        } else {
            const ind = mainIndex.index > targetIndex.index ? order.lastIndexOf(mainId) : order.indexOf(mainId);
            if (ind !== -1) {
                order.splice(ind, 1);
            }
        }

        settings.characterOrder = order;
        checkCharOrder();
    };

    /** The folder with `id` in the character order (its wrapper), found now; `undefined` once it is gone. */
    function folderById(id: string): folder | undefined {
        const index = getFolderIndex(id);
        return index === -1 ? undefined : (settings.characterOrder[index] as folder);
    }

    function getFolderIndex(id: string) {
        for (let i = 0; i < settings.characterOrder.length; i++) {
            const data = settings.characterOrder[i];
            if (typeof data !== "string" && data.id === id) {
                return i;
            }
        }
        return -1;
    }

    function scrollToActiveCharacter() {
        const characterId = selectedCharacter()?.chaId;
        if (!characterId) return;

        let targetFolderId: string | null = null;

        for (const item of charImages) {
            if (item.type === "folder") {
                const foundChar = item.folder.find((c) => c.chaId === characterId);
                if (foundChar) {
                    targetFolderId = item.id;
                    break;
                }
            }
        }

        if (targetFolderId && !openFolders.includes(targetFolderId)) {
            openFolders.push(targetFolderId);
            openFolders = openFolders;
        }

        setTimeout(() => {
            const activeElement = document.querySelector(`[data-char-id="${characterId}"]`);
            if (activeElement) {
                activeElement.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                });
            }
        }, 100);
    }

    $effect(() => {
        if (typeof window === "undefined") return;

        const handler = () => {
            scrollToActiveCharacter();
        };

        window.addEventListener("scrollToActiveCharacter", handler);

        return () => {
            window.removeEventListener("scrollToActiveCharacter", handler);
        };
    });

    const createFolder = (mainIndex: DragData, targetIndex: DragData) => {
        if (mainIndex.index === targetIndex.index && mainIndex.folder === targetIndex.folder) {
            return;
        }
        const order = settings.characterOrder;
        let mainFolderIndex = mainIndex.folder ? getFolderIndex(mainIndex.folder) : null;
        let mainFolder = order[mainFolderIndex] as folder;
        if (targetIndex.folder) {
            return;
        }
        const main = mainIndex.folder ? mainFolder.data[mainIndex.index] : order[mainIndex.index];
        const target = order[targetIndex.index];
        if (typeof main !== "string") {
            return;
        }
        if (typeof target === "string") {
            const newFolder: folder = {
                name: "New Folder",
                data: [main, target],
                color: "",
                id: v4(),
            };
            order[targetIndex.index] = newFolder;
            if (mainIndex.folder) {
                mainFolder.data.splice(mainIndex.index, 1);
                order[mainFolderIndex] = mainFolder;
            } else {
                order.splice(mainIndex.index, 1);
            }
        } else {
            target.data.push(main);
            if (mainIndex.folder) {
                mainFolder.data.splice(mainIndex.index, 1);
                order[mainFolderIndex] = mainFolder;
            } else {
                order.splice(mainIndex.index, 1);
            }
        }

        settings.characterOrder = order;
        checkCharOrder();
    };

    type DragEv = DragEvent & {
        currentTarget: EventTarget & HTMLDivElement;
    };
    type DragData = {
        index: number;
        folder?: string;
    };
    const avatarDragStart = (ind: DragData, e: DragEv) => {
        e.dataTransfer.setData("text/plain", "");
        e.dataTransfer.setData(RISU_SIDEBAR_DRAG_TYPE, "true");
        currentDrag = ind;
        const avatar = e.currentTarget.querySelector(".avatar");
        if (avatar) {
            e.dataTransfer.setDragImage(avatar, 10, 10);
        }
    };

    const clearCurrentDrag = () => {
        currentDrag = null;
    };

    $effect(() => {
        if (typeof window === "undefined") return;

        window.addEventListener("dragend", clearCurrentDrag);
        window.addEventListener("drop", clearCurrentDrag);
        window.addEventListener("blur", clearCurrentDrag);

        return () => {
            window.removeEventListener("dragend", clearCurrentDrag);
            window.removeEventListener("drop", clearCurrentDrag);
            window.removeEventListener("blur", clearCurrentDrag);
        };
    });

    const getCurrentSidebarDrag = (e: DragEvent) => {
        if (!currentDrag || !e.dataTransfer?.types.includes(RISU_SIDEBAR_DRAG_TYPE)) {
            return null;
        }
        return currentDrag;
    };

    const avatarDragOver = (e: DragEv) => {
        if (!getCurrentSidebarDrag(e)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
    };

    const avatarDrop = (ind: DragData, e: DragEv) => {
        const drag = getCurrentSidebarDrag(e);
        if (!drag) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        try {
            createFolder(drag, ind);
        } catch (error) {
            console.error("avatarDrop error:", error);
        } finally {
            clearCurrentDrag();
        }
    };

    const preventAll = (e: DragEvent) => {
        if (!getCurrentSidebarDrag(e)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        return false;
    };
</script>

{#if settings.ui.menuSideBar}
    <div
        class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
        class:editMode
        class:risu-sub-sidebar={$sideBarClosing}
        class:risu-sub-sidebar-close={$sideBarClosing}
        class:hidden
        class:flex={!hidden}
    >
        <button
            class="flex items-center justify-center py-2 flex-col gap-1 w-full mt-4"
            class:text-textcolor2={!(currentCharacter === undefined && $PlaygroundStore === 0 && !$settingsOpen)}
            onclick={() => {
                reseter();
                selectCharacter(null);
                PlaygroundStore.set(0);
                OpenRealmStore.set(false);
            }}
        >
            <HomeIcon />
            <span class="text-xs">{language.home}</span>
        </button>
        <button
            class="flex items-center justify-center py-2 flex-col gap-1 w-full"
            class:text-textcolor2={!$settingsOpen}
            onclick={() => {
                if ($settingsOpen) {
                    reseter();
                    settingsOpen.set(false);
                } else {
                    reseter();
                    settingsOpen.set(true);
                }
            }}
        >
            <Settings />
            <span class="text-xs">{language.settings}</span>
        </button>
        <button
            class="flex items-center justify-center py-2 flex-col gap-1 w-full"
            class:text-textcolor2={!(currentCharacter !== undefined)}
            onclick={() => {
                reseter();
                openGrid();
            }}
        >
            <User2Icon />
            <span class="text-xs">{language.character}</span>
        </button>
        <button
            class="flex items-center justify-center py-2 flex-col gap-1 w-full"
            class:text-textcolor2={!(currentCharacter === undefined && $PlaygroundStore !== 0)}
            onclick={() => {
                reseter();
                selectCharacter(null);
                PlaygroundStore.set(1);
            }}
        >
            <ShellIcon />
            <span class="text-xs">{language.playground.playground}</span>
        </button>
        <PinnedChatsRail
            items={pinnedChats}
            statuses={pinnedStatuses}
            memoryCounts={summarizing}
            selectedChaId={selection.chatOpen ? selection.characterId : null}
            selectedChatId={selection.characterId ? selectedChatId(selection.characterId) : null}
            rounded={IconRounded}
            onOpen={(item) => openPinnedChat(item, reseter)}
        />
    </div>
{:else}
    <div
        class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
        class:editMode
        class:risu-sub-sidebar={$sideBarClosing}
        class:risu-sub-sidebar-close={$sideBarClosing}
        class:hidden
        class:flex={!hidden}
    >
        {#if !settings.ui.hamburgerButtonBottom}
            <button
                class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-blue-500"
                onclick={() => {
                    menuMode = 1 - menuMode;
                }}
                ><ListIcon />
            </button>
            <div class="mt-2 border-b border-b-selected w-full relative text-white">
                {#if menuMode === 1}
                    <div
                        class="absolute w-20 min-w-20 flex border-b-selected border-b bg-bgcolor flex-col items-center pt-2 rounded-b-md z-20 pb-2"
                    >
                        <BarIcon
                            onClick={() => {
                                if ($settingsOpen) {
                                    reseter();
                                    settingsOpen.set(false);
                                } else {
                                    reseter();
                                    settingsOpen.set(true);
                                }
                            }}><Settings /></BarIcon
                        >
                        <div class="mt-2"></div>
                        <BarIcon
                            onClick={() => {
                                reseter();
                                selectCharacter(null);
                                PlaygroundStore.set(0);
                                OpenRealmStore.set(false);
                            }}><HomeIcon /></BarIcon
                        >
                        <div class="mt-2"></div>
                        <BarIcon
                            onClick={() => {
                                reseter();
                                if (currentCharacter === undefined && $PlaygroundStore !== 0) {
                                    PlaygroundStore.set(0);
                                    return;
                                }
                                selectCharacter(null);
                                PlaygroundStore.set(1);
                            }}><ShellIcon /></BarIcon
                        >
                        {#each additionalHamburgerMenu as menu}
                            <div class="mt-2"></div>
                            <BarIcon
                                onClick={() => {
                                    reseter();
                                    menu.callback();
                                }}
                            >
                                <PluginDefinedIcon ico={menu} />
                            </BarIcon>
                        {/each}
                        <div class="mt-2"></div>
                        <BarIcon
                            onClick={() => {
                                reseter();
                                openGrid();
                            }}><LayoutGridIcon /></BarIcon
                        >
                    </div>
                {/if}
            </div>
        {/if}
        <PinnedChatsRail
            items={pinnedChats}
            statuses={pinnedStatuses}
            memoryCounts={summarizing}
            selectedChaId={selection.chatOpen ? selection.characterId : null}
            selectedChatId={selection.characterId ? selectedChatId(selection.characterId) : null}
            rounded={IconRounded}
            onOpen={(item) => openPinnedChat(item, reseter)}
        />
        <div class="flex grow w-full flex-col items-center overflow-x-hidden overflow-y-auto pr-0">
            <div
                class="h-4 min-h-4 w-14"
                role="listitem"
                ondragover={(e) => {
                    if (!getCurrentSidebarDrag(e)) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    e.currentTarget.classList.add("bg-green-500");
                }}
                ondragleave={(e) => {
                    e.currentTarget.classList.remove("bg-green-500");
                }}
                ondrop={(e) => {
                    const drag = getCurrentSidebarDrag(e);
                    if (!drag) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.classList.remove("bg-green-500");
                    try {
                        inserter(drag, { index: 0 });
                    } finally {
                        clearCurrentDrag();
                    }
                }}
                ondragenter={preventAll}
            ></div>
            {#each charImages as char}
                {@const status =
                    char.type === "normal"
                        ? (characterStatuses.get(char.chaId) ?? null)
                        : !openFolders.includes(char.id)
                          ? folderStatus(
                                characterStatuses,
                                char.folder.map((member) => member.chaId),
                            )
                          : null}
                {@const statusCount = memoryCountOf(
                    status,
                    char.type === "normal" ? [char.chaId] : char.folder.map((member) => member.chaId),
                )}
                {@const statusLabel = status ? chatStatusLabel(status, char.name, statusCount) : ""}
                {@const name = status ? `${char.name} · ${statusLabel}` : char.name}
                <div
                    class="group relative flex items-center px-2"
                    role="listitem"
                    draggable="true"
                    ondragstart={(e) => {
                        avatarDragStart({ index: char.orderIndex }, e);
                    }}
                    ondragend={clearCurrentDrag}
                    ondragover={avatarDragOver}
                    ondrop={(e) => {
                        avatarDrop({ index: char.orderIndex }, e);
                    }}
                    ondragenter={preventAll}
                >
                    <SidebarIndicator
                        isActive={char.type === "normal" && currentCharacter?.chaId === char.chaId && sideBarMode !== 1}
                    />
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                    <div
                        class="relative"
                        role="button"
                        tabindex="0"
                        aria-label={status ? name : undefined}
                        data-risu-chat-status={status ?? undefined}
                        onclick={() => {
                            if (char.type === "normal") {
                                changeChar(char.chaId, { reseter });
                            }
                        }}
                        onkeydown={(e) => {
                            if (e.key === "Enter") {
                                if (char.type === "normal") {
                                    changeChar(char.chaId, { reseter });
                                }
                            }
                        }}
                    >
                        {#if char.type === "normal"}
                            <LazyCharImage path={char.img ?? ""} type="plain" thumb={256}>
                                {#snippet children(image)}
                                    <SidebarAvatar
                                        src={char.img ? image : "/none.webp"}
                                        size="56"
                                        rounded={IconRounded}
                                        {name}
                                        chaId={char.chaId}
                                    />
                                {/snippet}
                            </LazyCharImage>
                        {:else if char.type === "folder"}
                            <LazyCharImage path={char.img ?? ""} type="plain" thumb={256}>
                                {#snippet children(image)}
                                    {#key char.color}
                                        {#key char.name}
                                            <SidebarAvatar
                                                src="slot"
                                                size="56"
                                                rounded={IconRounded}
                                                bordered
                                                {name}
                                                color={char.color}
                                                backgroundimg={char.img ? image : ""}
                                                oncontextmenu={async (e) => {
                                                    e.preventDefault();
                                                    // The folder this menu was opened for (the row can move during the dialogs).
                                                    const folderId = char.id;
                                                    const folderName = char.name;
                                                    const sel = parseInt(
                                                        await alertSelect([
                                                            language.renameFolder,
                                                            language.changeFolderColor,
                                                            language.changeFolderImage,
                                                            language.cancel,
                                                        ]),
                                                    );
                                                    if (sel === 0) {
                                                        const v = await alertInput(
                                                            language.changeFolderName,
                                                            [],
                                                            folderName,
                                                        );
                                                        if (v) {
                                                            const oder = folderById(folderId);
                                                            if (!oder) {
                                                                return;
                                                            }
                                                            oder.name = v;
                                                        }
                                                    } else if (sel === 1) {
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
                                                        const oder = folderById(folderId);
                                                        if (!oder) {
                                                            return;
                                                        }
                                                        oder.color = colors[sel].toLocaleLowerCase();
                                                    } else if (sel === 2) {
                                                        const sel = parseInt(
                                                            await alertSelect([
                                                                "Reset to Default Image",
                                                                "Select Image File",
                                                            ]),
                                                        );
                                                        const oder = folderById(folderId);
                                                        if (!oder) {
                                                            return;
                                                        }

                                                        switch (sel) {
                                                            case 0:
                                                                oder.imgFile = null;
                                                                oder.img = "";
                                                                break;

                                                            case 1:
                                                                const folderImage = await selectSingleFile([
                                                                    "png",
                                                                    "jpg",
                                                                    "webp",
                                                                ]);

                                                                if (!folderImage) {
                                                                    return;
                                                                }

                                                                const folderImageData = await saveAsset(
                                                                    folderImage.data,
                                                                );
                                                                // Found again: the folder can be removed during the dialog and the save.
                                                                const target = folderById(folderId);
                                                                if (!target) {
                                                                    return;
                                                                }
                                                                target.imgFile = folderImageData;
                                                                // Shown from `imgFile`; a resolved URL is page-local.
                                                                target.img = "";
                                                                break;
                                                        }
                                                    }
                                                }}
                                                onClick={() => {
                                                    if (char.type !== "folder") {
                                                        return;
                                                    }
                                                    if (openFolders.includes(char.id)) {
                                                        openFolders.splice(openFolders.indexOf(char.id), 1);
                                                    } else {
                                                        openFolders.push(char.id);
                                                    }
                                                    openFolders = openFolders;
                                                }}
                                            >
                                                {#if settings.ui.showFolderName}
                                                    <div class="h-full w-full flex justify-center items-center">
                                                        <span class="hyphens-auto truncate font-bold">{char.name}</span>
                                                    </div>
                                                {:else if openFolders.includes(char.id)}
                                                    <FolderOpenIcon />
                                                {:else}
                                                    <FolderIcon />
                                                {/if}
                                            </SidebarAvatar>
                                        {/key}
                                    {/key}
                                {/snippet}
                            </LazyCharImage>
                        {/if}
                        {#if status}
                            <ChatStatusBadge {status} label={statusLabel} count={statusCount} />
                        {/if}
                    </div>
                </div>
                {#if char.type === "folder" && openFolders.includes(char.id)}
                    {#key char.color}
                        <div class="p-1 flex flex-col items-center py-1 mt-1 rounded-lg relative">
                            <div
                                class="absolute top-0 left-1 border border-selected w-full h-full rounded-lg z-0 {char.color ===
                                'red'
                                    ? 'bg-red-700/20'
                                    : char.color === 'yellow'
                                      ? 'bg-yellow-700/20'
                                      : char.color === 'green'
                                        ? 'bg-green-700/20'
                                        : char.color === 'blue'
                                          ? 'bg-blue-700/20'
                                          : char.color === 'indigo'
                                            ? 'bg-indigo-700/20'
                                            : char.color === 'purple'
                                              ? 'bg-purple-700/20'
                                              : char.color === 'pink'
                                                ? 'bg-pink-700/20'
                                                : 'bg-darkbg/20'}"
                            ></div>
                            <div
                                class="h-4 min-h-4 w-14 relative z-10"
                                role="listitem"
                                ondragover={(e) => {
                                    if (!getCurrentSidebarDrag(e)) {
                                        return;
                                    }
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.dataTransfer.dropEffect = "move";
                                    e.currentTarget.classList.add("bg-green-500");
                                }}
                                ondragleave={(e) => {
                                    e.currentTarget.classList.remove("bg-green-500");
                                }}
                                ondrop={(e) => {
                                    const drag = getCurrentSidebarDrag(e);
                                    if (!drag) {
                                        return;
                                    }
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.currentTarget.classList.remove("bg-green-500");
                                    try {
                                        if (char.type === "folder") {
                                            inserter(drag, { index: 0, folder: char.id });
                                        }
                                    } finally {
                                        clearCurrentDrag();
                                    }
                                }}
                                ondragenter={preventAll}
                            ></div>
                            {#each char.folder as char2}
                                {@const memberStatus = characterStatuses.get(char2.chaId)}
                                {@const memberCount = memoryCountOf(memberStatus ?? null, [char2.chaId])}
                                {@const memberStatusLabel = memberStatus
                                    ? chatStatusLabel(memberStatus, char2.name, memberCount)
                                    : ""}
                                {@const memberName = memberStatus ? `${char2.name} · ${memberStatusLabel}` : char2.name}
                                <div
                                    class="group relative flex items-center px-2 z-10"
                                    role="listitem"
                                    draggable="true"
                                    ondragstart={(e) => {
                                        if (char.type === "folder") {
                                            avatarDragStart({ index: char2.orderIndex, folder: char.id }, e);
                                        }
                                    }}
                                    ondragend={clearCurrentDrag}
                                    ondragover={avatarDragOver}
                                    ondrop={(e) => {
                                        if (char.type === "folder") {
                                            avatarDrop({ index: char2.orderIndex, folder: char.id }, e);
                                        }
                                    }}
                                    ondragenter={preventAll}
                                >
                                    <SidebarIndicator
                                        isActive={currentCharacter?.chaId === char2.chaId && sideBarMode !== 1}
                                    />
                                    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                                    <div
                                        class="relative"
                                        role="button"
                                        tabindex="0"
                                        aria-label={memberStatus ? memberName : undefined}
                                        data-risu-chat-status={memberStatus}
                                        onclick={() => {
                                            if (char2.type === "normal") {
                                                changeChar(char2.chaId, { reseter });
                                            }
                                        }}
                                        onkeydown={(e) => {
                                            if (e.key === "Enter") {
                                                if (char2.type === "normal") {
                                                    changeChar(char2.chaId, { reseter });
                                                }
                                            }
                                        }}
                                    >
                                        <LazyCharImage path={char2.img ?? ""} type="plain" thumb={256}>
                                            {#snippet children(image)}
                                                <SidebarAvatar
                                                    src={char2.img ? image : "/none.webp"}
                                                    size="56"
                                                    rounded={IconRounded}
                                                    name={memberName}
                                                    chaId={char2.chaId}
                                                />
                                            {/snippet}
                                        </LazyCharImage>
                                        {#if memberStatus}
                                            <ChatStatusBadge
                                                status={memberStatus}
                                                label={memberStatusLabel}
                                                count={memberCount}
                                            />
                                        {/if}
                                    </div>
                                </div>
                                <div
                                    class="h-4 min-h-4 w-14 relative z-20"
                                    role="listitem"
                                    ondragover={(e) => {
                                        if (!getCurrentSidebarDrag(e)) {
                                            return;
                                        }
                                        e.preventDefault();
                                        e.stopPropagation();
                                        e.dataTransfer.dropEffect = "move";
                                        e.currentTarget.classList.add("bg-green-500");
                                    }}
                                    ondragleave={(e) => {
                                        e.currentTarget.classList.remove("bg-green-500");
                                    }}
                                    ondrop={(e) => {
                                        const drag = getCurrentSidebarDrag(e);
                                        if (!drag) {
                                            return;
                                        }
                                        e.preventDefault();
                                        e.stopPropagation();
                                        e.currentTarget.classList.remove("bg-green-500");
                                        try {
                                            if (char.type === "folder") {
                                                inserter(drag, { index: char2.orderIndex + 1, folder: char.id });
                                            }
                                        } finally {
                                            clearCurrentDrag();
                                        }
                                    }}
                                    ondragenter={preventAll}
                                ></div>
                            {/each}
                        </div>
                    {/key}
                {/if}
                <div
                    class="h-4 min-h-4 w-14"
                    role="listitem"
                    ondragover={(e) => {
                        if (!getCurrentSidebarDrag(e)) {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = "move";
                        e.currentTarget.classList.add("bg-green-500");
                    }}
                    ondragleave={(e) => {
                        e.currentTarget.classList.remove("bg-green-500");
                    }}
                    ondrop={(e) => {
                        const drag = getCurrentSidebarDrag(e);
                        if (!drag) {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.classList.remove("bg-green-500");
                        try {
                            inserter(drag, { index: char.orderIndex + 1 });
                        } finally {
                            clearCurrentDrag();
                        }
                    }}
                    ondragenter={preventAll}
                ></div>
            {/each}
            <div class="flex flex-col items-center gap-2 px-2">
                <BaseRoundedButton
                    onClick={async () => {
                        addCharacter({ reseter });
                    }}
                    ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
                        ><path
                            fill="none"
                            stroke="currentColor"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                        /></svg
                    ></BaseRoundedButton
                >
            </div>
        </div>
        {#if settings.ui.hamburgerButtonBottom}
            <div class="border-t border-t-selected w-full relative text-white">
                {#if menuMode === 1}
                    <div
                        class="absolute bottom-full w-20 min-w-20 flex border-t-selected border-t bg-bgcolor flex-col items-center pt-2 rounded-t-md z-20 pb-2"
                    >
                        <BarIcon
                            onClick={() => {
                                if ($settingsOpen) {
                                    reseter();
                                    settingsOpen.set(false);
                                } else {
                                    reseter();
                                    settingsOpen.set(true);
                                }
                            }}><Settings /></BarIcon
                        >
                        <div class="mt-2"></div>
                        <BarIcon
                            onClick={() => {
                                reseter();
                                selectCharacter(null);
                                PlaygroundStore.set(0);
                                OpenRealmStore.set(false);
                            }}><HomeIcon /></BarIcon
                        >
                        <div class="mt-2"></div>
                        <BarIcon
                            onClick={() => {
                                reseter();
                                if (currentCharacter === undefined && $PlaygroundStore !== 0) {
                                    PlaygroundStore.set(0);
                                    return;
                                }
                                selectCharacter(null);
                                PlaygroundStore.set(1);
                            }}><ShellIcon /></BarIcon
                        >
                        {#each additionalHamburgerMenu as menu}
                            <div class="mt-2"></div>
                            <BarIcon
                                onClick={() => {
                                    reseter();
                                    menu.callback();
                                }}
                            >
                                <PluginDefinedIcon ico={menu} />
                            </BarIcon>
                        {/each}
                        <div class="mt-2"></div>
                        <BarIcon
                            onClick={() => {
                                reseter();
                                openGrid();
                            }}><LayoutGridIcon /></BarIcon
                        >
                    </div>
                {/if}
            </div>
            <button
                class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mb-2 mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-blue-500"
                onclick={() => {
                    menuMode = 1 - menuMode;
                }}
                ><ListIcon />
            </button>
        {/if}
    </div>
{/if}
<div
    class="setting-area h-full flex-col overflow-y-auto overflow-x-hidden bg-darkbg py-6 text-textcolor max-h-full"
    class:risu-sidebar={!$sideBarClosing}
    class:w-96={$sideBarSize === 0}
    class:w-110={$sideBarSize === 1}
    class:w-124={$sideBarSize === 2}
    class:w-138={$sideBarSize === 3}
    class:risu-sidebar-close={$sideBarClosing}
    class:min-w-96={!$DynamicGUI && $sideBarSize === 0}
    class:min-w-110={!$DynamicGUI && $sideBarSize === 1}
    class:min-w-124={!$DynamicGUI && $sideBarSize === 2}
    class:min-w-138={!$DynamicGUI && $sideBarSize === 3}
    class:px-2={$DynamicGUI}
    class:px-4={!$DynamicGUI}
    style:--sidebar-gutter={$DynamicGUI ? "0.5rem" : "1rem"}
    class:dynamic-sidebar={$DynamicGUI}
    class:hidden
    class:flex={!hidden}
    onanimationend={() => {
        if ($sideBarClosing) {
            $sideBarClosing = false;
            sideBarStore.set(false);
        }
    }}
>
    <button
        class="flex w-full justify-end text-textcolor"
        onclick={async () => {
            if ($sideBarClosing) {
                return;
            }
            $sideBarClosing = true;
        }}
    >
        <!-- <button class="border-none bg-transparent p-0 text-textcolor"><X /></button> -->
    </button>
    {#if sideBarMode === 0}
        {#if currentCharacter === undefined || $settingsOpen}
            <div>
                <h1 class="text-xl">Welcome to RisuAI!</h1>
                <span class="text-xs text-textcolor2">Select a bot to start chatting</span>
            </div>
        {:else if currentCharacter?.chaId === "§playground"}
            <SideChatList chara={currentCharacter} />
        {:else}
            <div
                class="w-full h-8 min-h-8 border-l border-b border-r border-selected relative bottom-6 rounded-b-md flex"
            >
                <button
                    onclick={() => {
                        devTool = false;
                        botMakerMode.set(false);
                    }}
                    class="grow border-r border-r-selected rounded-bl-md"
                    class:text-textcolor2={$botMakerMode || devTool}>{language.Chat}</button
                >
                <button
                    onclick={() => {
                        devTool = false;
                        botMakerMode.set(true);
                    }}
                    class="grow rounded-br-md"
                    class:text-textcolor2={!$botMakerMode || devTool}>{language.character}</button
                >
                {#if settings.ui.enableDevTools}
                    <button
                        onclick={() => {
                            devTool = true;
                        }}
                        class="border-l border-l-selected rounded-br-md px-1"
                        class:text-textcolor2={!devTool}
                    >
                        <WrenchIcon size={18} />
                    </button>
                {/if}
            </div>
            {#if devTool}
                <DevTool />
            {:else if $botMakerMode}
                <CharConfig />
            {:else if selection.chatOpen}
                <OpenChatPanel chara={currentCharacter} />
            {:else}
                <SideChatList chara={currentCharacter} />
            {/if}
        {/if}
    {/if}
</div>

{#if $DynamicGUI}
    <div
        role="button"
        tabindex="0"
        class="grow h-full min-w-12"
        class:hidden
        onclick={() => {
            if ($sideBarClosing) {
                return;
            }
            $sideBarClosing = true;
        }}
        onkeydown={(e) => {
            if (e.key === "Enter") {
                e.currentTarget.click();
            }
        }}
        class:sidebar-dark-animation={!$sideBarClosing}
        class:sidebar-dark-close-animation={$sideBarClosing}
    ></div>
{/if}

<style>
    .editMode {
        min-width: 6rem;
    }
    @keyframes sidebar-transition {
        from {
            width: 0rem;
        }
        to {
            width: var(--sidebar-size);
        }
    }
    @keyframes sidebar-transition-close {
        from {
            width: var(--sidebar-size);
            right: 0rem;
        }
        to {
            width: 0rem;
            right: 10rem;
        }
    }
    @keyframes sidebar-transition-non-dynamic {
        from {
            width: 0rem;
            min-width: 0rem;
        }
        to {
            width: var(--sidebar-size);
            min-width: var(--sidebar-size);
        }
    }
    @keyframes sidebar-transition-close-non-dynamic {
        from {
            width: var(--sidebar-size);
            min-width: var(--sidebar-size);
            right: 0rem;
        }
        to {
            width: 0rem;
            min-width: 0rem;
            right: 3rem;
        }
    }
    @keyframes sub-sidebar-transition {
        from {
            width: 0rem;
            min-width: 0rem;
        }
        to {
            width: 5rem;
            min-width: 5rem;
        }
    }
    @keyframes sub-sidebar-transition-close {
        from {
            width: 5rem;
            min-width: 5rem;
            max-width: 5rem;
            right: 0rem;
        }
        to {
            width: 0rem;
            min-width: 0rem;
            max-width: 0rem;
            right: 10rem;
        }
    }
    @keyframes sidebar-dark-animation {
        from {
            background-color: rgba(0, 0, 0, 0) !important;
        }
        to {
            background-color: rgba(0, 0, 0, 0.5) !important;
        }
    }
    @keyframes sidebar-dark-closing-animation {
        from {
            background-color: rgba(0, 0, 0, 0.5) !important;
        }
        to {
            background-color: rgba(0, 0, 0, 0) !important;
        }
    }

    .risu-sidebar:not(.dynamic-sidebar) {
        animation-name: sidebar-transition-non-dynamic;
        animation-duration: var(--risu-animation-speed);
    }
    .risu-sidebar-close:not(.dynamic-sidebar) {
        animation-name: sidebar-transition-close-non-dynamic;
        animation-duration: var(--risu-animation-speed);
        position: relative;
    }
    .risu-sidebar.dynamic-sidebar {
        animation-name: sidebar-transition;
        animation-duration: var(--risu-animation-speed);
    }
    .risu-sidebar-close.dynamic-sidebar {
        animation-name: sidebar-transition-close;
        animation-duration: var(--risu-animation-speed);
        position: relative;
        right: 3rem;
    }

    .risu-sub-sidebar {
        animation-name: sub-sidebar-transition;
        animation-duration: var(--risu-animation-speed);
    }
    .risu-sub-sidebar-close {
        animation-name: sub-sidebar-transition-close;
        animation-duration: var(--risu-animation-speed);
        position: relative;
    }
    .sidebar-dark-animation {
        animation-name: sidebar-dark-transition;
        animation-duration: var(--risu-animation-speed);
        background-color: rgba(0, 0, 0, 0.5);
    }
    .sidebar-dark-close-animation {
        animation-name: sidebar-dark-closing-transition;
        animation-duration: var(--risu-animation-speed);
        background-color: rgba(0, 0, 0, 0);
    }
</style>
