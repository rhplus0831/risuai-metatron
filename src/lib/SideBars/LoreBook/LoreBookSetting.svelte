<script lang="ts">
    import { currentChatRef, selectedChat } from "src/ts/storage/chatStore.svelte";
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { useLocalLoreDraft } from "src/ts/storage/localLoreDraft.svelte";
    import { language } from "../../../lang";
    import { DownloadIcon, HardDriveUploadIcon, PlusIcon, SunIcon, LinkIcon, FolderPlusIcon } from "@lucide/svelte";
    import {
        addLorebook,
        addLorebookFolder,
        exportLoreBook,
        importLoreBook,
    } from "../../../ts/process/lorebook.svelte";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import Accordion from "../../UI/Accordion.svelte";
    import LoreOverrideList from "./LoreOverrideList.svelte";
    import { mergeOwnerLore } from "../../../../shared/lore/overrides.ts";
    import { untrack } from "svelte";

    const currentCharacter = $derived(selectedCharacter());
    const currentChat = $derived(selectedChat());
    let submenu = $state(0);

    let overridesOpen = $state(false);
    const chatKey = $derived.by(() => {
        const ref = currentChatRef();
        return ref ? `${ref.chaId}\u0000${ref.chatId}` : "";
    });
    let previousChat = "";
    let previousOrphans = new Map<string, number>();
    // Open on a switch to a chat with orphans, or when a new orphan appears in the same chat.
    $effect(() => {
        const key = chatKey;
        const orphans = mergeOwnerLore(currentCharacter?.globalLore ?? [], currentChat?.loreOverrides ?? []).orphans;
        const ids = new Map<string, number>();
        for (const override of orphans) ids.set(override.entry.id, (ids.get(override.entry.id) ?? 0) + 1);
        untrack(() => {
            if (key !== previousChat) overridesOpen = ids.size > 0;
            else if ([...ids].some(([id, count]) => count > (previousOrphans.get(id) ?? 0))) overridesOpen = true;
            previousChat = key;
            previousOrphans = ids;
        });
    });

    function isAllCharacterLoreAlwaysActive() {
        const globalLore = currentCharacter.globalLore;
        return globalLore && globalLore.every((book) => book.alwaysActive);
    }

    function isAllChatLoreAlwaysActive() {
        const localLore = currentChat?.localLore;
        return localLore && localLore.every((book) => book.alwaysActive);
    }

    function toggleCharacterLoreAlwaysActive() {
        const globalLore = currentCharacter.globalLore;

        if (!globalLore) return;

        const allActive = globalLore.every((book) => book.alwaysActive);

        globalLore.forEach((book) => {
            book.alwaysActive = !allActive;
        });
    }

    function toggleChatLoreAlwaysActive() {
        // Edits the chat's local lorebook copy, which is saved through the chat module.
        const localLore = useLocalLoreDraft().value;

        if (!localLore) return;

        const allActive = localLore.every((book) => book.alwaysActive);

        localLore.forEach((book) => {
            book.alwaysActive = !allActive;
        });
    }
</script>

<div class="flex w-full rounded-md border border-selected">
    <button
        onclick={() => {
            submenu = 0;
        }}
        class="p-2 flex-1"
        class:bg-selected={submenu === 0}
    >
        <span>{currentCharacter.type === "group" ? language.group : language.character}</span>
    </button>
    <button
        onclick={() => {
            submenu = 1;
        }}
        class="p2 flex-1 border-r border-l border-selected"
        class:bg-selected={submenu === 1}
    >
        <span>{language.Chat}</span>
    </button>
    <button
        onclick={() => {
            submenu = 2;
        }}
        class="p-2 flex-1"
        class:bg-selected={submenu === 2}
    >
        <span>{language.settings}</span>
    </button>
</div>
{#if submenu !== 2}
    <span class="text-textcolor2 mt-2 mb-6 text-sm"
        >{submenu === 0
            ? currentCharacter.type === "group"
                ? language.groupLoreInfo
                : language.globalLoreInfo
            : language.localLoreInfo}</span
    >
    <LoreBookList {submenu} lorePlus={currentCharacter?.lorePlus} />
{:else}
    {#if currentCharacter.loreSettings}
        <div class="flex items-center mt-4">
            <Check
                check={false}
                onChange={() => {
                    currentCharacter.loreSettings = undefined;
                }}
                name={language.useGlobalSettings}
            />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={currentCharacter.loreSettings.recursiveScanning} name={language.recursiveScanning} />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={currentCharacter.loreSettings.fullWordMatching} name={language.fullWordMatching} />
        </div>
        <span class="text-textcolor mt-4 mb-2">{language.loreBookDepth}</span>
        <NumberInput size="sm" min={0} max={20} bind:value={currentCharacter.loreSettings.scanDepth} />
        <span class="text-textcolor">{language.loreBookToken}</span>
        <NumberInput size="sm" min={0} max={4096} bind:value={currentCharacter.loreSettings.tokenBudget} />
    {:else}
        <div class="flex items-center mt-4">
            <Check
                check={true}
                onChange={() => {
                    currentCharacter.loreSettings = {
                        tokenBudget: settings.providers.loreBookToken,
                        scanDepth: settings.memoryTranslateMedia.loreBookDepth,
                        recursiveScanning: false,
                    };
                }}
                name={language.useGlobalSettings}
            />
        </div>
    {/if}
    <div class="flex items-center mt-4">
        {#if settings.ui.useExperimental}
            <Check bind:check={currentCharacter.lorePlus} name={language.lorePlus}
                ><Help key="lorePlus"></Help><Help key="experimental"></Help></Check
            >
        {/if}
    </div>
{/if}
{#if submenu !== 2}
    <div class="text-textcolor2 mt-2 flex">
        <button
            onclick={() => {
                addLorebook(submenu);
            }}
            class="hover:text-textcolor cursor-pointer"
        >
            <PlusIcon />
        </button>
        <button
            onclick={() => {
                exportLoreBook(submenu === 0 ? "global" : "local");
            }}
            class="hover:text-textcolor ml-1 cursor-pointer"
        >
            <DownloadIcon />
        </button>
        <button
            onclick={() => {
                addLorebookFolder(submenu);
            }}
            class="hover:text-textcolor ml-2 cursor-pointer"
        >
            <FolderPlusIcon />
        </button>
        <button
            onclick={() => {
                importLoreBook(submenu === 0 ? "global" : "local");
            }}
            class="hover:text-textcolor ml-2 cursor-pointer"
        >
            <HardDriveUploadIcon />
        </button>
        {#if settings.ui.bulkEnabling}
            <button
                onclick={() => {
                    toggleCharacterLoreAlwaysActive();
                }}
                class="hover:text-textcolor ml-2 cursor-pointer flex items-center gap-1"
            >
                {#if isAllCharacterLoreAlwaysActive()}
                    <SunIcon />
                {:else}
                    <LinkIcon />
                {/if}
                <span class="text-xs">CHAR</span>
            </button>
            <button
                onclick={() => {
                    toggleChatLoreAlwaysActive();
                }}
                class="hover:text-textcolor ml-2 cursor-pointer flex items-center gap-1"
            >
                {#if isAllChatLoreAlwaysActive()}
                    <SunIcon />
                {:else}
                    <LinkIcon />
                {/if}
                <span class="text-xs">CHAT</span>
            </button>
        {/if}
    </div>
{/if}

{#if submenu === 1}
    <Accordion styled name={language.chatLoreOverrides.title} bind:open={overridesOpen}>
        {#key chatKey}
            <LoreOverrideList />
        {/key}
    </Accordion>
{/if}
