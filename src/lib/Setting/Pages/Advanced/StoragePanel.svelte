<script lang="ts">
    import { onMount } from "svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { alertConfirm, alertNormalWait } from "src/ts/alert";
    import { readStorageReport, startStorageScan, sweepAssets } from "src/ts/storage/assetLifecycleClient";
    import {
        listBackups,
        takeSnapshot,
        updateSnapshot,
        deleteSnapshot,
        restoreBackup,
        ResourceEpochMismatchError,
    } from "src/ts/storage/resourceClient";
    import type { AssetLifecycleReport, AssetSweepResult } from "../../../../../shared/assetLifecycle.ts";

    /**
     * Settings → Advanced → Storage reads the retention report and live snapshots on mount without
     * writing settings or resource records. Scans poll every second until finished; cleanup sends
     * explicit, confirmed asset or inlay selections and requires a complete run. Snapshot controls
     * refresh the live list, while held bytes come from the last report. Snapshot actions wait until
     * scans and sweeps finish. Button requests are serialized, server errors are shown unchanged,
     * and a successful restore reloads the app. Unmount stops polling.
     */

    let report: AssetLifecycleReport | null = $state(null);
    let snapshots: Awaited<ReturnType<typeof listBackups>> = $state([]);
    let loading = $state(true);
    let busy = $state(true);
    let error = $state("");
    let selectedKeys: string[] = $state([]);
    let selectedInlays: string[] = $state([]);
    let assetResult: AssetSweepResult | null = $state(null);
    let inlayResult: AssetSweepResult | null = $state(null);
    let snapshotLabel = $state("");
    let editingLabel: string | null = $state(null);
    let labelText = $state("");
    let disposed = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const running = $derived(report?.running ?? false);
    const incomplete = $derived(report?.generatedAt != null && !report.complete);
    const sweepDisabled = $derived(busy || running || report?.generatedAt == null || !report?.complete);
    const owners = $derived([...(report?.owners ?? [])].sort((a, b) => b.bytes - a.bytes));
    const selectedBytes = $derived.by(() => {
        const keys = new Set(selectedKeys);
        return (
            report?.unreferenced.candidates.reduce((total, item) => total + (keys.has(item.key) ? item.bytes : 0), 0) ??
            0
        );
    });
    const totals = $derived(
        report
            ? [
                  [language.storage.diskFree, report.disk ? formatBytes(report.disk.free) : language.storage.unknown],
                  [language.storage.diskTotal, report.disk ? formatBytes(report.disk.total) : language.storage.unknown],
                  [language.storage.assetsOnDisk, formatBytes(report.usage.assetsOnDisk)],
                  [language.storage.resourcesDb, formatBytes(report.usage.resourcesDb)],
                  [language.storage.snapshots, formatBytes(report.usage.snapshots)],
                  [language.storage.thumbnails, formatBytes(report.usage.thumbnails)],
                  [language.storage.staging, formatBytes(report.usage.staging)],
                  [language.storage.unmanaged, formatBytes(report.usage.unmanaged)],
                  [language.storage.referencedLogical, formatBytes(report.referenced.logicalBytes)],
                  [language.storage.referencedDeduped, formatBytes(report.referenced.dedupedBytes)],
                  [language.storage.referencedSavings, formatBytes(report.referenced.savings)],
                  [language.storage.referencedCount, report.referenced.count.toLocaleString()],
                  [language.storage.unreferencedCount, report.unreferenced.count.toLocaleString()],
                  [language.storage.unreferencedBytes, formatBytes(report.unreferenced.bytes)],
                  [language.storage.pastGraceCount, report.unreferenced.pastGrace.count.toLocaleString()],
                  [language.storage.pastGraceBytes, formatBytes(report.unreferenced.pastGrace.bytes)],
                  [language.storage.orphanInlayCount, report.orphanInlays.count.toLocaleString()],
                  [language.storage.orphanInlayBytes, formatBytes(report.orphanInlays.bytes)],
              ]
            : [],
    );

    function formatBytes(bytes: number): string {
        const units = language.storage.byteUnits;
        let unit = 0;
        while (bytes >= 1024 && unit < units.length - 1) {
            bytes /= 1024;
            unit++;
        }
        return `${bytes.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 2 })} ${units[unit]}`;
    }

    function date(value: number | string): string {
        return new Date(value).toLocaleString();
    }

    function message(value: unknown): string {
        return value instanceof Error ? value.message : String(value);
    }

    function applyReport(value: AssetLifecycleReport) {
        if (disposed) return;
        report = value;
        selectedKeys = value.unreferenced.candidates.map((item) => item.key);
        selectedInlays = value.orphanInlays.records.map((item) => item.id);
    }

    async function refreshSnapshots() {
        if (disposed) return;
        const items = await listBackups();
        if (!disposed) snapshots = items;
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        if (!disposed && report?.running) pollTimer = setTimeout(poll, 1000);
    }

    async function poll() {
        if (disposed) return;
        if (busy) {
            schedulePoll();
            return;
        }
        busy = true;
        try {
            applyReport(await readStorageReport());
            if (!disposed && !report.running) await refreshSnapshots();
        } catch (cause) {
            if (!disposed) error = message(cause);
        } finally {
            if (!disposed) busy = false;
            schedulePoll();
        }
    }

    async function load() {
        const [reportRead, snapshotRead] = await Promise.allSettled([readStorageReport(), listBackups()]);
        if (disposed) return;
        const failures: string[] = [];
        if (reportRead.status === "fulfilled") applyReport(reportRead.value);
        else failures.push(message(reportRead.reason));
        if (snapshotRead.status === "fulfilled") snapshots = snapshotRead.value;
        else failures.push(message(snapshotRead.reason));
        error = failures.join("\n");
        loading = false;
        busy = false;
        schedulePoll();
    }

    async function runAction(action: () => Promise<void>) {
        if (busy || disposed) return;
        busy = true;
        error = "";
        try {
            await action();
        } catch (cause) {
            if (!disposed) error = message(cause);
        } finally {
            if (!disposed) busy = false;
            schedulePoll();
        }
    }

    function scan() {
        if (running) return;
        return runAction(async () => {
            applyReport(await startStorageScan());
            if (!disposed && !report.running) await refreshSnapshots();
        });
    }

    function deleteAssets() {
        if (sweepDisabled || !selectedKeys.length) return;
        const keys = [...selectedKeys];
        const bytes = formatBytes(selectedBytes);
        return runAction(async () => {
            if (!(await alertConfirm(language.storage.deleteConfirm(keys.length, bytes))) || disposed) return;
            assetResult = await sweepAssets({ keys, inlays: [] });
            if (!disposed) applyReport(await readStorageReport());
        });
    }

    function deleteInlays() {
        if (sweepDisabled || !selectedInlays.length) return;
        const inlays = [...selectedInlays];
        return runAction(async () => {
            if (!(await alertConfirm(language.storage.deleteInlaysConfirm(inlays.length))) || disposed) return;
            inlayResult = await sweepAssets({ keys: [], inlays });
            if (!disposed) applyReport(await readStorageReport());
        });
    }

    function take() {
        if (running) return;
        return runAction(async () => {
            await takeSnapshot(snapshotLabel || null);
            if (!disposed) snapshotLabel = "";
            await refreshSnapshots();
        });
    }

    function pin(id: string, pinned: boolean) {
        if (running) return;
        return runAction(async () => {
            await updateSnapshot(id, { pinned: !pinned });
            await refreshSnapshots();
        });
    }

    function saveLabel(id: string) {
        if (running) return;
        return runAction(async () => {
            await updateSnapshot(id, { label: labelText });
            if (!disposed) editingLabel = null;
            await refreshSnapshots();
        });
    }

    function removeSnapshot(id: string, createdAt: string) {
        if (running) return;
        return runAction(async () => {
            if (!(await alertConfirm(language.storage.deleteSnapshotConfirm(date(createdAt)))) || disposed) return;
            await deleteSnapshot(id);
            await refreshSnapshots();
        });
    }

    function restore(id: string, createdAt: string) {
        if (running) return;
        return runAction(async () => {
            if (!(await alertConfirm(language.storage.restoreConfirm(date(createdAt)))) || disposed) return;
            try {
                await restoreBackup(id);
            } catch (cause) {
                if (!(cause instanceof ResourceEpochMismatchError)) throw cause;
            }
            // A failed list refresh must not prevent reloading the restored resources.
            try {
                await refreshSnapshots();
            } catch (cause) {
                if (!disposed) error = message(cause);
            }
            await alertNormalWait(language.storage.restored);
            location.reload();
        });
    }

    function unreadable(id: string): boolean {
        return (
            incomplete &&
            report.reasons.some(
                (reason) => reason.startsWith(`snapshot ${id}:`) || reason.startsWith(`snapshot ${id} `),
            )
        );
    }

    onMount(() => {
        void load();
        return () => {
            disposed = true;
            clearTimeout(pollTimer);
        };
    });
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || running} onclick={scan}>{language.storage.scan}</Button>
        {#if loading}<span class="text-textcolor2">{language.storage.loading}</span>{/if}
        {#if running}<span role="status" class="text-textcolor2">{language.storage.scanning}</span>{/if}
    </div>
    {#if error}
        <p role="alert" class="text-draculared whitespace-pre-wrap break-all">{error}</p>
    {/if}
    {#if report}
        <p class="text-textcolor2">
            {#if report.generatedAt !== null}
                {language.storage.generatedAt}: {date(report.generatedAt)}
            {:else}
                {language.storage.noScanYet}
            {/if}
        </p>
        {#if incomplete}
            <div class="rounded-md border border-darkborderc bg-darkbg p-2">
                <p>{language.storage.incomplete}</p>
                <ul class="max-h-64 overflow-auto list-disc pl-5">
                    {#each report.reasons as reason}<li class="break-all">{reason}</li>{/each}
                </ul>
            </div>
        {/if}
        <dl class="grid gap-2 sm:grid-cols-2">
            {#each totals as [label, value]}
                <div class="flex flex-wrap justify-between gap-x-3 rounded-md bg-darkbg p-2">
                    <dt class="text-textcolor2">{label}</dt>
                    <dd>{value}</dd>
                </div>
            {/each}
        </dl>

        <h3 class="font-semibold">{language.storage.owners}</h3>
        <p class="text-textcolor2">{language.storage.sharesNote}</p>
        <div class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
            <table class="w-full table-fixed text-left">
                <thead
                    ><tr>
                        <th class="p-2">{language.storage.ownerKind}</th>
                        <th class="p-2">{language.storage.name}</th>
                        <th class="p-2">{language.storage.count}</th>
                        <th class="p-2">{language.storage.bytes}</th>
                    </tr></thead
                >
                <tbody>
                    {#each owners as owner}
                        <tr class="border-t border-darkborderc">
                            <td class="p-2 break-all">{language.storage.ownerKinds[owner.kind]}</td>
                            <td class="p-2 break-all">{owner.name}</td>
                            <td class="p-2 break-all">{owner.count.toLocaleString()}</td>
                            <td class="p-2 break-all">{formatBytes(owner.bytes)}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>

        <h3 class="font-semibold">{language.storage.candidates}</h3>
        <div class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
            {#each report.unreferenced.candidates as candidate (candidate.key)}
                <label class="flex items-start gap-2 border-b border-darkborderc p-2">
                    <input type="checkbox" value={candidate.key} bind:group={selectedKeys} disabled={busy || running} />
                    <span class="min-w-0 break-all">
                        <span class="block">{candidate.key}</span>
                        <span class="text-textcolor2"
                            >{formatBytes(candidate.bytes)} · {language.storage.since}: {date(candidate.since)}</span
                        >
                    </span>
                </label>
            {:else}
                <p class="p-2 text-textcolor2">{language.storage.emptyCandidates}</p>
            {/each}
        </div>
        {#if report.unreferenced.total > report.unreferenced.candidates.length}
            <p class="text-textcolor2">
                {language.storage.showing(report.unreferenced.candidates.length, report.unreferenced.total)}
            </p>
        {/if}
        <div>
            <Button size="sm" disabled={sweepDisabled || !selectedKeys.length} onclick={deleteAssets}
                >{language.storage.deleteAssets}</Button
            >
        </div>
        {#if assetResult}
            <p role="status">
                {language.storage.deleteResult(assetResult.deleted.length, formatBytes(assetResult.freedBytes))}
            </p>
            {#if assetResult.skipped.length}
                <p>{language.storage.skippedAssets}</p>
                <ul class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg p-2">
                    {#each assetResult.skipped as item}<li class="break-all">{item.key}: {item.reason}</li>{/each}
                </ul>
            {/if}
        {/if}

        <h3 class="font-semibold">{language.storage.orphanInlays}</h3>
        <p class="text-textcolor2">{language.storage.inlayGraceNote}</p>
        <div class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
            {#each report.orphanInlays.records as inlay (inlay.id)}
                <label class="flex items-start gap-2 border-b border-darkborderc p-2">
                    <input type="checkbox" value={inlay.id} bind:group={selectedInlays} disabled={busy || running} />
                    <span class="min-w-0 break-all">
                        <span class="block">{language.storage.inlayId}: {inlay.id}</span>
                        <span class="block">{language.storage.assetKey}: {inlay.asset ?? language.storage.none}</span>
                        <span class="text-textcolor2"
                            >{formatBytes(inlay.bytes)} · {language.storage.since}: {inlay.since === null
                                ? language.storage.missingValue
                                : date(inlay.since)}</span
                        >
                    </span>
                </label>
            {:else}
                <p class="p-2 text-textcolor2">{language.storage.emptyInlays}</p>
            {/each}
        </div>
        <p class="text-textcolor2">
            {language.storage.showing(report.orphanInlays.records.length, report.orphanInlays.total)}
        </p>
        <div>
            <Button size="sm" disabled={sweepDisabled || !selectedInlays.length} onclick={deleteInlays}
                >{language.storage.deleteInlays}</Button
            >
        </div>
        {#if inlayResult}
            <p role="status">{language.storage.deleteInlaysResult(inlayResult.removedInlays.length)}</p>
            {#if inlayResult.skippedInlays.length}
                <p>{language.storage.skippedInlays}</p>
                <ul class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg p-2">
                    {#each inlayResult.skippedInlays as item}<li class="break-all">{item.id}: {item.reason}</li>{/each}
                </ul>
            {/if}
        {/if}
    {/if}

    <h3 class="font-semibold">{language.storage.snapshots}</h3>
    <p class="text-textcolor2">{language.storage.heldBytesNote}</p>
    <div class="flex flex-wrap items-center gap-2">
        <input
            class="min-w-0 rounded-md border border-darkborderc bg-darkbg p-2 text-textcolor"
            type="text"
            aria-label={language.storage.optionalLabel}
            placeholder={language.storage.optionalLabel}
            bind:value={snapshotLabel}
            disabled={busy || running}
        />
        <Button size="sm" disabled={busy || running} onclick={take}>{language.storage.takeSnapshot}</Button>
    </div>
    <ul class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
        {#each snapshots as snapshot (snapshot.id)}
            {@const heldBytes = report?.snapshots.find((item) => item.id === snapshot.id)?.heldBytes}
            <li class="flex flex-col gap-2 border-b border-darkborderc p-2">
                <dl class="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    <div>
                        <dt class="text-textcolor2">{language.storage.createdAt}</dt>
                        <dd class="break-all">{date(snapshot.createdAt)}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.bytes}</dt>
                        <dd>{formatBytes(snapshot.size)}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.snapshotLabel}</dt>
                        <dd class="break-all">{snapshot.label ?? language.storage.none}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.pinnedState}</dt>
                        <dd>{snapshot.pinned ? language.storage.pinned : language.storage.unpinned}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.heldBytes}</dt>
                        <dd>{heldBytes === undefined ? language.storage.missingValue : formatBytes(heldBytes)}</dd>
                    </div>
                </dl>
                {#if unreadable(snapshot.id)}<p class="text-draculared break-all">
                        {language.storage.unreadableSnapshot}
                    </p>{/if}
                <div class="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy || running} onclick={() => pin(snapshot.id, snapshot.pinned)}
                        >{snapshot.pinned ? language.storage.unpin : language.storage.pin}</Button
                    >
                    <Button
                        size="sm"
                        disabled={busy || running}
                        onclick={() => {
                            editingLabel = snapshot.id;
                            labelText = snapshot.label ?? "";
                        }}>{language.storage.label}</Button
                    >
                    <Button
                        size="sm"
                        disabled={busy || running}
                        onclick={() => restore(snapshot.id, snapshot.createdAt)}>{language.storage.restore}</Button
                    >
                    <Button
                        size="sm"
                        disabled={busy || running}
                        onclick={() => removeSnapshot(snapshot.id, snapshot.createdAt)}
                        >{language.storage.deleteSnapshot}</Button
                    >
                </div>
                {#if editingLabel === snapshot.id}
                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            class="min-w-0 rounded-md border border-darkborderc bg-bgcolor p-2 text-textcolor"
                            type="text"
                            aria-label={language.storage.snapshotLabel}
                            bind:value={labelText}
                            disabled={busy || running}
                        />
                        <Button size="sm" disabled={busy || running} onclick={() => saveLabel(snapshot.id)}
                            >{language.storage.save}</Button
                        >
                        <Button
                            size="sm"
                            disabled={busy}
                            onclick={() => {
                                editingLabel = null;
                            }}>{language.storage.cancel}</Button
                        >
                    </div>
                {/if}
            </li>
        {:else}
            {#if !loading}<li class="p-2 text-textcolor2">{language.storage.emptySnapshots}</li>{/if}
        {/each}
    </ul>
</div>
