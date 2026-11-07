// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetLifecycleReport, AssetSweepResult } from "../../../../../shared/assetLifecycle.ts";
import type { BackupSnapshotInfo } from "../../../../../shared/resources.ts";

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

import { changeLanguage, language } from "src/lang";
import { ResourceEpochMismatchError, ResourceRequestError } from "src/ts/storage/resourceClient";
import StorageSettings from "../StorageSettings.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";

const SCANNED_AT = 1_700_000_000_000;
const bytes = (value: number) => `${value} ${language.storage.byteUnits[0]}`;
const snapshot = (id: string, label: string, pinned = false): BackupSnapshotInfo => ({
    id,
    label,
    pinned,
    createdAt: "2023-11-13T12:00:00.000Z",
    size: 81,
});

function report(overrides: Partial<AssetLifecycleReport> = {}): AssetLifecycleReport {
    return {
        version: 1,
        generatedAt: SCANNED_AT,
        complete: true,
        reasons: [],
        running: false,
        disk: { free: 501, total: 901 },
        usage: { assetsOnDisk: 201, resourcesDb: 202, snapshots: 203, thumbnails: 204, staging: 205, unmanaged: 206 },
        referenced: { logicalBytes: 180, dedupedBytes: 100, savings: 80, count: 4 },
        unreferenced: {
            count: 5,
            bytes: 90,
            pastGrace: { count: 3, bytes: 60 },
            candidates: [
                { key: "assets/first.png", bytes: 10, since: SCANNED_AT - 1000 },
                { key: "assets/second.png", bytes: 20, since: SCANNED_AT - 2000 },
                { key: "assets/unselected.png", bytes: 30, since: SCANNED_AT - 3000 },
            ],
            total: 3,
        },
        orphanInlays: {
            count: 3,
            bytes: 36,
            records: [
                { id: "inlay-first", asset: "assets/inlay-first.png", bytes: 11, since: SCANNED_AT - 1000 },
                { id: "inlay-second", asset: "assets/inlay-second.png", bytes: 12, since: SCANNED_AT - 2000 },
                { id: "inlay-unselected", asset: null, bytes: 13, since: null },
            ],
            total: 3,
        },
        owners: [
            { kind: "character", id: "char", name: "Character owner", bytes: 120, count: 3 },
            { kind: "module", id: "module", name: "Module owner", bytes: 60, count: 1 },
        ],
        snapshots: [
            { ...snapshot("snap-b", "Old B"), heldBytes: 42 },
            { ...snapshot("snap-a", "Old A"), heldBytes: 24 },
            { ...snapshot("removed", "Removed snapshot"), heldBytes: 99 },
        ],
        ...overrides,
    };
}

