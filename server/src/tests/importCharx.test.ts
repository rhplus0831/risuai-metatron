// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Zip, ZipDeflate, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRPack } from "../../../shared/rpack.ts";
import { createResourceTestClient, type ResourceTestClient, waitFor } from "./testSupport.ts";

const route = "/api/import/charx";
const servers: ResourceTestClient[] = [];
const responses: Response[] = [];
const card = '{"spec":"chara_card_v3","data":{"name":"캐릭터 🎵"}}';
const bytes = (text: string) => Buffer.from(text);
const keyOf = (data: Uint8Array) => `assets/${createHash("sha256").update(data).digest("hex")}.png`;
const tmpDir = (s: ResourceTestClient) => path.join(s.savePath, ".tmp");
const assetDir = (s: ResourceTestClient) => path.join(s.savePath, "assets");
const staged = (s: ResourceTestClient) => readdirSync(tmpDir(s));
const assetFiles = (s: ResourceTestClient) => (existsSync(assetDir(s)) ? readdirSync(assetDir(s)).sort() : []);
const emptyResult = { card, moduleData: null, assets: {}, excluded: [] };

afterEach(async () => {
    await Promise.all(responses.splice(0).map((res) => res.body?.cancel().catch(() => {})));
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient(options);
    servers.push(s);
    return s;
}
function archive(entries: Record<string, Uint8Array> = {}) {
    return Buffer.from(zipSync({ ...entries, "card.json": bytes(card) }, { level: 0 }));
}
// Risu's writer uses ZipDeflate level 0 with data descriptors. Embedded signatures
// are payload bytes, deliberately not safe for a streaming signature scanner.
function descriptorArchive(entries: Record<string, Uint8Array>) {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => {
        if (error) throw error;
        chunks.push(chunk);
    });
    for (const [name, data] of Object.entries({ ...entries, "card.json": bytes(card) })) {
        const entry = new ZipDeflate(name, { level: 0 });
        zip.add(entry);
        entry.push(data, true);
    }
    zip.end();
    return Buffer.concat(chunks);
}
// Fixture editing follows ZIP's wire offsets; no production reader or constants.
function records(zip: Buffer) {
    const end = zip.length - 22;
    let position = zip.readUInt32LE(end + 16);
    const result: { name: string; central: number; local: number; data: number }[] = [];
    while (position < end) {
        const local = zip.readUInt32LE(position + 42);
        const nameLength = zip.readUInt16LE(position + 28);
        result.push({
            name: zip.subarray(position + 46, position + 46 + nameLength).toString(),
            central: position,
            local,
            data: local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28),
        });
        position += 46 + nameLength + zip.readUInt16LE(position + 30) + zip.readUInt16LE(position + 32);
    }
    return result;
}
function edit(zip: Buffer, name: string, change: (zip: Buffer, entry: ReturnType<typeof records>[number]) => void) {
    const copy = Buffer.from(zip);
    change(
        copy,
        records(copy).find((entry) => entry.name === name)!,
    );
    return copy;
}
async function post(s: ResourceTestClient, body?: RequestInit["body"], extra: RequestInit = {}, url = route) {
    const res = await s.request(url, { method: "POST", body, duplex: "half", ...extra } as RequestInit, null);
    responses.push(res);
    return res;
}
async function lines(res: Response): Promise<any[]> {
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
    expect(await lines(await post(s, archive()))).toEqual([emptyResult]);
    expect(staged(s)).toEqual([]);
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
function unreadBody() {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
        {
            pull(c) {
                reads++;
                c.enqueue(bytes("x"));
                c.close();
            },
        },
        { highWaterMark: 0 },
    );
    return { body, reads: () => reads };
}
function firstAssetClock(s: ResourceTestClient) {
    vi.spyOn(performance, "now").mockImplementation(() => (assetFiles(s).length ? 200 : 0));
}

