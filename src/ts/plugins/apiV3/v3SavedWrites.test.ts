import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "src/ts/storage/tests/mutationStoresHarness";

// Phase 4, slice 2 (`plugin-host-setters`): the plugin host API against the real save adapter and
// the real server store (`storeBackedServer.ts`), with the deep `pluginCustomStorage` watcher deleted
// (`PLAN.md` Invariant 2: `pluginStorage` is written through explicit mutations only). Every
// storage write of the API reaches the `pluginStorage` record because its mutation marks the
// record: v3 `pluginStorage` set, remove, and clear, `getLocalPluginStorage()` set, remove, and
// clear, a custom key and its deletion, and a whole-root replacement. Detached reads mark nothing,
// and a record reloaded after a conflict (server data) is not echoed back. Data-loss plan slice 5a:
// two tabs writing different keys are merged (both kept, no notice, no event); the same key written
// to two values discards this tab's unsaved values with the notice, and `onStorageDiscarded` tells
// every listening plugin the lost keys (a rejecting listener is logged, an unloaded plugin's is
// removed). The other setters land
// in their owners' records: an argument in `plugins`, a color scheme in `ui`, a forwarded key in
// the selected preset of `presets`, and an explicit `characterOrder` sent before the `characters`
// it names in `characterOrder`.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { server, alerts, captured } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
    captured: { api: null as CapturedApi | null },
}));

vi.mock("src/ts/storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("src/ts/alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertReloadNotice: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: vi.fn(async () => true),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
// The real parser module installs a module-level `$effect.root` over the selection, which is still
// uninitialized here because the modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(apiFactory: CapturedApi) {
            captured.api = apiFactory;
        }
        run() {}
        executeInIframe() {
            return Promise.resolve();
        }
        dispose() {}
        terminate() {}
    },
}));

/**
 * Boots the harness (a fresh module graph), then loads the host API on that graph and captures the
 * API object of one plugin (`plug`, the plugin the harness seeds, so `setArgument` has a record).
 */
async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const v3: typeof import("./v3.svelte") = await import("./v3.svelte");
    captured.api = null;
    await v3.executePluginV3({ name: "plug", script: "", version: "3.0" } as any);
    expect(captured.api).not.toBeNull();
    const api = captured.api!;
    const storage = () => booted.record("pluginStorage");
    /** Loads a second plugin on the same graph and captures its API object. */
    const loadPlugin = async (name: string) => {
        captured.api = null;
        await v3.executePluginV3({ name, script: "", version: "3.0" } as any);
        expect(captured.api).not.toBeNull();
        return captured.api!;
    };
    return { ...booted, api, storage, v3, loadPlugin };
}

/** Lets the not-awaited listener calls of a discard run. */
const settled = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
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
});

