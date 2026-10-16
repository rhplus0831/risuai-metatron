import { v4 } from "uuid";
import { fetchNative, openURL } from "../../globalApi.svelte";
import { alertInput } from "../../alert";
import { type MCPTool, MCPToolHandler } from "../../../../shared/mcp/risuaccess/host.ts";
import { parseSseEvent, SseFramer } from "../../../../shared/mcp/sse.ts";

export { type MCPTool, MCPToolHandler };

export type MCPPrompt = {
    name: string; // Unique identifier for the prompt
    description?: string; // Human-readable description
    arguments?: {
        // Optional list of arguments
        name: string; // Argument identifier
        description?: string; // Argument description
        required?: boolean; // Whether argument is required
    }[];
    url?: string;
};

export type JsonRPC = {
    jsonrpc: "2.0";
    id: number | string;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
};

export type JsonPing = {
    jsonrpc: "2.0";
    id: string;
    method: "ping";
};

export type RPCRequestResult = {
    rpc: JsonRPC;
    http: {
        status: number;
        headers: Record<string, string>;
    };
};

export type SseEventDetail = {
    mcpClientObjectId: string;
    data: JsonRPC;
};

export type RPCToolCallTextContent = {
    type: "text";
    text: string;
};

export type RPCToolCallImageAudioContent = {
    type: "image" | "audio";
    data: string; // Base64 encoded image
    mimeType: string; // e.g. 'image/png', 'image/jpeg'
};

export type RPCToolCallContentResource = {
    type: "resource";
    resource: {
        uri: string;
        mimeType: string;
        text: string;
    };
};

export type RPCToolCallContent = RPCToolCallTextContent | RPCToolCallImageAudioContent | RPCToolCallContentResource;

export class MCPClient {
    mcpClientObjectId: string = v4();
    sessionId: string | null = null;
    initialized: boolean = false;
    url: string;
    sseEndpoint: string;
    accessToken: string | null = null;
    sseResponses: Record<string, JsonRPC> = {};
    sseIdDone: Set<string | number> = new Set();
    protocolVersion: "2025-03-26" | "2024-11-05" = "2025-03-26";
    sses: {
        stream: ReadableStream;
        abortController?: AbortController;
    }[] = [];
    customTransport?: {
        send: (message: JsonRPC) => void | Promise<void>;
        addListener: (callback: (message: JsonRPC) => void | Promise<void>) => void;
        removeListener: (callback: (message: JsonRPC) => void | Promise<void>) => void;
    };
    onDestroy: (() => void) | null = null;
    /**
     * Set by `destroy()`: the client starts no request, handshake, or login step, and an answer that
     * arrives later publishes nothing (`assertOpen`).
     */
    private closed = false;
    /** Only the current legacy GET stream may reset the session when it ends. */
    private legacy: AbortController | null = null;
    /** Pending answers, including the legacy handshake's `"connected"` event. */
    private readonly pending = new Map<string | number, (rpc: JsonRPC) => void>();
    serverInfo: {
        protocolVersion: string;
        capabilities: {
            [key: string]: any;
        };
        serverInfo: {
            name: string;
            version: string;
        };
        instructions?: string;
    };
    cached: {
        prompts?: MCPPrompt[];
        tools?: MCPTool[];
    } = {
        prompts: [],
        tools: [],
    };
    registerRefreshToken:
        ((arg: { clientId: string; clientSecret: string; refreshToken: string; tokenUrl: string }) => void) | null =
        null;

    getRefreshToken:
        | (() => Promise<{
              clientId: string;
              clientSecret: string;
              refreshToken: string;
              tokenUrl: string;
          }>)
        | null = null;

    constructor(
        url: string,
        arg: {
            accessToken?: string;
            debug?: boolean;
        } = {},
    ) {
        this.url = url;
        if (arg.accessToken) {
            this.accessToken = arg.accessToken;
        }
    }

