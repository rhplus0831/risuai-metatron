<script lang="ts">
    import { language } from "src/lang";
    import { upstreamImportReportStore } from "src/ts/alert";
    import { alertStore } from "src/ts/stores.svelte";
    import Button from "../../UI/GUI/Button.svelte";
    import type { UpstreamImportCounts, UpstreamReportEntry } from "../../../../shared/upstreamBackup.ts";

    /**
     * The `upstreamImportReport` dialog (`alertUpstreamImportReport`): what a prepared upstream RisuAI
     * import holds, converted, and left out, and the full-replace warning, before anything is replaced.
     * Restore and Cancel answer this dialog's own callback.
     */

    /** How many missing assets are listed; the rest are counted. */
    const MISSING_SHOWN = 50;
    const countOrder: (keyof UpstreamImportCounts)[] = [
        "characters",
        "groups",
        "chats",
        "messages",
        "promptPresets",
        "modelPresets",
        "modelProfiles",
        "credentials",
        "personas",
        "customModels",
        "modules",
        "plugins",
    ];

    const dialog = $derived($upstreamImportReportStore);
    const report = $derived(dialog?.report);
    const text = language.upstreamImport;

    function answer(restore: boolean) {
        dialog?.answer(restore);
        alertStore.set({ type: "none", msg: "" });
    }

    function entryText(labels: Record<string, string>, entry: UpstreamReportEntry): string {
        return `${labels[entry.code] ?? entry.code} (${entry.count})`;
    }
</script>

{#if report}
    <div class="fixed inset-0 z-50 bg-black/80 flex justify-center items-start overflow-y-auto p-4">
        <div
            class="bg-darkbg rounded-lg w-full max-w-3xl my-4 flex flex-col max-h-[90vh]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="upstream-import-title"
        >
            <div class="p-4 border-b border-darkborderc">
                <h1 id="upstream-import-title" class="text-xl font-bold text-textcolor">{text.title}</h1>
                <p class="text-textcolor2 text-sm mt-1">{text.intro}</p>
            </div>
            <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4 text-textcolor">
                {#if dialog && dialog.changedWrites !== null}
                    <p class="text-draculared text-sm">{text.changedSinceReview(dialog.changedWrites)}</p>
                {/if}
                <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
                    {#each countOrder as key (key)}
                        {#if report.counts[key] > 0 || key === "characters" || key === "chats"}
                            <div class="flex justify-between gap-2">
                                <dt class="text-textcolor2">{text.counts[key]}</dt>
                                <dd>{report.counts[key]}</dd>
                            </div>
                        {/if}
                    {/each}
                </dl>

                {#if report.converted.length > 0}
                    <section>
                        <h2 class="font-semibold mb-1">{text.convertedTitle}</h2>
                        <ul class="list-disc pl-5 text-sm flex flex-col gap-1">
                            {#each report.converted as entry (entry.code)}
                                <li>
                                    {entryText(text.converted, entry)}
                                    {#if entry.examples.length > 0}
                                        <span class="text-textcolor2">{text.examples} {entry.examples.join(", ")}</span>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    </section>
                {/if}

                {#if report.excluded.length > 0}
                    <section>
                        <h2 class="font-semibold mb-1">{text.excludedTitle}</h2>
                        <ul class="list-disc pl-5 text-sm flex flex-col gap-1">
                            {#each report.excluded as entry (entry.code)}
                                <li>
                                    {entryText(text.excluded, entry)}
                                    {#if entry.examples.length > 0}
                                        <span class="text-textcolor2">{text.examples} {entry.examples.join(", ")}</span>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    </section>
                {/if}

                {#if report.missingAssets.length > 0}
                    <section>
                        <h2 class="font-semibold mb-1">
                            {text.missingTitle} ({report.missingAssets.length})
                        </h2>
                        {#if report.missingAssets.some((asset) => asset.expected)}
                            <p class="text-textcolor2 text-sm mb-1">{text.missingExpected}</p>
                        {/if}
                        <ul class="list-disc pl-5 text-sm flex flex-col gap-1 break-any">
                            {#each report.missingAssets.slice(0, MISSING_SHOWN) as asset, index (index)}
                                <li>
                                    {asset.owner || text.settingOwner}: {text.roles[asset.role] ?? asset.role}
                                    <span class="text-textcolor2">{asset.key}</span>
                                    {#if asset.expected}
                                        <span class="text-textcolor2">({text.expectedTag})</span>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                        {#if report.missingAssets.length > MISSING_SHOWN}
                            <p class="text-textcolor2 text-sm mt-1">
                                {text.missingMore(report.missingAssets.length - MISSING_SHOWN)}
                            </p>
                        {/if}
                    </section>
                {/if}

                <p class="text-draculared text-sm">{text.warning}</p>
            </div>
            <div class="flex gap-2 p-4 border-t border-darkborderc">
                <Button className="grow" styled="outlined" onclick={() => answer(false)}>{text.cancel}</Button>
                <Button className="grow" styled="danger" onclick={() => answer(true)}>{text.restore}</Button>
            </div>
        </div>
    </div>
{/if}
