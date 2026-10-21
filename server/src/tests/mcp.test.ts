// @vitest-environment node
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallbackResult, GenerationNotice, GenerationQuestion } from "../../../shared/jobs.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import type { ToolDescriptor } from "../../../shared/llm/request.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createChannelHub } from "../jobs/channel.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { loadJobScope, type JobScope } from "../jobs/jobScope.ts";
import { createLuaBindings, LuaJobFatalError } from "../lua/bindings.ts";
import {
    MAX_MCP_MESSAGE_BYTES,
    MAX_TOOL_LIST_PAGES,
    MAX_TOOL_LIST_TOOLS,
    McpClient,
    McpClientClosedError,
    type McpIo,
} from "../mcp/client.ts";
import { callDiceTool, MAX_DICE_NOTATION_CHARS, MAX_DICE_PER_CALL, rollDice } from "../mcp/dice.ts";
import {
    createJobTools,
    createJobToolState,
    type JobToolServices,
    MAX_JOB_TOOL_CALLS,
    TAB_ATTACH_GRACE_MS,
    TAB_MCP_TIMEOUT_MS,
} from "../mcp/jobTools.ts";
import { createMcpRegistry } from "../mcp/registry.ts";
import type { HostContext } from "../scripts/workerPool.ts";
import { countByteWork } from "./byteWork.ts";
import { sleep, waitFor } from "./testSupport.ts";

// The MCP tools of a server job, against injected `fetch` implementations (no network, no public
// service: the OAuth helper's URL is answered by the fake). The Node client
// (`server/src/mcp/client.ts`): the wire bodies and headers over streamable HTTP and the legacy
// SSE transport, every pending answer settling (a stream that ends first, the deadline, the
// caller's abort), the session reset and the handshake that publishes only into the session it
// initialized, the bounds (an event in bytes at the boundary, a JSON body, the tool list), OAuth
// (the stored refresh token, the full login with PKCE, the one login per handshake, a client
// closed during the owner's question), and the shared handshake with the leader's abort. The
// registry (`registry.ts`): one client per identifier, leases and idle expiry, the epoch, the
// `authRefreshes` replacement by URL. The job's tool set (`jobTools.ts`): the identifier list, the
// cache per list, a handshake failure skipped against a list failure that fails the build, the tab
// kinds through the callbacks with the attach grace, the budget, and a call's failure taxonomy.
// `internal:dice` on the server with its bounds. The channel's question with a withdrawing signal,
// and the bindings' `ask` distinguishing a withdrawn question from a lost owner.

const enc = new TextEncoder();
const INFO = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } };
const tool = (name: string): ToolDescriptor => ({
    name,
    description: `The ${name} tool`,
    inputSchema: { type: "object", properties: {} },
});

type Call = {
    url: string;
    method: string;
    headers: Record<string, string>;
    raw: string;
    rpc: any;
    signal: AbortSignal;
};
type Handler = (call: Call, index: number) => Response | Promise<Response>;

/** An injected `fetch` that records every call (headers lower-cased by `Headers`) and asks `handler`. */
function recorder(handler: Handler) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const raw = typeof init.body === "string" ? init.body : "";
        let rpc: unknown = null;
        try {
            rpc = raw ? JSON.parse(raw) : null;
        } catch {
            rpc = null;
        }
        const call: Call = {
            url,
            method: init.method ?? "GET",
            headers: Object.fromEntries(new Headers(init.headers as Record<string, string>)),
            raw,
            rpc,
            signal: init.signal as AbortSignal,
        };
        calls.push(call);
        if (call.signal?.aborted) {
            throw new DOMException("This operation was aborted", "AbortError");
        }
        return await handler(call, calls.length - 1);
    }) as typeof fetch;
    return { calls, fetchImpl };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const rpcAnswer = (call: Call, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    json({ jsonrpc: "2.0", id: call.rpc.id, ...body }, 200, headers);
const accepted = () => new Response(null, { status: 202 });
/** A fetch that answers only when the request is aborted (a server that withholds its headers). */
const withheld = (call: Call) =>
    new Promise<Response>((_, reject) => {
        call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
    });
const methods = (calls: Call[]) => calls.map((call) => call.rpc?.method ?? `${call.method} ${call.url}`);

/** An SSE response the test writes to; `signal` errors the body when the fetch is aborted, as a socket would. */
function sseStream(signal?: AbortSignal) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        },
    });
    const end = (error?: unknown) => {
        if (!open) {
            return;
        }
        open = false;
        if (error) {
            controller.error(error);
        } else {
            controller.close();
        }
    };
    signal?.addEventListener("abort", () => end(signal.reason ?? new Error("aborted")), { once: true });
    return {
        response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
        push(text: string) {
            if (open) {
                controller.enqueue(enc.encode(text));
            }
        },
        event(data: unknown, name?: string) {
            this.push(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
        },
        close: () => end(),
        get open() {
            return open;
        },
    };
}

/** A streamable-HTTP server: `pages` of tools, `session` as its id, `onCall` answering `tools/call`. */
function streamable(
    options: {
        pages?: ToolDescriptor[][];
        session?: string;
        info?: unknown;
        onCall?: (call: Call) => Response | Promise<Response>;
    } = {},
): Handler {
    const pages = options.pages ?? [[tool("echo")]];
    return (call) => {
        const rpc = call.rpc;
        if (!rpc || rpc.id === undefined) {
            return accepted();
        }
        switch (rpc.method) {
            case "initialize":
                return rpcAnswer(
                    call,
                    { result: options.info ?? INFO },
                    options.session ? { "Mcp-Session-Id": options.session } : {},
                );
            case "tools/list": {
                const index = rpc.params?.cursor ? Number(rpc.params.cursor) : 0;
                const next = index + 1 < pages.length ? { nextCursor: String(index + 1) } : {};
                return rpcAnswer(call, { result: { tools: pages[index] ?? [], ...next } });
            }
            case "tools/call":
                return options.onCall
                    ? options.onCall(call)
                    : rpcAnswer(call, {
                          result: {
                              content: [
                                  { type: "text", text: `${rpc.params.name}:${JSON.stringify(rpc.params.arguments)}` },
                              ],
                          },
                      });
            default:
                return rpcAnswer(call, { result: {} });
        }
    };
}

const legacyAnswer = (rpc: any): Record<string, unknown> | null => {
    switch (rpc.method) {
        case "initialize":
            return { result: { ...INFO, protocolVersion: "2024-11-05" } };
        case "tools/list":
            return { result: { tools: [tool("legacy_tool")] } };
        case "tools/call":
            return { result: { content: [{ type: "text", text: "legacy" }] } };
        default:
            return { result: {} };
    }
};

/** The legacy transport: 404 for the streamable POST, a session stream from the GET, answers pushed on it. */
function legacy() {
    const sessions: ReturnType<typeof sseStream>[] = [];
    const posts: any[] = [];
    const server = {
        sessions,
        posts,
        /** The answer to a POST with an id (null: none, the caller waits). */
        answer: legacyAnswer,
        /** Called after every POST to the endpoint was handled (a test closes the stream here). */
        after: null as null | ((rpc: any, session: ReturnType<typeof sseStream>) => void),
        get session() {
            return sessions[sessions.length - 1];
        },
        handler: ((call) => {
            if (call.method === "GET") {
                const session = sseStream(call.signal);
                sessions.push(session);
                session.push("event: endpoint\ndata: /messages\n\n");
                return session.response;
            }
            if (call.url.endsWith("/messages")) {
                posts.push(call.rpc);
                const session = server.session;
                if (call.rpc?.id !== undefined && call.rpc.method && session?.open) {
                    const body = server.answer(call.rpc);
                    if (body) {
                        session.event({ jsonrpc: "2.0", id: call.rpc.id, ...body }, "message");
                    }
                }
                server.after?.(call.rpc, session);
                return accepted();
            }
            return json({ error: "no streamable transport" }, 404);
        }) as Handler,
    };
    return server;
}

function ioOf(overrides: Partial<McpIo> = {}, signal = new AbortController().signal): McpIo {
    return { signal, openUrl() {}, askCode: async () => "", writeRefresh() {}, ...overrides };
}

/** The client's private state, for the assertions on what it keeps. */
const priv = (client: McpClient) =>
    client as unknown as {
        pending: Map<unknown, unknown>;
        generation: number;
        legacy: AbortController | null;
        serverInfo: unknown;
        accessToken: string | null;
        sessionId: string | null;
        sseEndpoint: string | null;
        closing: AbortController;
        readSse(stream: ReadableStream<Uint8Array>): Promise<void>;
        handleEvent(part: string): void;
        untilOver<T>(promise: Promise<T>, io: McpIo): Promise<T>;
    };