describe("POST /api/import/charx", () => {
    it.each([false, true])(
        "reads descriptor entries whole, hashes bytes and skips existing keys (JPEG prefix: %s)",
        async (prefixed) => {
            const s = await server();
            const signatures = Buffer.concat([
                bytes("before"),
                Buffer.from("504b0304504b0708504b0102", "hex"),
                bytes("after"),
            ]);
            const module = Buffer.from([111, 0, 255, 128, 0]);
            let zip = descriptorArchive({
                "assets/표정.webp": signatures,
                "empty.bin": Buffer.alloc(0),
                "duplicate.bin": signatures,
                "module.risum": module,
                "x_meta/ignored.json": bytes("not card metadata"),
            });
            // Wrapped/incorrect EOCD counts must not truncate the central-directory walk.
            zip.writeUInt16LE(0, zip.length - 22 + 8);
            zip.writeUInt16LE(0, zip.length - 22 + 10);
            if (prefixed) zip = Buffer.concat([Buffer.from([255, 216, 255, 224, 0, 16, 255, 217]), zip]);
            mkdirSync(assetDir(s), { recursive: true });
            writeFileSync(path.join(s.savePath, keyOf(signatures)), "existing key must survive");
            const answer = await lines(await post(s, zip));
            expect(answer.at(-2)).toEqual({ done: 3, total: 3 });
            expect(answer.at(-1)).toEqual({
                card,
                moduleData: module.toString("base64"),
                assets: {
                    "assets/표정.webp": keyOf(signatures),
                    "empty.bin": keyOf(Buffer.alloc(0)),
                    "duplicate.bin": keyOf(signatures),
                },
                excluded: [],
            });
            expect(assetFiles(s)).toEqual(
                [keyOf(signatures), keyOf(Buffer.alloc(0))].map((key) => path.basename(key)).sort(),
            );
            expect(readFileSync(path.join(s.savePath, keyOf(signatures)), "utf8")).toBe("existing key must survive");
            expect(readFileSync(path.join(s.savePath, keyOf(Buffer.alloc(0))))).toEqual(Buffer.alloc(0));
            await recovered(s);
        },
    );

    it("decodes unflagged names as Latin-1 and never decodes other JSON entries", async () => {
        const s = await server();
        const payload = bytes("unflagged asset");
        let zip = Buffer.from(
            zipSync({ "cafe.bin": payload, "x_meta/ignored.json": bytes("ignored"), "card.json": bytes(card) }),
        );
        zip = edit(zip, "cafe.bin", (b, e) => {
            b[e.local + 30 + 3] = 0xe9;
            b[e.central + 46 + 3] = 0xe9;
        });
        zip = edit(zip, "x_meta/ignored.json", (b, e) => {
            b[e.data] = 0x07;
        }); // reserved deflate block type
        expect((await lines(await post(s, zip))).at(-1)).toEqual({
            ...emptyResult,
            assets: { "café.bin": keyOf(payload) },
        });
        expect(readFileSync(path.join(s.savePath, keyOf(payload)))).toEqual(payload);
        expect(assetFiles(s)).toEqual([path.basename(keyOf(payload))]);
        await recovered(s);
    });

    const invalidBase = archive({ "first.bin": bytes("no writes before validation"), "last.bin": bytes("last") });
    it.each([
        ["plain JPEG", Buffer.from([255, 216, 255, 224, 255, 217])],
        ["truncated zip", invalidBase.subarray(0, -8)],
        ["missing card.json", Buffer.from(zipSync({ "first.bin": bytes("must not write") }))],
        ["bad late local header", edit(invalidBase, "last.bin", (b, e) => b.writeUInt32LE(0, e.local))],
        ["bad central directory", edit(invalidBase, "last.bin", (b, e) => b.writeUInt32LE(0, e.central))],
        ["encrypted local header", edit(invalidBase, "last.bin", (b, e) => b.writeUInt16LE(1, e.local + 6))],
        ["encrypted central record", edit(invalidBase, "last.bin", (b, e) => b.writeUInt16LE(1, e.central + 8))],
        ["entry on another disk", edit(invalidBase, "last.bin", (b, e) => b.writeUInt16LE(1, e.central + 34))],
        [
            "split archive",
            (() => {
                const b = Buffer.from(invalidBase);
                b.writeUInt16LE(1, b.length - 22 + 4);
                return b;
            })(),
        ],
    ])("validates before any write: %s", async (_name, zip) => {
        const s = await server();
        await refused(await post(s, zip), 400, "Invalid character file");
        expect(assetFiles(s)).toEqual([]);
        await recovered(s);
    });

    /**
     * The entry-size rules at `limit`: entries whose local header declares the limit or whose central
     * directory declares one byte more are excluded unread, one that decodes to one byte more is
     * excluded after reading, in file order, and the asset total counts only what is read.
     */
    async function excludesOversized(limit: number, s: ResourceTestClient) {
        // Only the bomb expands beyond the limit. All declared-size cases occupy tiny entries.
        let zip = Buffer.from(
            zipSync(
                {
                    "local-limit.bin": bytes("excluded by local header"),
                    "central-limit.bin": bytes("excluded by directory"),
                    "bomb.bin": new Uint8Array(limit + 1),
                    "kept.bin": bytes("kept"),
                    "module.risum": bytes("excluded module"),
                    "card.json": bytes(card),
                },
                { level: 1 },
            ),
        );
        zip = edit(zip, "local-limit.bin", (b, e) => {
            b.writeUInt32LE(limit, e.local + 22);
            b[e.data] = 7;
        });
        zip = edit(zip, "central-limit.bin", (b, e) => {
            b.writeUInt32LE(limit + 1, e.central + 24);
            b[e.data] = 7;
        });
        zip = edit(zip, "bomb.bin", (b, e) => {
            b.writeUInt32LE(1, e.local + 22);
            b.writeUInt32LE(1, e.central + 24);
        });
        zip = edit(zip, "module.risum", (b, e) => {
            b.writeUInt32LE(limit, e.local + 22);
            b[e.data] = 7;
        });
        zip = edit(zip, "card.json", (b, e) => {
            b.writeUInt32LE(limit + 1, e.central + 24);
            b[e.data] = 7;
        });
        const answer = await lines(await post(s, zip));
        expect(answer.at(-2)).toEqual({ done: 2, total: 2 });
        expect(answer.slice(0, -1).every((p) => p.total === 2)).toBe(true);
        expect(answer.at(-1)).toEqual({
            card: null,
            moduleData: null,
            assets: { "kept.bin": keyOf(bytes("kept")) },
            excluded: ["local-limit.bin", "central-limit.bin", "bomb.bin", "module.risum", "card.json"],
        });
        expect(assetFiles(s)).toEqual([path.basename(keyOf(bytes("kept")))]);
        expect(readFileSync(path.join(s.savePath, keyOf(bytes("kept"))))).toEqual(bytes("kept"));
        await recovered(s);
    }

    it("excludes declared and decoded oversized entries at an injected entry limit, in file order with the exact readable asset total", async () => {
        // A 1 KiB entry limit; the production 50 MiB is the slow case below.
        await excludesOversized(1024, await server({ routeLimits: { charxEntryBytes: 1024 } }));
    });

    it(
        "excludes declared and decoded oversized entries in file order with the exact readable asset total",
        { tags: ["slow"], timeout: 60_000 },
        async () => {
            await excludesOversized(50 * 1024 * 1024, await server());
        },
    );

    it("throttles progress to 200 ms and always reports the final asset", async () => {
        const s = await server();
        const entries = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`${i}.bin`, Buffer.from([i])]));
        const times = [0, 199, 200, 399, 400, 599, 600, 601];
        vi.spyOn(performance, "now").mockImplementation(() => times[assetFiles(s).length]);
        const answer = await lines(await post(s, archive(entries)));
        let previousDone = 0;
        for (const progress of answer.slice(0, -1)) {
            expect(progress.total).toBe(7);
            expect(Number.isInteger(progress.done)).toBe(true);
            expect(progress.done).toBeGreaterThan(previousDone);
            expect(progress.done).toBeLessThanOrEqual(7);
            if (previousDone > 0 && progress.done !== 7) {
                expect(times[progress.done] - times[previousDone]).toBeGreaterThanOrEqual(200);
            }
            previousDone = progress.done;
        }
        expect(answer.at(-2)).toEqual({ done: 7, total: 7 });
        expect(answer.at(-1)).toEqual({
            ...emptyResult,
            assets: Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, keyOf(data)])),
        });
        expect(staged(s)).toEqual([]);
    });

    it("refuses auth, declared/streamed caps, maintenance and missing bodies before reading", async () => {
        const s = await server({ maxImportBytes: 512 });
        vi.spyOn(console, "log").mockImplementation(() => {});
        for (const headers of [{}, { "risu-auth": await s.signer.jwt({ breakSignature: true }) }]) {
            const input = unreadBody();
            const res = await s.app.request(route, {
                method: "POST",
                body: input.body,
                duplex: "half",
                headers: { ...headers, "content-length": "513" },
            } as RequestInit);
            expect(res.status).toBe(400);
            expect(input.reads()).toBe(0);
        }
        const release = deferred();
        const entered = deferred();
        const maintenance = s.context.snapshots.withMaintenance(async () => {
            entered.resolve();
            await release.promise;
        });
        try {
            await entered.promise;
            const input = unreadBody();
            await refused(await post(s, input.body, { headers: { "content-length": "513" } }), 413, "File too large");
            await refused(await post(s, input.body), 503, "Maintenance in progress");
            await refused(await post(s), 503, "Maintenance in progress");
            expect(input.reads()).toBe(0);
            expect(staged(s)).toEqual([]);
        } finally {
            release.resolve();
            await maintenance;
        }
        await refused(await post(s), 400, "CharX body required");
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(Buffer.alloc(256));
                c.enqueue(Buffer.alloc(257));
                c.close();
            },
        });
        await refused(await post(s, body), 413, "File too large");
        expect(assetFiles(s)).toEqual([]);
        await recovered(s);
        const large = await server();
        await refused(
            await post(large, bytes("invalid"), { headers: { "content-length": String(101 * 1024 * 1024) } }),
            400,
            "Invalid character file",
        );
        await recovered(large);
    });

    it.each(["charx", "module"])(
        "shares admission with a running %s upload and releases it after spool cleanup",
        async (kind) => {
            const s = await server({ maxImportBytes: 1024 });
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            const body = new ReadableStream<Uint8Array>(
                {
                    start(c) {
                        controller = c;
                    },
                },
                { highWaterMark: 0 },
            );
            const main = encodeRPack(
                bytes(JSON.stringify({ type: "risuModule", module: { name: "Module", assets: [] } })),
            );
            const header = Buffer.alloc(6);
            header[0] = 111;
            header.writeUInt32LE(main.length, 2);
            const zip = kind === "charx" ? archive() : Buffer.concat([header, main, Buffer.from([0])]);
            const pending = post(s, body, {}, `/api/import/${kind}`);
            let ended = false;
            controller.enqueue(zip.subarray(0, 20));
            const release = deferred();
            const entered = deferred();
            let maintenance: Promise<void> | undefined;
            try {
                await waitFor(() =>
                    staged(s).some((name) => {
                        const file = path.join(tmpDir(s), name, kind === "charx" ? "file.charx" : "module.risum");
                        return existsSync(file) && statSync(file).size === 20;
                    }),
                );
                const folder = staged(s)[0];
                expect(folder).toMatch(new RegExp(`^${kind}-[0-9a-f-]{36}$`));
                expect(
                    readFileSync(path.join(tmpDir(s), folder, kind === "charx" ? "file.charx" : "module.risum")),
                ).toEqual(zip.subarray(0, 20));
                expect(assetFiles(s)).toEqual([]);
                maintenance = s.context.snapshots.withMaintenance(async () => {
                    entered.resolve();
                    await release.promise;
                });
                await entered.promise;
                for (const other of [route, "/api/import/module"]) {
                    const input = unreadBody();
                    await refused(
                        await post(s, input.body, { headers: { "content-length": "1025" } }, other),
                        413,
                        "File too large",
                    );
                    await refused(await post(s, input.body, {}, other), 409, "Another import is running");
                    expect(input.reads()).toBe(0);
                }
            } finally {
                release.resolve();
                await maintenance;
                if (!ended) {
                    controller.enqueue(zip.subarray(20));
                    controller.close();
                    ended = true;
                }
                await (await pending).text();
            }
            await recovered(s);
        },
    );

    it.each(["corrupt deflate", "maintenance", "write failure"])(
        "ends with one error and stops writing after %s",
        async (failure) => {
            const s = await server();
            firstAssetClock(s);
            const entries = { "first.bin": bytes("first"), "second.bin": bytes("second"), "third.bin": bytes("third") };
            let zip = Buffer.from(zipSync({ ...entries, "card.json": bytes(card) }));
            if (failure === "corrupt deflate")
                zip = edit(zip, "second.bin", (b, e) => {
                    b[e.data] = 7;
                });
            const res = await post(s, zip);
            const release = deferred();
            const entered = deferred();
            let maintenance: Promise<void> | undefined;
            const blocked = path.join(s.savePath, keyOf(entries["second.bin"]));
            try {
                await waitFor(() => assetFiles(s).length === 1);
                if (failure === "maintenance") {
                    maintenance = s.context.snapshots.withMaintenance(async () => {
                        entered.resolve();
                        await release.promise;
                    });
                    await entered.promise;
                } else if (failure === "write failure") {
                    mkdirSync(blocked);
                    vi.spyOn(console, "error").mockImplementation(() => {});
                }
                expect(await lines(res)).toEqual([
                    { done: 1, total: 3 },
                    {
                        error:
                            failure === "corrupt deflate"
                                ? "Invalid character file"
                                : failure === "maintenance"
                                  ? "Maintenance in progress"
                                  : "Import failed",
                    },
                ]);
                expect(readFileSync(path.join(s.savePath, keyOf(entries["first.bin"])))).toEqual(entries["first.bin"]);
                expect(existsSync(path.join(s.savePath, keyOf(entries["third.bin"])))).toBe(false);
                expect(staged(s)).toEqual([]);
            } finally {
                release.resolve();
                await maintenance;
                if (failure === "write failure") rmSync(blocked, { force: true, recursive: true });
            }
            expect(assetFiles(s)).toEqual([path.basename(keyOf(entries["first.bin"]))]);
            await recovered(s);
        },
    );

    it("returns 400 for a client aborted during validation and removes staging", async () => {
        const s = await server();
        const resume = deferred();
        const entered = deferred();
        const open = fs.open;
        const abort = new AbortController();
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[1] === "r" && String(args[0]).startsWith(tmpDir(s))) {
                entered.resolve();
                await resume.promise;
            }
            return handle;
        });
        const pending = post(s, archive({ "never.bin": bytes("never") }), { signal: abort.signal });
        try {
            await entered.promise;
            abort.abort();
        } finally {
            resume.resolve();
        }
        await refused(await pending, 400, "Request aborted");
        expect(assetFiles(s)).toEqual([]);
        await recovered(s);
    });

    it.each(["finish", "response cancel", "request abort"])(
        "holds admission through streaming and shutdown waits for %s",
        async (ending) => {
            const s = await server();
            firstAssetClock(s);
            const abort = new AbortController();
            const res = await post(s, archive({ "first.bin": bytes("first"), "second.bin": bytes("second") }), {
                signal: abort.signal,
            });
            await waitFor(() => assetFiles(s).length === 1);
            const input = unreadBody();
            await refused(await post(s, input.body, {}, "/api/import/module"), 409, "Another import is running");
            let disposed = false;
            const disposing = s.context.dispose().then(() => {
                disposed = true;
            });
            await refused(await post(s, input.body), 503, "The server is shutting down");
            expect(input.reads()).toBe(0);
            expect(disposed).toBe(false);
            expect(staged(s)).toHaveLength(1);
            if (ending === "finish") expect((await lines(res)).at(-2)).toEqual({ done: 2, total: 2 });
            else if (ending === "response cancel") await res.body!.cancel();
            else abort.abort();
            await waitFor(() => disposed);
            await disposing;
            expect(staged(s)).toEqual([]);
            expect(assetFiles(s)).toHaveLength(ending === "finish" ? 2 : 1);
        },
    );
});
