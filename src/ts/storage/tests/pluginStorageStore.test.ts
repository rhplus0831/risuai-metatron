import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain, warmMutationGraph } from "./mutationStoresHarness";

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
        expect(ps.pluginStorageInventory()).toEqual({ custom: [], pluginStorage: [], safeLocalPluginStorage: [] });
        expect(ps.getPluginCustomValue("missing")).toBeNull();
        expect(settings.pluginStorage).toBeUndefined();
    });

    it("lists JSON byte sizes and values, treating reserved objects and lists as namespaces and scalars as custom keys", async () => {
        const { sync, pluginStorageStore: ps, record } = await boot();
        const stored = {
            custom: { text: "한🙂" },
            _pluginStorage: ["é", null],
            _safeLocalPluginStorage: { flag: false, quoted: '"\n' },
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
            safeLocalPluginStorage: [{ key: "0", bytes: 6 }],
        });

        ps.replacePluginCustomStorage({ _pluginStorage: null, _safeLocalPluginStorage: "한" });
        expect(ps.pluginStorageInventory()).toEqual({
            custom: [
                { key: "_pluginStorage", bytes: 4 },
                { key: "_safeLocalPluginStorage", bytes: 5 },
            ],
            pluginStorage: [],
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
