import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RisuPlugin } from "../../../../shared/plugins";
import { FakeResourceServer } from "../../storage/tests/fakeResourceServer";

type CapturedApi = {
    requestPluginPermission: (permission: string) => Promise<boolean>;
    getDatabase: (includeOnly: string[], options: { chats: "summaries" }) => Promise<unknown>;
};

const { server, captured, confirm } = vi.hoisted(() => ({
    server: { current: null as Pick<FakeResourceServer, "fetch"> | null },
    captured: { api: null as CapturedApi | null },
    confirm: vi.fn(async () => true),
}));

vi.mock("../../storage/serverAuth", async () =>
    (await import("../../storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: (path: string, init?: RequestInit) => server.current!.fetch(path, init),
    }),
);
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: confirm }),
);
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("./factory", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./factory")>()),
    SandboxHost: class {
        constructor(api: CapturedApi) {
            captured.api = api;
        }
        run() {}
        terminate() {}
    },
}));

import { installFlatDatabase } from "../../storage/tests/installFlatDatabase";
import { settings } from "../../storage/settingsViews.svelte";
import { setResourceEpoch } from "../../storage/resourceClient";
import { loadPluginPermissions, refreshPluginPermissions } from "./permissionStore";
import {
    executePluginV3,
    loadV3Plugins,
    removeOrphanPluginPermissionGrants,
    resetPluginPermissions,
} from "./v3.svelte";

const hash = (script: string) => createHash("sha256").update(script, "utf8").digest("hex");
const permissions = ["fetchLogs", "db", "mainDom", "replacer", "provider", "sendChat", "inlay"];
const grantsFor = (script: string) =>
    Object.fromEntries(permissions.map((permission) => [`${hash(script)}_${permission}`, true]));
const timesFor = (name: string) =>
    Object.fromEntries(permissions.map((permission) => [`${name}_${permission}_lastGrantTime`, 100]));
const plugin = (name: string, script: string): RisuPlugin => ({
    name,
    script,
    version: "3.0",
    arguments: {},
    realArg: {},
    argMeta: {},
    customLink: [],
});

async function load(plugin: RisuPlugin): Promise<CapturedApi> {
    captured.api = null;
    await executePluginV3(plugin);
    expect(captured.api).not.toBeNull();
    return captured.api!;
}

let fake: FakeResourceServer;

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
}

function holdNextPermissionWrite() {
    const entered = deferred();
    const released = deferred();
    const statuses: number[] = [];
    let held = false;
    server.current = {
        fetch: async (path, init) => {
            if (path !== "/api/resources/pluginPermissions/main" || init?.method !== "PUT") {
                return fake.fetch(path, init);
            }
            if (!held) {
                held = true;
                entered.resolve();
                await released.promise;
            }
            const response = await fake.fetch(path, init);
            statuses.push(response.status);
            return response;
        },
    };
    return { entered: entered.promise, release: released.resolve, statuses };
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    confirm.mockReset().mockResolvedValue(true);
    fake = new FakeResourceServer();
    // Live updates compare real revision tokens, not the fake's default r1/r2 strings.
    fake.restore("00000000-0000-4000-8000-000000000002");
    let counter = 0;
    const set = fake.set.bind(fake);
    fake.set = (kind, id, data) => {
        set(kind, id, data);
        const revision = `${fake.epoch}:1:${++counter}`;
        fake.records.get(fake.key(kind, id))!.revision = revision;
        return revision;
    };
    server.current = fake;
    setResourceEpoch(fake.epoch);
    installFlatDatabase({ characters: [], plugins: [] });
    await loadPluginPermissions();
});

