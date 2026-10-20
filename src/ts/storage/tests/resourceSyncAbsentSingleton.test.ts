import { tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// A tab that booted while the server had no `pluginStorage/main` record (the one mirrored singleton
// that exists only once a plugin writes it; audit PERSIST-01, `docs/plan/audit-findings-perf.md`
// slice 2d) over the real store and its change feed: another client's creation of the record is
// adopted from the live update and from a reconnect's revision listing, with no outgoing write, and
// a later local plugin write is an update on the held revision. A tab that wrote its own record
// first meets the other tab's creation as a conflict: since data-loss plan slice 5a the two creates
// are merged key by key against an empty base (both keys stay, no notice); only the same key written
// to two values keeps the old policy (the server copy wins, the discard reported to the plugins).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined), terminal: vi.fn() },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertTerminal: alerts.terminal,
    }),
);
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");
type Storage = typeof import("../pluginStorageStore.svelte");

const KINDS = Object.values(RESOURCE_KIND);
const REMOTE = { _pluginStorage: { remoteSetting: "saved elsewhere" } };

/** Boots against a store without `pluginStorage/main`, the feed delivered live unless `live` is false. */
async function boot({ live = true } = {}) {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ feed: true });
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const storage: Storage = await import("../pluginStorageStore.svelte");

    const snapshot = await client.readKinds(KINDS, { chatSummaries: true });
    expect(snapshot.kinds.pluginStorage).toHaveLength(0);
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chatSummaries ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    chat.initializeChats();
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    expect(fake.record("pluginStorage", "main")).toBeNull();
    fake.requests.length = 0;
    if (live) {
        fake.onFeed = (event: ServerFeedEvent) => {
            if (event.type === "change") {
                sync.noteRemoteChanges(event.changes);
            }
        };
    }
    const reads = () => fake.requests.filter((request) => request.path === "/api/resources/read").length;
    return { fake, sync, storage, reads };
}

beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
    server.current = null;
});

it("adopts the first remote creation from the live update and updates it with the next local write", async () => {
    const h = await boot();
    h.fake.set("pluginStorage", "main", REMOTE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.storage.getPluginStorageValue("remoteSetting")).toBe("saved elsewhere");
    expect(h.sync.heldRecordRevision("pluginStorage", "main")).toBe(h.fake.record("pluginStorage", "main")!.revision);
    expect(h.reads()).toBe(1);
    expect(h.fake.batchCount()).toBe(0);

    h.storage.setPluginStorageItem("newLocalSetting", "local value");
    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.fake.record("pluginStorage", "main")!.data).toEqual({
        _pluginStorage: { remoteSetting: "saved elsewhere", newLocalSetting: "local value" },
    });
    expect(h.storage.getPluginStorageValue("newLocalSetting")).toBe("local value");
    expect(alerts.error).not.toHaveBeenCalled();
});

it("adopts it from a reconnect's revision listing when the live update was missed", async () => {
    const h = await boot({ live: false });
    h.fake.set("pluginStorage", "main", REMOTE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.storage.getPluginStorageValue("remoteSetting")).toBeNull();

    h.sync.reconcileRemote(h.fake.store.listRevisions());
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.storage.getPluginStorageValue("remoteSetting")).toBe("saved elsewhere");
    expect(h.sync.heldRecordRevision("pluginStorage", "main")).not.toBeNull();
    expect(h.fake.batchCount()).toBe(0);
});

it("merges a concurrent creation with its own unsaved record when the keys differ: both keys on the server, no discard, no notice", async () => {
    const h = await boot();
    const discards: unknown[] = [];
    h.sync.onPluginStorageDiscarded((lost) => discards.push(lost));
    h.storage.setPluginStorageItem("newLocalSetting", "local value");
    h.fake.set("pluginStorage", "main", REMOTE);
    await vi.advanceTimersByTimeAsync(100);
    // The live update waits: the local record is not overwritten before its save decides.
    expect(h.storage.getPluginStorageValue("newLocalSetting")).toBe("local value");
    expect(h.storage.getPluginStorageValue("remoteSetting")).toBeNull();

    expect((await h.sync.flushResources()).discarded).toEqual([]);
    const merged = { _pluginStorage: { remoteSetting: "saved elsewhere", newLocalSetting: "local value" } };
    expect(h.fake.record("pluginStorage", "main")!.data).toEqual(merged);
    expect(h.storage.getPluginStorageValue("remoteSetting")).toBe("saved elsewhere");
    expect(h.storage.getPluginStorageValue("newLocalSetting")).toBe("local value");
    expect(h.sync.heldRecordRevision("pluginStorage", "main")).toBe(h.fake.record("pluginStorage", "main")!.revision);
    expect(alerts.normal).not.toHaveBeenCalled();
    expect(discards).toEqual([]);
    // Idle afterwards: nothing is echoed back.
    const batches = h.fake.batchCount();
    await h.sync.flushResources();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.fake.batchCount()).toBe(batches);
    expect(h.fake.record("pluginStorage", "main")!.data).toEqual(merged);
});

it("control: a concurrent creation of the same key keeps the old policy (the server copy wins, the plugins are told)", async () => {
    const h = await boot();
    const discards: unknown[] = [];
    h.sync.onPluginStorageDiscarded((lost) => discards.push(lost));
    h.storage.setPluginStorageItem("remoteSetting", "local value");
    h.fake.set("pluginStorage", "main", REMOTE);
    expect((await h.sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
    expect(h.storage.getPluginStorageValue("remoteSetting")).toBe("saved elsewhere");
    expect(h.fake.record("pluginStorage", "main")!.data).toEqual(REMOTE);
    expect(alerts.normal).toHaveBeenCalledWith("reloaded");
    expect(discards).toEqual([{ pluginStorage: ["remoteSetting"], localPluginStorage: [], customStorage: false }]);
});
