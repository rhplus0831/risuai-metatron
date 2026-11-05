// @vitest-environment node
import http from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { EventFeedFrame, MemoryTaskEntry } from "../../../shared/events.ts";
import { revisionDigest, type ResourceRevisionListing } from "../../../shared/resources.ts";
import { DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import { createChangeFeed } from "../data/changeFeed.ts";
import { createEventSockets } from "../routes/events.ts";
import {
    allowListenerOrigin,
    createSigner,
    createTestServer,
    json,
    waitFor,
    type TestServerOptions,
} from "./testSupport.ts";

// The live-update socket (`/api/events/ws`, `server/src/routes/events.ts`) on a real listening
// server: JWT-only authentication, `hello` with the epoch and the memory task snapshot, every
// committed change delivered to every socket, close (1001) on shutdown and refusal afterwards, the
// heartbeat, and the revision listing route the client reconciles against after every `hello`; and
// the module alone: frames published while another is being sent keep their order on every socket,
// a failing snapshot closes the socket (1011) instead of sending a partial `hello`. The publisher is
// in `changeFeed.test.ts`; the frames of a real memory task are in `memoryTasks.test.ts`.

type Client = {
    frames: EventFeedFrame[];
    /** "open", or the HTTP status that refused the upgrade (0: no response). */
    opened: Promise<"open" | number>;
    closed: Promise<number>;
    ws: WsClient;
};

function connect(url: string, headers: Record<string, string> = {}): Client {
    const ws = new WsClient(url, { headers });
    const frames: EventFeedFrame[] = [];
    let settleOpen!: (value: "open" | number) => void;
    const opened = new Promise<"open" | number>((resolve) => (settleOpen = resolve));
    const closed = new Promise<number>((resolve) => {
        ws.on("close", (code) => {
            settleOpen(0);
            resolve(code);
        });
    });
    ws.on("open", () => settleOpen("open"));
    ws.on("unexpected-response", (_request, response) => {
        settleOpen(response.statusCode ?? 0);
        ws.terminate();
    });
    ws.on("error", () => {});
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as EventFeedFrame));
    return { frames, opened, closed, ws };
}

/** Wait for wire evidence without polling or a real production deadline. */
function frameAt(client: Client, index: number): Promise<EventFeedFrame> {
    if (client.frames[index]) return Promise.resolve(client.frames[index]);
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            client.ws.off("message", message);
            client.ws.off("close", closed);
        };
        const message = () => {
            if (client.frames[index]) {
                cleanup();
                resolve(client.frames[index]);
            }
        };
        const closed = () => {
            cleanup();
            reject(new Error("Socket closed before the expected frame"));
        };
        client.ws.on("message", message);
        client.ws.on("close", closed);
    });
}

/** A pong follows all change frames queued by the completed writes, including zero on rollback. */
async function delivered(client: Client) {
    const pong = new Promise<void>((resolve) => client.ws.once("pong", () => resolve()));
    client.ws.ping();
    await pong;
}

const noteKind: ResourceKind = { name: "notes", schemaVersion: 1, normalize: (value) => value };
const digestKinds = [...DEFAULT_RESOURCE_KINDS, noteKind];
const admissionBytes = 4 * 1024 * 1024;

