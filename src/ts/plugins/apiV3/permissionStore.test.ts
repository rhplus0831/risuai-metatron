import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResourceServer } from "../../storage/tests/fakeResourceServer";

// The server-owned `pluginPermissions` record: append-only merges, conflict re-read and retry,
// serialized calls, and plugin names that collide with `Object.prototype` keys.

const { server } = vi.hoisted(() => ({ server: { current: null as any } }));

vi.mock("../../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));

import * as client from "../../storage/resourceClient";
import {
    getLastGrantTime,
    hasPermissionGrant,
    loadPluginPermissions,
    recordPermissionGrants,
    refreshPluginPermissions,
    revokePermissionGrants,
    seedPluginPermissions,
} from "./permissionStore";

let fake: FakeResourceServer;

beforeEach(async () => {
    fake = new FakeResourceServer();
    server.current = fake;
    client.setResourceEpoch(fake.epoch);
    await loadPluginPermissions();
});

describe("loading", () => {
    it("starts empty when the server has no record and reads an existing one", async () => {
        expect(hasPermissionGrant("hash_db")).toBe(false);
        expect(getLastGrantTime("p_db_lastGrantTime")).toBeUndefined();
        fake.set("pluginPermissions", "main", {
            grants: { hash_db: true, junk: "no" },
            lastGrantTime: { p_db_lastGrantTime: 5, bad: "x" },
        });
        await loadPluginPermissions();
        expect(hasPermissionGrant("hash_db")).toBe(true);
        expect(hasPermissionGrant("junk")).toBe(false);
        expect(getLastGrantTime("p_db_lastGrantTime")).toBe(5);
        expect(getLastGrantTime("bad")).toBeUndefined();
    });

    it("answers prototype-named keys only when they were granted", () => {
        expect(hasPermissionGrant("constructor")).toBe(false);
        expect(hasPermissionGrant("__proto__")).toBe(false);
        expect(getLastGrantTime("toString")).toBeUndefined();
    });
});

describe("seedPluginPermissions", () => {
    it("filters boot grants and uses the boot revision for the first write without a conflict read", async () => {
        const revision = fake.set("pluginPermissions", "main", {
            grants: { boot: true, denied: false, junk: "yes" },
            lastGrantTime: { boot_lastGrantTime: 42, junk: "42" },
        });
        const snapshot = await client.readKinds(["pluginPermissions"]);
        const record = snapshot.kinds.pluginPermissions.find(({ id }) => id === "main")!;
        fake.requests.length = 0;

        seedPluginPermissions(record);
        expect(hasPermissionGrant("boot")).toBe(true);
        expect(hasPermissionGrant("denied")).toBe(false);
        expect(hasPermissionGrant("junk")).toBe(false);
        expect(getLastGrantTime("boot_lastGrantTime")).toBe(42);
        expect(getLastGrantTime("junk")).toBeUndefined();

        await recordPermissionGrants({ grants: ["new"] });
        expect(fake.requests).toEqual([
            {
                method: "PUT",
                path: "/api/resources/pluginPermissions/main",
                body: {
                    baseRevision: revision,
                    data: { grants: { boot: true, new: true }, lastGrantTime: { boot_lastGrantTime: 42 } },
                },
            },
        ]);
        expect(hasPermissionGrant("new")).toBe(true);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: { boot: true, new: true },
            lastGrantTime: { boot_lastGrantTime: 42 },
        });
    });

    it("seeds an absent record empty and creates the first grant at a null base", async () => {
        const revision = fake.set("pluginPermissions", "main", {
            grants: { previous: true },
            lastGrantTime: { previous_lastGrantTime: 42 },
        });
        seedPluginPermissions({ id: "main", revision, data: fake.data("pluginPermissions", "main") });
        expect(hasPermissionGrant("previous")).toBe(true);
        fake.delete("pluginPermissions", "main");
        fake.requests.length = 0;

        seedPluginPermissions(undefined);
        expect(hasPermissionGrant("previous")).toBe(false);
        expect(getLastGrantTime("previous_lastGrantTime")).toBeUndefined();
        await recordPermissionGrants({ grants: ["first"] });
        expect(fake.requests).toEqual([
            {
                method: "PUT",
                path: "/api/resources/pluginPermissions/main",
                body: { baseRevision: null, data: { grants: { first: true }, lastGrantTime: {} } },
            },
        ]);
        expect(fake.data("pluginPermissions", "main")).toEqual({ grants: { first: true }, lastGrantTime: {} });
        expect(hasPermissionGrant("first")).toBe(true);
    });
});

