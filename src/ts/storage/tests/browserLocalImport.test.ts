import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InlayResource, RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";

// The boot-time move of browser-local data to the server (`importBrowserLocalData`): write, verify,
// delete; keep the local entry on any failure or when it changed meanwhile; the server wins when it
// already holds a value. LocalForage is an in-memory multi-store; the resource routes are the fake
// server; the real save adapter runs on top of it so `flushResources` is exercised too.

const { server, assets, forage, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    assets: new Map<string, Uint8Array>(),
    forage: new Map<string, Map<string, unknown>>(),
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
}));

vi.mock("localforage", () => {
    const instance = (name: string) => {
        const table = forage.get(name) ?? new Map<string, unknown>();
        forage.set(name, table);
        // IndexedDB hands back structured clones: Blobs and Dates survive, references do not.
        const clone = (value: unknown): unknown => {
            if (value instanceof Blob || value === null || typeof value !== "object") {
                return value;
            }
            if (value instanceof Date) {
                return new Date(value.getTime());
            }
            if (Array.isArray(value)) {
                return value.map(clone);
            }
            const copy: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(value)) {
                Object.defineProperty(copy, key, {
                    value: clone(entry),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            return copy;
        };
        return {
            getItem: async (key: string) => clone(table.get(key) ?? null),
            setItem: async (key: string, value: unknown) => {
                table.set(key, clone(value));
            },
            removeItem: async (key: string) => {
                table.delete(key);
            },
            iterate: async (callback: (value: unknown, key: string) => void) => {
                for (const [key, value] of [...table]) {
                    callback(clone(value), key);
                }
            },
        };
    };
    return {
        default: {
            createInstance: ({ name, storeName }: { name: string; storeName: string }) =>
                instance(`${name}/${storeName}`),
            dropInstance: vi.fn(async ({ name }: { name: string }) => {
                forage.delete(`${name}/dropped`);
                forage.set(`dropped:${name}`, new Map());
            }),
        },
    };
});

vi.mock("../serverAuth", () => ({
    authFetch: async (path: string, init: RequestInit = {}) => {
        if (path === "/api/read" && init.method === "HEAD") {
            const key = Buffer.from(new Headers(init.headers).get("file-path")!, "hex").toString("utf-8");
            const bytes = assets.get(key);
            return new Response(null, {
                status: 200,
                headers: bytes ? { "content-length": String(bytes.byteLength) } : {},
            });
        }
        return server.current.fetch(path, init);
    },
    getNodeServerProxyAuth: async () => "signed-token",
}));

vi.mock("../assetClient", () => ({
    writeAsset: vi.fn(async (key: string, value: Uint8Array) => {
        assets.set(key, new Uint8Array(value));
    }),
    readAsset: vi.fn(async (key: string) => {
        const bytes = assets.get(key);
        return bytes ? Buffer.from(bytes) : null;
    }),
}));

vi.mock("../../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));

vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertReloadNotice: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertTerminal: alerts.terminal,
}));
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
vi.mock(import("src/ts/media"), () => ({ getImageType: vi.fn() }));
vi.mock(import("src/ts/model/modellist"), () => ({ getModelInfo: vi.fn() }));

const table = (name: string) => {
    const existing = forage.get(name) ?? new Map<string, unknown>();
    forage.set(name, existing);
    return existing;
};
const INLAY = "inlay/inlay";
const PLUGIN = "plugin/plugin";
const PERMISSIONS = "plugin_permissions/plugin_permissions";
const IRIS = "iris_dialogues/iris_dialogues";
const GOOGLE = "google-search-credentials/credentials";

async function sha256(text: string) {
    return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
}

let fake: FakeResourceServer;
let sync: typeof import("../resourceSync.svelte");
let client: typeof import("../resourceClient");
let importer: typeof import("../browserLocalImport");
let permissions: typeof import("../../plugins/apiV3/permissionStore");
let bootstrap: typeof import("../../bootstrap");

