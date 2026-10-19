<script lang="ts">
    import { language } from "src/lang";
    import { SettingsMenuIndex } from "src/ts/stores.svelte";
    import {
        accessibilitySettingsHeader,
        accessibilitySettingsSections,
    } from "src/ts/setting/accessibilitySettingsData";
    import { requestDisplayTab } from "src/ts/setting/displaySettingsData.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";
</script>

<SettingRenderer items={accessibilitySettingsHeader} />
<SettingsSections sections={accessibilitySettingsSections} />

<!-- Text, icon and input sizes live on Display's Layout & sizing tab (menu 3). -->
<button
    class="mt-6 self-start text-left text-sm text-textcolor2 underline hover:text-textcolor"
    onclick={() => {
        requestDisplayTab("layout");
        $SettingsMenuIndex = 3;
    }}>{language.accessibilityDisplaySizesLink}</button
>
