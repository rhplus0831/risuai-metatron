<script lang="ts">
    import { deviceLinkSettingsHeader, deviceLinkSettingsSections } from "src/ts/setting/deviceLinkSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";

    /** The header items, then each section of `deviceLinkSettingsSections` with a rule between them. */
</script>

<SettingRenderer items={deviceLinkSettingsHeader} itemSpacing />
{#each deviceLinkSettingsSections as section, index (section.id)}
    {#if index > 0}
        <hr class="mt-6 border-darkborderc" />
    {/if}
    <SettingsSections sections={[section]} itemSpacing />
{/each}
