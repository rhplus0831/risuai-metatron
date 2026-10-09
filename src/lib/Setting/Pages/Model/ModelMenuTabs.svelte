<script module lang="ts">
    // Switching tabs remounts the page (`Settings.svelte` keys it by the menu index), so the
    // clicked tab is a new element: the new tab bar takes the focus back.
    let refocus = false;
</script>

<script lang="ts">
    import { onMount } from "svelte";
    import { language } from "src/lang";
    import {
        API_KEYS_SETTINGS_MENU,
        MODEL_PROFILES_SETTINGS_MENU,
        MODEL_SETTINGS_MENU,
        SettingsMenuIndex,
        settingsOpen,
    } from "src/ts/stores.svelte";

    interface Props {
        /** In the quick settings panel, which shows only the Preset tab: the other tabs open the settings screen. */
        quick?: boolean;
    }

    let { quick = false }: Props = $props();

    /**
     * The Model menu's heading and tabs: the model preset (`ModelSettings`), the connections
     * (`ModelProfilesSettings`), and the API keys (`ApiKeysSettings`). Each tab keeps its own menu
     * index, so a caller can still open one tab directly.
     */
    const tabs = $derived([
        { menu: MODEL_SETTINGS_MENU, label: language.modelPresetTab },
        { menu: MODEL_PROFILES_SETTINGS_MENU, label: language.modelProfiles.title },
        { menu: API_KEYS_SETTINGS_MENU, label: language.apiKeys },
    ]);
    const selected = $derived(quick ? MODEL_SETTINGS_MENU : $SettingsMenuIndex);
    let bar: HTMLDivElement;

    function select(menu: number) {
        if (menu === selected) return;
        $SettingsMenuIndex = menu;
        if (quick) {
            settingsOpen.set(true);
        } else {
            refocus = true;
        }
    }

    onMount(() => {
        if (!refocus) return;
        refocus = false;
        bar.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    });
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.model}</h2>

<div class="flex w-full rounded-md border border-darkborderc mb-4" bind:this={bar}>
    {#each tabs as tab, i (tab.menu)}
        <button
            aria-pressed={selected === tab.menu}
            onclick={() => select(tab.menu)}
            class="p-2 flex-1"
            class:border-r={i < tabs.length - 1}
            class:border-darkborderc={i < tabs.length - 1}
            class:bg-darkbutton={selected === tab.menu}
        >
            <span>{tab.label}</span>
        </button>
    {/each}
</div>
