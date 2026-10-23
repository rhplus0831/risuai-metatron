// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServerContext } from "../app.ts";
import { decodeFileName, decodeKeyHeader, encodeFileName, resolveStorageKey } from "../routes/storage.ts";
import {
    buildArchive,
    createResourceTestClient,
    createSigner,
    createTestServer,
    hex,
    json,
    TEST_INDEX_HTML,
} from "./testSupport.ts";

let server: ReturnType<typeof createTestServer>;
const servers: ReturnType<typeof createTestServer>[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});
function freshServer(options?: { password?: string }) {
    server = createTestServer(options);
    servers.push(server);
    return server;
}

describe("GET / and /index.html", () => {
    const modifiedAt = new Date("2025-01-01T00:00:00Z");

    // Without the flag the client shows only the "self-host server required" notice, so both
    // entry URLs must inject it (with or without a query string, which deep links carry).
    it("injects the __NODE__ flag and revalidates both entry URLs", async () => {
        const { app, rootDir } = freshServer();
        utimesSync(path.join(rootDir, "dist", "index.html"), modifiedAt, modifiedAt);
        for (const url of ["/", "/?x=1", "/index.html", "/index.html?share=abc"]) {
            const res = await app.request(url);
            expect(res.status, url).toBe(200);
            expect(res.headers.get("content-type"), url).toMatch(/^text\/html/);
            expect(res.headers.get("cache-control"), url).toBe("no-cache");
            expect(res.headers.get("etag"), url).toMatch(/^W\//);
            expect(res.headers.get("last-modified"), url).toBe(modifiedAt.toUTCString());
            const html = await res.text();
            expect(html, url).toContain('<head><script>globalThis.__NODE__ = true</script><meta charset="utf-8">');
            expect(html.match(/__NODE__/g), url).toHaveLength(1);
        }
    });

    it("caches content-hashed assets immutably for one year", async () => {
        const { app, rootDir } = freshServer();
        const content = 'console.log("app");';
        mkdirSync(path.join(rootDir, "dist", "assets"));
        writeFileSync(path.join(rootDir, "dist", "assets", "index-abc123.js"), content);

        const res = await app.request("/assets/index-abc123.js");
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(await res.text()).toBe(content);
    });

    it("revalidates the service worker, manifest, and other unversioned static files", async () => {
        const { app, rootDir } = freshServer();
        for (const [filename, content] of [
            ["sw.js", "self.version = 1;"],
            ["manifest.json", '{"name":"Test app"}'],
            ["other.txt", "Unversioned content"],
        ]) {
            const filePath = path.join(rootDir, "dist", filename);
            writeFileSync(filePath, content);
            utimesSync(filePath, modifiedAt, modifiedAt);

            const res = await app.request(`/${filename}`);
            expect(res.status, filename).toBe(200);
            expect(res.headers.get("cache-control"), filename).toBe("no-cache");
            expect(res.headers.get("etag"), filename).toMatch(/^W\//);
            expect(res.headers.get("last-modified"), filename).toBe(modifiedAt.toUTCString());
            expect(await res.text(), filename).toBe(content);
        }
    });

    it.each(["/index.html", "/sw.js"])(
        "returns an empty 304 for matching validators and the full body for a non-matching ETag on %s",
        async (url) => {
            const { app, rootDir } = freshServer();
            const content = url === "/index.html" ? TEST_INDEX_HTML : "self.version = 1;";
            const expectedBody =
                url === "/index.html"
                    ? content.replace("<head>", "<head><script>globalThis.__NODE__ = true</script>")
                    : content;
            const filePath = path.join(rootDir, "dist", url.slice(1));
            writeFileSync(filePath, content);
            utimesSync(filePath, modifiedAt, modifiedAt);

            const first = await app.request(url);
            expect(first.status).toBe(200);
            expect(await first.text()).toBe(expectedBody);
            const etag = first.headers.get("etag") ?? "";
            const lastModified = first.headers.get("last-modified") ?? "";
            expect(etag).toMatch(/^W\//);
            expect(lastModified).toBe(modifiedAt.toUTCString());

            for (const [header, validator] of [
                ["If-None-Match", etag],
                ["If-Modified-Since", lastModified],
            ]) {
                const unchanged = await app.request(url, { headers: { [header]: validator } });
                expect(unchanged.status, header).toBe(304);
                expect(await unchanged.text(), header).toBe("");
            }

            const nonMatching = await app.request(url, {
                headers: { "If-None-Match": 'W/"outdated"', "If-Modified-Since": lastModified },
            });
            expect(nonMatching.status).toBe(200);
            expect(await nonMatching.text()).toBe(expectedBody);
        },
    );

    it("delivers a changed service worker with a new ETag when sent the old ETag", async () => {
        const { app, rootDir } = freshServer();
        const filePath = path.join(rootDir, "dist", "sw.js");
        writeFileSync(filePath, "self.version = 1;");
        utimesSync(filePath, modifiedAt, modifiedAt);
        const first = await app.request("/sw.js");
        expect(first.status).toBe(200);
        expect(await first.text()).toBe("self.version = 1;");
        const oldEtag = first.headers.get("etag") ?? "";
        expect(oldEtag).toMatch(/^W\//);

        const updatedAt = new Date("2025-01-02T00:00:00Z");
        writeFileSync(filePath, "self.version = 2;");
        utimesSync(filePath, updatedAt, updatedAt);

        const updated = await app.request("/sw.js", { headers: { "If-None-Match": oldEtag } });
        expect(updated.status).toBe(200);
        expect(await updated.text()).toBe("self.version = 2;");
        expect(updated.headers.get("cache-control")).toBe("no-cache");
        expect(updated.headers.get("etag")).toMatch(/^W\//);
        expect(updated.headers.get("etag")).not.toBe(oldEtag);
        expect(updated.headers.get("last-modified")).toBe(updatedAt.toUTCString());
    });

    it("serves other static files raw and keeps 404 for missing paths and non-GET entry requests", async () => {
        const { app, rootDir } = freshServer();
        writeFileSync(path.join(rootDir, "dist", "other.html"), TEST_INDEX_HTML);

        const other = await app.request("/other.html");
        expect(other.status).toBe(200);
        expect(await other.text()).not.toContain("__NODE__");

        expect((await app.request("/does-not-exist")).status).toBe(404);
        expect((await app.request("/index.html", { method: "POST" })).status).toBe(404);
    });

    // A reload or a link on a screen route (`shared/routes.ts`) must land on the client with the flag.
    it("serves the flagged client with no-cache for the client's screen routes and nothing else", async () => {
        const { app } = freshServer();
        for (const url of [
            "/chat/c1/chat-1",
            "/chat/%C2%A7playground/a%2Fb",
            "/settings",
            "/settings/model/",
            "/playground/tokenizer?x=1",
            "/realm",
            "/characters",
        ]) {
            const res = await app.request(url);
            expect(res.status, url).toBe(200);
            expect(res.headers.get("content-type"), url).toMatch(/^text\/html/);
            expect(res.headers.get("cache-control"), url).toBe("no-cache");
            const html = await res.text();
            expect(html.match(/__NODE__/g), url).toHaveLength(1);
        }
        expect((await app.request("/settings/model", { method: "HEAD" })).status).toBe(200);

        for (const url of ["/chat.js", "/settingsX", "/api/missing", "/assets/missing.js"]) {
            expect((await app.request(url)).status, url).toBe(404);
        }
        expect((await app.request("/settings/model", { method: "POST" })).status).toBe(404);
        // The routes registered after the fallback still answer.
        expect((await app.request("/api/test_auth")).status).toBe(200);
    });
});

describe("auth routes", () => {
    it("runs the first-run flow: unset -> crypto -> set_password -> login -> JWT", async () => {
        const { app, savePath } = freshServer();
        expect(await (await app.request("/api/test_auth")).json()).toEqual({ status: "unset" });

        const digest = await (await app.request("/api/crypto", json({ data: "hunter2" }))).text();
        expect(digest).toBe("f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7");

        const login = await app.request("/api/login", json({ password: digest, publicKey: {} }));
        expect(login.status).toBe(400);
        expect(await login.json()).toEqual({ error: "Password not set" });

        expect(await (await app.request("/api/set_password", json({ password: digest }))).json()).toEqual({
            status: "success",
        });
        expect(readFileSync(path.join(savePath, "server", "password"), "utf-8")).toBe(digest);
        const again = await app.request("/api/set_password", json({ password: "other" }));
        expect(again.status).toBe(400);
        expect(await again.text()).toBe("already set");

        expect(await (await app.request("/api/test_auth")).json()).toEqual({ status: "incorrect" });

        const signer = await createSigner();
        const unknown = await app.request("/api/test_auth", { headers: { "risu-auth": await signer.jwt() } });
        expect(await unknown.json()).toEqual({ status: "incorrect" });

        const wrong = await app.request("/api/login", json({ password: "nope", publicKey: signer.publicJwk }));
        expect(wrong.status).toBe(400);
        expect(await wrong.json()).toEqual({ error: "Password incorrect" });

        const ok = await app.request("/api/login", json({ password: digest, publicKey: signer.publicJwk }));
        expect(await ok.json()).toEqual({ status: "success" });
        expect(
            JSON.parse(readFileSync(path.join(savePath, "server", "known_public_key_hashes.json"), "utf-8")),
        ).toHaveLength(1);
        const success = await app.request("/api/test_auth", { headers: { "risu-auth": await signer.jwt() } });
        expect(await success.json()).toEqual({ status: "success" });
    });

    it("quarantines malformed known keys on restart and lets a previously registered browser log in again", async () => {
        for (const damaged of ["{bad JSON", "{}", '["a hash", 42]']) {
            const s = freshServer({ password: "pw" });
            const signer = await createSigner();
            const headers = { "risu-auth": await signer.jwt() };
            expect((await s.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }))).ok).toBe(
                true,
            );
            expect(await (await s.app.request("/api/test_auth", { headers })).json()).toEqual({ status: "success" });
            await s.context.dispose();

            const serverDir = path.join(s.savePath, "server");
            const keysPath = path.join(serverDir, "known_public_key_hashes.json");
            writeFileSync(keysPath, damaged);
            const restarted = createServerContext({ rootDir: s.rootDir, savePath: s.savePath });
            try {
                const quarantined = readdirSync(serverDir).filter((name) =>
                    name.startsWith("known_public_key_hashes.json.corrupt-"),
                );
                expect(quarantined, damaged).toHaveLength(1);
                expect(readFileSync(path.join(serverDir, quarantined[0]), "utf-8")).toBe(damaged);
                expect(existsSync(keysPath)).toBe(false);
                expect(await (await restarted.app.request("/api/test_auth", { headers })).json()).toEqual({
                    status: "incorrect",
                });
                const login = await restarted.app.request(
                    "/api/login",
                    json({ password: "pw", publicKey: signer.publicJwk }),
                );
                expect(login.ok).toBe(true);
                expect(await (await restarted.app.request("/api/test_auth", { headers })).json()).toEqual({
                    status: "success",
                });
            } finally {
                await restarted.dispose();
            }
        }
    });

    it("keeps setup closed and refuses password login when the password file is empty or whitespace only", async () => {
        const signer = await createSigner();
        for (const damaged of ["", " \t\n "]) {
            const { app, savePath } = freshServer({ password: damaged });
            const passwordPath = path.join(savePath, "server", "password");
            expect(await (await app.request("/api/test_auth")).json()).not.toEqual(
                expect.objectContaining({ status: "unset" }),
            );

            const setup = await app.request("/api/set_password", json({ password: "replacement" }));
            expect(setup.ok).toBe(false);
            expect(readFileSync(passwordPath, "utf-8")).toBe(damaged);
            const login = await app.request("/api/login", json({ password: damaged, publicKey: signer.publicJwk }));
            expect(login.ok).toBe(false);
            expect(await login.json()).toEqual({ error: expect.any(String) });
            expect(await (await app.request("/api/test_auth")).json()).not.toEqual(
                expect.objectContaining({ status: "unset" }),
            );
        }
    });

    it("seeds a missing password with a lowercase SHA-256 digest and preserves existing password files", async () => {
        const digest = createHash("sha256").update("hunter2").digest("hex");
        const existing = createHash("sha256").update("existing password").digest("hex");
        const signer = await createSigner();
        for (const [initialPassword, passwordSeed] of [
            [undefined, digest],
            [undefined, digest.toUpperCase()],
            [existing, digest.toUpperCase()],
            ["", digest.toUpperCase()],
        ] as const) {
            const s = freshServer({ password: initialPassword });
            await s.context.dispose();
            const seeded = createServerContext({ rootDir: s.rootDir, savePath: s.savePath, passwordSeed });
            try {
                expect(await (await seeded.app.request("/api/crypto", json({ data: "hunter2" }))).text()).toBe(digest);
                const expectedPassword = initialPassword ?? digest;
                expect(readFileSync(path.join(s.savePath, "server", "password"), "utf-8")).toBe(expectedPassword);
                expect(await (await seeded.app.request("/api/test_auth")).json()).not.toEqual(
                    expect.objectContaining({ status: "unset" }),
                );
                const login = await seeded.app.request(
                    "/api/login",
                    json({ password: expectedPassword, publicKey: signer.publicJwk }),
                );
                expect(login.ok).toBe(expectedPassword !== "");
                if (initialPassword !== undefined) {
                    const replacement = await seeded.app.request(
                        "/api/login",
                        json({ password: digest, publicKey: signer.publicJwk }),
                    );
                    expect(replacement.ok).toBe(false);
                }
            } finally {
                await seeded.dispose();
            }
        }
    });

    it("refuses to create a server context when an explicit password seed is not 64 hex characters", async () => {
        const s = freshServer();
        await s.context.dispose();
        for (const passwordSeed of ["hunter2", "g".repeat(64)]) {
            let context: ReturnType<typeof createServerContext> | undefined;
            try {
                expect(() => {
                    context = createServerContext({ rootDir: s.rootDir, savePath: s.savePath, passwordSeed });
                }, passwordSeed).toThrow();
            } finally {
                await context?.dispose();
            }
        }
    });

    it("keeps the exact JWT failure bodies of the former server", async () => {
        const { app } = freshServer({ password: "pw" });
        const signer = await createSigner();
        await app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
        const other = await createSigner();

        const cases: [string, Record<string, string>, number, string][] = [
            ["no header", {}, 400, "No auth header"],
            ["expired", { "risu-auth": await signer.jwt({ exp: 1 }) }, 400, "Token Expired"],
            ["unknown key", { "risu-auth": await other.jwt() }, 400, "Unknown Public Key"],
            ["bad alg", { "risu-auth": await signer.jwt({ alg: "HS256" }) }, 400, "Unsupported Algorithm"],
            ["bad signature", { "risu-auth": await signer.jwt({ breakSignature: true }) }, 400, "Invalid Signature"],
            ["garbage", { "risu-auth": "garbage" }, 500, "Internal Server Error"],
            ["stored password is not a JWT", { "risu-auth": "pw" }, 500, "Internal Server Error"],
        ];
        for (const [name, headers, status, error] of cases) {
            const res = await app.request("/api/list", { headers });
            expect(res.status, name).toBe(status);
            expect(await res.json(), name).toEqual({ error });
        }
        const ok = await app.request("/api/list", { headers: { "risu-auth": await signer.jwt() } });
        expect(ok.status).toBe(200);
    });

    it("rejects malformed, whitespace-only, and primitive JSON with 400 and leaves the password unset", async () => {
        const { app } = freshServer();
        for (const body of ["{bad", "   ", '"str"', "42"]) {
            const res = await app.request("/api/set_password", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
            });
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(await res.json(), JSON.stringify(body)).toEqual({ error: "Invalid JSON body" });
        }
        expect(await (await app.request("/api/test_auth")).json()).toEqual({ status: "unset" });

        // A non-JSON content type or a zero-length body reads as {} (Express body-parser behavior).
        const plain = await app.request("/api/login", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "x",
        });
        expect(plain.status).toBe(400);
        expect(await plain.json()).toEqual({ error: "Password not set" });
        const empty = await app.request("/api/crypto", { method: "POST" });
        expect(empty.status).toBe(500);
        expect(await empty.json()).toEqual({ error: "Crypto operation failed" });
    });

    it("limits /api/login to 10 attempts per window with draft-6 RateLimit headers", async () => {
        const { app } = freshServer({ password: "pw" });
        // The limiter's clock is `Date.now`: held still, then moved to the window's edges.
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            let last: Response | undefined;
            for (let i = 0; i < 10; i++) {
                last = await app.request("/api/login", json({ password: "bad" }));
                expect(last.status).toBe(400);
            }
            expect(last?.headers.get("RateLimit-Limit")).toBe("10");
            expect(last?.headers.get("RateLimit-Remaining")).toBe("0");
            expect(last?.headers.get("RateLimit-Policy")).toBe("10;w=30");

            const blocked = await app.request("/api/login", json({ password: "pw", publicKey: {} }));
            expect(blocked.status).toBe(429);
            expect(await blocked.json()).toEqual({ error: "Too many attempts. Please wait and try again later." });
            expect(blocked.headers.get("Retry-After")).toBe("30");
            expect(blocked.headers.get("RateLimit-Reset")).toBe("30");

            // The window started at the first attempt: blocked until its last millisecond, open after it.
            now += 29_999;
            const late = await app.request("/api/login", json({ password: "bad" }));
            expect(late.status).toBe(429);
            expect(late.headers.get("Retry-After")).toBe("1");
            now += 1;
            const reopened = await app.request("/api/login", json({ password: "bad" }));
            expect(reopened.status).toBe(400);
            expect(reopened.headers.get("RateLimit-Remaining")).toBe("9");
            expect(reopened.headers.get("RateLimit-Reset")).toBe("30");

            // Separate limiter instance for test_auth.
            const auth = await app.request("/api/test_auth");
            expect(auth.headers.get("RateLimit-Policy")).toBe("2000;w=60");
            expect(auth.headers.get("RateLimit-Remaining")).toBe("1999");
        } finally {
            clock.mockRestore();
        }
    });

    it("limits password setup to 10 attempts per IP per 30 seconds in the same bucket as login", async () => {
        const { app } = freshServer({ password: "pw" });
        const client = { incoming: { socket: { remoteAddress: "192.0.2.1" }, headers: {} } };
        const otherClient = { incoming: { socket: { remoteAddress: "192.0.2.2" }, headers: {} } };
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            for (let i = 0; i < 10; i++) {
                const setup = await app.request("/api/set_password", json({ password: "other" }), client);
                expect(setup.status).not.toBe(429);
                expect(await setup.text()).toBe("already set");
            }
            expect((await app.request("/api/set_password", json({ password: "other" }), client)).status).toBe(429);
            expect((await app.request("/api/login", json({ password: "bad" }), client)).status).toBe(429);
            expect((await app.request("/api/set_password", json({ password: "other" }), otherClient)).status).not.toBe(
                429,
            );
            now += 29_999;
            expect((await app.request("/api/set_password", json({ password: "other" }), client)).status).toBe(429);
            now += 1;
            expect(await (await app.request("/api/set_password", json({ password: "other" }), client)).text()).toBe(
                "already set",
            );
        } finally {
            clock.mockRestore();
        }
    });

    it("limits crypto requests with the shared per-minute auth bucket", async () => {
        const limit = 3;
        const s = createTestServer({ routeLimits: { requestsPerMinute: limit } });
        servers.push(s);
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            for (let i = 0; i < limit; i++) {
                expect((await s.app.request("/api/crypto", json({ data: "password" }))).ok).toBe(true);
            }
            expect((await s.app.request("/api/crypto", json({ data: "password" }))).status).toBe(429);
            expect((await s.app.request("/api/test_auth")).status).toBe(429);
            now += 60_000;
            expect((await s.app.request("/api/crypto", json({ data: "password" }))).ok).toBe(true);
        } finally {
            clock.mockRestore();
        }
    });
});

