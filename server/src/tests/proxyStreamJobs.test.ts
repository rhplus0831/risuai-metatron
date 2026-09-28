// @vitest-environment node
import type http from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isLocalNetworkHost, sanitizeTargetUrl } from "../routes/proxyStreamJobs.ts";
import { createTestServer, json, sleep, startUpstream, waitFor } from "./testSupport.ts";

type WsEvent = {
    type: string;
    status?: number;
    message?: string;
    headers?: Record<string, string>;
    dataBase64?: string;
};

describe("isLocalNetworkHost / sanitizeTargetUrl", () => {
    it("accepts local names and private, loopback, unspecified, and link-local IPv4", () => {
        for (const host of [
            "localhost",
            "LOCALHOST.",
            "nas.local",
            "127.0.0.1",
            "127.255.255.255",
            "0.0.0.0",
            "0.255.1.1",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.1.1",
        ]) {
            expect(isLocalNetworkHost(host), host).toBe(true);
        }
    });

    it("rejects public IPv4, single-label names, and range neighbors", () => {
        for (const host of [
            "8.8.8.8",
            "1.0.0.1",
            "128.0.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.169.1.1",
            "169.253.1.1",
            "100.64.0.1",
            "litellm",
            "example.com",
            "",
        ]) {
            expect(isLocalNetworkHost(host), host).toBe(false);
        }
    });

    it("classifies IPv6 by real CIDR ranges, not textual prefixes", () => {
        for (const host of ["::1", "fc00::1", "fd00::1", "fdff:ffff::1", "fe80::1", "febf::1", "fe80::1%eth0"]) {
            expect(isLocalNetworkHost(host), host).toBe(true);
        }
        // fc::1 is 00fc::1 and fe8::1 is 0fe8::1: outside fc00::/7 and fe80::/10.
        for (const host of ["fc::1", "fe8::1", "fe00::1", "fec0::1", "2001:db8::1", "::"]) {
            expect(isLocalNetworkHost(host), host).toBe(false);
        }
        expect(isLocalNetworkHost("::ffff:127.0.0.1")).toBe(true);
        expect(isLocalNetworkHost("::ffff:7f00:1")).toBe(true);
        expect(isLocalNetworkHost("::ffff:10.1.2.3")).toBe(true);
        expect(isLocalNetworkHost("::ffff:8.8.8.8")).toBe(false);
    });

    it("sanitizes job targets: http(s) only, bracketed IPv6 hosts, credentials removed", () => {
        expect(sanitizeTargetUrl("http://user:pw@127.0.0.1/x?y=1")).toBe("http://127.0.0.1/x?y=1");
        expect(sanitizeTargetUrl("https://[::1]:8080/v1")).toBe("https://[::1]:8080/v1");
        expect(sanitizeTargetUrl("http://[fd00::1]/")).toBe("http://[fd00::1]/");
        expect(sanitizeTargetUrl("http://[::ffff:127.0.0.1]/")).toBe("http://[::ffff:7f00:1]/");
        for (const raw of [
            "http://[fc::1]/",
            "http://[fe8::1]/",
            "http://8.8.8.8/",
            "ftp://127.0.0.1/",
            "not a url",
            "",
            5,
        ]) {
            expect(sanitizeTargetUrl(raw), String(raw)).toBeNull();
        }
    });
});

