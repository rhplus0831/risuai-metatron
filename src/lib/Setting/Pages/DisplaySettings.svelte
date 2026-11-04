<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import { languageText } from "src/ts/setting/utils";
    import SettingsSections from "../SettingsSections.svelte";
    import {
        displaySettingsSections,
        displaySettingsTabs,
        takeRequestedDisplayTab,
    } from "src/ts/setting/displaySettingsData.svelte";

    /**
     * Heading/tab bar and the selected tab's sections. At mount, consume `takeRequestedDisplayTab`
     * from `src/ts/setting/displaySettingsData.svelte.ts`, defaulting to Theme. `useLegacyGUI`, also
     * read at mount, removes the tab bar and stacks `displaySettingsSections` in tab order (-1).
     */

    const requestedTab = takeRequestedDisplayTab();
    let submenu = $state(settings.ui.useLegacyGUI ? -1 : requestedTab);
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.display}</h2>

{#if submenu !== -1}
    <!-- Four columns, or two rows of two on a phone; the hairlines are the grid's gaps. -->
    <div
        class="mb-4 grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-md border border-darkborderc bg-darkborderc sm:grid-cols-4"
    >
        {#each displaySettingsTabs as tab, index (tab.id)}
            <button
                onclick={() => {
                    submenu = index;
                }}
                class="min-h-12 p-2"
                class:bg-bgcolor={submenu !== index}
                class:bg-darkbutton={submenu === index}
                aria-pressed={submenu === index}
            >
                <span>{languageText(tab.labelKey)}</span>
            </button>
        {/each}
    </div>
    <SettingsSections sections={displaySettingsTabs[submenu].sections} />
{:else}
    <SettingsSections sections={displaySettingsSections} />
{/if}
