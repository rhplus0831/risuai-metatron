<script lang="ts">
    import { onMount } from "svelte";
    import { language } from "src/lang";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import { chatEntry, currentChatRef } from "src/ts/storage/chatStore.svelte";
    import { openSetting } from "src/ts/setting/settingJump.svelte";
    import { settingLocation, type SettingHit } from "src/ts/setting/searchIndex";
    import {
        botMakerMode,
        CharConfigSubMenu,
        gridOpenStore,
        loreBookSubmenuRequest,
        type LoreBudgetStopRequest,
        MEMORY_SETTINGS_MENU,
        settingsOpen,
        sideBarStore,
        sidebarLeaveDevTool,
    } from "src/ts/stores.svelte";

    interface Props {
        request: LoreBudgetStopRequest;
    }

    /*
     * What a send that stopped over the lore budget left out, and what to do about it. `App.svelte` mounts one
     * per shown request (`loreBudgetStopDialog`), after the picker lists, so it paints above them and below
     * alerts (`z-50`). Every button answers the request (`request.resolve`), which closes the dialog; so do
     * Escape (`closeBindingLayer` in `src/ts/hotkey.ts`), this component's teardown, and the chat leaving the
     * list. The caller acts on "Don't warn in this chat and send"; the two navigation buttons open their panel
     * here and are offered only while the stopped chat is the selected one and its owner's lorebook tab can show.
     */
    let { request }: Props = $props();
    const entry = $derived(chatEntry(request.ref));
    const owner = $derived(characterList().find((character) => character?.chaId === request.ref.chaId));
    /** The limit is the owner's own (`loreSettings.tokenBudget`, 0 included), read now: it names where to change it. */
    const ownBudget = $derived(owner?.loreSettings?.tokenBudget != null);
    const navigable = $derived.by(() => {
        const selected = currentChatRef();
        return (
            selected?.chaId === request.ref.chaId &&
            selected.chatId === request.ref.chatId &&
            owner !== undefined &&
            owner.chaId !== "§playground" &&
            !(owner.type === "character" && owner.license === "private")
        );
    });
    const named = $derived(request.stop.rejected);
    const unnamed = $derived(request.stop.rejectedCount - named.length);
    let closeButton: HTMLButtonElement | undefined = $state();

    const fmt = (value: number) => value.toLocaleString();

    $effect(() => {
        if (!entry) {
            request.resolve("close");
        }
    });

    onMount(() => {
        // The request this instance shows: its teardown never answers a later one.
        const shown = request;
        closeButton?.focus();
        return () => shown.resolve("close");
    });

    /** The selected character's editor on its lorebook tab, on `submenu` when one is given. */
    function openLorebookTab(submenu: number | null) {
        // The settings and the character grid show in place of the sidebar and the chat screen.
        settingsOpen.set(false);
        gridOpenStore.set(false);
        sideBarStore.set(true);
        sidebarLeaveDevTool.set(true);
        botMakerMode.set(true);
        CharConfigSubMenu.set(3);
        loreBookSubmenuRequest.set(submenu);
    }

    function changeLimit() {
        if (ownBudget) {
            openLorebookTab(2);
            request.resolve("changeLimit");
            return;
        }
        const location = settingLocation("adv.lbToken");
        openSetting({
            kind: "item",
            id: "adv.lbToken",
            label: language.loreBookToken,
            breadcrumb: [language.memorySettings, language.loreBook],
            target: {
                menu: location?.menu ?? MEMORY_SETTINGS_MENU,
                ...(location?.tab !== undefined ? { tab: location.tab } : {}),
                ...(location?.sectionId !== undefined ? { sectionId: location.sectionId } : {}),
                ...(location?.opener !== undefined ? { opener: location.opener } : {}),
            },
            available: true,
            score: 0,
        } satisfies SettingHit);
        request.resolve("changeLimit");
    }

    function manageLorebook() {
        openLorebookTab(null);
        request.resolve("manageLorebook");
    }
</script>

