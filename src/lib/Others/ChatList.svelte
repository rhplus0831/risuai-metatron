<script>
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { alertConfirm, alertError } from "../../ts/alert";
    import { language } from "../../lang";

    import { ReloadGUIPointer } from "../../ts/stores.svelte";
    import { DownloadIcon, SquarePenIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { exportChat, importChat } from "../../ts/characters";
    import { findCharacterbyId } from "../../ts/util";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { changeChatTo } from "src/ts/globalApi.svelte";
    import { initialChatBinding } from "src/ts/storage/chatBinding.svelte";
    import {
        chatList,
        createChat,
        deleteChat,
        isChatGenerating,
        selectedChatId,
        setChatMeta,
    } from "src/ts/storage/chatStore.svelte";

    const currentCharacter = $derived(selectedCharacter());
    // The chat list entries and the selected chat id (the chat module's).
    const chats = $derived(currentCharacter ? chatList(currentCharacter.chaId) : []);
    const selectedId = $derived(currentCharacter ? selectedChatId(currentCharacter.chaId) : null);
    let editMode = $state(false);
    /** @type {{close?: any}} */
    let { close = () => {} } = $props();
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-72 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.chatList}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24} />
                </button>
            </div>
        </div>
        {#each chats as chat}
            <button
                onclick={() => {
                    if (!editMode) {
                        changeChatTo(chat.id);
                        close();
                    }
                }}
                class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer"
                class:bg-selected={chat.id === selectedId}
            >
                {#if editMode}
                    <TextInput
                        value={chat.name}
                        oninput={(e) =>
                            setChatMeta(
                                { chaId: currentCharacter.chaId, chatId: chat.id },
                                { name: e.currentTarget.value },
                            )}
                        padding={false}
                    />
                {:else}
                    <span>{chat.name}</span>
                {/if}
                <div class="grow flex justify-end">
                    <div
                        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                        role="button"
                        tabindex="0"
                        onclick={async (e) => {
                            e.stopPropagation();
                            exportChat(chat.id);
                        }}
                        onkeydown={() => {}}
                    >
                        <DownloadIcon size={18} />
                    </div>
                    <div
                        class="text-textcolor2 hover:text-green-500 cursor-pointer"
                        role="button"
                        tabindex="0"
                        onclick={async (e) => {
                            e.stopPropagation();
                            if (chats.length === 1) {
                                alertError(language.errors.onlyOneChat);
                                return;
                            }
                            const ref = { chaId: currentCharacter.chaId, chatId: chat.id };
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
                                changeChatTo(0);
                            }
                        }}
                        onkeydown={() => {}}
                    >
                        <TrashIcon size={18} />
                    </div>
                </div>
            </button>
        {/each}
        <div class="flex mt-2 items-center">
            <button
                class="text-textcolor2 hover:text-green-500 cursor-pointer mr-1"
                onclick={() => {
                    const cha = currentCharacter;
                    const len = chats.length;
                    // A group chat starts with each member's first message.
                    const message =
                        cha.type === "group"
                            ? cha.characters.map((c) => ({
                                  saying: c,
                                  role: "char",
                                  data: findCharacterbyId(c).firstMessage,
                              }))
                            : [];
                    createChat(
                        cha.chaId,
                        {
                            // Read before the chat is created: it becomes the selected chat.
                            ...initialChatBinding(cha.chaId),
                            message,
                            note: "",
                            name: `New Chat ${len + 1}`,
                            localLore: [],
                            fmIndex: -1,
                        },
                        { index: 0, select: true },
                    );
                    changeChatTo(0);
                    close();
                }}
            >
                <PlusIcon />
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
                class="text-textcolor2 hover:text-green-500 cursor-pointer"
                onclick={() => {
                    editMode = !editMode;
                }}
            >
                <SquarePenIcon size={18} />
            </button>
        </div>
    </div>
</div>

<style>
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