describe("storage rate limiter", () => {
    async function authedServer() {
        const s = await createResourceTestClient();
        servers.push(s);
        return s;
    }

    function expectQuota(res: Response, remaining: number, label?: string) {
        expect(res.headers.get("RateLimit-Limit"), label).toBe("2000");
        expect(res.headers.get("RateLimit-Policy"), label).toBe("2000;w=60");
        expect(res.headers.get("RateLimit-Remaining"), label).toBe(String(remaining));
    }

    it("shares one bucket across all six storage routes, separate from the shared authenticated bucket", async () => {
        const s = await authedServer();
        const key = "assets/limiter.bin";
        const storageRequests: [string, () => Promise<Response>][] = [
            [
                "/api/write",
                () => s.request("/api/write", { method: "POST", headers: { "file-path": hex(key) }, body: "asset" }),
            ],
            ["/api/read", () => s.request("/api/read", { headers: { "file-path": hex(key) } })],
            ["/api/list", () => s.request("/api/list")],
            [
                "/api/assets/write",
                () =>
                    s.request("/api/assets/write", {
                        method: "POST",
                        headers: { "content-type": "application/octet-stream" },
                        body: buildArchive([["assets/batch.bin", "batch"]]) as RequestInit["body"],
                    }),
            ],
            ["/api/assets/read", () => s.json("/api/assets/read", { keys: [key, "assets/batch.bin"] })],
            ["/api/remove", () => s.request("/api/remove", { headers: { "file-path": hex(key) } })],
        ];
        const authenticatedRequests: [string, number, () => Promise<Response>][] = [
            ["/api/resources", 200, () => s.request("/api/resources?kinds=ui")],
            ["/api/resources/read", 200, () => s.json("/api/resources/read", { refs: [{ kind: "ui", id: "main" }] })],
            ["/api/resources/revisions", 200, () => s.request("/api/resources/revisions")],
            // Invalid bodies exercise the limiter without starting a generation or transform.
            ["/api/generations", 400, () => s.json("/api/generations", {})],
            ["/api/transform", 400, () => s.json("/api/transform", {})],
            ["/api/resources/ui", 200, () => s.request("/api/resources/ui")],
        ];

        for (let i = 0; i < storageRequests.length; i++) {
            const [storagePath, storageRequest] = storageRequests[i];
            const storage = await storageRequest();
            expect(storage.status, storagePath).toBe(200);
            expectQuota(storage, 1999 - i, storagePath);
            await storage.arrayBuffer();

            const [authenticatedPath, status, authenticatedRequest] = authenticatedRequests[i];
            const authenticated = await authenticatedRequest();
            expect(authenticated.status, authenticatedPath).toBe(status);
            // createResourceTestClient has already made one authenticated request to read the epoch.
            expectQuota(authenticated, 1998 - i, authenticatedPath);
            await authenticated.arrayBuffer();
        }
    });

    it("allows the storage bucket's requests then returns draft-6 headers and Retry-After without blocking resource sync", async () => {
        // A five-request bucket; the production 2000;w=60 policy is checked by the test above.
        const limit = 5;
        const s = await createResourceTestClient({ routeLimits: { requestsPerMinute: limit } });
        servers.push(s);
        const quota = (res: Response, remaining: number, label?: string) => {
            expect(res.headers.get("RateLimit-Limit"), label).toBe(String(limit));
            expect(res.headers.get("RateLimit-Policy"), label).toBe(`${limit};w=60`);
            expect(res.headers.get("RateLimit-Remaining"), label).toBe(String(remaining));
        };
        const headers = await s.headers({ "file-path": hex("assets/missing.bin") });
        // Freeze only the clock, so the 60-second header assertions do not depend on runner speed.
        const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
        try {
            for (let i = 0; i < limit; i++) {
                const read = await s.app.request("/api/read", { headers });
                expect(read.status, `storage request ${i + 1}`).toBe(200);
                quota(read, limit - 1 - i, `storage request ${i + 1}`);
                expect(read.headers.get("RateLimit-Reset")).toBe("60");
                await read.arrayBuffer();
            }

            const blocked = await s.request("/api/list");
            expect(blocked.status).toBe(429);
            quota(blocked, 0);
            expect(blocked.headers.get("RateLimit-Reset")).toBe("60");
            expect(blocked.headers.get("Retry-After")).toBe("60");
            expect(await blocked.json()).toEqual({ error: "Too many requests. Please retry shortly." });

            // The authenticated bucket is separate: one request read the epoch, this is the second.
            const resources = await s.request("/api/resources?kinds=ui");
            expect(resources.status).toBe(200);
            quota(resources, limit - 2);
        } finally {
            now.mockRestore();
        }
    });
});

