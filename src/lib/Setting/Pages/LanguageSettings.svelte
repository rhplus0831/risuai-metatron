<script lang="ts">
    import { languageSettingsItems } from "src/ts/setting/languageSettingsData.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";

    /** UI language only; translator controls live in `src/lib/Setting/Pages/TranslationSettings.svelte`. */
</script>

<SettingRenderer items={languageSettingsItems} />
