// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetLifecycleReport } from "../../../../../shared/assetLifecycle.ts";

const deps = vi.hoisted(() => ({
    readStorageReport: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["readStorageReport"]>(),
    readStorageStatus: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["readStorageStatus"]>(),
    startStorageScan: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["startStorageScan"]>(),
    sweepAssets: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["sweepAssets"]>(),
    listBackups: vi.fn<(typeof import("src/ts/storage/resourceClient"))["listBackups"]>(),
    takeSnapshot: vi.fn<(typeof import("src/ts/storage/resourceClient"))["takeSnapshot"]>(),
    updateSnapshot: vi.fn<(typeof import("src/ts/storage/resourceClient"))["updateSnapshot"]>(),
    deleteSnapshot: vi.fn<(typeof import("src/ts/storage/resourceClient"))["deleteSnapshot"]>(),
    restoreBackup: vi.fn<(typeof import("src/ts/storage/resourceClient"))["restoreBackup"]>(),
    alertConfirm: vi.fn<(typeof import("src/ts/alert"))["alertConfirm"]>(),
    alertNormalWait: vi.fn<(typeof import("src/ts/alert"))["alertNormalWait"]>(),
}));
vi.mock(
    "src/ts/storage/assetLifecycleClient",
    () =>
        ({
            readStorageReport: deps.readStorageReport,
            readStorageStatus: deps.readStorageStatus,
            startStorageScan: deps.startStorageScan,
            sweepAssets: deps.sweepAssets,
        }) satisfies typeof import("src/ts/storage/assetLifecycleClient"),
);
vi.mock("src/ts/storage/resourceClient", async () =>
    (await import("src/ts/storage/tests/resourceClientMock")).createResourceClientMock({
        listBackups: deps.listBackups,
        takeSnapshot: deps.takeSnapshot,
        updateSnapshot: deps.updateSnapshot,
        deleteSnapshot: deps.deleteSnapshot,
        restoreBackup: deps.restoreBackup,
    }),
);
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: deps.alertConfirm,
        alertNormalWait: deps.alertNormalWait,
    }),
);

import { StorageController } from "./storageController.svelte";

const runningReport = (version: number): AssetLifecycleReport => ({
    version,
    generatedAt: 1_700_000_000_000,
    complete: true,
    reasons: [],
    running: true,
    disk: null,
    usage: { assetsOnDisk: 0, resourcesDb: 0, snapshots: 0, thumbnails: 0, staging: 0, unmanaged: 0 },
    referenced: { logicalBytes: 0, dedupedBytes: 0, savings: 0, count: 0 },
    unreferenced: { count: 0, bytes: 0, pastGrace: { count: 0, bytes: 0 }, candidates: [], total: 0 },
    orphanInlays: { count: 0, bytes: 0, records: [], total: 0 },
    owners: [],
    snapshots: [],
});

let controller: StorageController;
beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    deps.listBackups.mockResolvedValue([]);
    controller = new StorageController();
});
afterEach(() => {
    controller.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("StorageController", () => {
    it("reads the full report when a status poll changes version while the run is still running", async () => {
        deps.readStorageReport.mockResolvedValueOnce(runningReport(1)).mockResolvedValue(runningReport(2));
        deps.readStorageStatus.mockResolvedValue({ running: true, version: 2 });
        await controller.load();
        expect(deps.readStorageReport).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(deps.readStorageStatus).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(deps.readStorageStatus).toHaveBeenCalledExactlyOnceWith();
        expect(deps.readStorageReport).toHaveBeenCalledTimes(2);
        expect(controller.report?.version).toBe(2);
        expect(controller.running).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.readStorageStatus).toHaveBeenCalledTimes(2);
        expect(deps.readStorageReport).toHaveBeenCalledTimes(2);
    });
});
