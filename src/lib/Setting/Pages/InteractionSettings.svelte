<script lang="ts">
    import { interactionSettingsHeader, interactionSettingsSections } from "src/ts/setting/interactionSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";
</script>

<SettingRenderer items={interactionSettingsHeader} />
<SettingsSections sections={interactionSettingsSections} />