describe("plugin storage writes sent without the watcher", () => {
    it("v3 pluginStorage set, remove, and clear reach the pluginStorage record", async () => {
        const { api, sync, storage } = await boot();
        await api._setPluginStorage("k", { list: [1] });
        await api._setPluginStorage("n", null);
        await sync.flushResources();
        expect(storage()._pluginStorage).toEqual({ k: { list: [1] }, n: null });
        await api._removePluginStorage("k");
        await sync.flushResources();
        expect(storage()._pluginStorage).toEqual({ n: null });
        await api._clearPluginStorage();
        await sync.flushResources();
        expect(storage()._pluginStorage).toEqual({});
    });

    it("getLocalPluginStorage() set, remove, and clear reach the record, undefined stored as null", async () => {
        const { api, sync, storage } = await boot();
        const local = api.getLocalPluginStorage();
        await local.setItem("a", "x");
        await local.setItem("u", undefined);
        await sync.flushResources();
        expect(storage()._safeLocalPluginStorage).toEqual({ a: "x", u: null });
        await local.removeItem("a");
        await sync.flushResources();
        expect(storage()._safeLocalPluginStorage).toEqual({ u: null });
        await local.clear();
        await sync.flushResources();
        expect(storage()._safeLocalPluginStorage).toEqual({});
    });

    it("a custom key of setDatabase, its deletion, and a whole-root replacement reach the record", async () => {
        const { api, sync, storage } = await boot();
        await api.setDatabase({ custom: { v: 1 } });
        await api.setDatabaseLite({ other: "o" });
        await sync.flushResources();
        expect(storage()).toEqual({ custom: { v: 1 }, other: "o" });
        await api.setDatabaseLite({ custom: undefined });
        await sync.flushResources();
        expect(storage()).toEqual({ other: "o" });
        await api.setDatabase({ pluginCustomStorage: { _pluginStorage: { k: 1 }, _safeLocalPluginStorage: { s: 2 } } });
        await sync.flushResources();
        expect(storage()).toEqual({ _pluginStorage: { k: 1 }, _safeLocalPluginStorage: { s: 2 } });
        expect(await api._getPluginStorage("k")).toBe(1);
        expect(await api.getLocalPluginStorage().getItem("s")).toBe(2);
    });

    it("a refused write and detached reads mark nothing: no batch is sent and the record is unchanged", async () => {
        const { api, sync, storage, fake } = await boot();
        await api._setPluginStorage("k", { a: 1 });
        await api.getLocalPluginStorage().setItem("s", [1]);
        await sync.flushResources();
        const batches = fake.batchCount();

        await expect(api._setPluginStorage("big", 1n)).rejects.toThrow(TypeError);
        await expect(api.getLocalPluginStorage().setItem("fn", () => 1)).rejects.toThrow(TypeError);
        const read = await api._getPluginStorage("k");
        read.a = 2;
        read.injected = true;
        const local = await api.getLocalPluginStorage().getItem("s");
        local.push(2);
        (await api._keysPluginStorage()).push("phantom");
        (await api.getLocalPluginStorage().keys()).push("phantom");
        await sync.flushResources();

        expect(fake.batchCount()).toBe(batches);
        expect(storage()).toEqual({ _pluginStorage: { k: { a: 1 } }, _safeLocalPluginStorage: { s: [1] } });
        expect(await api._getPluginStorage("k")).toEqual({ a: 1 });
    });

    it("a record another tab changed under the same key is reloaded on the conflict, not echoed back, and the plugin hears the lost key", async () => {
        const { api, sync, storage, fake, settings } = await boot();
        const events: unknown[] = [];
        await api.onStorageDiscarded((event: unknown) => events.push(event));
        await api._setPluginStorage("k", 1);
        await sync.flushResources();
        // Another tab writes `k` too; this client's write of `k` is stale and is discarded.
        fake.set("pluginStorage", "main", { _pluginStorage: { k: 9, remote: true } });
        await api._setPluginStorage("k", 2);
        const result = await sync.flushResources();
        await settled();
        expect(result.discarded).toEqual(["pluginStorage/main"]);
        expect(plain(settings.pluginStorage)).toEqual({ _pluginStorage: { k: 9, remote: true } });
        expect(await api._getPluginStorage("remote")).toBe(true);
        expect(await api._getPluginStorage("k")).toBe(9);
        expect(alerts.normal).toHaveBeenCalled();
        expect(events).toEqual([
            { type: "storageDiscarded", pluginStorage: ["k"], localPluginStorage: [], customStorage: false },
        ]);
        // The hydrated data is the saved state: nothing is echoed back.
        const batches = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(batches);
        expect(storage()).toEqual({ _pluginStorage: { k: 9, remote: true } });
        // The next write starts from the reloaded record.
        await api._setPluginStorage("k", 3);
        await sync.flushResources();
        expect(storage()).toEqual({ _pluginStorage: { k: 3, remote: true } });
        expect(events).toHaveLength(1);
    });

    it("two tabs writing different keys both keep them: merged on the conflict, no notice, no event, no echo", async () => {
        const { api, sync, storage, fake } = await boot();
        const events: unknown[] = [];
        await api.onStorageDiscarded((event: unknown) => events.push(event));
        await api._setPluginStorage("k", 1);
        await sync.flushResources();
        fake.set("pluginStorage", "main", {
            _pluginStorage: { k: 1, remote: true },
            _safeLocalPluginStorage: { s: 1 },
        });
        await api._setPluginStorage("k", 2);
        await api.getLocalPluginStorage().setItem("mine", "m");
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        await settled();
        expect(storage()).toEqual({
            _pluginStorage: { k: 2, remote: true },
            _safeLocalPluginStorage: { s: 1, mine: "m" },
        });
        expect(await api._getPluginStorage("remote")).toBe(true);
        expect(await api._getPluginStorage("k")).toBe(2);
        expect(await api.getLocalPluginStorage().getItem("s")).toBe(1);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        const batches = fake.batchCount();
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(batches);
    });

    it("every listening plugin hears a discard (local storage keys, a custom key as a flag), a rejecting listener is logged, and an unloaded plugin's listener is removed", async () => {
        const { api, sync, fake, v3, loadPlugin } = await boot();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        await api.onStorageDiscarded(async () => {
            throw new Error("listener failed");
        });
        const other = await loadPlugin("other");
        const events: unknown[] = [];
        await other.onStorageDiscarded((event: unknown) => events.push(event));
        await api.getLocalPluginStorage().setItem("a", 1);
        await api.setDatabase({ custom: 1 });
        await sync.flushResources();

        fake.set("pluginStorage", "main", { _safeLocalPluginStorage: { a: 2 }, custom: 1 });
        await api.getLocalPluginStorage().setItem("a", 3);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        await settled();
        expect(events).toEqual([
            { type: "storageDiscarded", pluginStorage: [], localPluginStorage: ["a"], customStorage: false },
        ]);
        expect(errors).toHaveBeenCalledWith(
            "[RisuAI Plugin: plug] storageDiscarded listener failed",
            expect.objectContaining({ message: "listener failed" }),
        );

        fake.set("pluginStorage", "main", { _safeLocalPluginStorage: { a: 2 }, custom: 2 });
        await api.setDatabase({ custom: 3 });
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        await settled();
        expect(events[1]).toEqual({
            type: "storageDiscarded",
            pluginStorage: [],
            localPluginStorage: [],
            customStorage: true,
        });

        // Unloaded plugins hear nothing more.
        errors.mockClear();
        await v3.loadV3Plugins([]);
        fake.set("pluginStorage", "main", { _safeLocalPluginStorage: { a: 5 }, custom: 2 });
        await api.getLocalPluginStorage().setItem("a", 6);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        await settled();
        expect(events).toHaveLength(2);
        expect(errors).not.toHaveBeenCalledWith(
            "[RisuAI Plugin: plug] storageDiscarded listener failed",
            expect.anything(),
        );
    });
});

