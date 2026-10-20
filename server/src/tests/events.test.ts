// @vitest-environment node
import http from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { EventFeedFrame } from "../../../shared/events.ts";
import type { ResourceRevisionListing } from "../../../shared/resources.ts";
import { createChangeFeed } from "../data/changeFeed.ts";
import { createEventSockets } from "../routes/events.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, waitFor } from "./testSupport.ts";

// The live-update socket (`/api/events/ws`, `server/src/routes/events.ts`) on a real listening
// server: JWT-only authentication, `hello` with the epoch, every committed change delivered to every
// socket, close (1001) on shutdown and refusal afterwards, the heartbeat, and the revision listing
// route the client reconciles against after every `hello`. The publisher is in `changeFeed.test.ts`.

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

    async function listen() {
        server = createTestServer({ password: "pw" });
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

    it("admits a JWT in the query or the header and sends `hello` with the epoch", async () => {
        await listen();
        const epoch = await epochOf();
        const byQuery = await open();
        expect(await byQuery.opened).toBe("open");
        await waitFor(() => byQuery.frames.length > 0);
        expect(byQuery.frames[0]).toEqual({ type: "hello", epoch });
        const byHeader = await open("", { "risu-auth": await signer.jwt() });
        expect(await byHeader.opened).toBe("open");
        await waitFor(() => byHeader.frames.length > 0);
        expect(byHeader.frames[0]).toEqual({ type: "hello", epoch });
        expect(server.context.eventSockets.size()).toBe(2);
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

    async function host(authorize: (token: string | undefined) => Promise<boolean>) {
        const feed = createChangeFeed();
        const sockets = createEventSockets({ feed, epoch: () => "E", authorize });
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
        expect(failed.frames).toEqual([{ type: "hello", epoch: "E" }]);
        await waitFor(() => sockets.size() === 2);
        for (const client of others) {
            client.ws.terminate();
        }
        sockets.close();
    });

    it("pings every 15 s, publishes `epoch` frames, and forgets a closed socket and its timer", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const { feed, sockets, url } = await host(async () => true);
        const client = connect(url);
        expect(await client.opened).toBe("open");
        await waitFor(() => client.frames.length > 0);
        expect(client.frames[0]).toEqual({ type: "hello", epoch: "E" });
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
});
