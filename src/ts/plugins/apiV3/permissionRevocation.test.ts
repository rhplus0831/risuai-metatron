import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RisuPlugin } from "../../../../shared/plugins";
import { FakeResourceServer } from "../../storage/tests/fakeResourceServer";

type CapturedApi = { requestPluginPermission: (permission: string) => Promise<boolean> };

const { server, captured, confirm } = vi.hoisted(() => ({
    server: { current: null as FakeResourceServer | null },
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
        expect(fake.get("pluginPermissions", "main")).toBeNull();
        expect(fake.requests.filter(({ method }) => method === "PUT")).toEqual([]);
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