describe("the live-update socket on the server", () => {
    let server: ReturnType<typeof createTestServer>;
    let node: http.Server | undefined;
    let base = "";
    let wsBase = "";
    let signer: Awaited<ReturnType<typeof createSigner>>;
    const clients: Client[] = [];

    beforeAll(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterAll(() => {
        vi.restoreAllMocks();
    });
    afterEach(async () => {
        vi.useRealTimers();
        for (const client of clients.splice(0)) {
            client.ws.terminate();
        }
        await server?.close();
        if (node) {
            node.closeAllConnections();
            await new Promise((resolve) => node?.close(resolve));
            node = undefined;
        }
    });

    async function listen(options: TestServerOptions = {}) {
        server = createTestServer({ password: "pw", ...options });
        const started = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
        node = started;
        await new Promise<void>((resolve) => started.once("listening", () => resolve()));
        allowListenerOrigin(started);
        server.context.attachWebSocket(started);
        const { port } = started.address() as { port: number };
        base = `http://127.0.0.1:${port}`;
        wsBase = `ws://127.0.0.1:${port}/api/events/ws`;
        signer = await createSigner();
        await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }));
    }

    async function open(query?: string, headers: Record<string, string> = {}) {
        const client = connect(
            query === undefined ? `${wsBase}?risu-auth=${await signer.jwt()}` : `${wsBase}${query}`,
            headers,
        );
        clients.push(client);
        return client;
    }

    async function request(url: string, init: RequestInit = {}) {
        return fetch(`${base}${url}`, {
            ...init,
            headers: { "risu-auth": await signer.jwt(), ...((init.headers as Record<string, string>) ?? {}) },
        });
    }

    const epochOf = async () =>
        ((await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing).epoch;

    it("sends committed cursors with hello and changes and serves bounded replay alongside the whole listing", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        await listen({ resourceKinds: digestKinds });
        const initial = (await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing;
        const epoch = initial.epoch;
        const put = async (baseRevision: string | null, text: string) => {
            const response = await request("/api/resources/notes/r", {
                ...json({ baseRevision, data: { text } }, { "x-resource-epoch": epoch }),
                method: "PUT",
            });
            expect(response.status).toBe(200);
            return ((await response.json()) as { revision: string }).revision;
        };
        const first = await open();
        expect(await frameAt(first, 0)).toMatchObject({
            type: "hello",
            epoch,
            cursor: 0,
            digest: revisionDigest(initial),
        });
        const one = await put(null, "one");
        const two = await put(one, "two");
        expect(
            (
                await request(`/api/resources/notes/r?baseRevision=${encodeURIComponent(two)}`, {
                    method: "DELETE",
                    headers: { "x-resource-epoch": epoch },
                })
            ).status,
        ).toBe(200);
        for (const [index, revision] of [one, two, null].entries()) {
            expect(await frameAt(first, index + 1)).toEqual({
                type: "change",
                epoch,
                cursor: index + 1,
                changes: {
                    resources: [{ kind: "notes", id: "r", revision }],
                    chats: [],
                    chatOrders: [],
                },
            });
        }
        const reconnect = await open();
        expect(await frameAt(reconnect, 0)).toMatchObject({
            type: "hello",
            epoch,
            cursor: 3,
            digest: revisionDigest(initial),
        });
        const replay = await request(`/api/resources/revisions?since=0&until=2&epoch=${epoch}`);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({
            epoch,
            cursor: 2,
            changes: { resources: [{ kind: "notes", id: "r", revision: two }], chats: [], chatOrders: [] },
        });
        expect(await (await request(`/api/resources/revisions?since=2&until=3&epoch=${epoch}`)).json()).toEqual({
            epoch,
            cursor: 3,
            changes: { resources: [{ kind: "notes", id: "r", revision: null }], chats: [], chatOrders: [] },
        });
        expect(await (await request(`/api/resources/revisions?since=0&until=4&epoch=${epoch}`)).json()).toEqual({
            epoch,
            cursor: 3,
            expired: true,
        });
        expect(await (await request("/api/resources/revisions?since=0&until=3&epoch=old")).json()).toEqual({
            epoch,
            cursor: 3,
        });
        expect(await (await request("/api/resources/revisions")).json()).toEqual(initial);
        for (const query of [
            "since=0&until=3",
            `since=0&epoch=${epoch}`,
            `since=&until=3&epoch=${epoch}`,
            `since=-1&until=3&epoch=${epoch}`,
            `since=0.5&until=3&epoch=${epoch}`,
            `since=0&until=NaN&epoch=${epoch}`,
            `since=0&until=9007199254740992&epoch=${epoch}`,
        ])
            expect((await request(`/api/resources/revisions?${query}`)).status, query).toBe(400);
    });

    it("admits a JWT in the query or the header and sends `hello` with the epoch and the (empty) memory task snapshot", async () => {
        await listen();
        const epoch = await epochOf();
        const byQuery = await open();
        expect(await byQuery.opened).toBe("open");
        await waitFor(() => byQuery.frames.length > 0);
        expect(byQuery.frames[0]).toEqual({
            type: "hello",
            epoch,
            streaming: [],
            memoryTasks: [],
            digest: expect.stringMatching(/^[0-9a-f]{32}$/),
            cursor: 0,
        });
        const byHeader = await open("", { "risu-auth": await signer.jwt() });
        expect(await byHeader.opened).toBe("open");
        await waitFor(() => byHeader.frames.length > 0);
        expect(byHeader.frames[0]).toEqual({
            type: "hello",
            epoch,
            streaming: [],
            memoryTasks: [],
            digest: expect.stringMatching(/^[0-9a-f]{32}$/),
            cursor: 0,
        });
        expect(server.context.eventSockets.size()).toBe(2);
    });

    it("reconciles a committed refs-only change from the revision listing after admission closes the socket", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        await listen({ resourceKinds: digestKinds });
        const before = (await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing;
        const client = await open();
        const hello = await frameAt(client, 0);
        expect(hello).toMatchObject({ type: "hello", epoch: before.epoch, digest: revisionDigest(before) });

        // Even a small refs-only frame cannot fit when only one byte remains. No patch can be
        // trimmed to rescue it: the reconnect must discover the committed revision instead.
        const buffered = vi.spyOn(WsClient.prototype, "bufferedAmount", "get").mockReturnValue(admissionBytes - 1);
        const send = vi.spyOn(WsClient.prototype, "send");
        const terminate = vi.spyOn(WsClient.prototype, "terminate");
        let revision: string;
        try {
            const response = await request("/api/resources/notes/missed", {
                ...json(
                    { baseRevision: null, data: { text: "committed while disconnected" } },
                    { "x-resource-epoch": before.epoch },
                ),
                method: "PUT",
            });
            expect(response.status).toBe(200);
            revision = ((await response.json()) as { revision: string }).revision;
            expect(send).not.toHaveBeenCalled();
            expect(terminate).toHaveBeenCalledTimes(1);
            expect(await client.closed).toBe(1006);
            expect(client.frames).toEqual([hello]);
        } finally {
            buffered.mockRestore();
            send.mockRestore();
            terminate.mockRestore();
        }

        const reconnected = await open();
        const nextHello = await frameAt(reconnected, 0);
        const listing = (await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing;
        expect(listing.resources).toContainEqual({ kind: "notes", id: "missed", revision });
        expect(nextHello).toEqual({
            type: "hello",
            epoch: before.epoch,
            streaming: [],
            memoryTasks: [],
            digest: revisionDigest(listing),
            cursor: expect.any(Number),
        });
        expect(revisionDigest(listing)).not.toBe(revisionDigest(before));
        await delivered(reconnected);
        expect(reconnected.frames).toEqual([nextHello]);
    });

    it("refuses the raw password, an expired or broken JWT, and no token (401), without a frame", async () => {
        await listen();
        const now = Math.floor(Date.now() / 1000);
        const refused = [
            await open("?risu-auth=pw"),
            await open("", { "risu-auth": "pw" }),
            await open(`?risu-auth=${await signer.jwt({ exp: now - 10 })}`),
            await open(`?risu-auth=${await signer.jwt({ breakSignature: true })}`),
            await open(""),
        ];
        for (const client of refused) {
            expect(await client.opened).toBe(401);
            expect(client.frames).toEqual([]);
        }
        expect(server.context.eventSockets.size()).toBe(0);
    });

    it("delivers every committed change to every socket, refs and revisions only, and a deletion as null", async () => {
        await listen();
        const a = await open();
        const b = await open();
        await waitFor(() => a.frames.length > 0 && b.frames.length > 0);
        const epoch = await epochOf();
        const put = await fetch(`${base}/api/resources/characters/c`, {
            method: "PUT",
            headers: {
                "content-type": "application/json",
                "risu-auth": await signer.jwt(),
                "x-resource-epoch": epoch,
            },
            body: JSON.stringify({ baseRevision: null, data: { chaId: "c", name: "C", secret: "data" } }),
        });
        expect(put.status).toBe(200);
        const { revision } = (await put.json()) as { revision: string };
        await waitFor(() => a.frames.length > 1 && b.frames.length > 1);
        for (const client of [a, b]) {
            const change = client.frames[1] as Extract<EventFeedFrame, { type: "change" }>;
            expect(change.type).toBe("change");
            expect(change.epoch).toBe(epoch);
            expect(change.changes.resources).toEqual([{ kind: "characters", id: "c", revision }]);
            expect(change.changes.chatOrders).toHaveLength(1);
            expect(JSON.stringify(change)).not.toContain("secret");
        }
        const removed = await request(`/api/resources/characters/c?baseRevision=${encodeURIComponent(revision)}`, {
            method: "DELETE",
            headers: { "x-resource-epoch": epoch },
        });
        expect(removed.status).toBe(200);
        await waitFor(() => a.frames.length > 2 && b.frames.length > 2);
        for (const client of [a, b]) {
            expect(client.frames[2]).toMatchObject({
                type: "change",
                changes: {
                    resources: [{ kind: "characters", id: "c", revision: null }],
                    chatOrders: [{ characterId: "c", revision: null }],
                },
            });
        }
    });

    it("lists every revision behind resource auth, registered before `/api/resources/:kind`", async () => {
        await listen();
        // No token, or the raw password: refused as every resource route refuses them (4xx, no listing).
        expect((await fetch(`${base}/api/resources/revisions`)).status).toBe(400);
        expect(
            (await fetch(`${base}/api/resources/revisions`, { headers: { "risu-auth": "pw" } })).status,
        ).toBeGreaterThanOrEqual(400);
        const epoch = await epochOf();
        const batch = await request("/api/resources/batch", {
            method: "POST",
            headers: { "content-type": "application/json", "x-resource-epoch": epoch },
            body: JSON.stringify({
                ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: null,
                        ops: [{ op: "create", chat: { id: "k", name: "K", message: [] } }],
                    },
                ],
            }),
        });
        expect(batch.status).toBe(200);
        const applied = (await batch.json()) as {
            results: { revision: string }[];
            chats: { revision: string }[];
            chatOrders: { revision: string }[];
        };
        const listing = (await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing;
        expect(listing.epoch).toBe(epoch);
        expect(listing.resources).toContainEqual({
            kind: "characters",
            id: "c",
            revision: applied.results[0].revision,
        });
        expect(listing.resources.some((entry) => entry.kind === "ui")).toBe(true);
        expect(listing.chats).toEqual([{ characterId: "c", id: "k", revision: applied.chats[0].revision }]);
        expect(listing.chatOrders).toEqual([{ characterId: "c", revision: applied.chatOrders[0].revision }]);
        expect(JSON.stringify(listing)).not.toContain('"data"');
    });

    it("keeps a frame-built revision map equal to fresh hello digests through every commit kind and rollback", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        await listen({ resourceKinds: digestKinds });
        const first = (await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing;
        const observer = await open();
        await frameAt(observer, 0);
        const resources = new Map(first.resources.map((row) => [JSON.stringify([row.kind, row.id]), row]));
        const chats = new Map(first.chats.map((row) => [JSON.stringify([row.characterId, row.id]), row]));
        const chatOrders = new Map(first.chatOrders.map((row) => [row.characterId, row]));
        let consumed = 1;
        const advertised = (): ResourceRevisionListing => ({
            epoch: first.epoch,
            resources: [...resources.values()],
            chats: [...chats.values()],
            chatOrders: [...chatOrders.values()],
        });
        async function matches(label: string) {
            await delivered(observer);
            for (const frame of observer.frames.slice(consumed)) {
                if (frame.type !== "change") continue;
                expect(frame.epoch).toBe(first.epoch);
                for (const { kind, id, revision } of frame.changes.resources) {
                    const key = JSON.stringify([kind, id]);
                    if (revision === null) resources.delete(key);
                    else resources.set(key, { kind, id, revision });
                }
                for (const { characterId, id, revision } of frame.changes.chats) {
                    const key = JSON.stringify([characterId, id]);
                    if (revision === null) chats.delete(key);
                    else chats.set(key, { characterId, id, revision });
                }
                for (const { characterId, revision } of frame.changes.chatOrders) {
                    if (revision === null) chatOrders.delete(characterId);
                    else chatOrders.set(characterId, { characterId, revision });
                }
            }
            consumed = observer.frames.length;
            const fresh = await open();
            expect(await frameAt(fresh, 0), label).toMatchObject({
                type: "hello",
                epoch: first.epoch,
                digest: revisionDigest(advertised()),
            });
            fresh.ws.close();
            await fresh.closed;
        }
        const write = async (body: unknown, status = 200) => {
            const response = await request("/api/resources/batch", json(body, { "x-resource-epoch": first.epoch }));
            expect(response.status).toBe(status);
            return response.json();
        };
        const resourceRevision = (kind: string, id: string) => resources.get(JSON.stringify([kind, id]))!.revision;
        const chatRevision = (id: string) => chats.get(JSON.stringify(["c", id]))!.revision;
        const createChat = (id: string) => ({
            characterId: "c",
            chatId: id,
            baseRevision: null,
            ops: [{ op: "create", chat: { id, name: id, message: [] } }],
        });
        await matches("initial listing");
        const putNote = async (baseRevision: string | null, text: string) => {
            expect(
                (
                    await request("/api/resources/notes/n", {
                        ...json({ baseRevision, data: { text } }, { "x-resource-epoch": first.epoch }),
                        method: "PUT",
                    })
                ).status,
            ).toBe(200);
        };
        await putNote(null, "one");
        await matches("resource insert");
        await putNote(resourceRevision("notes", "n"), "two");
        await matches("resource update");
        expect(
            (
                await request(
                    `/api/resources/notes/n?baseRevision=${encodeURIComponent(resourceRevision("notes", "n"))}`,
                    {
                        method: "DELETE",
                        headers: { "x-resource-epoch": first.epoch },
                    },
                )
            ).status,
        ).toBe(200);
        await matches("resource delete");
        await write({
            ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [createChat("k")],
        });
        await matches("character with chat and order");
        await write({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: chatRevision("k"),
                    ops: [{ op: "meta", set: { name: "Renamed" } }],
                },
            ],
        });
        await matches("existing chat ops");
        await write({ chats: [createChat("j")] });
        await matches("chat create");
        await write({
            chatOrders: [{ characterId: "c", baseRevision: chatOrders.get("c")!.revision, ids: ["j", "k"] }],
        });
        await matches("chat order write");
        await write({
            chats: [{ characterId: "c", chatId: "j", baseRevision: chatRevision("j"), ops: [{ op: "delete" }] }],
        });
        await matches("chat delete");
        const beforeRollback = structuredClone(advertised());
        const beforeFrames = observer.frames.length;
        await write(
            {
                ops: [
                    { kind: "notes", id: "rolled-back", baseRevision: null, data: { text: "never committed" } },
                    { kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "Conflict" } },
                ],
            },
            409,
        );
        await matches("rolled-back batch");
        expect(observer.frames).toHaveLength(beforeFrames);
        expect(advertised()).toEqual(beforeRollback);
        await write({
            ops: [{ kind: "characters", id: "c", baseRevision: resourceRevision("characters", "c"), delete: true }],
        });
        await matches("character cascade deletes remaining chat and order");
    });

    it.each(["startup normalization", "restore"])(
        "invalidates a preexisting revision map after %s",
        async (operation) => {
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            await listen({ resourceKinds: digestKinds });
            const epoch = await epochOf();
            expect(
                (
                    await request("/api/resources/notes/n", {
                        ...json({ baseRevision: null, data: { text: "old" } }, { "x-resource-epoch": epoch }),
                        method: "PUT",
                    })
                ).status,
            ).toBe(200);
            const before = (await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing;
            const prior = await open();
            expect(await frameAt(prior, 0)).toMatchObject({ digest: revisionDigest(before) });
            if (operation === "startup normalization") {
                const rootDir = server.rootDir;
                await server.context.dispose();
                node!.closeAllConnections();
                await new Promise<void>((resolve) => node!.close(() => resolve()));
                node = undefined;
                await listen({
                    rootDir,
                    resourceKinds: [
                        ...DEFAULT_RESOURCE_KINDS,
                        {
                            ...noteKind,
                            normalize: (value) => ({ ...(value as object), normalized: true }),
                        },
                    ],
                });
            } else {
                const snapshot = await server.context.snapshots.snapshotNow();
                expect(
                    (
                        await request(`/api/backups/${snapshot.id}/restore`, {
                            method: "POST",
                            headers: { "x-resource-epoch": epoch },
                        })
                    ).status,
                ).toBe(200);
                await delivered(prior);
                expect(prior.frames.some((frame) => frame.type === "epoch" && frame.epoch !== epoch)).toBe(true);
            }
            const after = (await (await request("/api/resources/revisions")).json()) as ResourceRevisionListing;
            if (operation === "startup normalization") {
                expect(after.epoch).toBe(before.epoch);
                expect(after.resources.find((row) => row.kind === "notes")?.revision).not.toBe(
                    before.resources.find((row) => row.kind === "notes")?.revision,
                );
            } else expect(after.epoch).not.toBe(before.epoch);
            const hello = await frameAt(await open(), 0);
            expect(hello).toMatchObject({ type: "hello", epoch: after.epoch, digest: revisionDigest(after) });
            expect(hello.type === "hello" && hello.digest).not.toBe(revisionDigest(before));
        },
    );

    it("closes every socket with 1001 on shutdown and refuses new ones", async () => {
        await listen();
        const a = await open();
        const b = await open();
        await waitFor(() => a.frames.length > 0 && b.frames.length > 0);
        server.context.beginShutdown();
        expect(await a.closed).toBe(1001);
        expect(await b.closed).toBe(1001);
        expect(server.context.eventSockets.size()).toBe(0);
    });
});