describe("storage key codec", () => {
    // One canonical file name per logical name: readable lowercase ASCII, everything else `%XX`,
    // escaped trailing dot and Windows device stem, `~<hex>` fallback above 255 bytes.
    const table: [string, string][] = [
        ["database.bin", "database.bin"],
        ["dbbackup-17905.bin", "dbbackup-17905.bin"],
        ["x.png", "x.png"],
        ["x.PNG", "x.%50%4E%47"],
        ["a/b", "a%2Fb"],
        ["a\\b", "a%5Cb"],
        ["%2F", "%252%46"], // uppercase F is escaped like any other uppercase byte
        ["my file", "my%20file"],
        ["한글 이름.webp", "%ED%95%9C%EA%B8%80%20%EC%9D%B4%EB%A6%84.webp"],
        ["\u0000", "%00"],
        ["~lit", "%7Elit"],
        ["end.", "end%2E"],
        [".", "%2E"],
        ["..", ".%2E"],
        ["con.png", "%63on.png"],
        ["CON.png", "%43%4F%4E.png"],
        ["console.png", "console.png"],
        ["nul", "%6Eul"],
        ["com1.txt", "%63om1.txt"],
        ["lpt9.local.bin", "%6Cpt9.local.bin"],
        ["con.", "con%2E"],
        ["a".repeat(255), "a".repeat(255)],
    ];

    it("encodes to the documented canonical file names and decodes them back", () => {
        for (const [name, encoded] of table) {
            expect(encodeFileName(name), JSON.stringify(name)).toBe(encoded);
            expect(decodeFileName(encoded), encoded).toBe(name);
        }
    });

    it("is injective even on a case-insensitive filesystem", () => {
        const names = [...table.map(([name]) => name), "x.Png", "X.png", "Con.png", "a%2Fb", "%252F", "end%2E"];
        const encoded = names.map((name) => encodeFileName(name));
        expect(new Set(encoded).size).toBe(names.length);
        expect(new Set(encoded.map((e) => e?.toLowerCase())).size).toBe(names.length);
    });

    it("falls back to ~<hex> when the readable form exceeds 255 bytes and rejects names that fit neither", () => {
        const korean = "가".repeat(29) + ".png"; // 265 readable bytes, 183 as ~hex
        const fallback = encodeFileName(korean);
        expect(fallback).toBe("~" + Buffer.from(korean, "utf-8").toString("hex"));
        expect(fallback?.length).toBeLessThanOrEqual(255);
        expect(decodeFileName(fallback as string)).toBe(korean);

        expect(encodeFileName("a".repeat(256))).toBeNull();
        expect(encodeFileName("가".repeat(60))).toBeNull();
        expect(encodeFileName("")).toBeNull();
    });

    it("rejects every file name that encodeFileName would not produce", () => {
        const korean = "가".repeat(29) + ".png";
        for (const fileName of [
            "",
            "A",
            "x.PNG",
            "con.png",
            "end.",
            "%61", // readable byte written as an escape
            "%2e", // lowercase hex escape
            "%2f",
            "%",
            "%zz",
            "%C3%28", // invalid UTF-8
            "~",
            "~" + Buffer.from("a", "utf-8").toString("hex"), // fits the readable form
            "~" + Buffer.from(korean, "utf-8").toString("hex").toUpperCase(),
            "~zz",
        ]) {
            expect(decodeFileName(fileName), JSON.stringify(fileName)).toBeNull();
        }
    });

    it("decodes the file-path header as hex UTF-8 only when it round-trips byte for byte", () => {
        expect(decodeKeyHeader(hex("assets/한글.png"))).toBe("assets/한글.png");
        expect(decodeKeyHeader(hex("assets/a.png").toUpperCase())).toBe("assets/a.png");
        expect(decodeKeyHeader("efbfbd")).toBe("�"); // an explicit U+FFFD is valid UTF-8
        for (const header of ["", "a", "abc", "zz", "../x", "__password", " 61", "61 ", "ff", "c0af", "eda080"]) {
            expect(decodeKeyHeader(header), JSON.stringify(header)).toBeNull();
        }
    });

    it("resolves only <namespace>/<name> keys to a file directly inside the namespace folder", () => {
        const save = path.resolve("/tmp/save");
        expect(resolveStorageKey(save, "assets/database.bin")).toBe(path.join(save, "assets", "database.bin"));
        expect(resolveStorageKey(save, "assets/../server/password")).toBe(
            path.join(save, "assets", "..%2Fserver%2Fpassword"),
        );
        expect(resolveStorageKey(save, "assets/x.a/b")).toBe(path.join(save, "assets", "x.a%2Fb"));
        for (const key of [
            "database.bin",
            // The database and remote-character namespaces of older versions are gone.
            "database/database.bin",
            "remotes/cha-1.local.bin",
            "/assets/x.png",
            "assets/",
            "server/password",
            "server/known_public_key_hashes.json",
            "server/web_push_vapid.json",
            "server/push_subscriptions.json",
            ".tmp/x",
            "Assets/x.png",
            "legacy/avatar.png",
            "../assets/x.png",
            "assets/" + "가".repeat(60),
        ]) {
            expect(resolveStorageKey(save, key), key).toBeNull();
        }
    });
});

