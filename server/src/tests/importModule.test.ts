// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRPack } from "../../../shared/rpack.ts";
import { allowListenerOrigin, createResourceTestClient, type ResourceTestClient, waitFor } from "./testSupport.ts";

const route = "/api/import/module";
const servers: ResourceTestClient[] = [];
const responses: Response[] = [];

afterEach(async () => {
    // Also release a suspended generator if an assertion (or a mutation) failed.
    await Promise.all(responses.splice(0).map((res) => res.body?.cancel().catch(() => {})));
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient(options);
    servers.push(s);
    return s;
}

function u32(value: number) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
}

// Independent exporter fixture: literal magic/version, u32le lengths, rpack payloads,
// literal record/end marks. Do not import the server reader or its framing constants.
function mainRecord(text: string) {
    const bytes = encodeRPack(Buffer.from(text, "utf8"));
    return Buffer.concat([Buffer.from([111, 0]), u32(bytes.length), bytes]);
}
function assetRecord(bytes: Uint8Array) {
    const packed = encodeRPack(bytes);
    return Buffer.concat([Buffer.from([1]), u32(packed.length), packed]);
}
function moduleOf(count: number) {
    return {
        id: "fixture-module",
        name: "모듈 🎵",
        description: "Keep the metadata exactly as exported",
        assets: Array.from({ length: count }, (_, i) => [`asset-${i}`, "", "webp"]),
        lorebook: [{ key: "fixture", content: "unmodified" }],
    };
}
function risum(module: object, records: Uint8Array[] = []) {
    return Buffer.concat([
        mainRecord(JSON.stringify({ type: "risuModule", module })),
        ...records.map(assetRecord),
        Buffer.from([0]),
    ]);
}
const keyOf = (bytes: Uint8Array) => `assets/${createHash("sha256").update(bytes).digest("hex")}.png`;
const tmpDir = (s: ResourceTestClient) => path.join(s.savePath, ".tmp");
const assetDir = (s: ResourceTestClient) => path.join(s.savePath, "assets");
const assetFiles = (s: ResourceTestClient) => (existsSync(assetDir(s)) ? readdirSync(assetDir(s)).sort() : []);
const staged = (s: ResourceTestClient) => readdirSync(tmpDir(s));
function spooledFile(s: ResourceTestClient) {
    const folder = staged(s).find((name) => /^module-[0-9a-f-]+$/.test(name));
    if (!folder) return undefined;
    const directory = path.join(tmpDir(s), folder);
    const file = readdirSync(directory).find((name) => statSync(path.join(directory, name)).isFile());
    return file ? path.join(directory, file) : undefined;
}

async function post(s: ResourceTestClient, body?: RequestInit["body"], extra: RequestInit = {}) {
    const res = await s.request(route, { method: "POST", body, duplex: "half", ...extra } as RequestInit, null);
    responses.push(res);
    return res;
}
async function lines(res: Response): Promise<Record<string, unknown>[]> {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    return text
        .slice(0, -1)
        .split("\n")
        .map((line) => JSON.parse(line));
}
async function refused(res: Response, status: number, error: string) {
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    if (status === 503) expect(res.headers.get("retry-after")).toBe("5");
}
async function recovered(s: ResourceTestClient) {
    expect(staged(s)).toEqual([]);
    expect(await lines(await post(s, risum(moduleOf(0))))).toEqual([
        { module: moduleOf(0), assetsWritten: 0, assetsSkipped: 0 },
    ]);
    expect(staged(s)).toEqual([]);
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
function controlledBody() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>(
        {
            start(c) {
                controller = c;
            },
        },
        { highWaterMark: 0 },
    );
    return { body, controller };
}
function unreadBody() {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
        {
            pull(c) {
                reads++;
                c.enqueue(Buffer.from([111]));
                c.close();
            },
        },
        { highWaterMark: 0 },
    );
    return { body, reads: () => reads };
}