function client(
    fetchImpl: typeof fetch,
    options: { url?: string; timeoutMs?: number; refresh?: McpIo | unknown } = {},
) {
    return new McpClient(options.url ?? "http://mcp.test/mcp", {
        fetchImpl,
        readRefresh: () => options.refresh as never,
        ...(options.timeoutMs !== undefined ? { requestTimeoutMs: options.timeoutMs } : {}),
    });
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("McpClient over streamable HTTP", () => {
    it("handshakes once with the tab client's bodies and headers, lists every page, caches the list, and calls a tool over JSON, an event stream, and an RPC error", async () => {
        const server = recorder(
            streamable({
                pages: [[tool("echo")], [tool("shout"), tool("fail")]],
                session: "s-1",
                onCall: (call) => {
                    const name = call.rpc.params.name;
                    if (name === "fail") {
                        return rpcAnswer(call, { error: { code: -32000, message: "tool exploded" } });
                    }
                    if (name === "shout") {
                        const stream = sseStream(call.signal);
                        stream.event(
                            { jsonrpc: "2.0", id: call.rpc.id, result: { content: [{ type: "text", text: "SHOUT" }] } },
                            "message",
                        );
                        stream.close();
                        return stream.response;
                    }
                    return rpcAnswer(call, {
                        result: { content: [{ type: "text", text: `echo:${call.rpc.params.arguments.text}` }] },
                    });
                },
            }),
        );
        const mcp = client(server.fetchImpl);
        const io = ioOf();
        const tools = await mcp.getToolList(io);
        expect(tools.map((entry) => entry.name)).toEqual(["echo", "shout", "fail"]);
        expect(methods(server.calls)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
        expect(server.calls[0].rpc).toMatchObject({
            jsonrpc: "2.0",
            id: expect.any(String),
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "RS-MCP-CLIENT", version: "1.0.0" },
            },
        });
        expect(server.calls[0].headers).toMatchObject({
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
        });
        expect(server.calls[0].headers["mcp-session-id"]).toBeUndefined();
        expect(server.calls[0].headers.authorization).toBeUndefined();
        // The notification has no id and no params; the session id is sent from then on.
        expect(server.calls[1].rpc).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
        expect(server.calls[1].headers["mcp-session-id"]).toBe("s-1");
        expect(server.calls[2].rpc.params).toEqual({});
        expect(server.calls[3].rpc.params).toEqual({ cursor: "1" });
        // The non-empty list is cached: no request.
        expect(await mcp.getToolList(io)).toBe(tools);
        expect(server.calls).toHaveLength(4);

        expect(await mcp.callTool("echo", { text: "hi" }, io)).toEqual([{ type: "text", text: "echo:hi" }]);
        expect(server.calls[4].rpc).toMatchObject({
            method: "tools/call",
            params: { name: "echo", arguments: { text: "hi" } },
        });
        expect(await mcp.callTool("shout", {}, io)).toEqual([{ type: "text", text: "SHOUT" }]);
        const failed = await mcp.callTool("fail", {}, io);
        expect(failed).toEqual([{ type: "text", text: expect.stringContaining("Error calling fail") }]);
        expect(failed[0]).toMatchObject({ text: expect.stringContaining("tool exploded") });
        expect(priv(mcp).pending.size).toBe(0);

        mcp.destroy();
        expect(mcp.isClosed).toBe(true);
        await expect(mcp.callTool("echo", {}, io)).rejects.toBeInstanceOf(McpClientClosedError);
    });

    it("settles the answer when its own stream ends first, bounds a JSON body, and answers a bad body or content type as an RPC error", async () => {
        let mode: "eof" | "big" | "bad" | "html" = "eof";
        const server = recorder((call) => {
            if (call.rpc?.id === undefined) {
                return accepted();
            }
            if (call.rpc.method === "initialize") {
                return rpcAnswer(call, { result: INFO });
            }
            switch (mode) {
                case "eof": {
                    const stream = sseStream(call.signal);
                    stream.event({ jsonrpc: "2.0", method: "notifications/progress", params: {} }, "message");
                    stream.close();
                    return stream.response;
                }
                case "big":
                    return rpcAnswer(call, {
                        result: { content: [{ type: "text", text: "x".repeat(MAX_MCP_MESSAGE_BYTES) }] },
                    });
                case "bad":
                    return new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
                default:
                    return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
            }
        });
        const mcp = client(server.fetchImpl);
        const io = ioOf();
        await mcp.checkHandshake(io);
        const text = async () => (await mcp.callTool("echo", {}, io))[0] as { text: string };
        expect((await text()).text).toContain("The MCP stream ended without an answer");
        mode = "big";
        expect((await text()).text).toContain("Internal Error");
        mode = "bad";
        expect((await text()).text).toContain("Internal Error");
        mode = "html";
        expect((await text()).text).toContain("Invalid Content-Type");
        expect(priv(mcp).pending.size).toBe(0);
        mcp.destroy();
    });

    it("ends a request at its deadline and rejects when the caller aborts, leaving no pending entry", async () => {
        vi.useFakeTimers();
        // Resolved once the handler holds a request (its abort listener installed).
        let held: (() => void) | null = null;
        const server = recorder((call) => {
            if (call.rpc?.id === undefined) {
                return accepted();
            }
            if (call.rpc.method === "initialize") {
                return rpcAnswer(call, { result: INFO });
            }
            const response = withheld(call);
            held?.();
            return response;
        });
        const mcp = client(server.fetchImpl, { timeoutMs: 40 });
        try {
            await mcp.checkHandshake(ioOf());
            let settled = false;
            const late = mcp.callTool("echo", {}, ioOf()).finally(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(39);
            expect(settled).toBe(false);
            expect(server.calls[2].signal.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(((await late)[0] as { text: string }).text).toMatch(/timed out|Internal Error/);
            expect(server.calls[2].signal.aborted).toBe(true);

            const controller = new AbortController();
            const holding = new Promise<void>((resolve) => {
                held = resolve;
            });
            const pending = mcp.callTool("echo", {}, ioOf({}, controller.signal));
            await holding;
            controller.abort(new Error("caller gone"));
            await expect(pending).rejects.toThrow("caller gone");
            expect(server.calls[3].signal.aborted).toBe(true);
            expect(priv(mcp).pending.size).toBe(0);
        } finally {
            mcp.destroy();
        }
    });

    it("resets the session on a 404 with a session id or a 401 with a token and repeats the request once without them", async () => {
        let initializes = 0;
        const server = recorder((call) => {
            if (call.rpc?.id === undefined) {
                return accepted();
            }
            if (call.rpc.method === "initialize") {
                initializes++;
                if (call.headers["mcp-session-id"] === "stale") {
                    return json({}, 404);
                }
                if (call.headers.authorization === "Bearer stale") {
                    return json({}, 401);
                }
                return rpcAnswer(call, { result: INFO }, { "Mcp-Session-Id": "fresh" });
            }
            return rpcAnswer(call, { result: {} });
        });
        for (const stale of ["session", "token"] as const) {
            const mcp = client(server.fetchImpl);
            if (stale === "session") {
                priv(mcp).sessionId = "stale";
            } else {
                priv(mcp).accessToken = "stale";
            }
            expect((await mcp.checkHandshake(ioOf())).serverInfo.name).toBe("mock");
            expect(priv(mcp).sessionId).toBe("fresh");
            expect(priv(mcp).accessToken).toBeNull();
            mcp.destroy();
        }
        expect(initializes).toBe(4);
    });

    it("bounds the tool list: a repeated cursor, too many pages, too many tools; a malformed descriptor is left out and a server without tools offers none", async () => {
        const cases: { pages: Record<string, unknown>; error: RegExp | null; names?: string[] }[] = [
            {
                pages: { "": { tools: [tool("a")], nextCursor: "x" }, x: { tools: [tool("b")], nextCursor: "x" } },
                error: /repeats a cursor/,
            },
            {
                pages: Object.fromEntries(
                    Array.from({ length: MAX_TOOL_LIST_PAGES + 1 }, (_, i) => [
                        i === 0 ? "" : String(i),
                        { tools: [tool(`t${i}`)], nextCursor: String(i + 1) },
                    ]),
                ),
                error: /too many pages/,
            },
            {
                pages: { "": { tools: Array.from({ length: MAX_TOOL_LIST_TOOLS + 1 }, (_, i) => tool(`t${i}`)) } },
                error: /too large/,
            },
            {
                pages: {
                    "": {
                        tools: [
                            tool("good"),
                            { name: 7 },
                            { name: "" },
                            { name: "no-schema" },
                            { name: "bad-description", description: 1, inputSchema: {} },
                            { name: "no-description", inputSchema: { type: "object" } },
                            "junk",
                        ],
                    },
                },
                error: null,
                names: ["good", "no-description"],
            },
        ];
        for (const entry of cases) {
            const server = recorder((call) => {
                if (call.rpc?.id === undefined) {
                    return accepted();
                }
                if (call.rpc.method === "initialize") {
                    return rpcAnswer(call, { result: INFO });
                }
                return rpcAnswer(call, { result: entry.pages[call.rpc.params?.cursor ?? ""] ?? { tools: [] } });
            });
            const mcp = client(server.fetchImpl);
            if (entry.error) {
                await expect(mcp.getToolList(ioOf())).rejects.toThrow(entry.error);
            } else {
                const listed = await mcp.getToolList(ioOf());
                expect(listed.map((t) => t.name)).toEqual(entry.names);
                expect(listed[1]).toEqual({ name: "no-description", description: "", inputSchema: { type: "object" } });
            }
            mcp.destroy();
        }
        const server = recorder(streamable({ info: { ...INFO, capabilities: {} } }));
        const mcp = client(server.fetchImpl);
        expect(await mcp.getToolList(ioOf())).toEqual([]);
        await expect(mcp.callTool("echo", {}, ioOf())).rejects.toThrow("does not support tools");
        expect(methods(server.calls)).toEqual(["initialize", "notifications/initialized"]);
        mcp.destroy();
    });
});

describe("McpClient over the legacy SSE transport", () => {
    it("falls back on a 404, posts to the origin's endpoint and reads the answers on the session stream, answers a ping, and drops an unknown id", async () => {
        const remote = legacy();
        const server = recorder(remote.handler);
        const mcp = client(server.fetchImpl, { url: "http://mcp.test/sse" });
        const io = ioOf();
        const tools = await mcp.getToolList(io);
        expect(tools.map((t) => t.name)).toEqual(["legacy_tool"]);
        expect(server.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            "POST http://mcp.test/sse",
            "GET http://mcp.test/sse",
            "POST http://mcp.test/messages",
            "POST http://mcp.test/messages",
            "POST http://mcp.test/messages",
        ]);
        expect(server.calls[1].headers.accept).toBe("text/event-stream");
        expect(server.calls[2].headers.accept).toBe("*/*");
        expect(server.calls[2].rpc).toMatchObject({ method: "initialize", params: { protocolVersion: "2024-11-05" } });
        expect(remote.posts.map((rpc) => rpc.method)).toEqual([
            "initialize",
            "notifications/initialized",
            "tools/list",
        ]);

        remote.session.event({ jsonrpc: "2.0", id: "ping-1", method: "ping" });
        await waitFor(() => remote.posts.some((rpc) => rpc.id === "ping-1"));
        expect(remote.posts.at(-1)).toEqual({ jsonrpc: "2.0", id: "ping-1", result: {} });
        remote.session.event({ jsonrpc: "2.0", id: "nobody", result: { stray: true } });
        expect(await mcp.callTool("legacy_tool", {}, io)).toEqual([{ type: "text", text: "legacy" }]);
        expect(priv(mcp).pending.size).toBe(0);
        expect(remote.session.open).toBe(true);
        mcp.destroy();
        // The session stream ends with the client.
        expect(remote.session.open).toBe(false);
    });

    it("settles every pending answer when the session stream ends, resets the session, and handshakes again on the next call", async () => {
        const remote = legacy();
        remote.answer = (rpc) => (rpc.method === "tools/call" ? null : legacyAnswer(rpc));
        const server = recorder(remote.handler);
        const mcp = client(server.fetchImpl, { url: "http://mcp.test/sse" });
        const io = ioOf();
        await mcp.checkHandshake(io);
        const pending = mcp.callTool("legacy_tool", {}, io);
        await waitFor(() => remote.posts.some((rpc) => rpc.method === "tools/call"));
        expect(priv(mcp).pending.size).toBe(1);
        remote.session.close();
        expect((await pending)[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("session stream ended"),
        });
        expect(priv(mcp).pending.size).toBe(0);
        expect(priv(mcp).serverInfo).toBeNull();
        expect(priv(mcp).sseEndpoint).toBeNull();
        expect(priv(mcp).legacy).toBeNull();

        remote.answer = legacyAnswer;
        expect(await mcp.callTool("legacy_tool", {}, io)).toEqual([{ type: "text", text: "legacy" }]);
        expect(server.calls.filter((call) => call.method === "GET")).toHaveLength(2);
        expect(remote.posts.filter((rpc) => rpc.method === "initialize")).toHaveLength(2);
        mcp.destroy();
    });

    it("gives the session stream one deadline to connect and name its endpoint, and none once connected", async () => {
        vi.useFakeTimers();
        const remote = legacy();
        const server = recorder((call, index) =>
            call.method === "GET" && index === 1 ? withheld(call) : remote.handler(call, index),
        );
        const mcp = client(server.fetchImpl, { url: "http://mcp.test/sse", timeoutMs: 40 });
        try {
            let settled = false;
            const first = mcp.checkHandshake(ioOf()).finally(() => {
                settled = true;
            });
            const refused = expect(first).rejects.toThrow("did not connect in time");
            await vi.advanceTimersByTimeAsync(39);
            expect(settled).toBe(false);
            expect(server.calls[1].signal.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await refused;
            expect(server.calls[1].signal.aborted).toBe(true);
            expect(priv(mcp).legacy).toBeNull();
            expect(priv(mcp).pending.size).toBe(0);

            expect((await mcp.checkHandshake(ioOf())).serverInfo.name).toBe("mock");
            // Connected: no deadline is left armed on the session stream.
            await vi.advanceTimersByTimeAsync(100);
            expect(remote.session.open).toBe(true);
            expect(priv(mcp).serverInfo).not.toBeNull();
            expect(await mcp.callTool("legacy_tool", {}, ioOf())).toEqual([{ type: "text", text: "legacy" }]);
        } finally {
            mcp.destroy();
        }
    });

    it("publishes nothing from a handshake whose session ended right after the initialize answer or during the initialized notification, and handshakes afresh next", async () => {
        for (const endAt of ["initialize", "notifications/initialized"]) {
            const remote = legacy();
            remote.after = (rpc, session) => {
                if (rpc.method === endAt) {
                    session.close();
                }
            };
            const server = recorder(remote.handler);
            const mcp = client(server.fetchImpl, { url: "http://mcp.test/sse" });
            await expect(mcp.checkHandshake(ioOf())).rejects.toThrow("The MCP session ended during the handshake");
            expect(priv(mcp).serverInfo).toBeNull();
            expect(priv(mcp).sseEndpoint).toBeNull();
            expect(priv(mcp).legacy).toBeNull();
            expect(priv(mcp).pending.size).toBe(0);
            // The next call starts over: a new GET, a new initialize, and the session is used.
            remote.after = null;
            expect(await mcp.callTool("legacy_tool", {}, ioOf())).toEqual([{ type: "text", text: "legacy" }]);
            expect(server.calls.filter((call) => call.method === "GET")).toHaveLength(2);
            expect(remote.posts.filter((rpc) => rpc.method === "initialize")).toHaveLength(2);
            expect(priv(mcp).serverInfo).toMatchObject({ serverInfo: { name: "mock" } });
            mcp.destroy();
        }
    });
});

describe("McpClient OAuth", () => {
    type OAuthOptions = {
        /** What the refresh grant answers. */
        refresh?: "ok" | "empty" | "html" | "denied" | "network";
        /** The server keeps answering 401 after the login. */
        stillUnauthorized?: boolean;
        /** Discovery answers these endpoints (404 when `discovery` is false). */
        endpoints?: Record<string, unknown>;
        discovery?: boolean;
    };
    function oauthServer(options: OAuthOptions = {}) {
        const refreshes: Record<string, string>[] = [];
        const exchanges: Record<string, string>[] = [];
        const registrations: unknown[] = [];
        const helper: unknown[] = [];
        const serve = streamable();
        const handler: Handler = (call, index) => {
            if (call.url === "http://mcp.test/token") {
                const form = Object.fromEntries(new URLSearchParams(call.raw));
                if (form.grant_type === "refresh_token") {
                    refreshes.push(form);
                    switch (options.refresh) {
                        case "ok":
                            return json({ access_token: "refreshed" });
                        case "empty":
                            return json({ token_type: "bearer" });
                        case "html":
                            return new Response("<html>", { status: 200 });
                        case "network":
                            throw new TypeError("fetch failed");
                        default:
                            return json({ error: "invalid_grant" }, 400);
                    }
                }
                exchanges.push(form);
                return json({ access_token: "logged-in", refresh_token: "rt-new" });
            }
            if (call.url === "http://mcp.test/.well-known/oauth-authorization-server") {
                return options.discovery === false
                    ? json({ error: "not found" }, 404)
                    : json({
                          authorization_endpoint: "http://mcp.test/authorize",
                          token_endpoint: "http://mcp.test/token",
                          registration_endpoint: "http://mcp.test/register",
                          ...options.endpoints,
                      });
            }
            if (call.url === "http://mcp.test/register") {
                registrations.push(call.rpc);
                return json({ client_id: "cid", client_secret: "csec" }, 201);
            }
            if (call.url === "https://account.sionyw.com/oauthhelper/api") {
                helper.push(call.rpc);
                return json({ success: true, payload: { code: "server-code" } });
            }
            const token = call.headers.authorization;
            const authorized =
                token === "Bearer refreshed" || (token === "Bearer logged-in" && !options.stillUnauthorized);
            return authorized ? serve(call, index) : json({ error: "unauthorized" }, 401);
        };
        return { handler, refreshes, exchanges, registrations, helper };
    }
    const stored = { clientId: "c", clientSecret: "s", refreshToken: "rt", tokenUrl: "http://mcp.test/token" };

    it("uses a stored refresh token when the token endpoint answers 200 with a token, and asks the owner nothing", async () => {
        const oauth = oauthServer({ refresh: "ok" });
        const server = recorder(oauth.handler);
        const mcp = client(server.fetchImpl, { refresh: stored });
        const openUrl = vi.fn();
        const askCode = vi.fn(async () => "never");
        expect((await mcp.checkHandshake(ioOf({ openUrl, askCode }))).serverInfo.name).toBe("mock");
        expect(server.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            "POST http://mcp.test/mcp",
            "POST http://mcp.test/token",
            "POST http://mcp.test/mcp",
            "POST http://mcp.test/mcp",
        ]);
        expect(oauth.refreshes).toEqual([
            { grant_type: "refresh_token", refresh_token: "rt", client_id: "c", client_secret: "s" },
        ]);
        expect(server.calls[1].headers["content-type"]).toBe("application/x-www-form-urlencoded");
        expect(server.calls[2].headers.authorization).toBe("Bearer refreshed");
        expect(openUrl).not.toHaveBeenCalled();
        expect(askCode).not.toHaveBeenCalled();
        expect(priv(mcp).accessToken).toBe("refreshed");
        mcp.destroy();
    });

    it("logs in fully when the refresh answers without a token, with no JSON, or with an error, and when nothing is stored: discovery, registration, PKCE, the owner's code through the helper, the refresh record written", async () => {
        for (const refresh of ["empty", "html", "denied", undefined] as const) {
            const oauth = oauthServer(refresh ? { refresh } : {});
            const server = recorder(oauth.handler);
            const mcp = client(server.fetchImpl, { refresh: refresh ? stored : undefined });
            const opened: string[] = [];
            const written: unknown[] = [];
            const io = ioOf({
                openUrl: (url) => opened.push(url),
                askCode: async () => "user-code",
                writeRefresh: (entry) => written.push(entry),
            });
            expect((await mcp.checkHandshake(io)).serverInfo.name).toBe("mock");
            expect(oauth.refreshes).toHaveLength(refresh ? 1 : 0);
            expect(oauth.registrations).toEqual([
                {
                    client_name: "RS-MCP-CLIENT",
                    redirect_uris: ["https://account.sionyw.com/oauthhelper"],
                    response_types: ["code"],
                    grant_types: ["authorization_code"],
                    token_endpoint_auth_method: "client_secret_basic",
                },
            ]);
            expect(opened).toHaveLength(1);
            const url = new URL(opened[0]);
            expect(`${url.origin}${url.pathname}`).toBe("http://mcp.test/authorize");
            expect(Object.fromEntries(url.searchParams)).toMatchObject({
                client_id: "cid",
                response_type: "code",
                redirect_uri: "https://account.sionyw.com/oauthhelper",
                scope: "",
                code_challenge_method: "S256",
            });
            expect(url.searchParams.get("state")).toMatch(/^[0-9a-f-]{36}$/);
            expect(oauth.helper).toEqual([{ code: "user-code" }]);
            expect(oauth.exchanges).toHaveLength(1);
            expect(oauth.exchanges[0]).toMatchObject({
                grant_type: "authorization_code",
                code: "server-code",
                redirect_uri: "https://account.sionyw.com/oauthhelper",
                client_id: "cid",
                client_secret: "csec",
            });
            // PKCE: the challenge opened is the hash of the verifier exchanged.
            const verifier = oauth.exchanges[0].code_verifier;
            expect(verifier).toMatch(/^[0-9a-f]{64}$/);
            expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
                url.searchParams.get("code_challenge"),
            );
            expect(written).toEqual([
                { clientId: "cid", clientSecret: "csec", refreshToken: "rt-new", tokenUrl: "http://mcp.test/token" },
            ]);
            expect(server.calls.at(-2)!.headers.authorization).toBe("Bearer logged-in");
            expect(priv(mcp).accessToken).toBe("logged-in");
            mcp.destroy();
        }
    });

    it("falls back to the origin's endpoints when discovery fails, refuses endpoints that are not web addresses before opening anything, and fails the handshake when the refresh exchange fails on the network", async () => {
        const fallback = oauthServer({ discovery: false });
        let server = recorder(fallback.handler);
        let mcp = client(server.fetchImpl);
        const opened: string[] = [];
        await mcp.checkHandshake(ioOf({ openUrl: (url) => opened.push(url), askCode: async () => "code" }));
        expect(opened[0]).toMatch(/^http:\/\/mcp\.test\/authorize\?/);
        expect(fallback.registrations).toHaveLength(1);
        mcp.destroy();

        for (const endpoints of [
            { authorization_endpoint: "javascript:alert(1)" },
            { token_endpoint: "ftp://mcp.test/token" },
            { registration_endpoint: 7 },
        ]) {
            const hostile = oauthServer({ endpoints });
            server = recorder(hostile.handler);
            mcp = client(server.fetchImpl);
            const openUrl = vi.fn();
            await expect(mcp.checkHandshake(ioOf({ openUrl }))).rejects.toThrow("not web addresses");
            expect(openUrl).not.toHaveBeenCalled();
            expect(hostile.registrations).toEqual([]);
            expect(priv(mcp).accessToken).toBeNull();
            mcp.destroy();
        }

        const offline = oauthServer({ refresh: "network" });
        server = recorder(offline.handler);
        mcp = client(server.fetchImpl, { refresh: stored });
        await expect(mcp.checkHandshake(ioOf())).rejects.toThrow("fetch failed");
        expect(server.calls.map((call) => call.url)).toEqual(["http://mcp.test/mcp", "http://mcp.test/token"]);
        mcp.destroy();
    });

    it("logs in at most once per handshake: a server that still refuses the token fails the handshake", async () => {
        const oauth = oauthServer({ stillUnauthorized: true });
        const server = recorder(oauth.handler);
        const mcp = client(server.fetchImpl);
        const askCode = vi.fn(async () => "code");
        await expect(mcp.checkHandshake(ioOf({ askCode }))).rejects.toThrow("refused the authorization");
        expect(askCode).toHaveBeenCalledTimes(1);
        expect(oauth.registrations).toHaveLength(1);
        expect(oauth.exchanges).toHaveLength(1);
        // initialize (401), discovery, register, helper, token, initialize with the token (401), reset, retry without (401).
        expect(server.calls.filter((call) => call.url === "http://mcp.test/mcp")).toHaveLength(3);
        expect(priv(mcp).accessToken).toBeNull();
        mcp.destroy();
    });

    it("withdraws the owner's question and settles its callers when the client is closed during the login; a late answer publishes nothing", async () => {
        const oauth = oauthServer();
        const server = recorder(oauth.handler);
        const mcp = client(server.fetchImpl);
        let cancel: AbortSignal | null = null;
        let answer!: (code: string) => void;
        const io = ioOf({
            askCode: (signal) =>
                new Promise<string>((resolve) => {
                    cancel = signal;
                    answer = resolve;
                }),
        });
        const waiting = mcp.checkHandshake(io);
        const other = mcp.checkHandshake(ioOf());
        await waitFor(() => cancel !== null);
        expect(cancel!.aborted).toBe(false);
        mcp.destroy();
        await expect(waiting).rejects.toBeInstanceOf(McpClientClosedError);
        await expect(other).rejects.toBeInstanceOf(McpClientClosedError);
        expect(cancel!.aborted).toBe(true);
        answer("late");
        await sleep(20);
        expect(oauth.helper).toEqual([]);
        expect(oauth.exchanges).toEqual([]);
        expect(priv(mcp).accessToken).toBeNull();

        // The caller's own abort during the question rejects with its reason.
        const second = client(recorder(oauthServer().handler).fetchImpl);
        const controller = new AbortController();
        let asked = false;
        const aborted = second.checkHandshake(
            ioOf(
                {
                    askCode: () =>
                        new Promise<string>(() => {
                            asked = true;
                        }),
                },
                controller.signal,
            ),
        );
        await waitFor(() => asked);
        controller.abort(new Error("owner left"));
        await expect(aborted).rejects.toThrow("owner left");
        second.destroy();
    });

    it("shares one handshake between concurrent callers; when the caller that started it is aborted the next one starts its own, and another failure fails every waiter", async () => {
        let hold: (() => void) | null = null;
        let initializes = 0;
        let failAll = false;
        const server = recorder((call) => {
            if (call.rpc?.id === undefined) {
                return accepted();
            }
            if (call.rpc.method !== "initialize") {
                return rpcAnswer(call, { result: {} });
            }
            initializes++;
            if (failAll) {
                return rpcAnswer(call, { error: { code: -32000, message: "nope" } });
            }
            if (initializes === 1) {
                return new Promise<Response>((resolve, reject) => {
                    hold = () => resolve(rpcAnswer(call, { result: INFO }));
                    call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
                });
            }
            return rpcAnswer(call, { result: INFO });
        });
        const mcp = client(server.fetchImpl);
        const leader = new AbortController();
        const first = mcp.checkHandshake(ioOf({}, leader.signal));
        const second = mcp.checkHandshake(ioOf());
        await waitFor(() => hold !== null);
        leader.abort(new Error("leader left"));
        await expect(first).rejects.toThrow("leader left");
        expect((await second).serverInfo.name).toBe("mock");
        expect(initializes).toBe(2);
        mcp.destroy();

        initializes = 0;
        hold = null;
        const shared = client(server.fetchImpl);
        const a = shared.checkHandshake(ioOf());
        const b = shared.checkHandshake(ioOf());
        await waitFor(() => hold !== null);
        hold!();
        expect((await a).serverInfo.name).toBe("mock");
        expect((await b).serverInfo.name).toBe("mock");
        expect(initializes).toBe(1);
        shared.destroy();

        initializes = 0;
        failAll = true;
        const failing = client(server.fetchImpl);
        const results = await Promise.allSettled([failing.checkHandshake(ioOf()), failing.checkHandshake(ioOf())]);
        expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
        expect((results[1] as PromiseRejectedResult).reason.message).toBe("MCP Handshake Failed");
        expect(initializes).toBe(1);
        failing.destroy();
    });

    it("untilOver leaves no listener behind after the promise settles or the client closes", async () => {
        const mcp = client(recorder(() => accepted()).fetchImpl);
        const controller = new AbortController();
        expect(await priv(mcp).untilOver(Promise.resolve(1), ioOf({}, controller.signal))).toBe(1);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        expect(getEventListeners(priv(mcp).closing.signal, "abort")).toHaveLength(0);
        let finish!: (value: number) => void;
        const held = priv(mcp).untilOver(
            new Promise<number>((resolve) => {
                finish = resolve;
            }),
            ioOf({}, controller.signal),
        );
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        mcp.destroy();
        await expect(held).rejects.toBeInstanceOf(McpClientClosedError);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        finish(2);
    });
});

