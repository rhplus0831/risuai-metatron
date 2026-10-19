// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSigner, createTestServer, json, startUpstream, waitFor } from "./testSupport.ts";

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let server: ReturnType<typeof createTestServer>;
const rh = (headers: unknown) => encodeURIComponent(JSON.stringify(headers));
const target = (p: string) => encodeURIComponent(upstream.url + p);

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
    await server?.close();
    upstream.requests.length = 0;
});

describe("/proxy2", () => {
    it("requires proxy auth (stored password or a registered JWT) and a target URL", async () => {
        server = createTestServer({ password: "pw" });
        const { app } = server;
        const unauth = await app.request("/proxy2", {
            method: "POST",
            headers: { "risu-url": target("/echo") },
            body: "{}",
        });
        expect(unauth.status).toBe(400);
        expect(await unauth.json()).toEqual({ error: "No auth header" });

        const noUrl = await app.request("/proxy2", { method: "POST", headers: { "risu-auth": "pw" }, body: "{}" });
        expect(noUrl.status).toBe(400);
        expect(await noUrl.json()).toEqual({ error: "URL has no param" });

        const signer = await createSigner();
        await app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
        const viaJwt = await app.request("/proxy2", {
            headers: { "risu-auth": await signer.jwt(), "risu-url": target("/echo") },
        });
        expect(viaJwt.status).toBe(200);
        const viaQuery = await app.request(`/proxy?url=${target("/echo?q=1")}`, { headers: { "risu-auth": "pw" } });
        expect(((await viaQuery.json()) as { url: string }).url).toBe("/echo?q=1");
    });

    it("forwards the raw body and filters request headers case-insensitively", async () => {
        server = createTestServer({ password: "pw" });
        const res = await server.app.request("/proxy2", {
            method: "POST",
            headers: {
                "risu-auth": "pw",
                "risu-url": target("/echo"),
                "content-type": "application/x-www-form-urlencoded",
                "risu-header": rh({
                    "Content-Type": "application/x-www-form-urlencoded",
                    Authorization: "Bearer key",
                    "x-api-key": "k",
                    "anthropic-version": "2023-06-01",
                    "Risu-Auth": "must-not-leak",
                    Host: "evil.example",
                    "Content-Length": "999",
                    "X-Forwarded-For": "9.9.9.9",
                    Connection: " X-Drop, , keep-alive ",
                    "X-Drop": "dropped",
                    "X-Keep": "kept",
                }),
            },
            body: "a=1&b=2",
        });
        expect(res.status).toBe(200);
        const seen = (await res.json()) as { body: string; headers: Record<string, string> };
        expect(seen.body).toBe("a=1&b=2");
        expect(seen.headers["content-type"]).toBe("application/x-www-form-urlencoded");
        expect(seen.headers["content-length"]).toBe("7");
        expect(seen.headers.authorization).toBe("Bearer key");
        expect(seen.headers["x-api-key"]).toBe("k");
        expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
        expect(seen.headers["x-keep"]).toBe("kept");
        expect(seen.headers["x-forwarded-for"]).toBe("9.9.9.9");
        expect(seen.headers["risu-auth"]).toBeUndefined();
        expect(seen.headers["x-drop"]).toBeUndefined();
        expect(seen.headers.host).toBe(new URL(upstream.url).host);

        // Response side: caching/CSP headers are stripped, the upstream status and body pass through.
        expect(res.headers.get("cache-control")).toBeNull();
        expect(res.headers.get("content-security-policy")).toBeNull();
        expect(res.headers.get("x-upstream")).toBe("echo");
    });

    it("never forwards risu-auth when risu-header is absent and rejects a non-object risu-header", async () => {
        server = createTestServer({ password: "pw" });
        const res = await server.app.request("/proxy2", {
            headers: { "risu-auth": "pw", "risu-url": target("/echo"), "x-custom": "c" },
        });
        const seen = (await res.json()) as { headers: Record<string, string> };
        expect(seen.headers["risu-auth"]).toBeUndefined();
        expect(seen.headers["x-custom"]).toBe("c");

        const bad = await server.app.request("/proxy2", {
            headers: { "risu-auth": "pw", "risu-url": target("/echo"), "risu-header": rh([["X-A", "1"]]) },
        });
        expect(bad.status).toBe(500);
        expect(upstream.requests).toHaveLength(1);
    });

    it("streams SSE through, and a timeout before upstream headers is a 504", async () => {
        server = createTestServer({ password: "pw" });
        const sse = await server.app.request("/proxy2", {
            method: "POST",
            headers: { "risu-auth": "pw", "risu-url": target("/sse"), "risu-header": rh({}) },
            body: "{}",
        });
        expect(sse.headers.get("content-type")).toBe("text/event-stream");
        expect(sse.headers.get("content-security-policy")).toBeNull();
        expect(await sse.text()).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\n");

        const timeout = await server.app.request("/proxy2", {
            method: "POST",
            headers: {
                "risu-auth": "pw",
                "risu-url": target("/hang"),
                "risu-header": rh({}),
                "risu-timeout-ms": "100",
            },
            body: "{}",
        });
        expect(timeout.status).toBe(504);
        expect(await timeout.json()).toEqual({ error: "Proxy request timed out after 100ms" });
        await waitFor(() => upstream.requests[1]?.closed === true);
    });

    it("answers HEAD with headers only and closes the upstream body", async () => {
        server = createTestServer({ password: "pw" });
        const res = await server.app.request("/proxy2", {
            method: "HEAD",
            headers: { "risu-auth": "pw", "risu-url": target("/stall"), "risu-header": rh({}) },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        expect((await res.arrayBuffer()).byteLength).toBe(0);
        const record = await upstream.received(1);
        expect(record.method).toBe("GET");
        await waitFor(() => record.closed);
    });
});

describe("/hub-proxy", () => {
    it("reaches only the hub (never x-risu-node-path), strips risu-auth, and follows one redirect within the hub's origin", async () => {
        server = createTestServer({ password: "pw", realm: { hubURL: upstream.url } });
        const res = await server.app.request("/hub-proxy/echo?viahub=1", {
            headers: {
                "x-risu-node-path": encodeURIComponent("http://127.0.0.1:1/elsewhere"),
                "risu-auth": "pw",
                "x-custom": "hub",
            },
        });
        expect(res.status).toBe(200);
        const seen = (await res.json()) as { url: string; headers: Record<string, string> };
        expect(seen.url).toBe("/echo?viahub=1");
        expect(seen.headers.origin).toBe(upstream.url);
        expect(seen.headers["x-custom"]).toBe("hub");
        expect(seen.headers["risu-auth"]).toBeUndefined();
        expect(seen.headers["x-risu-node-path"]).toBeUndefined();
        expect(upstream.requests).toHaveLength(1);

        const redirected = await server.app.request("/hub-proxy/redirect");
        expect(redirected.status).toBe(200);
        expect(redirected.headers.get("x-final")).toBe("yes");
        expect(redirected.headers.get("x-first")).toBeNull();
        expect(await redirected.text()).toBe("final body");
        expect(upstream.requests.map((r) => r.url)).toEqual(["/echo?viahub=1", "/redirect", "/final?from=redirect"]);
    });

    it("answers a redirect to another origin to the browser as it is, without fetching it", async () => {
        server = createTestServer({ password: "pw", realm: { hubURL: upstream.url } });
        const res = await server.app.request("/hub-proxy/redirect-off/docs/lua");
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("https://docs.example/lua");
        expect(res.headers.get("x-first")).toBe("yes");
        expect(await res.text()).toBe("moved");
        expect(upstream.requests.map((r) => r.url)).toEqual(["/redirect-off/docs/lua"]);
    });

    it("answers 502 when the hub cannot be reached", async () => {
        server = createTestServer({ password: "pw", realm: { hubURL: "http://127.0.0.1:1" } });
        const failed = await server.app.request("/hub-proxy/r");
        expect(failed.status).toBe(502);
        expect(((await failed.json()) as { error: string }).error).toMatch(/^Proxy request failed: /);
        expect(upstream.requests).toHaveLength(0);
    });
});
