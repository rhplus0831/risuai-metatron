import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain, SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
import { StoreBackedServer } from "./storeBackedServer";

// The `pluginStorage` mutations (`pluginStorageStore.svelte.ts`) against the real server store.
// Every function is sent (there is no `pluginCustomStorage` watcher; `v3SavedWrites.test.ts` has
// the "without the watcher" case), reads are detached copies, and any string is a valid key: an own
// `__proto__` and the names of `Object.prototype` members land as own properties and reach the
// server.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
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
vi.mock("../../globalApi.svelte", async () => (await import("../../tests/globalApiMock")).createGlobalApiMock());

async function boot() {
    vi.resetModules();
    return bootMutations((fake) => {
        server.current = fake;
    });
}

beforeAll(() => warmMutationGraph(), 60_000);

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

describe("plugin storage inventory", () => {
    it("reads an absent inventory without creating the pluginStorage record", async () => {
        vi.resetModules();
        const ps = await import("../pluginStorageStore.svelte");
        const { settings } = await import("../settingsViews.svelte");

        expect(settings.pluginStorage).toBeUndefined();
        expect(ps.pluginStorageInventory()).toEqual({
            custom: [],
            pluginStorage: [],
            ownedPluginStorage: {},
            safeLocalPluginStorage: [],
        });
        expect(ps.getPluginCustomValue("missing")).toBeNull();
        expect(settings.pluginStorage).toBeUndefined();
    });

    it("lists JSON byte sizes and values, treating reserved objects and lists as namespaces and scalars as custom keys", async () => {
        const { sync, pluginStorageStore: ps, record } = await boot();
        const stored = {
            custom: { text: "한🙂" },
            _pluginStorage: ["é", null],
            _safeLocalPluginStorage: { flag: false, quoted: '"\n' },
            // Owned keys are grouped by owner; a clear marker lists its owner with no keys.
            _ownedPluginStorage: { "plug\u0000k": 1, other: { legacyHidden: true } },
        };
        ps.replacePluginCustomStorage(stored);
        await sync.flushResources();

        // JSON punctuation counts too: {"text":"한🙂"} is 18 UTF-8 bytes; "é" is 4.
        expect(ps.pluginStorageInventory()).toEqual({
            custom: [{ key: "custom", bytes: 18 }],
            pluginStorage: [
                { key: "0", bytes: 4 },
                { key: "1", bytes: 4 },
            ],
            ownedPluginStorage: { plug: [{ key: "k", bytes: 1 }], other: [] },
            safeLocalPluginStorage: [
                { key: "flag", bytes: 5 },
                { key: "quoted", bytes: 6 },
            ],
        });
        expect(ps.getPluginCustomValue("custom")).toEqual({ text: "한🙂" });
        expect(ps.getPluginStorageValue("0")).toBe("é");
        expect(ps.getSafeLocalPluginValue("quoted")).toBe('"\n');
        await sync.flushResources();
        expect(record("pluginStorage")).toEqual(stored);

        ps.replacePluginCustomStorage({ _pluginStorage: { count: 12 }, _safeLocalPluginStorage: ["🙂"] });
        expect(ps.pluginStorageInventory()).toEqual({
            custom: [],
            pluginStorage: [{ key: "count", bytes: 2 }],
            ownedPluginStorage: { plug: [{ key: "k", bytes: 1 }], other: [] },
            safeLocalPluginStorage: [{ key: "0", bytes: 6 }],
        });

        ps.replacePluginCustomStorage({ _pluginStorage: null, _safeLocalPluginStorage: "한" });
        expect(ps.pluginStorageInventory()).toEqual({
            custom: [
                { key: "_pluginStorage", bytes: 4 },
                { key: "_safeLocalPluginStorage", bytes: 5 },
            ],
            pluginStorage: [],
            ownedPluginStorage: { plug: [{ key: "k", bytes: 1 }], other: [] },
            safeLocalPluginStorage: [],
        });
        expect(ps.getPluginCustomValue("_safeLocalPluginStorage")).toBe("한");
    });
});

