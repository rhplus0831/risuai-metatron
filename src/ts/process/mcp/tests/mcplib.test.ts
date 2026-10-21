import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tab's remote MCP client (`src/ts/process/mcp/mcplib.ts` `MCPClient`) over a fake
// `fetchNative` (no network). Its event stream framed by `shared/mcp/sse.ts` (CRLF, CR, and
// space-less events, an endpoint, a ping answered, several answers in one chunk, an answer split
// inside its CRLF and inside a UTF-8 character, comments and an unfinished tail ignored); the
// session id of an `initialize` answer sent as an event stream or as JSON, carried by the later
// requests and not replaced by a later answer; refresh rotation (the new token registered with the
// stored client data, used by a recreated client that registers the next; nothing registered for a
// missing, empty, or non-string token, or for an answer without a usable access token); and
// retirement (`destroy()`: no request, refresh, discovery, or stream reader started afterwards,
// late answers refused, a cached list refused) against the session reset after a 401 that keeps the
// client usable. Not asserted: the cleanup of a stream that ends without its answer (a recorded
// hazard, `plugins-mcp.md`). The framer alone: `server/src/tests/mcpSse.test.ts`.

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Reply = {
    status: number;
    statusText: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
    json(): Promise<any>;
};

const { calls, server } = vi.hoisted(() => ({
    calls: [] as { url: string; method: string; headers: Record<string, string>; body: any }[],
    server: { handle: null as null | ((call: Call) => Promise<unknown> | unknown) },
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    fetchNative: vi.fn(
        async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
            let body: any = init?.body ?? null;
            if (typeof body === "string") {
                try {
                    body = JSON.parse(body);
                } catch {
                    body = Object.fromEntries(new URLSearchParams(body));
                }
            }
            const call = { url, method: init?.method ?? "GET", headers: { ...(init?.headers ?? {}) }, body };
            calls.push(call);
            if (!server.handle) {
                throw new Error(`unexpected fetchNative(${url})`);
            }
            return await server.handle(call);
        },
    ),
    openURL: vi.fn(),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

const enc = new TextEncoder();

/** A stream of `chunks` that then closes, or stays open (`open`); `cancelled` counts its cancellations. */
function streamOf(chunks: (string | Uint8Array)[], options: { open?: boolean } = {}) {
    const state = { cancelled: 0, controller: null as null | ReadableStreamDefaultController<Uint8Array> };
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            state.controller = controller;
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
            }
            if (!options.open) {
                controller.close();
            }
        },
        cancel() {
            state.cancelled++;
        },
    });
    return { stream, state };
}

function reply(
    options: {
        status?: number;
        headers?: Record<string, string>;
        json?: unknown | (() => Promise<unknown>);
        stream?: ReadableStream<Uint8Array>;
    } = {},
): Reply {
    const headers = new Headers({
        ...(options.json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.stream ? { "Content-Type": "text/event-stream" } : {}),
        ...options.headers,
    });
    const body = options.stream ?? streamOf([]).stream;
    return {
        status: options.status ?? 200,
        statusText: "",
        headers,
        body,
        json: async () =>
            typeof options.json === "function" ? await (options.json as () => Promise<unknown>)() : options.json,
    };
}
const rpcJson = (call: Call, result: unknown, headers: Record<string, string> = {}) =>
    reply({ json: { jsonrpc: "2.0", id: call.body.id, result }, headers });
const sseAnswer = (call: Call, result: unknown, headers: Record<string, string> = {}) =>
    reply({
        stream: streamOf([
            `event:message\r\ndata:${JSON.stringify({ jsonrpc: "2.0", id: call.body.id, result })}\r\n\r\n`,
        ]).stream,
        headers,
    });
const INFO = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } };
const TOOLS = { tools: [{ name: "echo", inputSchema: {} }] };

