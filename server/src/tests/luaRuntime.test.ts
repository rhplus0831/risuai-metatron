// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createRequestLimiter,
    EgressAbortError,
    type EgressDeps,
    isBlockedAddress,
    MAX_REQUESTS_PER_WINDOW,
    REQUEST_WINDOW_MS,
    serverLuaRequest,
    validateEgressUrl,
} from "../lua/egress.ts";

/**
 * The Lua runtime's egress guard (policy in process, the pinned TLS transport against a local
 * server in a plain Node child that trusts a minted certificate) and the engine lifecycle inside a
 * worker (a plain Node child, as `worker.ts` runs it). Ported from the previous attempt's
 * `luaRuntime.test.ts` where the cases still apply.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PUBLIC = "93.184.216.34";
const publicLookup: EgressDeps["lookup"] = async () => [{ address: PUBLIC, family: 4 }];
const status = async (raw: string) => (JSON.parse(raw) as { status: number; data: string }).status;

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** Runs a script with plain `node` (no flags, no `NODE_OPTIONS`) and returns its exit and output. */
async function runNode(
    args: string[],
    extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const env = { ...process.env, ...extraEnv };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { code, stdout, stderr };
}

describe("the address classifier", () => {
    it("blocks private, loopback, link-local, CGNAT, multicast, reserved, and unparseable addresses", () => {
        for (const blocked of [
            "127.0.0.1",
            "0.0.0.0",
            "10.0.0.5",
            "172.16.9.9",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "169.254.0.1",
            "100.64.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "192.0.2.1",
            "::1",
            "::",
            "fe80::1",
            "fe80::1%eth0",
            "fd00::1",
            "fc00::1",
            "ff02::1",
            "ff00::1",
            "fec0::1",
            "100::1",
            "2001:db8::1",
            "3fff::1",
            "2001::1",
            "2001:2::1",
            "5f00::1",
            "::ffff:127.0.0.1",
            "not-an-ip",
            " ",
        ]) {
            expect(isBlockedAddress(blocked), blocked).toBe(true);
        }
        for (const allowed of ["8.8.8.8", PUBLIC, "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
            expect(isBlockedAddress(allowed), allowed).toBe(false);
        }
    });

    it("judges the IPv4 embedded in mapped, compatible, 6to4, and NAT64 forms, and blocks local-use NAT64", () => {
        for (const blocked of [
            "::ffff:7f00:1",
            "::ffff:a9fe:a9fe",
            "::7f00:1",
            "::127.0.0.1",
            "::a00:1",
            "2002:7f00:1::",
            "2002:a9fe:a9fe::",
            "2002:c0a8:101::",
            "64:ff9b::7f00:1",
            "64:ff9b::127.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::7f00:1",
            "64:ff9b:1::808:808",
        ]) {
            expect(isBlockedAddress(blocked), blocked).toBe(true);
        }
        for (const allowed of ["::ffff:808:808", "::ffff:8.8.8.8", "2002:808:808::", "64:ff9b::808:808"]) {
            expect(isBlockedAddress(allowed), allowed).toBe(false);
        }
    });

    it("rejects a non-string", () => {
        expect(isBlockedAddress(undefined as unknown as string)).toBe(true);
    });
});

describe("validateEgressUrl", () => {
    const expectStatus = async (url: string, expected: number, deps: EgressDeps = {}) => {
        const verdict = await validateEgressUrl(url, deps);
        expect(verdict.ok, url).toBe(false);
        if (!verdict.ok) {
            expect(verdict.status, url).toBe(expected);
        }
    };

    it("rejects non-https, over-long, invalid, and banned URLs before any lookup", async () => {
        let lookups = 0;
        const deps: EgressDeps = { lookup: async () => (lookups++, [{ address: PUBLIC, family: 4 }]) };
        await expectStatus("http://example.com/", 400, deps);
        await expectStatus("https://example.com/" + "a".repeat(101), 413, deps);
        await expectStatus("https://", 400, deps);
        await expectStatus("https://risuai.net/x", 400, deps);
        await expectStatus("https://realm.risuai.net/", 400, deps);
        await expectStatus("https://risuai.xyz/", 400, deps);
        await expectStatus("https://RISUAI.NET/x", 400, deps);
        await expectStatus("https://user@risuai.net/", 400, deps);
        await expectStatus("https://localhost/secret", 403, deps);
        await expectStatus("https://LOCALHOST/", 403, deps);
        await expectStatus("https://app.localhost/", 403, deps);
        await expectStatus("https://10.0.0.1/", 403, deps);
        await expectStatus("https://[::1]/", 403, deps);
        await expectStatus("https://[fe80::1]/", 403, deps);
        expect(lookups).toBe(0);
        const literal = await validateEgressUrl("https://8.8.8.8/x", deps);
        expect(literal).toEqual({ ok: true, addresses: ["8.8.8.8"] });
        expect(lookups).toBe(0);
    });

    it("judges every resolved address", async () => {
        for (const ip of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "::ffff:127.0.0.1", "64:ff9b::7f00:1"]) {
            await expectStatus("https://evil.test/x", 403, { lookup: async () => [{ address: ip, family: 4 }] });
        }
        await expectStatus("https://rebind.test/x", 403, {
            lookup: async () => [
                { address: PUBLIC, family: 4 },
                { address: "127.0.0.1", family: 4 },
            ],
        });
        await expectStatus("https://nowhere.test/x", 400, {
            lookup: async () => {
                throw new Error("ENOTFOUND");
            },
        });
        await expectStatus("https://empty.test/x", 400, { lookup: async () => [] });
        expect(await validateEgressUrl("https://example.test/x", { lookup: publicLookup })).toEqual({
            ok: true,
            addresses: [PUBLIC],
        });
    });

    it("races a stalled lookup against the abort and rejects with the abort", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        await expect(
            validateEgressUrl("https://stalled.test/", { lookup: () => new Promise(() => {}) }, controller.signal),
        ).rejects.toBeInstanceOf(EgressAbortError);
        await expect(
            validateEgressUrl("https://stalled.test/", { lookup: () => new Promise(() => {}) }, AbortSignal.abort()),
        ).rejects.toBeInstanceOf(EgressAbortError);
    });
});