describe("the SSE reader (readSse)", () => {
    /** Reads `chunks` with a recording event handler; `events` are the finished events' text. */
    function reading(chunks: Uint8Array[]) {
        const mcp = client(recorder(() => accepted()).fetchImpl);
        const events: string[] = [];
        priv(mcp).handleEvent = (part) => {
            // The real handler drops an event without data (two blank lines in a row).
            if (part !== "") {
                events.push(part);
            }
        };
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                }
                controller.close();
            },
        });
        return { run: priv(mcp).readSse(stream), events, stream, mcp };
    }
    const bytes = (text: string) => enc.encode(text);

    it("measures an event in bytes at the limit, with a four-byte character split after a previous delimiter", async () => {
        for (const size of [MAX_MCP_MESSAGE_BYTES - 1, MAX_MCP_MESSAGE_BYTES, MAX_MCP_MESSAGE_BYTES + 1]) {
            // A blank line, then the first three bytes of U+1F600; the rest comes with the next chunk.
            const head = Uint8Array.from([10, 10, 0xf0, 0x9f, 0x98]);
            const tail = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(size - 4, 0x78), Buffer.from("\n\n")]);
            const { run, events, stream, mcp } = reading([head, tail]);
            if (size > MAX_MCP_MESSAGE_BYTES) {
                await expect(run).rejects.toThrow("An MCP event is too large");
                expect(events).toEqual([]);
            } else {
                await run;
                expect(events).toHaveLength(1);
                expect(Buffer.byteLength(events[0])).toBe(size);
                expect(events[0].startsWith("\u{1F600}x")).toBe(true);
            }
            // The reader's lock is released whatever ended the read.
            expect(stream.locked).toBe(false);
            mcp.destroy();
        }
    });

    it("finds the blank line across chunks, several events in one chunk, and drops an unfinished tail at the end", async () => {
        const spanning = reading([bytes("data: a\n"), bytes("\ndata: b\n\n")]);
        await spanning.run;
        expect(spanning.events).toEqual(["data: a", "data: b"]);

        const several = reading([bytes("data: 1\n\nevent: message\ndata: 2\n\n\n"), bytes("data: unfinished")]);
        await several.run;
        expect(several.events).toEqual(["data: 1", "event: message\ndata: 2"]);

        // One byte over an event in a held tail is allowed: it may be the first half of the blank line.
        const slack = reading([Buffer.alloc(MAX_MCP_MESSAGE_BYTES, 0x78), bytes("\n"), bytes("\n")]);
        await slack.run;
        expect(slack.events.map((event) => Buffer.byteLength(event))).toEqual([MAX_MCP_MESSAGE_BYTES]);

        const tooLong = reading([Buffer.alloc(MAX_MCP_MESSAGE_BYTES + 1, 0x78), bytes("\n\n")]);
        await expect(tooLong.run).rejects.toThrow("too large");
        expect(tooLong.stream.locked).toBe(false);

        const unfinished = reading([Buffer.alloc(MAX_MCP_MESSAGE_BYTES + 2, 0x78)]);
        await expect(unfinished.run).rejects.toThrow("too large");
    });

    it("reads a limit-sized event delivered in small chunks without rescanning or recopying it", async () => {
        // Plain `Uint8Array` chunks, as a fetch body yields them (`countByteWork` sees their searches and copies).
        const chunk = 64 * 1024;
        const chunks: Uint8Array[] = [bytes("data: ")];
        const payload = new Uint8Array(MAX_MCP_MESSAGE_BYTES - 6).fill(0x78);
        for (let offset = 0; offset < payload.length; offset += chunk) {
            chunks.push(payload.subarray(offset, Math.min(offset + chunk, payload.length)));
        }
        chunks.push(bytes("\n\n"));
        const input = chunks.reduce((total, part) => total + part.length, 0);
        const {
            result: events,
            scanned,
            copied,
        } = await countByteWork(async () => {
            const read = reading(chunks);
            await read.run;
            return read.events;
        });
        expect(events).toHaveLength(1);
        expect(Buffer.byteLength(events[0])).toBe(MAX_MCP_MESSAGE_BYTES);
        // Linear: each chunk is searched for both line ends once, kept once, and joined once. Searching
        // or joining what the event already holds on every chunk is about 64 times the input here.
        // The lower bounds only prove the counters were active.
        expect(scanned).toBeGreaterThanOrEqual(input);
        expect(scanned).toBeLessThanOrEqual(2 * input + 64);
        expect(copied).toBeGreaterThan(0);
        expect(copied).toBeLessThanOrEqual(2 * input + 64);
    });

    it("dispatches an endpoint event, a ping, and a message by id, and ignores events it cannot parse", async () => {
        const posts: Call[] = [];
        const mcp = client(
            recorder((call) => {
                posts.push(call);
                return accepted();
            }).fetchImpl,
        );
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes("event: endpoint\ndata: /post\n\n"));
                controller.enqueue(bytes("data: not json\n\n"));
                controller.enqueue(bytes("data: [1]\n\n"));
                controller.enqueue(bytes('data: {"jsonrpc":"2.0","id":"p","method":"ping"}\n\n'));
                controller.enqueue(bytes('data: {"jsonrpc":"2.0",\ndata: "id":"nobody","result":1}\n\n'));
                controller.close();
            },
        });
        const connected: unknown[] = [];
        priv(mcp).pending.set("connected", (rpc: unknown) => connected.push(rpc));
        await priv(mcp).readSse(stream);
        expect(connected).toEqual([{ jsonrpc: "2.0", id: "connected", result: { endpoint: "/post" } }]);
        await waitFor(() => posts.length === 1);
        expect(posts[0].rpc).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
        mcp.destroy();
    });
});

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;