// Hold the response at its first progress line using backpressure. The clock is
// driven by observable files, not elapsed wall time or calls into the importer.
function firstRecordClock(s: ResourceTestClient) {
    vi.spyOn(performance, "now").mockImplementation(() => (assetFiles(s).length ? 200 : 0));
}

describe("POST /api/import/module", () => {
    it("stores decoded bytes at browser keys, preserves metadata, skips existing files and accepts legacy empty tails", async () => {
        const s = await server();
        const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
        const records = [jpeg, Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.alloc(0), jpeg];
        const module = moduleOf(records.length + 1);
        const keys = records.map(keyOf);
        mkdirSync(assetDir(s), { recursive: true });
        // Existing content is deliberately different: checking bytes catches an overwrite
        // even if the importer lies about its skipped count.
        writeFileSync(path.join(s.savePath, keys[0]), "pre-existing content");
        const body = Buffer.concat([risum(module, records), Buffer.from([255, 1, 99])]);
        const expectedModule = {
            ...module,
            assets: module.assets.map((entry, i) => [entry[0], keys[i] ?? "", entry[2]]),
        };
        const first = await lines(await post(s, body));
        expect(first.at(-2)).toEqual({ done: records.length, total: records.length });
        expect(first.at(-1)).toEqual({ module: expectedModule, assetsWritten: 2, assetsSkipped: 2 });
        expect(assetFiles(s)).toEqual([...new Set(keys)].map((key) => path.basename(key)).sort());
        expect(readFileSync(path.join(s.savePath, keys[0]), "utf8")).toBe("pre-existing content");
        for (const index of [1, 2]) expect(readFileSync(path.join(s.savePath, keys[index]))).toEqual(records[index]);
        expect(staged(s)).toEqual([]);
        expect(s.context.diagnostics.recent()).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: "lifecycle", phase: "moduleImport" })]),
        );

        const second = await lines(await post(s, body));
        expect(second.at(-1)).toEqual({ module: expectedModule, assetsWritten: 0, assetsSkipped: records.length });
        expect(readFileSync(path.join(s.savePath, keys[0]), "utf8")).toBe("pre-existing content");
        for (const module of [{ name: "absent" }, { name: "null", assets: null }]) {
            expect(await lines(await post(s, risum(module)))).toEqual([{ module, assetsWritten: 0, assetsSkipped: 0 }]);
        }
        await recovered(s);
    });

    it("throttles progress to 200 ms while always reporting the last record", async () => {
        const s = await server();
        const records = Array.from({ length: 7 }, (_, i) => Buffer.from([i]));
        // Just below and exactly at each 200 ms boundary, then a final record only 1 ms later.
        const times = [0, 199, 200, 399, 400, 599, 600, 601];
        vi.spyOn(performance, "now").mockImplementation(() => times[assetFiles(s).length]);
        const answer = await lines(await post(s, risum(moduleOf(9), records)));
        let previousDone = 0;
        for (const progress of answer.slice(0, -1)) {
            expect(progress).toEqual({ done: expect.any(Number), total: 7 });
            const done = progress.done as number;
            expect(Number.isInteger(done)).toBe(true);
            expect(done).toBeGreaterThan(previousDone);
            expect(done).toBeLessThanOrEqual(7);
            // The last record is the explicit exception to the frequency limit.
            if (previousDone > 0 && done !== 7) {
                expect(times[done] - times[previousDone]).toBeGreaterThanOrEqual(200);
            }
            previousDone = done;
        }
        expect(answer.at(-2)).toEqual({ done: 7, total: 7 });
        expect(answer.at(-1)).toMatchObject({ assetsWritten: 7, assetsSkipped: 0 });
        expect(staged(s)).toEqual([]);
    });

    const validPrefix = mainRecord(JSON.stringify({ type: "risuModule", module: moduleOf(2) }));
    const firstAsset = assetRecord(Buffer.from("must not be written before validation finishes"));
    const badMain = (value: unknown) => Buffer.concat([mainRecord(JSON.stringify(value)), Buffer.from([0])]);
    it.each([
        ["short header", Buffer.from([111, 0, 1])],
        ["wrong magic", Buffer.concat([Buffer.from([110]), risum(moduleOf(0)).subarray(1)])],
        ["wrong version", Buffer.concat([Buffer.from([111, 1]), risum(moduleOf(0)).subarray(2)])],
        ["main over 64 MiB", Buffer.concat([Buffer.from([111, 0]), u32(64 * 1024 * 1024 + 1)])],
        ["truncated main", validPrefix.subarray(0, -1)],
        ["non-JSON main", Buffer.concat([mainRecord("not JSON"), Buffer.from([0])])],
        ["wrong type", badMain({ type: "other", module: {} })],
        ["non-object main", badMain(null)],
        ["absent module", badMain({ type: "risuModule" })],
        ["non-object module", badMain({ type: "risuModule", module: [] })],
        ["non-list assets", badMain({ type: "risuModule", module: { assets: {} } })],
        ["non-list asset entry", badMain({ type: "risuModule", module: { assets: ["bad"] } })],
        ["unknown mark after an asset", Buffer.concat([validPrefix, firstAsset, Buffer.from([2])])],
        ["missing end after an asset", Buffer.concat([validPrefix, firstAsset])],
        ["short record header after an asset", Buffer.concat([validPrefix, firstAsset, Buffer.from([1, 2])])],
        [
            "short record payload after an asset",
            Buffer.concat([validPrefix, firstAsset, Buffer.from([1]), u32(9), Buffer.from([5, 0])]),
        ],
        ["more records than entries", risum(moduleOf(1), [Buffer.from("first"), Buffer.from("extra")])],
    ])("validates the whole file before writing: %s", async (_name, body) => {
        const s = await server();
        await refused(await post(s, body), 400, "Invalid module file");
        expect(assetFiles(s)).toEqual([]);
        expect(staged(s)).toEqual([]);
        await recovered(s);
    });

    it("enforces declared, streamed and per-asset caps while bypassing the global body limit", async () => {
        const s = await server({ maxImportBytes: 512 });
        const untouched = unreadBody();
        await refused(await post(s, untouched.body, { headers: { "content-length": "513" } }), 413, "File too large");
        expect(untouched.reads()).toBe(0);
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(Buffer.alloc(256));
                c.enqueue(Buffer.alloc(257));
                c.close();
            },
        });
        await refused(await post(s, body), 413, "File too large");
        await recovered(s);
        const oversizedAsset = Buffer.concat([validPrefix, firstAsset, Buffer.from([1]), u32(100 * 1024 * 1024 + 1)]);
        await refused(await post(s, oversizedAsset), 413, "Asset too large");
        expect(assetFiles(s)).toEqual([]);
        await recovered(s);

        const large = await server();
        // Only the declaration is large; the tiny real file must reach the file validator.
        await refused(
            await post(large, Buffer.from([111]), { headers: { "content-length": String(101 * 1024 * 1024) } }),
            400,
            "Invalid module file",
        );
        await recovered(large);
    });

    it("checks JWT, the shared authenticated limiter, maintenance and missing body before reading", async () => {
        // A 20-request bucket, so spending it takes a few requests (the policy itself is the same limiter).
        const s = await server({ routeLimits: { requestsPerMinute: 20 } });
        vi.spyOn(console, "log").mockImplementation(() => {});
        for (const headers of [{}, { "risu-auth": await s.signer.jwt({ breakSignature: true }) }]) {
            const input = unreadBody();
            const denied = await s.app.request(route, {
                method: "POST",
                headers,
                body: input.body,
                duplex: "half",
            } as RequestInit);
            expect(denied.status).toBe(400);
            expect(input.reads()).toBe(0);
        }
        await refused(await post(s), 400, "Module body required");
        const holding = deferred();
        const entered = deferred();
        const maintenance = s.context.snapshots.withMaintenance(async () => {
            entered.resolve();
            await holding.promise;
        });
        try {
            await entered.promise;
            const input = unreadBody();
            await refused(await post(s, input.body), 503, "Maintenance in progress");
            expect(input.reads()).toBe(0);
            expect(staged(s)).toEqual([]);
        } finally {
            holding.resolve();
            await maintenance;
        }
        await recovered(s);

        // Spend the bucket through another authenticated route, proving it is shared.
        const before = await s.request("/api/backups");
        const remaining = Number(before.headers.get("ratelimit-remaining"));
        expect(before.headers.get("ratelimit-limit")).toBe("20");
        expect(remaining).toBeGreaterThan(0);
        for (let i = 0; i < remaining; i++) await s.app.request("/api/backups");
        const input = unreadBody();
        const limited = await post(s, input.body);
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).not.toBeNull();
        expect(input.reads()).toBe(0);
        expect(staged(s)).toEqual([]);
    });

    it("keeps admission through spool and response streaming, and shutdown waits for the admitted import", async () => {
        const s = await server();
        firstRecordClock(s);
        const records = [Buffer.from("first"), Buffer.from("second")];
        const bytes = risum(moduleOf(2), records);
        const input = controlledBody();
        const pending = post(s, input.body);
        input.controller.enqueue(bytes.subarray(0, 20));
        let ended = false;
        try {
            await waitFor(() => {
                const file = spooledFile(s);
                return !!file && statSync(file).size === 20;
            });
            expect(readFileSync(spooledFile(s)!)).toEqual(bytes.subarray(0, 20));
            expect(assetFiles(s)).toEqual([]);
            const second = unreadBody();
            await refused(await post(s, second.body), 409, "Another import is running");
            expect(second.reads()).toBe(0);
            input.controller.enqueue(bytes.subarray(20));
            input.controller.close();
            ended = true;
            const res = await pending;
            await waitFor(() => assetFiles(s).length === 1);
            const concurrent = unreadBody();
            await refused(await post(s, concurrent.body), 409, "Another import is running");
            expect(concurrent.reads()).toBe(0);

            let disposed = false;
            const disposing = s.context.dispose().then(() => {
                disposed = true;
            });
            const late = unreadBody();
            await refused(await post(s, late.body), 503, "The server is shutting down");
            expect(late.reads()).toBe(0);
            // HTTP admission was observed closed while the response still owns staging.
            expect(disposed).toBe(false);
            expect(staged(s)).toHaveLength(1);
            expect((await lines(res)).at(-1)).toMatchObject({ assetsWritten: 2, assetsSkipped: 0 });
            await waitFor(() => disposed);
            await disposing;
            expect(staged(s)).toEqual([]);
        } finally {
            if (!ended) input.controller.close();
            await (await pending).body?.cancel().catch(() => {});
        }
    });

    it.each(["maintenance", "write failure"] as const)(
        "ends a started stream with one error on %s, preserving earlier files",
        async (failure) => {
            const s = await server();
            firstRecordClock(s);
            const records = [Buffer.from("first"), Buffer.from("second"), Buffer.from("third")];
            const res = await post(s, risum(moduleOf(3), records));
            await waitFor(() => assetFiles(s).length === 1);
            const holding = deferred();
            const entered = deferred();
            const blockedPath = path.join(s.savePath, keyOf(records[1]));
            let maintenance: Promise<void> | undefined;
            try {
                if (failure === "maintenance") {
                    maintenance = s.context.snapshots.withMaintenance(async () => {
                        entered.resolve();
                        await holding.promise;
                    });
                    await entered.promise;
                } else {
                    // A directory at the next key makes the real filesystem rename fail.
                    mkdirSync(blockedPath);
                    vi.spyOn(console, "error").mockImplementation(() => {});
                }
                const answer = await lines(res);
                expect(answer).toEqual([
                    { done: 1, total: 3 },
                    { error: failure === "maintenance" ? "Maintenance in progress" : expect.any(String) },
                ]);
                expect(readFileSync(path.join(s.savePath, keyOf(records[0])))).toEqual(records[0]);
                expect(existsSync(path.join(s.savePath, keyOf(records[2])))).toBe(false);
                expect(staged(s)).toEqual([]);
                expect(
                    s.context.diagnostics
                        .recent()
                        .some((event) => event.kind === "lifecycle" && event.phase === "moduleImport"),
                ).toBe(false);
            } finally {
                holding.resolve();
                await maintenance;
                if (failure === "write failure") rmSync(blockedPath, { recursive: true, force: true });
            }
            expect(assetFiles(s)).toEqual([path.basename(keyOf(records[0]))]);
            await recovered(s);
        },
    );

    it.each(["response cancellation", "request abort"] as const)(
        "cleans staging and releases admission and shutdown after %s",
        async (kind) => {
            const s = await server();
            firstRecordClock(s);
            const abort = new AbortController();
            const records = [Buffer.from("first"), Buffer.from("second"), Buffer.from("third")];
            const res = await post(s, risum(moduleOf(3), records), { signal: abort.signal });
            await waitFor(() => assetFiles(s).length === 1);
            if (kind === "response cancellation") await res.body!.cancel();
            else abort.abort();
            await waitFor(() => staged(s).length === 0);
            expect(assetFiles(s)).toEqual([path.basename(keyOf(records[0]))]);
            await recovered(s);
            let disposed = false;
            const disposing = s.context.dispose().then(() => {
                disposed = true;
            });
            await waitFor(() => disposed);
            await disposing;
        },
    );

    it.each(["spooling", "validation"] as const)(
        "cleans an upload abandoned on a real socket during %s",
        async (phase) => {
            const s = await server();
            vi.spyOn(console, "error").mockImplementation(() => {});
            const resume = deferred();
            let validating = false;
            let disconnected = false;
            if (phase === "validation") {
                // Delay only delivery of the real read handle: disconnect after the complete
                // upload is on disk, before validation can finish or response headers exist.
                const open = fs.open;
                vi.spyOn(fs, "open").mockImplementation(async (...args) => {
                    const handle = await open(...args);
                    if (args[1] === "r" && String(args[0]).startsWith(`${tmpDir(s)}${path.sep}`)) {
                        validating = true;
                        await resume.promise;
                    }
                    return handle;
                });
            }
            const node = serve({
                fetch: async (req, env) => {
                    req.signal.addEventListener("abort", () => {
                        disconnected = true;
                    });
                    const res = await s.app.fetch(req, env);
                    responses.push(res);
                    return res;
                },
                port: 0,
                hostname: "127.0.0.1",
            }) as http.Server;
            await new Promise<void>((resolve) => node.once("listening", resolve));
            allowListenerOrigin(node);
            const { port } = node.address() as { port: number };
            const req = http.request({
                hostname: "127.0.0.1",
                port,
                path: route,
                method: "POST",
                headers: await s.headers({}, null),
            });
            req.on("error", () => {});
            try {
                const bytes = risum(moduleOf(1), [Buffer.from("never written")]);
                if (phase === "validation") {
                    req.end(bytes);
                    await waitFor(() => validating);
                    expect(readFileSync(spooledFile(s)!)).toEqual(bytes);
                } else {
                    req.write(bytes.subarray(0, 20)); // No end(): still reading when the socket leaves.
                    await waitFor(() => {
                        const file = spooledFile(s);
                        return !!file && statSync(file).size === 20;
                    });
                }
                req.destroy();
                await waitFor(() => disconnected);
                resume.resolve();
                await waitFor(() => staged(s).length === 0);
                expect(assetFiles(s)).toEqual([]);
                await recovered(s);
                let disposed = false;
                const disposing = s.context.dispose().then(() => {
                    disposed = true;
                });
                await waitFor(() => disposed);
                await disposing;
            } finally {
                req.destroy();
                resume.resolve();
                node.closeAllConnections();
                await new Promise<void>((resolve, reject) =>
                    node.close((error) => (error ? reject(error) : resolve())),
                );
            }
        },
    );
});