describe("serverLuaRequest", () => {
    const fetched: EgressDeps = { lookup: publicLookup, fetchImpl: async () => ({ status: 200, data: "ok" }) };

    it("allows 30 validated requests per window, answers 429 to the 31st, and rolls the window", async () => {
        let now = 1_000_000;
        const deps: EgressDeps = { ...fetched, now: () => now };
        const limiter = createRequestLimiter();
        const statuses: number[] = [];
        for (let i = 0; i < MAX_REQUESTS_PER_WINDOW + 1; i++) {
            statuses.push(await status(await serverLuaRequest("https://example.test/x", { limiter, deps })));
        }
        expect(statuses.slice(0, MAX_REQUESTS_PER_WINDOW)).toEqual(Array(MAX_REQUESTS_PER_WINDOW).fill(200));
        expect(statuses[MAX_REQUESTS_PER_WINDOW]).toBe(429);
        now += REQUEST_WINDOW_MS + 1;
        expect(await status(await serverLuaRequest("https://example.test/x", { limiter, deps }))).toBe(200);
    });

    it("counts only validated requests, and checks the window before validating", async () => {
        const limiter = createRequestLimiter();
        for (let i = 0; i < 40; i++) {
            expect(await status(await serverLuaRequest("http://blocked.test/x", { limiter, deps: fetched }))).toBe(400);
        }
        for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
            expect(await status(await serverLuaRequest("https://example.test/x", { limiter, deps: fetched }))).toBe(
                200,
            );
        }
        // The exhausted window answers first, even for a URL that would fail validation.
        expect(await status(await serverLuaRequest("http://blocked.test/x", { limiter, deps: fetched }))).toBe(429);
    });

    it("takes the slot after name resolution, so 31 concurrent requests still pass exactly 30", async () => {
        const limiter = createRequestLimiter();
        const deps: EgressDeps = {
            ...fetched,
            lookup: () => new Promise((resolve) => setTimeout(() => resolve([{ address: PUBLIC, family: 4 }]), 20)),
        };
        const statuses = await Promise.all(
            Array.from({ length: MAX_REQUESTS_PER_WINDOW + 1 }, () =>
                serverLuaRequest("https://example.test/x", { limiter, deps }).then(status),
            ),
        );
        expect(statuses.filter((s) => s === 200)).toHaveLength(MAX_REQUESTS_PER_WINDOW);
        expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    });

    it("caps the response by UTF-8 bytes and turns a failing fetch into a 400", async () => {
        const limiter = createRequestLimiter();
        const big = await serverLuaRequest("https://example.test/multibyte", {
            limiter,
            deps: { lookup: publicLookup, fetchImpl: async () => ({ status: 200, data: "é".repeat(1_000_001) }) },
        });
        expect(JSON.parse(big)).toEqual({ status: 400, data: "internal error" });
        const failing = await serverLuaRequest("https://example.test/x", {
            limiter,
            deps: {
                lookup: publicLookup,
                fetchImpl: async () => {
                    throw new Error("socket hang up");
                },
            },
        });
        expect(JSON.parse(failing)).toEqual({ status: 400, data: "internal error" });
    });

    it("rejects through the caller's abort during the fetch and during a stalled lookup", async () => {
        const controller = new AbortController();
        let seenSignal: AbortSignal | undefined;
        const deps: EgressDeps = {
            lookup: publicLookup,
            fetchImpl: (_url, _addresses, signal) => {
                seenSignal = signal;
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(new Error("socket destroyed")), { once: true });
                });
            },
        };
        const pending = serverLuaRequest("https://example.test/x", {
            limiter: createRequestLimiter(),
            deps,
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 20);
        await expect(pending).rejects.toThrow("request aborted");
        expect(seenSignal?.aborted).toBe(true);

        const dns = new AbortController();
        setTimeout(() => dns.abort(), 20);
        await expect(
            serverLuaRequest("https://stalled.test/", {
                limiter: createRequestLimiter(),
                deps: { lookup: () => new Promise(() => {}) },
                signal: dns.signal,
            }),
        ).rejects.toThrow("request aborted");
    });
});