describe("the other setters land in their owners' records", () => {
    it("setArg and setArgument reach the plugins record", async () => {
        const { api, sync, record } = await boot();
        api.setArg("plug::a", "2");
        await api.setArgument("b", 3);
        await sync.flushResources();
        expect(record("plugins")[0].realArg).toEqual({ a: "2", b: 3 });
    });

    it("changeColorScheme reaches the ui record", async () => {
        const { api, sync, record } = await boot();
        api.changeColorScheme("light");
        await sync.flushResources();
        expect(record("ui").colorSchemeName).toBe("light");
        expect(record("ui").colorScheme).toMatchObject({ type: "light", bgcolor: "#ffffff" });
    });

    it("a forwarded key reaches the selected preset of its owner's record and no other", async () => {
        const { api, sync, record, selection, collectionStore } = await boot();
        // `temperature` is the prompt preset's, `maxContext` the selected model preset's main profile's
        // (`docs/plan/split-preset.md`, `docs/plan/model-profiles.md` O8). The other model preset gets
        // a main profile of its own, so the two do not share the written record.
        const otherModelId = record("modelPresets").find((preset: any) => preset.id !== selection.modelPresetId).id;
        const otherProfileId = collectionStore.addModelProfile({ name: "Other" });
        collectionStore.setMainModelSlot(otherModelId, otherProfileId);
        await api.setDatabase({ temperature: 77 });
        await api.setDatabaseLite({ maxContext: 4321 });
        await sync.flushResources();
        const presets = record("presets");
        const selected = presets.find((preset: any) => preset.id === selection.presetId);
        const other = presets.find((preset: any) => preset.id !== selection.presetId);
        expect(selected).toMatchObject({ temperature: 77 });
        expect(selected).not.toHaveProperty("maxContext");
        expect(other.temperature).not.toBe(77);
        const modelPresets = record("modelPresets");
        const selectedModel = modelPresets.find((preset: any) => preset.id === selection.modelPresetId);
        expect(selectedModel).not.toHaveProperty("maxContext");
        expect(selectedModel).not.toHaveProperty("temperature");
        const profiles = record("modelProfiles");
        const selectedProfile = profiles.find((profile: any) => profile.id === selectedModel.mainSlot.profileId);
        const otherProfile = profiles.find((profile: any) => profile.id === otherProfileId);
        expect(selectedProfile).toMatchObject({ maxContext: 4321 });
        expect(selectedProfile).not.toHaveProperty("temperature");
        expect(otherProfile.maxContext).not.toBe(4321);
    });

    it("an explicit characterOrder sent before the characters it names is the saved order", async () => {
        const { api, sync, record, fake, characterList } = await boot();
        await api.setDatabaseLite({
            characterOrder: [{ id: "f", name: "F", color: "", data: ["e", "c"] }, "d"],
            characters: [
                plain(characterList()[0]),
                { chaId: "d", name: "D", chats: [] },
                { chaId: "e", name: "E", chats: [] },
            ],
        });
        await sync.flushResources();
        expect(record("characterOrder")).toEqual([{ id: "f", name: "F", color: "", data: ["e", "c"] }, "d"]);
        expect(record("characters", "d")).toMatchObject({ name: "D" });
        expect(record("characters", "e")).toMatchObject({ name: "E" });
        expect(fake.order("e")!.ids).toHaveLength(1);
        expect(characterList().map((character: any) => character.chaId)).toEqual(["c", "d", "e"]);
    });
});