describe("proxy stream jobs", () => {
    let upstream: Awaited<ReturnType<typeof startUpstream>>;
    let server: ReturnType<typeof createTestServer>;
    let node: http.Server | undefined;
    let base = "";
    const auth = { "risu-auth": "pw" };

    beforeAll(async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        upstream = await startUpstream();
    });
    afterAll(() => {
        upstream.close();
        vi.restoreAllMocks();
    });
    afterEach(async () => {
        server?.close();
        if (node) {
            node.closeAllConnections();
            await new Promise((resolve) => node?.close(resolve));
            node = undefined;
        }
        upstream.requests.length = 0;
    });

    /** Starts a real listening server (needed for the WebSocket upgrade path). */
    async function listen() {
        server = createTestServer({ password: "pw" });
        const started = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
        node = started;
        await new Promise<void>((resolve) => started.once("listening", () => resolve()));
        server.context.attachWebSocket(started);
        const { port } = started.address() as { port: number };
        base = `http://127.0.0.1:${port}`;
    }

    async function createJob(body: Record<string, unknown>) {
        const res = await fetch(`${base}/proxy-stream-jobs`, json(body, auth));
        expect(res.status).toBe(200);
        return (await res.json()) as { jobId: string; heartbeatSec: number };
    }

    /** Collects WebSocket events until `done`/`error`, the socket closes, or `maxMs` elapses. */
    function collect(jobId: string, token: string | undefined, maxMs = 3000) {
        return new Promise<{ events: WsEvent[]; closeCode?: number }>((resolve) => {
            const query = token === undefined ? "" : `?risu-auth=${encodeURIComponent(token)}`;
            const ws = new WebSocket(`${base.replace("http", "ws")}/proxy-stream-jobs/${jobId}/ws${query}`);
            const events: WsEvent[] = [];
            let closeCode: number | undefined;
            const timer = setTimeout(() => ws.close(), maxMs);
            ws.onmessage = (message) => {
                const event = JSON.parse(String(message.data)) as WsEvent;
                events.push(event);
                if (event.type === "done" || event.type === "error") {
                    clearTimeout(timer);
                    setTimeout(() => ws.close(), 20);
                }
            };
            ws.onerror = () => {};
            ws.onclose = (event) => {
                clearTimeout(timer);
                closeCode = event.code;
                resolve({ events, closeCode });
            };
        });
    }

    it("validates the request before creating a job", async () => {
        server = createTestServer({ password: "pw" });
        const { app } = server;
        const unauth = await app.request("/proxy-stream-jobs", json({ url: upstream.url }));
        expect(unauth.status).toBe(400);
        const nonLocal = await app.request("/proxy-stream-jobs", json({ url: "http://example.com/" }, auth));
        expect(nonLocal.status).toBe(400);
        expect(await nonLocal.json()).toEqual({
            error: "Invalid target URL. Only local/private network http(s) endpoints are allowed.",
        });
        const badIPv6 = await app.request("/proxy-stream-jobs", json({ url: "http://[fc::1]/" }, auth));
        expect(badIPv6.status).toBe(400);
        const badMethod = await app.request("/proxy-stream-jobs", json({ url: upstream.url, method: "TRACE" }, auth));
        expect(badMethod.status).toBe(400);
        expect(await badMethod.json()).toEqual({ error: "Invalid method" });
        const tooLarge = await app.request(
            "/proxy-stream-jobs",
            json({ url: upstream.url, bodyBase64: "A".repeat(8 * 1024 * 1024 + 1) }, auth),
        );
        expect(tooLarge.status).toBe(413);
        expect(upstream.requests).toHaveLength(0);
    });

    it("forwards the decoded body and lowercased headers, minus risu-auth/host/content-length", async () => {
        server = createTestServer({ password: "pw" });
        const created = await server.app.request(
            "/proxy-stream-jobs",
            json(
                {
                    url: `${upstream.url}/echo`,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: "Bearer key",
                        "Risu-Auth": "must-not-leak",
                        Host: "evil.example",
                        "Content-Length": "999",
                        "X-Forwarded-For": "9.9.9.9",
                    },
                    bodyBase64: Buffer.from('{"a":1}').toString("base64"),
                },
                auth,
            ),
        );
        expect(created.status).toBe(200);
        const record = await upstream.received(1);
        expect(record.method).toBe("POST");
        expect(record.body).toBe('{"a":1}');
        expect(record.headers["content-type"]).toBe("application/json");
        expect(record.headers["content-length"]).toBe("7");
        expect(record.headers.authorization).toBe("Bearer key");
        expect(record.headers["x-forwarded-for"]).toBe("9.9.9.9");
        expect(record.headers["risu-auth"]).toBeUndefined();
        expect(record.headers.host).toBe(new URL(upstream.url).host);
    });

    it("streams job_accepted, upstream_headers, chunks, and done over the WebSocket, and replays pending events", async () => {
        await listen();
        const { jobId, heartbeatSec } = await createJob({ url: `${upstream.url}/sse`, method: "GET", heartbeatSec: 1 });
        expect(heartbeatSec).toBe(5);
        // Connect only after the job finished: everything must come from the pending queue.
        await waitFor(() => upstream.requests[0]?.closed === true);
        const { events } = await collect(jobId, "pw");
        expect(events.map((e) => e.type)).toEqual([
            "job_accepted",
            "upstream_headers",
            "chunk",
            "chunk",
            "chunk",
            "done",
        ]);
        expect(events[1].status).toBe(200);
        expect(events[1].headers?.["content-type"]).toBe("text/event-stream");
        expect(events[1].headers?.["content-security-policy"]).toBeUndefined();
        expect(
            events.filter((e) => e.type === "chunk").map((e) => Buffer.from(e.dataBase64!, "base64").toString()),
        ).toEqual(["data: 0\n\n", "data: 1\n\n", "data: 2\n\n"]);

        const unauth = await collect(jobId, undefined, 500);
        expect(unauth.events).toEqual([]);
        const unknown = await collect("no-such-job", "pw", 500);
        expect(unknown.events).toEqual([]);
    });

    it("DELETE after upstream headers destroys a stalled upstream and closes the WebSocket", async () => {
        await listen();
        const { jobId } = await createJob({ url: `${upstream.url}/stall`, method: "GET" });
        const record = await upstream.received(1);
        const collecting = collect(jobId, "pw", 5000);
        await sleep(100);
        expect(record.closed).toBe(false);

        const deleted = await fetch(`${base}/proxy-stream-jobs/${jobId}`, { method: "DELETE", headers: auth });
        expect(await deleted.json()).toEqual({ success: true });
        await waitFor(() => record.closed);
        const { events } = await collecting;
        expect(events.map((e) => e.type).slice(0, 3)).toEqual(["job_accepted", "upstream_headers", "chunk"]);

        const unknown = await fetch(`${base}/proxy-stream-jobs/${jobId}`, { method: "DELETE", headers: auth });
        expect(await unknown.json()).toEqual({ success: true });
    });

    it("dispose() aborts a job whose upstream stalled after headers", async () => {
        server = createTestServer({ password: "pw" });
        const created = await server.app.request(
            "/proxy-stream-jobs",
            json({ url: `${upstream.url}/stall`, method: "GET" }, auth),
        );
        expect(created.status).toBe(200);
        const record = await upstream.received(1);
        await sleep(50);
        expect(record.closed).toBe(false);
        server.context.dispose();
        await waitFor(() => record.closed);
    });
});