    /** Registers once; every settlement removes both the document listener and the pending entry. */
    private waitFor(id: string | number, http: RPCRequestResult["http"] = { status: 200, headers: {} }) {
        // A replacement waiter must not strand the previous listener for the same id.
        this.pending.get(id)?.({ jsonrpc: "2.0", id, error: { code: -32000, message: "The MCP session ended" } });
        let resolve!: (answer: RPCRequestResult) => void;
        const answer = new Promise<RPCRequestResult>((done) => {
            resolve = done;
        });
        let settled = false;
        const settle = (rpc: JsonRPC) => {
            if (settled) return;
            settled = true;
            document.removeEventListener("mcp-sse", listener);
            if (this.pending.get(id) === settle) {
                this.pending.delete(id);
            }
            resolve({ rpc, http });
        };
        const listener = (event: CustomEvent<SseEventDetail>) => {
            if (event.detail.mcpClientObjectId === this.mcpClientObjectId && event.detail.data.id === id) {
                settle(event.detail.data);
            }
        };
        this.pending.set(id, settle);
        document.addEventListener("mcp-sse", listener);
        return {
            answer,
            settle,
            fail: (message: string, code = -32000) => settle({ jsonrpc: "2.0", id, error: { code, message } }),
        };
    }

    private failPending(message: string): void {
        for (const [id, settle] of this.pending) {
            settle({ jsonrpc: "2.0", id, error: { code: -32000, message } });
        }
    }

    /** Resolves at EOF, rejects on a read failure, and always releases its reader and tracked entry. */
    async connectSSE(stream: ReadableStream, abortController = new AbortController()): Promise<void> {
        if (this.closed) {
            // A retired client reads no stream (its `destroy()` could not abort this one).
            stream.cancel().catch(() => {});
            return;
        }
        const reader = stream.getReader();
        // Events are framed in bytes (`shared/mcp/sse.ts`: CRLF, LF, or CR line ends) and handled in order.
        const events: string[] = [];
        const framer = new SseFramer((event) => events.push(event));
        const sse = { stream, abortController };
        this.sses.push(sse);
        // Also cancel the reader explicitly: a custom fetch transport may not wire its signal to
        // the returned stream, and an answered request must stop reading even then.
        const cancel = () => {
            void reader.cancel().catch(() => {});
        };
        abortController.signal.addEventListener("abort", cancel, { once: true });
        try {
            while (!abortController.signal.aborted && !this.closed) {
                const { done, value } = await reader.read();
                if (done || abortController.signal.aborted || this.closed) break;

                framer.push(value);
                for (let i = 0; i < events.length; i++) {
                    if (abortController.signal.aborted || this.closed) break;
                    await this.handleSseEvent(events[i]);
                }
                events.length = 0;
            }
        } finally {
            abortController.signal.removeEventListener("abort", cancel);
            cancel();
            reader.releaseLock();
            const index = this.sses.indexOf(sse);
            if (index !== -1) this.sses.splice(index, 1);
        }
    }

    private async handleSseEvent(text: string) {
        const parsed = parseSseEvent(text);
        const data = parsed.data.trim();
        const eventName = parsed.event.trim();
        if (!data) {
            return;
        }
        console.log("MCP SSE Data", {
            eventName: eventName,
            data: data,
        });

        if (eventName === "endpoint") {
            const sseEventDetail: SseEventDetail = {
                mcpClientObjectId: this.mcpClientObjectId,
                data: {
                    jsonrpc: "2.0",
                    id: "connected",
                    result: {
                        endpoint: data,
                    },
                },
            };
            document.dispatchEvent(
                new CustomEvent("mcp-sse", {
                    detail: sseEventDetail,
                }),
            );
            return;
        }
        try {
            const jsonData = JSON.parse(data) as JsonRPC | JsonPing;
            if (this.sseIdDone.has(jsonData.id)) {
                return;
            }

            //@ts-expect-error JsonRPC type doesn't have method property, but JsonPing does
            if (jsonData.method === "ping") {
                // Sending a ping reply must not prevent the reader from observing EOF or failure
                // while the POST is still out.
                void this.request(
                    "response",
                    {},
                    {
                        notifications: true,
                        initMethod: "none",
                        id: jsonData.id,
                    },
                ).then(
                    () => this.sseIdDone.add(jsonData.id),
                    () => {},
                );
                return;
            }

            const sseEventDetail: SseEventDetail = {
                mcpClientObjectId: this.mcpClientObjectId,
                data: jsonData,
            };
            document.dispatchEvent(
                new CustomEvent("mcp-sse", {
                    detail: sseEventDetail,
                }),
            );
            this.sseIdDone.add(jsonData.id);
        } catch (error) {}
    }