/** A deferred value: `promise` settles when `resolve` is called. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
const until = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
    expect(condition()).toBe(true);
};
const methodsOf = () => calls.map((call) => call.body?.method ?? `${call.method} ${call.url}`);

async function newClient() {
    const { MCPClient } = await import("../mcplib");
    return new MCPClient("http://mcp.test/mcp");
}
const reset = (client: object) => (client as { reset(): void }).reset();

beforeEach(() => {
    calls.length = 0;
    server.handle = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("MCPClient event streams", () => {
    it("frames CRLF, CR, and space-less events and dispatches them in order: an endpoint, a ping answered, two answers of one chunk, an answer split inside its CRLF and its UTF-8; comments and an unfinished tail are ignored", async () => {
        const client = await newClient();
        server.handle = () => reply({ status: 202 });
        const dispatched: unknown[] = [];
        const listener = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail.mcpClientObjectId === client.mcpClientObjectId) {
                dispatched.push(detail.data);
            }
        };
        document.addEventListener("mcp-sse", listener);
        const split = enc.encode('data:{"jsonrpc":"2.0","id":3,"result":"\u{1F600}"}\r\n\r\n');
        const emoji = split.indexOf(0xf0);
        const crlf = split.indexOf(13);
        const { stream } = streamOf([
            ": comment\r\nevent:endpoint\r\ndata:/messages\r\n\r\n",
            'data:{"jsonrpc":"2.0","id":"p1","method":"ping"}\r\r',
            'data: {"jsonrpc":"2.0","id":1,"result":"a"}\n\ndata:{"jsonrpc":"2.0",\r\ndata:"id":2,"result":"b"}\r\n\r\n',
            split.subarray(0, emoji + 2),
            split.subarray(emoji + 2, crlf + 1),
            new Uint8Array(0),
            split.subarray(crlf + 1),
            'data:{"jsonrpc":"2.0","id":"tail"}',
        ]);
        await client.connectSSE(stream);
        document.removeEventListener("mcp-sse", listener);
        expect(dispatched).toEqual([
            { jsonrpc: "2.0", id: "connected", result: { endpoint: "/messages" } },
            { jsonrpc: "2.0", id: 1, result: "a" },
            { jsonrpc: "2.0", id: 2, result: "b" },
            { jsonrpc: "2.0", id: 3, result: "\u{1F600}" },
        ]);
        // The ping was answered, before the answers after it were dispatched.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            url: "http://mcp.test/mcp",
            method: "POST",
            body: { jsonrpc: "2.0", id: "p1", result: {} },
        });
    });

    it("takes the session id of an initialize answer sent as an event stream and sends it on every later request; a later answer's id does not replace it", async () => {
        const client = await newClient();
        server.handle = (call) => {
            switch (call.body?.method) {
                case "initialize":
                    return sseAnswer(call, INFO, { "Mcp-Session-Id": "s-1" });
                case "tools/list":
                    return sseAnswer(call, TOOLS, { "Mcp-Session-Id": "other" });
                case "tools/call":
                    return rpcJson(call, { content: [{ type: "text", text: "ok" }] }, { "Mcp-Session-Id": "other2" });
                default:
                    return reply({ status: 202 });
            }
        };
        expect((await client.checkHandshake()).serverInfo.name).toBe("mock");
        expect(client.sessionId).toBe("s-1");
        expect((await client.getToolList()).map((tool) => tool.name)).toEqual(["echo"]);
        expect(await client.callTool("echo", {})).toEqual([{ type: "text", text: "ok" }]);
        expect(methodsOf()).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
        expect(calls[0].headers["Mcp-Session-Id"]).toBeUndefined();
        expect(calls.slice(1).map((call) => call.headers["Mcp-Session-Id"])).toEqual(["s-1", "s-1", "s-1"]);
        expect(client.sessionId).toBe("s-1");
    });

    it("takes the session id of a JSON initialize answer the same way", async () => {
        const client = await newClient();
        server.handle = (call) =>
            call.body?.method === "initialize"
                ? rpcJson(call, INFO, { "Mcp-Session-Id": "j-1" })
                : call.body?.id === undefined
                  ? reply({ status: 202 })
                  : rpcJson(call, TOOLS, { "Mcp-Session-Id": "other" });
        await client.checkHandshake();
        await client.getToolList();
        expect(calls.slice(1).map((call) => call.headers["Mcp-Session-Id"])).toEqual(["j-1", "j-1"]);
        expect(client.sessionId).toBe("j-1");
    });
});

describe("MCPClient refresh rotation", () => {
    type Stored = { clientId: string; clientSecret: string; refreshToken: string; tokenUrl: string };
    const first: Stored = { clientId: "c1", clientSecret: "s1", refreshToken: "r1", tokenUrl: "http://mcp.test/token" };

    /** A server whose token endpoint rotates (each grant spends its token) and whose MCP needs the issued token. */
    function rotatingServer() {
        const auth = { current: "r1", issued: 0, valid: null as string | null, grants: [] as any[] };
        server.handle = (call) => {
            if (call.url === "http://mcp.test/token") {
                auth.grants.push(call.body);
                if (call.body.refresh_token !== auth.current) {
                    return reply({ status: 400, json: { error: "invalid_grant" } });
                }
                auth.issued++;
                auth.valid = `a${auth.issued}`;
                auth.current = `r${auth.issued + 1}`;
                return reply({ json: { access_token: auth.valid, refresh_token: auth.current } });
            }
            if (call.url.includes("/.well-known/")) {
                throw new Error("no full login here");
            }
            if (!auth.valid || call.headers.Authorization !== `Bearer ${auth.valid}`) {
                return reply({ status: 401 });
            }
            if (call.body?.id === undefined) {
                return reply({ status: 202 });
            }
            return rpcJson(call, call.body.method === "initialize" ? INFO : TOOLS);
        };
        return auth;
    }

    it("registers a rotated refresh token with the stored client data; a recreated client refreshes with it and registers the next", async () => {
        const auth = rotatingServer();
        const store = { record: { ...first } as Stored };
        const wire = async () => {
            const client = await newClient();
            client.getRefreshToken = async () => store.record;
            client.registerRefreshToken = (arg) => {
                store.record = { ...arg };
            };
            return client;
        };

        const one = await wire();
        await one.checkHandshake();
        expect(one.accessToken).toBe("a1");
        expect(store.record).toEqual({ ...first, refreshToken: "r2" });

        // A new client (a reload), no access token: the first 401 refreshes with the stored token.
        auth.valid = null;
        const two = await wire();
        expect((await two.getToolList()).map((tool) => tool.name)).toEqual(["echo"]);
        expect(two.accessToken).toBe("a2");
        expect(store.record).toEqual({ ...first, refreshToken: "r3" });
        expect(auth.grants).toEqual([
            { grant_type: "refresh_token", refresh_token: "r1", client_id: "c1", client_secret: "s1" },
            { grant_type: "refresh_token", refresh_token: "r2", client_id: "c1", client_secret: "s1" },
        ]);
    });

    it("registers nothing for a missing, empty, or non-string rotated token (the stored one stays)", async () => {
        for (const rotated of [undefined, "", 42, null]) {
            const client = await newClient();
            client.getRefreshToken = async () => first;
            const register = vi.fn();
            client.registerRefreshToken = register;
            server.handle = () => reply({ json: { access_token: "a1", refresh_token: rotated } });
            await client.oauthLogin();
            expect(client.accessToken).toBe("a1");
            expect(register).not.toHaveBeenCalled();
        }
    });

    it("registers no rotated token from an answer without a usable access token or with a failed status: the login goes on to discovery", async () => {
        const answers = [
            () => reply({ json: { refresh_token: "r2" } }),
            () => reply({ json: { access_token: "", refresh_token: "r2" } }),
            () => reply({ json: { access_token: 7, refresh_token: "r2" } }),
            () => reply({ status: 400, json: { access_token: "a1", refresh_token: "r2" } }),
        ];
        for (const answer of answers) {
            calls.length = 0;
            const client = await newClient();
            client.getRefreshToken = async () => first;
            const register = vi.fn();
            client.registerRefreshToken = register;
            server.handle = (call) => {
                if (call.url === first.tokenUrl) {
                    return answer();
                }
                throw new Error("discovery reached");
            };
            await expect(client.oauthLogin()).rejects.toThrow("discovery reached");
            expect(register).not.toHaveBeenCalled();
            expect(client.accessToken).toBeNull();
            expect(calls.map((call) => call.url)).toEqual([
                first.tokenUrl,
                "http://mcp.test/.well-known/oauth-authorization-server",
            ]);
        }
    });
});

