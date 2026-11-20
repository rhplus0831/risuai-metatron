<script lang="ts">
    import { advancedSettingsHeader, advancedSettingsSections } from "src/ts/setting/advancedSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";
</script>

<SettingRenderer items={advancedSettingsHeader} />
<SettingsSections sections={advancedSettingsSections} />
