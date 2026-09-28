import { beforeEach, describe, expect, it, vi } from "vitest";

// The v3 host API used to borrow its `setDatabase`/`setDatabaseLite` and
// `safeLocalStorage` implementations from the removed API 2.1 layer. They now
// live in `v3.svelte.ts`. These tests pin the contracts the move must keep:
// - `setDatabaseLite`/`setDatabase` copy `allowedDbKeys` onto the live database
//   and route every other key to the top level of `pluginCustomStorage`,
//   without touching the v3 `_pluginStorage` sub-object. The removed `pluginV2`
//   key is no longer an allowed key, so it lands in custom storage too.
// - `setDatabaseLite` only assigns; `setDatabase` goes through the normalizing
//   `setDatabase`.
// - the `_*SafeLocalStorage` aliases work when called detached, which is how
//   the sandbox RPC (`CALL_ROOT` does `fn(...args)`) invokes them. `key` and
//   `clear` used to be exported unbound and threw on `this`.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { db, captured, dbMocks } = vi.hoisted(() => ({
    db: {
        characters: [] as any[],
        temperature: 0,
        pluginCustomStorage: undefined as Record<string, any> | undefined,
    },
    captured: { api: null as CapturedApi | null },
    dbMocks: {
        setDatabase: vi.fn(),
        setDatabaseLite: vi.fn(),
    },
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
    },
}));

vi.mock("src/ts/storage/database.svelte", () => ({
    getDatabase: () => db,
    setDatabase: dbMocks.setDatabase,
    setDatabaseLite: dbMocks.setDatabaseLite,
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
    setCurrentChat: vi.fn(),
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: { getItem: vi.fn(), setItem: vi.fn(), keys: vi.fn(async () => []) },
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));

vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));

// The real parser module installs a module-level `$effect.root` that reads
// `selIdState` from `stores.svelte`, which is still uninitialized here because
// the two modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));

import { DBState } from "src/ts/stores.svelte";
import { executePluginV3 } from "./v3.svelte";

async function makeApi(): Promise<CapturedApi> {
    captured.api = null;
    await executePluginV3({
        name: `hostApi-test-${Math.random().toString(36).slice(2)}`,
        script: "",
        version: "3.0",
    } as any);
    expect(captured.api).not.toBeNull();
    return captured.api!;
}

describe("v3 setDatabase / setDatabaseLite routing", () => {
    beforeEach(() => {
        db.characters = [];
        db.temperature = 0;
        db.pluginCustomStorage = undefined;
        dbMocks.setDatabase.mockClear();
        dbMocks.setDatabaseLite.mockClear();
    });

    it("setDatabaseLite assigns allowed keys and routes the rest into pluginCustomStorage", async () => {
        const api = await makeApi();

        api.setDatabaseLite({
            characters: [{ name: "c" }],
            custom: { x: 1 },
            pluginV2: [{ name: "old" }],
        });

        expect(db.characters).toEqual([{ name: "c" }]);
        expect(db.pluginCustomStorage).toEqual({ custom: { x: 1 }, pluginV2: [{ name: "old" }] });
        expect("custom" in db).toBe(false);
        expect("pluginV2" in db).toBe(false);
        expect(DBState.db.pluginCustomStorage).toEqual({ custom: { x: 1 }, pluginV2: [{ name: "old" }] });
        expect(dbMocks.setDatabase).not.toHaveBeenCalled();
    });

    it("setDatabase routes the same way and then saves through the normalizing setDatabase", async () => {
        const api = await makeApi();

        await api.setDatabase({ temperature: 80, custom: "v" });

        expect(db.temperature).toBe(80);
        expect(db.pluginCustomStorage).toEqual({ custom: "v" });
        expect(dbMocks.setDatabase).toHaveBeenCalledTimes(1);
        expect(dbMocks.setDatabase).toHaveBeenCalledWith(db);
    });

    it("keeps the v3 _pluginStorage sub-object next to routed custom keys", async () => {
        db.pluginCustomStorage = { _pluginStorage: { k: 1 } };
        const api = await makeApi();

        api.setDatabaseLite({ custom: 1 });
        await api.setDatabase({ other: 2 });

        expect(db.pluginCustomStorage).toEqual({ _pluginStorage: { k: 1 }, custom: 1, other: 2 });
        expect(await api._getPluginStorage("k")).toBe(1);
    });
});

describe("v3 safeLocalStorage aliases", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("work when called detached, as the sandbox RPC calls them", async () => {
        const api = await makeApi();
        const {
            _setSafeLocalStorage,
            _getSafeLocalStorage,
            _keySafeLocalStorage,
            _keysSafeLocalStorage,
            _removeSafeLocalStorage,
            _clearSafeLocalStorage,
        } = api;

        localStorage.setItem("unrelated", "keep");
        _setSafeLocalStorage("a", "1");
        _setSafeLocalStorage("b", "2");

        expect(_getSafeLocalStorage("a")).toBe("1");
        expect(localStorage.getItem("safe_plugin_a")).toBe("1");
        expect(_keysSafeLocalStorage()).toEqual(["a", "b"]);
        expect(_keySafeLocalStorage(0)).toBe("a");
        expect(_keySafeLocalStorage(5)).toBeNull();

        _removeSafeLocalStorage("a");
        expect(_keysSafeLocalStorage()).toEqual(["b"]);

        _clearSafeLocalStorage();
        expect(_keysSafeLocalStorage()).toEqual([]);
        expect(localStorage.getItem("safe_plugin_b")).toBeNull();
        expect(localStorage.getItem("unrelated")).toBe("keep");
    });
});