describe("recordPermissionGrants", () => {
    it("creates the record with the first grant and appends later ones", async () => {
        await recordPermissionGrants({ grants: ["hash_db"], lastGrantTime: { p_db_lastGrantTime: 10 } });
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: { hash_db: true },
            lastGrantTime: { p_db_lastGrantTime: 10 },
        });
        await recordPermissionGrants({ grants: ["hash_inlay"] });
        expect(fake.data("pluginPermissions", "main").grants).toEqual({ hash_db: true, hash_inlay: true });
        expect(hasPermissionGrant("hash_inlay")).toBe(true);
    });

    it("keeps the newest grant time and writes nothing when nothing is new", async () => {
        await recordPermissionGrants({ grants: ["h"], lastGrantTime: { t: 10 } });
        const revision = fake.get("pluginPermissions", "main")!.revision;
        await recordPermissionGrants({ grants: ["h"], lastGrantTime: { t: 5 } });
        expect(fake.get("pluginPermissions", "main")!.revision).toBe(revision);
        await recordPermissionGrants({ lastGrantTime: { t: 20 } });
        expect(getLastGrantTime("t")).toBe(20);
        expect(fake.data("pluginPermissions", "main").lastGrantTime.t).toBe(20);
    });

    it("merges into another tab's record after a conflict instead of overwriting it", async () => {
        await recordPermissionGrants({ grants: ["mine"] });
        fake.set("pluginPermissions", "main", { grants: { mine: true, theirs: true }, lastGrantTime: { x: 99 } });
        await recordPermissionGrants({ grants: ["also mine"], lastGrantTime: { x: 1 } });
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: { mine: true, theirs: true, "also mine": true },
            lastGrantTime: { x: 99 },
        });
        expect(hasPermissionGrant("theirs")).toBe(true);
    });

    it("retries a create that lost to another tab's create", async () => {
        fake.set("pluginPermissions", "main", { grants: { theirs: true }, lastGrantTime: {} });
        // `current` still says "no record" (loaded before the other tab wrote).
        await recordPermissionGrants({ grants: ["mine"] });
        expect(fake.data("pluginPermissions", "main").grants).toEqual({ theirs: true, mine: true });
    });

    it("runs concurrent calls one at a time, so no grant is lost", async () => {
        await Promise.all([
            recordPermissionGrants({ grants: ["a"] }),
            recordPermissionGrants({ grants: ["b"] }),
            recordPermissionGrants({ grants: ["c"] }),
        ]);
        expect(Object.keys(fake.data("pluginPermissions", "main").grants).sort()).toEqual(["a", "b", "c"]);
    });

    it("stores a plugin named like a prototype key as a plain grant", async () => {
        await recordPermissionGrants({ grants: ["__proto___db"], lastGrantTime: { ["__proto__"]: 3 } });
        const saved = fake.data("pluginPermissions", "main");
        expect(Object.hasOwn(saved.grants, "__proto___db")).toBe(true);
        expect(Object.hasOwn(saved.lastGrantTime, "__proto__")).toBe(true);
        expect(hasPermissionGrant("__proto___db")).toBe(true);
        expect(getLastGrantTime("__proto__")).toBe(3);
    });

    it("propagates a 412 and other failures to the caller", async () => {
        fake.restore("new-epoch");
        await expect(recordPermissionGrants({ grants: ["x"] })).rejects.toBeInstanceOf(
            client.ResourceEpochMismatchError,
        );
        fake.restore(client.getResourceEpoch());
        fake.failNext = { status: 500, times: 1 };
        await expect(recordPermissionGrants({ grants: ["x"] })).rejects.toMatchObject({ status: 500 });
        await recordPermissionGrants({ grants: ["x"] });
        expect(hasPermissionGrant("x")).toBe(true);
    });
});

