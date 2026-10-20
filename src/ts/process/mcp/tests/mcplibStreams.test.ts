import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Goal E: public MCP requests over controllable streams, with no network or timer polling.

type Call = { url: string; method: string; headers: Record<string, string>; body: any; signal?: AbortSignal };
type Reply = {
    status: number;
    statusText: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
    json(): Promise<any>;
};

const { calls, server } = vi.hoisted(() => ({
    calls: [] as { url: string; method: string; headers: Record<string, string>; body: any; signal?: AbortSignal }[],
    server: { handle: null as null | ((call: Call) => Promise<unknown> | unknown) },
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    fetchNative: vi.fn(
        async (
            url: string,
            init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
        ) => {
            let body: any = init?.body ?? null;
            if (typeof body === "string") {
                try {
                    body = JSON.parse(body);
                } catch {
                    body = Object.fromEntries(new URLSearchParams(body));
                }
            }
            const call = {
                url,
                method: init?.method ?? "GET",
                headers: { ...(init?.headers ?? {}) },
                body,
                signal: init?.signal,
            };
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
import { MCPClient, type RPCRequestResult } from "../mcplib";
const clients: MCPClient[] = [];
function newClient(token?: string) {
    const client = new MCPClient("http://mcp.test/mcp", { accessToken: token });
    clients.push(client);
    return client;
}
const event = (id: string | number, result: unknown) => `data:${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
const send = (session: ReturnType<typeof streamOf>, call: Call, result: unknown) =>
    session.state.controller!.enqueue(enc.encode(event(call.body.id, result)));

// All scheduling here consists only of local promises. A bounded microtask checkpoint makes a
// stranded request fail immediately and deterministically, rather than relying on a wall clock.
async function until(predicate: () => boolean, label: string) {
    for (let i = 0; i < 200 && !predicate(); i++) await Promise.resolve();
    expect(predicate(), label).toBe(true);
}
function observe<T>(promise: Promise<T> | T) {
    const state = {
        status: "pending" as "pending" | "fulfilled" | "rejected",
        value: undefined as T | undefined,
        error: undefined as unknown,
    };
    void Promise.resolve(promise).then(
        (value) => {
            state.status = "fulfilled";
            state.value = value;
        },
        (error) => {
            state.status = "rejected";
            state.error = error;
        },
    );
    return state;
}
async function result<T>(state: ReturnType<typeof observe<T>>) {
    await until(() => state.status !== "pending", "request must settle after the controlled stream transition");
    expect(state.status).toBe("fulfilled");
    return state.value!;
}
async function rejected(state: ReturnType<typeof observe>, message?: string) {
    await until(() => state.status !== "pending", "request must reject after the controlled stream transition");
    expect(state.status).toBe("rejected");
    if (message) expect(String(state.error)).toContain(message);
}
async function clean(client: MCPClient, streams: ReturnType<typeof streamOf>[]) {
    await until(() => streams.every(({ stream }) => !stream.locked), "all stream readers must release their locks");
    expect(client.sses).toEqual([]);
}
function noListeners() {
    const added = vi
        .mocked(document.addEventListener)
        .mock.calls.filter(([type]) => type === "mcp-sse")
        .map(([, fn]) => fn);
    const removed = vi
        .mocked(document.removeEventListener)
        .mock.calls.filter(([type]) => type === "mcp-sse")
        .map(([, fn]) => fn);
    expect(added.length).toBeGreaterThan(0);
    expect(removed).toEqual(expect.arrayContaining(added));
}
const rpcError = (answer: RPCRequestResult, message: string) =>
    expect(answer.rpc.error).toEqual({ code: -32000, message });

beforeEach(() => {
    calls.length = 0;
    server.handle = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(document, "addEventListener");
    vi.spyOn(document, "removeEventListener");
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    // Also remove listeners when a deliberate production mutation strands them.
    for (const [type, listener] of vi.mocked(document.addEventListener).mock.calls) {
        if (type === "mcp-sse") document.removeEventListener(type, listener);
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    vi.restoreAllMocks();
});

describe("MCP streamable response lifetime", () => {
    it("releases completed streams and cancels answered open streams through handshake, listing and repeated tool calls", async () => {
        const client = newClient();
        const streams: ReturnType<typeof streamOf>[] = [];
        const open: boolean[] = [];
        server.handle = (call) => {
            if (call.body.id === undefined) return reply({ status: 202 });
            const value =
                call.body.method === "initialize"
                    ? INFO
                    : call.body.method === "tools/list"
                      ? TOOLS
                      : { content: [{ type: "text", text: "ok" }] };
            const staysOpen = streams.length % 2 === 0;
            const stream = streamOf([event(call.body.id, value)], { open: staysOpen });
            streams.push(stream);
            open.push(staysOpen);
            return reply({ stream: stream.stream });
        };
        expect(await result(observe(client.checkHandshake()))).toEqual(INFO);
        expect((await result(observe(client.getToolList()))).map((tool) => tool.name)).toEqual(["echo"]);
        for (let i = 0; i < 20; i++) {
            expect(await result(observe(client.callTool("echo", {})))).toEqual([{ type: "text", text: "ok" }]);
            await clean(client, streams);
        }
        expect(streams).toHaveLength(22);
        streams.forEach((stream, i) => expect(stream.state.cancelled).toBe(open[i] ? 1 : 0));
        noListeners();
    });

    it("EOF settles only its unanswered request and leaves a concurrent response live", async () => {
        const client = newClient();
        const one = streamOf([":heartbeat\n\n", event("unrelated", {})], { open: true });
        const two = streamOf([], { open: true });
        server.handle = (call) => reply({ stream: call.body.method === "one" ? one.stream : two.stream });
        const first = observe(client.request("one")),
            second = observe(client.request("two"));
        await until(() => client.sses.length === 2, "both response streams started");
        one.state.controller!.close();
        rpcError(await result(first), "The MCP stream ended without an answer");
        expect(second.status).toBe("pending");
        expect(client.sses.map((sse) => sse.stream)).toEqual([two.stream]);
        expect(one.stream.locked).toBe(false);
        send(
            two,
            calls.find((call) => call.body.method === "two")!,
            { ok: true },
        );
        expect((await result(second)).rpc.result).toEqual({ ok: true });
        await clean(client, [one, two]);
        expect(two.state.cancelled).toBe(1);
        noListeners();
    });

    it("a read failure settles with its message and releases the failed stream", async () => {
        const client = newClient();
        const broken = streamOf([], { open: true });
        server.handle = () => reply({ stream: broken.stream });
        const answer = observe(client.request("broken"));
        await until(() => broken.stream.locked, "reader acquired");
        broken.state.controller!.error(new Error("wire broke"));
        rpcError(await result(answer), "wire broke");
        await clean(client, [broken]);
        noListeners();
    });

    it("aborting a response reader settles the unanswered request and releases it", async () => {
        const client = newClient();
        const stream = streamOf([], { open: true });
        server.handle = () => reply({ stream: stream.stream });
        const answer = observe(client.request("abort"));
        await until(() => client.sses.length === 1, "response stream registered");
        client.sses[0].abortController!.abort();
        rpcError(await result(answer), "The MCP stream ended without an answer");
        await clean(client, [stream]);
        expect(stream.state.cancelled).toBe(1);
        noListeners();
    });

    it("404 with a session and 401 with a token settle every pending request and retry on a usable client", async () => {
        for (const status of [404, 401]) {
            const client = newClient(status === 401 ? "old-token" : undefined);
            const streams = [streamOf([], { open: true }), streamOf([], { open: true })];
            let retries = 0;
            server.handle = (call) => {
                if (call.body.method === "seed") return rpcJson(call, {}, { "Mcp-Session-Id": "old-session" });
                if (call.body.method === "a") return reply({ stream: streams[0].stream });
                if (call.body.method === "b") return reply({ stream: streams[1].stream });
                if (call.body.method === "reset" && retries++ === 0) return reply({ status });
                return rpcJson(call, { usable: true });
            };
            await client.request("seed", {}, { initMethod: "init" });
            const a = observe(client.request("a")),
                b = observe(client.request("b"));
            await until(() => client.sses.length === 2, "both requests pending before reset");
            expect((await result(observe(client.request("reset")))).rpc.result).toEqual({ usable: true });
            rpcError(await result(a), "The MCP session ended");
            rpcError(await result(b), "The MCP session ended");
            await clean(client, streams);
            expect(streams.map((s) => s.state.cancelled)).toEqual([1, 1]);
            expect(client.sessionId).toBeNull();
            expect(client.accessToken).toBeNull();
            expect((await client.request("still-usable")).rpc.result).toEqual({ usable: true });
        }
        noListeners();
    });

    it("destroy rejects every pending request as closed and releases their readers", async () => {
        const client = newClient();
        const streams = [streamOf([], { open: true }), streamOf([], { open: true })];
        server.handle = (call) => reply({ stream: streams[call.body.method === "a" ? 0 : 1].stream });
        const a = observe(client.request("a")),
            b = observe(client.request("b"));
        await until(() => client.sses.length === 2, "both requests pending before destroy");
        client.destroy();
        await rejected(a, "The MCP client was closed");
        await rejected(b, "The MCP client was closed");
        await clean(client, streams);
        expect(streams.map((s) => s.state.cancelled)).toEqual([1, 1]);
        noListeners();
    });

    it("answers a server ping without waiting for its POST before reading the next answer and EOF", async () => {
        const client = newClient();
        const pingPost = deferred<Reply>();
        let stream!: ReturnType<typeof streamOf>;
        server.handle = (call) => {
            if (call.body.id === "server-ping") return pingPost.promise;
            stream = streamOf([
                'data:{"jsonrpc":"2.0","id":"server-ping","method":"ping"}\n\n',
                event(call.body.id, { ok: true }),
            ]);
            return reply({ stream: stream.stream });
        };
        const request = observe(client.request("work"));
        try {
            expect((await result(request)).rpc.result).toEqual({ ok: true });
            expect(calls.find((call) => call.body.id === "server-ping")?.body).toEqual({
                jsonrpc: "2.0",
                id: "server-ping",
                result: {},
            });
            await clean(client, [stream]);
        } finally {
            pingPost.resolve(reply({ status: 202 }));
        }
        noListeners();
    });
});

// A legacy server announces a POST endpoint on one long-lived GET stream; POST replies are 202,
// and JSON-RPC answers are delivered on that GET stream, including initialize.
function legacyServer(session: ReturnType<typeof streamOf>) {
    server.handle = (call) => {
        if (call.method === "GET") return reply({ stream: session.stream });
        if (call.url.endsWith("/mcp")) return reply({ status: 404 });
        if (call.body.method === "initialize") send(session, call, INFO);
        return reply({ status: 202 });
    };
}
const endpoint = "event:endpoint\ndata:/messages\n\n";

describe("MCP legacy session lifetime", () => {
    it("fails a handshake whose GET reaches EOF before the endpoint event", async () => {
        const client = newClient();
        const session = streamOf([":heartbeat\n\n"]);
        legacyServer(session);
        await rejected(observe(client.checkHandshake()));
        expect(client.initialized).toBe(false);
        await clean(client, [session]);
        noListeners();
    });

    it("legacy GET EOF settles all pending POST requests with the session-ended error", async () => {
        const client = newClient();
        const session = streamOf([endpoint], { open: true });
        legacyServer(session);
        expect(await result(observe(client.checkHandshake()))).toEqual(INFO);
        const a = observe(client.request("a")),
            b = observe(client.request("b"));
        await until(() => calls.some((call) => call.body?.method === "b"), "both POSTs sent");
        session.state.controller!.close();
        rpcError(await result(a), "The MCP session ended");
        rpcError(await result(b), "The MCP session ended");
        expect(client.initialized).toBe(false);
        await clean(client, [session]);
        noListeners();
    });

    it("reset and destroy abort a legacy GET even before fetch returns or an endpoint arrives", async () => {
        for (const phase of ["fetch", "endpoint"] as const)
            for (const action of ["reset", "destroy"] as const) {
                const client = newClient("old-token");
                const session = streamOf([], { open: true });
                const connection = deferred<Reply>();
                server.handle = (call) => {
                    if (call.method === "GET")
                        return phase === "fetch" ? connection.promise : reply({ stream: session.stream });
                    if (call.body.method === "reset")
                        return call.headers.Authorization ? reply({ status: 401 }) : rpcJson(call, {});
                    return reply({ status: 404 });
                };
                const start = calls.length;
                const handshake = observe(client.checkHandshake());
                await until(() => calls.slice(start).some((call) => call.method === "GET"), "legacy GET sent");
                const get = calls.slice(start).find((call) => call.method === "GET")!;
                if (phase === "endpoint") await until(() => session.stream.locked, "legacy reader acquired");
                if (action === "destroy") client.destroy();
                else await result(observe(client.request("reset")));
                await rejected(handshake, action === "destroy" ? "The MCP client was closed" : "The MCP session ended");
                expect(get.signal?.aborted).toBe(true);
                connection.resolve(reply({ stream: session.stream }));
                await until(() => session.state.cancelled === 1, "late or active legacy GET cancelled");
                await clean(client, [session]);
            }
        noListeners();
    });

    it("an old GET ending during re-handshake cannot reset the replacement session", async () => {
        const client = newClient();
        const old = streamOf([], { open: true });
        const current = streamOf([endpoint], { open: true });
        let gets = 0;
        server.handle = (call) => {
            if (call.method === "GET") return reply({ stream: gets++ === 0 ? old.stream : current.stream });
            if (call.url.endsWith("/mcp")) return reply({ status: 404 });
            if (call.body.method === "initialize") send(current, call, INFO);
            else if (call.body.id !== undefined) send(current, call, { fresh: true });
            return reply({ status: 202 });
        };
        const first = observe(client.checkHandshake());
        await until(() => old.stream.locked, "old handshake waiting for endpoint");
        const replacement = observe(client.checkHandshake());
        expect(await result(replacement)).toEqual(INFO);
        await rejected(first, "The MCP session ended");
        expect(old.stream.locked).toBe(false);
        expect(old.state.cancelled).toBe(1);
        expect(client.initialized).toBe(true);
        expect(client.sses.map((sse) => sse.stream)).toEqual([current.stream]);
        expect((await result(observe(client.request("fresh")))).rpc.result).toEqual({ fresh: true });
        client.destroy();
        await clean(client, [old, current]);
        noListeners();
    });

    it("a throwing legacy POST removes its listener while the session remains usable", async () => {
        const client = newClient();
        const session = streamOf([endpoint], { open: true });
        legacyServer(session);
        await result(observe(client.checkHandshake()));
        const base = server.handle!;
        server.handle = (call) => {
            if (call.body?.method === "throws") throw new Error("POST failed");
            if (call.body?.method === "after") {
                send(session, call, { ok: true });
                return reply({ status: 202 });
            }
            return base(call);
        };
        const failed = await result(observe(client.request("throws")));
        expect(failed.rpc.error).toBeDefined();
        noListeners();
        expect(client.sses.map((sse) => sse.stream)).toEqual([session.stream]);
        expect((await result(observe(client.request("after")))).rpc.result).toEqual({ ok: true });
        client.destroy();
        await clean(client, [session]);
    });

    it("destroy settles a legacy request even while its POST response is still pending", async () => {
        const client = newClient();
        const session = streamOf([endpoint], { open: true });
        legacyServer(session);
        await result(observe(client.checkHandshake()));
        const post = deferred<Reply>();
        const late = streamOf([], { open: true });
        server.handle = () => post.promise;
        const waiting = observe(client.request("slow-post"));
        await until(() => calls.some((call) => call.body?.method === "slow-post"), "POST sent");
        client.destroy();
        try {
            await rejected(waiting, "The MCP client was closed");
            await clean(client, [session]);
        } finally {
            post.resolve(reply({ stream: late.stream }));
        }
        await until(() => late.state.cancelled === 1, "late POST body cancelled");
        expect(late.stream.locked).toBe(false);
        noListeners();
    });
});
