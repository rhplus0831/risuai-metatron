// @vitest-environment node
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowTestLoopbackOrigin, testNetwork } from "./vitest.testNetwork.ts";

// The guards vitest.setup.ts installs, under Node's own fetch and WebSocket (undici).

let server: http.Server;
let origin: string;
let unregister: () => void;
beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === "/away") {
            res.writeHead(302, { location: "https://example.test/landing" });
        } else if (req.url === "/authority") {
            // http://example.test//127.0.0.1:<port>/landing: a `//` path naming the registered host.
            res.writeHead(302, { location: `http://example.test${origin.slice("http:".length)}/landing` });
        } else if (req.url === "/here") {
            res.writeHead(302, { location: "/ok" });
        } else {
            res.writeHead(200);
        }
        res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    unregister = allowTestLoopbackOrigin(origin);
});
afterAll(async () => {
    unregister();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("installed guards (node)", () => {
    it("reaches a registered origin and follows a redirect within it", async () => {
        const res = await fetch(`${origin}/here`);
        expect(res.status).toBe(200);
        expect(res.url).toBe(`${origin}/ok`);
    });

    it("refuses a redirect from a registered origin to a public host", async () => {
        await expect(fetch(`${origin}/away`)).rejects.toThrow();
        expect(() => testNetwork.finish()).toThrow("https://example.test/landing");
    });

    it("checks a redirect hop by the host it connects to, whatever its path", async () => {
        await expect(fetch(`${origin}/authority`)).rejects.toThrow();
        expect(() => testNetwork.finish()).toThrow(`http://example.test${origin.slice("http:".length)}/landing`);
    });

    it("refuses a fetch and a WebSocket to a public host", async () => {
        await expect(fetch("https://example.test/v1")).rejects.toThrow("Blocked test network request");
        expect(() => new WebSocket("wss://example.test/socket")).toThrow("Blocked test network request");
        expect(() => testNetwork.finish()).toThrow("Blocked test network requests (2)");
    });
});