/** A store with its materialized singletons, in memory. */
function memoryStore() {
    return createResourceStore({ file: ":memory:", kinds });
}

describe("createMcpRegistry", () => {
    it("shares one client per identifier, keeps a leased client past the idle time, closes an idle one after its release, and replaces a closed one", async () => {
        // Fake from the first lease on, so every idle timer is one the test advances.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const store = memoryStore();
        const server = recorder(streamable());
        const registry = createMcpRegistry({ store, kinds, fetchImpl: server.fetchImpl, idleMs: 40 });
        registry.sync("e1");
        const seen: McpClient[] = [];
        await registry.use("id", "http://mcp.test/mcp", async (mcp) => {
            seen.push(mcp);
            await mcp.checkHandshake(ioOf());
        });
        await registry.use("id", "http://mcp.test/mcp", async (mcp) => {
            seen.push(mcp);
        });
        expect(seen[1]).toBe(seen[0]);
        expect(methods(server.calls)).toEqual(["initialize", "notifications/initialized"]);
        await registry.use("id", "http://mcp.test/mcp", async (mcp) => {
            await vi.advanceTimersByTimeAsync(90);
            expect(mcp.isClosed).toBe(false);
            expect(mcp).toBe(seen[0]);
        });
        // Idle from the release on: open just before the idle time, closed at it.
        await vi.advanceTimersByTimeAsync(39);
        expect(seen[0].isClosed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(seen[0].isClosed).toBe(true);
        await registry.use("id", "http://mcp.test/mcp", async (mcp) => {
            seen.push(mcp);
        });
        expect(seen[2]).not.toBe(seen[0]);
        expect(seen[2].isClosed).toBe(false);

        // The same epoch keeps the clients; a new one closes every client.
        registry.sync("e1");
        expect(seen[2].isClosed).toBe(false);
        registry.sync("e2");
        expect(seen[2].isClosed).toBe(true);
        await registry.use("id", "http://mcp.test/mcp", async (mcp) => {
            seen.push(mcp);
        });
        expect(seen[3]).not.toBe(seen[2]);
        registry.dispose();
        expect(seen[3].isClosed).toBe(true);
        await expect(registry.use("id", "http://mcp.test/mcp", async () => {})).rejects.toThrow("shutting down");
        store.close();
    });

    it("replaces every authRefreshes entry of the identifier in place and keeps the others, appends a new one, and the client reads the stored entry", async () => {
        const store = memoryStore();
        const refreshKind = kind(RESOURCE_KIND.authRefreshes);
        // The store materializes the singleton: the registry relies on it.
        const row = store.get(refreshKind, SINGLETON_RESOURCE_ID);
        expect(row).not.toBeNull();
        const list = [
            { url: "http://a.test/mcp", refreshToken: "1", tokenUrl: "http://a.test/token" },
            { url: "http://b.test/mcp", refreshToken: "2", tokenUrl: "http://b.test/token" },
            { url: "http://a.test/mcp", refreshToken: "3", tokenUrl: "http://a.test/token" },
        ];
        store.applyChanges({
            ops: [{ kind: refreshKind, id: SINGLETON_RESOURCE_ID, baseRevision: row!.revision, data: list }],
        });
        const refreshes: Record<string, string>[] = [];
        const server = recorder((call, index) => {
            if (call.url === "http://mcp.test/token") {
                refreshes.push(Object.fromEntries(new URLSearchParams(call.raw)));
                return json({ access_token: "refreshed" });
            }
            return call.headers.authorization === "Bearer refreshed"
                ? streamable()(call, index)
                : json({ error: "unauthorized" }, 401);
        });
        const registry = createMcpRegistry({ store, kinds, fetchImpl: server.fetchImpl });

        const replaced = registry.refreshChanges("http://a.test/mcp", {
            clientId: "c",
            refreshToken: "9",
            tokenUrl: "http://mcp.test/token",
        });
        const current = store.get(refreshKind, SINGLETON_RESOURCE_ID)!;
        expect(replaced.ops).toEqual([
            {
                kind: refreshKind,
                id: SINGLETON_RESOURCE_ID,
                baseRevision: current.revision,
                data: [
                    { url: "http://a.test/mcp", clientId: "c", refreshToken: "9", tokenUrl: "http://mcp.test/token" },
                    { url: "http://b.test/mcp", refreshToken: "2", tokenUrl: "http://b.test/token" },
                ],
            },
        ]);
        store.applyChanges(replaced as never);
        const appended = registry.refreshChanges("http://c.test/mcp", { refreshToken: "c" });
        expect((appended.ops![0] as { data: unknown[] }).data).toEqual([
            { url: "http://a.test/mcp", clientId: "c", refreshToken: "9", tokenUrl: "http://mcp.test/token" },
            { url: "http://b.test/mcp", refreshToken: "2", tokenUrl: "http://b.test/token" },
            { url: "http://c.test/mcp", refreshToken: "c" },
        ]);

        // The client of identifier `a` refreshes with the entry as stored now.
        await registry.use("http://a.test/mcp", "http://mcp.test/mcp", (mcp) => mcp.checkHandshake(ioOf()));
        expect(refreshes).toEqual([
            { grant_type: "refresh_token", refresh_token: "9", client_id: "c", client_secret: "" },
        ]);
        registry.dispose();
        store.close();
    });
});

describe("createJobTools", () => {
    const identity = { characterId: "c", chatId: "k", presetId: "p", personaId: "u" };
    function ctxOf(signal = new AbortController().signal): HostContext {
        return { identity, access: "lowLevel", signal, regex: async () => ({ value: false }) } as HostContext;
    }
    function fakeJob(
        options: {
            attached?: () => boolean;
            mcpTools?: string[];
            signal?: AbortSignal;
            write?: RunningJob["write"];
        } = {},
    ): RunningJob {
        return {
            id: "job",
            hooks: { ...NO_GENERATION_HOOKS, mcpTools: options.mcpTools ?? [] },
            ownerAttached: options.attached ?? (() => true),
            signal: options.signal ?? new AbortController().signal,
            write:
                options.write ??
                (() => {
                    throw new Error("no write in this test");
                }),
        } as unknown as RunningJob;
    }
    /** A scope whose enabled modules name `urls`, in that order. */
    function fakeScope(urls: string[], options: { secret?: string } = {}): JobScope {
        return {
            characterId: "c",
            chatId: "k",
            db: {
                characters: [{ chaId: "c", chats: [{ id: "k" }] }],
                personas: [],
                enabledModules: urls.map((_, index) => `m${index}`),
                modules: urls.map((url, index) => ({ id: `m${index}`, name: `m${index}`, mcp: { url } })),
            },
            request: { db: options.secret ? { openAIKey: options.secret } : {} },
        } as unknown as JobScope;
    }
    type Answer = CallbackResult | { ok: true; value: unknown } | { ok: false; error: string } | Error;
    /** Recording services; `callbacks` answers `tryCallback` (an Error is a latched fatal outcome). */
    function fakeServices(
        options: { callbacks?: (name: string, payload: unknown) => Answer | undefined; code?: string } = {},
    ) {
        const log = {
            callbacks: [] as { name: string; payload: unknown; timeoutMs?: number }[],
            notices: [] as GenerationNotice[],
            questions: [] as { question: GenerationQuestion; signal?: AbortSignal }[],
        };
        let fatal: Error | null = null;
        const services: JobToolServices = {
            fence(ctx) {
                if (fatal) {
                    throw fatal;
                }
                if (ctx?.signal.aborted) {
                    fatal = new Error("request aborted");
                    throw fatal;
                }
            },
            latch(error) {
                fatal ??= error instanceof Error ? error : new Error(String(error));
                return fatal;
            },
            async ask(question, _ctx, askOptions) {
                log.questions.push({ question, signal: askOptions?.signal });
                return options.code ?? "code-1";
            },
            notice(notice) {
                log.notices.push(notice);
            },
            async tryCallback(name, payload, _ctx, callbackOptions) {
                log.callbacks.push({ name, payload, timeoutMs: callbackOptions?.timeoutMs });
                const answer = options.callbacks?.(name, payload);
                if (answer === undefined) {
                    return { ok: false, error: "nothing registered" };
                }
                if (answer instanceof Error) {
                    throw services.latch(answer);
                }
                return answer as { ok: true; value: unknown } | { ok: false; error: string };
            },
            // The internal MCPs' services: inert, no test here calls an internal tool other than dice.
            refresh: () => false,
            request: async () => {
                throw new Error("no request in this test");
            },
            getChatVar: () => "",
            setChatVar: () => false,
            embeddings: () => {
                throw new Error("no embeddings in this test");
            },
        };
        return { services, log, fatal: () => fatal };
    }
    function registryOver(handler: Handler, store = memoryStore()) {
        const server = recorder(handler);
        return { server, store, registry: createMcpRegistry({ store, kinds, fetchImpl: server.fetchImpl }) };
    }
    /** Dispatches by host: `mcp.test` and `second.test` are streamable servers. */
    const twoServers: Handler = (call, index) =>
        call.url.startsWith("http://second.test/")
            ? streamable({ pages: [[tool("echo"), tool("other")]] })(call, index)
            : streamable({ pages: [[tool("echo")]] })(call, index);

    it("offers dice, the remotes, and a stdio URL in module order, each identifier once, routes a name to its first MCP, and warns for what it does not serve", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { registry, server, store } = registryOver(twoServers);
        const urls = [
            "internal:dice",
            "http://mcp.test/mcp",
            "internal:dice",
            "internal:aiaccess",
            "internal:unknown",
            'stdio:{"url":"http://second.test/mcp"}',
            "ftp://nowhere.test",
            "plugin:unlisted",
            "http://mcp.test/mcp",
        ];
        const state = createJobToolState();
        const tools = createJobTools({
            job: fakeJob(),
            scope: fakeScope(urls),
            state,
            registry,
            store,
            kinds,
            services: fakeServices().services,
        });
        const set = await tools.list(ctxOf());
        expect(set.descriptors.map((d) => d.name)).toEqual(["rollDice", "echo", "runLLM", "echo", "other"]);
        expect(set.routes.get("rollDice")).toMatchObject({ kind: "local", identifier: "internal:dice" });
        expect(set.routes.get("runLLM")).toMatchObject({ kind: "local", identifier: "internal:aiaccess" });
        expect(set.routes.get("echo")).toMatchObject({
            kind: "remote",
            identifier: "http://mcp.test/mcp",
            url: "http://mcp.test/mcp",
        });
        expect(set.routes.get("other")).toMatchObject({
            kind: "remote",
            identifier: 'stdio:{"url":"http://second.test/mcp"}',
            url: "http://second.test/mcp",
        });
        // One handshake per remote, none repeated for the duplicate identifier.
        expect(server.calls.filter((call) => call.rpc?.method === "initialize").map((call) => call.url)).toEqual([
            "http://mcp.test/mcp",
            "http://second.test/mcp",
        ]);
        const warned = warn.mock.calls.map((call) => String(call[1]));
        expect(warned).toEqual([
            "internal:unknown is not a known internal MCP",
            "MCP: Failed to initialize ftp://nowhere.test: Invalid MCP URL",
            "MCP: Failed to initialize plugin:unlisted: Invalid MCP URL",
        ]);
        expect(state.warned).toBe(true);
        registry.dispose();
    });

    it("skips a server whose handshake fails with a warning that names only the origin, while a tool list that fails after the handshake fails the build, which is not kept", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        let listing: "ok" | "repeat" = "repeat";
        const { registry, server, store } = registryOver((call, index) => {
            if (call.url.startsWith("http://down.test/")) {
                return json({ error: "boom" }, 500);
            }
            if (call.rpc?.method === "tools/list" && listing === "repeat") {
                return rpcAnswer(call, { result: { tools: [tool("echo")], nextCursor: "again" } });
            }
            return streamable()(call, index);
        });
        const state = createJobToolState();
        const urls = ["http://down.test/secret/path?key=1", "http://mcp.test/mcp"];
        const tools = createJobTools({
            job: fakeJob(),
            scope: fakeScope(urls),
            state,
            registry,
            store,
            kinds,
            services: fakeServices().services,
        });
        await expect(tools.list(ctxOf())).rejects.toThrow("repeats a cursor");
        expect(state.sets.size).toBe(0);
        expect(warn.mock.calls.map((call) => String(call[1]))).toEqual([
            "MCP: Failed to initialize http://down.test: MCP Handshake Failed",
        ]);
        listing = "ok";
        const set = await tools.list(ctxOf());
        expect(set.descriptors.map((d) => d.name)).toEqual(["echo"]);
        expect(state.sets.size).toBe(1);
        // The failed server was tried again by the second build (nothing of a failed build is kept).
        expect(server.calls.filter((call) => call.url.startsWith("http://down.test/"))).toHaveLength(2);
        registry.dispose();

        const command = createJobTools({
            job: fakeJob(),
            scope: fakeScope(['stdio:{"command":"npx","args":["x"]}']),
            state: createJobToolState(),
            registry,
            store,
            kinds,
            services: fakeServices().services,
        });
        await expect(command.list(ctxOf())).rejects.toThrow(/Failed to parse MCP JSON: .*stdio MCPs are not supported/);
    });

    it("builds the set once per identifier list for the job, shared by concurrent requests, with distinct keys for distinct lists", async () => {
        const { registry, server, store } = registryOver(twoServers);
        const state = createJobToolState();
        const services = fakeServices().services;
        const tools = createJobTools({
            job: fakeJob(),
            scope: fakeScope(["http://mcp.test/mcp"]),
            state,
            registry,
            store,
            kinds,
            services,
        });
        const [a, b] = await Promise.all([tools.list(ctxOf()), tools.list(ctxOf())]);
        expect(a).toBe(b);
        expect(await tools.list(ctxOf())).toBe(a);
        expect(server.calls.filter((call) => call.rpc?.method === "initialize")).toHaveLength(1);
        expect(server.calls.filter((call) => call.rpc?.method === "tools/list")).toHaveLength(1);
        expect([...state.sets.keys()]).toEqual([JSON.stringify(["http://mcp.test/mcp"])]);

        // Another run of the job (another preset's modules) gets its own set on the same state.
        const joined = createJobTools({
            job: fakeJob(),
            scope: fakeScope(["internal:dice\nhttp://mcp.test/mcp"]),
            state,
            registry,
            store,
            kinds,
            services,
        });
        const split = createJobTools({
            job: fakeJob(),
            scope: fakeScope(["internal:dice", "http://mcp.test/mcp"]),
            state,
            registry,
            store,
            kinds,
            services,
        });
        expect((await joined.list(ctxOf())).descriptors).toEqual([]);
        expect((await split.list(ctxOf())).descriptors.map((d) => d.name)).toEqual(["rollDice", "echo"]);
        expect(state.sets.size).toBe(3);

        // A request's own end does not end the job's build; the waiter is released.
        const waiting = new AbortController();
        const other = createJobTools({
            job: fakeJob(),
            scope: fakeScope(["http://second.test/mcp"]),
            state,
            registry,
            store,
            kinds,
            services: fakeServices().services,
        });
        const listing = other.list(ctxOf(waiting.signal));
        waiting.abort(new Error("request over"));
        await expect(listing).rejects.toThrow("request over");
        await waitFor(() => state.sets.size === 4);
        expect((await other.list(ctxOf())).descriptors.map((d) => d.name)).toEqual(["echo", "other"]);
        registry.dispose();
    });

    it("call: an unknown name, a tool's own failures as text results, a credential never sent, and a fatal outcome thrown", async () => {
        const secret = "sk-SECRET-7777";
        let answer: "ok" | "error" | "junk" = "ok";
        const { registry, server, store } = registryOver((call, index) =>
            streamable({
                onCall: (c) =>
                    answer === "error"
                        ? rpcAnswer(c, { error: { code: -32000, message: "tool exploded" } })
                        : rpcAnswer(c, {
                              result: { content: answer === "junk" ? "not a list" : [{ type: "text", text: "fine" }] },
                          }),
            })(call, index),
        );
        const fake = fakeServices();
        const job = fakeJob();
        const tools = createJobTools({
            job,
            scope: fakeScope(["internal:dice", "http://mcp.test/mcp"], { secret }),
            state: createJobToolState(),
            registry,
            store,
            kinds,
            services: fake.services,
        });
        const ctx = ctxOf();
        const set = await tools.list(ctx);
        expect(await tools.call(set, "nope", {}, ctx)).toEqual([
            { type: "text", text: "Tool nope not found on any MCP" },
        ]);
        const rolled = (await tools.call(set, "rollDice", { notation: "2d6+3" }, ctx))[0] as { text: string };
        expect(rolled.text).toMatch(/^Rolled 2d6\+3: \d+ \(Details: 2d6\+3: \[\d+, \d+\] \+3 = \d+\)$/);
        expect(await tools.call(set, "echo", { text: "a" }, ctx)).toEqual([{ type: "text", text: "fine" }]);
        answer = "error";
        expect((await tools.call(set, "echo", {}, ctx))[0]).toMatchObject({
            text: expect.stringContaining("Error calling echo"),
        });
        answer = "junk";
        expect(await tools.call(set, "echo", {}, ctx)).toEqual([
            { type: "text", text: "Tool call failed with error: The tool answered a value that is not tool content" },
        ]);
        expect(await tools.call(set, "rollDice", { notation: "5000d6" }, ctx)).toEqual([
            {
                type: "text",
                text: `Tool call failed with error: The notation rolls more than ${MAX_DICE_PER_CALL} dice`,
            },
        ]);

        const sent = server.calls.length;
        expect(await tools.call(set, "echo", { text: `use ${secret}` }, ctx)).toEqual([
            {
                type: "text",
                text: "Tool call failed with error: The tool call carries a stored credential; it is not sent",
            },
        ]);
        expect(await tools.call(set, secret, {}, ctx)).toEqual([
            { type: "text", text: `Tool ${secret} not found on any MCP` },
        ]);
        expect(server.calls).toHaveLength(sent);

        // A throw under the call (the registry shutting down) is the tool's failure, not the job's.
        registry.dispose();
        expect(await tools.call(set, "echo", {}, ctx)).toEqual([
            { type: "text", text: "Tool call failed with error: The server is shutting down" },
        ]);
        expect(fake.fatal()).toBeNull();
        // A latched failure and an aborted call throw out as they are.
        const aborted = new AbortController();
        aborted.abort(new Error("stop"));
        await expect(tools.call(set, "rollDice", { notation: "1d1" }, ctxOf(aborted.signal))).rejects.toThrow(
            "request aborted",
        );
        expect(fake.fatal()).not.toBeNull();
        await expect(tools.call(set, "rollDice", { notation: "1d1" }, ctx)).rejects.toBe(fake.fatal());
    });

    it("tab kinds: no tab within the grace offers nothing, an attached tab answers mcpList and mcpTool, and a callback's outcomes are classified", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { registry, store } = registryOver(() => accepted());
        const detached = fakeServices();
        const away = createJobTools({
            job: fakeJob({ attached: () => false }),
            scope: fakeScope(["internal:fs", "plugin:p"]),
            state: createJobToolState(),
            registry,
            store,
            kinds,
            services: detached.services,
        });
        const listing = away.list(ctxOf());
        await vi.advanceTimersByTimeAsync(TAB_ATTACH_GRACE_MS + 200);
        expect((await listing).descriptors).toEqual([]);
        expect(detached.log.callbacks).toEqual([]);
        expect(warn.mock.calls.map((call) => String(call[1]))).toEqual([
            "internal:fs offers no tools to this job: no tab is connected",
            "MCP: Failed to initialize plugin:p: Invalid MCP URL",
        ]);
        vi.useRealTimers();

        let attached = true;
        let toolOutcome: Answer = { ok: true, value: [{ type: "text", text: "content" }] };
        const fake = fakeServices({
            callbacks: (name, payload) => {
                if (name === "mcpList") {
                    const identifier = (payload as { identifier: string }).identifier;
                    return {
                        ok: true,
                        value: [
                            {
                                name: `${identifier.startsWith("plugin:") ? "plugin" : "fs"}_read`,
                                description: "d",
                                inputSchema: {},
                            },
                            { name: 7 },
                            { name: "bad", inputSchema: "nope" },
                        ],
                    };
                }
                return toolOutcome;
            },
        });
        const tools = createJobTools({
            job: fakeJob({ attached: () => attached, mcpTools: ["plugin:p"] }),
            scope: fakeScope(["internal:fs", "plugin:p", "plugin:q", "internal:googlesearch"]),
            state: createJobToolState(),
            registry,
            store,
            kinds,
            services: fake.services,
        });
        const ctx = ctxOf();
        const set = await tools.list(ctx);
        expect(set.descriptors).toEqual([
            { name: "fs_read", description: "d", inputSchema: {} },
            { name: "plugin_read", description: "d", inputSchema: {} },
            { name: "fs_read", description: "d", inputSchema: {} },
        ]);
        expect(fake.log.callbacks).toEqual([
            { name: "mcpList", payload: { identifier: "internal:fs" }, timeoutMs: TAB_MCP_TIMEOUT_MS },
            { name: "mcpList", payload: { identifier: "plugin:p" }, timeoutMs: TAB_MCP_TIMEOUT_MS },
            { name: "mcpList", payload: { identifier: "internal:googlesearch" }, timeoutMs: TAB_MCP_TIMEOUT_MS },
        ]);
        expect(set.routes.get("fs_read")).toMatchObject({ kind: "tab", identifier: "internal:fs" });

        expect(await tools.call(set, "plugin_read", { path: "/" }, ctx)).toEqual([{ type: "text", text: "content" }]);
        expect(fake.log.callbacks.at(-1)).toEqual({
            name: "mcpTool",
            payload: { identifier: "plugin:p", tool: "plugin_read", args: { path: "/" } },
            timeoutMs: TAB_MCP_TIMEOUT_MS,
        });
        toolOutcome = { ok: false, error: "the hook threw" };
        expect(await tools.call(set, "fs_read", {}, ctx)).toEqual([
            { type: "text", text: "Tool call failed with error: the hook threw" },
        ]);
        toolOutcome = { ok: true, value: { not: "content" } };
        expect((await tools.call(set, "fs_read", {}, ctx))[0]).toMatchObject({
            text: expect.stringContaining("not tool content"),
        });

        vi.useFakeTimers();
        attached = false;
        const noTab = tools.call(set, "fs_read", {}, ctx);
        await vi.advanceTimersByTimeAsync(TAB_ATTACH_GRACE_MS + 200);
        expect(await noTab).toEqual([
            { type: "text", text: "Tool call failed with error: The owner's tab is not connected" },
        ]);
        vi.useRealTimers();
        attached = true;

        toolOutcome = new Error("The mcpTool callback failed (barrier): stale");
        await expect(tools.call(set, "fs_read", {}, ctx)).rejects.toThrow("barrier");
        expect(fake.fatal()?.message).toContain("barrier");

        // A tab's list that fails or is too large fails the build.
        const failing = createJobTools({
            job: fakeJob(),
            scope: fakeScope(["internal:fs"]),
            state: createJobToolState(),
            registry,
            store,
            kinds,
            services: fakeServices({ callbacks: () => ({ ok: false, error: "picker dismissed" }) }).services,
        });
        await expect(failing.list(ctxOf())).rejects.toThrow("MCP internal:fs: picker dismissed");
        const huge = createJobTools({
            job: fakeJob(),
            scope: fakeScope(["internal:fs"]),
            state: createJobToolState(),
            registry,
            store,
            kinds,
            services: fakeServices({
                callbacks: () => ({
                    ok: true,
                    value: Array.from({ length: MAX_TOOL_LIST_TOOLS + 1 }, (_, i) => tool(`t${i}`)),
                }),
            }).services,
        });
        await expect(huge.list(ctxOf())).rejects.toThrow("too large");
        registry.dispose();
    });

    it("charges the job's budget for every attempt across the tool sets of its runs", () => {
        const state = createJobToolState();
        const { registry, store } = registryOver(() => accepted());
        const first = createJobTools({
            job: fakeJob(),
            scope: fakeScope([]),
            state,
            registry,
            store,
            kinds,
            services: fakeServices().services,
        });
        const second = createJobTools({
            job: fakeJob(),
            scope: fakeScope([]),
            state,
            registry,
            store,
            kinds,
            services: fakeServices().services,
        });
        for (let i = 0; i < MAX_JOB_TOOL_CALLS; i++) {
            expect(i % 2 === 0 ? first.charge() : second.charge()).toBe(true);
        }
        expect(first.charge()).toBe(false);
        expect(second.charge()).toBe(false);
        expect(state.attempts).toBe(MAX_JOB_TOOL_CALLS + 2);
        registry.dispose();
    });

    it("runs a login through the job: the page is an openURL notice, the code an alertInput question the client's end withdraws, the record written with the job's write", async () => {
        const store = memoryStore();
        const refreshKind = kind(RESOURCE_KIND.authRefreshes);
        const { registry, server } = registryOver((call, index) => {
            if (call.url === "http://mcp.test/.well-known/oauth-authorization-server") {
                return json({
                    authorization_endpoint: "http://mcp.test/authorize",
                    token_endpoint: "http://mcp.test/token",
                    registration_endpoint: "http://mcp.test/register",
                });
            }
            if (call.url === "http://mcp.test/register") {
                return json({ client_id: "cid", client_secret: "csec" }, 201);
            }
            if (call.url === "https://account.sionyw.com/oauthhelper/api") {
                return json({ success: true, payload: { code: "server-code" } });
            }
            if (call.url === "http://mcp.test/token") {
                return json({ access_token: "logged-in", refresh_token: "rt-new" });
            }
            return call.headers.authorization === "Bearer logged-in"
                ? streamable()(call, index)
                : json({ error: "unauthorized" }, 401);
        }, store);
        const fake = fakeServices({ code: "the-code" });
        const job = fakeJob({ write: (build) => store.applyChanges(build() as never, { epoch: store.epoch() }) });
        const tools = createJobTools({
            job,
            scope: fakeScope(["http://mcp.test/mcp"]),
            state: createJobToolState(),
            registry,
            store,
            kinds,
            services: fake.services,
        });
        const set = await tools.list(ctxOf());
        expect(set.descriptors.map((d) => d.name)).toEqual(["echo"]);
        expect(fake.log.notices).toEqual([
            {
                kind: "openURL",
                payload: { url: expect.stringMatching(/^http:\/\/mcp\.test\/authorize\?client_id=cid/) },
            },
        ]);
        expect(fake.log.questions).toHaveLength(1);
        expect(fake.log.questions[0].question).toEqual({
            kind: "alertInput",
            payload: { message: "Input Authorization Code" },
        });
        expect(fake.log.questions[0].signal).toBeInstanceOf(AbortSignal);
        expect(fake.log.questions[0].signal!.aborted).toBe(false);
        expect(server.calls.find((call) => call.url === "https://account.sionyw.com/oauthhelper/api")!.rpc).toEqual({
            code: "the-code",
        });
        expect(store.get(refreshKind, SINGLETON_RESOURCE_ID)!.data).toEqual([
            {
                url: "http://mcp.test/mcp",
                clientId: "cid",
                clientSecret: "csec",
                refreshToken: "rt-new",
                tokenUrl: "http://mcp.test/token",
            },
        ]);
        // The client's end withdraws the question's signal.
        registry.dispose();
        expect(fake.log.questions[0].signal!.aborted).toBe(true);
        store.close();
    });

    it("stores a rotated refresh token with the job's write, keeping the client data, and a recreated client refreshes with it and stores the next", async () => {
        const store = memoryStore();
        const refreshKind = kind(RESOURCE_KIND.authRefreshes);
        const row = store.get(refreshKind, SINGLETON_RESOURCE_ID)!;
        const other = { url: "http://other.test/mcp", refreshToken: "keep", tokenUrl: "http://other.test/token" };
        store.applyChanges({
            ops: [
                {
                    kind: refreshKind,
                    id: SINGLETON_RESOURCE_ID,
                    baseRevision: row.revision,
                    data: [
                        {
                            url: "http://mcp.test/mcp",
                            clientId: "c1",
                            clientSecret: "s1",
                            refreshToken: "r1",
                            tokenUrl: "http://mcp.test/token",
                        },
                        other,
                    ],
                },
            ],
        });
        // A token endpoint that rotates: each grant spends its token and issues the next.
        const auth = { current: "r1", issued: 0, valid: null as string | null, grants: [] as Record<string, string>[] };
        const handler: Handler = (call, index) => {
            if (call.url === "http://mcp.test/token") {
                const form = Object.fromEntries(new URLSearchParams(call.raw));
                auth.grants.push(form);
                if (form.refresh_token !== auth.current) {
                    return json({ error: "invalid_grant" }, 400);
                }
                auth.issued++;
                auth.valid = `a${auth.issued}`;
                auth.current = `r${auth.issued + 1}`;
                return json({ access_token: auth.valid, refresh_token: auth.current });
            }
            if (call.url.startsWith("http://mcp.test/.well-known/")) {
                throw new Error("no full login in this test");
            }
            return auth.valid && call.headers.authorization === `Bearer ${auth.valid}`
                ? streamable()(call, index)
                : json({ error: "unauthorized" }, 401);
        };
        const listOnce = async () => {
            const { registry } = registryOver(handler, store);
            const tools = createJobTools({
                job: fakeJob({ write: (build) => store.applyChanges(build() as never, { epoch: store.epoch() }) }),
                scope: fakeScope(["http://mcp.test/mcp"]),
                state: createJobToolState(),
                registry,
                store,
                kinds,
                services: fakeServices().services,
            });
            const set = await tools.list(ctxOf());
            registry.dispose();
            return set.descriptors.map((d) => d.name);
        };
        const stored = () => store.get(refreshKind, SINGLETON_RESOURCE_ID)!.data;

        expect(await listOnce()).toEqual(["echo"]);
        expect(auth.grants).toEqual([
            { grant_type: "refresh_token", refresh_token: "r1", client_id: "c1", client_secret: "s1" },
        ]);
        expect(stored()).toEqual([
            {
                url: "http://mcp.test/mcp",
                clientId: "c1",
                clientSecret: "s1",
                refreshToken: "r2",
                tokenUrl: "http://mcp.test/token",
            },
            other,
        ]);

        // A new registry (a restart: a new client, no access token) reads the stored record.
        auth.valid = null;
        expect(await listOnce()).toEqual(["echo"]);
        expect(auth.grants.map((grant) => grant.refresh_token)).toEqual(["r1", "r2"]);
        expect(auth.grants[1]).toMatchObject({ client_id: "c1", client_secret: "s1" });
        expect(stored()).toEqual([
            {
                url: "http://mcp.test/mcp",
                clientId: "c1",
                clientSecret: "s1",
                refreshToken: "r3",
                tokenUrl: "http://mcp.test/token",
            },
            other,
        ]);
        store.close();
    });
});

