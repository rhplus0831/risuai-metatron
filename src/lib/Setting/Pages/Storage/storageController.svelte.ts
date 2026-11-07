import { language } from "src/lang";
import { alertConfirm, alertNormalWait } from "src/ts/alert";
import {
    readStorageReport,
    readStorageStatus,
    startStorageScan,
    sweepAssets,
} from "src/ts/storage/assetLifecycleClient";
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
 * The Storage settings page reads the retention report and live snapshots on mount without
 * writing settings or resource records. Scans and sweeps poll status every second, reading the full
 * report when its version changes or the run ends; cleanup sends
 * explicit, confirmed asset or inlay selections and requires a complete run. Snapshot controls
 * refresh the live list, while held bytes come from the last report. Snapshot actions wait until
 * scans and sweeps finish. Button requests are serialized, server errors are shown unchanged,
 * and restores reload the app after a success or epoch-conflict notice. Unmount stops polling.
 */
export class StorageController {
    report: AssetLifecycleReport | null = $state(null);
    snapshots: Awaited<ReturnType<typeof listBackups>> = $state([]);
    loading = $state(true);
    busy = $state(true);
    error = $state("");
    selectedKeys: string[] = $state([]);
    selectedInlays: string[] = $state([]);
    assetResult: AssetSweepResult | null = $state(null);
    inlayResult: AssetSweepResult | null = $state(null);
    snapshotLabel = $state("");
    editingLabel: string | null = $state(null);
    labelText = $state("");
    private disposed = false;
    private pollTimer: ReturnType<typeof setTimeout> | undefined;

    formatBytes = (bytes: number): string => {
        const units = language.storage.byteUnits;
        let unit = 0;
        while (bytes >= 1024 && unit < units.length - 1) {
            bytes /= 1024;
            unit++;
        }
        return `${bytes.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 2 })} ${units[unit]}`;
    };

    running = $derived(this.report?.running ?? false);
    incomplete = $derived(this.report?.generatedAt != null && !this.report.complete);
    sweepDisabled = $derived(this.busy || this.running || this.report?.generatedAt == null || !this.report?.complete);
    owners = $derived([...(this.report?.owners ?? [])].sort((a, b) => b.bytes - a.bytes));
    selectedBytes = $derived.by(() => {
        const keys = new Set(this.selectedKeys);
        return (
            this.report?.unreferenced.candidates.reduce(
                (total, item) => total + (keys.has(item.key) ? item.bytes : 0),
                0,
            ) ?? 0
        );
    });
    totals = $derived(
        this.report
            ? [
                  [
                      language.storage.diskFree,
                      this.report.disk ? this.formatBytes(this.report.disk.free) : language.storage.unknown,
                  ],
                  [
                      language.storage.diskTotal,
                      this.report.disk ? this.formatBytes(this.report.disk.total) : language.storage.unknown,
                  ],
                  [language.storage.assetsOnDisk, this.formatBytes(this.report.usage.assetsOnDisk)],
                  [language.storage.resourcesDb, this.formatBytes(this.report.usage.resourcesDb)],
                  [language.storage.snapshots, this.formatBytes(this.report.usage.snapshots)],
                  [language.storage.thumbnails, this.formatBytes(this.report.usage.thumbnails)],
                  [language.storage.staging, this.formatBytes(this.report.usage.staging)],
                  [language.storage.unmanaged, this.formatBytes(this.report.usage.unmanaged)],
                  [language.storage.referencedLogical, this.formatBytes(this.report.referenced.logicalBytes)],
                  [language.storage.referencedDeduped, this.formatBytes(this.report.referenced.dedupedBytes)],
                  [language.storage.referencedSavings, this.formatBytes(this.report.referenced.savings)],
                  [language.storage.referencedCount, this.report.referenced.count.toLocaleString()],
                  [language.storage.unreferencedCount, this.report.unreferenced.count.toLocaleString()],
                  [language.storage.unreferencedBytes, this.formatBytes(this.report.unreferenced.bytes)],
                  [language.storage.pastGraceCount, this.report.unreferenced.pastGrace.count.toLocaleString()],
                  [language.storage.pastGraceBytes, this.formatBytes(this.report.unreferenced.pastGrace.bytes)],
                  [language.storage.orphanInlayCount, this.report.orphanInlays.count.toLocaleString()],
                  [language.storage.orphanInlayBytes, this.formatBytes(this.report.orphanInlays.bytes)],
              ]
            : [],
    );

    date = (value: number | string): string => {
        return new Date(value).toLocaleString();
    };

    message = (value: unknown): string => {
        return value instanceof Error ? value.message : String(value);
    };

    private applyReport = (value: AssetLifecycleReport) => {
        if (this.disposed) return;
        this.report = value;
        this.selectedKeys = value.unreferenced.candidates.map((item) => item.key);
        this.selectedInlays = value.orphanInlays.records.map((item) => item.id);
    };

    private refreshSnapshots = async () => {
        if (this.disposed) return;
        const items = await listBackups();
        if (!this.disposed) this.snapshots = items;
    };

