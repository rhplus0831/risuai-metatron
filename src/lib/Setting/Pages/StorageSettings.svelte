<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { storageSettingsHeader, storageSettingsSections } from "src/ts/setting/storageSettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";
    import { StorageController } from "./Storage/storageController.svelte";
    import { setStorageController } from "./Storage/storageContext";

    /** The page owns report loading and polling; collapsible sections share its controller. */
    const controller = new StorageController();
    setStorageController(controller);
    onMount(() => {
        void controller.load();
    });
    onDestroy(controller.dispose);
</script>

<SettingRenderer items={storageSettingsHeader} />
<SettingsSections sections={storageSettingsSections} />
