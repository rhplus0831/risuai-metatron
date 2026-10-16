import { isRecordId } from "../../../shared/ids.ts";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { planAuxOp, type AuxCredential } from "../llm/auxOps.ts";
import { createRedactor } from "../llm/redact.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

const hubURL = "https://sv.risuai.xyz";

// fetch() already decoded the body, so the upstream length/encoding/framing no longer apply.
const strippedProxyResponseHeaders = [
    "content-security-policy",
    "content-security-policy-report-only",
    "clear-site-data",
    "cache-control",
    "content-encoding",
    "content-length",
    "transfer-encoding",
];
const strippedHubResponseHeaders = ["content-encoding", "content-length", "transfer-encoding"];
// Hop-by-hop or recomputed by fetch(); `risu-auth` must never leave this server.
const strippedProxyRequestHeaders = [
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "content-length",
    "risu-auth",
    "risu-aux-profile",
];
const nullBodyStatuses = new Set([101, 204, 205, 304]);

/**
 * Upstream request headers for `/proxy*`: the decoded `risu-header` object (or the incoming
 * headers), minus hop-by-hop fields, fields nominated by `Connection`, and `risu-auth`. All
 * matching is case-insensitive. A `risu-header` that is not a plain object throws (500).
 */
function buildUpstreamHeaders(source: unknown): Headers {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new TypeError("risu-header must be a JSON object");
    }
    const headers = new Headers(source as Record<string, string>);
    const nominated = (headers.get("connection") ?? "")
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token !== "");
    for (const name of [...nominated, ...strippedProxyRequestHeaders]) {
        headers.delete(name);
    }
    return headers;
}

function getRequestTimeoutMs(raw: string | undefined): number | null {
    if (!raw) {
        return null;
    }
    const timeoutMs = Number.parseInt(raw, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return null;
    }
    return timeoutMs;
}

function createTimeoutController(timeoutMs: number | null) {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}

/**
 * Re-streams an upstream body while keeping ownership of its lifetime: `onFinish` runs exactly
 * once at EOF, on error, or when the downstream client cancels. When `closeOnError` says so, a
 * failure ends the response cleanly (like Express's `res.end()`) instead of erroring it.
 */
function ownBody(
    body: ReadableStream<Uint8Array> | null,
    arg: { onFinish: () => void; closeOnError: (error: unknown) => boolean },
): ReadableStream<Uint8Array> | null {
    if (!body) {
        arg.onFinish();
        return null;
    }
    const reader = body.getReader();
    let finished = false;
    const finish = () => {
        if (!finished) {
            finished = true;
            arg.onFinish();
        }
    };
    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        finish();
                        controller.close();
                        return;
                    }
                    controller.enqueue(value);
                } catch (error) {
                    finish();
                    if (arg.closeOnError(error)) {
                        controller.close();
                    } else {
                        controller.error(error);
                    }
                }
            },
            async cancel(reason) {
                finish();
                await reader.cancel(reason).catch(() => {});
            },
        },
        { highWaterMark: 0 },
    );
}

function filterHeaders(source: Headers, stripped: string[]): Headers {
    const headers = new Headers(source);
    for (const name of stripped) {
        headers.delete(name);
    }
    return headers;
}

