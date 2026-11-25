<script lang="ts">
    import { getStorageController } from "./storageContext";

    const controller = getStorageController();
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    {#if controller.report}
        <dl class="grid gap-2 sm:grid-cols-2">
            {#each controller.totals as [label, value]}
                <div class="flex flex-wrap justify-between gap-x-3 rounded-md bg-darkbg p-2">
                    <dt class="text-textcolor2">{label}</dt>
                    <dd>{value}</dd>
                </div>
            {/each}
        </dl>
    {/if}
</div>
