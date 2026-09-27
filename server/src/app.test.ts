// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSigner, createTestServer, hex, json } from "./testSupport.ts";

let server: ReturnType<typeof createTestServer>;
const servers: ReturnType<typeof createTestServer>[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(() => {
    for (const s of servers.splice(0)) {
        s.close();
    }
});
function freshServer(options?: { password?: string }) {
    server = createTestServer(options);
    servers.push(server);
    return server;
}

describe("GET /", () => {
    it("injects the __NODE__ flag as the first child of <head> and leaves /index.html raw", async () => {
        const { app } = freshServer();
        const res = await app.request("/");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/html/);
        const html = await res.text();
        expect(html).toContain('<head><script>globalThis.__NODE__ = true</script><meta charset="utf-8">');

        const raw = await app.request("/index.html");
        expect(raw.status).toBe(200);
        expect(await raw.text()).not.toContain("__NODE__");

        expect((await app.request("/does-not-exist")).status).toBe(404);
        expect((await app.request("/index.html", { method: "POST" })).status).toBe(404);
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
        expect(readFileSync(path.join(savePath, "__password"), "utf-8")).toBe(digest);
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
        expect(JSON.parse(readFileSync(path.join(savePath, "__known_public_key_hashes.json"), "utf-8"))).toHaveLength(
            1,
        );
        const success = await app.request("/api/test_auth", { headers: { "risu-auth": await signer.jwt() } });
        expect(await success.json()).toEqual({ status: "success" });
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
        expect(blocked.headers.get("Retry-After")).toMatch(/^(29|30)$/);
        expect(blocked.headers.get("RateLimit-Reset")).toBe(blocked.headers.get("Retry-After"));

        // Separate limiter instance for test_auth.
        const auth = await app.request("/api/test_auth");
        expect(auth.headers.get("RateLimit-Policy")).toBe("2000;w=60");
        expect(auth.headers.get("RateLimit-Remaining")).toBe("1999");
    });
});

describe("storage routes", () => {
    async function authedServer() {
        const s = freshServer({ password: "pw" });
        const signer = await createSigner();
        await s.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
        const headers = async (extra: Record<string, string> = {}) => ({ "risu-auth": await signer.jwt(), ...extra });
        return { ...s, signer, headers };
    }

    it("round-trips bytes by hex-encoded key, reads a missing key as an empty 200, and lists decoded keys", async () => {
        const s = await authedServer();
        const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
        const write = await s.app.request("/api/write", {
            method: "POST",
            headers: await s.headers({
                "content-type": "application/octet-stream",
                "file-path": hex("database/database.bin"),
            }),
            body: bytes,
        });
        expect(await write.json()).toEqual({ success: true });
        expect(existsSync(path.join(s.savePath, hex("database/database.bin")))).toBe(true);

        const read = await s.app.request("/api/read", {
            headers: await s.headers({ "file-path": hex("database/database.bin") }),
        });
        expect(read.status).toBe(200);
        expect(read.headers.get("content-type")).toBe("application/octet-stream");
        expect(read.headers.get("content-length")).toBe("7");
        expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

        const head = await s.app.request("/api/read", {
            method: "HEAD",
            headers: await s.headers({ "file-path": hex("database/database.bin") }),
        });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe("7");
        expect((await head.arrayBuffer()).byteLength).toBe(0);

        const missing = await s.app.request("/api/read", { headers: await s.headers({ "file-path": hex("missing") }) });
        expect(missing.status).toBe(200);
        expect((await missing.arrayBuffer()).byteLength).toBe(0);

        // Zero-length writes are valid (NodeStorage.setItem may send an empty Uint8Array).
        const empty = await s.app.request("/api/write", {
            method: "POST",
            headers: await s.headers({ "content-type": "application/octet-stream", "file-path": hex("empty") }),
            body: new Uint8Array(0),
        });
        expect(await empty.json()).toEqual({ success: true });
        const readEmpty = await s.app.request("/api/read", { headers: await s.headers({ "file-path": hex("empty") }) });
        expect(readEmpty.headers.get("content-type")).toBe("application/octet-stream");
        expect((await readEmpty.arrayBuffer()).byteLength).toBe(0);

        const list = (await (await s.app.request("/api/list", { headers: await s.headers() })).json()) as {
            success: boolean;
            content: string[];
        };
        expect(list.success).toBe(true);
        expect(list.content).toEqual(expect.arrayContaining(["database/database.bin", "empty"]));
    });

    it("only accepts hex file names (plus __password) and requires the header", async () => {
        const s = await authedServer();
        for (const route of ["/api/read", "/api/remove"]) {
            const noHeader = await s.app.request(route, { headers: await s.headers() });
            expect(noHeader.status, route).toBe(400);
            expect(await noHeader.json(), route).toEqual({ error: "File path required" });
            const traversal = await s.app.request(route, { headers: await s.headers({ "file-path": "../x" }) });
            expect(traversal.status, route).toBe(400);
            expect(await traversal.json(), route).toEqual({ error: "Invaild Path" });
        }
        const write = await s.app.request("/api/write", {
            method: "POST",
            headers: await s.headers({ "content-type": "application/octet-stream", "file-path": "zz" }),
            body: "x",
        });
        expect(write.status).toBe(400);
        expect(await write.json()).toEqual({ error: "Invaild Path" });
        expect(existsSync(path.join(s.savePath, "zz"))).toBe(false);

        const password = await s.app.request("/api/read", { headers: await s.headers({ "file-path": "__password" }) });
        expect(password.status).toBe(200);
        expect(await password.text()).toBe("pw");
    });

    it("validates every $$-separated batch segment before deleting anything", async () => {
        const s = await authedServer();
        for (const key of ["a", "b"]) {
            await s.app.request("/api/write", {
                method: "POST",
                headers: await s.headers({ "content-type": "application/octet-stream", "file-path": hex(key) }),
                body: key,
            });
        }
        const bad = await s.app.request("/api/remove", {
            headers: await s.headers({ "file-path": `${hex("a")}$$zz` }),
        });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({ error: "Invaild Path" });
        const emptySegment = await s.app.request("/api/remove", {
            headers: await s.headers({ "file-path": `${hex("a")}$$` }),
        });
        expect(emptySegment.status).toBe(400);
        expect(await emptySegment.json()).toEqual({ error: "File path required" });
        expect(existsSync(path.join(s.savePath, hex("a")))).toBe(true);
        expect(existsSync(path.join(s.savePath, hex("b")))).toBe(true);

        const ok = await s.app.request("/api/remove", {
            headers: await s.headers({ "file-path": `${hex("a")}$$${hex("b")}$$${hex("a")}` }),
        });
        expect(await ok.json()).toEqual({ success: true });
        expect(existsSync(path.join(s.savePath, hex("a")))).toBe(false);
        expect(existsSync(path.join(s.savePath, hex("b")))).toBe(false);

        const missing = await s.app.request("/api/remove", { headers: await s.headers({ "file-path": hex("a") }) });
        expect(missing.status).toBe(500);
    });
});
