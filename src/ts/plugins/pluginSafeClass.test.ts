import { beforeEach, describe, expect, it, vi } from "vitest";

// `SafeLocalPluginStorage` (the plugin API's `getLocalPluginStorage()`) over
// `pluginCustomStorage._safeLocalPluginStorage` through the plugin storage mutations
// (`pluginStorageStore.svelte.ts`), with the documented JSON-only contract, against the real
// `DBState` proxy so key handling is what plugins see.

vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { DBState } from "../stores.svelte";
import { setDatabaseLite } from "../storage/database.svelte";
import { SAFE_LOCAL_PLUGIN_STORAGE_KEY, setSafeLocalPluginValue } from "../storage/pluginStorageStore.svelte";
import { isJsonValue, SafeLocalPluginStorage } from "./pluginSafeClass";

const stored = () => (DBState.db.pluginCustomStorage as any)?.[SAFE_LOCAL_PLUGIN_STORAGE_KEY];

beforeEach(() => {
    // Installed the way the app installs a database (its fields moved into the records), since the
    // plugin storage mutations write the records through the settings views (Phase 6 slice 7).
    setDatabaseLite({ characters: [] } as any);
});

describe("isJsonValue", () => {
    it("accepts plain JSON data and rejects everything else", () => {
        for (const value of [
            null,
            true,
            0,
            -1.5,
            "s",
            [],
            {},
            [1, "a", null, { b: [true] }],
            { nested: { deep: [] } },
            // A null-prototype dictionary is plain data (the permission store uses them).
            Object.assign(Object.create(null), { k: 1 }),
        ]) {
            expect(isJsonValue(value)).toBe(true);
        }
        const cyclic: any = { a: 1 };
        cyclic.self = cyclic;
        for (const value of [
            undefined,
            NaN,
            Infinity,
            10n,
            () => 1,
            Symbol("s"),
            new Date(),
            new Map(),
            new Set(),
            new Uint8Array(1),
            new Blob(["x"]),
            new (class Custom {})(),
            { d: new Date() },
            [1, undefined],
            cyclic,
        ]) {
            expect(isJsonValue(value)).toBe(false);
        }
    });

    it("treats a shared (non-cyclic) reference as plain data", () => {
        const shared = { x: 1 };
        expect(isJsonValue({ a: shared, b: shared })).toBe(true);
    });
});

describe("SafeLocalPluginStorage", () => {
    it("stores clones inside pluginCustomStorage and reads clones back", async () => {
        const storage = new SafeLocalPluginStorage();
        expect(DBState.db.pluginCustomStorage).toBeUndefined();
        expect(await storage.getItem("missing")).toBeNull();
        expect(DBState.db.pluginCustomStorage).toBeUndefined();
        const value = { list: [1, 2], nested: { ok: true } };
        await storage.setItem("key", value);
        value.list.push(3);
        expect(stored().key).toEqual({ list: [1, 2], nested: { ok: true } });
        const read = await storage.getItem<typeof value>("key");
        read!.nested.ok = false;
        expect(stored().key.nested.ok).toBe(true);
        expect(await storage.keys()).toEqual(["key"]);
        expect(await storage.getItem("key")).toEqual({ list: [1, 2], nested: { ok: true } });
    });

    it("keeps falsy values, stores undefined as null (LocalForage parity), and removes keys", async () => {
        const storage = new SafeLocalPluginStorage();
        await storage.setItem("zero", 0);
        await storage.setItem("empty", "");
        await storage.setItem("no", false);
        await storage.setItem("nothing", undefined);
        expect(await storage.getItem("zero")).toBe(0);
        expect(await storage.getItem("empty")).toBe("");
        expect(await storage.getItem("no")).toBe(false);
        expect(await storage.getItem("nothing")).toBeNull();
        expect(Object.hasOwn(stored(), "nothing")).toBe(true);
        await storage.removeItem("zero");
        expect(await storage.getItem("zero")).toBeNull();
        expect(await storage.keys()).toEqual(["empty", "no", "nothing"]);
        await storage.clear();
        expect(await storage.keys()).toEqual([]);
        expect(stored()).toEqual({});
    });

    it("throws a TypeError for a non-JSON value and changes nothing", async () => {
        const storage = new SafeLocalPluginStorage();
        await storage.setItem("kept", 1);
        for (const value of [new Date(), { d: new Blob([]) }, () => 1, NaN, new Map()]) {
            await expect(storage.setItem("bad", value)).rejects.toBeInstanceOf(TypeError);
        }
        expect(await storage.keys()).toEqual(["kept"]);
        expect(stored()).toEqual({ kept: 1 });
    });

    it("keeps the key `__proto__` as an own key, readable, listed, removable, and preserved by other writes", async () => {
        const storage = new SafeLocalPluginStorage();
        await storage.setItem("first", 1);
        await storage.setItem("__proto__", { probe: "value" });
        await storage.setItem("second", 2);
        expect(await storage.getItem("__proto__")).toEqual({ probe: "value" });
        expect((await storage.keys()).sort()).toEqual(["__proto__", "first", "second"]);
        expect(Object.getPrototypeOf(stored())).toBe(Object.prototype);
        expect(JSON.parse(JSON.stringify(stored()))).toEqual({
            first: 1,
            ["__proto__"]: { probe: "value" },
            second: 2,
        });
        expect(Object.hasOwn(JSON.parse(JSON.stringify(stored())), "__proto__")).toBe(true);
        await storage.setItem("__proto__", 5);
        expect(await storage.getItem("__proto__")).toBe(5);
        await storage.removeItem("__proto__");
        expect(await storage.getItem("__proto__")).toBeNull();
        expect((await storage.keys()).sort()).toEqual(["first", "second"]);
    });

    it("setSafeLocalPluginValue creates the dictionary and writes any key", () => {
        setSafeLocalPluginValue("__proto__", [1]);
        setSafeLocalPluginValue("plain", "v");
        expect(Object.keys(stored()).sort()).toEqual(["__proto__", "plain"]);
        expect(stored()["__proto__"]).toEqual([1]);
    });
});