    private schedulePoll = () => {
        clearTimeout(this.pollTimer);
        if (!this.disposed && this.report?.running) this.pollTimer = setTimeout(this.poll, 1000);
    };

    poll = async () => {
        if (this.disposed) return;
        if (this.busy) {
            this.schedulePoll();
            return;
        }
        this.busy = true;
        try {
            const status = await readStorageStatus();
            if (this.disposed) return;
            if (!status.running || status.version !== this.report.version) {
                this.applyReport(await readStorageReport());
                if (!this.disposed && !this.report.running) await this.refreshSnapshots();
            }
        } catch (cause) {
            if (!this.disposed) this.error = this.message(cause);
        } finally {
            if (!this.disposed) this.busy = false;
            this.schedulePoll();
        }
    };

    load = async () => {
        const [reportRead, snapshotRead] = await Promise.allSettled([readStorageReport(), listBackups()]);
        if (this.disposed) return;
        const failures: string[] = [];
        if (reportRead.status === "fulfilled") this.applyReport(reportRead.value);
        else failures.push(this.message(reportRead.reason));
        if (snapshotRead.status === "fulfilled") this.snapshots = snapshotRead.value;
        else failures.push(this.message(snapshotRead.reason));
        this.error = failures.join("\n");
        this.loading = false;
        this.busy = false;
        this.schedulePoll();
    };

    runAction = async (action: () => Promise<void>) => {
        if (this.busy || this.disposed) return;
        this.busy = true;
        this.error = "";
        try {
            await action();
        } catch (cause) {
            if (!this.disposed) this.error = this.message(cause);
        } finally {
            if (!this.disposed) this.busy = false;
            this.schedulePoll();
        }
    };

    scan = () => {
        if (this.running) return;
        return this.runAction(async () => {
            this.applyReport(await startStorageScan());
            if (!this.disposed && !this.report.running) await this.refreshSnapshots();
        });
    };

    deleteAssets = () => {
        if (this.sweepDisabled || !this.selectedKeys.length) return;
        const keys = [...this.selectedKeys];
        const bytes = this.formatBytes(this.selectedBytes);
        return this.runAction(async () => {
            if (!(await alertConfirm(language.storage.deleteConfirm(keys.length, bytes))) || this.disposed) return;
            this.assetResult = await sweepAssets({ keys, inlays: [] });
            if (!this.disposed) this.applyReport(await readStorageReport());
        });
    };

    deleteInlays = () => {
        if (this.sweepDisabled || !this.selectedInlays.length) return;
        const inlays = [...this.selectedInlays];
        return this.runAction(async () => {
            if (!(await alertConfirm(language.storage.deleteInlaysConfirm(inlays.length))) || this.disposed) return;
            this.inlayResult = await sweepAssets({ keys: [], inlays });
            if (!this.disposed) this.applyReport(await readStorageReport());
        });
    };

    take = () => {
        if (this.running) return;
        return this.runAction(async () => {
            await takeSnapshot(this.snapshotLabel || null);
            if (!this.disposed) this.snapshotLabel = "";
            await this.refreshSnapshots();
        });
    };

    pin = (id: string, pinned: boolean) => {
        if (this.running) return;
        return this.runAction(async () => {
            await updateSnapshot(id, { pinned: !pinned });
            await this.refreshSnapshots();
        });
    };

    saveLabel = (id: string) => {
        if (this.running) return;
        return this.runAction(async () => {
            await updateSnapshot(id, { label: this.labelText });
            if (!this.disposed) this.editingLabel = null;
            await this.refreshSnapshots();
        });
    };

    removeSnapshot = (id: string, createdAt: string) => {
        if (this.running) return;
        return this.runAction(async () => {
            if (!(await alertConfirm(language.storage.deleteSnapshotConfirm(this.date(createdAt)))) || this.disposed)
                return;
            await deleteSnapshot(id);
            await this.refreshSnapshots();
        });
    };

    restore = (id: string, createdAt: string) => {
        if (this.running) return;
        return this.runAction(async () => {
            if (!(await alertConfirm(language.storage.restoreConfirm(this.date(createdAt)))) || this.disposed) return;
            let notice: string;
            try {
                await restoreBackup(id);
                notice = language.storage.restored;
            } catch (cause) {
                if (!(cause instanceof ResourceEpochMismatchError)) throw cause;
                notice = language.storage.restoreConflict;
            }
            // A failed list refresh must not prevent reloading the current resources.
            try {
                await this.refreshSnapshots();
            } catch (cause) {
                if (!this.disposed) this.error = this.message(cause);
            }
            await alertNormalWait(notice);
            location.reload();
        });
    };

    unreadable = (id: string): boolean => {
        return (
            this.incomplete &&
            this.report.reasons.some(
                (reason) => reason.startsWith(`snapshot ${id}:`) || reason.startsWith(`snapshot ${id} `),
            )
        );
    };

    dispose = () => {
        this.disposed = true;
        clearTimeout(this.pollTimer);
    };
}