async function boot() {
    vi.resetModules();
    await materialize(fake);
    client = await import("../resourceClient");
    sync = await import("../resourceSync.svelte");
    importer = await import("../browserLocalImport");
    permissions = await import("../../plugins/apiV3/permissionStore");
    bootstrap = await import("../../bootstrap");
    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    forage.clear();
    assets.clear();
    fake = new FakeResourceServer();
    fake.set("root", "main", { username: "u" });
    fake.set("presets", "main", [{ name: "p" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    server.current = fake;
    localStorage.setItem("risuauth", "stale token");
    await boot();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("inlays", () => {
    it("moves a Blob entry and a data-URI entry to the server and deletes them locally", async () => {
        table(INLAY).set("blob-id", {
            name: "b.png",
            ext: "png",
            type: "image",
            width: 2,
            height: 1,
            data: new Blob(["blob"]),
        });
        table(INLAY).set("uri-id", { name: "u.png", ext: "png", type: "image", data: "data:image/png;base64,dXJp" });
        table(INLAY).set("sig-id", { name: "sig", ext: "json", type: "signature", data: '{"s":1}' });
        table(INLAY).set("junk", "not an asset");
        await importer.importBrowserLocalData();
        expect(fake.data<InlayResource>("inlays", "blob-id")).toMatchObject({
            name: "b.png",
            width: 2,
            height: 1,
            asset: `assets/inlay_${await sha256("blob")}.png`,
            size: 4,
        });
        expect(fake.data<InlayResource>("inlays", "uri-id")!.asset).toBe(`assets/inlay_${await sha256("uri")}.png`);
        expect(fake.data<InlayResource>("inlays", "sig-id")).toEqual({
            name: "sig",
            ext: "json",
            type: "signature",
            text: '{"s":1}',
        });
        expect(assets.size).toBe(2);
        expect([...table(INLAY).keys()]).toEqual(["junk"]);
    });

    it("keeps the local entry when the write fails and moves it on the next boot", async () => {
        table(INLAY).set("later", { name: "l.png", ext: "png", type: "image", data: new Blob(["later"]) });
        fake.failNext = { status: 500, times: 1, match: (path) => path.includes("/api/resources/inlays/") };
        await importer.importBrowserLocalData();
        expect(fake.get("inlays", "later")).toBeNull();
        expect(table(INLAY).has("later")).toBe(true);
        await importer.importBrowserLocalData();
        expect(fake.get("inlays", "later")).not.toBeNull();
        expect(table(INLAY).has("later")).toBe(false);
    });

    it("lets the server copy win and deletes the local entry only when the media is really there", async () => {
        const key = `assets/inlay_${await sha256("mine")}.png`;
        fake.set("inlays", "dup", { name: "theirs.png", ext: "png", type: "image", asset: key, size: 4 });
        assets.set(key, new TextEncoder().encode("mine"));
        table(INLAY).set("dup", { name: "mine.png", ext: "png", type: "image", data: new Blob(["mine"]) });
        await importer.importBrowserLocalData();
        expect(fake.data<InlayResource>("inlays", "dup")!.name).toBe("theirs.png");
        expect(table(INLAY).has("dup")).toBe(false);
        expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    });

    it("repairs a server inlay whose media is missing from the local bytes, and keeps the local copy when they differ", async () => {
        const key = `assets/inlay_${await sha256("abc")}.wav`;
        fake.set("inlays", "partial", { name: "s.wav", ext: "wav", type: "audio", asset: key, size: 3 });
        fake.set("inlays", "other", {
            name: "o.wav",
            ext: "wav",
            type: "audio",
            asset: "assets/inlay_unknown.wav",
            size: 3,
        });
        table(INLAY).set("partial", { name: "s.wav", ext: "wav", type: "audio", data: new Blob(["abc"]) });
        table(INLAY).set("other", { name: "o.wav", ext: "wav", type: "audio", data: new Blob(["xyz"]) });
        await importer.importBrowserLocalData();
        expect(assets.get(key)).toEqual(new TextEncoder().encode("abc"));
        expect(table(INLAY).has("partial")).toBe(false);
        expect(table(INLAY).has("other")).toBe(true);
        expect(assets.has("assets/inlay_unknown.wav")).toBe(false);
        expect(fake.data<InlayResource>("inlays", "other")!.asset).toBe("assets/inlay_unknown.wav");
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("without its media"));
    });
});

describe("plugin storage", () => {
    it("moves JSON values into _safeLocalPluginStorage, keeps non-JSON values local, and lets the server win", async () => {
        fake.set("pluginStorage", "main", { _safeLocalPluginStorage: { shared: "server" } });
        await boot();
        table(PLUGIN).set("safe_plugin_moved", { a: [1] });
        table(PLUGIN).set("safe_plugin_shared", "browser");
        table(PLUGIN).set("safe_plugin_date", new Date());
        table(PLUGIN).set("safe_plugin___proto__", { probe: true });
        table(PLUGIN).set("unrelated", 1);
        await importer.importBrowserLocalData();
        const saved = fake.data("pluginStorage", "main")._safeLocalPluginStorage;
        expect(saved.moved).toEqual({ a: [1] });
        expect(saved.shared).toBe("server");
        expect(Object.hasOwn(saved, "__proto__")).toBe(true);
        expect(saved.__proto__).toEqual({ probe: true });
        expect(saved).not.toHaveProperty("date");
        expect([...table(PLUGIN).keys()].sort()).toEqual(["safe_plugin_date", "unrelated"]);
    });

    it("keeps a local value that another tab changed while the import was saving", async () => {
        table(PLUGIN).set("safe_plugin_race", "old");
        fake.beforeNextBatch = () => {
            table(PLUGIN).set("safe_plugin_race", "new");
        };
        await importer.importBrowserLocalData();
        expect(fake.data("pluginStorage", "main")._safeLocalPluginStorage.race).toBe("old");
        expect(table(PLUGIN).get("safe_plugin_race")).toBe("new");
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("changed in this browser"));
    });
});

describe("permissions", () => {
    it("merges grants and grant times into the server record and deletes them locally", async () => {
        fake.set("pluginPermissions", "main", { grants: { theirs: true }, lastGrantTime: { t: 50 } });
        table(PERMISSIONS).set("hash_db", true);
        table(PERMISSIONS).set("p_db_lastGrantTime", 10);
        table(PERMISSIONS).set("t", 20);
        table(PERMISSIONS).set("denied", false);
        await importer.importBrowserLocalData();
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: { theirs: true, hash_db: true },
            lastGrantTime: { t: 50, p_db_lastGrantTime: 10 },
        });
        expect(permissions.hasPermissionGrant("hash_db")).toBe(true);
        expect(permissions.hasPermissionGrant("theirs")).toBe(true);
        expect([...table(PERMISSIONS).keys()]).toEqual([]);
    });

    it("keeps the local grants when the server write fails", async () => {
        table(PERMISSIONS).set("hash_db", true);
        fake.failNext = { status: 500, times: 5, match: (path) => path.includes("pluginPermissions") };
        await importer.importBrowserLocalData();
        expect(fake.get("pluginPermissions", "main")).toBeNull();
        expect(table(PERMISSIONS).get("hash_db")).toBe(true);
    });
});

