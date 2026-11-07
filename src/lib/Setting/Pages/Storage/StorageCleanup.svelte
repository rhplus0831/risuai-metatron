<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import StorageCleanupRow from "./StorageCleanupRow.svelte";
    import { cleanupAssetKind, type AssetKind } from "./storageCleanup";
    import { getStorageController } from "./storageContext";

    /** Filters affect visible rows and select-all, while summaries include every selected row. */
    const controller = getStorageController();
    const kinds = ["all", "image", "audio", "video", "other"] as const;
    let filter: AssetKind | "all" = $state("all");
    let sort: "size" | "age" = $state("size");
    const disabled = $derived(controller.busy || controller.running);
    const assets = $derived(controller.report?.unreferenced.candidates ?? []);
    const inlays = $derived(controller.report?.orphanInlays.records ?? []);
    const counts = $derived.by(() => {
        const result = { all: assets.length + inlays.length, image: 0, audio: 0, video: 0, other: 0 };
        for (const item of assets) result[cleanupAssetKind(item.key)]++;
        for (const item of inlays) result[cleanupAssetKind(item.asset)]++;
        return result;
    });
    function compare(a: { bytes: number; since: number | null }, b: { bytes: number; since: number | null }) {
        if (sort === "size") return b.bytes - a.bytes;
        if (a.since === null) return b.since === null ? 0 : 1;
        if (b.since === null) return -1;
        return a.since - b.since;
    }
    const visibleAssets = $derived(
        assets.filter((item) => filter === "all" || cleanupAssetKind(item.key) === filter).sort(compare),
    );
    const visibleInlays = $derived(
        inlays.filter((item) => filter === "all" || cleanupAssetKind(item.asset) === filter).sort(compare),
    );
    const selectedKeys = $derived(new Set(controller.selectedKeys));
    const selectedInlays = $derived(new Set(controller.selectedInlays));
    const selectedInlayBytes = $derived(
        inlays.reduce((sum, item) => sum + (selectedInlays.has(item.id) ? item.bytes : 0), 0),
    );

    function selectAsset(key: string, checked: boolean) {
        if (disabled) return;
        controller.selectedKeys = checked
            ? [...new Set([...controller.selectedKeys, key])]
            : controller.selectedKeys.filter((item) => item !== key);
    }

    function selectInlay(id: string, checked: boolean) {
        if (disabled) return;
        controller.selectedInlays = checked
            ? [...new Set([...controller.selectedInlays, id])]
            : controller.selectedInlays.filter((item) => item !== id);
    }
</script>