describe("storage routes", () => {
    type Server = Awaited<ReturnType<typeof authedServer>>;
    async function authedServer() {
        const s = freshServer({ password: "pw" });
        const signer = await createSigner();
        await s.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
        const headers = async (extra: Record<string, string> = {}) => ({ "risu-auth": await signer.jwt(), ...extra });
        return { ...s, signer, headers };
    }
    /** `key` is a logical key unless `raw` is set, in which case it is sent as the header verbatim. */
    const filePath = (key: string, raw?: boolean) => (raw ? key : hex(key));
    const write = async (s: Server, key: string, body: string | Uint8Array, raw?: boolean) =>
        s.app.request("/api/write", {
            method: "POST",
            headers: await s.headers({ "content-type": "application/octet-stream", "file-path": filePath(key, raw) }),
            body,
        });
    const read = async (s: Server, key: string, raw?: boolean, method = "GET") =>
        s.app.request("/api/read", { method, headers: await s.headers({ "file-path": filePath(key, raw) }) });
    const remove = async (s: Server, header: string) =>
        s.app.request("/api/remove", { headers: await s.headers({ "file-path": header }) });
    const list = async (s: Server) =>
        ((await (await s.app.request("/api/list", { headers: await s.headers() })).json()) as { content: string[] })
            .content;
    const invalidPath = async (res: Response, label: string) => {
        expect(res.status, label).toBe(400);
        expect(await res.json(), label).toEqual({ error: "Invaild Path" });
    };

    it("stores each key at save/<namespace>/<encoded name>, reads it back by GET and HEAD, and lists the written keys", async () => {
        const s = await authedServer();
        const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
        expect(await (await write(s, "assets/blob.bin", bytes)).json()).toEqual({ success: true });
        expect(new Uint8Array(readFileSync(path.join(s.savePath, "assets", "blob.bin")))).toEqual(bytes);

        const get = await read(s, "assets/blob.bin");
        expect(get.status).toBe(200);
        expect(get.headers.get("content-type")).toBe("application/octet-stream");
        expect(get.headers.get("content-length")).toBe("7");
        expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

        const head = await read(s, "assets/blob.bin", false, "HEAD");
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe("7");
        expect((await head.arrayBuffer()).byteLength).toBe(0);

        // The uppercase spelling of the same hex addresses the same file.
        const upper = await read(s, hex("assets/blob.bin").toUpperCase(), true);
        expect(new Uint8Array(await upper.arrayBuffer())).toEqual(bytes);

        const missing = await read(s, "assets/missing.png");
        expect(missing.status).toBe(200);
        expect((await missing.arrayBuffer()).byteLength).toBe(0);

        // Zero-length writes are valid (`assetClient.ts`'s `writeAsset` may send an empty Uint8Array).
        expect(await (await write(s, "assets/empty", new Uint8Array(0))).json()).toEqual({ success: true });
        const readEmpty = await read(s, "assets/empty");
        expect(readEmpty.headers.get("content-type")).toBe("application/octet-stream");
        expect((await readEmpty.arrayBuffer()).byteLength).toBe(0);

        // Names that need escaping land under the canonical file name and read back unchanged.
        const escaped: [string, string][] = [
            ["assets/x.PNG", "assets/x.%50%4E%47"],
            ["assets/x.png", "assets/x.png"],
            ["assets/한글 이름.webp", "assets/%ED%95%9C%EA%B8%80%20%EC%9D%B4%EB%A6%84.webp"],
            ["assets/x.a/b", "assets/x.a%2Fb"],
            ["assets/con.png", "assets/%63on.png"],
            ["assets/%2F", "assets/%252%46"],
            ["assets/..", "assets/.%2E"],
            ["assets/cha-1.local.bin", "assets/cha-1.local.bin"],
            ["assets/" + "가".repeat(29) + ".png", "assets/~" + Buffer.from("가".repeat(29) + ".png").toString("hex")],
        ];
        for (const [key, relative] of escaped) {
            expect(await (await write(s, key, `v:${key}`)).json(), key).toEqual({ success: true });
            expect(readFileSync(path.join(s.savePath, relative), "utf-8"), key).toBe(`v:${key}`);
            expect(await (await read(s, key)).text(), key).toBe(`v:${key}`);
        }

        const keys = ["assets/blob.bin", "assets/empty", ...escaped.map(([key]) => key)];
        expect((await list(s)).sort()).toEqual([...keys].sort());
        // Nothing lands flat in save/: only the server folder, the staging folder, the resource database,
        // snapshot, and diagnostics folders, and the one namespace.
        expect(readdirSync(s.savePath).sort()).toEqual([".tmp", "assets", "backups", "data", "diagnostics", "server"]);
        expect(readdirSync(path.join(s.savePath, ".tmp"))).toEqual([]);
    });

    it("reads well-formed keys with no storage location as missing without touching disk, and rejects writing or removing them", async () => {
        const s = await authedServer();
        const unsupported = [
            "missing",
            "database.bin",
            "database/database.bin",
            "remotes/cha-1.local.bin",
            "server/password",
            "server/known_public_key_hashes.json",
            "server/web_push_vapid.json",
            "server/push_subscriptions.json",
            ".tmp/x",
            "../server/password",
            "legacy/avatar.png",
            "Assets/x.png",
            "assets/",
            "assets/" + "가".repeat(60),
        ];
        const open = vi.spyOn(fsPromises, "open");
        for (const key of unsupported) {
            const res = await read(s, key);
            expect(res.status, key).toBe(200);
            expect(await res.text(), key).toBe("");
        }
        expect(open).not.toHaveBeenCalled();
        open.mockRestore();

        for (const key of unsupported) {
            await invalidPath(await write(s, key, "pwn"), `write ${key}`);
            await invalidPath(await remove(s, hex(key)), `remove ${key}`);
        }
        expect(readFileSync(path.join(s.savePath, "server", "password"), "utf-8")).toBe("pw");
        expect(readdirSync(s.savePath).sort()).toEqual([".tmp", "backups", "data", "diagnostics", "server"]);
        // `web_push_vapid.json` is the server's Web Push key pair, generated at start.
        expect(readdirSync(path.join(s.savePath, "server")).sort()).toEqual([
            "known_public_key_hashes.json",
            "password",
            "web_push_vapid.json",
        ]);
    });

    it("rejects malformed file-path headers on every route and requires the header", async () => {
        const s = await authedServer();
        // (Leading and trailing whitespace never reaches the server: the Headers API trims header values.)
        const malformed = ["../x", "__password", "abc", "zz", "61 62", "6173736574732fff", "6173736574732fc0af"];
        for (const header of malformed) {
            await invalidPath(await read(s, header, true), `read ${header}`);
            await invalidPath(await remove(s, header), `remove ${header}`);
            await invalidPath(await write(s, header, "x", true), `write ${header}`);
        }
        for (const route of ["/api/read", "/api/remove"]) {
            const noHeader = await s.app.request(route, { headers: await s.headers() });
            expect(noHeader.status, route).toBe(400);
            expect(await noHeader.json(), route).toEqual({ error: "File path required" });
        }
        const noHeader = await s.app.request("/api/write", { method: "POST", headers: await s.headers(), body: "x" });
        expect(noHeader.status).toBe(400);
        expect(await noHeader.json()).toEqual({ error: "File path required" });
        expect(readdirSync(s.savePath).sort()).toEqual([".tmp", "backups", "data", "diagnostics", "server"]);
    });

    it("lists only canonical regular files and reads other entries as missing", async () => {
        const s = await authedServer();
        await write(s, "assets/real.png", "real");
        const assets = path.join(s.savePath, "assets");
        for (const name of ["Upper.png", "%78.png", "%2e", "~" + hex("short")]) {
            writeFileSync(path.join(assets, name), "noncanonical");
        }
        mkdirSync(path.join(assets, "sub"));
        writeFileSync(path.join(assets, "sub", "inner.png"), "nested");
        writeFileSync(path.join(s.savePath, "deadbeef"), "flat legacy file");
        writeFileSync(path.join(s.savePath, "server", "extra"), "server-owned");
        const posix = process.platform !== "win32";
        if (posix) {
            symlinkSync(path.join(s.savePath, "server", "password"), path.join(assets, "link.png"));
            execFileSync("mkfifo", [path.join(assets, "fifo")]);
        }

        expect(await list(s)).toEqual(["assets/real.png"]);

        const dir = await read(s, "assets/sub");
        expect(dir.status).toBe(200);
        expect(await dir.text()).toBe("");
        if (posix) {
            const link = await read(s, "assets/link.png");
            expect(link.status).toBe(200);
            expect(await link.text()).toBe("");
            // A FIFO without a writer must not block the request.
            const fifo = await read(s, "assets/fifo");
            expect(fifo.status).toBe(200);
            expect(await fifo.text()).toBe("");
        }
    });

    it("validates every $$-separated batch segment before deleting, deduplicates by resolved file, and stops at a missing file", async () => {
        const s = await authedServer();
        for (const key of ["assets/a", "assets/b", "assets/c"]) {
            await write(s, key, key);
        }
        const exists = (name: string) => existsSync(path.join(s.savePath, "assets", name));

        await invalidPath(await remove(s, `${hex("assets/a")}$$zz`), "malformed segment");
        await invalidPath(await remove(s, `${hex("assets/a")}$$${hex("server/password")}`), "unsupported segment");
        const emptySegment = await remove(s, `${hex("assets/a")}$$`);
        expect(emptySegment.status).toBe(400);
        expect(await emptySegment.json()).toEqual({ error: "File path required" });
        expect([exists("a"), exists("b"), exists("c")]).toEqual([true, true, true]);
        expect(readFileSync(path.join(s.savePath, "server", "password"), "utf-8")).toBe("pw");

        // Both hex spellings of `assets/a` resolve to one file, so the batch deletes it once.
        const ok = await remove(s, `${hex("assets/a")}$$${hex("assets/a").toUpperCase()}$$${hex("assets/b")}`);
        expect(await ok.json()).toEqual({ success: true });
        expect([exists("a"), exists("b"), exists("c")]).toEqual([false, false, true]);

        // A missing file is a 500; files deleted before it stay deleted.
        const partial = await remove(s, `${hex("assets/c")}$$${hex("assets/a")}`);
        expect(partial.status).toBe(500);
        expect(exists("c")).toBe(false);
        expect((await remove(s, hex("assets/a"))).status).toBe(500);
    });

    it("replaces a file atomically: an open reader keeps the old bytes and a failed rename keeps the old file", async () => {
        const s = await authedServer();
        await write(s, "assets/v.bin", "old");
        const reader = await read(s, "assets/v.bin"); // handle opened, body not consumed yet
        await write(s, "assets/v.bin", "new-longer");
        expect(reader.headers.get("content-length")).toBe("3");
        expect(await reader.text()).toBe("old");
        expect(await (await read(s, "assets/v.bin")).text()).toBe("new-longer");

        const rename = vi
            .spyOn(fsPromises, "rename")
            .mockRejectedValueOnce(Object.assign(new Error("EPERM: locked"), { code: "EPERM" }));
        const failed = await write(s, "assets/v.bin", "lost");
        expect(failed.status).toBe(500);
        rename.mockRestore();
        expect(readFileSync(path.join(s.savePath, "assets", "v.bin"), "utf-8")).toBe("new-longer");
        expect(readdirSync(path.join(s.savePath, ".tmp"))).toEqual([]);
    });

    it("empties save/.tmp at startup and keeps the password, registered keys, and data across a restart", async () => {
        const s = await authedServer();
        await write(s, "assets/kept.bin", "db");
        await s.context.dispose();
        writeFileSync(path.join(s.savePath, ".tmp", "stale.tmp"), "half-written");

        const restarted = createServerContext({ rootDir: s.rootDir });
        try {
            expect(readdirSync(path.join(s.savePath, ".tmp"))).toEqual([]);
            const auth = await restarted.app.request("/api/test_auth", {
                headers: { "risu-auth": await s.signer.jwt() },
            });
            expect(await auth.json()).toEqual({ status: "success" });
            const db = await restarted.app.request("/api/read", {
                headers: { "risu-auth": await s.signer.jwt(), "file-path": hex("assets/kept.bin") },
            });
            expect(await db.text()).toBe("db");
        } finally {
            await restarted.dispose();
        }
    });
});