    async request(
        method: string,
        params?: any,
        options: {
            notifications?: boolean;
            initMethod?: "init" | "none";
            id?: string | number;
        } = {},
    ): Promise<RPCRequestResult> {
        this.assertOpen();
        options ??= {};
        const initMethod = options.initMethod || "none";
        let httpStatus = 500;
        const url = this.sseEndpoint ?? this.url;
        const legacy = !!this.sseEndpoint;

        const body =
            method === "response"
                ? {
                      jsonrpc: "2.0",
                      id: options?.id ?? v4(),
                      result: params,
                  }
                : {
                      jsonrpc: "2.0",
                      id: options?.id ?? v4(),
                      method: method,
                      params: params,
                  };

        if (method !== "response") {
            if (options.notifications) {
                delete body.params;
                delete body.id;
            } else if (!params) {
                delete body.params;
            }
        }

        if (this.customTransport) {
            return new Promise<RPCRequestResult>((resolve) => {
                const func = (message: JsonRPC) => {
                    if (message.id === body.id) {
                        resolve({
                            rpc: message,
                            http: {
                                status: 200,
                                headers: {},
                            },
                        });
                        this.customTransport.removeListener(func);
                    }
                };
                Promise.resolve(this.customTransport.addListener(func))
                    .then(() => this.customTransport.send(body as JsonRPC))
                    // TODO: handle send errors properly (e.g. timeout, reject with RPC error)
                    .catch(() => {});
            });
        }

        let responseWaiter: ReturnType<MCPClient["waitFor"]> | null = null;
        try {
            const headers: Record<string, string> = !this.sseEndpoint
                ? {
                      "Content-Type": "application/json",
                      Accept: "application/json, text/event-stream",
                  }
                : {
                      "Content-Type": "application/json",
                      Accept: "*/*",
                  };

            if (this.sessionId) {
                headers["Mcp-Session-Id"] = this.sessionId;
            }

            if (this.accessToken) {
                headers["Authorization"] = `Bearer ${this.accessToken}`;
            }

            const abortController = new AbortController();
            const requestParams = {
                body: JSON.stringify(body),
                method: "POST",
                headers: headers,
                signal: abortController.signal,
            } as {
                body?: string;
                method: "GET" | "POST";
                headers: Record<string, string>;
                signal?: AbortSignal;
            };

            if (requestParams.method === "GET") {
                delete requestParams.body;
            }

            if (legacy && !options.notifications) {
                responseWaiter = this.waitFor(body.id);
            }

            const fetching = fetchNative(url, requestParams);
            // The legacy session can answer or end while its POST is still out. Neither leaves
            // this request waiting for a POST response after its waiter has already settled.
            const response = responseWaiter ? await Promise.race([fetching, responseWaiter.answer]) : await fetching;
            if ("rpc" in response) {
                abortController.abort();
                void fetching.then(
                    (late) => late.body?.cancel().catch(() => {}),
                    () => {},
                );
                this.assertOpen();
                return response;
            }
            if (this.closed) {
                // The client was retired while the request was out: its answer is not read.
                response.body?.cancel().catch(() => {});
                this.assertOpen();
            }

            if (legacy && options.notifications) {
                response.body?.cancel().catch(() => {});
                return {
                    rpc: {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: null, // No result for notifications
                    },
                    http: {
                        status: response.status,
                        headers: Object.fromEntries(response.headers.entries()),
                    },
                };
            }

            if (responseWaiter) {
                response.body?.cancel().catch(() => {});
                if (response.status > 299) {
                    responseWaiter.settle({
                        jsonrpc: "2.0",
                        id: body.id,
                        error: {
                            code: response.status,
                            message: response.statusText,
                            data: {
                                method: method,
                                params: params,
                            },
                        },
                    });
                }
                // An answer that arrives after the client was retired is not taken.
                return responseWaiter.answer.then((answer) => {
                    this.assertOpen();
                    return answer;
                });
            }

            if ((this.sessionId && response.status === 404) || (this.accessToken && response.status === 401)) {
                response.body?.cancel().catch(() => {});
                this.reset();
                return this.request(method, params, options);
            }

            const contentType = response.headers.get("Content-Type") || "";

            if (contentType.includes("text/event-stream")) {
                if (response.headers.has("Mcp-Session-Id") && initMethod !== "none") {
                    this.sessionId = response.headers.get("Mcp-Session-Id");
                }
                const waiting = this.waitFor(body.id, {
                    status: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                });
                void this.connectSSE(response.body, abortController).then(
                    () => waiting.fail("The MCP stream ended without an answer"),
                    (error) =>
                        waiting.fail(error instanceof Error && error.message ? error.message : "The MCP stream failed"),
                );
                return waiting.answer
                    .finally(() => abortController.abort())
                    .then((answer) => {
                        this.assertOpen();
                        return answer;
                    });
            }

            if (!contentType.includes("application/json")) {
                return {
                    rpc: {
                        jsonrpc: "2.0",
                        id: body.id,
                        error: {
                            code: -32603,
                            message: "Invalid Content-Type",
                            data: {
                                contentType: contentType,
                            },
                        },
                    },
                    http: {
                        status: response.status,
                        headers: Object.fromEntries(response.headers.entries()),
                    },
                };
            }

            if (response.headers.has("Mcp-Session-Id") && initMethod !== "none") {
                this.sessionId = response.headers.get("Mcp-Session-Id");
            }
            const rpc = await response.json();
            this.assertOpen();
            return {
                rpc,
                http: {
                    status: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                },
            };
        } catch (error) {
            responseWaiter?.fail("Internal Error", httpStatus);
            if (this.closed) {
                throw error;
            }
            return {
                rpc: {
                    jsonrpc: "2.0",
                    id: "",
                    error: {
                        code: httpStatus,
                        message: "Internal Error",
                    },
                },
                http: {
                    status: httpStatus,
                    headers: {},
                },
            };
        }
    }

