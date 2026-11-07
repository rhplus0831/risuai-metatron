<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
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

<div class="flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3">
    <div class="min-w-0 flex-1 basis-64 break-words">
        <SettingRenderer items={storageSettingsHeader} />
    </div>
    <div class="flex min-w-0 flex-wrap items-center gap-2 text-sm text-textcolor">
        {#if controller.report}
            <p class="text-textcolor2 break-words">
                {#if controller.report.generatedAt != null}
                    {language.storage.generatedAt}: {controller.date(controller.report.generatedAt)}
                {:else}
                    {language.storage.noScanYet}
                {/if}
            </p>
        {/if}
        <Button size="sm" disabled={controller.busy || controller.running} onclick={controller.scan}
            >{language.storage.scan}</Button
        >
        {#if controller.loading}<span class="text-textcolor2">{language.storage.loading}</span>{/if}
        {#if controller.running}<span role="status" class="text-textcolor2">{language.storage.scanning}</span>{/if}
    </div>
    {#if controller.error}
        <p role="alert" class="w-full text-sm text-draculared whitespace-pre-wrap break-all">{controller.error}</p>
    {/if}
</div>
<SettingsSections sections={storageSettingsSections} />
