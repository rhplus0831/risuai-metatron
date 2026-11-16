<script lang="ts">
    import { deviceLinkSettingsHeader, deviceLinkSettingsSections } from "src/ts/setting/deviceLinkSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";
</script>

<SettingRenderer items={deviceLinkSettingsHeader} />
<SettingsSections sections={deviceLinkSettingsSections} />