    async getCapabilities() {
        await this.checkHandshake();
        return this.serverInfo?.capabilities || {};
    }

    async loadPrompt(mcpPrompt: MCPPrompt) {
        await this.checkHandshake();
        const d = await this.request("prompts/get", {
            name: mcpPrompt.name,
        });

        return d;
    }

    checkHandshake() {
        this.assertOpen();
        if (this.initialized) {
            return this.serverInfo;
        } else {
            return this.handshake();
        }
    }

    /** The legacy GET belongs to its session, including the wait for the endpoint event. */
    private async connectLegacy(headers: Record<string, string>): Promise<AbortController> {
        const session = new AbortController();
        this.legacy?.abort();
        this.legacy = session;
        const connected = this.waitFor("connected");
        try {
            const fetching = fetchNative(this.url, { method: "GET", headers, signal: session.signal });
            const connection = await Promise.race([fetching, connected.answer]);
            if ("rpc" in connection) {
                session.abort();
                void fetching.then(
                    (late) => late.body?.cancel().catch(() => {}),
                    () => {},
                );
                this.assertOpen();
                throw new Error(connection.rpc.error?.message ?? "The MCP session ended");
            }
            if (this.closed || this.legacy !== session) {
                connection.body?.cancel().catch(() => {});
                this.assertOpen();
                throw new Error("The MCP session ended");
            }
            if (connection.status !== 200) {
                connection.body?.cancel().catch(() => {});
                throw new Error(`Failed to connect to MCP server: ${connection.status} ${connection.statusText}`);
            }

            const ended = (message: string) => {
                // An old stream may finish its cleanup after a new handshake installed its session.
                if (this.legacy === session) this.reset(message);
            };
            void this.connectSSE(connection.body, session).then(
                () => ended("The MCP session ended"),
                (error) => ended(error instanceof Error && error.message ? error.message : "The MCP stream failed"),
            );
            const connectionResult = await connected.answer;
            this.assertOpen();
            const endpoint = connectionResult.rpc.result?.endpoint;
            if (!endpoint) {
                throw new Error(connectionResult.rpc.error?.message ?? "Failed to get endpoint from MCP server");
            }
            if (this.legacy !== session) throw new Error("The MCP session ended");
            this.sseEndpoint = `${new URL(this.url).origin}${endpoint}`;
            return session;
        } catch (error) {
            connected.fail("The MCP session ended");
            if (this.legacy === session) this.reset();
            session.abort();
            throw error;
        }
    }

