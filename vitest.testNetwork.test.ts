import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { allowTestLoopbackOrigin, createTestNetworkPolicy, testNetwork } from "./vitest.testNetwork.ts";

declare const happyDOM: { waitUntilComplete(): Promise<void> };

// The policy in vitest.testNetwork.ts and the guards vitest.setup.ts installs from it. Tests that
// trip the shared `testNetwork` call its `finish` themselves, so the setup's afterEach stays clean.

describe("test network policy", () => {
    it("allows data: and blob: URLs and refuses everything else unregistered", () => {
        const policy = createTestNetworkPolicy();
        policy.check("data:text/plain,hi");
        policy.check("blob:http://localhost:3000/0b1c");
        for (const url of ["http://127.0.0.1:4321/api", "/api/chat", "https://example.test/v1", "file:///tmp/x"]) {
            expect(() => policy.check(url)).toThrow("Blocked test network request");
        }
        expect(() => policy.check(new Request("https://example.test/v1"))).toThrow("https://example.test/v1");
        expect(() => policy.finish()).toThrow("Blocked test network requests (5)");
    });

    it("allows a registered origin until it is unregistered, across finish calls", () => {
        const policy = createTestNetworkPolicy();
        const unregister = policy.allowLoopbackOrigin("http://127.0.0.1:4321");
        policy.check("http://127.0.0.1:4321/api");
        policy.check(new URL("http://127.0.0.1:4321/other?q=1"));
        policy.finish();
        policy.check("http://127.0.0.1:4321/api");
        expect(() => policy.check("http://127.0.0.1:4322/api")).toThrow();
        expect(() => policy.check("http://localhost:4321/api")).toThrow();
        expect(() => policy.finish()).toThrow("(2)");
        expect(policy.registeredOrigins()).toEqual(["http://127.0.0.1:4321"]);
        unregister();
        expect(() => policy.check("http://127.0.0.1:4321/api")).toThrow();
        expect(() => policy.finish()).toThrow("(1)");
        expect(policy.registeredOrigins()).toEqual([]);
    });

    it("keeps an origin registered twice until both registrations end", () => {
        const policy = createTestNetworkPolicy();
        const first = policy.allowLoopbackOrigin("http://[::1]:4321");
        const second = policy.allowLoopbackOrigin("http://[::1]:4321");
        first();
        first();
        policy.check("http://[::1]:4321/api");
        second();
        expect(() => policy.check("http://[::1]:4321/api")).toThrow();
        expect(() => policy.finish()).toThrow();
    });

    it("checks sockets against the HTTP origin of the same host and port", () => {
        const policy = createTestNetworkPolicy();
        policy.allowLoopbackOrigin("http://127.0.0.1:4321");
        policy.check("ws://127.0.0.1:4321/socket");
        expect(() => policy.check("wss://127.0.0.1:4321/socket")).toThrow();
        expect(() => policy.check("ws://127.0.0.1:4322/socket")).toThrow();
        expect(() => policy.check(new URL("wss://example.test/socket"))).toThrow();
        expect(() => policy.finish()).toThrow("(3)");
    });

    it("refuses origins that are not an exact loopback origin", () => {
        const policy = createTestNetworkPolicy();
        for (const origin of [
            "https://example.test",
            "http://localhost:4321/path",
            "http://127.0.0.1:4321/",
            "http://192.168.0.2:4321",
            "ws://127.0.0.1:4321",
            "file:///tmp",
            "127.0.0.1:4321",
        ]) {
            expect(() => policy.allowLoopbackOrigin(origin)).toThrow("Expected an exact loopback origin");
        }
        expect(policy.registeredOrigins()).toEqual([]);
    });

    it("finish reports a refusal the caller caught and is clean afterwards", () => {
        const policy = createTestNetworkPolicy();
        try {
            policy.check("https://example.test/v1");
        } catch {
            // The code under test swallowed the error.
        }
        expect(() => policy.finish()).toThrow("https://example.test/v1");
        expect(() => policy.finish()).not.toThrow();
    });
});

describe("installed guards (happy-dom)", () => {
    it("refuses a fetch and a WebSocket to a public host", async () => {
        await expect(fetch("https://example.test/v1")).rejects.toThrow("Blocked test network request");
        expect(() => new WebSocket("wss://example.test/socket")).toThrow("Blocked test network request");
        expect(() => testNetwork.finish()).toThrow("Blocked test network requests (2)");
    });

    it("fails an XHR to a public host through happy-dom's loader and leaves no task pending", async () => {
        const xhr = new XMLHttpRequest();
        const events: string[] = [];
        const done = new Promise<void>((resolve) => xhr.addEventListener("loadend", () => resolve()));
        xhr.addEventListener("load", () => events.push("load"));
        xhr.addEventListener("error", () => events.push("error"));
        xhr.open("GET", "https://example.test/v1");
        xhr.send();
        await done;
        expect(events).toEqual(["error"]);
        await happyDOM.waitUntilComplete();
        expect(() => testNetwork.finish()).toThrow("https://example.test/v1");
    });

    it("refuses a sync XHR to a public host", () => {
        const xhr = new XMLHttpRequest();
        const events: string[] = [];
        xhr.addEventListener("load", () => events.push("load"));
        xhr.addEventListener("error", () => events.push("error"));
        xhr.open("GET", "https://example.test/sync", false);
        xhr.send();
        expect(events).toEqual(["error"]);
        expect(() => testNetwork.finish()).toThrow("https://example.test/sync");
    });

    it("refuses a redirect from a registered origin to a public host in happy-dom's fetch", async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(302, { location: "https://example.test/landing" });
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const unregister = allowTestLoopbackOrigin(origin);
        try {
            await expect(fetch(`${origin}/away`)).rejects.toThrow();
            expect(() => testNetwork.finish()).toThrow("https://example.test/landing");
        } finally {
            unregister();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("refuses a WebSocket from a window happy-dom builds later (an iframe's)", () => {
        const iframe = document.createElement("iframe");
        iframe.srcdoc = "";
        document.body.appendChild(iframe);
        try {
            const ChildWebSocket = (iframe.contentWindow as unknown as { WebSocket: typeof WebSocket }).WebSocket;
            expect(ChildWebSocket).not.toBe(globalThis.WebSocket);
            expect(() => new ChildWebSocket("wss://example.test/socket")).toThrow("Blocked test network request");
            expect(() => testNetwork.finish()).toThrow("(1)");
        } finally {
            iframe.remove();
        }
    });

    it("keeps the guards after vi.unstubAllGlobals()", async () => {
        const guardedFetch = globalThis.fetch;
        const GuardedWebSocket = globalThis.WebSocket;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("synthetic")),
        );
        vi.stubGlobal("WebSocket", vi.fn());
        expect(await (await fetch("https://example.test/v1")).text()).toBe("synthetic");
        vi.unstubAllGlobals();
        expect(globalThis.fetch).toBe(guardedFetch);
        expect(globalThis.WebSocket).toBe(GuardedWebSocket);
        await expect(fetch("https://example.test/v1")).rejects.toThrow("Blocked test network request");
        expect(() => testNetwork.finish()).toThrow("(1)");
    });
});
