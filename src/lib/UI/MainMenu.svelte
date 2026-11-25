<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import { activeChatList } from "src/ts/storage/chatStore.svelte";
    import {
        chatStatusKey,
        generatingBadgeKeys,
        memoryHealthStates,
        recoveryChatKeys,
        unseenChatKeys,
    } from "src/ts/process/chatStatus.svelte";
    import { summarizingChats } from "src/ts/process/memoryTasks.svelte";
    import { refusedItems } from "src/ts/storage/resourceSync.svelte";
    import Hub from "./Realm/RealmMain.svelte";
    import { gridOpenStore, OpenRealmStore } from "src/ts/stores.svelte";
    import {
        ArrowLeft,
        ChevronRightIcon,
        Globe2Icon,
        ImportIcon,
        LayoutGridIcon,
        MonitorSmartphoneIcon,
        PinIcon,
        UsersIcon,
    } from "@lucide/svelte";
    import { getVersionString, openPinnedChat, recoverDirectAssetElement } from "src/ts/globalApi.svelte";
    import { buildId, buildInfo } from "src/ts/buildInfo";
    import { alertNormal } from "src/ts/alert";
    import { language } from "src/lang";
    import { changeChar, getCharImage, importCharacterAndSelect } from "src/ts/characters";
    import { onMount } from "svelte";
    import { hostMode } from "src/ts/network/remoteHost";
    import Title from "./Title.svelte";
    import { collectHomeRecentCharacters } from "./mainMenuProjection";
    import { collectPinnedChats, HOME_PINNED_CHAT_COLLAPSED_LIMIT } from "../SideBars/pinnedChats";
    import ChatStatusBadge from "../SideBars/ChatStatusBadge.svelte";
    import { chatStatusLabel, refusedChatKeys, resolveChatStatus, type ChatStatus } from "../SideBars/chatStatus";

    /**
     * The home screen: `src/lib/ChatScreens/DefaultChatScreen.svelte` shows it with no selected character and
     * `PlaygroundStore` 0. It fetches nothing from Realm itself.
     *
     * - Pinned chats share their projection (`collectPinnedChats`, `src/lib/SideBars/pinnedChats.ts`) and their status
     *   resolution (`resolveChatStatus`, `ChatStatusBadge`) with the sidebar rail; the status is in a card's accessible
     *   name and hover title. A card opens through `openPinnedChat` (`src/ts/globalApi.svelte.ts`), which selects the
     *   chat before its character, so the character's previous chat is not loaded first.
     * - Recent characters come from `collectHomeRecentCharacters` (`src/lib/UI/mainMenuProjection.ts`).
     * - The More section always shows. `OpenRealmStore` swaps the whole screen, logo included, for `RealmMain`; the
     *   card that sets it is hidden under `settings.ui.hideRealm`. The import card opens the card file picker directly
     *   (`importCharacterAndSelect`, `src/ts/characters.ts`), not the add dialog. The remote host card turns on `hostMode`
     *   (`src/ts/network/remoteHost.ts`), whose lock screen then covers the app and holds the control that leaves it.
     */

    const compatVersion = getVersionString();

    // The full commit goes with the copy, so a bug report names the exact build.
    async function copyVersion() {
        const commit = buildInfo.commit ? ` (${buildInfo.commit})` : "";
        await navigator.clipboard.writeText(`Metatron ${buildId}${commit}, RisuAI ${compatVersion}`);
        alertNormal(language.clipboardSuccess);
    }

    const agoFormatter = new Intl.RelativeTimeFormat(navigator.languages, { style: "short" });

    let relativeTimeNow = $state(Date.now());
    let showAllPinnedChats = $state(false);
    const pinnedChats = $derived(
        collectPinnedChats(characterList(), settings.characterOrder, activeChatList, language.unnamedPinnedChat),
    );
    const summarizing = $derived(summarizingChats());
    const healthStates = $derived(memoryHealthStates());
    const statusSets = $derived({
        recovery: $recoveryChatKeys,
        refused: refusedChatKeys(refusedItems()),
        generating: generatingBadgeKeys(),
        memory: summarizing,
        unseen: $unseenChatKeys,
        health: healthStates,
    });
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
    const visiblePinnedChats = $derived(
        showAllPinnedChats ? pinnedChats : pinnedChats.slice(0, HOME_PINNED_CHAT_COLLAPSED_LIMIT),
    );
    let recentCharacters = $derived(
        collectHomeRecentCharacters(characterList(), {
            agoFormatter,
            unknownText: language.unknownInteractionTime,
            now: relativeTimeNow,
        }),
    );

    onMount(() => {
        const timer = window.setInterval(() => {
            relativeTimeNow = Date.now();
        }, 60_000);
        return () => window.clearInterval(timer);
    });