    async handshake() {
        this.assertOpen();
        let legacySession: AbortController | null = null;
        console.log("MCP Handshake", this.url, this.mcpClientObjectId);
        this.protocolVersion = "2025-03-26"; //default to latest version
        let { rpc: d, http } = await this.request(
            "initialize",
            {
                protocolVersion: this.protocolVersion,
                capabilities: {},
                clientInfo: {
                    name: "RS-MCP-CLIENT",
                    version: "1.0.0",
                },
            },
            {
                initMethod: "init",
            },
        );

        if (http.status === 404) {
            this.assertOpen();
            console.warn("MCP: Streamed transport not supported, falling back to SSE");
            this.protocolVersion = "2024-11-05";

            const headers: Record<string, string> = {
                Accept: "text/event-stream",
            };

            if (this.sessionId) {
                headers["Mcp-Session-Id"] = this.sessionId;
            }

            if (this.accessToken) {
                headers["Authorization"] = `Bearer ${this.accessToken}`;
            }

            legacySession = await this.connectLegacy(headers);
            this.assertOpen();
            if (this.legacy !== legacySession) throw new Error("The MCP session ended");

            let r = await this.request(
                "initialize",
                {
                    protocolVersion: this.protocolVersion,
                    capabilities: {},
                    clientInfo: {
                        name: "RS-MCP-CLIENT",
                        version: "1.0.0",
                    },
                },
                {
                    initMethod: "init",
                },
            );

            d = r.rpc;
            http = r.http;
        }

        this.assertOpen();
        if (legacySession && this.legacy !== legacySession) throw new Error("The MCP session ended");
        if (http.status === 401) {
            await this.oauthLogin();
            return this.handshake();
        }

        if (d?.result?.serverInfo) {
            this.serverInfo = d.result;

            await this.request("notifications/initialized", null, {
                notifications: true,
            });
            this.assertOpen();
            if (legacySession && this.legacy !== legacySession) throw new Error("The MCP session ended");

            if (d?.result?.protocolVersion !== "2025-03-26" && d?.result?.protocolVersion !== "2024-11-05") {
                console.warn("MCP Server is using an unsupported protocol version", d.result.protocolVersion);
            } else {
                this.protocolVersion = d.result.protocolVersion;
            }

            console.log("MCP Handshake Successful", this.serverInfo, this.mcpClientObjectId);
            this.initialized = true;

            return this.serverInfo;
        } else {
            throw "MCP Handshake Failed";
        }
    }