describe("the v3 pluginStorage dictionary", () => {
    it("sets, reads a detached copy, lists, removes, and clears, with every write saved", async () => {
        const { sync, pluginStorageStore: ps, record } = await boot();
        const value = { list: [1] };
        ps.setPluginStorageItem("k", value);
        value.list.push(2);
        expect(ps.getPluginStorageValue("k")).toEqual({ list: [1] });
        (ps.getPluginStorageValue("k") as any).list.push(3);
        expect(ps.getPluginStorageValue("k")).toEqual({ list: [1] });
        expect(ps.getPluginStorageValue("missing")).toBeNull();
        ps.setPluginStorageItem("n", null);
        expect(ps.pluginStorageKeys()).toEqual(["k", "n"]);
        await sync.flushResources();
        expect(record("pluginStorage")._pluginStorage).toEqual({ k: { list: [1] }, n: null });
        ps.removePluginStorageItem("k");
        ps.removePluginStorageItem("k");
        expect(ps.pluginStorageKeys()).toEqual(["n"]);
        await sync.flushResources();
        expect(record("pluginStorage")._pluginStorage).toEqual({ n: null });
        ps.clearPluginStorage();
        await sync.flushResources();
        expect(record("pluginStorage")._pluginStorage).toEqual({});
    });

    it("refuses a value that is not JSON data and changes nothing", async () => {
        const { pluginStorageStore: ps, refusedEach, validation } = await boot();
        await refusedEach(
            [
                ...[() => 1, 1n, Number.NaN, { nested: Symbol("s") }, new Map(), undefined].flatMap((value) => [
                    () => ps.setPluginStorageItem("k", value),
                    () => ps.setSafeLocalPluginValue("k", value),
                ]),
                () => ps.setPluginCustomValue("k", () => 1),
                () => ps.replacePluginCustomStorage([]),
                () => ps.replacePluginCustomStorage({ k: 1n }),
            ],
            validation.MutationValidationError,
        );
    });
});

