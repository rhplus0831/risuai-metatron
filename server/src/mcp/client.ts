import { createHash, randomUUID } from "node:crypto";
import type { RPCToolCallContent, ToolDescriptor } from "../../../shared/llm/request.ts";
import { parseSseEvent, SseFramer } from "../../../shared/mcp/sse.ts";

/**
 * The Node port of `MCPClient` (`src/ts/process/mcp/mcplib.ts`, Phase 5 slice 12): a remote MCP
 * server over `fetch`, with the tab client's wire behaviour (the JSON-RPC bodies and headers,
 * streamable HTTP with the 404 fallback to the legacy SSE transport, `ping` answered, the handshake,
 * `tools/list` pagination with the non-empty cache, `tools/call`, OAuth with dynamic registration
 * and PKCE through the account helper).
 *
 * What differs from the tab client:
 *
 * - no `document` events: an answer is matched by its id in the client's own pending map, registered
 *   before the request that produces it starts;
 * - a pending answer always settles: with the message, or with an RPC error when its stream ends or
 *   fails first, when the legacy SSE stream ends (every pending answer, and the session is reset),
 *   or at `MCP_REQUEST_TIMEOUT_MS`; the caller's signal aborting rejects;
 * - the client belongs to the process, not to a job: every call takes the calling job's I/O
 *   (`McpIo`), which only that call's own work holds (a handshake until it settles). Concurrent
 *   callers share one handshake; when the caller that started it is aborted, the next one starts its
 *   own;
 * - what it reads is bounded: one SSE event or JSON body (`MAX_MCP_MESSAGE_BYTES`), a whole tool
 *   list (`MAX_TOOL_LIST_*`), every OAuth answer (`MAX_OAUTH_BODY_BYTES`, `MCP_OAUTH_TIMEOUT_MS`),
 *   and the time the legacy session stream may take to connect and name its endpoint;
 * - a session that ended while its handshake was still running is not taken as initialized (the
 *   session generation), and a client closed while an owner's question is open settles its callers;
 * - OAuth refresh uses a 200 answer's token (the tab client read it only from a failed answer), the
 *   endpoints a server names must be `http:` or `https:`, and one handshake logs in at most once.
 *
 * Events are framed by `shared/mcp/sse.ts` (CRLF, LF, or CR line ends; `data:` with or without the
 * space), a session id is taken from an `initialize` answer in JSON or as an event stream, and a
 * refresh answer's new refresh token replaces the stored one (Phase 5 Stop D fixes; the tab client
 * does the same). Kept as the tab client has it: a 404 with a session or a 401 with a token resets
 * the session and repeats the request once without them. Prompts, the custom transport, and
 * `debug` are not ported (no server caller).
 */

export const MCP_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const MCP_OAUTH_TIMEOUT_MS = 30_000;
/** How long the client's own answer to a server `ping` may take. */
const MCP_PING_TIMEOUT_MS = 30_000;
/** The longest SSE event or JSON body, in bytes. */
export const MAX_MCP_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_OAUTH_BODY_BYTES = 1024 * 1024;
export const MAX_TOOL_LIST_PAGES = 32;
export const MAX_TOOL_LIST_TOOLS = 512;
export const MAX_TOOL_LIST_BYTES = 1024 * 1024;

const OAUTH_REDIRECT_URL = "https://account.sionyw.com/oauthhelper";
const OAUTH_HELPER_URL = "https://account.sionyw.com/oauthhelper/api";

type JsonRpc = {
    jsonrpc: "2.0";
    id: number | string;
    result?: any;
    error?: { code: number; message: string; data?: unknown };
};

/** `generation`: the session the answer came from (the client's session counter when it was taken). */
type RpcResult = { rpc: JsonRpc; http: { status: number }; generation: number };

/** An OAuth refresh record of one MCP server (`authRefreshes`, without its `url`). */
export type McpRefresh = { clientId?: string; clientSecret?: string; refreshToken?: string; tokenUrl?: string };

/** The calling job's side of one operation; the client keeps none of it after the call. */
export type McpIo = {
    /** The job's (and the calling task's) signal: the call rejects when it aborts. */
    signal: AbortSignal;
    /** Opens the authorization page in the owner's tab. */
    openUrl(url: string): void;
    /** Asks the owner for the authorization code; `cancel` aborting withdraws the question. */
    askCode(cancel: AbortSignal): Promise<string>;
    /** Stores the refresh record of a completed login. */
    writeRefresh(entry: McpRefresh): void;
};