describe("internal:dice on the server", () => {
    it("rolls as the tab's adapter does, with the server's bounds on the notation and the dice", async () => {
        expect(rollDice("2d6+3", () => 0.999)).toEqual({ total: 15, details: "2d6+3: [6, 6] +3 = 15" });
        expect(rollDice("d20", () => 0)).toEqual({ total: 1, details: "1d20: [1] = 1" });
        expect(rollDice("1d4-1 and 2d2", () => 0.5)).toEqual({
            total: 6,
            details: "1d4-1: [3] -1 = 2; 2d2: [2, 2] = 4",
        });
        expect(rollDice("no dice here")).toEqual({ total: 0, details: "" });
        expect(() => rollDice(`${"1".repeat(MAX_DICE_NOTATION_CHARS)}d6`)).toThrow(
            `longer than ${MAX_DICE_NOTATION_CHARS}`,
        );
        expect(() => rollDice(`${MAX_DICE_PER_CALL + 1}d6`)).toThrow(`more than ${MAX_DICE_PER_CALL} dice`);
        // The dice of every term count together (`+500` is a modifier; a space separates terms).
        expect(rollDice("600d6+500 1d4", () => 0).total).toBe(1101);
        expect(() => rollDice("600d6 500d4")).toThrow(`more than ${MAX_DICE_PER_CALL} dice`);
        expect(rollDice(`${MAX_DICE_PER_CALL}d1`).total).toBe(MAX_DICE_PER_CALL);
        expect(await callDiceTool("rollDice", { notation: "1d1" })).toEqual([
            { type: "text", text: "Rolled 1d1: 1 (Details: 1d1: [1] = 1)" },
        ]);
        // No notation: the tab answers the same text for an undefined notation.
        expect(await callDiceTool("rollDice", {})).toEqual([{ type: "text", text: "Rolled undefined: 0 (Details: )" }]);
        await expect(callDiceTool("other", {})).rejects.toThrow("Unknown tool: other");
    });
});