afterEach(async () => {
    await loadV3Plugins([]);
    document.body.replaceChildren();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("permission revocation through the plugin API", () => {
    it("refuses an expired database renewal when another tab resets during its write and asks again afterward", async () => {
        const loaded = plugin("foo", "renewing script");
        settings.plugins = [loaded];
        const api = await load(loaded);
        const grantKey = `${hash(loaded.script)}_db`;
        fake.set("pluginPermissions", "main", {
            grants: { [grantKey]: true },
            lastGrantTime: { foo_db_lastGrantTime: Date.now() - 4 * 24 * 60 * 60 * 1000 },
        });
        await loadPluginPermissions();
        const held = holdNextPermissionWrite();

        // getDatabase asks for periodic db consent; requestPluginPermission alone does not reconfirm it.
        const requesting = api.getDatabase([], { chats: "summaries" });
        await held.entered;
        const reset = { grants: {}, lastGrantTime: {}, resets: { foo: 1 } };
        // Tab B commits its reset while tab A's accepted renewal is still on the wire.
        fake.set("pluginPermissions", "main", reset);
        held.release();
        const result = await requesting;

        expect(held.statuses[0]).toBe(409);
        expect(fake.data("pluginPermissions", "main")).toEqual(reset);
        expect(result).toBeNull();
        expect(confirm).toHaveBeenCalledTimes(1);

        confirm.mockResolvedValue(false);
        expect(await api.getDatabase([], { chats: "summaries" })).toBeNull();
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(await api.requestPluginPermission("db")).toBe(false);
        expect(fake.data("pluginPermissions", "main")).toEqual(reset);
    });

    it("rejects an open prompt after a live reset even when the plugin had no grants", async () => {
        const loaded = plugin("foo", "pending live script");
        settings.plugins = [loaded];
        const api = await load(loaded);
        const opened = deferred();
        const answer = deferred<boolean>();
        confirm.mockImplementationOnce(() => {
            opened.resolve();
            return answer.promise;
        });
        const requesting = api.requestPluginPermission("db");
        await opened.promise;

        const reset = { grants: {}, lastGrantTime: {}, resets: { foo: 1 } };
        const revision = fake.set("pluginPermissions", "main", reset);
        await refreshPluginPermissions(revision);
        answer.resolve(true);

        expect(await requesting).toBe(false);
        expect(fake.data("pluginPermissions", "main")).toEqual(reset);
        expect(fake.requests.filter(({ method }) => method === "PUT")).toEqual([]);
        confirm.mockResolvedValue(false);
        expect(await api.getDatabase([], { chats: "summaries" })).toBeNull();
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it("keeps different permissions granted by concurrent tabs after a write conflict", async () => {
        const loaded = plugin("foo", "concurrent script");
        settings.plugins = [loaded];
        const api = await load(loaded);
        const held = holdNextPermissionWrite();
        const requesting = api.requestPluginPermission("fetchLogs");
        await held.entered;
        fake.set("pluginPermissions", "main", {
            grants: { [`${hash(loaded.script)}_sendChat`]: true },
            lastGrantTime: {},
        });
        held.release();

        expect(await requesting).toBe(true);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: {
                [`${hash(loaded.script)}_fetchLogs`]: true,
                [`${hash(loaded.script)}_sendChat`]: true,
            },
            lastGrantTime: {},
        });
        expect(held.statuses).toEqual([409, 200]);
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("persists every empty settings reset and allows consent begun after the reset", async () => {
        const loaded = plugin("foo", "empty reset script");
        settings.plugins = [loaded];
        const api = await load(loaded);

        await resetPluginPermissions(loaded.name, loaded.script);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: {},
            lastGrantTime: {},
            resets: { foo: 1 },
        });
        await resetPluginPermissions(loaded.name, loaded.script);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: {},
            lastGrantTime: {},
            resets: { foo: 2 },
        });

        expect(await api.requestPluginPermission("db")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: { [`${hash(loaded.script)}_db`]: true },
            lastGrantTime: {},
            resets: { foo: 2 },
        });
    });

    it("resets both settings and loaded scripts, preserves similarly named plugins, and asks again", async () => {
        const loaded = plugin("foo", "loaded script");
        settings.plugins = [loaded, plugin("foo_bar", "other script")];
        const api = await load(loaded);
        settings.plugins[0].script = "settings script";
        fake.set("pluginPermissions", "main", {
            grants: { ...grantsFor("loaded script"), ...grantsFor("settings script"), ...grantsFor("other script") },
            lastGrantTime: { ...timesFor("foo"), ...timesFor("foo_bar") },
        });
        await loadPluginPermissions();
        expect(await api.requestPluginPermission("fetchLogs")).toBe(true);
        expect(confirm).not.toHaveBeenCalled();

        await resetPluginPermissions("foo", settings.plugins[0].script);

        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: grantsFor("other script"),
            lastGrantTime: timesFor("foo_bar"),
            resets: { foo: 1 },
        });
        confirm.mockResolvedValue(false);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(1);

        // A reset also drops a denial held only in this page's answer cache.
        await resetPluginPermissions("foo", settings.plugins[0].script);
        confirm.mockResolvedValue(true);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(fake.data("pluginPermissions", "main").grants).toEqual({
            ...grantsFor("other script"),
            [`${hash("loaded script")}_fetchLogs`]: true,
        });
    });

    it("rejects an open consent prompt after reset without recording its answer", async () => {
        const loaded = plugin("foo", "pending script");
        settings.plugins = [loaded];
        const api = await load(loaded);
        let markOpened!: () => void;
        let resolveAnswer!: (granted: boolean) => void;
        const opened = new Promise<void>((resolve) => (markOpened = resolve));
        const answer = new Promise<boolean>((resolve) => (resolveAnswer = resolve));
        confirm.mockImplementationOnce(() => {
            markOpened();
            return answer;
        });
        const requesting = api.requestPluginPermission("fetchLogs");
        await opened;

        await resetPluginPermissions(loaded.name, loaded.script);
        resolveAnswer(true);

        expect(await requesting).toBe(false);
        // Only the reset itself is written: its count, never the answered grant.
        expect(fake.data("pluginPermissions", "main")).toEqual({ grants: {}, lastGrantTime: {}, resets: { foo: 1 } });
        expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
        confirm.mockResolvedValue(false);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it("asks again for a grant revoked by a live update while retaining other cached grants", async () => {
        const loaded = plugin("foo", "live script");
        settings.plugins = [loaded];
        const api = await load(loaded);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(true);
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);

        const revision = fake.set("pluginPermissions", "main", {
            grants: { [`${hash(loaded.script)}_sendChat`]: true },
            lastGrantTime: {},
        });
        await refreshPluginPermissions(revision);

        confirm.mockResolvedValue(false);
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(3);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: { [`${hash(loaded.script)}_sendChat`]: true },
            lastGrantTime: {},
        });
    });

    it("removes orphan grants and times while keeping installed and still-loaded scripts and names", async () => {
        const loaded = plugin("foo", "old script");
        const retiring = plugin("retiring", "retiring script");
        await load(loaded);
        await load(retiring);
        settings.plugins = [plugin("foo", "new script"), { ...plugin("disabled", "disabled script"), enabled: false }];
        const keptGrants = {
            ...grantsFor("old script"),
            ...grantsFor("new script"),
            ...grantsFor("retiring script"),
            ...grantsFor("disabled script"),
        };
        const keptTimes = { ...timesFor("foo"), ...timesFor("retiring"), ...timesFor("disabled") };
        fake.set("pluginPermissions", "main", {
            grants: { ...keptGrants, ...grantsFor("orphan script") },
            lastGrantTime: { ...keptTimes, ...timesFor("foo_bar") },
        });

        await removeOrphanPluginPermissionGrants();

        expect(fake.data("pluginPermissions", "main")).toEqual({ grants: keptGrants, lastGrantTime: keptTimes });
    });
});