describe("createEventSockets", () => {
    const servers: http.Server[] = [];
    afterEach(async () => {
        vi.useRealTimers();
        for (const node of servers.splice(0)) {
            node.closeAllConnections();
            await new Promise((resolve) => node.close(resolve));
        }
    });

    async function host(
        authorize: (token: string | undefined) => Promise<boolean>,
        memoryTasks: () => MemoryTaskEntry[] = () => [],
        digest?: () => string,
        cursor?: () => number,
    ) {
        const feed = createChangeFeed();
        const sockets = createEventSockets({
            feed,
            epoch: () => "E",
            authorize,
            streaming: () => [],
            memoryTasks,
            digest,
            cursor,
        });
        const node = http.createServer((_req, res) => res.end());
        node.on("upgrade", (req, socket, head) => {
            if (!sockets.handleUpgrade(req, socket, head)) {
                socket.destroy();
            }
        });
        servers.push(node);
        await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
        allowListenerOrigin(node);
        const { port } = node.address() as { port: number };
        return { feed, sockets, url: `ws://127.0.0.1:${port}/api/events/ws?risu-auth=t` };
    }

    it("samples hello's digest and cursor before a queued commit can intervene", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        let cursor = 7;
        const rows: ResourceRevisionListing = {
            epoch: "E",
            resources: [{ kind: "notes", id: "r", revision: "E:1:7" }],
            chats: [],
            chatOrders: [],
        };
        const digest = revisionDigest(rows);
        const { sockets, url } = await host(
            async () => true,
            () => [],
            () => {
                queueMicrotask(() => {
                    cursor = 8;
                    rows.resources[0].revision = "E:1:8";
                });
                return revisionDigest(rows);
            },
            () => cursor,
        );
        const client = connect(url);
        try {
            expect(await frameAt(client, 0)).toMatchObject({ type: "hello", digest, cursor: 7 });
            expect(cursor).toBe(8);
        } finally {
            sockets.close();
            await client.closed;
        }
    });

    it("refuses (503) a socket whose authorization finished after `close()`", async () => {
        let finish!: (ok: boolean) => void;
        const { sockets, url } = await host(() => new Promise<boolean>((resolve) => (finish = resolve)));
        const client = connect(url);
        await waitFor(() => finish !== undefined);
        sockets.close();
        finish(true);
        expect(await client.opened).toBe(503);
        expect(sockets.size()).toBe(0);
    });

    it("leaves another path untouched", async () => {
        const { sockets } = await host(async () => true);
        const req = { url: "/api/generations/x/ws", headers: {} } as http.IncomingMessage;
        const socket = { write: vi.fn(), destroy: vi.fn() };
        expect(sockets.handleUpgrade(req, socket as never, Buffer.alloc(0))).toBe(false);
        expect(socket.write).not.toHaveBeenCalled();
        expect(socket.destroy).not.toHaveBeenCalled();
    });

    it("terminates a socket whose `send` throws and still delivers the frame to the sockets after it", async () => {
        const { feed, sockets, url } = await host(async () => true);
        const clients = [connect(url), connect(url), connect(url)];
        for (const client of clients) {
            expect(await client.opened).toBe("open");
        }
        await waitFor(() => clients.every((client) => client.frames.length > 0));
        // Server sockets share the client class: the fan-out's first `send` (the first socket to
        // connect) throws, the others go through.
        const send = vi.spyOn(WsClient.prototype, "send").mockImplementationOnce(() => {
            throw new Error("send failed");
        });
        try {
            expect(() => feed.publish({ type: "epoch", epoch: "F" })).not.toThrow();
        } finally {
            send.mockRestore();
        }
        const [failed, ...others] = clients;
        await waitFor(() => others.every((client) => client.frames.length > 1));
        for (const client of others) {
            expect(client.frames[1]).toEqual({ type: "epoch", epoch: "F" });
        }
        expect(await failed.closed).toBe(1006);
        expect(failed.frames).toEqual([{ type: "hello", epoch: "E", streaming: [], memoryTasks: [] }]);
        await waitFor(() => sockets.size() === 2);
        for (const client of others) {
            client.ws.terminate();
        }
        sockets.close();
    });

    it("admits non-hello frames by UTF-8 bytes, including exactly 4 MiB, without queuing rejected frames", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        const frames: EventFeedFrame[] = [
            {
                type: "change",
                epoch: "E",
                changes: {
                    resources: [
                        {
                            kind: "notes",
                            id: "n",
                            revision: "r2",
                            patch: { baseRevision: "r1", set: { text: "€한😀" }, remove: [] },
                        },
                    ],
                    chats: [],
                    chatOrders: [],
                },
            },
            {
                type: "memoryTask",
                epoch: "E",
                characterId: "한",
                chatId: "k",
                status: { taskId: "t", state: "queued", done: 0, total: 0 },
            },
            { type: "epoch", epoch: "새 epoch" },
            { type: "ping", ts: 15_000 },
        ];
        for (const frame of frames) {
            vi.setSystemTime(0);
            const { feed, sockets, url } = await host(async () => true);
            const clients: Client[] = [];
            // Connect in order so the rejected socket is first in the fan-out.
            for (let i = 0; i < 3; i++) {
                const client = connect(url);
                clients.push(client);
                await frameAt(client, 0);
            }
            const text = JSON.stringify(frame);
            const bytes = Buffer.byteLength(text);
            const over = admissionBytes - bytes + 1;
            if (frame.type !== "ping") {
                expect(bytes).toBeGreaterThan(text.length);
                expect(over + text.length).toBeLessThanOrEqual(admissionBytes);
            }
            // ws counts buffered strings in UTF-16 code units. Control its getter instead of
            // relying on real buffering; both the server and clients use this class.
            const buffered = vi
                .spyOn(WsClient.prototype, "bufferedAmount", "get")
                .mockReturnValueOnce(over)
                .mockReturnValueOnce(admissionBytes - bytes)
                .mockReturnValue(0);
            const send = vi.spyOn(WsClient.prototype, "send");
            const terminate = vi.spyOn(WsClient.prototype, "terminate");
            try {
                if (frame.type === "ping") vi.advanceTimersByTime(15_000);
                else if (frame.type !== "hello") feed.publish(frame);
                expect(
                    send.mock.calls.map(([data]) => data),
                    frame.type,
                ).toEqual([text, text]);
                expect(terminate, frame.type).toHaveBeenCalledTimes(1);
                expect(terminate.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
                expect(await clients[0].closed).toBe(1006);
                expect(clients[0].frames).toEqual([{ type: "hello", epoch: "E", streaming: [], memoryTasks: [] }]);
                for (const client of clients.slice(1)) {
                    expect(await frameAt(client, 1)).toEqual(frame);
                    expect(client.ws.readyState).toBe(WsClient.OPEN);
                }
            } finally {
                buffered.mockRestore();
                send.mockRestore();
                terminate.mockRestore();
                for (const client of clients) client.ws.terminate();
                sockets.close();
            }
        }
    });

    it("admits hello on bufferedAmount alone even when its own bytes would exceed 4 MiB", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const { sockets, url } = await host(async () => true);
        const buffered = vi.spyOn(WsClient.prototype, "bufferedAmount", "get").mockReturnValue(admissionBytes);
        const send = vi.spyOn(WsClient.prototype, "send");
        const clients: Client[] = [];
        try {
            const admitted = connect(url);
            clients.push(admitted);
            const hello = { type: "hello", epoch: "E", streaming: [], memoryTasks: [] };
            expect(admissionBytes + Buffer.byteLength(JSON.stringify(hello))).toBeGreaterThan(admissionBytes);
            expect(await frameAt(admitted, 0)).toEqual(hello);
            expect(admitted.ws.readyState).toBe(WsClient.OPEN);

            buffered.mockReturnValue(admissionBytes + 1);
            send.mockClear();
            const rejected = connect(url);
            clients.push(rejected);
            expect(await rejected.closed).toBe(1006);
            expect(send).not.toHaveBeenCalled();
            expect(rejected.frames).toEqual([]);
        } finally {
            buffered.mockRestore();
            send.mockRestore();
            for (const client of clients) client.ws.terminate();
            sockets.close();
        }
    });

    it("pings every 15 s, publishes `epoch` frames, and forgets a closed socket and its timer", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const { feed, sockets, url } = await host(async () => true);
        const client = connect(url);
        expect(await client.opened).toBe("open");
        await waitFor(() => client.frames.length > 0);
        expect(client.frames[0]).toEqual({ type: "hello", epoch: "E", streaming: [], memoryTasks: [] });
        vi.advanceTimersByTime(15_000);
        await waitFor(() => client.frames.length > 1);
        expect(client.frames[1]).toMatchObject({ type: "ping", ts: expect.any(Number) });
        feed.publish({ type: "epoch", epoch: "F" });
        await waitFor(() => client.frames.length > 2);
        expect(client.frames[2]).toEqual({ type: "epoch", epoch: "F" });
        client.ws.close();
        await client.closed;
        await waitFor(() => sockets.size() === 0);
        expect(vi.getTimerCount()).toBe(0);
        sockets.close();
    });

    it("a frame published while another is being sent reaches every socket after it, as its own `memoryTask` frame", async () => {
        const { feed, sockets, url } = await host(async () => true);
        const clients = [connect(url), connect(url)];
        for (const client of clients) {
            expect(await client.opened).toBe("open");
        }
        await waitFor(() => clients.every((client) => client.frames.length > 0));
        const nested = {
            type: "memoryTask",
            epoch: "E",
            characterId: "c",
            chatId: "k",
            status: { taskId: "t1", state: "queued", done: 0, total: 0 },
        } as const;
        // Server sockets share the client class: the fan-out's first `send` (the first socket) publishes
        // another event before the first frame reached the second socket.
        const original = WsClient.prototype.send;
        const send = vi.spyOn(WsClient.prototype, "send").mockImplementationOnce(function (this: WsClient, ...args) {
            feed.publish(nested);
            return (original as (...a: unknown[]) => void).apply(this, args);
        });
        try {
            feed.publish({ type: "epoch", epoch: "F" });
        } finally {
            send.mockRestore();
        }
        await waitFor(() => clients.every((client) => client.frames.length > 2));
        for (const client of clients) {
            expect(client.frames.slice(1)).toEqual([{ type: "epoch", epoch: "F" }, nested]);
        }
        for (const client of clients) {
            client.ws.terminate();
        }
        sockets.close();
    });

    it("omits a failed digest while keeping the hello snapshots and the socket usable", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const status: MemoryTaskEntry = {
            characterId: "c",
            chatId: "k",
            status: { taskId: "t", state: "running", done: 0, total: 1 },
        };
        const { feed, sockets, url } = await host(
            async () => true,
            () => [status],
            () => {
                throw new Error("digest failed");
            },
        );
        const client = connect(url);
        try {
            expect(await frameAt(client, 0)).toEqual({
                type: "hello",
                epoch: "E",
                streaming: [],
                memoryTasks: [status],
            });
            expect(client.ws.readyState).toBe(WsClient.OPEN);
            feed.publish({ type: "epoch", epoch: "F" });
            expect(await frameAt(client, 1)).toEqual({ type: "epoch", epoch: "F" });
        } finally {
            client.ws.terminate();
            sockets.close();
            logged.mockRestore();
        }
    });

    it("closes a socket with 1011 and no frame when the memory task snapshot throws, logging no detail", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { sockets, url } = await host(
                async () => true,
                () => {
                    throw new Error("registry detail");
                },
            );
            const client = connect(url);
            expect(await client.opened).toBe("open");
            expect(await client.closed).toBe(1011);
            expect(client.frames).toEqual([]);
            expect(sockets.size()).toBe(0);
            expect(error).toHaveBeenCalledTimes(1);
            expect(error.mock.calls[0].join(" ")).not.toContain("registry detail");
            sockets.close();
        } finally {
            error.mockRestore();
        }
    });
});