describe("a question with a withdrawing signal (the channel hub)", () => {
    function link() {
        const sent: Record<string, unknown>[] = [];
        const hub = createChannelHub();
        const opened = hub.open({
            jobId: "j",
            clientId: "tab",
            epoch: "e",
            targets: { chatRef: { chaId: "c", chatId: "k" }, presetId: "p", modelPresetId: "m", personaId: "u" },
            hooks: NO_GENERATION_HOOKS,
            send: (event) => {
                sent.push(event as unknown as Record<string, unknown>);
                return true;
            },
            hydrate: () => [],
            ownerAttached: () => true,
        });
        return { ...opened, sent };
    }

    it("withdraws a dispatched question with one cancel frame, ignores its late answer, and leaves the lane free for the next", async () => {
        const { channel, handleMessage, sent, close } = link();
        const controller = new AbortController();
        const asked = channel.ask({ kind: "alertInput", payload: { message: "code" } }, { signal: controller.signal });
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        const id = sent.find((event) => event.type === "question")!.id as string;
        controller.abort();
        expect(await asked).toEqual({ outcome: "aborted", error: "The request ended" });
        expect(sent.filter((event) => event.type === "cancel")).toEqual([{ type: "cancel", epoch: "e", id }]);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        handleMessage({ type: "answer", id, outcome: "answered", value: "late" });
        const next = channel.ask({ kind: "alertInput", payload: { message: "next" } });
        const nextId = sent.filter((event) => event.type === "question").at(-1)!.id as string;
        expect(nextId).not.toBe(id);
        handleMessage({ type: "answer", id: nextId, outcome: "answered", value: "ok" });
        expect(await next).toEqual({ outcome: "answered", value: "ok" });
        close("done");
    });

    it("withdraws a queued question without a cancel frame, and an already-aborted signal settles at once without a frame", async () => {
        const { channel, handleMessage, sent, close } = link();
        const first = channel.ask({ kind: "alertInput", payload: { message: "first" } });
        const controller = new AbortController();
        const queued = channel.ask(
            { kind: "alertInput", payload: { message: "queued" } },
            { signal: controller.signal },
        );
        expect(sent.filter((event) => event.type === "question")).toHaveLength(1);
        controller.abort();
        expect(await queued).toEqual({ outcome: "aborted", error: "The request ended" });
        expect(sent.filter((event) => event.type === "cancel")).toEqual([]);
        const done = new AbortController();
        done.abort();
        expect(
            await channel.ask({ kind: "alertInput", payload: { message: "never" } }, { signal: done.signal }),
        ).toEqual({
            outcome: "aborted",
            error: "The request ended",
        });
        expect(sent.filter((event) => event.type === "question")).toHaveLength(1);
        const id = sent[0].id as string;
        handleMessage({ type: "answer", id, outcome: "answered", value: "first!" });
        expect(await first).toEqual({ outcome: "answered", value: "first!" });
        close("done");
    });
});

