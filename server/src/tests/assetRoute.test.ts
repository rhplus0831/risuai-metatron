// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetVerification } from "../http/assetVerification.ts";
import { resolveStorageKey } from "../routes/storage.ts";
import { buildArchive, createResourceTestClient, hex, parseArchive, type ResourceTestClient } from "./testSupport.ts";

let s: ResourceTestClient;
beforeEach(async () => {
    // JWT validity and rate-limit windows stay fixed regardless of machine load.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await createResourceTestClient();
});
afterEach(async () => {
    await assetVerification.idle();
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

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const assetPath = (key: string) => resolveStorageKey(s.savePath, key)!;
async function writeOnDisk(key: string, bytes: string) {
    const fullPath = assetPath(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, bytes);
}
async function weakEtag(key: string) {
    const stat = await fs.stat(assetPath(key), { bigint: true });
    return `W/"${stat.size}-${stat.mtimeNs}-${stat.ino}"`;
}
async function expectAssetCache(key: string, bytes: string, cacheControl: string, etag: string, method = "GET") {
    const response = await read(key, { method });
    expect(await response.text()).toBe(method === "HEAD" ? "" : bytes);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(cacheControl);
    expect(response.headers.get("etag")).toBe(etag);
}

describe("verified content-name caching", () => {
    it("makes matching writes immediately immutable with a strong SHA-256 ETag for GET and HEAD", async () => {
        const bytes = "matching asset bytes";
        const digest = sha256(bytes);
        for (const key of [`assets/${digest}.png`, `assets/inlay_${digest}.png`]) {
            await write(key, bytes);
            for (const method of ["GET", "HEAD"]) {
                await expectAssetCache(
                    key,
                    bytes,
                    "private, max-age=31536000, immutable",
                    `"sha256-${digest}"`,
                    method,
                );
            }
        }
    });

    it("keeps mismatched writes and disk files no-cache with their weak stat ETags after hashing", async () => {
        const bytes = "bytes that do not match the name";
        const digest = sha256("expected asset bytes");
        for (const [key, put] of [
            [`assets/${digest}.png`, write],
            [`assets/inlay_${digest}.png`, writeOnDisk],
        ] as const) {
            await put(key, bytes);
            const etag = await weakEtag(key);
            await expectAssetCache(key, bytes, "private, no-cache", etag);
            await assetVerification.idle();
            for (const method of ["GET", "HEAD"]) {
                await expectAssetCache(key, bytes, "private, no-cache", etag, method);
            }
        }
    });

    it("serves a disk-only content name no-cache first and immutable after background verification", async () => {
        const bytes = "asset installed outside the server";
        const digest = sha256(bytes);
        const key = `assets/${digest}.png`;
        await writeOnDisk(key, bytes);
        await expectAssetCache(key, bytes, "private, no-cache", await weakEtag(key));
        await assetVerification.idle();
        await expectAssetCache(key, bytes, "private, max-age=31536000, immutable", `"sha256-${digest}"`);
    });

    it("requires new verification when an outside replacement changes a verified file's stat", async () => {
        const bytes = "unchanged content in a replacement file";
        const digest = sha256(bytes);
        const key = `assets/${digest}.png`;
        await write(key, bytes);
        await expectAssetCache(key, bytes, "private, max-age=31536000, immutable", `"sha256-${digest}"`);
        const oldStat = await fs.stat(assetPath(key), { bigint: true });
        const replacement = path.join(s.savePath, ".tmp", "replacement.png");
        await fs.writeFile(replacement, bytes);
        // Fixed timestamps and a separately allocated inode make the stat change independent of clock resolution.
        await fs.utimes(replacement, 1, 1);
        await fs.rename(replacement, assetPath(key));
        const newStat = await fs.stat(assetPath(key), { bigint: true });
        expect(newStat.ino).not.toBe(oldStat.ino);
        expect(newStat.mtimeNs).not.toBe(oldStat.mtimeNs);
        await expectAssetCache(key, bytes, "private, no-cache", await weakEtag(key));
        await assetVerification.idle();
        await expectAssetCache(key, bytes, "private, max-age=31536000, immutable", `"sha256-${digest}"`);
    });

    it("keeps custom IDs and uppercase hash names no-cache even after the queue is idle", async () => {
        const bytes = "custom asset bytes";
        for (const key of ["assets/custom.png", `assets/${sha256(bytes).toUpperCase()}.png`]) {
            await write(key, bytes);
            const etag = await weakEtag(key);
            await expectAssetCache(key, bytes, "private, no-cache", etag);
            await assetVerification.idle();
            await expectAssetCache(key, bytes, "private, no-cache", etag);
        }
    });

    it("upgrades strong and earlier weak validators to immutable on 304 while retaining the matching ETag", async () => {
        const bytes = "cached before verification";
        const digest = sha256(bytes);
        const key = `assets/${digest}.png`;
        await writeOnDisk(key, bytes);
        const initial = await read(key);
        expect(await initial.text()).toBe(bytes);
        expect(initial.status).toBe(200);
        expect(initial.headers.get("cache-control")).toBe("private, no-cache");
        const earlierWeakEtag = initial.headers.get("etag")!;
        expect(earlierWeakEtag).toBe(await weakEtag(key));
        await assetVerification.idle();

        for (const etag of [`"sha256-${digest}"`, earlierWeakEtag]) {
            for (const method of ["GET", "HEAD"]) {
                const response = await read(key, { method, headers: { "If-None-Match": etag } });
                expect(await response.text()).toBe("");
                expect(response.status).toBe(304);
                expect(response.headers.get("etag")).toBe(etag);
                expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
            }
        }
    });

    it("makes a matching batch write immutable on the next GET", async () => {
        const bytes = "batch asset bytes";
        const digest = sha256(bytes);
        const key = `assets/inlay_${digest}.png`;
        const response = await s.request("/api/assets/write", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: buildArchive([[key, bytes]]) as RequestInit["body"],
        });
        await response.arrayBuffer();
        expect(response.status).toBe(200);
        await expectAssetCache(key, bytes, "private, max-age=31536000, immutable", `"sha256-${digest}"`);
    });

    it("forgets verification on removal even when a direct recreation preserves the bytes and stat", async () => {
        const bytes = "removed and recreated asset";
        const digest = sha256(bytes);
        const key = `assets/${digest}.png`;
        await write(key, bytes);
        await expectAssetCache(key, bytes, "private, max-age=31536000, immutable", `"sha256-${digest}"`);
        const etag = await weakEtag(key);
        const preserved = path.join(s.savePath, ".tmp", "preserved.png");
        // Re-link the same inode so a changed stat cannot hide a failure to forget the verification.
        await fs.link(assetPath(key), preserved);
        const removed = await s.request("/api/remove", { headers: { "file-path": hex(key) } });
        await removed.arrayBuffer();
        expect(removed.status).toBe(200);
        await fs.link(preserved, assetPath(key));
        expect(await weakEtag(key)).toBe(etag);
        await expectAssetCache(key, bytes, "private, no-cache", etag);
        await assetVerification.idle();
        await expectAssetCache(key, bytes, "private, max-age=31536000, immutable", `"sha256-${digest}"`);
    });

    it("makes a content-name asset restored from a version-2 backup immutable on the next GET", async () => {
        const bytes = "restored asset bytes";
        const digest = sha256(bytes);
        const key = `assets/${digest}.png`;
        const exported = await s.json("/api/backups/export", {});
        expect(exported.status).toBe(200);
        const records = parseArchive(new Uint8Array(await exported.arrayBuffer()));
        const database = records.find((record) => record.name === "resources.sqlite")!;
        const archive = buildArchive([
            [
                "manifest.json",
                JSON.stringify({
                    version: 2,
                    createdAt: "2026-01-01T00:00:00.000Z",
                    partial: false,
                    assets: [key],
                    missing: [],
                }),
            ],
            ["resources.sqlite", database.data],
            [key, bytes],
        ]);
        const imported = await s.request("/api/backups/import", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: archive as RequestInit["body"],
        });
        expect(await imported.json()).toMatchObject({ assetsWritten: 1 });
        expect(imported.status).toBe(200);
        await expectAssetCache(key, bytes, "private, max-age=31536000, immutable", `"sha256-${digest}"`);
    });
});

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
            ["flac", "audio/flac", "inline"],
            ["m4a", "audio/mp4", "inline"],
            ["mp4", "video/mp4", "inline"],
            ["webm", "video/webm", "inline"],
            ["mkv", "video/x-matroska", "inline"],
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
