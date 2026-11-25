// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { settleFlush } from "src/ts/storage/tests/flushRetry";
import { bootMutations, SAVE_DEBOUNCE_MS, warmMutationGraph } from "src/ts/storage/tests/mutationStoresHarness";
import type { StoreBackedServer } from "src/ts/storage/tests/storeBackedServer";
import type { StorageController } from "./storageController.svelte";
import type { AssetLifecycleReport } from "../../../../../shared/assetLifecycle.ts";

const deps = vi.hoisted(() => ({
    readStorageReport: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["readStorageReport"]>(),
    readStorageStatus: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["readStorageStatus"]>(),
    startStorageScan: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["startStorageScan"]>(),
    sweepAssets: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["sweepAssets"]>(),
    loadAssetPreview: vi.fn<(typeof import("src/ts/storage/assetLifecycleClient"))["loadAssetPreview"]>(),
    listBackups: vi.fn<(typeof import("src/ts/storage/resourceClient"))["listBackups"]>(),
    alertConfirm: vi.fn<(typeof import("src/ts/alert"))["alertConfirm"]>(),
    alertNormalWait: vi.fn<(typeof import("src/ts/alert"))["alertNormalWait"]>(),
    alertNormal: vi.fn<(typeof import("src/ts/alert"))["alertNormal"]>(),
}));
const io = vi.hoisted(() => ({
    server: null as StoreBackedServer | null,
    snapshots: [] as { theme: string; label: string | null }[],
    saveAck: null as { entered: () => void; release: Promise<void> } | null,
}));
vi.mock("src/ts/storage/serverAuth", () => ({
    authFetch: async (url: string, init?: RequestInit) => {
        if (url === "/api/backups") return Response.json({ items: await deps.listBackups() });
        if (url === "/api/backups/snapshot") {
            io.snapshots.push({
                theme: io.server!.record("ui", "main")!.data.theme,
                label: JSON.parse(init!.body as string).label,
            });
            return Response.json({ snapshot: { id: "saved-snapshot", label: null } });
        }
        const response = await io.server!.fetch(url, init);
        if (url === "/api/resources/batch" && io.saveAck) {
            const ack = io.saveAck;
            io.saveAck = null;
            ack.entered();
            await ack.release;
        }
        return response;
    },
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock(
    "src/ts/storage/assetLifecycleClient",
    () =>
        ({
            readStorageReport: deps.readStorageReport,
            readStorageStatus: deps.readStorageStatus,
            startStorageScan: deps.startStorageScan,
            sweepAssets: deps.sweepAssets,
            loadAssetPreview: deps.loadAssetPreview,
        }) satisfies typeof import("src/ts/storage/assetLifecycleClient"),
);
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: deps.alertConfirm,
        alertNormalWait: deps.alertNormalWait,
        alertNormal: deps.alertNormal,
    }),
);

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

function defer() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

let controller: StorageController;
beforeAll(
    () =>
        warmMutationGraph(() =>
            Promise.all([import("./storageController.svelte"), import("src/ts/drive/backuplocal")]),
        ),
    60_000,
);
beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
    io.snapshots.length = 0;
    io.saveAck = null;
    deps.listBackups.mockResolvedValue([]);
    const module = await import("./storageController.svelte");
    controller = new module.StorageController();
});
afterEach(() => {
    controller.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    io.server?.close();
    io.server = null;
});

describe("StorageController", () => {
    it("waits for a retrying edit's acknowledgement before requesting its snapshot", async () => {
        const h = await bootMutations((server) => {
            io.server = server;
        });
        const original = h.record("ui").theme;
        h.fake.failNext = { status: 0, times: 1, match: (url) => url === "/api/resources/batch" };
        h.settings.ui.theme = "pending theme";
        await tick();
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(h.fake.failNext).toBeNull();
        expect(h.record("ui").theme).toBe(original);

        const entered = defer();
        const release = defer();
        io.saveAck = { entered: () => entered.resolve(), release: release.promise };
        controller.busy = false;
        controller.snapshotLabel = "Before risky change";
        const taking = controller.take();
        try {
            await Promise.race([entered.promise, taking]);
            expect(io.snapshots).toEqual([]);
        } finally {
            release.resolve();
            await taking;
        }
        expect(io.snapshots).toEqual([{ theme: "pending theme", label: "Before risky change" }]);
        expect(controller.snapshotLabel).toBe("");
        expect(controller.error).toBe("");
        expect(controller.busy).toBe(false);
        expect(deps.alertNormal).not.toHaveBeenCalled();
    });

    it("keeps the label and shows a failed flush without requesting a snapshot", async () => {
        const h = await bootMutations((server) => {
            io.server = server;
        });
        h.settings.ui.theme = "unsaved theme";
        // The save fails and the flush's resend stays unanswered: the snapshot stops at the save deadline.
        h.fake.failNext = { status: 0, times: 1, match: (url) => url === "/api/resources/batch" };
        h.fake.holdNextBatch = true;
        controller.busy = false;
        controller.snapshotLabel = "Keep this label";
        await settleFlush(Promise.resolve(controller.take()));
        expect(h.fake.failNext).toBeNull();
        expect(h.fake.releaseBatch).not.toBeNull();
        expect(io.snapshots).toEqual([]);
        expect(controller.error).toBe(
            "Could not save your latest changes before the snapshot: The server has not answered the save request. Please try again shortly.",
        );
        expect(controller.snapshotLabel).toBe("Keep this label");
        expect(controller.busy).toBe(false);
        expect(deps.alertNormal).not.toHaveBeenCalled();
        h.fake.releaseBatch!();
    });

    it.each(["chat", "order"])(
        "names a refused %s and any discarded work in the snapshot notice even if refreshing the list fails",
        async (kind) => {
            const h = await bootMutations((server) => {
                io.server = server;
            });
            if (kind === "chat") h.chat.setChatMeta({ chaId: "c", chatId: "k" }, { note: "refused note" });
            else h.chat.reorderChats("c", ["j", "k"]);
            h.fake.failNext = {
                status: 400,
                times: 1,
                match: (url) => url === "/api/resources/batch",
                body: { error: `${kind === "chat" ? "chats" : "chatOrders"}[0] is refused` },
            };
            deps.listBackups.mockRejectedValueOnce(new Error("Snapshot list unavailable"));
            controller.busy = false;
            await controller.take();
            expect(io.snapshots).toHaveLength(1);
            expect(deps.alertNormal).toHaveBeenCalledExactlyOnceWith(
                (kind === "chat"
                    ? "While your latest changes were being saved for this backup, another tab or device changed some of the same data. Its version was kept and is in the backup; those changes of yours were replaced and are not in it.\n\n"
                    : "") +
                    "The server refused local changes to the following items. This snapshot holds the server's copy and does not contain those local changes:\n" +
                    (kind === "chat" ? "- C / K" : "- Chat order: C"),
            );
            expect(controller.error).toBe("Snapshot list unavailable");
        },
    );

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