describe("the safe local dictionary and the custom keys", () => {
    it.each([
        {
            shape: "dictionaries",
            v3: { otherPlugin: { count: 1 } },
            local: { otherPlugin: ["local"] },
        },
        { shape: "a scalar and a list", v3: false, local: ["legacy"] },
    ])(
        "saves a fresh replacement keeping omitted reserved values ($shape) and removing omitted custom keys",
        async ({ v3, local }) => {
            const { sync, pluginStorageStore: ps, record } = await boot();
            const stored = { obsolete: true, _pluginStorage: v3, _safeLocalPluginStorage: local };
            ps.replacePluginCustomStorage(stored);
            await sync.flushResources();
            expect(record("pluginStorage")).toStrictEqual(stored);

            ps.replacePluginCustomStorage({ custom: { count: 2 } });
            await sync.flushResources();

            expect(record("pluginStorage")).toStrictEqual({
                custom: { count: 2 },
                _pluginStorage: v3,
                _safeLocalPluginStorage: local,
            });
            expect(ps.getPluginCustomValue("_pluginStorage")).toEqual(v3);
            expect(ps.getPluginCustomValue("_safeLocalPluginStorage")).toEqual(local);
            expect(ps.getPluginCustomValue("custom")).toEqual({ count: 2 });
            expect(ps.getPluginCustomValue("obsolete")).toBeNull();
        },
    );

    it("saves an own undefined reserved name as removal while keeping the omitted reserved name", async () => {
        const { sync, pluginStorageStore: ps, record } = await boot();
        ps.replacePluginCustomStorage({
            _pluginStorage: { v3: "saved v3" },
            _safeLocalPluginStorage: { local: "saved local" },
        });
        await sync.flushResources();

        ps.replacePluginCustomStorage({ custom: "updated", _pluginStorage: undefined });
        await sync.flushResources();

        expect(record("pluginStorage")).toStrictEqual({
            custom: "updated",
            _safeLocalPluginStorage: { local: "saved local" },
        });
        expect(ps.getPluginCustomValue("_pluginStorage")).toBeNull();
        expect(ps.getPluginCustomValue("_safeLocalPluginStorage")).toEqual({ local: "saved local" });
    });

    it("sets, has, lists, removes, and clears the getLocalPluginStorage() values", async () => {
        const { sync, pluginStorageStore: ps, record } = await boot();
        ps.setSafeLocalPluginValue("a", "x");
        ps.setSafeLocalPluginValue("b", [1, "two"]);
        expect(ps.hasSafeLocalPluginValue("a")).toBe(true);
        expect(ps.hasSafeLocalPluginValue("z")).toBe(false);
        expect(ps.getSafeLocalPluginValue("b")).toEqual([1, "two"]);
        expect(ps.getSafeLocalPluginValue("z")).toBeNull();
        expect(ps.safeLocalPluginKeys()).toEqual(["a", "b"]);
        await sync.flushResources();
        expect(record("pluginStorage")._safeLocalPluginStorage).toEqual({ a: "x", b: [1, "two"] });
        ps.removeSafeLocalPluginValue("a");
        await sync.flushResources();
        expect(record("pluginStorage")._safeLocalPluginStorage).toEqual({ b: [1, "two"] });
        ps.clearSafeLocalPluginStorage();
        await sync.flushResources();
        expect(record("pluginStorage")._safeLocalPluginStorage).toEqual({});
    });

    it("stores custom keys, including the reserved dictionary names, removes one for undefined, and replaces the top level, keeping an omitted reserved dictionary", async () => {
        const { sync, pluginStorageStore: ps, record, settings } = await boot();
        ps.setPluginCustomValue("custom", { v: 1 });
        ps.setPluginCustomValue("_pluginStorage", { k: { v: 2 } });
        expect(ps.getPluginStorageValue("k")).toEqual({ v: 2 });
        await sync.flushResources();
        expect(record("pluginStorage")).toEqual({ custom: { v: 1 }, _pluginStorage: { k: { v: 2 } } });
        ps.setPluginCustomValue("custom", undefined);
        ps.setPluginCustomValue("never", undefined);
        expect(plain(settings.pluginStorage)).toEqual({ _pluginStorage: { k: { v: 2 } } });
        await sync.flushResources();
        expect(record("pluginStorage")).toEqual({ _pluginStorage: { k: { v: 2 } } });
        const whole = { top: 1, _safeLocalPluginStorage: { s: true } };
        ps.replacePluginCustomStorage(whole);
        whole.top = 2;
        expect(ps.getSafeLocalPluginValue("s")).toBe(true);
        expect(ps.pluginStorageKeys()).toEqual(["k"]);
        await sync.flushResources();
        expect(record("pluginStorage")).toEqual({
            top: 1,
            _safeLocalPluginStorage: { s: true },
            _pluginStorage: { k: { v: 2 } },
        });
    });
});

