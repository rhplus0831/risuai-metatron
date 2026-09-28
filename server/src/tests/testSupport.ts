// Shared helpers for the server tests (not a test file itself).
import { webcrypto } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServerContext } from "../app.ts";

export const TEST_INDEX_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';

/** A server context over a temporary `rootDir` with a minimal `dist/index.html`. */
export function createTestServer(options: { password?: string } = {}) {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-server-test-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
    const savePath = path.join(rootDir, "save");
    mkdirSync(savePath);
    if (options.password !== undefined) {
        writeFileSync(path.join(savePath, "__password"), options.password);
    }
    const context = createServerContext({ rootDir });
    return {
        rootDir,
        savePath,
        context,
        app: context.app,
        close() {
            context.dispose();
            rmSync(rootDir, { recursive: true, force: true });
        },
    };
}

export const hex = (s: string) => Buffer.from(s, "utf-8").toString("hex");
export const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
});

/** An ES256 key pair with a JWT signer matching `NodeStorage.createAuth`. */
export async function createSigner() {
    const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return {
        publicJwk,
        async jwt(opts: { exp?: number; alg?: string; breakSignature?: boolean } = {}) {
            const now = Math.floor(Date.now() / 1000);
            const header = b64({ alg: opts.alg ?? "ES256", typ: "JWT" });
            const payload = b64({ iat: now, exp: opts.exp ?? now + 300, pub: publicJwk });
            const signature = Buffer.from(
                await webcrypto.subtle.sign(
                    { name: "ECDSA", hash: "SHA-256" },
                    keyPair.privateKey,
                    Buffer.from(`${header}.${payload}`),
                ),
            );
            if (opts.breakSignature) {
                signature[0] ^= 0xff;
            }
            return `${header}.${payload}.${signature.toString("base64url")}`;
        },
    };
}

export type UpstreamRequest = {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
    /** True once the upstream response (and its socket) closed. */
    closed: boolean;
};

/**
 * A local HTTP upstream that records every request. Paths: `/echo` returns the request as JSON with
 * `cache-control` and CSP headers; `/sse` streams three events; `/stall` sends headers and one
 * chunk, then never ends; `/hang` never responds; `/redirect` sends a relative 302 to `/final`.
 */
export async function startUpstream() {
    const requests: UpstreamRequest[] = [];
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        req.on("error", () => {});
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const record: UpstreamRequest = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
            closed: false,
        };
        requests.push(record);
        res.on("close", () => {
            record.closed = true;
        });
        const url = req.url ?? "";
        if (url.startsWith("/sse")) {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "content-security-policy": "default-src 'none'",
            });
            let i = 0;
            const timer = setInterval(() => {
                res.write(`data: ${i}\n\n`);
                if (++i === 3) {
                    clearInterval(timer);
                    res.end();
                }
            }, 20);
            return;
        }
        if (url.startsWith("/stall")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.flushHeaders();
            res.write("data: first\n\n");
            return;
        }
        if (url.startsWith("/hang")) {
            return;
        }
        if (url.startsWith("/redirect")) {
            res.writeHead(302, { location: "/final?from=redirect", "x-first": "yes" });
            res.end("moved");
            return;
        }
        if (url.startsWith("/final")) {
            res.writeHead(200, { "content-type": "text/plain", "x-final": "yes" });
            res.end("final body");
            return;
        }
        res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "max-age=100",
            "content-security-policy": "default-src 'none'",
            "x-upstream": "echo",
        });
        res.end(JSON.stringify({ method: record.method, url: record.url, headers: record.headers, body: record.body }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        /** Waits until the upstream has received `count` requests. */
        async received(count: number, timeoutMs = 2000) {
            await waitFor(() => requests.length >= count, timeoutMs);
            return requests[count - 1];
        },
        close() {
            server.closeAllConnections();
            server.close();
        },
    };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000, stepMs = 10) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("waitFor: condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
