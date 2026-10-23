// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResourceTestClient, hex, type ResourceTestClient } from "./testSupport.ts";

let s: ResourceTestClient;
beforeEach(async () => {
    // JWT validity and rate-limit windows stay fixed regardless of machine load.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await createResourceTestClient();
});
afterEach(async () => {
    await s?.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const assetUrl = (key: string) => `/api/asset/${hex(key)}`;
const read = (key: string, init: RequestInit = {}) => s.request(assetUrl(key), init);
async function write(key: string, body: string | Uint8Array) {
    const response = await s.request("/api/write", {
        method: "POST",
        headers: { "file-path": hex(key) },
        body: body as RequestInit["body"],
    });
    await response.arrayBuffer();
    expect(response.status, `write ${key}`).toBe(200);
}

describe("authenticated asset URLs", () => {
    it("requires a valid risu-auth JWT for GET and HEAD", async () => {
        const key = "assets/private.png";
        await write(key, "private bytes");
        const badSignature = await s.signer.jwt({ breakSignature: true });
        const tokens = [
            { label: "missing JWT", token: undefined },
            { label: "stored password instead of JWT", token: "pw" },
            { label: "invalid JWT signature", token: badSignature },
        ];
        for (const method of ["GET", "HEAD"]) {
            for (const { label, token } of tokens) {
                const response = await s.app.request(assetUrl(key), {
                    method,
                    headers: token === undefined ? {} : { "risu-auth": token },
                });
                await response.arrayBuffer();
                expect.soft(response.status, `${method}, ${label}`).toBe(401);
            }
        }
    });

    it("serves exact bytes with extension MIME types and the required disposition", async () => {
        const bytes = new Uint8Array([0, 255, 128, 13, 10, 60, 62]);
        const cases = [
            ["png", "image/png", "inline"],
            ["jpg", "image/jpeg", "inline"],
            ["jpeg", "image/jpeg", "inline"],
            ["webp", "image/webp", "inline"],
            ["gif", "image/gif", "inline"],
            ["avif", "image/avif", "inline"],
            ["svg", "image/svg+xml", "inline"],
            ["mp3", "audio/mpeg", "inline"],
            ["ogg", "audio/ogg", "inline"],
            ["wav", "audio/wav", "inline"],
            ["m4a", "audio/mp4", "inline"],
            ["mp4", "video/mp4", "inline"],
            ["webm", "video/webm", "inline"],
            ["woff2", "font/woff2", "inline"],
            ["ttf", "font/ttf", "inline"],
            ["otf", "font/otf", "inline"],
            ["json", "application/json", "inline"],
            ["unknown", "application/octet-stream", "inline"],
            ["html", "application/octet-stream", "attachment"],
            ["htm", "application/octet-stream", "attachment"],
            ["xhtml", "application/octet-stream", "attachment"],
            ["xml", "application/octet-stream", "attachment"],
            ["js", "application/octet-stream", "attachment"],
            ["mjs", "application/octet-stream", "attachment"],
        ];
        for (const [extension, mime, disposition] of cases) {
            // A non-ASCII logical key exercises the URL's UTF-8 hex encoding too.
            const key = `assets/그림.${extension}`;
            await write(key, bytes);
            const response = await read(key);
            const body = new Uint8Array(await response.arrayBuffer());
            expect(response.status, extension).toBe(200);
            expect(response.headers.get("content-type"), extension).toBe(mime);
            expect(response.headers.get("content-disposition"), extension).toBe(disposition);
            expect(body, extension).toEqual(bytes);
        }
    });

    it("answers HEAD with the full Content-Length and no body", async () => {
        const key = "assets/head.png";
        const bytes = new Uint8Array([0, 255, 128, 13, 10]);
        await write(key, bytes);
        const response = await read(key, { method: "HEAD" });
        const body = await response.arrayBuffer();
        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("content-disposition")).toBe("inline");
        expect(response.headers.get("cache-control")).toBe("private, no-cache");
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("etag")).toMatch(/^W\//);
        expect(body.byteLength).toBe(0);
    });

    it("serves one byte range, rejects an unsatisfiable range, and ignores multiple ranges", async () => {
        const key = "assets/range.mp4";
        await write(key, "0123456789");
        const cases = [
            { range: "bytes=2-5", status: 206, contentRange: "bytes 2-5/10", body: "2345" },
            { range: "bytes=7-", status: 206, contentRange: "bytes 7-9/10", body: "789" },
            { range: "bytes=-3", status: 206, contentRange: "bytes 7-9/10", body: "789" },
            { range: "bytes=10-", status: 416, contentRange: "bytes */10", body: null },
            { range: "bytes=0-1,4-5", status: 200, contentRange: null, body: "0123456789" },
        ];
        for (const { range, status, contentRange, body } of cases) {
            const response = await read(key, { headers: { Range: range } });
            const actualBody = await response.text();
            expect(response.status, range).toBe(status);
            expect(response.headers.get("content-range"), range).toBe(contentRange);
            expect(response.headers.get("accept-ranges"), range).toBe("bytes");
            if (body !== null) {
                expect(actualBody, range).toBe(body);
                expect(response.headers.get("content-length"), range).toBe(String(body.length));
                expect(response.headers.get("content-type"), range).toBe("video/mp4");
                expect(response.headers.get("cache-control"), range).toBe("private, no-cache");
            }
        }
    });

    it("uses a weak ETag for conditional requests and private revalidation caching", async () => {
        const key = "assets/validator.png";
        await write(key, "image bytes");
        const initial = await read(key);
        expect(await initial.text()).toBe("image bytes");
        expect(initial.status).toBe(200);
        expect(initial.headers.get("cache-control")).toBe("private, no-cache");
        const etag = initial.headers.get("etag")!;
        expect(etag).toMatch(/^W\//);

        for (const method of ["GET", "HEAD"]) {
            const unchanged = await read(key, { method, headers: { "If-None-Match": etag } });
            const body = await unchanged.arrayBuffer();
            expect(unchanged.status, method).toBe(304);
            expect(body.byteLength, method).toBe(0);
            expect(unchanged.headers.get("etag"), method).toBe(etag);
            expect(unchanged.headers.get("cache-control"), method).toBe("private, no-cache");
        }

        const changed = await read(key, { headers: { "If-None-Match": 'W/"different"' } });
        expect(await changed.text()).toBe("image bytes");
        expect(changed.status).toBe(200);
        expect(changed.headers.get("cache-control")).toBe("private, no-cache");
    });

    it("answers missing keys and keys without a storage location with 404 and no-store", async () => {
        // The password exists on disk, but its namespace is never an asset storage location.
        for (const key of ["assets/missing.png", "server/password"]) {
            const response = await read(key);
            await response.arrayBuffer();
            expect(response.status, key).toBe(404);
            expect(response.headers.get("cache-control"), key).toBe("no-store");
        }
    });

    it("keeps security headers and Accept-Ranges on successes, 304s, and errors", async () => {
        const key = "assets/sandbox.svg";
        await write(key, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const initial = await read(key);
        await initial.arrayBuffer();
        const etag = initial.headers.get("etag")!;
        const cases: [number, () => Promise<Response>][] = [
            [200, () => read(key)],
            [206, () => read(key, { headers: { Range: "bytes=0-3" } })],
            [304, () => read(key, { headers: { "If-None-Match": etag } })],
            [401, async () => s.app.request(assetUrl(key))],
            [404, () => read("assets/missing.svg")],
            [416, () => read(key, { headers: { Range: "bytes=999-" } })],
        ];
        for (const [status, request] of cases) {
            const response = await request();
            await response.arrayBuffer();
            expect(response.status).toBe(status);
            expect(response.headers.get("content-security-policy"), String(status)).toBe(
                "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
            );
            expect(response.headers.get("x-content-type-options"), String(status)).toBe("nosniff");
            expect(response.headers.get("cross-origin-resource-policy"), String(status)).toBe("same-origin");
            expect(response.headers.get("accept-ranges"), String(status)).toBe("bytes");
        }
    });

    it("keeps size and bytes consistent when a file is replaced atomically during a read", async () => {
        const key = "assets/replace.bin";
        await write(key, "old");
        const fullPath = path.join(s.savePath, "assets", "replace.bin");
        const realOpen = fs.open.bind(fs);
        let replaceOnOpen = true;
        const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await realOpen(...args);
            if (replaceOnOpen && args[0] === fullPath) {
                replaceOnOpen = false;
                // Hold the open result until the HTTP write renames a new file into place.
                // A path stat now sees the replacement; the reader's handle still sees "old".
                try {
                    await write(key, "new-longer");
                } catch (error) {
                    await handle.close();
                    throw error;
                }
            }
            return handle;
        });
        let reader: Response;
        try {
            reader = await read(key);
        } finally {
            open.mockRestore();
        }
        const body = await reader.text();
        expect(reader.status).toBe(200);
        expect(reader.headers.get("content-length")).toBe("3");
        expect(body).toBe("old");
        const replacement = await read(key);
        expect(await replacement.text()).toBe("new-longer");
        expect(replacement.status).toBe(200);
        expect(replacement.headers.get("content-length")).toBe("10");
    });

    it("records failed requests under the route template without exposing the hex key", async () => {
        const key = "assets/private portrait.png";
        const url = assetUrl(key);
        const before = s.context.diagnostics.recent().length;
        const denied = await s.app.request(url);
        await denied.arrayBuffer();
        expect(denied.status).toBe(401);
        const missing = await s.request(url);
        await missing.arrayBuffer();
        expect(missing.status).toBe(404);

        const events = s.context.diagnostics
            .recent()
            .slice(before)
            .filter((event) => event.kind === "http");
        expect(events.map(({ method, route, status }) => ({ method, route, status }))).toEqual([
            { method: "GET", route: "/api/asset/*", status: 401 },
            { method: "GET", route: "/api/asset/*", status: 404 },
        ]);
        const recorded = JSON.stringify(events);
        expect(recorded).not.toContain(hex(key));
        expect(recorded).not.toContain(key);
        expect(recorded).not.toContain(url);
    });
});