describe("owned storage administration", () => {
    it("reuses one owned-dictionary traversal for count, indexed keys, and detached key lists", async () => {
        const { pluginStorageStore: ps, settings } = await boot();
        const owners = Array.from({ length: 10 }, (_, i) => `owner-${i}`);
        const keys = Array.from({ length: 10 }, (_, i) => `key-${i}`);
        ps.replacePluginCustomStorage({
            _ownedPluginStorage: Object.fromEntries(
                owners.flatMap((owner) => keys.map((key) => [`${owner}\u0000${key}`, 1])),
            ),
        });
        const owned = settings.pluginStorage._ownedPluginStorage;
        const objectKeys = Object.keys;
        let visits = 0;
        vi.spyOn(Object, "keys").mockImplementation((value) => {
            const result = objectKeys(value);
            if (value === owned) visits += result.length;
            return result;
        });

        expect(ps.ownedPluginStorageKeyCount(owners[0])).toBe(keys.length);
        expect(keys.map((_, i) => ps.ownedPluginStorageKeyAt(owners[0], i))).toEqual(keys);
        ps.ownedPluginStorageKeys(owners[0]).splice(0, keys.length, "phantom");
        expect(ps.ownedPluginStorageKeys(owners[0])).toEqual(keys);
        expect(ps.ownedPluginStorageKeyAt(owners[0], keys.length)).toBeNull();
        expect(visits).toBe(owners.length * keys.length);
    });

    it.each(["whole record", "feed entry patch"])(
        "refreshes cached owner keys after another client's %s update",
        async (delivery) => {
            // Keep the existing boot fixture, enabling the real server's change feed for this round trip.
            const createServer = StoreBackedServer.create;
            vi.spyOn(StoreBackedServer, "create").mockImplementationOnce(() =>
                createServer.call(StoreBackedServer, { feed: true }),
            );
            const { fake, sync, pluginStorageStore: ps } = await boot();
            ps.replacePluginCustomStorage({
                _ownedPluginStorage: { "plug\u0000old": 1 },
                _pluginStorage: { legacy: 1 },
            });
            await sync.flushResources();
            expect(ps.ownedPluginStorageKeys("plug")).toEqual(["old", "legacy"]);

            vi.resetModules();
            const writer = await import("../resourceClient");
            const snapshot = await writer.readKinds(["pluginStorage"]);
            writer.setResourceEpoch(snapshot.epoch);
            const notices: unknown[] = [];
            fake.onFeed = (event) => {
                if (event.type !== "change") return;
                notices.push(...event.changes.resources);
                sync.noteRemoteChanges({
                    ...event.changes,
                    resources:
                        delivery === "whole record"
                            ? event.changes.resources.map(({ kind, id, revision }) => ({ kind, id, revision }))
                            : event.changes.resources,
                });
            };
            fake.requests.length = 0;
            await writer.applyBatchText(
                JSON.stringify({
                    ops: [
                        {
                            kind: "pluginStorage",
                            id: "main",
                            baseRevision: snapshot.kinds.pluginStorage[0].revision,
                            ...(delivery === "whole record"
                                ? {
                                      data: {
                                          _ownedPluginStorage: { "plug\u0000new": 2 },
                                          _pluginStorage: { tail: 3 },
                                      },
                                  }
                                : {
                                      patch: {
                                          nested: {
                                              _ownedPluginStorage: {
                                                  set: { "plug\u0000new": 2 },
                                                  remove: ["plug\u0000old"],
                                              },
                                              _pluginStorage: { set: { tail: 3 }, remove: ["legacy"] },
                                          },
                                      },
                                  }),
                        },
                    ],
                }),
            );
            await sync.flushResources();

            await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
            expect(notices).toHaveLength(1);
            if (delivery === "feed entry patch") {
                expect(notices[0]).toHaveProperty("entryPatch");
                expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toEqual([]);
            }
            expect(ps.ownedPluginStorageKeyAt("plug", 0)).toBe("new");
            expect(ps.ownedPluginStorageKeyCount("plug")).toBe(2);
            expect(ps.ownedPluginStorageKeys("plug")).toEqual(["new", "tail"]);
        },
    );

    it("keeps owned entries and clear markers when a custom-storage replacement omits the dictionary", async () => {
        const { sync, pluginStorageStore: ps, record } = await boot();
        ps.replacePluginCustomStorage({
            obsolete: true,
            _ownedPluginStorage: { "plug\u0000key": { value: 1 }, other: { legacyHidden: true } },
        });
        await sync.flushResources();
        ps.replacePluginCustomStorage({ custom: "replacement" });
        await sync.flushResources();
        expect(record("pluginStorage")).toEqual({
            custom: "replacement",
            _ownedPluginStorage: { "plug\u0000key": { value: 1 }, other: { legacyHidden: true } },
        });
    });

    it("moves a legacy entry to an installed owner and deletes only that owner's data and marker", async () => {
        const { sync, pluginStorageStore: ps, record } = await boot();
        // The harness installs the plugin named plug; it has previously hidden legacy reads.
        ps.replacePluginCustomStorage({
            _pluginStorage: { assign: { value: 1 }, keep: "legacy" },
            _ownedPluginStorage: { plug: { legacyHidden: true }, "other\u0000assign": "other value" },
        });
        await sync.flushResources();
        expect(ps.assignLegacyPluginStorageItem("plug", "assign")).toBe(true);
        await sync.flushResources();
        expect(record("pluginStorage")).toEqual({
            _pluginStorage: { keep: "legacy" },
            _ownedPluginStorage: {
                plug: { legacyHidden: true },
                "other\u0000assign": "other value",
                "plug\u0000assign": { value: 1 },
            },
        });
        expect(ps.getOwnedPluginStorageValue("plug", "assign")).toEqual({ value: 1 });

        ps.deleteOwnedPluginStorage("plug");
        await sync.flushResources();
        expect(record("pluginStorage")).toEqual({
            _pluginStorage: { keep: "legacy" },
            _ownedPluginStorage: { "other\u0000assign": "other value" },
        });
    });
});