describe("revokePermissionGrants", () => {
    const mine = (key: string) => key.startsWith("hash-foo_");
    const myTime = (key: string) => key === "foo_db_lastGrantTime";
    const writes = () => fake.requests.filter(({ method }) => method === "PUT");

    it("reads unseen grants before matching and writes nothing when no keys match", async () => {
        await revokePermissionGrants(mine, myTime);
        expect(fake.get("pluginPermissions", "main")).toBeNull();
        expect(writes()).toEqual([]);

        fake.set("pluginPermissions", "main", {
            grants: { "hash-foo_db": true, "hash-other_db": true },
            lastGrantTime: { foo_db_lastGrantTime: 10, foo_bar_db_lastGrantTime: 20 },
        });
        expect(hasPermissionGrant("hash-foo_db")).toBe(false);
        await revokePermissionGrants(mine, myTime);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: { "hash-other_db": true },
            lastGrantTime: { foo_bar_db_lastGrantTime: 20 },
        });
        expect(writes()).toHaveLength(1);

        await revokePermissionGrants(mine, myTime);
        expect(writes()).toHaveLength(1);
    });

    it("reapplies selectors after four revision conflicts and preserves concurrent grants of another plugin", async () => {
        const timeKeys = new Set([
            "foo_db_lastGrantTime",
            "foo_inlay_lastGrantTime",
            "foo_provider_lastGrantTime",
            "foo_sendChat_lastGrantTime",
            "foo_mainDom_lastGrantTime",
        ]);
        fake.set("pluginPermissions", "main", {
            grants: { "hash-foo_db": true, "hash-other_db": true },
            lastGrantTime: { foo_db_lastGrantTime: 10, foo_bar_db_lastGrantTime: 20 },
        });
        await loadPluginPermissions();
        const statuses: number[] = [];
        server.current = {
            fetch: async (path: string, init?: RequestInit) => {
                if (init?.method !== "PUT") return fake.fetch(path, init);
                if (statuses.length < 4) {
                    const permission = ["inlay", "provider", "sendChat", "mainDom"][statuses.length];
                    const current = fake.data("pluginPermissions", "main");
                    fake.set("pluginPermissions", "main", {
                        grants: {
                            ...current.grants,
                            [`hash-foo_${permission}`]: true,
                            [`hash-other_${permission}`]: true,
                        },
                        lastGrantTime: {
                            ...current.lastGrantTime,
                            [`foo_${permission}_lastGrantTime`]: 30,
                            [`foo_bar_${permission}_lastGrantTime`]: 40,
                        },
                    });
                }
                const response = await fake.fetch(path, init);
                statuses.push(response.status);
                return response;
            },
        };

        await revokePermissionGrants(mine, (key) => timeKeys.has(key));

        expect(statuses).toEqual([409, 409, 409, 409, 200]);
        expect(fake.data("pluginPermissions", "main")).toEqual({
            grants: {
                "hash-other_db": true,
                "hash-other_inlay": true,
                "hash-other_provider": true,
                "hash-other_sendChat": true,
                "hash-other_mainDom": true,
            },
            lastGrantTime: {
                foo_bar_db_lastGrantTime: 20,
                foo_bar_inlay_lastGrantTime: 40,
                foo_bar_provider_lastGrantTime: 40,
                foo_bar_sendChat_lastGrantTime: 40,
                foo_bar_mainDom_lastGrantTime: 40,
            },
        });
    });

    it("stops after five conflicting writes without overwriting the server record", async () => {
        const stored = { grants: { "hash-foo_db": true, "hash-other_db": true }, lastGrantTime: {} };
        fake.set("pluginPermissions", "main", stored);
        server.current = {
            fetch: (path: string, init?: RequestInit) => {
                if (init?.method === "PUT") fake.set("pluginPermissions", "main", stored);
                return fake.fetch(path, init);
            },
        };

        await expect(revokePermissionGrants(mine, myTime)).rejects.toThrow();
        expect(writes()).toHaveLength(5);
        expect(fake.data("pluginPermissions", "main")).toEqual(stored);
    });
});

