<script lang="ts">
    import { language } from "src/lang";
    import { getStorageController } from "./storageContext";
    import { getStorageCards, getStorageSegments, type StorageUsageKind } from "./storageUsage";

    const controller = getStorageController();
    const usage = $derived(controller.report ? getStorageSegments(controller.report) : null);
    const cards = $derived(controller.report ? getStorageCards(controller.report) : null);
    const colors: Record<StorageUsageKind, string> = {
        assetsOnDisk: "bg-primary-500",
        resourcesDb: "bg-secondary-500",
        snapshots: "bg-success-500",
        thumbnails: "bg-primary-300",
        staging: "bg-danger-400",
        unmanaged: "bg-secondary-300",
        outside: "storage-outside",
        free: "bg-neutral-200",
    };
    const labels = $derived({
        ...language.storage,
        outside: language.storagePage.overview.outside,
        free: language.storagePage.overview.free,
    });
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    {#if usage && cards}
        <div class="flex h-6 w-full overflow-hidden rounded-md border border-darkborderc bg-darkbg" aria-hidden="true">
            {#each usage.segments as segment (segment.kind)}
                <div class="h-full shrink-0 {colors[segment.kind]}" style:width={`${segment.fraction * 100}%`}></div>
            {/each}
        </div>
        <ul class="grid min-w-0 gap-x-6 gap-y-2 sm:grid-cols-2">
            {#each usage.segments as segment (segment.kind)}
                <li class="min-w-0">
                    <div class="flex items-baseline gap-2">
                        <span class="h-3 w-3 shrink-0 self-center rounded-sm {colors[segment.kind]}" aria-hidden="true"
                        ></span>
                        <span class="min-w-0 flex-1 break-words">{labels[segment.kind]}</span>
                        <span class="shrink-0 tabular-nums">{controller.formatBytes(segment.bytes)}</span>
                    </div>
                    {#if segment.kind === "outside"}
                        <p class="mt-1 pl-5 text-xs text-textcolor2 break-words">
                            {language.storagePage.overview.outsideHelp}
                        </p>
                    {/if}
                </li>
            {/each}
        </ul>
        {#if usage.diskUnknown}
            <p class="text-textcolor2">{language.storagePage.overview.diskUnknown}</p>
        {/if}
        <div class="grid min-w-0 gap-2 sm:grid-cols-3">
            <div class="min-w-0 rounded-md border border-darkborderc bg-darkbg p-3 break-words">
                <p class="text-textcolor2">{language.storagePage.overview.reclaimable}</p>
                <p class="mt-1 text-xl font-semibold tabular-nums">{controller.formatBytes(cards.reclaimable)}</p>
            </div>
            <div class="min-w-0 rounded-md border border-darkborderc bg-darkbg p-3 break-words">
                <p class="text-textcolor2">{language.storagePage.overview.snapshotsCard}</p>
                <p class="mt-1 text-xl font-semibold tabular-nums">{controller.formatBytes(cards.snapshots.bytes)}</p>
                <p class="text-textcolor2">{language.storagePage.overview.snapshotCount(cards.snapshots.count)}</p>
            </div>
            <div class="min-w-0 rounded-md border border-darkborderc bg-darkbg p-3 break-words">
                <p class="text-textcolor2">{language.storagePage.overview.dedupeSaved}</p>
                <p class="mt-1 text-xl font-semibold tabular-nums">{controller.formatBytes(cards.dedupeSaved)}</p>
            </div>
        </div>
    {/if}
    {#if controller.report}
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

<style>
    .storage-outside {
        background: repeating-linear-gradient(
            135deg,
            var(--risu-theme-neutral-600) 0 4px,
            var(--risu-theme-neutral-400) 4px 6px
        );
    }
</style>