describe("keys the proxy would not store", () => {
    it("keeps an own __proto__ key and the names of Object.prototype members in every dictionary and at the top level", async () => {
        const { sync, pluginStorageStore: ps, record, settings } = await boot();
        ps.setPluginStorageItem("__proto__", { own: 1 });
        ps.setPluginStorageItem("constructor", { v: 1 });
        ps.setPluginStorageItem("ordinary", 0);
        ps.setSafeLocalPluginValue("__proto__", "safe");
        ps.setSafeLocalPluginValue("toString", 3);
        ps.setPluginCustomValue("__proto__", { top: true });
        ps.setPluginCustomValue("valueOf", 4);
        ps.setPluginCustomValue("hasOwnProperty", "h");
        expect(ps.pluginStorageKeys().sort()).toEqual(["__proto__", "constructor", "ordinary"]);
        expect(ps.getPluginStorageValue("__proto__")).toEqual({ own: 1 });
        expect(ps.getPluginStorageValue("constructor")).toEqual({ v: 1 });
        expect(ps.hasSafeLocalPluginValue("toString")).toBe(true);
        expect(ps.getSafeLocalPluginValue("__proto__")).toBe("safe");
        expect(Object.getPrototypeOf(settings.pluginStorage)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(settings.pluginStorage._pluginStorage)).toBe(Object.prototype);
        expect(Object.hasOwn(Object.prototype, "own")).toBe(false);
        await sync.flushResources();
        const saved = record("pluginStorage");
        expect(Object.hasOwn(saved, "__proto__")).toBe(true);
        expect(saved.__proto__).toEqual({ top: true });
        expect(saved).toMatchObject({ valueOf: 4, hasOwnProperty: "h" });
        expect(Object.hasOwn(saved._pluginStorage, "__proto__")).toBe(true);
        expect(saved._pluginStorage).toMatchObject({ constructor: { v: 1 }, ordinary: 0 });
        expect(Object.hasOwn(saved._safeLocalPluginStorage, "__proto__")).toBe(true);
        expect(saved._safeLocalPluginStorage).toMatchObject({ __proto__: "safe", toString: 3 });
        // They are removed like any other key, and a second write replaces them in place.
        ps.setPluginStorageItem("constructor", { v: 2 });
        ps.removePluginStorageItem("__proto__");
        ps.removeSafeLocalPluginValue("toString");
        ps.setPluginCustomValue("valueOf", undefined);
        await sync.flushResources();
        const after = record("pluginStorage");
        expect(Object.hasOwn(after._pluginStorage, "__proto__")).toBe(false);
        expect(after._pluginStorage.constructor).toEqual({ v: 2 });
        expect(Object.hasOwn(after._safeLocalPluginStorage, "toString")).toBe(false);
        expect(Object.hasOwn(after, "valueOf")).toBe(false);
        expect(Object.hasOwn(after, "__proto__")).toBe(true);
    });
});