export function registerProxyRoutes(
    app: Hono<AppEnv>,
    arg: {
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        clientIp: (c: Context<AppEnv>) => string | undefined;
        /** The stored `llmSecrets` record, for the auxiliary operations (`risu-aux-op`). */
        llmSecrets: () => Record<string, unknown> | null;
        /** Resolve a stored profile's credential binding; no store reads belong in this route. */
        auxCredential?: (profileId: string) => AuxCredential;
    },
) {
    const { auth, limiter, clientIp, llmSecrets } = arg;

    /**
     * A `risu-aux-op` request (`server/src/llm/auxOps.ts`): JWT only, the row's exact endpoint, the
     * server's credential, no redirect followed (a 3xx is a 502), and an error body without the
     * credential in it.
     */
    const auxOp = async (c: Context<AppEnv>, name: string) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const downstreamSignal = c.req.raw.signal;
        const risuUrl = c.req.header("risu-url");
        const urlParam = risuUrl ? decodeURIComponent(risuUrl) : c.req.query("url");
        if (!urlParam) {
            return c.json({ error: "URL has no param" }, 400);
        }
        const risuHeader = c.req.header("risu-header");
        const header = buildUpstreamHeaders(
            risuHeader ? JSON.parse(decodeURIComponent(risuHeader)) : c.req.raw.headers,
        );
        const profileId = c.req.header("risu-aux-profile");
        if (profileId !== undefined && !isRecordId(profileId)) {
            return c.json({ error: "Invalid auxiliary model profile id" }, 400);
        }
        const profile =
            profileId === undefined
                ? undefined
                : (arg.auxCredential?.(profileId) ?? { error: "The model profile no longer exists" });
        const plan = planAuxOp(name, urlParam, c.req.method, header, llmSecrets() ?? {}, profile);
        if (!plan.ok) {
            return c.json({ error: plan.error }, plan.status);
        }
        const ip = clientIp(c);
        if (!plan.headers.has("x-forwarded-for") && ip) {
            plan.headers.set("x-forwarded-for", ip);
        }
        const redactor = createRedactor(plan.secrets);
        const timeoutMs = getRequestTimeoutMs(c.req.header("risu-timeout-ms"));
        const timeout = createTimeoutController(timeoutMs);
        const aborted = () => timeout.signal.aborted || downstreamSignal.aborted;
        let upstream: Response;
        try {
            const method = c.req.method.toUpperCase();
            upstream = await fetch(plan.url, {
                method,
                headers: plan.headers,
                // A GET (the discovery and account rows) sends no body.
                body: method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer(),
                redirect: "manual",
                signal: AbortSignal.any([timeout.signal, downstreamSignal]),
            });
        } catch (error) {
            timeout.cleanup();
            if (aborted()) {
                return c.json(
                    { error: timeout.signal.aborted ? "Proxy request timed out" : "Proxy request aborted" },
                    504,
                );
            }
            return c.json({ error: redactor.text(`${error}`) }, 502);
        }
        if (upstream.status >= 300 && upstream.status < 400) {
            timeout.cleanup();
            await upstream.body?.cancel().catch(() => {});
            return c.json({ error: `The ${name} endpoint answered a redirect, which is not followed` }, 502);
        }
        const headers = filterHeaders(upstream.headers, strippedProxyResponseHeaders);
        // No response header carries the credential back (an upstream may echo it in a debug header).
        for (const [name, value] of [...headers]) {
            const redacted = redactor.text(value);
            if (redacted !== value) {
                headers.set(name, redacted);
            }
        }
        // A JSON body is checked as the tab will read it: its decoded keys and values (an escape such
        // as `\u0073k-...` hides the credential from a text match), and as text.
        const carriesDecoded = (text: string) => {
            if (redactor.carries(text)) {
                return true;
            }
            try {
                return redactor.carries(JSON.parse(text));
            } catch {
                return false;
            }
        };
        const isJson = (upstream.headers.get("content-type") ?? "").toLowerCase().includes("json");
        if (upstream.status >= 400) {
            try {
                const text = await upstream.text().catch(() => "");
                if (isJson && carriesDecoded(text)) {
                    return new Response(
                        JSON.stringify({
                            error: `The ${name} endpoint answered ${upstream.status} with the stored credential in it`,
                        }),
                        { status: upstream.status, headers: { "content-type": "application/json" } },
                    );
                }
                return new Response(redactor.text(text), { status: upstream.status, headers });
            } finally {
                timeout.cleanup();
            }
        }
        if (isJson) {
            // A successful JSON answer (an account or model list) reaches the tab only without the
            // credential in it; one that carries it is refused rather than rewritten. Media bodies
            // (speech, images) pass as they are. A body that fails to arrive, or is not JSON, is an
            // error, never an empty success.
            try {
                let text: string;
                try {
                    text = await upstream.text();
                } catch {
                    return c.json(
                        aborted()
                            ? { error: timeout.signal.aborted ? "Proxy request timed out" : "Proxy request aborted" }
                            : { error: `The ${name} answer could not be read` },
                        aborted() ? 504 : 502,
                    );
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    return c.json({ error: `The ${name} answer is not valid JSON` }, 502);
                }
                if (redactor.carries(text) || redactor.carries(parsed)) {
                    return c.json({ error: `The ${name} answer carried the stored credential; it is not sent` }, 502);
                }
                return new Response(text, { status: upstream.status, headers });
            } finally {
                timeout.cleanup();
            }
        }
        const body = ownBody(nullBodyStatuses.has(upstream.status) ? null : upstream.body, {
            onFinish: timeout.cleanup,
            closeOnError: aborted,
        });
        return new Response(body, { status: upstream.status, headers });
    };

    /**
     * Arbitrary reverse proxy. Target from `risu-url` (or `?url=`), headers from the encoded JSON
     * `risu-header` (or the incoming headers). POST forwards the raw request bytes.
     */
    const reverseProxy = (method: "GET" | "POST") => async (c: Context<AppEnv>) => {
        const auxOpName = c.req.header("risu-aux-op");
        if (auxOpName !== undefined) {
            return await auxOp(c, auxOpName);
        }
        const denied = await auth.checkProxyAuth(c);
        if (denied) {
            return denied;
        }
        // Capture before any await on the body: aborts when the client disconnects.
        const downstreamSignal = c.req.raw.signal;

        const risuUrl = c.req.header("risu-url");
        const urlParam = risuUrl ? decodeURIComponent(risuUrl) : c.req.query("url");
        if (!urlParam) {
            return c.json({ error: "URL has no param" }, 400);
        }
        const risuHeader = c.req.header("risu-header");
        const header = buildUpstreamHeaders(
            risuHeader ? JSON.parse(decodeURIComponent(risuHeader)) : c.req.raw.headers,
        );
        const ip = clientIp(c);
        if (!header.has("x-forwarded-for") && ip) {
            header.set("x-forwarded-for", ip);
        }

        const timeoutMs = getRequestTimeoutMs(c.req.header("risu-timeout-ms"));
        const timeout = createTimeoutController(timeoutMs);
        const aborted = () => timeout.signal.aborted || downstreamSignal.aborted;
        let upstream: Response;
        try {
            upstream = await fetch(urlParam, {
                method: method === "GET" ? "GET" : c.req.method,
                headers: header,
                body: method === "GET" ? undefined : await c.req.arrayBuffer(),
                signal: AbortSignal.any([timeout.signal, downstreamSignal]),
            });
        } catch (error) {
            timeout.cleanup();
            if (aborted()) {
                return c.json(
                    {
                        error: timeout.signal.aborted
                            ? `Proxy request timed out after ${timeoutMs}ms`
                            : "Proxy request aborted",
                    },
                    504,
                );
            }
            throw error;
        }

        const headers = filterHeaders(upstream.headers, strippedProxyResponseHeaders);
        // Hono runs GET handlers for HEAD and drops the body without cancelling it.
        if (c.req.method === "HEAD") {
            timeout.cleanup();
            await upstream.body?.cancel().catch(() => {});
            return new Response(null, { status: upstream.status, headers });
        }

        // The timeout keeps covering the body until it finishes streaming.
        const body = ownBody(nullBodyStatuses.has(upstream.status) ? null : upstream.body, {
            onFinish: timeout.cleanup,
            closeOnError: aborted,
        });
        if (nullBodyStatuses.has(upstream.status)) {
            await upstream.body?.cancel().catch(() => {});
        }
        return new Response(body, { status: upstream.status, headers });
    };

    app.get("/proxy", limiter, reverseProxy("GET"));
    app.get("/proxy2", limiter, reverseProxy("GET"));
    app.post("/proxy", limiter, reverseProxy("POST"));
    app.post("/proxy2", limiter, reverseProxy("POST"));

    /** Realm hub proxy (GET only, no auth). */
    app.get("/hub-proxy/*", limiter, async (c) => {
        try {
            const pathHeader = c.req.header("x-risu-node-path");
            let externalURL: string;
            if (pathHeader) {
                externalURL = decodeURIComponent(pathHeader);
            } else {
                const url = new URL(c.req.url);
                externalURL = hubURL + url.pathname.replace(/^\/hub-proxy/, "") + url.search;
            }

            const headersToSend = Object.fromEntries(c.req.raw.headers);
            delete headersToSend.host;
            delete headersToSend.connection;
            delete headersToSend["content-length"];
            delete headersToSend["x-risu-node-path"];
            delete headersToSend["risu-auth"];
            headersToSend.origin = new URL(hubURL).origin;

            const request = (target: string) =>
                fetch(target, {
                    method: c.req.method,
                    headers: headersToSend,
                    redirect: "manual",
                    // A client abort cancels the upstream request, including before headers arrive.
                    signal: c.req.raw.signal,
                });

            let response = await request(externalURL);
            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
                // Follow exactly one redirect; relative locations resolve against the first URL.
                await response.body?.cancel().catch(() => {});
                response = await request(new URL(location, externalURL).toString());
            }

            const body = ownBody(nullBodyStatuses.has(response.status) ? null : response.body, {
                onFinish: () => {},
                closeOnError: (error) => {
                    console.error("[Hub Proxy] Error:", error);
                    return true;
                },
            });
            if (nullBodyStatuses.has(response.status)) {
                await response.body?.cancel().catch(() => {});
            }
            return new Response(body, {
                status: response.status,
                headers: filterHeaders(response.headers, strippedHubResponseHeaders),
            });
        } catch (error) {
            console.error("[Hub Proxy] Error:", error);
            return c.json({ error: "Proxy request failed: " + (error as Error)?.message }, 502);
        }
    });
}