describe("MCPClient retirement (destroy) against the session reset", () => {
    const stored = { clientId: "c1", clientSecret: "s1", refreshToken: "r1", tokenUrl: "http://mcp.test/token" };

    it("refuses a refresh answer that arrives after destroy(): nothing registered, no access token; across a session reset the same answer is taken", async () => {
        for (const end of ["destroy", "reset"] as const) {
            calls.length = 0;
            const client = await newClient();
            client.getRefreshToken = async () => stored;
            const register = vi.fn();
            client.registerRefreshToken = register;
            const answer = deferred<Reply>();
            server.handle = () => answer.promise;
            const login = client.oauthLogin();
            await until(() => calls.length === 1);
            if (end === "destroy") {
                client.destroy();
            } else {
                reset(client);
            }
            answer.resolve(reply({ json: { access_token: "late", refresh_token: "r2" } }));
            if (end === "destroy") {
                await expect(login).rejects.toThrow("The MCP client was closed");
                expect(register).not.toHaveBeenCalled();
                expect(client.accessToken).toBeNull();
            } else {
                await login;
                expect(register).toHaveBeenCalledWith({ ...stored, refreshToken: "r2" });
                expect(client.accessToken).toBe("late");
            }
        }
    });

    it("starts no refresh after destroy() while the stored token is read, and no discovery after destroy() while a failed refresh is out", async () => {
        const reading = await newClient();
        const record = deferred<typeof stored>();
        reading.getRefreshToken = () => record.promise;
        server.handle = () => reply({ json: { access_token: "a" } });
        const first = reading.oauthLogin();
        reading.destroy();
        record.resolve(stored);
        await expect(first).rejects.toThrow("The MCP client was closed");
        expect(calls).toEqual([]);

        const failing = await newClient();
        failing.getRefreshToken = async () => stored;
        const answer = deferred<Reply>();
        server.handle = () => answer.promise;
        const second = failing.oauthLogin();
        await until(() => calls.length === 1);
        failing.destroy();
        answer.resolve(reply({ status: 400, json: { error: "invalid_grant" } }));
        await expect(second).rejects.toThrow("The MCP client was closed");
        expect(calls.map((call) => call.url)).toEqual([stored.tokenUrl]);
    });

    it("refuses a late initialize answer: a 401 starts no refresh, and a successful one publishes no session or initialized state and sends no notification", async () => {
        for (const late of ["unauthorized", "ok"] as const) {
            calls.length = 0;
            const client = await newClient();
            client.getRefreshToken = async () => stored;
            const answer = deferred<Reply>();
            server.handle = () => answer.promise;
            const handshake = client.checkHandshake();
            await until(() => calls.length === 1);
            client.destroy();
            answer.resolve(
                late === "unauthorized"
                    ? reply({ status: 401 })
                    : reply({
                          json: { jsonrpc: "2.0", id: calls[0].body.id, result: INFO },
                          headers: { "Mcp-Session-Id": "late" },
                      }),
            );
            await expect(handshake).rejects.toThrow("The MCP client was closed");
            expect(methodsOf()).toEqual(["initialize"]);
            expect(client.initialized).toBe(false);
            expect(client.sessionId).toBeNull();
        }
    });

    it("cancels a legacy session stream that arrives after destroy() and reads nothing from it; connectSSE on a retired client cancels its stream", async () => {
        const client = await newClient();
        const connection = deferred<Reply>();
        server.handle = (call) => (call.method === "GET" ? connection.promise : reply({ status: 404 }));
        const handshake = client.checkHandshake();
        await until(() => calls.length === 2);
        expect(calls[1]).toMatchObject({ method: "GET", url: "http://mcp.test/mcp" });
        client.destroy();
        const session = streamOf(["event: endpoint\ndata: /messages\n\n"], { open: true });
        connection.resolve(reply({ stream: session.stream }));
        await expect(handshake).rejects.toThrow("The MCP client was closed");
        expect(session.state.cancelled).toBe(1);
        expect(session.stream.locked).toBe(false);
        expect(client.sses).toEqual([]);
        expect(client.sseEndpoint).toBeNull();

        const later = streamOf([], { open: true });
        await client.connectSSE(later.stream);
        expect(later.state.cancelled).toBe(1);
        expect(later.stream.locked).toBe(false);
        expect(client.sses).toEqual([]);
    });

    it("refuses a tool list whose body completes after destroy(), caching nothing; refuses a cached list after destroy(), while a live client answers it from the cache", async () => {
        const live = async () => {
            const client = await newClient();
            client.initialized = true;
            client.serverInfo = INFO;
            return client;
        };
        const late = await live();
        const body = deferred<unknown>();
        server.handle = () => reply({ json: () => body.promise });
        const list = late.getToolList();
        await until(() => calls.length === 1);
        late.destroy();
        body.resolve({ jsonrpc: "2.0", id: calls[0].body.id, result: TOOLS });
        await expect(list).rejects.toThrow("The MCP client was closed");
        expect(late.cached.tools).toEqual([]);

        calls.length = 0;
        const cached = await live();
        server.handle = (call) => rpcJson(call, TOOLS);
        expect((await cached.getToolList()).map((tool) => tool.name)).toEqual(["echo"]);
        expect((await cached.getToolList()).map((tool) => tool.name)).toEqual(["echo"]);
        expect(calls).toHaveLength(1);
        const afterRetire = cached.getToolList();
        cached.destroy();
        await expect(afterRetire).rejects.toThrow("The MCP client was closed");
        await expect(cached.getToolList()).rejects.toThrow("The MCP client was closed");
        await expect(cached.callTool("echo", {})).rejects.toThrow("The MCP client was closed");
        expect(calls).toHaveLength(1);
    });

    it("resets the session on a 401 with a token and repeats the request once without it; the client stays usable", async () => {
        const client = await newClient();
        client.accessToken = "old";
        client.sessionId = "s-old";
        server.handle = (call) =>
            call.headers.Authorization ? reply({ status: 401 }) : rpcJson(call, { ok: call.body.method });
        expect((await client.request("ping")).rpc.result).toEqual({ ok: "ping" });
        expect(
            calls.map((call) => [call.headers.Authorization ?? null, call.headers["Mcp-Session-Id"] ?? null]),
        ).toEqual([
            ["Bearer old", "s-old"],
            [null, null],
        ]);
        expect(client.accessToken).toBeNull();
        expect((await client.request("tools/list")).rpc.result).toEqual({ ok: "tools/list" });
    });
});