export type McpClientDeps = {
    fetchImpl?: typeof fetch;
    /** The stored refresh record of this server, as it is now. */
    readRefresh(): McpRefresh | undefined;
    requestTimeoutMs?: number;
};

export type McpServerInfo = {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo: { name: string; version: string };
    instructions?: string;
};

/** The client was closed (idle expiry, a new database epoch, shutdown) while a call was using it. */
export class McpClientClosedError extends Error {
    constructor() {
        super("The MCP client was closed");
        this.name = "McpClientClosedError";
    }
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error("request aborted");
}

function isHttpUrl(value: unknown): value is string {
    if (typeof value !== "string") {
        return false;
    }
    try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A response's text, at most `limit` bytes; a longer body is cancelled and throws. */
async function readBounded(response: Response, limit: number): Promise<string> {
    if (!response.body) {
        return "";
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return text + decoder.decode();
            }
            bytes += value.byteLength;
            if (bytes > limit) {
                throw new Error("The MCP server's answer is too large");
            }
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        // Releases the connection whatever ended the read.
        reader.cancel().catch(() => {});
        try {
            reader.releaseLock();
        } catch {
            // The stream is already released.
        }
    }
}

function discard(response: Response): void {
    response.body?.cancel().catch(() => {});
}

export class McpClient {
    readonly url: string;
    private readonly fetchImpl: typeof fetch;
    private readonly deps: McpClientDeps;
    private readonly requestTimeoutMs: number;
    /** Aborted by `destroy`: every fetch and stream of the client ends with it. */
    private readonly closing = new AbortController();
    private closed = false;

    private sessionId: string | null = null;
    private accessToken: string | null = null;
    private sseEndpoint: string | null = null;
    private protocolVersion: "2025-03-26" | "2024-11-05" = "2025-03-26";
    private serverInfo: McpServerInfo | null = null;
    /** Counts the sessions: a handshake publishes only into the session it initialized. */
    private generation = 0;
    /** The legacy transport's session stream: the reader that is still this one owns the session. */
    private legacy: AbortController | null = null;
    /** The answers waited for, by request id (`"connected"` for the legacy endpoint event). */
    private readonly pending = new Map<string | number, (rpc: JsonRpc) => void>();
    /** The handshake in progress: `aborted` when the caller that started it was aborted. */
    private handshaking: Promise<{ ok: true } | { ok: false; error: unknown; aborted: boolean }> | null = null;
    private cachedTools: ToolDescriptor[] = [];

    constructor(url: string, deps: McpClientDeps) {
        this.url = url;
        this.deps = deps;
        this.fetchImpl = deps.fetchImpl ?? fetch;
        this.requestTimeoutMs = deps.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** Ends the client for good: every stream and fetch aborted, every pending answer settled. */
    destroy(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.reset("The MCP client was closed");
        this.closing.abort(new McpClientClosedError());
    }

    /** `MCPClient.destroy()` of the tab client: the session, its token, and its streams are dropped. */
    private reset(message: string): void {
        this.generation++;
        this.serverInfo = null;
        this.sessionId = null;
        this.accessToken = null;
        this.sseEndpoint = null;
        const legacy = this.legacy;
        this.legacy = null;
        legacy?.abort(new Error(message));
        this.failPending(message);
    }

    private failPending(message: string): void {
        for (const [id, settle] of [...this.pending]) {
            settle({ jsonrpc: "2.0", id, error: { code: -32000, message } });
        }
    }

    /**
     * Waits for the answer `id`: registered now, settled once (the message, `fail`, the timeout, or
     * a failed session), and rejected when `signal` aborts.
     */
    private waitFor(
        id: string | number,
        signal: AbortSignal,
        timeoutMs: number,
    ): {
        answer: Promise<JsonRpc>;
        /** The session counter when the answer was settled (a reset right after it is a later session). */
        generation: () => number;
        fail: (message: string, code?: number) => void;
        drop: () => void;
    } {
        let settle!: (rpc: JsonRpc) => void;
        let reject!: (error: unknown) => void;
        const answer = new Promise<JsonRpc>((resolve, rejectAnswer) => {
            settle = resolve;
            reject = rejectAnswer;
        });
        // A caller that stops waiting (its own failure) leaves no unhandled rejection behind.
        answer.catch(() => {});
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            if (this.pending.get(id) === entry) {
                this.pending.delete(id);
            }
        };
        let generation = this.generation;
        const entry = (rpc: JsonRpc) => {
            finish();
            generation = this.generation;
            settle(rpc);
        };
        const fail = (message: string, code = -32000) => entry({ jsonrpc: "2.0", id, error: { code, message } });
        const onAbort = () => {
            finish();
            reject(abortReason(signal));
        };
        const timer = setTimeout(() => fail("The MCP request timed out", -32001), timeoutMs);
        this.pending.set(id, entry);
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
        // `drop`: the answer came another way (a JSON body); nothing waits for this entry.
        return { answer, generation: () => generation, fail, drop: finish };
    }