describe("Iris dialogue and Google credentials", () => {
    it("moves a valid dialogue into the ui record and credentials into the secrets record, and deletes them locally", async () => {
        table(IRIS).set("current_dialogue", [{ speaker: "Iris", text: "hi", tip: "t" }]);
        table(GOOGLE).set("google-search-creds", { apiKey: "k", searchEngineId: "e" });
        await importer.importBrowserLocalData();
        expect(fake.data("ui", "main").irisDialogue).toEqual([{ speaker: "Iris", text: "hi", tip: "t" }]);
        expect(fake.data("secrets", "main").googleSearchCredentials).toEqual({ apiKey: "k", searchEngineId: "e" });
        expect(table(IRIS).size).toBe(0);
        expect(table(GOOGLE).size).toBe(0);
    });

    it("keeps invalid shapes local and lets an existing server value win", async () => {
        fake.set("ui", "main", {
            ...fake.data<Record<string, unknown>>("ui", "main")!,
            irisDialogue: [{ speaker: "server", text: "kept" }],
        });
        await boot();
        table(IRIS).set("current_dialogue", [{ speaker: "browser", text: "lost" }]);
        table(GOOGLE).set("google-search-creds", { apiKey: 1 });
        await importer.importBrowserLocalData();
        expect(fake.data("ui", "main").irisDialogue).toEqual([{ speaker: "server", text: "kept" }]);
        expect(fake.data("secrets", "main").googleSearchCredentials).toBeUndefined();
        expect(table(IRIS).size).toBe(0);
        expect(table(GOOGLE).get("google-search-creds")).toEqual({ apiKey: 1 });
    });
});

describe("Iris dialogue when the save fails (Phase 6 slice 7: written through the settings views)", () => {
    it("keeps the local dialogue until the server holds it, and deletes it on a later run once it does", async () => {
        const dialogue = [{ speaker: "Iris", text: "hi", tip: "t" }];
        table(IRIS).set("current_dialogue", dialogue);
        fake.failNext = { status: 500, times: 50, match: (path) => path === "/api/resources/batch" };
        await importer.importBrowserLocalData();
        expect(fake.data("ui", "main").irisDialogue).toBeUndefined();
        expect(table(IRIS).get("current_dialogue")).toEqual(dialogue);
        // The ui record holds it (queued): only the server's copy lets the local entry go.
        const { settings } = await import("../settingsViews.svelte");
        expect(JSON.parse(JSON.stringify(settings.ui.irisDialogue))).toEqual(dialogue);

        fake.failNext = null;
        await sync.flushResources();
        expect(fake.data("ui", "main").irisDialogue).toEqual(dialogue);
        await importer.importBrowserLocalData();
        expect(table(IRIS).size).toBe(0);
        expect(fake.data("ui", "main").irisDialogue).toEqual(dialogue);
    });
});

