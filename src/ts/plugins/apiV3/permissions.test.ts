import { beforeEach, describe, expect, it, vi } from "vitest";

// `getPluginPermission` in the v3 host API: a grant is keyed by the hash of the script captured when
// the plugin was loaded plus the permission, so one consent answers one permission of one plugin,
// a plugin that rewrites its own database copy keeps its original grants, answers are cached per
// (plugin, permission) for the page load and dropped on unload, and "periodically" asks again after
// three days.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { db, captured, grants, times, recorded, confirm } = vi.hoisted(() => ({
    db: { characters: [] as any[], plugins: [] as any[], pluginCustomStorage: undefined as any },
    captured: { api: null as CapturedApi | null },
    grants: new Set<string>(),
    times: new Map<string, number>(),
    recorded: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
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
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
    setCurrentChat: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => [{ url: "https://example.com/path?q=1", body: "", response: "", success: true }]),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: { getItem: vi.fn(), setItem: vi.fn(), keys: vi.fn(async () => []) },
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("src/ts/alert", () => ({
    alertConfirm: confirm,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async (bytes: Uint8Array) => `h(${new TextDecoder().decode(bytes)})`),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("./permissionStore", () => ({
    hasPermissionGrant: (key: string) => grants.has(key),
    getLastGrantTime: (key: string) => times.get(key),
    recordPermissionGrants: recorded,
}));
vi.mock("src/ts/process/files/inlays", () => ({ getInlayAsset: vi.fn(async () => ({ name: "inlay" })) }));

import { executePluginV3, getV3PluginInstance, loadV3Plugins } from "./v3.svelte";

let counter = 0;

async function makeApi(script = "script-a"): Promise<{ api: CapturedApi; plugin: any }> {
    captured.api = null;
    const plugin = { name: `perm-test-${++counter}`, script, version: "3.0" };
    db.plugins = [plugin];
    await executePluginV3(plugin as any);
    expect(captured.api).not.toBeNull();
    return { api: captured.api!, plugin };
}

beforeEach(() => {
    grants.clear();
    times.clear();
    recorded.mockClear();
    confirm.mockClear();
    confirm.mockResolvedValue(true);
    vi.useRealTimers();
});

describe("grants", () => {
    it("answers from a stored grant for that permission only; other permissions still ask", async () => {
        const { api, plugin } = await makeApi("script-a");
        grants.add("h(script-a)_db");
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now());
        expect(await api.getDatabase()).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        expect(await api.readInlay("x")).toEqual({ name: "inlay" });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveBeenCalledWith({ grants: ["h(script-a)_inlay"], lastGrantTime: expect.any(Object) });
    });

    it("records a consent under the (script hash, permission) key and caches the answer", async () => {
        const { api } = await makeApi("script-b");
        expect(await api.requestPluginPermission("fetchLogs")).toBe(true);
        expect(recorded).toHaveBeenCalledWith({ grants: ["h(script-b)_fetchLogs"], lastGrantTime: undefined });
        expect(await api.getFetchLogs()).toHaveLength(1);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("caches a denial per permission and keeps asking for other permissions", async () => {
        confirm.mockResolvedValue(false);
        const { api } = await makeApi("script-c");
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(await api.getFetchLogs()).toBeNull();
        expect(await api.requestPluginPermission("sendChat")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(recorded).not.toHaveBeenCalled();
    });

    it("hashes the script captured at load, not the database copy a plugin may rewrite", async () => {
        const { api, plugin } = await makeApi("original");
        grants.add("h(original)_db");
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now());
        plugin.script = "rewritten by a db-granted plugin";
        db.plugins[0].script = "rewritten by a db-granted plugin";
        expect(await api.getDatabase()).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        grants.clear();
        // A grant for the rewritten script does not answer the loaded plugin either.
        const { api: second } = await makeApi("loaded");
        grants.add("h(rewritten)_fetchLogs");
        db.plugins[0].script = "rewritten";
        confirm.mockResolvedValue(false);
        expect(await second.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("keeps a consent for the page load even when saving the grant fails", async () => {
        recorded.mockRejectedValueOnce(new Error("offline"));
        const { api } = await makeApi("script-d");
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});

/**
 * Unloads every running plugin. `loadV3Plugins` maps over the live instance list while each
 * unload splices it, so one pass can skip entries (pre-existing; recorded in `plugins-mcp.md`).
 */
async function unloadAll() {
    for (let attempt = 0; attempt < 10 && getV3PluginInstance(`perm-test-${counter}`); attempt += 1) {
        await loadV3Plugins([]);
    }
}

describe("unload", () => {
    it("drops the cached answers when the plugin is unloaded, so a reload asks again", async () => {
        const { api, plugin } = await makeApi("script-e");
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
        await unloadAll();
        expect(getV3PluginInstance(plugin.name)).toBeUndefined();
        await executePluginV3(plugin as any);
        const reloaded = captured.api!;
        expect(reloaded).not.toBe(api);
        expect(await reloaded.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
    });
});

describe("periodic permissions", () => {
    it("asks again three days after the last grant and records the new time", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
        const { api, plugin } = await makeApi("script-f");
        grants.add("h(script-f)_db");
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now() - 2 * 24 * 60 * 60 * 1000);
        expect(await api.getDatabase()).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();

        await unloadAll();
        await executePluginV3(plugin as any);
        const later = captured.api!;
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now() - 4 * 24 * 60 * 60 * 1000);
        expect(await later.getDatabase()).not.toBeNull();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveBeenCalledWith({
            grants: ["h(script-f)_db"],
            lastGrantTime: { [`${plugin.name}_db_lastGrantTime`]: Date.now() },
        });
    });
});