{#snippet summary(
    count: number,
    bytes: number,
    selectAll: () => void,
    clear: () => void,
    remove: () => unknown,
    deleteLabel: string,
)}
    <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" {disabled} onclick={selectAll}>{language.storagePage.cleanup.selectAll}</Button>
        <Button size="sm" disabled={disabled || !count} onclick={clear}>{language.storagePage.cleanup.clear}</Button>
        <span class="min-w-0 text-textcolor2"
            >{language.storagePage.cleanup.selected(count, controller.formatBytes(bytes))}</span
        >
        <button
            type="button"
            class="max-w-full rounded-md border border-danger-600 bg-danger-700 px-2 py-1 text-sm text-textcolor hover:bg-danger-600 focus-visible:outline-2 focus-visible:outline-danger-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={controller.sweepDisabled || !count}
            onclick={remove}>{deleteLabel}</button
        >
    </div>
{/snippet}

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    {#if controller.report}
        <div class="flex min-w-0 flex-wrap items-center gap-3">
            <div class="flex flex-wrap gap-1" role="group" aria-label={language.storagePage.cleanup.filterKind}>
                {#each kinds as kind}
                    <button
                        type="button"
                        class="rounded-full border border-darkborderc px-3 py-1 text-textcolor hover:bg-selected focus-visible:outline-2 focus-visible:outline-selected"
                        class:bg-bg-selected={filter === kind}
                        class:bg-darkbutton={filter !== kind}
                        aria-pressed={filter === kind}
                        onclick={() => (filter = kind)}
                        >{language.storagePage.cleanup.kinds[kind]} ({counts[kind]})</button
                    >
                {/each}
            </div>
            <label class="flex min-w-0 max-w-full items-center gap-2 text-textcolor2">
                {language.storagePage.cleanup.sortBy}
                <select
                    bind:value={sort}
                    class="min-w-0 rounded-md border border-darkborderc bg-darkbg p-1 text-textcolor"
                >
                    <option value="size">{language.storagePage.cleanup.sortSize}</option>
                    <option value="age">{language.storagePage.cleanup.sortAge}</option>
                </select>
            </label>
        </div>
        <section
            class="flex min-w-0 flex-col gap-3"
            data-storage-cleanup-list="assets"
            aria-label={language.storage.candidates}
        >
            <h3 class="font-semibold">{language.storage.candidates}</h3>
            {@render summary(
                controller.selectedKeys.length,
                controller.selectedBytes,
                () => {
                    controller.selectedKeys = visibleAssets.map((item) => item.key);
                },
                () => {
                    controller.selectedKeys = [];
                },
                controller.deleteAssets,
                language.storage.deleteAssets,
            )}
            <div class="max-h-64 min-w-0 overflow-y-auto rounded-md border border-darkborderc bg-darkbg">
                {#each visibleAssets as candidate (candidate.key)}
                    <StorageCleanupRow
                        assetKey={candidate.key}
                        value={candidate.key}
                        bytes={candidate.bytes}
                        since={candidate.since}
                        generatedAt={controller.report.generatedAt}
                        checked={selectedKeys.has(candidate.key)}
                        {disabled}
                        onchange={(checked) => selectAsset(candidate.key, checked)}
                    />
                {:else}
                    <p class="p-2 text-textcolor2">
                        {assets.length ? language.storagePage.cleanup.noMatches : language.storage.emptyCandidates}
                    </p>
                {/each}
            </div>
            {#if controller.report.unreferenced.total > controller.report.unreferenced.candidates.length}
                <p class="text-textcolor2">
                    {language.storage.showing(
                        controller.report.unreferenced.candidates.length,
                        controller.report.unreferenced.total,
                    )}
                </p>
            {/if}
            {#if controller.assetResult}
                <p role="status">
                    {language.storage.deleteResult(
                        controller.assetResult.deleted.length,
                        controller.formatBytes(controller.assetResult.freedBytes),
                    )}
                </p>
                {#if controller.assetResult.skipped.length}
                    <p>{language.storage.skippedAssets}</p>
                    <ul class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg p-2">
                        {#each controller.assetResult.skipped as item}<li class="break-all">
                                {item.key}: {item.reason}
                            </li>{/each}
                    </ul>
                {/if}
            {/if}
        </section>

        <section
            class="flex min-w-0 flex-col gap-3"
            data-storage-cleanup-list="inlays"
            aria-label={language.storage.orphanInlays}
        >
            <h3 class="font-semibold">{language.storage.orphanInlays}</h3>
            <p class="text-textcolor2">{language.storage.inlayGraceNote}</p>
            {@render summary(
                controller.selectedInlays.length,
                selectedInlayBytes,
                () => {
                    controller.selectedInlays = visibleInlays.map((item) => item.id);
                },
                () => {
                    controller.selectedInlays = [];
                },
                controller.deleteInlays,
                language.storage.deleteInlays,
            )}
            <div class="max-h-64 min-w-0 overflow-y-auto rounded-md border border-darkborderc bg-darkbg">
                {#each visibleInlays as inlay (inlay.id)}
                    <StorageCleanupRow
                        assetKey={inlay.asset}
                        value={inlay.id}
                        inlayId={inlay.id}
                        bytes={inlay.bytes}
                        since={inlay.since}
                        generatedAt={controller.report.generatedAt}
                        checked={selectedInlays.has(inlay.id)}
                        {disabled}
                        onchange={(checked) => selectInlay(inlay.id, checked)}
                    />
                {:else}
                    <p class="p-2 text-textcolor2">
                        {inlays.length ? language.storagePage.cleanup.noMatches : language.storage.emptyInlays}
                    </p>
                {/each}
            </div>
            <p class="text-textcolor2">
                {language.storage.showing(
                    controller.report.orphanInlays.records.length,
                    controller.report.orphanInlays.total,
                )}
            </p>
            {#if controller.inlayResult}
                <p role="status">{language.storage.deleteInlaysResult(controller.inlayResult.removedInlays.length)}</p>
                {#if controller.inlayResult.skippedInlays.length}
                    <p>{language.storage.skippedInlays}</p>
                    <ul class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg p-2">
                        {#each controller.inlayResult.skippedInlays as item}<li class="break-all">
                                {item.id}: {item.reason}
                            </li>{/each}
                    </ul>
                {/if}
            {/if}
        </section>
    {/if}
</div>