    /**
     * Reads an SSE stream (`connectSSE`): an `endpoint` event settles `"connected"`, a `ping` is
     * answered, any other message settles the answer with its id. Resolves when the stream ends,
     * rejects when it fails or an event is too large.
     */
    private async readSse(stream: ReadableStream<Uint8Array>): Promise<void> {
        const reader = stream.getReader();
        // Events are framed in bytes (`shared/mcp/sse.ts`: CRLF, LF, or CR line ends), so an event is
        // measured and decoded whole.
        const framer = new SseFramer((event) => this.handleEvent(event), MAX_MCP_MESSAGE_BYTES);
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    return;
                }
                framer.push(value);
            }
        } finally {
            reader.cancel().catch(() => {});
            try {
                reader.releaseLock();
            } catch {
                // The stream is already released.
            }
        }
    }

    private handleEvent(part: string): void {
        const parsed = parseSseEvent(part);
        const data = parsed.data.trim();
        const eventName = parsed.event.trim();
        if (!data) {
            return;
        }
        if (eventName === "endpoint") {
            this.pending.get("connected")?.({ jsonrpc: "2.0", id: "connected", result: { endpoint: data } });
            return;
        }
        let message: unknown;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (!isPlainObject(message)) {
            return;
        }
        const id = message.id;
        if (message.method === "ping") {
            if (typeof id === "string" || typeof id === "number") {
                this.answerPing(id);
            }
            return;
        }
        if (typeof id === "string" || typeof id === "number") {
            this.pending.get(id)?.(message as unknown as JsonRpc);
        }
    }

    /** A server `ping` is the session's, not a job's: answered with the client's own bounded request. */
    private answerPing(id: string | number): void {
        const signal = AbortSignal.any([this.closing.signal, AbortSignal.timeout(MCP_PING_TIMEOUT_MS)]);
        this.post({ jsonrpc: "2.0", id, result: {} }, signal)
            .then(discard)
            .catch(() => {});
    }

    private post(body: unknown, signal: AbortSignal): Promise<Response> {
        const headers: Record<string, string> = this.sseEndpoint
            ? { "Content-Type": "application/json", Accept: "*/*" }
            : { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
        if (this.sessionId) {
            headers["Mcp-Session-Id"] = this.sessionId;
        }
        if (this.accessToken) {
            headers["Authorization"] = `Bearer ${this.accessToken}`;
        }
        return this.fetchImpl(this.sseEndpoint ?? this.url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
        });
    }

    /**
     * One JSON-RPC request (`MCPClient.request`). A transport failure is an RPC error with HTTP
     * status 500, as in the tab client; only the caller's abort (or the client's end) rejects.
     */
    private async request(
        method: string,
        params: unknown,
        signal: AbortSignal,
        options: { notification?: boolean; init?: boolean; retried?: boolean } = {},
    ): Promise<RpcResult> {
        if (this.closed) {
            throw new McpClientClosedError();
        }
        const id = randomUUID();
        const body: Record<string, unknown> = { jsonrpc: "2.0", id, method, params };
        if (options.notification) {
            delete body.params;
            delete body.id;
        } else if (!params) {
            delete body.params;
        }
        // The fetch and its stream end with the caller, the client, or the deadline.
        const exchange = new AbortController();
        const deadline = setTimeout(
            () => exchange.abort(new DOMException("The MCP request timed out", "TimeoutError")),
            this.requestTimeoutMs,
        );
        const fetchSignal = AbortSignal.any([signal, this.closing.signal, exchange.signal]);
        const waiting = options.notification ? null : this.waitFor(id, signal, this.requestTimeoutMs);
        try {
            const legacy = this.sseEndpoint !== null;
            const hadSession = this.sessionId !== null;
            const hadToken = this.accessToken !== null;
            const response = await this.post(body, fetchSignal);
            const http = { status: response.status };

            if (legacy) {
                discard(response);
                if (!waiting) {
                    return { rpc: { jsonrpc: "2.0", id, result: null }, http, generation: this.generation };
                }
                if (response.status > 299) {
                    waiting.fail(response.statusText, response.status);
                }
                // The answer arrives on the session stream.
                const rpc = await waiting.answer;
                return { rpc, http: { status: 200 }, generation: waiting.generation() };
            }

            if (
                !options.retried &&
                ((hadSession && response.status === 404) || (hadToken && response.status === 401))
            ) {
                discard(response);
                waiting?.drop();
                this.reset("The MCP session ended");
                return await this.request(method, params, signal, { ...options, retried: true });
            }

            const contentType = response.headers.get("Content-Type") || "";
            if (contentType.includes("text/event-stream") && response.body && waiting) {
                if (options.init && response.headers.has("Mcp-Session-Id")) {
                    this.sessionId = response.headers.get("Mcp-Session-Id");
                }
                // This stream belongs to this request: its end without the answer settles it.
                void this.readSse(response.body).then(
                    () => waiting.fail("The MCP stream ended without an answer"),
                    (error) => waiting.fail(error instanceof Error ? error.message : "The MCP stream failed"),
                );
                try {
                    const rpc = await waiting.answer;
                    return { rpc, http, generation: waiting.generation() };
                } finally {
                    // Answered, timed out, or abandoned: the stream is not read further.
                    exchange.abort(new Error("The MCP request is over"));
                }
            }
            if (!contentType.includes("application/json")) {
                discard(response);
                const rpc: JsonRpc = {
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32603, message: "Invalid Content-Type", data: { contentType } },
                };
                waiting?.drop();
                return { rpc, http, generation: this.generation };
            }
            if (options.init && response.headers.has("Mcp-Session-Id")) {
                this.sessionId = response.headers.get("Mcp-Session-Id");
            }
            // A JSON body is bounded in bytes by the same number.
            const text = await readBounded(response, MAX_MCP_MESSAGE_BYTES);
            const rpc = JSON.parse(text) as JsonRpc;
            waiting?.drop();
            return { rpc, http, generation: this.generation };
        } catch (error) {
            waiting?.drop();
            if (signal.aborted) {
                throw abortReason(signal);
            }
            if (this.closed) {
                throw new McpClientClosedError();
            }
            return {
                rpc: { jsonrpc: "2.0", id: "", error: { code: 500, message: "Internal Error" } },
                http: { status: 500 },
                generation: this.generation,
            };
        } finally {
            clearTimeout(deadline);
        }
    }

    /** The legacy transport's session stream: `GET`, then the `endpoint` event names where to POST. */
    private async connectLegacy(signal: AbortSignal): Promise<void> {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (this.sessionId) {
            headers["Mcp-Session-Id"] = this.sessionId;
        }
        if (this.accessToken) {
            headers["Authorization"] = `Bearer ${this.accessToken}`;
        }
        // The stream outlives this call: once connected it ends with the client or the session, not
        // with the caller. Until then the caller's abort ends it.
        const session = new AbortController();
        const onAbort = () => session.abort(abortReason(signal));
        if (signal.aborted) {
            throw abortReason(signal);
        }
        signal.addEventListener("abort", onAbort, { once: true });
        // One deadline for the whole connection, from the GET to the endpoint event; a connected
        // session has none.
        const establishing = setTimeout(
            () => session.abort(new Error("The MCP session stream did not connect in time")),
            this.requestTimeoutMs,
        );
        try {
            const connection = await this.fetchImpl(this.url, {
                method: "GET",
                headers,
                signal: AbortSignal.any([this.closing.signal, session.signal]),
            });
            if (connection.status !== 200 || !connection.body) {
                discard(connection);
                throw new Error(`Failed to connect to MCP server: ${connection.status} ${connection.statusText}`);
            }
            const connected = this.waitFor("connected", signal, this.requestTimeoutMs);
            this.legacy?.abort(new Error("The MCP session was replaced"));
            this.legacy = session;
            const ended = (message: string) => {
                // Only the reader that is still the session's ends it: an old one changes nothing.
                if (this.legacy === session) {
                    this.reset(message);
                }
            };
            void this.readSse(connection.body).then(
                () => ended("The MCP session stream ended"),
                () => ended("The MCP session stream failed"),
            );
            const rpc = await connected.answer;
            const endpoint = rpc.result?.endpoint;
            if (typeof endpoint !== "string" || !endpoint) {
                throw new Error("Failed to get endpoint from MCP server");
            }
            if (this.legacy !== session) {
                throw new Error("The MCP session ended");
            }
            this.sseEndpoint = `${new URL(this.url).origin}${endpoint}`;
        } catch (error) {
            session.abort(new Error("The MCP handshake failed"));
            if (this.legacy === session) {
                this.reset("The MCP handshake failed");
            }
            if (signal.aborted) {
                throw abortReason(signal);
            }
            throw error;
        } finally {
            clearTimeout(establishing);
            signal.removeEventListener("abort", onAbort);
        }
    }

    private async handshake(io: McpIo): Promise<void> {
        const initialize = () =>
            this.request(
                "initialize",
                {
                    protocolVersion: this.protocolVersion,
                    capabilities: {},
                    clientInfo: { name: "RS-MCP-CLIENT", version: "1.0.0" },
                },
                io.signal,
                { init: true },
            );
        // One login at most: a server that still answers 401 after it fails the handshake.
        for (let attempt = 0; ; attempt++) {
            this.protocolVersion = "2025-03-26";
            let { rpc, http, generation } = await initialize();
            if (http.status === 404) {
                this.protocolVersion = "2024-11-05";
                await this.connectLegacy(io.signal);
                ({ rpc, http, generation } = await initialize());
            }
            if (http.status === 401) {
                if (attempt > 0) {
                    throw new Error("The MCP server refused the authorization");
                }
                await this.oauthLogin(io);
                continue;
            }
            const result = rpc?.result;
            if (!isPlainObject(result) || !isPlainObject(result.serverInfo)) {
                throw new Error("MCP Handshake Failed");
            }
            // `generation` is the session this answer came from: if that session ended since (its
            // stream closed right after the answer, or during the notification), nothing is published.
            const ended = () => {
                if (this.closed) {
                    throw new McpClientClosedError();
                }
                if (this.generation !== generation) {
                    throw new Error("The MCP session ended during the handshake");
                }
            };
            ended();
            await this.request("notifications/initialized", null, io.signal, { notification: true });
            ended();
            if (result.protocolVersion === "2025-03-26" || result.protocolVersion === "2024-11-05") {
                this.protocolVersion = result.protocolVersion;
            }
            this.serverInfo = result as unknown as McpServerInfo;
            return;
        }
    }

    /**
     * `checkHandshake`: the server's info, after one shared handshake. A waiter whose leader was
     * aborted starts its own; a handshake that failed for another reason fails every waiter.
     */
    async checkHandshake(io: McpIo): Promise<McpServerInfo> {
        while (true) {
            if (this.closed) {
                throw new McpClientClosedError();
            }
            if (io.signal.aborted) {
                throw abortReason(io.signal);
            }
            if (this.serverInfo) {
                return this.serverInfo;
            }
            if (!this.handshaking) {
                const run = this.handshake(io).then(
                    () => ({ ok: true }) as const,
                    (error: unknown) => ({ ok: false, error, aborted: io.signal.aborted }) as const,
                );
                this.handshaking = run;
                void run.finally(() => {
                    if (this.handshaking === run) {
                        this.handshaking = null;
                    }
                });
            }
            const outcome = await this.untilOver(this.handshaking, io);
            if (!outcome.ok && !outcome.aborted) {
                throw outcome.error;
            }
        }
    }

    /** `promise`, unless the caller is aborted or the client is closed first (both reject). */
    private untilOver<T>(promise: Promise<T>, io: McpIo): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const clear = () => {
                io.signal.removeEventListener("abort", onAbort);
                this.closing.signal.removeEventListener("abort", onClose);
            };
            const onAbort = () => {
                clear();
                reject(abortReason(io.signal));
            };
            const onClose = () => {
                clear();
                reject(new McpClientClosedError());
            };
            if (io.signal.aborted) {
                reject(abortReason(io.signal));
                return;
            }
            if (this.closing.signal.aborted) {
                reject(new McpClientClosedError());
                return;
            }
            io.signal.addEventListener("abort", onAbort, { once: true });
            this.closing.signal.addEventListener("abort", onClose, { once: true });
            promise.then(
                (value) => {
                    clear();
                    resolve(value);
                },
                (error) => {
                    clear();
                    reject(error);
                },
            );
        });
    }

    /** One bounded OAuth exchange: the status and the JSON body (undefined when it is not JSON). */
    private async oauthFetch(url: string, init: RequestInit, io: McpIo): Promise<{ status: number; json: any }> {
        const signal = AbortSignal.any([io.signal, this.closing.signal, AbortSignal.timeout(MCP_OAUTH_TIMEOUT_MS)]);
        let response: Response;
        let text: string;
        try {
            response = await this.fetchImpl(url, { ...init, signal });
            text = await readBounded(response, MAX_OAUTH_BODY_BYTES);
        } catch (error) {
            if (io.signal.aborted) {
                throw abortReason(io.signal);
            }
            throw error;
        }
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        return { status: response.status, json };
    }

    /** `oauthLogin`: the stored refresh token first, else registration, PKCE, and the owner's code. */
    private async oauthLogin(io: McpIo): Promise<void> {
        const stored = this.deps.readRefresh();
        if (stored && isHttpUrl(stored.tokenUrl)) {
            const answer = await this.oauthFetch(
                stored.tokenUrl,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        grant_type: "refresh_token",
                        refresh_token: stored.refreshToken ?? "",
                        client_id: stored.clientId ?? "",
                        client_secret: stored.clientSecret ?? "",
                    }).toString(),
                },
                io,
            );
            const token = answer.status === 200 ? answer.json?.access_token : undefined;
            if (typeof token === "string" && token !== "") {
                // A rotated refresh token replaces the stored one (the old one may be spent).
                const rotated = answer.json?.refresh_token;
                if (typeof rotated === "string" && rotated !== "") {
                    this.fenceIo(io);
                    io.writeRefresh({
                        ...(stored.clientId !== undefined ? { clientId: stored.clientId } : {}),
                        ...(stored.clientSecret !== undefined ? { clientSecret: stored.clientSecret } : {}),
                        refreshToken: rotated,
                        tokenUrl: stored.tokenUrl,
                    });
                }
                this.publishToken(token);
                return;
            }
        }

        const discovery = new URL(this.url);
        discovery.pathname = "/.well-known/oauth-authorization-server";
        const discovered = await this.oauthFetch(
            discovery.toString(),
            { method: "GET", headers: { Accept: "application/json" } },
            io,
        );
        let endpoints: Record<string, unknown> = {
            authorization_endpoint: discovery.origin + "/authorize",
            token_endpoint: discovery.origin + "/token",
            registration_endpoint: discovery.origin + "/register",
        };
        if (discovered.status === 200 && isPlainObject(discovered.json)) {
            endpoints = discovered.json;
        }
        const { authorization_endpoint, token_endpoint, registration_endpoint } = endpoints;
        // The server names these: none of them may be anything but a web address.
        if (!isHttpUrl(authorization_endpoint) || !isHttpUrl(token_endpoint) || !isHttpUrl(registration_endpoint)) {
            throw new Error("The MCP server's OAuth endpoints are not web addresses");
        }

        const registered = await this.oauthFetch(
            registration_endpoint,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({
                    client_name: "RS-MCP-CLIENT",
                    redirect_uris: [OAUTH_REDIRECT_URL],
                    response_types: ["code"],
                    grant_types: ["authorization_code"],
                    token_endpoint_auth_method: "client_secret_basic",
                }),
            },
            io,
        );
        if (registered.status !== 201 || !isPlainObject(registered.json)) {
            throw new Error("Failed to register client with OAuth server");
        }
        const clientId = typeof registered.json.client_id === "string" ? registered.json.client_id : "";
        const clientSecret = typeof registered.json.client_secret === "string" ? registered.json.client_secret : "";

        const verifier = (randomUUID() + randomUUID()).replace(/-/g, "");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const authUrl = new URL(authorization_endpoint);
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URL);
        authUrl.searchParams.set("scope", "");
        authUrl.searchParams.set("state", randomUUID());
        authUrl.searchParams.set("code_challenge", challenge);
        authUrl.searchParams.set("code_challenge_method", "S256");

        this.fenceIo(io);
        io.openUrl(authUrl.toString());
        // The client's end withdraws the question and stops the login; a late answer is not used.
        const asked = io.askCode(this.closing.signal);
        asked.catch(() => {});
        const code = await this.untilOver(asked, io);
        this.fenceIo(io);

        const helped = await this.oauthFetch(
            OAUTH_HELPER_URL,
            { method: "POST", body: JSON.stringify({ code }), headers: { Accept: "application/json" } },
            io,
        );
        if (helped.json?.success !== true) {
            throw new Error("Failed to get authorization code from helper");
        }
        const exchanged = await this.oauthFetch(
            token_endpoint,
            {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code: typeof helped.json?.payload?.code === "string" ? helped.json.payload.code : "",
                    redirect_uri: OAUTH_REDIRECT_URL,
                    client_id: clientId,
                    client_secret: clientSecret,
                    code_verifier: verifier,
                }).toString(),
            },
            io,
        );
        const token = exchanged.json?.access_token;
        if (exchanged.status !== 200 || typeof token !== "string" || token === "") {
            throw new Error("Failed to exchange authorization code for access token");
        }
        // Nothing of a login is kept once its job or the client is over.
        this.fenceIo(io);
        const refreshToken = exchanged.json?.refresh_token;
        io.writeRefresh({
            clientId,
            clientSecret,
            ...(typeof refreshToken === "string" ? { refreshToken } : {}),
            tokenUrl: token_endpoint,
        });
        this.publishToken(token);
    }

    private fenceIo(io: McpIo): void {
        if (io.signal.aborted) {
            throw abortReason(io.signal);
        }
        if (this.closed) {
            throw new McpClientClosedError();
        }
    }

    private publishToken(token: string): void {
        if (this.closed) {
            throw new McpClientClosedError();
        }
        this.accessToken = token;
    }

    /**
     * `getToolList`: every page of `tools/list` as descriptors, cached once it is not empty. The whole
     * list is bounded (pages, tools, bytes) and a cursor that repeats ends it; a malformed entry is
     * left out.
     */
    async getToolList(io: McpIo): Promise<ToolDescriptor[]> {
        const info = await this.checkHandshake(io);
        if (!info.capabilities?.tools) {
            return [];
        }
        if (this.cachedTools.length > 0) {
            return this.cachedTools;
        }
        const tools: ToolDescriptor[] = [];
        const seen = new Set<string>();
        let bytes = 0;
        let cursor: string | null = null;
        for (let page = 0; ; page++) {
            if (page >= MAX_TOOL_LIST_PAGES) {
                throw new Error("The MCP server's tool list has too many pages");
            }
            const response = await this.request("tools/list", cursor ? { cursor } : {}, io.signal);
            const listed = response.rpc.result?.tools;
            if (!Array.isArray(listed)) {
                break;
            }
            for (const entry of listed) {
                if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name === "") {
                    continue;
                }
                if (entry.description !== undefined && typeof entry.description !== "string") {
                    continue;
                }
                if (!isPlainObject(entry.inputSchema)) {
                    continue;
                }
                const tool: ToolDescriptor = {
                    name: entry.name,
                    description: entry.description ?? "",
                    inputSchema: entry.inputSchema,
                };
                bytes += Buffer.byteLength(JSON.stringify(tool));
                if (tools.length >= MAX_TOOL_LIST_TOOLS || bytes > MAX_TOOL_LIST_BYTES) {
                    throw new Error("The MCP server's tool list is too large");
                }
                tools.push(tool);
            }
            const next: unknown = response.rpc.result?.nextCursor;
            if (typeof next !== "string" || next === "") {
                break;
            }
            if (seen.has(next)) {
                throw new Error("The MCP server's tool list repeats a cursor");
            }
            seen.add(next);
            cursor = next;
        }
        if (!this.closed) {
            this.cachedTools = tools;
        }
        return tools;
    }

    /** `callTool`: the answer's `content` as the server sent it (the caller checks its shape). */
    async callTool(toolName: string, args: unknown, io: McpIo): Promise<RPCToolCallContent[]> {
        const info = await this.checkHandshake(io);
        if (!info.capabilities?.tools) {
            throw new Error("MCP Server does not support tools");
        }
        const response = await this.request("tools/call", { name: toolName, arguments: args }, io.signal);
        if (response.rpc.error) {
            return [{ type: "text", text: `Error calling ${toolName}: ${JSON.stringify(response.rpc.error)}` }];
        }
        return response.rpc?.result?.content;
    }
}
