import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";

// The resource transport: the epoch header on mutations only, the typed errors, and the one
// epoch-mismatch listener that every consumer (adapter, inlays, permissions) shares.

const { server, calls } = vi.hoisted(() => ({
    server: { current: null as any },
    calls: [] as { path: string; init: RequestInit }[],
}));

vi.mock("../serverAuth", () => ({
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

    it("passes cancellation to every read transport without putting the signal in the JSON body", async () => {
        fake.set("root", "main", { a: 1 });
        const { signal } = new AbortController();
        // The resource-only fake has no revision-list route; keep the other requests on it.
        const transport = vi.fn((path: string, init?: RequestInit) =>
            path === "/api/resources/revisions"
                ? Promise.resolve(Response.json({ epoch: fake.epoch, resources: [], chats: [], chatOrders: [] }))
                : fake.fetch(path, init),
        );
        server.current = { fetch: transport };
        await client.readKinds(["root"], { signal });
        await client.readRefs([{ kind: "root", id: "main" }], {
            chats: [{ characterId: "c", id: "k" }],
            chatCollections: ["c"],
            chatSummaryCollections: ["d"],
            signal,
        });
        await client.listRevisions({ signal });
        await client.getResource("root", "main", { signal });
        expect(calls.map(({ init }) => init.signal)).toEqual([signal, signal, signal, signal]);
        expect(JSON.parse(calls[1].init.body as string)).toEqual({
            refs: [{ kind: "root", id: "main" }],
            chats: [{ characterId: "c", id: "k" }],
            chatCollections: ["c"],
            chatSummaryCollections: ["d"],
            continue: true,
        });
        expect(calls.filter(({ init }) => init.body !== undefined)).toHaveLength(1);
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

describe("continued reads", () => {
    it("accepts a moved row answer on its own without another request", async () => {
        const request = { characterId: "c", id: "k", revision: "epoch-1:1:2", messageIds: ["b"], meta: [] };
        const moved = { characterId: "c", id: "k", revision: null, moved: true };
        server.current = {
            fetch: vi.fn().mockResolvedValue(Response.json({ epoch: "epoch-1", items: [], chatRows: [moved] })),
        };
        expect(await client.readRefs([], { chatRows: [request] })).toEqual({
            epoch: "epoch-1",
            items: [],
            chatRows: [moved],
        });
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].init.body as string)).toEqual({ refs: [], chatRows: [request], continue: true });
    });

    it("counts moved row answers as progress and merges row reads across mixed continuations", async () => {
        const requests = ["k", "j"].map((id) => ({
            characterId: "c",
            id,
            revision: "epoch-1:1:2",
            messageIds: ["b"],
            meta: ["scriptstate"],
        }));
        const moved = { characterId: "c", id: "k", revision: "epoch-1:1:3", moved: true };
        const rows = {
            characterId: "c",
            id: "j",
            revision: requests[1].revision,
            rows: [{ id: "b", after: "a", message: { chatId: "b", role: "char", data: "B" } }],
            metaFields: { set: { scriptstate: { keep: "same", active: "reroll" } }, remove: [] },
        };
        const pending = {
            refs: [],
            chats: [],
            chatRows: [requests[1]],
            chatCollections: [],
            chatSummaryCollections: ["c"],
        };
        const last = { ...pending, chatRows: [] };
        const summary = { characterId: "c", order: null, chats: [] };
        server.current = {
            fetch: vi
                .fn()
                .mockResolvedValueOnce(
                    Response.json({ epoch: "epoch-1", items: [], chatRows: [moved], unanswered: pending }),
                )
                .mockResolvedValueOnce(
                    Response.json({ epoch: "epoch-1", items: [], chatRows: [rows], unanswered: last }),
                )
                .mockResolvedValueOnce(
                    Response.json({ epoch: "epoch-1", items: [], chatSummaryCollections: [summary] }),
                ),
        };
        const { signal } = new AbortController();
        expect(await client.readRefs([], { chatRows: requests, chatSummaryCollections: ["c"], signal })).toEqual({
            epoch: "epoch-1",
            items: [],
            chatRows: [moved, rows],
            chatSummaryCollections: [summary],
        });
        expect(calls).toHaveLength(3);
        expect(calls.map(({ init }) => init.signal)).toEqual([signal, signal, signal]);
        expect(JSON.parse(calls[0].init.body as string)).toEqual({
            refs: [],
            chatRows: requests,
            chatSummaryCollections: ["c"],
            continue: true,
        });
        expect(JSON.parse(calls[1].init.body as string)).toEqual({ ...pending, continue: true });
        expect(JSON.parse(calls[2].init.body as string)).toEqual({ ...last, continue: true });
    });

    const a = { kind: "characters", id: "a" };
    const b = { kind: "characters", id: "b" };
    const pending = (refs = [b]) => ({ refs, chats: [], chatCollections: [], chatSummaryCollections: [] });
    const item = (ref: { kind: string; id: string }) => ({ ...ref, revision: "r1", data: { name: ref.id } });
    const collection = (characterId: string) => ({ characterId, order: null, chats: [] });

    it("merges two rounds once in request order when a character pulls a later collection forward", async () => {
        const { signal } = new AbortController();
        const unanswered = {
            refs: [b],
            chats: [{ characterId: "b", id: "k" }],
            chatCollections: ["b", "c"],
            chatSummaryCollections: ["c", "b"],
        };
        const chat = { characterId: "b", id: "k", revision: null, data: null };
        let release!: (response: Response) => void;
        let reached!: () => void;
        const secondRequest = new Promise<void>((resolve) => {
            reached = resolve;
        });
        server.current = {
            fetch: vi
                .fn()
                .mockResolvedValueOnce(
                    Response.json({
                        epoch: "epoch-1",
                        items: [item(a)],
                        chats: [],
                        chatCollections: [collection("a")],
                        chatSummaryCollections: [collection("a")],
                        unanswered,
                    }),
                )
                .mockImplementationOnce(() => {
                    reached();
                    return new Promise<Response>((resolve) => {
                        release = resolve;
                    });
                }),
        };
        const returned = vi.fn();
        const reading = client
            .readRefs([a, b], {
                chats: [{ characterId: "b", id: "k" }],
                chatCollections: ["b", "a", "c"],
                chatSummaryCollections: ["c", "a", "b"],
                signal,
            })
            .then((result) => {
                returned(result);
                return result;
            });
        await secondRequest;
        expect(returned).not.toHaveBeenCalled();
        expect(calls).toHaveLength(2);
        expect(calls.map(({ init }) => init.signal)).toEqual([signal, signal]);
        expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ continue: true });
        expect(JSON.parse(calls[1].init.body as string)).toEqual({ ...unanswered, continue: true });
        release(
            Response.json({
                epoch: "epoch-1",
                items: [item(b)],
                chats: [chat],
                chatCollections: [collection("b"), collection("c")],
                chatSummaryCollections: [collection("c"), collection("b")],
            }),
        );
        expect(await reading).toEqual({
            epoch: "epoch-1",
            items: [item(a), item(b)],
            chats: [chat],
            chatCollections: [collection("b"), collection("a"), collection("c")],
            chatSummaryCollections: [collection("c"), collection("a"), collection("b")],
        });
        expect(returned).toHaveBeenCalledTimes(1);
        expect(returned.mock.calls[0][0]).not.toHaveProperty("unanswered");
    });

    it("continues the fake server's deduplicated plain-ref answers", async () => {
        fake.readResponseBytes = 1;
        fake.set(a.kind, a.id, { name: "a" });
        fake.set(b.kind, b.id, { name: "b" });
        const result = await client.readRefs([a, a, b, b]);
        expect(result.items.map(({ id, data }) => ({ id, data }))).toEqual([
            { id: "a", data: { name: "a" } },
            { id: "b", data: { name: "b" } },
        ]);
        expect(calls).toHaveLength(2);
        expect(result).not.toHaveProperty("unanswered");
        expect(JSON.parse(calls[1].init.body as string)).toEqual({ ...pending(), continue: true });
    });

    it.each([false, true])("rejects a round with no progress even with duplicate input (%s)", async (duplicates) => {
        const requested = duplicates ? [a, a] : [a];
        server.current = {
            fetch: vi
                .fn()
                .mockResolvedValueOnce(Response.json({ epoch: "epoch-1", items: [], unanswered: pending([a]) }))
                // A finite fallback makes a missing progress guard fail without hanging the test.
                .mockResolvedValue(Response.json({ epoch: "epoch-1", items: [item(a)] })),
        };
        const returned = vi.fn();
        await expect(client.readRefs(requested).then(returned)).rejects.toBeInstanceOf(client.ResourceRequestError);
        expect(returned).not.toHaveBeenCalled();
        expect(calls).toHaveLength(1);
    });

    it.each(["no progress", "HTTP failure"])("discards an earlier round after %s", async (failure) => {
        server.current = {
            fetch: vi
                .fn()
                .mockResolvedValueOnce(Response.json({ epoch: "epoch-1", items: [item(a)], unanswered: pending() }))
                .mockResolvedValueOnce(
                    failure === "no progress"
                        ? Response.json({ epoch: "epoch-1", items: [], unanswered: pending() })
                        : Response.json({ error: "failed" }, { status: 500 }),
                )
                .mockResolvedValue(Response.json({ epoch: "epoch-1", items: [item(b)] })),
        };
        const returned = vi.fn();
        await expect(client.readRefs([a, b]).then(returned)).rejects.toBeInstanceOf(client.ResourceRequestError);
        expect(returned).not.toHaveBeenCalled();
        expect(calls).toHaveLength(2);
    });

    it.each([
        ["epoch-1", 412],
        ["", 412],
        ["epoch-1", 200],
        ["", 200],
    ] as const)(
        "discards rounds and calls the epoch listener with loaded epoch '%s' and status %s",
        async (loaded, status) => {
            client.setResourceEpoch(loaded);
            const listener = vi.fn();
            client.setEpochMismatchListener(listener);
            server.current = {
                fetch: vi
                    .fn()
                    .mockResolvedValueOnce(Response.json({ epoch: "epoch-1", items: [item(a)], unanswered: pending() }))
                    .mockResolvedValueOnce(
                        Response.json(
                            status === 412
                                ? { error: "EpochMismatch", epoch: "epoch-2" }
                                : { epoch: "epoch-2", items: [item(b)] },
                            { status },
                        ),
                    ),
            };
            const returned = vi.fn();
            await expect(client.readRefs([a, b]).then(returned)).rejects.toBeInstanceOf(
                client.ResourceEpochMismatchError,
            );
            expect(returned).not.toHaveBeenCalled();
            expect(listener).toHaveBeenCalledExactlyOnceWith("epoch-2");
            expect(calls).toHaveLength(2);
        },
    );

    it("stops before the next round when the caller aborts", async () => {
        const controller = new AbortController();
        const reason = new Error("caller stopped the read");
        server.current = {
            fetch: vi
                .fn()
                .mockImplementationOnce(async () => {
                    controller.abort(reason);
                    return Response.json({ epoch: "epoch-1", items: [item(a)], unanswered: pending() });
                })
                .mockResolvedValue(Response.json({ epoch: "epoch-1", items: [item(b)] })),
        };
        const returned = vi.fn();
        await expect(client.readRefs([a, b], { signal: controller.signal }).then(returned)).rejects.toBe(reason);
        expect(returned).not.toHaveBeenCalled();
        expect(calls).toHaveLength(1);
    });
});