describe("the bindings' ask with a withdrawing signal", () => {
    function setup(outcome: "aborted" | "timedOut" | "disconnected") {
        const store = memoryStore();
        const singleton = (name: string, data: unknown) => {
            const row = store.get(kind(name), SINGLETON_RESOURCE_ID);
            store.applyChanges({
                ops: [{ kind: kind(name), id: SINGLETON_RESOURCE_ID, baseRevision: row?.revision ?? null, data }],
            });
        };
        singleton(RESOURCE_KIND.presets, [{ id: "p", name: "p" }]);
        singleton(RESOURCE_KIND.modelPresets, [{ id: "m", name: "m", aiModel: "gpt-4o" }]);
        singleton(RESOURCE_KIND.personas, [{ id: "u", name: "Uma" }]);
        store.applyChanges({
            ops: [
                {
                    kind: kind(RESOURCE_KIND.characters),
                    id: "c",
                    baseRevision: null,
                    data: { chaId: "c", type: "character", name: "C", firstMessage: "hello" },
                },
            ] as never,
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            // The chat's binding: the job scope checks the context's ids against it.
                            chat: {
                                id: "k",
                                name: "K",
                                modelPresetId: "m",
                                promptPresetId: "p",
                                bindedPersona: "u",
                                message: [{ role: "user", data: "hi", chatId: "m1" }],
                            },
                        },
                    ],
                },
            ],
        });
        const context = {
            characterId: "c",
            chatId: "k",
            presetId: "p",
            modelPresetId: "m",
            personaId: "u",
            mode: "button",
            input: "",
            chatRevision: store.chatRevision("c", "k")!,
        };
        const scope = loadJobScope(store, kinds, context);
        const asked: { signal?: AbortSignal }[] = [];
        const job: RunningJob = {
            id: "job",
            kind: "command",
            context,
            command: { type: "button", data: "" },
            hooks: NO_GENERATION_HOOKS,
            channel: {
                notice() {},
                ask: async (_question, options) => {
                    asked.push({ signal: options?.signal });
                    return { outcome };
                },
                callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
            },
            ownerAttached: () => true,
            epoch: store.epoch(),
            signal: new AbortController().signal,
            emit() {},
            emitRecords: () => [],
            write: (build) => store.applyChanges(build() as never, { epoch: store.epoch() }),
            onClientMessage: () => () => {},
        };
        const bindings = createLuaBindings({
            job,
            scope,
            store,
            kinds,
            rootDir: "/nonexistent",
            savePath: "/nonexistent/save",
            llm: {} as never,
            tokens: { count: async () => 1, encode: async () => [] } as never,
            runCharacterId: "c",
            engineCharacterId: "c",
        });
        const ctx: HostContext = {
            identity: { characterId: "c", chatId: "k", presetId: "p", personaId: "u" },
            access: "lowLevel",
            signal: new AbortController().signal,
            regex: async () => ({ value: false }),
        };
        return { bindings, ctx, asked, store };
    }
    const question: GenerationQuestion = { kind: "alertInput", payload: { message: "Input Authorization Code" } };

    it("raises an ordinary error for a question its own signal withdrew, and a fatal one for a lost or silent owner", async () => {
        const withdrawn = setup("aborted");
        const controller = new AbortController();
        controller.abort();
        await expect(
            withdrawn.bindings.services.ask(question, withdrawn.ctx, { signal: controller.signal }),
        ).rejects.toThrow("The alertInput question ended: aborted");
        expect(withdrawn.asked[0].signal).toBe(controller.signal);
        expect(withdrawn.bindings.fatal()).toBeNull();
        // The same `aborted` outcome without the caller's own withdrawal is the job's failure.
        await expect(
            withdrawn.bindings.services.ask(question, withdrawn.ctx, { signal: new AbortController().signal }),
        ).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(withdrawn.bindings.fatal()).toBeInstanceOf(LuaJobFatalError);
        withdrawn.store.close();

        for (const outcome of ["timedOut", "disconnected"] as const) {
            const lost = setup(outcome);
            const signal = new AbortController();
            signal.abort();
            await expect(
                lost.bindings.services.ask(question, lost.ctx, { signal: signal.signal }),
            ).rejects.toBeInstanceOf(LuaJobFatalError);
            expect(lost.bindings.fatal()?.message).toContain(outcome);
            lost.store.close();
        }
    });
});

