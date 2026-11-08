import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cold storage was removed. v3 `pluginStorage` used to keep its values in cold
// storage behind a `pluginCustomStorage._coldplugin` key -> uuid map; it now keeps
// them inline under the reserved `pluginCustomStorage._ownedPluginStorage` sub-object,
// keyed `<plugin name>\u0000<key>`.
// These tests pin the replacement contract:
// - values are isolated from the top level of `pluginCustomStorage`, where the
//   `setDatabase`/`setDatabaseLite` APIs route custom (non-`allowedDbKeys`)
//   properties, so a `pluginStorage` key can neither read nor clobber one,
// - `setItem` JSON-normalizes the value and rejects what the save file cannot
//   hold (BigInt) without touching the database,
// - falsy stored values survive `getItem`; only a missing key yields null.
// The storage functions write the records through `pluginStorageStore.svelte.ts`, so the record
// under test is `settings.pluginStorage` over freshly installed records (per case).

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

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: vi.fn(async () => true),
    }),
);

// The real parser module installs a module-level `$effect.root` over the selection, which is
// still uninitialized here because the modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));

import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { executePluginV3 } from "./v3.svelte";
import * as pluginStorageStore from "src/ts/storage/pluginStorageStore.svelte";
import { MutationValidationError } from "src/ts/storage/mutationValidation";

/** The `pluginStorage` record (the legacy `pluginCustomStorage`), through its view. */
const stored = () => settings.pluginStorage as Record<string, any> | undefined;

/** The loaded plugin's name, the owner of its `pluginStorage` keys. */
let pluginName = "";
const ownKey = (key: string) => `${pluginName}\u0000${key}`;

async function makeApi(): Promise<CapturedApi> {
    captured.api = null;
    pluginName = `pluginStorage-test-${Math.random().toString(36).slice(2)}`;
    // Owned writes need the owner installed (`setOwnedPluginStorageItem`).
    settings.plugins = [{ name: pluginName, script: "", version: "3.0" }] as any;
    await executePluginV3({
        name: pluginName,
        script: "",
        version: "3.0",
    } as any);
    expect(captured.api).not.toBeNull();
    return captured.api!;
}