describe("the pinned TLS transport against a local server", () => {
    let certDir: string;
    beforeAll(() => {
        certDir = makeTempDir("risu-egress-tls-");
        execFileSync(
            "openssl",
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                path.join(certDir, "key.pem"),
                "-out",
                path.join(certDir, "cert.pem"),
                "-days",
                "2",
                "-subj",
                "/CN=fable.test",
                "-addext",
                "subjectAltName=DNS:fable.test",
            ],
            { stdio: "ignore" },
        );
    });

    it(
        "pins the address, verifies the URL's host, follows no redirect, caps the body, settles on failures, and answers 408 on the deadline",
        { tags: ["slow"], timeout: 40_000 },
        async () => {
            // A fresh process trusts the minted certificate through NODE_EXTRA_CA_CERTS; the URL names
            // `fable.test` (never resolved: the lookup seam answers a public address, the fetch pins
            // 127.0.0.1), as the server would pin a validated address while the host drives SNI.
            const script = path.join(certDir, "transport.mjs");
            writeFileSync(
                script,
                `import https from "node:https";
import { readFileSync } from "node:fs";
import { pinnedHttpsFetch, serverLuaRequest, createRequestLimiter } from ${JSON.stringify(path.join(REPO_ROOT, "server/src/lua/egress.ts"))};
const dir = ${JSON.stringify(certDir)};
const server = https.createServer({ key: readFileSync(dir + "/key.pem"), cert: readFileSync(dir + "/cert.pem") }, (req, res) => {
    switch (req.url) {
        case "/ok": res.writeHead(200, { "content-type": "text/plain" }); res.end("hello"); return;
        case "/redirect": res.writeHead(302, { location: "/ok" }); res.end("moved"); return;
        case "/big": res.writeHead(200); res.end("x".repeat(2_000_001)); return;
        case "/cut": res.writeHead(200); res.write("partial"); setTimeout(() => res.socket.destroy(), 20); return;
        case "/slow": res.writeHead(200); res.write("start"); return;
        case "/trickle": { res.writeHead(200); const timer = setInterval(() => res.write("."), 500); res.on("close", () => clearInterval(timer)); return; }
        default: res.writeHead(404); res.end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = (p) => "https://fable.test:" + port + p;
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error: error.message, code: error.code }));
const abortAt = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
const deps = { lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetchImpl: (u, _addresses, signal) => pinnedHttpsFetch(u, ["127.0.0.1"], signal) };
const start = performance.now();
const [ok, redirect, big, cut, slow, wrongHost, e2e, e2eBig, e2eTimeout] = await Promise.all([
    settle(pinnedHttpsFetch(url("/ok"), ["127.0.0.1"])),
    settle(pinnedHttpsFetch(url("/redirect"), ["127.0.0.1"])),
    settle(pinnedHttpsFetch(url("/big"), ["127.0.0.1"])),
    settle(pinnedHttpsFetch(url("/cut"), ["127.0.0.1"])),
    settle(pinnedHttpsFetch(url("/slow"), ["127.0.0.1"], abortAt(200))),
    settle(pinnedHttpsFetch("https://other.test:" + port + "/ok", ["127.0.0.1"])),
    serverLuaRequest(url("/ok"), { limiter: createRequestLimiter(), deps }),
    serverLuaRequest(url("/big"), { limiter: createRequestLimiter(), deps }),
    serverLuaRequest(url("/trickle"), { limiter: createRequestLimiter(), deps }).then((raw) => ({ raw, ms: Math.round(performance.now() - start) })),
]);
server.closeAllConnections();
server.close();
console.log(JSON.stringify({ ok, redirect, big, cut, slow, wrongHost, e2e: JSON.parse(e2e), e2eBig: JSON.parse(e2eBig), e2eTimeout: { ...JSON.parse(e2eTimeout.raw), ms: e2eTimeout.ms } }));
`,
            );
            const result = await runNode([script], { NODE_EXTRA_CA_CERTS: path.join(certDir, "cert.pem") });
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            const out = JSON.parse(result.stdout.trim()) as Record<string, Record<string, unknown>>;
            expect(out.ok).toEqual({ value: { status: 200, data: "hello" } });
            expect(out.redirect).toEqual({ value: { status: 302, data: "moved" } });
            expect(out.big).toMatchObject({ error: "response too large" });
            expect(out.cut).toHaveProperty("error");
            expect(out.cut.value).toBeUndefined();
            expect(out.slow).toMatchObject({ error: "request aborted" });
            expect(out.wrongHost).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
            expect(out.e2e).toEqual({ status: 200, data: "hello" });
            expect(out.e2eBig).toEqual({ status: 400, data: "internal error" });
            expect(out.e2eTimeout).toMatchObject({ status: 408, data: "request timeout" });
            expect(out.e2eTimeout.ms as number).toBeGreaterThanOrEqual(9_500);
            expect(out.e2eTimeout.ms as number).toBeLessThan(14_000);
        },
    );
});

