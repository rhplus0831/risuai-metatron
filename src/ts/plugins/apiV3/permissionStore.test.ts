import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResourceServer } from "../../storage/tests/fakeResourceServer";

// The server-owned `pluginPermissions` record: append-only merges, conflict re-read and retry,
// serialized calls, and plugin names that collide with `Object.prototype` keys.

const { server } = vi.hoisted(() => ({ server: { current: null as any } }));

vi.mock("../../storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));

import * as client from "../../storage/resourceClient";
import { getLastGrantTime, hasPermissionGrant, loadPluginPermissions, recordPermissionGrants } from "./permissionStore";

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
