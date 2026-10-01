import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Context, Hono, MiddlewareHandler } from "hono";
import ipaddr from "ipaddr.js";
import { WebSocketServer, type WebSocket } from "ws";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

// Contract shared with src/ts/network/proxyJobWs.ts and fetchViaProxyJobWs in
// src/ts/globalApi.svelte.ts: event names, base64 chunks, WS auth, and these limits.
const PROXY_STREAM_DEFAULT_TIMEOUT_MS = 600000;
const PROXY_STREAM_MAX_TIMEOUT_MS = 3600000;
const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15;
const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5;
const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60;
const PROXY_STREAM_GC_INTERVAL_MS = 60000;
const PROXY_STREAM_DONE_GRACE_MS = 30000;
const PROXY_STREAM_MAX_ACTIVE_JOBS = 64;
const PROXY_STREAM_MAX_PENDING_EVENTS = 512;
const PROXY_STREAM_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024;

type ProxyStreamJob = {
    id: string;
    createdAt: number;
    updatedAt: number;
    done: boolean;
    cleanupAt: number;
    clients: Set<WebSocket>;
    pendingEvents: string[];
    pendingBytes: number;
    abortController: AbortController;
    deadlineAt: number;
    heartbeatSec: number;
    timeoutMs: number;
};

type ProxyJobEvent =
    | { type: "upstream_headers"; status: number; headers: Record<string, string> }
    | { type: "chunk"; dataBase64: string }
    | { type: "error"; status: number; message: string }
    | { type: "done" };

function normalizeProxyStreamTimeoutMs(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return PROXY_STREAM_DEFAULT_TIMEOUT_MS;
    }
    const parsed = Math.max(1, Math.floor(timeoutMs));
    return Math.min(PROXY_STREAM_MAX_TIMEOUT_MS, parsed);
}

function normalizeHeartbeatSec(heartbeatSec: number): number {
    if (!Number.isFinite(heartbeatSec)) {
        return PROXY_STREAM_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(PROXY_STREAM_HEARTBEAT_MAX_SEC, Math.max(PROXY_STREAM_HEARTBEAT_MIN_SEC, parsed));
}

const localIPv4Ranges = new Set(["private", "loopback", "unspecified", "linkLocal"]);
const localIPv6Ranges = new Set(["uniqueLocal", "linkLocal", "loopback"]);

/**
 * localhost, `*.local`, and IP literals in 10/8, 172.16/12, 192.168/16, 127/8, 0/8, 169.254/16,
 * fc00::/7, fe80::/10, ::1, or IPv4-mapped IPv6 of those IPv4 ranges.
 */
export function isLocalNetworkHost(hostname: unknown): boolean {
    if (typeof hostname !== "string" || hostname.trim() === "") {
        return false;
    }

    const normalizedHost = hostname.toLowerCase().replace(/\.$/, "").split("%")[0];
    if (normalizedHost === "localhost" || normalizedHost.endsWith(".local")) {
        return true;
    }

    const family = net.isIP(normalizedHost);
    if (family === 0) {
        return false;
    }
    const address = ipaddr.parse(normalizedHost);
    if (family === 4) {
        return localIPv4Ranges.has(address.range());
    }
    const v6 = address as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
        return localIPv4Ranges.has(v6.toIPv4Address().range());
    }
    return localIPv6Ranges.has(v6.range());
}

/** Proxy jobs may only target local/private http(s) hosts. */
export function sanitizeTargetUrl(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.trim() === "") {
        return null;
    }
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        // URL.hostname keeps IPv6 brackets; strip them for the host check.
        if (!isLocalNetworkHost(parsed.hostname.replace(/^\[(.*)\]$/, "$1"))) {
            return null;
        }
        parsed.username = "";
        parsed.password = "";
        return parsed.toString();
    } catch {
        return null;
    } // lgtm[js/request-forgery]
}

function normalizeForwardHeaders(input: unknown): Record<string, string> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {};
    }
    // Header names are case-insensitive: lowercase them so the deletes and lookups below match.
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === "string") {
            normalized[key.toLowerCase()] = value;
        }
    }
    delete normalized["risu-auth"];
    delete normalized["risu-timeout-ms"];
    delete normalized["host"];
    delete normalized["connection"];
    delete normalized["content-length"];
    return normalized;
}

function normalizeProxyResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined) {
            continue;
        }
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return normalized;
}

function requestLocalTargetStream(
    targetUrl: string,
    arg: {
        method: string;
        headers: Record<string, string>;
        bodyBuffer?: Buffer;
        timeoutMs: number;
        signal?: AbortSignal;
    },
): Promise<{ status: number; headers: Record<string, string>; body: http.IncomingMessage }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === "https:" ? https : http;
        const headers = normalizeForwardHeaders(arg.headers);
        if (!headers["host"]) {
            headers["host"] = parsedUrl.host;
        }
        if (arg.bodyBuffer && !headers["content-length"]) {
            headers["content-length"] = String(arg.bodyBuffer.length);
        }

        let settled = false;
        let response: http.IncomingMessage | undefined;
        let cleanupAbort = () => {};
        const finishReject = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };

        const req = client.request(parsedUrl, { method: arg.method, headers }, (res) => {
            if (settled) {
                res.destroy();
                return;
            }
            settled = true;
            response = res;
            // The abort listener stays attached while the body streams, so DELETE/GC/dispose
            // also stop an upstream that sent headers and then stalled.
            res.once("close", () => cleanupAbort());
            resolve({
                status: res.statusCode || 502,
                headers: normalizeProxyResponseHeaders(res.headers),
                body: res,
            });
        });

        req.on("error", (error) => {
            cleanupAbort();
            finishReject(error);
        });

        req.setTimeout(arg.timeoutMs, () => {
            req.destroy(new Error(`Upstream request timed out after ${arg.timeoutMs}ms`));
        });

        if (arg.signal) {
            const signal = arg.signal;
            const onAbort = () => {
                const abortError = new Error("Proxy stream job aborted");
                abortError.name = "AbortError";
                req.destroy(abortError);
                response?.destroy(abortError);
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            cleanupAbort = () => signal.removeEventListener("abort", onAbort);
        }

        if (arg.bodyBuffer && arg.method !== "GET" && arg.method !== "HEAD") {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

export type ProxyStreamJobs = ReturnType<typeof createProxyStreamJobs>;

/**
 * Local-network streaming proxy: POST creates a job, the client follows it over
 * `/proxy-stream-jobs/:jobId/ws`, DELETE aborts it.
 */
export function createProxyStreamJobs(arg: { auth: AuthStore }) {
    const { auth } = arg;
    const jobs = new Map<string, ProxyStreamJob>();
    let gcTimer: NodeJS.Timeout | undefined;
    const wsServer = new WebSocketServer({ noServer: true });
    let disposed = false;

    function createJob(timeoutMsRaw: unknown, heartbeatSec: number): ProxyStreamJob {
        const timeoutMs = normalizeProxyStreamTimeoutMs(Number(timeoutMsRaw));
        const createdAt = Date.now();
        const job: ProxyStreamJob = {
            id: randomUUID(),
            createdAt,
            updatedAt: createdAt,
            done: false,
            cleanupAt: 0,
            clients: new Set(),
            pendingEvents: [],
            pendingBytes: 0,
            abortController: new AbortController(),
            deadlineAt: createdAt + timeoutMs,
            heartbeatSec,
            timeoutMs, // lgtm[js/request-forgery]
        };
        jobs.set(job.id, job);
        return job;
    }

    function pushJobEvent(job: ProxyStreamJob, event: ProxyJobEvent) {
        job.updatedAt = Date.now();
        const text = JSON.stringify(event);
        if (job.clients.size === 0) {
            job.pendingEvents.push(text);
            job.pendingBytes += Buffer.byteLength(text);
            while (
                job.pendingEvents.length > PROXY_STREAM_MAX_PENDING_EVENTS ||
                job.pendingBytes > PROXY_STREAM_MAX_PENDING_BYTES
            ) {
                const removed = job.pendingEvents.shift();
                if (!removed) {
                    break;
                }
                job.pendingBytes -= Buffer.byteLength(removed);
            }
            return;
        }
        for (const client of job.clients) {
            if (client.readyState === client.OPEN) {
                client.send(text);
            }
        }
    }

    function markJobDone(job: ProxyStreamJob) {
        if (job.done) {
            return;
        }
        job.done = true;
        job.cleanupAt = Date.now() + PROXY_STREAM_DONE_GRACE_MS;
    }

    function cleanupJob(jobId: string) {
        const job = jobs.get(jobId);
        if (!job) {
            return;
        }
        // Stop any upstream work before the job becomes unreachable.
        job.abortController.abort();
        for (const client of job.clients) {
            try {
                client.close();
            } catch {
                // ignore
            }
        }
        jobs.delete(jobId);
    }

    async function runJob(
        job: ProxyStreamJob,
        run: {
            targetUrl: string;
            headers: Record<string, string>;
            method: string;
            bodyBase64: string;
            clientIp: string | undefined;
        },
    ) {
        const targetUrl = sanitizeTargetUrl(run.targetUrl);
        if (!targetUrl) {
            pushJobEvent(job, { type: "error", status: 400, message: "Blocked non-local target URL" });
            markJobDone(job);
            return;
        }

        const headers = normalizeForwardHeaders(run.headers);
        if (!headers["x-forwarded-for"] && run.clientIp) {
            headers["x-forwarded-for"] = run.clientIp;
        }
        const bodyBuffer = run.bodyBase64 ? Buffer.from(run.bodyBase64, "base64") : undefined;

        try {
            const upstreamResponse = await requestLocalTargetStream(targetUrl, {
                method: run.method,
                headers,
                bodyBuffer,
                timeoutMs: job.timeoutMs,
                signal: job.abortController.signal,
            });

            const filteredHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(upstreamResponse.headers)) {
                if (
                    key === "content-security-policy" ||
                    key === "content-security-policy-report-only" ||
                    key === "clear-site-data"
                ) {
                    continue;
                }
                filteredHeaders[key] = value;
            }

            pushJobEvent(job, { type: "upstream_headers", status: upstreamResponse.status, headers: filteredHeaders });

            for await (const value of upstreamResponse.body) {
                if (job.abortController.signal.aborted) {
                    break;
                }
                if (value && value.length > 0) {
                    pushJobEvent(job, { type: "chunk", dataBase64: Buffer.from(value).toString("base64") });
                }
            }
            pushJobEvent(job, { type: "done" });
            markJobDone(job);
        } catch (error) {
            const aborted = job.abortController.signal.aborted || (error as Error)?.name === "AbortError";
            const message = aborted ? "Proxy stream job aborted" : `${error}`;
            pushJobEvent(job, { type: "error", status: 504, message });
            markJobDone(job);
        }
    }

    function registerRoutes(
        app: Hono<AppEnv>,
        routeArg: { limiter: MiddlewareHandler<AppEnv>; clientIp: (c: Context<AppEnv>) => string | undefined },
    ) {
        app.post("/proxy-stream-jobs", routeArg.limiter, async (c) => {
            const denied = await auth.checkProxyAuth(c);
            if (denied) {
                return denied;
            }
            const parsed = await readJsonBody(c);
            if (!parsed.ok) {
                return parsed.response;
            }
            const body = parsed.body;

            const rawUrl = typeof body.url === "string" ? body.url : "";
            const url = sanitizeTargetUrl(rawUrl);
            if (!url) {
                return c.json(
                    { error: "Invalid target URL. Only local/private network http(s) endpoints are allowed." },
                    400,
                );
            }

            const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
            if (!["POST", "GET", "PUT", "DELETE", "PATCH"].includes(method)) {
                return c.json({ error: "Invalid method" }, 400);
            }

            const bodyBase64 = typeof body.bodyBase64 === "string" ? body.bodyBase64 : "";
            if (bodyBase64.length > PROXY_STREAM_MAX_BODY_BASE64_BYTES) {
                return c.json({ error: "Request body too large" }, 413);
            }
            if (jobs.size >= PROXY_STREAM_MAX_ACTIVE_JOBS) {
                return c.json({ error: "Too many active stream jobs. Retry shortly." }, 429);
            }
            const headers = normalizeForwardHeaders(body.headers);
            const heartbeatSec = normalizeHeartbeatSec(Number(body.heartbeatSec));
            const job = createJob(body.timeoutMs, heartbeatSec);

            void runJob(job, { targetUrl: url, headers, method, bodyBase64, clientIp: routeArg.clientIp(c) });

            return c.json({ jobId: job.id, heartbeatSec: job.heartbeatSec });
        });

        app.delete("/proxy-stream-jobs/:jobId", routeArg.limiter, async (c) => {
            const denied = await auth.checkProxyAuth(c);
            if (denied) {
                return denied;
            }
            const job = jobs.get(c.req.param("jobId"));
            if (!job) {
                return c.json({ success: true });
            }
            job.abortController.abort();
            markJobDone(job);
            cleanupJob(job.id);
            return c.json({ success: true });
        });
    }

    /**
     * The `upgrade` handler for `/proxy-stream-jobs/:jobId/ws`, called by the server's one upgrade
     * dispatcher (`app.ts`). Returns false, leaving the socket untouched, for any other path;
     * otherwise it owns the socket and answers it asynchronously.
     */
    function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
        let reqUrl: URL;
        try {
            reqUrl = new URL(req.url ?? "", `http://${req.headers.host}`);
        } catch {
            return false;
        }
        if (!reqUrl.pathname.startsWith("/proxy-stream-jobs/") || !reqUrl.pathname.endsWith("/ws")) {
            return false;
        }
        void (async () => {
            try {
                const headerAuth = req.headers["risu-auth"];
                const token =
                    reqUrl.searchParams.get("risu-auth") || (Array.isArray(headerAuth) ? headerAuth[0] : headerAuth);
                if (!(await auth.isAuthorizedProxyToken(token))) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    socket.destroy();
                    return;
                }

                const pathParts = reqUrl.pathname.split("/").filter(Boolean);
                const jobId = pathParts.length >= 3 ? pathParts[1] : "";
                if (disposed || !jobs.has(jobId)) {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    socket.destroy();
                    return;
                }

                wsServer.handleUpgrade(req, socket, head, (ws) => onConnection(ws, jobId));
            } catch {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
            }
        })();
        return true;
    }

    function onConnection(ws: WebSocket, jobId: string) {
        const job = jobs.get(jobId);
        if (!job) {
            ws.close();
            return;
        }

        job.clients.add(ws);
        ws.send(JSON.stringify({ type: "job_accepted", jobId }));
        for (const event of job.pendingEvents) {
            ws.send(event);
        }
        job.pendingEvents = [];
        job.pendingBytes = 0;

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) {
                return;
            }
            ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }, job.heartbeatSec * 1000);

        ws.on("close", () => {
            clearInterval(pingTimer);
            const currentJob = jobs.get(jobId);
            if (!currentJob) {
                return;
            }
            currentJob.clients.delete(ws);
            if (currentJob.done && currentJob.clients.size === 0) {
                cleanupJob(jobId);
            }
        });

        ws.on("error", () => {
            clearInterval(pingTimer);
        });
    }

    function startGc() {
        if (gcTimer) {
            return;
        }
        gcTimer = setInterval(() => {
            const now = Date.now();
            for (const [jobId, job] of jobs.entries()) {
                if (!job.done && now >= job.deadlineAt && !job.abortController.signal.aborted) {
                    job.abortController.abort();
                }
                if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && now >= job.cleanupAt) {
                    cleanupJob(jobId);
                    continue;
                }
                if (!job.done && now - job.updatedAt > Math.max(PROXY_STREAM_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
                    cleanupJob(jobId);
                }
            }
        }, PROXY_STREAM_GC_INTERVAL_MS);
    }

    function dispose() {
        clearInterval(gcTimer);
        gcTimer = undefined;
        disposed = true;
        for (const jobId of [...jobs.keys()]) {
            cleanupJob(jobId);
        }
        wsServer.close();
    }

    return { registerRoutes, handleUpgrade, startGc, dispose };
}