<div class="absolute w-full h-full z-40 bg-bgcolor/70 flex justify-center items-center p-2">
    <div
        class="bg-darkbg text-textcolor p-4 break-any rounded-md flex flex-col gap-3 max-w-full w-96 max-h-full overflow-y-auto border border-darkborderc"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lore-budget-stop-dialog-title"
        data-lore-budget-stop-dialog
    >
        <div class="flex flex-col">
            <h2 id="lore-budget-stop-dialog-title" class="mt-0 mb-0 font-bold">
                {language.loreBudgetStopDialog.title}
            </h2>
            {#if entry}
                <span class="text-textcolor2 text-sm truncate">
                    {owner?.name ? `${owner.name} · ${entry.name}` : entry.name}
                </span>
            {/if}
        </div>
        <div class="flex flex-col gap-1 text-sm">
            <div class="flex justify-between gap-2">
                <span title={language.contextUsage.loreBudgetHelp}>{language.contextUsage.loreBudget}</span>
                <span class="tabular-nums">{fmt(request.stop.budgetUsed)} / {fmt(request.stop.budget)}</span>
            </div>
            <span class="text-xs text-textcolor2" data-lore-budget-stop-limit>
                {ownBudget
                    ? owner?.type === "group"
                        ? language.loreBudgetStopDialog.limitOwnGroup
                        : language.loreBudgetStopDialog.limitOwnCharacter
                    : language.loreBudgetStopDialog.limitGlobal}
            </span>
        </div>
        <div class="flex flex-col gap-1 text-sm">
            <span class="font-semibold">
                {language.contextUsage.loreRejected(request.stop.rejectedCount, fmt(request.stop.rejectedTokens))}
            </span>
            {#if named.length > 0}
                <ul class="flex flex-col gap-0.5 text-xs" data-lore-budget-stop-rejected>
                    {#each named as rejected, index (index)}
                        <li class="flex gap-2">
                            <span class="min-w-0 grow truncate" title={rejected.name}>{rejected.name}</span>
                            <span class="shrink-0 tabular-nums text-textcolor2">
                                {language.contextUsage.tokens(fmt(rejected.tokens))}
                            </span>
                        </li>
                    {/each}
                    {#if unnamed > 0}
                        <li class="text-textcolor2">{language.contextUsage.loreRejectedMore(unnamed)}</li>
                    {/if}
                </ul>
            {/if}
        </div>
        <span class="text-sm text-textcolor2" data-lore-budget-stop-note>
            {language.loreBudgetStopDialog.notCalled}
            {#if request.messageKept}
                {language.loreBudgetStopDialog.messageKept}
            {/if}
        </span>
        <div class="flex flex-col gap-2 text-sm">
            <button
                type="button"
                class="bg-darkbutton hover:bg-selected border border-darkborderc rounded-md px-4 py-2"
                data-lore-budget-stop-action="warnOffAndSend"
                onclick={() => request.resolve("warnOffAndSend")}
            >
                {language.loreBudgetStopDialog.warnOffAndSend}
            </button>
            {#if navigable}
                <button
                    type="button"
                    class="bg-darkbutton hover:bg-selected border border-darkborderc rounded-md px-4 py-2"
                    data-lore-budget-stop-action="changeLimit"
                    onclick={changeLimit}
                >
                    {language.loreBudgetStopDialog.changeLimit}
                </button>
                <button
                    type="button"
                    class="bg-darkbutton hover:bg-selected border border-darkborderc rounded-md px-4 py-2"
                    data-lore-budget-stop-action="manageLorebook"
                    onclick={manageLorebook}
                >
                    {language.loreBudgetStopDialog.manageLorebook}
                </button>
            {/if}
            <button
                bind:this={closeButton}
                type="button"
                class="hover:bg-selected border border-darkborderc rounded-md px-4 py-2 text-textcolor2"
                data-lore-budget-stop-action="close"
                onclick={() => request.resolve("close")}
            >
                {language.loreBudgetStopDialog.close}
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