</script>

{#snippet moreCard(card: string, Icon: typeof Globe2Icon, title: string, description: string, onclick: () => void)}
    <button
        type="button"
        class="group flex w-full items-center gap-4 rounded-xl border border-darkborderc bg-darkbg px-5 py-4 text-left shadow-sm transition-colors hover:border-green-500 hover:bg-selected focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-500"
        data-risu-home-card={card}
        {onclick}
    >
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-selected text-textcolor">
            <Icon size={22} aria-hidden="true" />
        </span>
        <span class="min-w-0 grow">
            <span class="block text-lg font-bold">{title}</span>
            <span class="mt-0.5 block text-sm text-textcolor2">{description}</span>
        </span>
        <ChevronRightIcon
            size={20}
            class="shrink-0 text-textcolor2 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
        />
    </button>
{/snippet}

<div class="h-full w-full flex flex-col overflow-y-auto items-center">
    {#if !$OpenRealmStore}
        <Title />
        <button
            type="button"
            class="mt-1 flex flex-col items-center text-textcolor2 hover:text-textcolor"
            title={language.versionCopy}
            onclick={copyVersion}
        >
            <span class="text-lg font-bold">{language.versionLabel.replace("{{build}}", buildId)}</span>
            <span class="text-xs">{language.versionBasedOn.replace("{{version}}", compatVersion)}</span>
        </button>
    {/if}
    <div class="w-full flex p-4 pb-8 flex-col text-textcolor max-w-4xl">
        {#if !$OpenRealmStore}
            <div class="mt-4 mb-5 w-full border-t border-t-selected"></div>

            <section aria-labelledby="home-pinned-chats-title" data-risu-home-section="pinned-chats">
                <div class="mb-3 flex items-center gap-2">
                    <PinIcon size={18} aria-hidden="true" />
                    <h2 id="home-pinned-chats-title" class="text-lg font-bold">{language.pinnedChats}</h2>
                </div>

                {#if pinnedChats.length > 0}
                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2" data-risu-home-pinned-list>
                        {#each visiblePinnedChats as item (JSON.stringify([item.chaId, item.chatId]))}
                            {@const status = pinnedStatuses.get(chatStatusKey(item))}
                            {@const statusCount =
                                status === "memory" ? (summarizing.get(chatStatusKey(item)) ?? null) : null}
                            {@const statusHealth =
                                status === "health" ? (healthStates.get(chatStatusKey(item)) ?? null) : null}
                            {@const statusLabel = status
                                ? chatStatusLabel(status, item.chatName, statusCount, statusHealth)
                                : ""}
                            {@const label =
                                language.openPinnedChat(item.chatName, item.characterName) +
                                (status ? ` · ${statusLabel}` : "")}
                            <button
                                type="button"
                                class="flex min-w-0 items-center gap-2 rounded-xl border border-darkborderc bg-darkbg p-3 text-left shadow-sm transition-colors hover:border-green-500 hover:bg-selected focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-500"
                                aria-label={label}
                                title={status ? label : undefined}
                                data-risu-home-pinned-chat={item.chatId}
                                data-risu-chat-status={status ?? undefined}
                                onclick={() => openPinnedChat(item)}
                            >
                                <span class="relative h-11 w-11 shrink-0">
                                    {#await getCharImage(item.characterImage, "plain", 256)}
                                        <span
                                            class="block h-full w-full animate-pulse rounded-lg bg-selected"
                                            aria-hidden="true"
                                        ></span>
                                    {:then imageSource}
                                        <img
                                            onerror={(event) => void recoverDirectAssetElement(event.currentTarget)}
                                            src={imageSource || "/none.webp"}
                                            alt=""
                                            class="h-full w-full rounded-lg object-cover object-top"
                                            class:rounded-full={settings.ui.roundIcons}
                                        />
                                    {/await}
                                    {#if status}
                                        <ChatStatusBadge
                                            {status}
                                            label={statusLabel}
                                            count={statusCount}
                                            health={statusHealth}
                                        />
                                    {/if}
                                </span>
                                <span class="min-w-0">
                                    <span class="block truncate text-sm font-semibold">{item.chatName}</span>
                                    <span class="mt-0.5 block truncate text-xs text-textcolor2"
                                        >{item.characterName}</span
                                    >
                                </span>
                            </button>
                        {/each}
                    </div>
                    {#if pinnedChats.length > HOME_PINNED_CHAT_COLLAPSED_LIMIT}
                        <button
                            type="button"
                            class="mt-3 rounded-md px-2 py-1 text-sm font-medium text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-500"
                            aria-expanded={showAllPinnedChats}
                            onclick={() => (showAllPinnedChats = !showAllPinnedChats)}
                        >
                            {showAllPinnedChats
                                ? language.homeShowFewerPinnedChats
                                : language.homeShowAllPinnedChats(pinnedChats.length)}
                        </button>
                    {/if}
                {:else}
                    <div
                        class="rounded-xl border border-dashed border-darkborderc bg-darkbg/60 px-4 py-3 text-sm text-textcolor2"
                    >
                        {language.homePinnedChatsEmpty}
                    </div>
                {/if}
            </section>

            <section
                class="mt-7"
                aria-labelledby="home-recent-characters-title"
                data-risu-home-section="recent-characters"
            >
                <div class="mb-3 flex items-center gap-2">
                    <UsersIcon size={18} aria-hidden="true" />
                    <h2 id="home-recent-characters-title" class="text-lg font-bold">
                        {language.homeRecentCharacters}
                    </h2>
                    <button
                        type="button"
                        class="ml-auto rounded-md px-2 py-1 text-sm font-medium text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-500"
                        onclick={() => ($gridOpenStore = true)}
                    >
                        {language.homeViewAllCharacters}
                    </button>
                </div>

                {#if recentCharacters.length > 0}
                    <div class="grid grid-cols-2 gap-3 md:grid-cols-4" data-risu-home-recent-list>
                        {#each recentCharacters as item (item.chaId)}
                            <button
                                type="button"
                                class="flex min-w-0 items-center gap-2 rounded-xl border border-darkborderc bg-darkbg p-3 text-left shadow-sm transition-colors hover:border-green-500 hover:bg-selected focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-500"
                                aria-label={language.homeOpenCharacter(item.name)}
                                data-risu-home-recent-character={item.chaId}
                                onclick={() => changeChar(item.chaId)}
                            >
                                {#await getCharImage(item.image, "plain", 256)}
                                    <span
                                        class="h-11 w-11 shrink-0 animate-pulse rounded-lg bg-selected"
                                        aria-hidden="true"
                                    ></span>
                                {:then imageSource}
                                    <img
                                        onerror={(event) => void recoverDirectAssetElement(event.currentTarget)}
                                        src={imageSource || "/none.webp"}
                                        alt=""
                                        class="h-11 w-11 shrink-0 rounded-lg object-cover object-top"
                                        class:rounded-full={settings.ui.roundIcons}
                                    />
                                {/await}
                                <span class="min-w-0">
                                    <span class="block truncate text-sm font-semibold">{item.name}</span>
                                    <span class="mt-0.5 block truncate text-xs text-textcolor2">{item.agoText}</span>
                                </span>
                            </button>
                        {/each}
                    </div>
                {:else}
                    <div
                        class="rounded-xl border border-dashed border-darkborderc bg-darkbg/60 px-4 py-3 text-sm text-textcolor2"
                    >
                        {language.homeRecentCharactersEmpty}
                    </div>
                {/if}
            </section>

            <section class="mt-7" aria-labelledby="home-more-title" data-risu-home-section="more">
                <div class="mb-3 flex items-center gap-2">
                    <LayoutGridIcon size={18} aria-hidden="true" />
                    <h2 id="home-more-title" class="text-lg font-bold">{language.homeMore}</h2>
                </div>
                <div class="flex flex-col gap-3">
                    {#if !settings.ui.hideRealm}
                        {@render moreCard(
                            "realm",
                            Globe2Icon,
                            language.openRisuRealm,
                            language.homeExploreRealmDescription,
                            () => ($OpenRealmStore = true),
                        )}
                    {/if}
                    {@render moreCard(
                        "import-character",
                        ImportIcon,
                        language.importCharacter,
                        language.homeImportCharacterDescription,
                        () => void importCharacterAndSelect(),
                    )}
                    {@render moreCard(
                        "remote-host",
                        MonitorSmartphoneIcon,
                        language.serverJob.remoteHost.start,
                        language.serverJob.remoteHost.startDescription,
                        () => hostMode.set(true),
                    )}
                </div>
            </section>
        {:else}
            <div class="flex items-center mt-4">
                <button
                    class="mr-2 text-textcolor2 hover:text-green-500"
                    aria-label={language.goback}
                    onclick={() => ($OpenRealmStore = false)}
                >
                    <ArrowLeft aria-hidden="true" />
                </button>
            </div>
            <Hub />
        {/if}
    </div>
</div>