// Live updates: another tab's or device's grant reaches this tab as a feed notice with the
// committed revision. The fake's revisions are real tokens here, since the refresh compares them.
describe("refreshPluginPermissions", () => {
    const EPOCH = "00000000-0000-4000-8000-000000000002";
    let counter = 0;
    const reads = () => fake.requests.filter((r) => r.method === "GET").length;

    beforeEach(async () => {
        counter = 0;
        fake.restore(EPOCH);
        client.setResourceEpoch(EPOCH);
        const set = fake.set.bind(fake);
        fake.set = (kind: string, id: string, data: unknown) => {
            set(kind, id, data);
            const token = `${EPOCH}:1:${++counter}`;
            fake.records.get(fake.key(kind, id))!.revision = token;
            return token;
        };
        await loadPluginPermissions();
        fake.requests.length = 0;
    });

    it("reads a newer revision, and skips one this tab already holds", async () => {
        const r1 = fake.set("pluginPermissions", "main", { grants: { theirs: true }, lastGrantTime: {} });
        await refreshPluginPermissions(r1);
        expect(hasPermissionGrant("theirs")).toBe(true);
        expect(reads()).toBe(1);
        await refreshPluginPermissions(r1);
        expect(reads()).toBe(1);
        // This tab's own grant: its echo needs no read.
        await recordPermissionGrants({ grants: ["mine"] });
        const own = fake.get("pluginPermissions", "main")!.revision;
        fake.requests.length = 0;
        await refreshPluginPermissions(own);
        expect(reads()).toBe(0);
        expect(hasPermissionGrant("mine")).toBe(true);
    });

    it("runs after a grant write already queued, so the write's newer copy is never replaced by an older read", async () => {
        const r1 = fake.set("pluginPermissions", "main", { grants: { theirs: true }, lastGrantTime: {} });
        const writing = recordPermissionGrants({ grants: ["mine"] });
        const refreshing = refreshPluginPermissions(r1);
        await Promise.all([writing, refreshing]);
        expect(hasPermissionGrant("theirs")).toBe(true);
        expect(hasPermissionGrant("mine")).toBe(true);
        expect(fake.data("pluginPermissions", "main").grants).toEqual({ theirs: true, mine: true });
    });

    it("keeps a newer copy this tab came to hold while the refresh's read was out", async () => {
        const r1 = fake.set("pluginPermissions", "main", { grants: { one: true }, lastGrantTime: {} });
        let release!: () => void;
        const real = fake.fetch;
        let held = false;
        server.current = {
            fetch: async (path: string, init?: RequestInit) => {
                const response = real(path, init);
                if (!held) {
                    held = true;
                    await new Promise<void>((resolve) => (release = resolve));
                }
                return response;
            },
        };
        const refreshing = refreshPluginPermissions(r1);
        await vi.waitFor(() => expect(release).toBeDefined());
        fake.set("pluginPermissions", "main", { grants: { one: true, two: true }, lastGrantTime: {} });
        await loadPluginPermissions();
        release();
        await refreshing;
        expect(hasPermissionGrant("two")).toBe(true);
        server.current = fake;
    });

    it("forgets the grants when the record is gone", async () => {
        const r1 = fake.set("pluginPermissions", "main", { grants: { gone: true }, lastGrantTime: {} });
        await refreshPluginPermissions(r1);
        expect(hasPermissionGrant("gone")).toBe(true);
        fake.delete("pluginPermissions", "main");
        await refreshPluginPermissions(null);
        expect(hasPermissionGrant("gone")).toBe(false);
    });
});
