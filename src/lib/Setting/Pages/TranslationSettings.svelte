<script lang="ts">
    import { translationSettingsHeader, translationSettingsSections } from "src/ts/setting/translationSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";
</script>

<SettingRenderer items={translationSettingsHeader} itemSpacing />
<SettingsSections sections={translationSettingsSections} itemSpacing />