describe("the engine lifecycle inside a worker (plain Node)", () => {
    it(
        "keeps the wasm function table flat across runs with awaits, raises the budget inside a resumed coroutine, and runs one task at a time",
        { tags: ["slow"], timeout: 60_000 },
        async () => {
            const dir = makeTempDir("risu-lua-runtime-");
            const script = path.join(dir, "runtime.mjs");
            writeFileSync(
                script,
                `import { readFileSync } from "node:fs";
import { LuaFactory } from ${JSON.stringify(path.join(REPO_ROOT, "node_modules/wasmoon/dist/index.js"))};
import { createLuaRuntime } from ${JSON.stringify(path.join(REPO_ROOT, "server/src/lua/runtime.ts"))};
let adds = 0, removes = 0;
const patched = new Set();
const createEngine = LuaFactory.prototype.createEngine;
LuaFactory.prototype.createEngine = async function (...args) {
    const engine = await createEngine.apply(this, args);
    const module = engine.global.lua.module;
    if (!patched.has(module)) {
        patched.add(module);
        const add = module.addFunction, remove = module.removeFunction;
        module.addFunction = (...a) => (adds++, add(...a));
        module.removeFunction = (...a) => (removes++, remove(...a));
    }
    return engine;
};
const runtime = createLuaRuntime({ jsonLua: readFileSync(${JSON.stringify(path.join(REPO_ROOT, "public/lua/json.lua"))}, "utf8") });
// As worker.ts does: a wasmoon promise step that errors belongs to the active run.
process.on("unhandledRejection", (reason) => { if (!runtime.reportFault(reason)) throw reason; });
const identity = { characterId: null, chatId: null, presetId: null, personaId: null };
const hooks = { aborted: () => false, log: () => {}, callSync: () => null, callAsync: async () => { await new Promise((r) => setTimeout(r, 2)); return "x"; } };
const run = (code, cpuMs = 3000) => runtime.run({ identity, code, mode: "probe", cpuMs, asyncHost: ["slowHost"] }, hooks);
await runtime.warm();
const net = [];
const afterWarm = adds - removes;
for (let i = 1; i <= 30; i++) {
    const out = await run("probe = async(function(id) slowHost():await() slowHost():await() slowHost():await() return 1 end)");
    if (out.error) throw new Error(out.error);
    await runtime.warm();
    if (i % 10 === 0) net.push(adds - removes - afterWarm);
}
const resumed = await run("probe = async(function(id) slowHost():await() while true do end end)", 200);
const concurrent = run("function probe(id) return 1 end");
const overlap = await run("function probe(id) return 2 end").catch((error) => error.message);
console.log(JSON.stringify({ net, resumed: { error: resumed.error, timedOut: resumed.timedOut, cpuMs: resumed.cpuMs }, overlap, concurrent: (await concurrent).res }));
`,
            );
            const result = await runNode([script]);
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            const out = JSON.parse(result.stdout.trim()) as {
                net: number[];
                resumed: { error?: string; timedOut?: boolean; cpuMs: number };
                overlap: string;
                concurrent: unknown;
            };
            expect(out.net).toEqual([0, 0, 0]);
            expect(out.resumed).toMatchObject({ error: "Lua CPU budget exceeded (timeout)", timedOut: true });
            expect(out.resumed.cpuMs).toBeGreaterThanOrEqual(150);
            expect(out.overlap).toBe("A Lua run is already active in this worker");
            expect(out.concurrent).toBe(1);
        },
    );
});
