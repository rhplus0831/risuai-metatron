<script lang="ts">
    import { editedMainProfile, type ModelProfileView } from "src/ts/storage/settingsViews.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { chatFormatSettingsItems } from "src/ts/setting/chatFormatSettingsData";
    interface Props {
        profile?: ModelProfileView;
    }
    let { profile = editedMainProfile }: Props = $props();
</script>

<SettingRenderer items={chatFormatSettingsItems} modelProfile={profile} />