describe("the run as a whole", () => {
    it("continues after a failed step, drops the old caches, and stops on a restore", async () => {
        table(INLAY).set("broken", { name: "b.png", ext: "png", type: "image", data: new Blob(["b"]) });
        table(GOOGLE).set("google-search-creds", { apiKey: "k", searchEngineId: "e" });
        fake.failNext = { status: 500, times: 1, match: (path) => path.includes("/api/resources/inlays/") };
        await importer.importBrowserLocalData();
        expect(fake.data("secrets", "main").googleSearchCredentials).toEqual({ apiKey: "k", searchEngineId: "e" });
        expect(table(INLAY).has("broken")).toBe(true);
        expect(localStorage.getItem("risuauth")).toBeNull();
        expect(forage.has("dropped:risuSaveCache")).toBe(true);

        table(IRIS).set("current_dialogue", [{ speaker: "a", text: "b" }]);
        fake.restore("restored-epoch");
        await expect(importer.importBrowserLocalData()).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        expect(table(INLAY).has("broken")).toBe(true);
        expect(table(IRIS).size).toBe(1);
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
    });
});

describe("the Bergamot model store (docs/plan/translation.md slice 1.5)", () => {
    type Request = { onerror: ((event: Event) => void) | null; onsuccess: unknown; onblocked: unknown };
    const request = (): Request => ({ onerror: null, onsuccess: null, onblocked: null });

    it("asks IndexedDB to delete `firefox-translations-models` without waiting for the request, and swallows its error event", async () => {
        // The request never completes (another tab holds the database open): the import still ends.
        const pending = request();
        const deleteDatabase = vi.fn(() => pending);
        vi.stubGlobal("indexedDB", { deleteDatabase });
        await importer.importBrowserLocalData();
        expect(deleteDatabase).toHaveBeenCalledTimes(1);
        expect(deleteDatabase).toHaveBeenCalledWith("firefox-translations-models");
        // The old caches of the same block were dropped before it.
        expect(localStorage.getItem("risuauth")).toBeNull();
        expect(forage.has("dropped:risuSaveCache")).toBe(true);
        // A later error event is handled: its default (an uncaught error report) is prevented.
        const preventDefault = vi.fn();
        expect(pending.onerror).toBeTypeOf("function");
        pending.onerror!({ preventDefault } as unknown as Event);
        expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("ends the import when IndexedDB is missing, or when the delete throws", async () => {
        // happy-dom has no IndexedDB: the plain run is the missing-global case.
        expect(typeof indexedDB).toBe("undefined");
        await expect(importer.importBrowserLocalData()).resolves.toBeUndefined();

        const deleteDatabase = vi.fn(() => {
            throw new DOMException("denied", "SecurityError");
        });
        vi.stubGlobal("indexedDB", { deleteDatabase });
        await expect(importer.importBrowserLocalData()).resolves.toBeUndefined();
        expect(deleteDatabase).toHaveBeenCalledWith("firefox-translations-models");

        // A global whose access itself throws (a sandboxed frame) is a throw inside the guard too.
        Object.defineProperty(globalThis, "indexedDB", {
            configurable: true,
            get() {
                throw new DOMException("denied", "SecurityError");
            },
        });
        try {
            await expect(importer.importBrowserLocalData()).resolves.toBeUndefined();
        } finally {
            delete (globalThis as { indexedDB?: unknown }).indexedDB;
        }
    });
});

describe("sameLocalValue", () => {
    it("compares Blobs by type and bytes and objects structurally", async () => {
        const { sameLocalValue } = importer;
        expect(await sameLocalValue(new Blob(["a"], { type: "x" }), new Blob(["a"], { type: "x" }))).toBe(true);
        expect(await sameLocalValue(new Blob(["a"], { type: "x" }), new Blob(["a"], { type: "y" }))).toBe(false);
        expect(await sameLocalValue(new Blob(["a"]), new Blob(["b"]))).toBe(false);
        expect(await sameLocalValue(new Blob(["a"]), "a")).toBe(false);
        expect(await sameLocalValue({ data: new Blob(["a"]), n: 1 }, { n: 1, data: new Blob(["a"]) })).toBe(true);
        expect(await sameLocalValue({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
        expect(await sameLocalValue({ a: [1] }, { a: [1], b: 2 })).toBe(false);
        expect(await sameLocalValue([1], { 0: 1 })).toBe(false);
        expect(await sameLocalValue(NaN, NaN)).toBe(true);
        expect(await sameLocalValue(null, undefined)).toBe(false);
    });
});
