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
    } from "src/ts/stores.svelte";

    /**
     * Heading and tabs shared by `src/lib/Setting/Pages/ModelSettings.svelte`,
     * `src/lib/Setting/Pages/ModelProfilesSettings.svelte` (Connections), and
     * `src/lib/Setting/Pages/ApiKeysSettings.svelte`. One sidebar entry covers their three menu indexes;
     * selecting a tab sets `SettingsMenuIndex`, so each can also be opened directly.
     */

    const tabs = $derived([
        { menu: MODEL_SETTINGS_MENU, label: language.modelPresetTab },
        { menu: MODEL_PROFILES_SETTINGS_MENU, label: language.modelProfiles.title },
        { menu: API_KEYS_SETTINGS_MENU, label: language.apiKeys },
    ]);
    const selected = $derived($SettingsMenuIndex);
    let bar: HTMLDivElement;

    function select(menu: number) {
        if (menu === selected) return;
        $SettingsMenuIndex = menu;
        refocus = true;
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