    async oauthLogin() {
        // A retired client starts no login step: a refresh would spend the token a newer client holds.
        this.assertOpen();
        if (this.getRefreshToken) {
            const refreshTokenData = await this.getRefreshToken();
            this.assertOpen();
            if (refreshTokenData) {
                //get access token using refresh token
                const tokenResponse = await fetchNative(refreshTokenData.tokenUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                        grant_type: "refresh_token",
                        refresh_token: refreshTokenData.refreshToken,
                        client_id: refreshTokenData.clientId,
                        client_secret: refreshTokenData.clientSecret,
                    }).toString(),
                });
                // A successful refresh gives the token (the check used to be inverted: Phase 5 slice
                // 12); anything else goes on to a full login.
                if (tokenResponse.status === 200) {
                    const tokenData = await tokenResponse.json().catch((): null => null);
                    if (typeof tokenData?.access_token === "string" && tokenData.access_token !== "") {
                        // A rotated refresh token replaces the stored one (the old one may be spent).
                        const rotated = tokenData.refresh_token;
                        this.assertOpen();
                        if (typeof rotated === "string" && rotated !== "" && this.registerRefreshToken) {
                            this.registerRefreshToken({
                                clientId: refreshTokenData.clientId,
                                clientSecret: refreshTokenData.clientSecret,
                                refreshToken: rotated,
                                tokenUrl: refreshTokenData.tokenUrl,
                            });
                        }
                        this.accessToken = tokenData.access_token;
                        return;
                    }
                }
            }
        }

        this.assertOpen();
        const OauthDiscovery = new URL(this.url);
        OauthDiscovery.pathname = "/.well-known/oauth-authorization-server";
        const oauthResponse = await fetchNative(OauthDiscovery.toString(), {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
        });

        //default discovery URLS
        let discoveryURLS = {
            authorization_endpoint: OauthDiscovery.origin + "/authorize",
            token_endpoint: OauthDiscovery.origin + "/token",
            registration_endpoint: OauthDiscovery.origin + "/register",
        };

        if (oauthResponse.status === 200) {
            discoveryURLS = await oauthResponse.json();
        }

        const redirectURL = "https://account.sionyw.com/oauthhelper"; //Just a placeholder, should be replaced with actual redirect URL

        this.assertOpen();
        const registerResponse = await fetchNative(discoveryURLS.registration_endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                client_name: "RS-MCP-CLIENT",
                redirect_uris: [redirectURL],
                response_types: ["code"],
                grant_types: ["authorization_code"],
                token_endpoint_auth_method: "client_secret_basic",
            }),
        });

        if (registerResponse.status !== 201) {
            throw new Error("Failed to register client with OAuth server");
        }

        const clientData = await registerResponse.json();

        const code_verifier = (v4() + v4()).replace(/-/g, "");
        const sha256 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code_verifier));
        const code_challenge = Buffer.from(sha256)
            .toString("base64")
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");

        const authUrl = new URL(discoveryURLS.authorization_endpoint);
        // The server names this address, and it is opened in a window: only a web address may be.
        if (authUrl.protocol !== "http:" && authUrl.protocol !== "https:") {
            throw new Error("The OAuth authorization endpoint is not a web address");
        }
        authUrl.searchParams.set("client_id", clientData.client_id);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("redirect_uri", redirectURL);
        authUrl.searchParams.set("scope", "");
        authUrl.searchParams.set("state", v4());
        authUrl.searchParams.set("code_challenge", code_challenge);
        authUrl.searchParams.set("code_challenge_method", "S256");

        this.assertOpen();
        openURL(authUrl.toString());
        const code = await alertInput("Input Authorization Code");
        this.assertOpen();

        const authHelperResponse = await fetchNative("https://account.sionyw.com/oauthhelper/api", {
            method: "POST",
            body: JSON.stringify({
                code: code,
            }),
            headers: {
                Accept: "application/json",
            },
        });

        const authHelperResponseJson = await authHelperResponse.json();

        if (authHelperResponseJson.success !== true) {
            throw new Error("Failed to get authorization code from helper");
        }

        const payload = authHelperResponseJson.payload;

        this.assertOpen();

        const tokenResponse = await fetchNative(discoveryURLS.token_endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: payload.code || "",
                redirect_uri: redirectURL,
                client_id: clientData.client_id,
                client_secret: clientData.client_secret,
                code_verifier: code_verifier,
            }).toString(),
        });

        if (tokenResponse.status !== 200) {
            throw new Error("Failed to exchange authorization code for access token");
        }

        const tokenData = await tokenResponse.json();

        this.assertOpen();
        if (this.registerRefreshToken) {
            this.registerRefreshToken({
                clientId: clientData.client_id,
                clientSecret: clientData.client_secret,
                refreshToken: tokenData.refresh_token,
                tokenUrl: discoveryURLS.token_endpoint,
            });
        }
        this.accessToken = tokenData.access_token;
    }

    async getPromptList(): Promise<MCPPrompt[]> {
        await this.checkHandshake();
        this.assertOpen();
        if (!this.serverInfo.capabilities?.prompts) {
            return [];
        }
        if (this.cached.prompts.length > 0) {
            return this.cached.prompts;
        }
        let prompts: MCPPrompt[] = [];
        let cursor: string | null = null;
        while (true) {
            const args = {
                cursor: cursor,
            } as Record<string, any>;

            if (!args.cursor) {
                delete args.cursor;
            }

            const response = await this.request("prompts/list", args);
            if (response.rpc.result?.prompts) {
                prompts.push(...response.rpc.result.prompts);
                if (response.rpc.result.nextCursor) {
                    cursor = response.rpc.result.nextCursor;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        this.assertOpen();
        this.cached.prompts = prompts;

        return prompts;
    }

    async getToolList(): Promise<MCPTool[]> {
        await this.checkHandshake();
        this.assertOpen();
        if (!this.serverInfo.capabilities?.tools) {
            return [];
        }
        if (this.cached.tools.length > 0) {
            return this.cached.tools;
        }
        let tools: MCPTool[] = [];
        let cursor: string | null = null;
        while (true) {
            const args = {
                cursor: cursor,
            } as Record<string, any>;

            if (!args.cursor) {
                delete args.cursor;
            }

            const response = await this.request("tools/list", args);
            console.log("MCP Tools List Response", response);
            if (response.rpc.result?.tools) {
                tools.push(...response.rpc.result.tools);
                if (response.rpc.result.nextCursor) {
                    cursor = response.rpc.result.nextCursor;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        this.assertOpen();
        this.cached.tools = tools;

        return tools;
    }

    async callTool(toolName: string, args: any): Promise<RPCToolCallContent[]> {
        await this.checkHandshake();
        this.assertOpen();
        if (!this.serverInfo.capabilities?.tools) {
            throw new Error("MCP Server does not support tools");
        }

        const response = await this.request("tools/call", {
            name: toolName,
            arguments: args,
        });

        if (response.rpc.error) {
            return [
                {
                    type: "text",
                    text: `Error calling ${toolName}: ${JSON.stringify(response.rpc.error)}`,
                },
            ];
        }

        return response.rpc?.result?.content;
    }

    /**
     * Retires the client (the registry dropped it): it starts nothing afterwards, and requests, logins,
     * and lists it started refuse their late answers. Pending SSE answers settle, and running readers
     * are cancelled and released. The custom transport is not fenced.
     */
    destroy() {
        this.closed = true;
        this.reset();
    }

    /** Drops the session, token, and streams and settles its waiters; the client stays usable. */
    private reset(message = "The MCP session ended") {
        this.initialized = false;
        this.sessionId = null;
        this.accessToken = null;
        this.sseEndpoint = null;
        this.sseResponses = {};
        const legacy = this.legacy;
        this.legacy = null;
        legacy?.abort();
        this.failPending(message);
        for (const sse of this.sses) {
            sse.abortController?.abort();
        }
        this.sseIdDone.clear();
        this.sses = [];
        this.onDestroy?.();
    }

    ping() {
        return this.request("ping");
    }

    /** Throws for a client `destroy()` retired (its credentials or session could replace a newer client's). */
    private assertOpen() {
        if (this.closed) {
            throw new Error("The MCP client was closed");
        }
    }
}
