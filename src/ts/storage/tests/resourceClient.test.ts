import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";

// The resource transport: the epoch header on mutations only, the typed errors, and the one
// epoch-mismatch listener that every consumer (adapter, inlays, permissions) shares.

const { server, calls } = vi.hoisted(() => ({
    server: { current: null as any },
    calls: [] as { path: string; init: RequestInit }[],
}));

vi.mock("../nodeStorage", () => ({
    authFetch: (path: string, init: RequestInit = {}) => {
        calls.push({ path, init });
        return server.current.fetch(path, init);
    },
}));

import * as client from "../resourceClient";

let fake: FakeResourceServer;

beforeEach(() => {
    fake = new FakeResourceServer();
    server.current = fake;
    calls.length = 0;
    client.setResourceEpoch("");
    client.setEpochMismatchListener(null);
});

afterEach(() => {
    vi.clearAllMocks();
});

const header = (call: { init: RequestInit }) => new Headers(call.init.headers).get(RESOURCE_EPOCH_HEADER);

describe("requests", () => {
    it("sends the loaded epoch on mutations and never on reads", async () => {
        fake.set("root", "main", { a: 1 });
        client.setResourceEpoch("epoch-1");
        await client.readKinds(["root"]);
        await client.readRefs([{ kind: "root", id: "main" }]);
        await client.getResource("root", "main");
        expect(calls.map(header)).toEqual([null, null, null]);
        calls.length = 0;
        const put = await client.putResource("inlays", "x", { name: "x" }, null);
        await client.applyBatchText('{"ops":[]}');
        await client.deleteResource("inlays", "x", put.revision);
        expect(calls.map(header)).toEqual(["epoch-1", "epoch-1", "epoch-1"]);
        expect(calls.map((call) => call.init.cache)).toEqual(["no-store", "no-store", "no-store"]);
    });

    it("encodes kind and id once, so path-shaped and non-ASCII ids reach the server intact", async () => {
        client.setResourceEpoch("epoch-1");
        await client.putResource("inlays", "assets/x y.png", { name: "x" }, null);
        await client.putResource("inlays", "§playground", { name: "p" }, null);
        expect(calls.map((call) => call.path)).toEqual([
            "/api/resources/inlays/assets%2Fx%20y.png",
            "/api/resources/inlays/%C2%A7playground",
        ]);
        expect(fake.get("inlays", "assets/x y.png")).not.toBeNull();
        expect(fake.get("inlays", "§playground")).not.toBeNull();
    });

    it("returns null for a missing record and throws a typed error otherwise", async () => {
        expect(await client.getResource("inlays", "nope")).toBeNull();
        fake.failNext = { status: 500, times: 1 };
        await expect(client.getResource("inlays", "nope")).rejects.toMatchObject({
            name: "ResourceRequestError",
            status: 500,
        });
        fake.failNext = { status: 0, times: 1 };
        await expect(client.getResource("inlays", "nope")).rejects.toMatchObject({ status: 0 });
    });
});

describe("conflicts", () => {
    it("maps a batch 409 to every listed conflict", async () => {
        client.setResourceEpoch("epoch-1");
        const revision = fake.set("root", "main", { a: 1 });
        const body = JSON.stringify({
            ops: [
                { kind: "root", id: "main", baseRevision: "stale", data: {} },
                { kind: "characters", id: "c", baseRevision: "stale", data: {} },
            ],
        });
        await expect(client.applyBatchText(body)).rejects.toMatchObject({
            name: "ResourceConflictError",
            conflicts: [
                { kind: "root", id: "main", revision },
                { kind: "characters", id: "c", revision: null },
            ],
        });
        expect(fake.data("root", "main")).toEqual({ a: 1 });
    });

    it("names the record in a single-route conflict", async () => {
        client.setResourceEpoch("epoch-1");
        const revision = fake.set("inlays", "x", { name: "x" });
        await expect(client.putResource("inlays", "x", { name: "y" }, "stale")).rejects.toMatchObject({
            conflicts: [{ kind: "inlays", id: "x", revision }],
        });
        await expect(client.deleteResource("inlays", "x", "stale")).rejects.toMatchObject({
            conflicts: [{ kind: "inlays", id: "x", revision }],
        });
        await expect(client.putResource("inlays", "x", { name: "y" }, null)).rejects.toMatchObject({
            conflicts: [{ kind: "inlays", id: "x", revision }],
        });
    });
});

describe("epoch replacement", () => {
    it("runs the listener once per 412 before throwing", async () => {
        const listener = vi.fn();
        client.setEpochMismatchListener(listener);
        client.setResourceEpoch("old");
        fake.restore("new");
        await expect(client.putResource("inlays", "x", { name: "x" }, null)).rejects.toBeInstanceOf(
            client.ResourceEpochMismatchError,
        );
        await expect(client.applyBatchText('{"ops":[]}')).rejects.toMatchObject({ epoch: "new" });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenCalledWith("new");
    });

    it("treats a read that answers with another epoch as a replacement", async () => {
        const listener = vi.fn();
        client.setEpochMismatchListener(listener);
        client.setResourceEpoch("epoch-1");
        fake.set("root", "main", { a: 1 });
        fake.readEpoch = "from-a-restore";
        await expect(client.readRefs([{ kind: "root", id: "main" }])).rejects.toBeInstanceOf(
            client.ResourceEpochMismatchError,
        );
        await expect(client.readKinds(["root"])).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        await expect(client.getResource("root", "main")).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it("accepts any epoch before one was loaded (the boot read) and the matching one afterwards", async () => {
        const listener = vi.fn();
        client.setEpochMismatchListener(listener);
        fake.set("root", "main", { a: 1 });
        fake.readEpoch = "whatever";
        const boot = await client.readKinds(["root"]);
        expect(boot.epoch).toBe("whatever");
        client.setResourceEpoch(boot.epoch);
        await client.readRefs([{ kind: "root", id: "main" }]);
        expect(listener).not.toHaveBeenCalled();
    });

    it("does not treat the new epoch a restore answers with as a mismatch", async () => {
        const listener = vi.fn();
        client.setEpochMismatchListener(listener);
        client.setResourceEpoch("epoch-1");
        const original = fake.fetch;
        (fake as any).fetch = async (path: string, init?: RequestInit) =>
            path === "/api/backups/snap/restore" ? Response.json({ epoch: "epoch-2" }) : original(path, init);
        expect(await client.restoreBackup("snap")).toBe("epoch-2");
        expect(listener).not.toHaveBeenCalled();
    });
});