describe("McpClient: event framing, the session id, and refresh token rotation", () => {
    /** An event-stream response whose body is `chunks`, as given. */
    const eventStream = (chunks: string[], headers: Record<string, string> = {}) =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(enc.encode(chunk));
                    }
                    controller.close();
                },
            }),
            { status: 200, headers: { "content-type": "text/event-stream", ...headers } },
        );

    it("reads CRLF, CR, and space-less events, takes the session id of an event-stream initialize answer, and sends it on every later request; a later answer's id does not replace it", async () => {
        const server = recorder((call) => {
            const rpc = call.rpc;
            if (rpc?.id === undefined) {
                return accepted();
            }
            const message = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
            switch (rpc.method) {
                case "initialize": {
                    // CRLF line ends, `data:` without the space, the answer split inside a CRLF.
                    const text = `: hello\r\nevent:message\r\ndata:${message(INFO)}\r\n\r\n`;
                    const cut = text.lastIndexOf("\r\n\r\n") + 1;
                    return eventStream([text.slice(0, cut), text.slice(cut)], { "Mcp-Session-Id": "s-1" });
                }
                case "tools/list": {
                    // The JSON split over two data lines, CRLF line ends; another session id on the answer.
                    const body = message({ tools: [tool("echo")] });
                    const half = body.indexOf(',"result"');
                    return eventStream([`data:${body.slice(0, half)}\r\ndata:${body.slice(half)}\r\n\r\n`], {
                        "Mcp-Session-Id": "other",
                    });
                }
                case "tools/call":
                    // CR line ends only.
                    return eventStream([
                        `event: message\rdata: ${message({ content: [{ type: "text", text: "cr" }] })}\r\r`,
                    ]);
                default:
                    return eventStream([`data:${message({})}\n\n`]);
            }
        });
        const mcp = client(server.fetchImpl);
        expect((await mcp.checkHandshake(ioOf())).serverInfo.name).toBe("mock");
        expect(priv(mcp).sessionId).toBe("s-1");
        expect((await mcp.getToolList(ioOf())).map((d) => d.name)).toEqual(["echo"]);
        expect(await mcp.callTool("echo", {}, ioOf())).toEqual([{ type: "text", text: "cr" }]);
        expect(methods(server.calls)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
        expect(server.calls[0].headers["mcp-session-id"]).toBeUndefined();
        expect(server.calls.slice(1).map((call) => call.headers["mcp-session-id"])).toEqual(["s-1", "s-1", "s-1"]);
        expect(priv(mcp).sessionId).toBe("s-1");
        mcp.destroy();
    });

    /** A server that answers 401 until the refresh grant `answer` gives a token, then serves. */
    function refreshServer(answer: () => Response | Promise<Response>) {
        const refreshes: Record<string, string>[] = [];
        let token: string | null = null;
        const server = recorder(async (call, index) => {
            if (call.url === "http://mcp.test/token") {
                const form = Object.fromEntries(new URLSearchParams(call.raw));
                if (form.grant_type === "refresh_token") {
                    refreshes.push(form);
                    const response = await answer();
                    const body = (await response
                        .clone()
                        .json()
                        .catch(() => null)) as { access_token?: unknown } | null;
                    if (response.status === 200 && typeof body?.access_token === "string") {
                        token = body.access_token;
                    }
                    return response;
                }
                token = "logged-in";
                return json({ access_token: "logged-in", refresh_token: "from-login" });
            }
            if (call.url === "http://mcp.test/.well-known/oauth-authorization-server") {
                return json({ error: "not found" }, 404);
            }
            if (call.url === "http://mcp.test/register") {
                return json({ client_id: "cid", client_secret: "csec" }, 201);
            }
            if (call.url === "https://account.sionyw.com/oauthhelper/api") {
                return json({ success: true, payload: { code: "code" } });
            }
            return token && call.headers.authorization === `Bearer ${token}`
                ? streamable()(call, index)
                : json({ error: "unauthorized" }, 401);
        });
        return { ...server, refreshes };
    }
    const stored = { clientId: "c", clientSecret: "s", refreshToken: "r1", tokenUrl: "http://mcp.test/token" };

    it("writes nothing for a refresh answer whose new refresh token is missing, empty, or not a string (the stored one stays)", async () => {
        for (const rotated of [undefined, "", 42, null, { token: "x" }]) {
            const server = refreshServer(() => json({ access_token: "a1", refresh_token: rotated }));
            const mcp = client(server.fetchImpl, { refresh: stored });
            const writeRefresh = vi.fn();
            await mcp.checkHandshake(ioOf({ writeRefresh }));
            expect(server.refreshes.map((form) => form.refresh_token)).toEqual(["r1"]);
            expect(priv(mcp).accessToken).toBe("a1");
            expect(writeRefresh).not.toHaveBeenCalled();
            mcp.destroy();
        }
    });

    it("never stores the refresh token of an answer that gives no usable access token or fails: the full login writes its own record", async () => {
        const answers = [
            () => json({ refresh_token: "r2" }),
            () => json({ access_token: "", refresh_token: "r2" }),
            () => json({ access_token: 7, refresh_token: "r2" }),
            () => json({ access_token: "a1", refresh_token: "r2" }, 400),
        ];
        for (const answer of answers) {
            const server = refreshServer(answer);
            const mcp = client(server.fetchImpl, { refresh: stored });
            const written: unknown[] = [];
            await mcp.checkHandshake(ioOf({ writeRefresh: (entry) => written.push(entry) }));
            expect(written).toEqual([
                {
                    clientId: "cid",
                    clientSecret: "csec",
                    refreshToken: "from-login",
                    tokenUrl: "http://mcp.test/token",
                },
            ]);
            expect(priv(mcp).accessToken).toBe("logged-in");
            mcp.destroy();
        }
    });

    it("writes no rotated token and publishes no access token when the job ends or the client closes while the refresh answer is out", async () => {
        for (const end of ["abort", "close"] as const) {
            let release!: () => void;
            const server = refreshServer(
                () =>
                    new Promise<Response>((resolve) => {
                        release = () => resolve(json({ access_token: "late", refresh_token: "r2" }));
                    }),
            );
            const mcp = client(server.fetchImpl, { refresh: stored });
            const controller = new AbortController();
            const writeRefresh = vi.fn();
            const handshake = mcp.checkHandshake(ioOf({ writeRefresh }, controller.signal));
            await waitFor(() => server.refreshes.length === 1);
            if (end === "abort") {
                controller.abort(new Error("job ended"));
            } else {
                mcp.destroy();
            }
            release();
            if (end === "abort") {
                await expect(handshake).rejects.toThrow("job ended");
            } else {
                await expect(handshake).rejects.toBeInstanceOf(McpClientClosedError);
            }
            await sleep(20);
            expect(writeRefresh).not.toHaveBeenCalled();
            expect(priv(mcp).accessToken).toBeNull();
            mcp.destroy();
        }
    });
});
