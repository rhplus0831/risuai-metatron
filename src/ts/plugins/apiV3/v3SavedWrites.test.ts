import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain, warmMutationGraph } from "src/ts/storage/tests/mutationStoresHarness";

// The plugin host API against the real save adapter and the real server store
// (`storeBackedServer.ts`), with no deep `pluginCustomStorage` watcher (`pluginStorage` is written
// through explicit mutations only). Every storage write of the API reaches the `pluginStorage`
// record because its mutation marks the record: v3 `pluginStorage` set, remove, and clear,
// `getLocalPluginStorage()` set, remove, and clear, a custom key and its deletion, and a whole-root
// replacement. Detached reads mark nothing, and a record reloaded after a conflict (server data) is
// not echoed back. Two tabs writing different keys are merged (both kept, no notice, no event); the
// same key written to two values discards this tab's unsaved values with the notice, and
// `onStorageDiscarded` tells every listening plugin the lost keys (a rejecting listener is logged,
// an unloaded plugin's is removed). The other setters land in their owners' records: an argument in
// `plugins`, a color scheme in `ui`, a forwarded key in the selected preset of `presets`, and an
// explicit `characterOrder` sent before the `characters` it names in `characterOrder`.

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
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: vi.fn(async () => true),
    }),
);
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
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
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
    /**
     * Installs a second plugin (owned storage writes need the owner in `settings.plugins`), loads it
     * on the same graph, and captures its API object.
     */
    const loadPlugin = async (name: string) => {
        booted.settings.plugins = [...(booted.settings.plugins ?? []), { name, script: "", version: "3.0" } as any];
        captured.api = null;
        await v3.executePluginV3({ name, script: "", version: "3.0" } as any);
        expect(captured.api).not.toBeNull();
        return captured.api!;
    };
    return { ...booted, api, storage, v3, loadPlugin };
}

/** Lets the not-awaited listener calls of a discard run. */
const settled = () => vi.advanceTimersByTimeAsync(0);

