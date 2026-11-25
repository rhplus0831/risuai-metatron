<script lang="ts">
    import { language } from "src/lang";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { SaveIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { saving } from "src/ts/globalApi.svelte";
    import { unconfirmedSave } from "src/ts/storage/resourceSync.svelte";
</script>

{#if unconfirmedSave.state}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Allow keyboard users to reveal the save status tooltip.) -->
    <div
        class="group pointer-events-auto absolute top-3 right-3 z-10 rounded-sm bg-draculared p-2 text-white"
        role="status"
        tabindex="0"
        title={language.resourceSaveUnconfirmed}
        aria-label={language.resourceSaveUnconfirmed}
    >
        <TriangleAlertIcon size={24} aria-hidden="true" />
        <span
            class="absolute top-full right-0 mt-1 hidden w-56 max-w-[calc(100vw-2rem)] rounded-sm border border-darkborderc bg-darkbg p-2 text-sm text-textcolor group-focus-visible:block"
            aria-hidden="true"
        >
            {language.resourceSaveUnconfirmed}
        </span>
    </div>
{:else if settings.ui.showSavingIcon && saving.state}
    <div
        class="absolute top-3 right-3 z-10 text-white p-2 rounded-sm bg-linear-to-br from-blue-500 to-purple-800 saving-animation pointer-events-none opacity-15"
    >
        <SaveIcon size={24} />
    </div>
{/if}
