<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { getStorageController } from "./storageContext";

    const controller = getStorageController();
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    {#if controller.report}
        <h3 class="font-semibold">{language.storage.candidates}</h3>
        <div class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
            {#each controller.report.unreferenced.candidates as candidate (candidate.key)}
                <label class="flex items-start gap-2 border-b border-darkborderc p-2">
                    <input
                        type="checkbox"
                        value={candidate.key}
                        bind:group={controller.selectedKeys}
                        disabled={controller.busy || controller.running}
                    />
                    <span class="min-w-0 break-all">
                        <span class="block">{candidate.key}</span>
                        <span class="text-textcolor2"
                            >{controller.formatBytes(candidate.bytes)} · {language.storage.since}: {controller.date(
                                candidate.since,
                            )}</span
                        >
                    </span>
                </label>
            {:else}
                <p class="p-2 text-textcolor2">{language.storage.emptyCandidates}</p>
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
        <div>
            <Button
                size="sm"
                disabled={controller.sweepDisabled || !controller.selectedKeys.length}
                onclick={controller.deleteAssets}>{language.storage.deleteAssets}</Button
            >
        </div>
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

        <h3 class="font-semibold">{language.storage.orphanInlays}</h3>
        <p class="text-textcolor2">{language.storage.inlayGraceNote}</p>
        <div class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
            {#each controller.report.orphanInlays.records as inlay (inlay.id)}
                <label class="flex items-start gap-2 border-b border-darkborderc p-2">
                    <input
                        type="checkbox"
                        value={inlay.id}
                        bind:group={controller.selectedInlays}
                        disabled={controller.busy || controller.running}
                    />
                    <span class="min-w-0 break-all">
                        <span class="block">{language.storage.inlayId}: {inlay.id}</span>
                        <span class="block">{language.storage.assetKey}: {inlay.asset ?? language.storage.none}</span>
                        <span class="text-textcolor2"
                            >{controller.formatBytes(inlay.bytes)} · {language.storage.since}: {inlay.since === null
                                ? language.storage.missingValue
                                : controller.date(inlay.since)}</span
                        >
                    </span>
                </label>
            {:else}
                <p class="p-2 text-textcolor2">{language.storage.emptyInlays}</p>
            {/each}
        </div>
        <p class="text-textcolor2">
            {language.storage.showing(
                controller.report.orphanInlays.records.length,
                controller.report.orphanInlays.total,
            )}
        </p>
        <div>
            <Button
                size="sm"
                disabled={controller.sweepDisabled || !controller.selectedInlays.length}
                onclick={controller.deleteInlays}>{language.storage.deleteInlays}</Button
            >
        </div>
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
    {/if}
</div>