describe("v3 pluginStorage without cold storage", () => {
    beforeEach(() => {
        // The records installed as the app installs them (no `pluginStorage` record yet), since the
        // storage functions write the records through the settings views.
        installFlatDatabase({ pluginCustomStorage: undefined });
    });

    afterEach(() => vi.restoreAllMocks());

    it("enumerates an owner's keys with one owned-dictionary pass and at most one key-list copy", async () => {
        const api = await makeApi();
        const expected = Array.from({ length: 10 }, (_, i) => `key-${i}`);
        const owners = [pluginName, ...Array.from({ length: 9 }, (_, i) => `other-${i}`)];
        settings.pluginStorage = {
            _ownedPluginStorage: Object.fromEntries(
                owners.flatMap((owner) => expected.map((key) => [`${owner}\u0000${key}`, 1])),
            ),
        };
        const owned = stored()!._ownedPluginStorage;
        const objectKeys = Object.keys;
        let visits = 0;
        vi.spyOn(Object, "keys").mockImplementation((value) => {
            const keys = objectKeys(value);
            if (value === owned) visits += keys.length;
            return keys;
        });
        const keysForOwner = pluginStorageStore.ownedPluginStorageKeys;
        let copiedKeys = 0;
        vi.spyOn(pluginStorageStore, "ownedPluginStorageKeys").mockImplementation((owner) => {
            const keys = keysForOwner(owner);
            copiedKeys += keys.length;
            return keys;
        });

        expect(await api._lengthPluginStorage()).toBe(expected.length);
        const actual = [];
        for (let i = 0; i < expected.length; i++) actual.push(await api._keyPluginStorage(i));

        expect(actual).toEqual(expected);
        expect(visits).toBe(owners.length * expected.length);
        expect(copiedKeys).toBeLessThanOrEqual(expected.length);
    });

    it("refreshes enumeration after local writes and clear, preserving visible order and detached key arrays", async () => {
        const api = await makeApi();
        settings.pluginStorage = {
            _ownedPluginStorage: { [ownKey("own")]: 1, [ownKey("shadow")]: null, "other\u0000private": 2 },
            _pluginStorage: { legacy: 1, shadow: 2, tail: 3 },
        };
        const first = await api._keysPluginStorage();
        expect(first).toEqual(["own", "shadow", "legacy", "tail"]);
        first.splice(0, first.length, "phantom");
        expect(await api._lengthPluginStorage()).toBe(4);
        expect(await api._keyPluginStorage(0)).toBe("own");
        expect(await api._keysPluginStorage()).toEqual(["own", "shadow", "legacy", "tail"]);

        await api._setPluginStorage("next", 1);
        expect(await api._keyPluginStorage(2)).toBe("next");
        expect(await api._lengthPluginStorage()).toBe(5);
        expect(await api._keysPluginStorage()).toEqual(["own", "shadow", "next", "legacy", "tail"]);

        await api._removePluginStorage("shadow");
        expect(await api._lengthPluginStorage()).toBe(4);
        expect(await api._keysPluginStorage()).toEqual(["own", "next", "legacy", "tail"]);
        expect(await api._keyPluginStorage(4)).toBeNull();

        await api._clearPluginStorage();
        expect(await api._keysPluginStorage()).toEqual([]);
        expect(await api._lengthPluginStorage()).toBe(0);
        expect(await api._keyPluginStorage(0)).toBeNull();
        await api._setPluginStorage("after", 1);
        expect(await api._lengthPluginStorage()).toBe(1);
        expect(await api._keyPluginStorage(0)).toBe("after");
        expect(await api._keysPluginStorage()).toEqual(["after"]);
    });

    it("refreshes enumeration when setDatabase replaces pluginCustomStorage and its clear marker", async () => {
        const api = await makeApi();
        await api._clearPluginStorage();
        await api._setPluginStorage("before", 1);
        expect(await api._keysPluginStorage()).toEqual(["before"]);

        await api.setDatabase({
            pluginCustomStorage: {
                _ownedPluginStorage: { [ownKey("replacement")]: 1 },
                _pluginStorage: { freshLegacy: 2 },
            },
        });

        expect(await api._keyPluginStorage(0)).toBe("replacement");
        expect(await api._lengthPluginStorage()).toBe(2);
        expect(await api._keysPluginStorage()).toEqual(["replacement", "freshLegacy"]);
    });

    it("stores values inline under pluginCustomStorage._ownedPluginStorage, keyed by the plugin, and reads them back", async () => {
        const api = await makeApi();

        await api._setPluginStorage("theme", "dark");
        await api._setPluginStorage("count", 3);
        await api._setPluginStorage("prefs", { nested: { list: [1, "two", null] } });

        expect(stored()).toEqual({
            _ownedPluginStorage: {
                [ownKey("theme")]: "dark",
                [ownKey("count")]: 3,
                [ownKey("prefs")]: { nested: { list: [1, "two", null] } },
            },
        });
        expect(stored()!._coldplugin).toBeUndefined();

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
        settings.pluginStorage = { settings: "legacy", characters: "legacy-list" };
        const api = await makeApi();

        expect(await api._getPluginStorage("settings")).toBeNull();
        expect(await api._lengthPluginStorage()).toBe(0);

        await api._setPluginStorage("settings", { v3: true });
        await api._setPluginStorage("characters", []);

        expect(stored()!.settings).toBe("legacy");
        expect(stored()!.characters).toBe("legacy-list");
        expect(Object.keys(stored()!).sort()).toEqual(["_ownedPluginStorage", "characters", "settings"]);
        expect(await api._keysPluginStorage()).toEqual(["settings", "characters"]);

        await api._removePluginStorage("settings");
        expect(stored()!.settings).toBe("legacy");
        expect(await api._keysPluginStorage()).toEqual(["characters"]);

        await api._clearPluginStorage();
        expect(stored()).toEqual({
            settings: "legacy",
            characters: "legacy-list",
            _ownedPluginStorage: { [pluginName]: { legacyHidden: true } },
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
        expect("drop" in stored()!._ownedPluginStorage[ownKey("holes")]).toBe(false);
    });

    it("rejects a BigInt before touching the database so saving cannot break", async () => {
        const api = await makeApi();

        await expect(api._setPluginStorage("counter", 1n)).rejects.toThrow(TypeError);
        expect(stored()).toBeUndefined();

        await api._setPluginStorage("ok", 1);
        await expect(api._setPluginStorage("counter", { big: 2n })).rejects.toThrow(TypeError);
        expect(stored()).toEqual({ _ownedPluginStorage: { [ownKey("ok")]: 1 } });
        expect(() => JSON.stringify(stored())).not.toThrow();
    });

    it("returns a detached copy so a plugin cannot mutate the live database object", async () => {
        const api = await makeApi();

        await api._setPluginStorage("prefs", { a: 1 });
        const read = await api._getPluginStorage("prefs");
        read.a = 2;
        read.injected = true;

        expect(stored()!._ownedPluginStorage[ownKey("prefs")]).toEqual({ a: 1 });
    });
});

describe("v3 pluginStorage installation", () => {
    it.each([
        { enabled: true, state: "enabled" },
        { enabled: false, state: "disabled" },
    ])("stores values while $state and rejects late writes after uninstall", async ({ enabled }) => {
        const plugin = {
            name: `installed-storage-${enabled ? "enabled" : "disabled"}`,
            script: "",
            version: "3.0" as const,
            enabled,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
        };
        installFlatDatabase({ plugins: [plugin], pluginCustomStorage: undefined });
        captured.api = null;
        await executePluginV3(plugin);
        expect(captured.api).not.toBeNull();
        const api = captured.api!;

        await api._setPluginStorage("prefs", { theme: "dark" });
        expect(await api._getPluginStorage("prefs")).toEqual({ theme: "dark" });
        expect(stored()).toEqual({
            _ownedPluginStorage: { [`${plugin.name}\u0000prefs`]: { theme: "dark" } },
        });

        settings.plugins = [];
        await api._removePluginStorage("prefs");
        expect(stored()).toEqual({ _ownedPluginStorage: {} });

        await expect(api._setPluginStorage("prefs", { theme: "late" })).rejects.toThrow(MutationValidationError);
        expect(await api._getPluginStorage("prefs")).toBeNull();
        expect(stored()).toEqual({ _ownedPluginStorage: {} });
    });
});
