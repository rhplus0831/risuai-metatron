<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { getStorageController } from "./storageContext";

    const controller = getStorageController();
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={controller.busy || controller.running} onclick={controller.scan}
            >{language.storage.scan}</Button
        >
        {#if controller.loading}<span class="text-textcolor2">{language.storage.loading}</span>{/if}
        {#if controller.running}<span role="status" class="text-textcolor2">{language.storage.scanning}</span>{/if}
    </div>
    {#if controller.error}
        <p role="alert" class="text-draculared whitespace-pre-wrap break-all">{controller.error}</p>
    {/if}
    {#if controller.report}
        <p class="text-textcolor2">
            {#if controller.report.generatedAt !== null}
                {language.storage.generatedAt}: {controller.date(controller.report.generatedAt)}
            {:else}
                {language.storage.noScanYet}
            {/if}
        </p>
        {#if controller.incomplete}
            <div class="rounded-md border border-darkborderc bg-darkbg p-2">
                <p>{language.storage.incomplete}</p>
                <ul class="max-h-64 overflow-auto list-disc pl-5">
                    {#each controller.report.reasons as reason}<li class="break-all">{reason}</li>{/each}
                </ul>
            </div>
        {/if}
    {/if}
</div>