const emptySweep = (): AssetSweepResult => ({
    deleted: [],
    freedBytes: 0,
    removedInlays: [],
    skipped: [],
    skippedInlays: [],
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

let target: HTMLElement;
let mounted: ReturnType<typeof mount> | undefined;
beforeEach(() => {
    installFlatDatabase({ characters: [] });
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(SCANNED_AT);
    deps.readStorageReport.mockResolvedValue(report());
    deps.listBackups.mockResolvedValue([snapshot("snap-a", "Live A"), snapshot("snap-b", "Live B", true)]);
    deps.sweepAssets.mockResolvedValue(emptySweep());
    deps.alertConfirm.mockResolvedValue(true);
    deps.alertNormalWait.mockResolvedValue();
    target = document.createElement("div");
    document.body.appendChild(target);
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    target.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function open() {
    mounted = mount(StorageSettings, { target });
    flushSync();
    await settle();
}
function button(label: string, within: ParentNode = target) {
    const found = [...within.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
    );
    expect(found, `button ${label}`).toBeDefined();
    return found!;
}
async function click(label: string, within: ParentNode = target) {
    button(label, within).click();
    await settle();
}
function snapshotRow(label: string) {
    const row = [...target.querySelectorAll("li")].find((item) =>
        [...item.querySelectorAll("span")].some((cell) => cell.textContent === label),
    );
    expect(row, `snapshot ${label}`).toBeDefined();
    return row!;
}
/** A snapshot row's ⋯ menu item, opening that row's menu first when it is closed. */
async function snapshotAction(action: string, label: string) {
    const trigger = button(language.storagePage.snapshots.actions, snapshotRow(label));
    if (trigger.getAttribute("aria-expanded") !== "true")
        await click(language.storagePage.snapshots.actions, snapshotRow(label));
    return button(action, snapshotRow(label));
}
async function clickSnapshotAction(action: string, label: string) {
    (await snapshotAction(action, label)).click();
    await settle();
}
function heldBytes(label: string) {
    return snapshotRow(label).querySelector(`[title="${language.storage.heldBytes}"]`)?.textContent?.trim();
}
function input(label: string, value: string, within: ParentNode = target) {
    const field = [...within.querySelectorAll<HTMLInputElement>("input")].find(
        (item) => item.getAttribute("aria-label") === label,
    );
    expect(field, `input ${label}`).toBeDefined();
    field!.value = value;
    field!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}
function deselect(value: string) {
    const checkbox = [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
        (item) => item.value === value,
    );
    expect(checkbox).toBeDefined();
    expect(checkbox!.checked).toBe(true);
    checkbox!.click();
    flushSync();
}
function detail(within: ParentNode, label: string) {
    const term = [...within.querySelectorAll("dt")].find((item) => item.textContent === label);
    expect(term, `detail ${label}`).toBeDefined();
    return term!.nextElementSibling?.textContent;
}

describe("StorageSettings", () => {
    it("shows the no-label text in an unlabeled snapshot row", async () => {
        deps.listBackups.mockResolvedValue([{ ...snapshot("unlabeled", ""), label: null }]);
        await open();

        const row = target.querySelector('[data-settings-section="storage.snapshots"] li');
        expect(row).not.toBeNull();
        expect(row!.textContent).toContain(language.storagePage.snapshots.noLabel);
    });

    it("closes a snapshot's actions menu on Escape", async () => {
        await open();
        const row = snapshotRow("Live A");
        const trigger = button(language.storagePage.snapshots.actions, row);
        await click(language.storagePage.snapshots.actions, row);
        expect(row.querySelector('[role="menu"]')).not.toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");

        button(language.storagePage.snapshots.editLabel, row).dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        await settle();

        expect(row.querySelector('[role="menu"]')).toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes a snapshot's actions menu on a click outside the menu", async () => {
        await open();
        const row = snapshotRow("Live A");
        const trigger = button(language.storagePage.snapshots.actions, row);
        await click(language.storagePage.snapshots.actions, row);
        expect(row.querySelector('[role="menu"]')).not.toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");

        // The row's label is outside the menu even though it belongs to the same snapshot.
        [...row.querySelectorAll("span")].find((cell) => cell.textContent === "Live A")!.click();
        await settle();

        expect(row.querySelector('[role="menu"]')).toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes the first snapshot's actions menu when another row's menu opens", async () => {
        await open();
        const first = snapshotRow("Live A");
        const second = snapshotRow("Live B");
        await click(language.storagePage.snapshots.actions, first);
        expect(first.querySelector('[role="menu"]')).not.toBeNull();

        await click(language.storagePage.snapshots.actions, second);

        expect(first.querySelector('[role="menu"]')).toBeNull();
        expect(button(language.storagePage.snapshots.actions, first).getAttribute("aria-expanded")).toBe("false");
        expect(second.querySelector('[role="menu"]')).not.toBeNull();
        expect(button(language.storagePage.snapshots.actions, second).getAttribute("aria-expanded")).toBe("true");
        expect(target.querySelectorAll('[role="menu"]')).toHaveLength(1);
    });

    it("reads storage without writes and shows totals, owners, candidates, inlays, and live snapshots matched by id", async () => {
        deps.listBackups.mockResolvedValue([
            snapshot("snap-a", "Live A"),
            snapshot("snap-b", "Live B", true),
            snapshot("new", "New snapshot"),
        ]);
        await open();
        expect(
            [...target.querySelectorAll("[data-settings-section]")].map((section) =>
                section.getAttribute("data-settings-section"),
            ),
        ).toEqual(["storage.overview", "storage.cleanup", "storage.snapshots", "storage.owners", "storage.details"]);
        for (const title of [language.storagePage.owners.title, language.storagePage.details.title]) {
            expect(button(title).getAttribute("aria-expanded")).toBe("false");
            await click(title);
            expect(button(title).getAttribute("aria-expanded")).toBe("true");
        }
        const totals = [
            [language.storage.diskFree, bytes(501)],
            [language.storage.diskTotal, bytes(901)],
            [language.storage.assetsOnDisk, bytes(201)],
            [language.storage.resourcesDb, bytes(202)],
            [language.storage.snapshots, bytes(203)],
            [language.storage.thumbnails, bytes(204)],
            [language.storage.staging, bytes(205)],
            [language.storage.unmanaged, bytes(206)],
            [language.storage.referencedLogical, bytes(180)],
            [language.storage.referencedDeduped, bytes(100)],
            [language.storage.referencedSavings, bytes(80)],
            [language.storage.referencedCount, "4"],
            [language.storage.unreferencedCount, "5"],
            [language.storage.unreferencedBytes, bytes(90)],
            [language.storage.pastGraceCount, "3"],
            [language.storage.pastGraceBytes, bytes(60)],
            [language.storage.orphanInlayCount, "3"],
            [language.storage.orphanInlayBytes, bytes(36)],
        ];
        for (const [label, value] of totals) expect(detail(target, label), label).toBe(value);
        expect(target.textContent).toContain(language.storage.sharesNote);
        const ownerRows = [...target.querySelectorAll('[role="row"]')]
            .filter((row) => row.querySelector('[role="cell"]'))
            .map((row) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent?.trim()));
        expect(ownerRows).toEqual([
            [language.storage.ownerKinds.character, "Character owner", "3", bytes(120)],
            [language.storage.ownerKinds.module, "Module owner", "1", bytes(60)],
        ]);
        expect(
            [...target.querySelectorAll('input[type="checkbox"]')].map((item) => (item as HTMLInputElement).value),
        ).toEqual([
            "assets/first.png",
            "assets/second.png",
            "assets/unselected.png",
            "inlay-first",
            "inlay-second",
            "inlay-unselected",
        ]);
        expect(target.textContent).toContain(language.storage.candidates);
        expect(target.textContent).toContain(language.storage.orphanInlays);
        expect(target.textContent).toContain("assets/inlay-first.png");
        expect(heldBytes("Live A")).toBe(bytes(24));
        expect(heldBytes("Live B")).toBe(bytes(42));
        expect(heldBytes("New snapshot")).toBe(language.storage.missingValue);
        expect(target.textContent).not.toContain("Removed snapshot");
        expect(deps.readStorageReport).toHaveBeenCalledExactlyOnceWith();
        expect(deps.listBackups).toHaveBeenCalledExactlyOnceWith();
        for (const write of [
            deps.startStorageScan,
            deps.sweepAssets,
            deps.takeSnapshot,
            deps.updateSnapshot,
            deps.deleteSnapshot,
            deps.restoreBackup,
        ]) {
            expect(write).not.toHaveBeenCalled();
        }
        expect(deps.alertConfirm).not.toHaveBeenCalled();
    });

    it("starts a scan, polls status until it finishes, reads the full report once at the end, and disables action controls while keeping accordions usable", async () => {
        deps.startStorageScan.mockResolvedValue(report({ running: true }));
        deps.readStorageStatus
            .mockResolvedValueOnce({ running: true, version: 1 })
            .mockResolvedValueOnce({ running: true, version: 1 })
            .mockResolvedValue({ running: false, version: 1 });
        await open();
        // Completion must refresh even if the status version has not changed.
        deps.readStorageReport.mockResolvedValue(report());
        await clickSnapshotAction(language.storagePage.snapshots.editLabel, "Live A");
        await click(language.storage.scan);
        expect(deps.startStorageScan).toHaveBeenCalledExactlyOnceWith();
        expect(target.textContent).toContain(language.storage.scanning);
        const enabledWhileRunning = [
            ...target.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button:not([aria-expanded]), input"),
        ]
            .filter((item) => !item.disabled)
            .map((item) => item.getAttribute("aria-label") ?? item.textContent?.trim() ?? item.value)
            // Cancel only closes the open label editor, so it stays enabled during a scan.
            .filter((name) => name !== language.storage.cancel);
        const actionsDisabledWhileRunning = ["Live A", "Live B"].map(
            (label) => button(language.storagePage.snapshots.actions, snapshotRow(label)).disabled,
        );
        for (const title of [language.storagePage.owners.title, language.storagePage.details.title]) {
            expect(button(title).disabled).toBe(false);
            await click(title);
            expect(button(title).getAttribute("aria-expanded")).toBe("true");
            await click(title);
        }
        await vi.advanceTimersByTimeAsync(2000);
        flushSync();
        expect(deps.readStorageStatus).toHaveBeenCalledTimes(2);
        expect(deps.readStorageReport).toHaveBeenCalledTimes(1);
        expect(target.textContent).toContain(language.storage.scanning);
        await vi.advanceTimersByTimeAsync(1000);
        flushSync();
        expect(deps.readStorageReport).toHaveBeenCalledTimes(2);
        expect(target.textContent).not.toContain(language.storage.scanning);
        expect(button(language.storage.scan).disabled).toBe(false);
        expect(button(language.storage.deleteAssets).disabled).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(deps.readStorageStatus).toHaveBeenCalledTimes(3);
        expect(deps.readStorageReport).toHaveBeenCalledTimes(2);
        expect(enabledWhileRunning).toEqual([]);
        // The ⋯ triggers carry aria-expanded, so the sweep above skips them.
        expect(actionsDisabledWhileRunning).toEqual([true, true]);
    });

    it("blocks cleanup for incomplete scans, marks named unreadable snapshots, and still allows their deletion", async () => {
        deps.readStorageReport.mockResolvedValue(
            report({
                complete: false,
                reasons: [
                    "snapshot snap-a: unreadable manifest",
                    "snapshot snap-b missing asset index",
                    "asset directory unavailable",
                ],
            }),
        );
        deps.listBackups.mockResolvedValue([
            snapshot("snap-a", "Live A"),
            snapshot("snap-b", "Live B"),
            snapshot("snap-a-long", "Readable"),
        ]);
        await open();
        expect(target.textContent).toContain(language.storage.incomplete);
        for (const reason of [
            "snapshot snap-a: unreadable manifest",
            "snapshot snap-b missing asset index",
            "asset directory unavailable",
        ]) {
            expect(target.textContent).toContain(reason);
        }
        expect(button(language.storage.deleteAssets).disabled).toBe(true);
        expect(button(language.storage.deleteInlays).disabled).toBe(true);
        await click(language.storage.deleteAssets);
        await click(language.storage.deleteInlays);
        expect(deps.sweepAssets).not.toHaveBeenCalled();
        for (const label of ["Live A", "Live B"]) {
            expect(snapshotRow(label).textContent).toContain(language.storage.unreadableSnapshot);
            expect((await snapshotAction(language.storage.deleteSnapshot, label)).disabled).toBe(false);
        }
        expect(snapshotRow("Readable").textContent).not.toContain(language.storage.unreadableSnapshot);
        await clickSnapshotAction(language.storage.deleteSnapshot, "Live B");
        expect(deps.alertConfirm).toHaveBeenCalledWith(
            language.storage.deleteSnapshotConfirm(new Date("2023-11-13T12:00:00.000Z").toLocaleString()),
        );
        expect(deps.deleteSnapshot).toHaveBeenCalledExactlyOnceWith("snap-b");
    });

    it("confirms the selected assets' count and bytes, sends only their keys, and displays deletion and skip results", async () => {
        deps.sweepAssets.mockResolvedValue({
            ...emptySweep(),
            deleted: ["assets/first.png"],
            freedBytes: 10,
            skipped: [{ key: "assets/second.png", reason: "asset is now referenced" }],
        });
        await open();
        deselect("assets/unselected.png");
        deps.alertConfirm.mockResolvedValueOnce(false);
        await click(language.storage.deleteAssets);
        expect(deps.alertConfirm).toHaveBeenLastCalledWith(language.storage.deleteConfirm(2, bytes(30)));
        expect(deps.sweepAssets).not.toHaveBeenCalled();
        await click(language.storage.deleteAssets);
        expect(deps.alertConfirm).toHaveBeenLastCalledWith(language.storage.deleteConfirm(2, bytes(30)));
        expect(deps.sweepAssets).toHaveBeenCalledExactlyOnceWith({
            keys: ["assets/first.png", "assets/second.png"],
            inlays: [],
        });
        expect(target.textContent).toContain(language.storage.deleteResult(1, bytes(10)));
        expect(target.textContent).toContain(language.storage.skippedAssets);
        expect(target.textContent).toContain("assets/second.png: asset is now referenced");
    });

    it("confirms selected orphan inlay records, sends no asset keys, and displays removed and skipped records", async () => {
        deps.sweepAssets.mockResolvedValue({
            ...emptySweep(),
            removedInlays: ["inlay-first"],
            skippedInlays: [{ id: "inlay-second", reason: "within grace period" }],
        });
        await open();
        deselect("inlay-unselected");
        deps.alertConfirm.mockResolvedValueOnce(false);
        await click(language.storage.deleteInlays);
        expect(deps.alertConfirm).toHaveBeenLastCalledWith(language.storage.deleteInlaysConfirm(2));
        expect(deps.sweepAssets).not.toHaveBeenCalled();
        await click(language.storage.deleteInlays);
        expect(deps.alertConfirm).toHaveBeenLastCalledWith(language.storage.deleteInlaysConfirm(2));
        expect(deps.sweepAssets).toHaveBeenCalledExactlyOnceWith({ keys: [], inlays: ["inlay-first", "inlay-second"] });
        expect(target.textContent).toContain(language.storage.deleteInlaysResult(1));
        expect(target.textContent).toContain(language.storage.skippedInlays);
        expect(target.textContent).toContain("inlay-second: within grace period");
    });

    it("shows server conflict and other sweep failure messages", async () => {
        deps.sweepAssets
            .mockRejectedValueOnce(new ResourceRequestError(409, "Scan changed; scan again"))
            .mockRejectedValueOnce(new ResourceRequestError(503, "Storage temporarily unavailable"));
        await open();
        await click(language.storage.deleteAssets);
        expect(target.querySelector('[role="alert"]')?.textContent).toBe("Scan changed; scan again");
        await click(language.storage.deleteInlays);
        expect(target.querySelector('[role="alert"]')?.textContent).toBe("Storage temporarily unavailable");
        expect(target.textContent).not.toContain(language.storage.deleteResult(0, bytes(0)));
        expect(target.textContent).not.toContain(language.storage.deleteInlaysResult(0));
    });

    it("takes, pins, labels, and deletes snapshots by id and shows a refused twenty-first pin", async () => {
        await open();
        input(language.storage.optionalLabel, "Before cleanup");
        await click(language.storage.takeSnapshot);
        expect(deps.takeSnapshot).toHaveBeenLastCalledWith("Before cleanup");
        await click(language.storage.takeSnapshot);
        expect(deps.takeSnapshot).toHaveBeenLastCalledWith(null);
        expect(deps.takeSnapshot).toHaveBeenCalledTimes(2);
        deps.listBackups.mockResolvedValue([snapshot("snap-a", "Live A", true), snapshot("snap-b", "Live B", true)]);
        await click(language.storage.pin, snapshotRow("Live A"));
        expect(deps.updateSnapshot).toHaveBeenLastCalledWith("snap-a", { pinned: true });
        await click(language.storage.unpin, snapshotRow("Live B"));
        expect(deps.updateSnapshot).toHaveBeenLastCalledWith("snap-b", { pinned: false });
        await clickSnapshotAction(language.storagePage.snapshots.editLabel, "Live B");
        input(language.storage.snapshotLabel, "Keep this snapshot", snapshotRow("Live B"));
        await click(language.storage.save, snapshotRow("Live B"));
        expect(deps.updateSnapshot).toHaveBeenLastCalledWith("snap-b", { label: "Keep this snapshot" });
        deps.alertConfirm.mockResolvedValueOnce(false);
        await clickSnapshotAction(language.storage.deleteSnapshot, "Live A");
        expect(deps.deleteSnapshot).not.toHaveBeenCalled();
        await clickSnapshotAction(language.storage.deleteSnapshot, "Live A");
        expect(deps.alertConfirm).toHaveBeenLastCalledWith(
            language.storage.deleteSnapshotConfirm(new Date("2023-11-13T12:00:00.000Z").toLocaleString()),
        );
        expect(deps.deleteSnapshot).toHaveBeenCalledExactlyOnceWith("snap-a");
        deps.listBackups.mockResolvedValue(
            Array.from({ length: 21 }, (_, i) => snapshot(`cap-${i + 1}`, `Snapshot ${i + 1}`, i < 20)),
        );
        // Refresh the live list through a snapshot action before trying to pin its last row.
        await click(language.storage.takeSnapshot);
        deps.updateSnapshot.mockRejectedValueOnce(new ResourceRequestError(409, "At most 20 snapshots may be pinned"));
        await click(language.storage.pin, snapshotRow("Snapshot 21"));
        expect(deps.updateSnapshot).toHaveBeenLastCalledWith("cap-21", { pinned: true });
        expect(target.querySelector('[role="alert"]')?.textContent).toBe("At most 20 snapshots may be pinned");
    });

    it("confirms restore by snapshot id and reloads after success or an epoch replacement", async () => {
        const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
        await open();
        deps.alertConfirm.mockResolvedValueOnce(false);
        await clickSnapshotAction(language.storage.restore, "Live B");
        expect(deps.restoreBackup).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        const notice = deferred<void>();
        deps.alertNormalWait.mockReturnValueOnce(notice.promise);
        deps.restoreBackup.mockResolvedValueOnce("restored-epoch");
        await clickSnapshotAction(language.storage.restore, "Live B");
        expect(deps.alertConfirm).toHaveBeenLastCalledWith(
            language.storage.restoreConfirm(new Date("2023-11-13T12:00:00.000Z").toLocaleString()),
        );
        expect(deps.restoreBackup).toHaveBeenCalledExactlyOnceWith("snap-b");
        expect(deps.alertNormalWait).toHaveBeenCalledWith(language.storage.restored);
        expect(reload).not.toHaveBeenCalled();
        notice.resolve();
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        deps.alertNormalWait.mockClear();
        deps.restoreBackup.mockRejectedValueOnce(new ResourceEpochMismatchError("new-epoch"));
        await clickSnapshotAction(language.storage.restore, "Live A");
        expect(deps.restoreBackup).toHaveBeenLastCalledWith("snap-a");
        expect(deps.alertNormalWait).toHaveBeenCalledExactlyOnceWith(language.storage.restoreConflict);
        expect(deps.alertNormalWait).not.toHaveBeenCalledWith(language.storage.restored);
        expect(reload).toHaveBeenCalledTimes(2);
    });

    it("keeps live snapshots visible when the report read fails", async () => {
        deps.readStorageReport.mockRejectedValue(new ResourceRequestError(503, "Storage report unavailable"));
        await open();
        expect(deps.readStorageReport).toHaveBeenCalledExactlyOnceWith();
        expect(deps.listBackups).toHaveBeenCalledExactlyOnceWith();
        expect(target.querySelector('[role="alert"]')?.textContent).toBe("Storage report unavailable");
        expect(heldBytes("Live A")).toBe(language.storage.missingValue);
        expect(heldBytes("Live B")).toBe(language.storage.missingValue);
        expect((await snapshotAction(language.storage.restore, "Live A")).disabled).toBe(false);
    });

    it("stops scheduled status polling when the page unmounts during a scan", async () => {
        deps.startStorageScan.mockResolvedValue(report({ running: true }));
        deps.readStorageStatus.mockResolvedValue({ running: true, version: 1 });
        await open();
        await click(language.storage.scan);
        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.readStorageStatus).toHaveBeenCalledExactlyOnceWith();
        await unmount(mounted!);
        mounted = undefined;
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(3000);
        expect(deps.readStorageStatus).toHaveBeenCalledTimes(1);
        expect(deps.readStorageReport).toHaveBeenCalledTimes(1);
    });

    it("ignores an in-flight status response after unmount without reading a report or rescheduling", async () => {
        const status = deferred<Awaited<ReturnType<typeof deps.readStorageStatus>>>();
        deps.startStorageScan.mockResolvedValue(report({ running: true }));
        deps.readStorageStatus.mockReturnValue(status.promise);
        await open();
        await click(language.storage.scan);
        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.readStorageStatus).toHaveBeenCalledExactlyOnceWith();
        await unmount(mounted!);
        mounted = undefined;
        // A newer report is available, but belongs to a page that has already left.
        status.resolve({ running: true, version: 2 });
        await settle();
        expect(deps.readStorageReport).toHaveBeenCalledTimes(1);
        expect(deps.listBackups).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(3000);
        expect(deps.readStorageStatus).toHaveBeenCalledTimes(1);
        expect(deps.readStorageReport).toHaveBeenCalledTimes(1);
    });
});

describe("StorageSettings usage summary", () => {
    afterEach(() => changeLanguage("en"));

    function section(id: string) {
        const found = target.querySelector<HTMLElement>(`[data-settings-section="storage.${id}"]`);
        expect(found, `storage ${id} section`).not.toBeNull();
        return found!;
    }

    function pageHeader() {
        let row: HTMLElement | null = button(language.storage.scan);
        while (row && !row.querySelector("h2")) row = row.parentElement;
        expect(row, "row containing the page heading and Scan").not.toBeNull();
        expect(row!.querySelector("h2")?.textContent).toBe(language.storagePage.title);
        expect(row!.querySelector("[data-settings-section]")).toBeNull();
        return row!;
    }

    it.each([
        {
            scenario: "known disk in English",
            locale: "en",
            disk: { total: 2000, free: 500 },
            unmanaged: "Unrecognized files in assets",
        },
        { scenario: "unknown disk in Korean", locale: "ko", disk: null, unmanaged: "에셋 폴더의 인식되지 않은 파일" },
    ])(
        "renders the overview legend, bar, cards, and header scan time for $scenario",
        async ({ locale, disk, unmanaged }) => {
            changeLanguage(locale);
            deps.readStorageReport.mockResolvedValue(report({ disk }));
            await open();

            const header = pageHeader();
            expect(header.textContent).toContain(
                `${language.storage.generatedAt}: ${new Date(SCANNED_AT).toLocaleString()}`,
            );
            expect(header.textContent).not.toContain(language.storage.noScanYet);

            const overview = section("overview");
            const expectedLegend = [
                [language.storage.assetsOnDisk, bytes(201)],
                [language.storage.resourcesDb, bytes(202)],
                [language.storage.snapshots, bytes(203)],
                [language.storage.thumbnails, bytes(204)],
                [language.storage.staging, bytes(205)],
                [unmanaged, bytes(206)],
                ...(disk
                    ? [
                          [language.storagePage.overview.outside, bytes(279)],
                          [language.storagePage.overview.free, bytes(500)],
                      ]
                    : []),
            ];
            const legend = [...overview.querySelectorAll("li")];
            expect(
                legend.map((item) =>
                    [...item.querySelectorAll("span")].map((span) => span.textContent?.trim()).filter(Boolean),
                ),
            ).toEqual(expectedLegend);
            if (disk) {
                expect(legend[6].querySelector("p")?.textContent?.trim()).toBe(
                    language.storagePage.overview.outsideHelp,
                );
                expect(overview.textContent).not.toContain(language.storagePage.overview.diskUnknown);
            } else {
                expect(overview.textContent).toContain(language.storagePage.overview.diskUnknown);
                expect(overview.textContent).not.toContain(language.storagePage.overview.outsideHelp);
            }

            const bars = overview.querySelectorAll<HTMLElement>('div[aria-hidden="true"]');
            expect(bars).toHaveLength(1);
            const expectedWidths = disk
                ? [10.05, 10.1, 10.15, 10.2, 10.25, 10.3, 13.95, 25]
                : [201, 202, 203, 204, 205, 206].map((size) => (size / 1221) * 100);
            expect(bars[0].children).toHaveLength(expectedWidths.length);
            [...bars[0].children].forEach((segment, index) => {
                expect(parseFloat((segment as HTMLElement).style.width)).toBeCloseTo(expectedWidths[index]);
            });

            for (const [label, values] of [
                [language.storagePage.overview.reclaimable, [bytes(60)]],
                [
                    language.storagePage.overview.snapshotsCard,
                    [bytes(203), language.storagePage.overview.snapshotCount(3)],
                ],
                [language.storagePage.overview.dedupeSaved, [bytes(80)]],
            ] as const) {
                const title = [...overview.querySelectorAll("p")].find((item) => item.textContent?.trim() === label);
                expect(title, `card ${label}`).toBeDefined();
                expect(
                    [...title!.parentElement!.querySelectorAll("p")].map((item) => item.textContent?.trim()),
                ).toEqual([label, ...values]);
            }
        },
    );

    it("keeps loading, no-scan, scan-error, and scanning states in the page header", async () => {
        const pendingReport = deferred<AssetLifecycleReport>();
        deps.readStorageReport.mockReturnValueOnce(pendingReport.promise);
        deps.startStorageScan
            .mockRejectedValueOnce(new ResourceRequestError(503, "Scan unavailable"))
            .mockResolvedValueOnce(report({ running: true }));
        await open();
        const scan = button(language.storage.scan);
        const header = pageHeader();
        expect(header.textContent).toContain(language.storage.loading);
        expect(header.textContent).not.toContain(language.storage.noScanYet);
        expect(header.textContent).not.toContain(language.storage.generatedAt);
        expect(scan.disabled).toBe(true);

        pendingReport.resolve(report({ generatedAt: null }));
        await settle();
        expect(header.textContent).toContain(language.storage.noScanYet);
        expect(header.textContent).not.toContain(language.storage.generatedAt);
        expect(header.textContent).not.toContain(language.storage.loading);
        expect(scan.disabled).toBe(false);

        await click(language.storage.scan);
        expect(header.querySelector('[role="alert"]')?.textContent).toBe("Scan unavailable");
        expect(scan.disabled).toBe(false);
        await click(language.storage.scan);
        expect(header.querySelector('[role="status"]')?.textContent).toBe(language.storage.scanning);
        expect(header.textContent).toContain(new Date(SCANNED_AT).toLocaleString());
        expect(header.textContent).not.toContain(language.storage.noScanYet);
        expect(header.querySelector('[role="alert"]')).toBeNull();
        expect(scan.disabled).toBe(true);
    });

    it("shows ten owners by descending bytes, toggles all and back, and hides the toggle at ten", async () => {
        const owners: AssetLifecycleReport["owners"] = [3, 12, 1, 7, 11, 2, 9, 6, 10, 4, 8, 5].map((rank) => ({
            kind: rank % 2 ? "character" : "module",
            id: `owner-${rank}`,
            name: `Owner ${rank}`,
            count: rank + 1,
            bytes: rank * 10,
        }));
        deps.readStorageReport.mockResolvedValue(report({ owners }));
        await open();
        await click(language.storagePage.owners.title);
        const ownerSection = section("owners");
        function expectOwners(ranks: number[]) {
            const rows = [...ownerSection.querySelectorAll('[role="row"]')].filter((row) =>
                row.querySelector('[role="cell"]'),
            );
            expect(
                rows.map((row) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent?.trim())),
            ).toEqual(
                ranks.map((rank) => [
                    language.storage.ownerKinds[rank % 2 ? "character" : "module"],
                    `Owner ${rank}`,
                    `${rank + 1}`,
                    bytes(rank * 10),
                ]),
            );
            rows.forEach((row, index) => {
                const bar = row.querySelector<HTMLElement>('[aria-hidden="true"] > div');
                expect(bar).not.toBeNull();
                expect(parseFloat(bar!.style.width)).toBeCloseTo((ranks[index] / 12) * 100);
            });
        }
        const topTen = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3];
        expectOwners(topTen);
        expect(button(language.storagePage.owners.showAll(12), ownerSection).getAttribute("aria-expanded")).toBe(
            "false",
        );
        await click(language.storagePage.owners.showAll(12), ownerSection);
        expectOwners([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
        expect(button(language.storagePage.owners.showFewer, ownerSection).getAttribute("aria-expanded")).toBe("true");
        await click(language.storagePage.owners.showFewer, ownerSection);
        expectOwners(topTen);

        deps.startStorageScan.mockResolvedValue(report({ owners: owners.filter((owner) => owner.bytes >= 30) }));
        await click(language.storage.scan);
        expectOwners(topTen);
        expect(ownerSection.querySelector('[role="table"]')?.parentElement?.querySelector("button")).toBeNull();
    });
});