describe("revisionDigest", () => {
    const rows: ResourceRevisionListing = {
        epoch: "epoch",
        resources: [
            { kind: "c", id: "k", revision: "r" },
            { kind: "ui", id: "main", revision: "s" },
        ],
        chats: [
            { characterId: "c", id: "k", revision: "r" },
            { characterId: "d", id: "j", revision: "s" },
        ],
        chatOrders: [
            { characterId: "c", revision: "r" },
            { characterId: "d", revision: "s" },
        ],
    };
    it("is order independent and has exactly 32 lowercase hexadecimal digits", () => {
        const digest = revisionDigest(rows);
        expect(digest).toMatch(/^[0-9a-f]{32}$/);
        expect(
            revisionDigest({
                ...rows,
                resources: [...rows.resources].reverse(),
                chats: [...rows.chats].reverse(),
                chatOrders: [...rows.chatOrders].reverse(),
            }),
        ).toBe(digest);
        expect(revisionDigest({ epoch: "", resources: [], chats: [], chatOrders: [] })).toMatch(/^[0-9a-f]{32}$/);
    });
    it.each<[string, (listing: ResourceRevisionListing) => void]>([
        [
            "epoch",
            (value) => {
                value.epoch = "other";
            },
        ],
        [
            "resource membership",
            (value) => {
                value.resources.pop();
            },
        ],
        [
            "resource kind",
            (value) => {
                value.resources[0].kind = "other";
            },
        ],
        [
            "resource id",
            (value) => {
                value.resources[0].id = "other";
            },
        ],
        [
            "resource revision",
            (value) => {
                value.resources[0].revision = "other";
            },
        ],
        [
            "chat membership",
            (value) => {
                value.chats.pop();
            },
        ],
        [
            "chat character id",
            (value) => {
                value.chats[0].characterId = "other";
            },
        ],
        [
            "chat id",
            (value) => {
                value.chats[0].id = "other";
            },
        ],
        [
            "chat revision",
            (value) => {
                value.chats[0].revision = "other";
            },
        ],
        [
            "order membership",
            (value) => {
                value.chatOrders.pop();
            },
        ],
        [
            "order character id",
            (value) => {
                value.chatOrders[0].characterId = "other";
            },
        ],
        [
            "order revision",
            (value) => {
                value.chatOrders[0].revision = "other";
            },
        ],
        [
            "row category",
            (value) => {
                const resource = value.resources.pop()!;
                value.chats.push({ characterId: resource.kind, id: resource.id, revision: resource.revision });
            },
        ],
    ])("changes when only %s changes", (_label, change) => {
        const changed = structuredClone(rows);
        change(changed);
        expect(revisionDigest(changed)).not.toBe(revisionDigest(rows));
    });
});