beforeAll(() => warmMutationGraph(() => import("./v3.svelte")), 60_000);

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
        expect(storage()._ownedPluginStorage).toEqual({ "plug\u0000k": { list: [1] }, "plug\u0000n": null });
        await api._removePluginStorage("k");
        await sync.flushResources();
        expect(storage()._ownedPluginStorage).toEqual({ "plug\u0000n": null });
        await api._clearPluginStorage();
        await sync.flushResources();
        expect(storage()._ownedPluginStorage).toEqual({ plug: { legacyHidden: true } });
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
        expect(storage()).toEqual({
            _ownedPluginStorage: { "plug\u0000k": { a: 1 } },
            _safeLocalPluginStorage: { s: [1] },
        });
        expect(await api._getPluginStorage("k")).toEqual({ a: 1 });
    });

    it("a record another tab changed under the same key is reloaded on the conflict, not echoed back, and the plugin hears the lost key", async () => {
        const { api, sync, storage, fake, settings } = await boot();
        const events: unknown[] = [];
        await api.onStorageDiscarded((event: unknown) => events.push(event));
        await api._setPluginStorage("k", 1);
        await sync.flushResources();
        // Another tab writes `k` too; this client's write of `k` is stale and is discarded.
        const remote = { _ownedPluginStorage: { "plug\u0000k": 9 }, _pluginStorage: { remote: true } };
        fake.set("pluginStorage", "main", remote);
        await api._setPluginStorage("k", 2);
        const result = await sync.flushResources();
        await settled();
        expect(result.discarded).toEqual(["pluginStorage/main"]);
        expect(plain(settings.pluginStorage)).toEqual(remote);
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
        expect(storage()).toEqual(remote);
        // The next write starts from the reloaded record.
        await api._setPluginStorage("k", 3);
        await sync.flushResources();
        expect(storage()).toEqual({ _ownedPluginStorage: { "plug\u0000k": 3 }, _pluginStorage: { remote: true } });
        expect(events).toHaveLength(1);
    });

    it("two tabs writing different keys both keep them: merged on the conflict, no notice, no event, no echo", async () => {
        const { api, sync, storage, fake } = await boot();
        const events: unknown[] = [];
        await api.onStorageDiscarded((event: unknown) => events.push(event));
        await api._setPluginStorage("k", 1);
        await sync.flushResources();
        fake.set("pluginStorage", "main", {
            _ownedPluginStorage: { "plug\u0000k": 1 },
            _pluginStorage: { remote: true },
            _safeLocalPluginStorage: { s: 1 },
        });
        await api._setPluginStorage("k", 2);
        await api.getLocalPluginStorage().setItem("mine", "m");
        expect(await sync.flushResources()).toEqual({ discarded: [], refused: [] });
        await settled();
        expect(storage()).toEqual({
            _ownedPluginStorage: { "plug\u0000k": 2 },
            _pluginStorage: { remote: true },
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

describe("owned v3 plugin storage", () => {
    it("keeps two plugins' same key separate, including a concurrent write by another owner", async () => {
        const { api, loadPlugin, sync, storage, fake } = await boot();
        const other = await loadPlugin("other");
        await api._setPluginStorage("shared", "plug value");
        await other._setPluginStorage("shared", "other value");
        await sync.flushResources();
        expect(storage()).toEqual({
            _ownedPluginStorage: { "plug\u0000shared": "plug value", "other\u0000shared": "other value" },
        });
        expect(await api._getPluginStorage("shared")).toBe("plug value");
        expect(await other._getPluginStorage("shared")).toBe("other value");

        fake.set("pluginStorage", "main", {
            _ownedPluginStorage: { "plug\u0000shared": "plug value", "other\u0000shared": "remote value" },
        });
        await api._setPluginStorage("shared", "local value");
        expect(await sync.flushResources()).toEqual({ discarded: [], refused: [] });
        expect(storage()).toEqual({
            _ownedPluginStorage: { "plug\u0000shared": "local value", "other\u0000shared": "remote value" },
        });
        expect(await api._getPluginStorage("shared")).toBe("local value");
        expect(await other._getPluginStorage("shared")).toBe("remote value");
    });

    it("reads owned keys before unshadowed legacy keys and removes both copies of a visible key", async () => {
        const { api, sync, storage } = await boot();
        await api.setDatabase({
            pluginCustomStorage: {
                _pluginStorage: { legacy: "old", shadow: "legacy shadow", tail: false },
                _ownedPluginStorage: { "plug\u0000own": 1, "plug\u0000shadow": null, "other\u0000private": 2 },
            },
        });
        await sync.flushResources();
        expect(await api._getPluginStorage("legacy")).toBe("old");
        expect(await api._getPluginStorage("shadow")).toBeNull();
        expect(await api._getPluginStorage("private")).toBeNull();
        expect(await api._keysPluginStorage()).toEqual(["own", "shadow", "legacy", "tail"]);
        expect(await api._lengthPluginStorage()).toBe(4);
        for (const [index, key] of ["own", "shadow", "legacy", "tail", null].entries()) {
            expect(await api._keyPluginStorage(index)).toBe(key);
        }

        await api._removePluginStorage("shadow");
        await api._removePluginStorage("legacy");
        await sync.flushResources();
        expect(await api._getPluginStorage("shadow")).toBeNull();
        expect(await api._getPluginStorage("legacy")).toBeNull();
        expect(storage()).toEqual({
            _pluginStorage: { tail: false },
            _ownedPluginStorage: { "plug\u0000own": 1, "other\u0000private": 2 },
        });
    });

    it("claims a legacy key with its owned write and legacy removal in one saved record patch", async () => {
        const { api, sync, storage, fake } = await boot();
        const keep = "unchanged".repeat(100);
        await api.setDatabase({
            pluginCustomStorage: {
                _pluginStorage: { claim: "legacy", keep },
                _ownedPluginStorage: { "other\u0000keep": keep },
            },
        });
        await sync.flushResources();
        fake.requests.length = 0;

        await api._setPluginStorage("claim", { value: "owned" });
        await sync.flushResources();
        const batches = fake.batchBodies();
        expect(batches).toHaveLength(1);
        expect(batches[0].ops).toHaveLength(1);
        expect(batches[0].ops[0]).toMatchObject({
            kind: "pluginStorage",
            id: "main",
            patch: {
                nested: {
                    _pluginStorage: { set: {}, remove: ["claim"] },
                    _ownedPluginStorage: { set: { "plug\u0000claim": { value: "owned" } }, remove: [] },
                },
            },
        });
        expect(storage()).toEqual({
            _pluginStorage: { keep },
            _ownedPluginStorage: { "other\u0000keep": keep, "plug\u0000claim": { value: "owned" } },
        });
    });

    it("clear hides legacy only for its owner, preserves other data, and leaves the empty key usable", async () => {
        const { api, loadPlugin, sync, storage } = await boot();
        const other = await loadPlugin("other");
        await api.setDatabase({
            pluginCustomStorage: {
                _pluginStorage: { shared: "legacy", untouched: "still legacy" },
                _ownedPluginStorage: { "plug\u0000old": "delete", "other\u0000private": "keep" },
            },
        });
        await sync.flushResources();
        await api._clearPluginStorage();
        await sync.flushResources();
        expect(storage()).toEqual({
            _pluginStorage: { shared: "legacy", untouched: "still legacy" },
            _ownedPluginStorage: { "other\u0000private": "keep", plug: { legacyHidden: true } },
        });
        expect(await api._getPluginStorage("shared")).toBeNull();
        expect(await api._keysPluginStorage()).toEqual([]);
        expect(await api._lengthPluginStorage()).toBe(0);
        expect(await api._keyPluginStorage(0)).toBeNull();
        expect(await other._getPluginStorage("shared")).toBe("legacy");
        expect(await other._getPluginStorage("private")).toBe("keep");

        await api._setPluginStorage("", "empty key");
        await api._setPluginStorage("shared", "new owned");
        await sync.flushResources();
        expect(await api._getPluginStorage("")).toBe("empty key");
        expect(await api._getPluginStorage("shared")).toBe("new owned");
        expect(await api._keysPluginStorage()).toEqual(["", "shared"]);
        expect(storage()._pluginStorage).toEqual({ shared: "legacy", untouched: "still legacy" });
        await api._removePluginStorage("shared");
        await sync.flushResources();
        expect(await api._getPluginStorage("shared")).toBeNull();
        expect(storage()).toEqual({
            _pluginStorage: { shared: "legacy", untouched: "still legacy" },
            _ownedPluginStorage: {
                "other\u0000private": "keep",
                plug: { legacyHidden: true },
                "plug\u0000": "empty key",
            },
        });
    });

    it("reports only each listener's unprefixed owned losses plus legacy losses in the existing event shape", async () => {
        const { api, loadPlugin, sync, fake } = await boot();
        const other = await loadPlugin("other");
        const ownEvents: unknown[] = [];
        const otherEvents: unknown[] = [];
        await api.onStorageDiscarded((event: any) =>
            ownEvents.push({ ...event, pluginStorage: event.pluginStorage.sort() }),
        );
        await other.onStorageDiscarded((event: any) =>
            otherEvents.push({ ...event, pluginStorage: event.pluginStorage.sort() }),
        );
        await api.setDatabase({
            pluginCustomStorage: {
                _pluginStorage: { legacy: 1 },
                _ownedPluginStorage: { "plug\u0000mine": 1, "other\u0000private": 1 },
                _safeLocalPluginStorage: { local: 1 },
                custom: 1,
            },
        });
        await sync.flushResources();
        fake.set("pluginStorage", "main", {
            _pluginStorage: { legacy: 9 },
            _ownedPluginStorage: { "plug\u0000mine": 9, "other\u0000private": 9 },
            _safeLocalPluginStorage: { local: 9 },
            custom: 9,
        });
        await api._setPluginStorage("mine", 2);
        await other._setPluginStorage("private", 2);
        await api.setDatabase({ pluginCustomStorage: { _pluginStorage: { legacy: 2 }, custom: 2 } });
        await api.getLocalPluginStorage().setItem("local", 2);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        await settled();
        expect(ownEvents).toEqual([
            {
                type: "storageDiscarded",
                pluginStorage: ["legacy", "mine"],
                localPluginStorage: ["local"],
                customStorage: true,
            },
        ]);
        expect(otherEvents).toEqual([
            {
                type: "storageDiscarded",
                pluginStorage: ["legacy", "private"],
                localPluginStorage: ["local"],
                customStorage: true,
            },
        ]);
    });

    it("reports newly visible legacy keys when a conflict rolls back the owner's clear marker", async () => {
        const { api, sync, fake } = await boot();
        const events: unknown[] = [];
        await api.onStorageDiscarded((event: unknown) => events.push(event));
        const stored = {
            _pluginStorage: { legacy: "visible again" },
            _ownedPluginStorage: { "other\u0000private": "keep" },
            custom: "base",
        };
        await api.setDatabase({ pluginCustomStorage: stored });
        await sync.flushResources();
        fake.set("pluginStorage", "main", { ...stored, custom: "remote" });
        await api._clearPluginStorage();
        await api.setDatabase({ custom: "local" });
        expect(await api._getPluginStorage("legacy")).toBeNull();
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        await settled();
        expect(await api._getPluginStorage("legacy")).toBe("visible again");
        expect(events).toEqual([
            {
                type: "storageDiscarded",
                pluginStorage: ["legacy"],
                localPluginStorage: [],
                customStorage: true,
            },
        ]);
    });

    it("keeps shared legacy storage behavior for a plugin name containing U+0000", async () => {
        const { api, loadPlugin, sync, storage } = await boot();
        const legacy = await loadPlugin("old\u0000plugin");
        await api._setPluginStorage("owned", "keep");
        await legacy._setPluginStorage("shared", "legacy value");
        await sync.flushResources();
        expect(storage()).toEqual({
            _ownedPluginStorage: { "plug\u0000owned": "keep" },
            _pluginStorage: { shared: "legacy value" },
        });
        expect(await api._getPluginStorage("shared")).toBe("legacy value");
        expect(await legacy._getPluginStorage("shared")).toBe("legacy value");
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
        // `temperature` is the prompt preset's, `maxContext` the selected model preset's main
        // profile's. The other model preset gets a main profile of its own, so the two do not share
        // the written record.
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
