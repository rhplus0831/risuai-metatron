<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import Hub from "./Realm/RealmMain.svelte";
    import { gridOpenStore, OpenRealmStore } from "src/ts/stores.svelte";
    import { ArrowLeft, ChevronRightIcon, Globe2Icon, UsersIcon } from "@lucide/svelte";
    import { getVersionString } from "src/ts/globalApi.svelte";
    import { language } from "src/lang";
    import { changeChar, getCharImage } from "src/ts/characters";
    import { onMount } from "svelte";
    import Title from "./Title.svelte";
    import { collectHomeRecentCharacters } from "./mainMenuProjection";

    const agoFormatter = new Intl.RelativeTimeFormat(navigator.languages, { style: "short" });

    let relativeTimeNow = $state(Date.now());
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

<div class="h-full w-full flex flex-col overflow-y-auto items-center">
    {#if !$OpenRealmStore}
        <Title />
        <h3 class="text-textcolor2 mt-1">Version {getVersionString()}</h3>
    {/if}
    <div class="w-full flex p-4 pb-8 flex-col text-textcolor max-w-4xl">
        {#if !$OpenRealmStore}
            <div class="mt-4 mb-5 w-full border-t border-t-selected"></div>

            <section aria-labelledby="home-recent-characters-title" data-risu-home-section="recent-characters">
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
                                {#await getCharImage(item.image, "plain")}
                                    <span
                                        class="h-11 w-11 shrink-0 animate-pulse rounded-lg bg-selected"
                                        aria-hidden="true"
                                    ></span>
                                {:then imageSource}
                                    <img
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

            {#if !settings.ui.hideRealm}
                <section class="mt-7" aria-labelledby="home-explore-title" data-risu-home-section="explore">
                    <div class="mb-3 flex items-center gap-2">
                        <Globe2Icon size={18} aria-hidden="true" />
                        <h2 id="home-explore-title" class="text-lg font-bold">{language.homeExplore}</h2>
                    </div>
                    <button
                        type="button"
                        class="group flex w-full items-center gap-4 rounded-xl border border-darkborderc bg-darkbg px-5 py-4 text-left shadow-sm transition-colors hover:border-green-500 hover:bg-selected focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-500"
                        onclick={() => ($OpenRealmStore = true)}
                    >
                        <span
                            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-selected text-textcolor"
                        >
                            <Globe2Icon size={22} aria-hidden="true" />
                        </span>
                        <span class="min-w-0 grow">
                            <span class="block text-lg font-bold">{language.openRisuRealm}</span>
                            <span class="mt-0.5 block text-sm text-textcolor2"
                                >{language.homeExploreRealmDescription}</span
                            >
                        </span>
                        <ChevronRightIcon
                            size={20}
                            class="shrink-0 text-textcolor2 transition-transform group-hover:translate-x-0.5"
                            aria-hidden="true"
                        />
                    </button>
                </section>
            {/if}
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
