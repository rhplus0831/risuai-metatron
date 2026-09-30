import { beforeEach, describe, expect, it, vi } from "vitest";

// Cold storage was removed. v3 `pluginStorage` used to keep its values in cold
// storage behind a `pluginCustomStorage._coldplugin` key -> uuid map; it now keeps
// them inline under the reserved `pluginCustomStorage._pluginStorage` sub-object.
// These tests pin the replacement contract:
// - values are isolated from the top level of `pluginCustomStorage`, where the
//   `setDatabase`/`setDatabaseLite` APIs route custom (non-`allowedDbKeys`)
//   properties, so a `pluginStorage` key can neither read nor clobber one,
// - `setItem` JSON-normalizes the value and rejects what the save file cannot
//   hold (BigInt) without touching the database,
// - falsy stored values survive `getItem`; only a missing key yields null.
// The storage functions write the live `DBState.db` through `pluginStorageStore.svelte.ts`, so the
// database under test is `DBState.db` (a fresh object per case).

type CapturedApi = Record<string, (...args: any[]) => any>;

const { captured } = vi.hoisted(() => ({
    captured: { api: null as CapturedApi | null },
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

vi.mock("src/ts/storage/database.svelte", async () => {
    // Resolved here because the factory runs before this file's own imports are initialized.
    const stores = await vi.importActual<typeof import("src/ts/stores.svelte")>("src/ts/stores.svelte");
    return {
        getDatabase: () => stores.DBState.db,
        setDatabase: vi.fn(),
        getCurrentCharacter: vi.fn(),
        getCurrentChat: vi.fn(),
        setCurrentChat: vi.fn(),
    };
});

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

const db = () => DBState.db as { pluginCustomStorage: Record<string, any> | undefined };

async function makeApi(): Promise<CapturedApi> {
    captured.api = null;
    await executePluginV3({
        name: `pluginStorage-test-${Math.random().toString(36).slice(2)}`,
        script: "",
        version: "3.0",
    } as any);
    expect(captured.api).not.toBeNull();
    return captured.api!;
}

describe("v3 pluginStorage without cold storage", () => {
    beforeEach(() => {
        DBState.db = { pluginCustomStorage: undefined } as any;
    });

    it("stores values inline under pluginCustomStorage._pluginStorage and reads them back", async () => {
        const api = await makeApi();

        await api._setPluginStorage("theme", "dark");
        await api._setPluginStorage("count", 3);
        await api._setPluginStorage("prefs", { nested: { list: [1, "two", null] } });

        expect(db().pluginCustomStorage).toEqual({
            _pluginStorage: {
                theme: "dark",
                count: 3,
                prefs: { nested: { list: [1, "two", null] } },
            },
        });
        expect(db().pluginCustomStorage!._coldplugin).toBeUndefined();

        expect(await api._getPluginStorage("theme")).toBe("dark");
        expect(await api._getPluginStorage("count")).toBe(3);
        expect(await api._getPluginStorage("prefs")).toEqual({ nested: { list: [1, "two", null] } });
        expect(await api._getPluginStorage("missing")).toBeNull();
        expect(await api._keysPluginStorage()).toEqual(["theme", "count", "prefs"]);
        expect(await api._lengthPluginStorage()).toBe(3);
        expect(await api._keyPluginStorage(1)).toBe("count");
        expect(await api._keyPluginStorage(99)).toBeNull();
    });

    it("keeps falsy values distinct from a missing key", async () => {
        const api = await makeApi();

        await api._setPluginStorage("zero", 0);
        await api._setPluginStorage("empty", "");
        await api._setPluginStorage("no", false);
        await api._setPluginStorage("nil", null);

        expect(await api._getPluginStorage("zero")).toBe(0);
        expect(await api._getPluginStorage("empty")).toBe("");
        expect(await api._getPluginStorage("no")).toBe(false);
        expect(await api._getPluginStorage("nil")).toBeNull();
        expect(await api._lengthPluginStorage()).toBe(4);
    });

    it("does not read, overwrite, or clear top-level pluginCustomStorage entries", async () => {
        // `setDatabase({ settings: ... })` writes `pluginCustomStorage.settings` at the top
        // level. `characters` is a real DB key that a plugin may plausibly pick as a storage
        // key; it must not land at the top level either, where `setDatabase` would later
        // treat it as a routed custom property.
        db().pluginCustomStorage = { settings: "legacy", characters: "legacy-list" };
        const api = await makeApi();

        expect(await api._getPluginStorage("settings")).toBeNull();
        expect(await api._lengthPluginStorage()).toBe(0);

        await api._setPluginStorage("settings", { v3: true });
        await api._setPluginStorage("characters", []);

        expect(db().pluginCustomStorage.settings).toBe("legacy");
        expect(db().pluginCustomStorage.characters).toBe("legacy-list");
        expect(Object.keys(db().pluginCustomStorage).sort()).toEqual(["_pluginStorage", "characters", "settings"]);
        expect(await api._keysPluginStorage()).toEqual(["settings", "characters"]);

        await api._removePluginStorage("settings");
        expect(db().pluginCustomStorage.settings).toBe("legacy");
        expect(await api._keysPluginStorage()).toEqual(["characters"]);

        await api._clearPluginStorage();
        expect(db().pluginCustomStorage).toEqual({
            settings: "legacy",
            characters: "legacy-list",
            _pluginStorage: {},
        });
        expect(await api._lengthPluginStorage()).toBe(0);
    });

    it("JSON-normalizes stored values", async () => {
        const api = await makeApi();

        await api._setPluginStorage("undef", undefined);
        await api._setPluginStorage("fn", () => 1);
        await api._setPluginStorage("holes", { keep: 1, drop: undefined, when: new Date(0) });

        expect(await api._getPluginStorage("undef")).toBeNull();
        expect(await api._getPluginStorage("fn")).toBeNull();
        expect(await api._getPluginStorage("holes")).toEqual({ keep: 1, when: "1970-01-01T00:00:00.000Z" });
        expect("drop" in db().pluginCustomStorage!._pluginStorage.holes).toBe(false);
    });

    it("rejects a BigInt before touching the database so saving cannot break", async () => {
        const api = await makeApi();

        await expect(api._setPluginStorage("counter", 1n)).rejects.toThrow(TypeError);
        expect(db().pluginCustomStorage).toBeUndefined();

        await api._setPluginStorage("ok", 1);
        await expect(api._setPluginStorage("counter", { big: 2n })).rejects.toThrow(TypeError);
        expect(db().pluginCustomStorage).toEqual({ _pluginStorage: { ok: 1 } });
        expect(() => JSON.stringify(db().pluginCustomStorage)).not.toThrow();
    });

    it("returns a detached copy so a plugin cannot mutate the live database object", async () => {
        const api = await makeApi();

        await api._setPluginStorage("prefs", { a: 1 });
        const read = await api._getPluginStorage("prefs");
        read.a = 2;
        read.injected = true;

        expect(db().pluginCustomStorage!._pluginStorage.prefs).toEqual({ a: 1 });
    });
});
