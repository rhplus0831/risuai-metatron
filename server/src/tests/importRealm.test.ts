// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Buffer as TabBuffer } from "buffer/index.js";
import crc32 from "crc/crc32";
import { zipSync } from "fflate";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { REALM_IMPORT_PATH } from "../../../shared/realmImport.ts";
import { MAX_PNG_CHUNKS, MAX_PNG_TEXT_CHUNK_BYTES, PngFileError, planPngFile } from "../routes/importPng.ts";
import { createResourceTestClient, type ResourceTestClient, waitFor } from "./testSupport.ts";

/**
 * `POST /api/import/realm` over a local stand-in for Realm (`startRealm`: one HTTP server answering
 * `/api/v1/download/dynamic/<id>` from a per-id table), so no test reaches realm.risuai.net. The PNG
 * expectations are built independently of the server reader: the fixture's chunks are concatenated
 * by the test itself, and asset bytes are decoded with the tab's `buffer` package.
 */

const route = REALM_IMPORT_PATH;
const servers: ResourceTestClient[] = [];
const realms: Realm[] = [];
const responses: Response[] = [];
const bytes = (text: string) => Buffer.from(text, "utf-8");
const keyOf = (data: Uint8Array) => `assets/${createHash("sha256").update(data).digest("hex")}.png`;
const tmpDir = (s: ResourceTestClient) => path.join(s.savePath, ".tmp");
const assetDir = (s: ResourceTestClient) => path.join(s.savePath, "assets");
const staged = (s: ResourceTestClient) => readdirSync(tmpDir(s));
const assetFiles = (s: ResourceTestClient) => (existsSync(assetDir(s)) ? readdirSync(assetDir(s)).sort() : []);
const stored = (s: ResourceTestClient, key: string) => readFileSync(path.join(s.savePath, key));
const card = '{"spec":"chara_card_v3","data":{"name":"캐릭터 🎵"}}';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
const v3 = (name: string) => b64({ spec: "chara_card_v3", data: { name } });

// PNG pieces, built here and not by any production writer or reader.
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string, data: Uint8Array | string): Buffer {
    const typeBytes = Buffer.from(type, "latin1");
    const payload = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])) >>> 0);
    return Buffer.concat([length, typeBytes, payload, crc]);
}
const text = (key: string, value: string | Uint8Array) =>
    chunk("tEXt", Buffer.concat([Buffer.from(key, "utf-8"), Buffer.from([0]), Buffer.from(value)]));
const png = (...chunks: Uint8Array[]) => Buffer.concat([PNG_SIGNATURE, ...chunks]);
const ihdr = chunk("IHDR", Buffer.alloc(13));
const iend = chunk("IEND", Buffer.alloc(0));
/** The bytes the tab's `Buffer.from(value, "base64")` (the `buffer` package) gives. */
function tabBytes(value: string): Buffer {
    const decoded = TabBuffer.from(value, "base64");
    return Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

type RealmRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; closed: boolean };
type RealmAnswer = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type Realm = {
    url: string;
    requests: RealmRequest[];
    answer(id: string, handler: RealmAnswer): void;
    requestsFor(id: string): RealmRequest[];
    received(id: string, count?: number): Promise<RealmRequest>;
    close(): void;
};
const downloadPath = (id: string) => `/api/v1/download/dynamic/${id}`;

/** A local Realm: `answer(id, handler)` serves `/api/v1/download/dynamic/<id>`; anything else is Realm's 404 JSON. */
async function startRealm(): Promise<Realm> {
    const answers = new Map<string, RealmAnswer>();
    const requests: RealmRequest[] = [];
    const server = http.createServer((req, res) => {
        const record: RealmRequest = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            closed: false,
        };
        requests.push(record);
        res.on("close", () => {
            record.closed = true;
        });
        req.resume();
        const answer = answers.get(new URL(req.url ?? "/", "http://realm").pathname);
        if (!answer) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end('{"error":"Not found"}');
            return;
        }
        answer(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const realm: Realm = {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        answer(id: string, handler: RealmAnswer) {
            answers.set(downloadPath(id), handler);
        },
        requestsFor: (id: string) => requests.filter((r) => r.url.startsWith(`${downloadPath(id)}?`)),
        async received(id: string, count = 1) {
            await waitFor(() => realm.requestsFor(id).length >= count);
            return realm.requestsFor(id)[count - 1];
        },
        close() {
            server.closeAllConnections();
            server.close();
        },
    };
    realms.push(realm);
    // A small CharX every server can download (`recovered`).
    realm.answer("ok", file("application/charx", archive()));
    return realm;
}
/** A whole answer with its declared length. */
const file =
    (type: string | null, body: Uint8Array | string, status = 200, extra: Record<string, string> = {}): RealmAnswer =>
    (_req, res) => {
        const payload = typeof body === "string" ? bytes(body) : Buffer.from(body);
        res.writeHead(status, {
            ...(type === null ? {} : { "content-type": type }),
            "content-length": String(payload.length),
            ...extra,
        });
        res.end(payload);
    };
const redirect =
    (location: string): RealmAnswer =>
    (_req, res) => {
        res.writeHead(302, { location });
        res.end("moved");
    };
function archive(entries: Record<string, Uint8Array> = {}) {
    return Buffer.from(zipSync({ ...entries, "card.json": bytes(card) }, { level: 0 }));
}

afterEach(async () => {
    await Promise.all(responses.splice(0).map((res) => res.body?.cancel().catch(() => {})));
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
    for (const realm of realms.splice(0)) realm.close();
});

async function server(realm: Realm, options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient({ realm: { downloadOrigin: realm.url }, ...options });
    servers.push(s);
    return s;
}
async function post(s: ResourceTestClient, body: unknown, init: RequestInit = {}, url = route) {
    const res = await s.request(
        url,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
            ...init,
        },
        null,
    );
    responses.push(res);
    return res;
}
const download = (s: ResourceTestClient, id: string, init: RequestInit = {}) => post(s, { id }, init);
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
/** The slot and the staging are free again: the next download works. */
async function recovered(s: ResourceTestClient) {
    expect(staged(s)).toEqual([]);
    expect((await lines(await download(s, "ok"))).at(-1)).toEqual({
        kind: "charx",
        card,
        moduleData: null,
        assets: {},
        excluded: [],
    });
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
/** The first asset's progress line is sent at once, so the lines pause there until the answer is read. */
function firstAssetClock(s: ResourceTestClient) {
    vi.spyOn(performance, "now").mockImplementation(() => (assetFiles(s).length ? 200 : 0));
}
const lifecycle = (s: ResourceTestClient, phase: string) =>
    s.context.diagnostics.recent().filter((event) => event.kind === "lifecycle" && event.phase === phase);

describe("POST /api/import/realm", () => {
    it.each(["application/charx", "application/zip"])(
        "downloads a %s answer with only the API version header and reads it with the CharX reader",
        async (type) => {
            const realm = await startRealm();
            const s = await server(realm);
            const payload = Buffer.from([0, 255, 128, 80, 75, 3, 4]);
            const module = Buffer.from([111, 0, 255, 128, 0]);
            realm.answer(
                "charx-id",
                file(
                    type,
                    archive({ "assets/bg.webp": payload, "module.risum": module, "x_meta/ignored.json": bytes("x") }),
                ),
            );
            expect(await lines(await download(s, "charx-id"))).toEqual([
                { done: 1, total: 1 },
                {
                    kind: "charx",
                    card,
                    moduleData: module.toString("base64"),
                    assets: { "assets/bg.webp": keyOf(payload) },
                    excluded: [],
                },
            ]);
            expect(stored(s, keyOf(payload))).toEqual(payload);
            expect(assetFiles(s)).toEqual([path.basename(keyOf(payload))]);
            expect(staged(s)).toEqual([]);
            const request = await realm.received("charx-id");
            expect(request.method).toBe("GET");
            expect(request.url).toBe(`${downloadPath("charx-id")}?cors=true`);
            expect(request.headers["x-risu-api-version"]).toBe("4");
            expect(request.headers["risu-auth"]).toBeUndefined();
            expect(request.headers.authorization).toBeUndefined();
            expect(request.headers.cookie).toBeUndefined();
            expect(request.headers["x-resource-epoch"]).toBeUndefined();
            await waitFor(() => request.closed);
            expect(lifecycle(s, "realmImport")).toHaveLength(1);
            expect(lifecycle(s, "charxImport")).toEqual([]);
            await recovered(s);
        },
    );

    it("reads a PNG as the tab does: the image without its text chunks, the last card text, and the assets by the tab's base64 decoder", async () => {
        const realm = await startRealm();
        const s = await server(realm);
        const assetA = bytes("asset A: the first chunk of index 0");
        const assetB = bytes("asset B: the later chunk of index 0 wins");
        // A stray character: the tab's decoder drops it, Node's does not; the key must be the tab's.
        const odd = "ŁAAA";
        const oddBytes = tabBytes(odd);
        expect(keyOf(oddBytes)).not.toBe(keyOf(Buffer.from(odd, "base64")));
        const time = chunk("tIME", Buffer.from([7, 230, 10, 19, 1, 2, 3]));
        const idat = chunk("IDAT", randomBytes(3000));
        const last = v3("last");
        const image = png(
            ihdr,
            text("Comment", "kept by nobody"),
            chunk("tEXt", bytes("no NUL in this chunk")),
            text("chara", b64({ spec: "chara_card_v2", data: { name: "v2" } })),
            text("ccv3", v3("first")),
            time,
            text("chara-ext-asset_:0", assetA.toString("base64")),
            text("chara-ext-asset_1", odd),
            text("chara-ext-asset_0", assetB.toString("base64")),
            text("chara-ext-asset_2", ""),
            idat,
            text("ccv3", last),
            iend,
            bytes("trailing bytes after IEND are ignored"),
        );
        const trimmed = png(ihdr, time, idat, iend);
        realm.answer("png-id", file("image/png", image));
        const answer = await lines(await download(s, "png-id"));
        expect(answer.at(-1)).toEqual({
            kind: "png",
            card: last,
            image: keyOf(trimmed),
            assets: { "0": keyOf(assetB), "1": keyOf(oddBytes), "2": keyOf(Buffer.alloc(0)) },
        });
        expect(answer.at(-2)).toEqual({ done: 4, total: 4 });
        expect(answer.slice(0, -1).every((progress) => progress.total === 4)).toBe(true);
        expect(stored(s, keyOf(trimmed))).toEqual(trimmed);
        expect(stored(s, keyOf(assetA))).toEqual(assetA);
        expect(stored(s, keyOf(assetB))).toEqual(assetB);
        expect(stored(s, keyOf(oddBytes))).toEqual(oddBytes);
        expect(stored(s, keyOf(Buffer.alloc(0)))).toEqual(Buffer.alloc(0));
        expect(assetFiles(s)).toEqual(
            [assetA, assetB, oddBytes, Buffer.alloc(0), trimmed].map((data) => path.basename(keyOf(data))).sort(),
        );
        expect(staged(s)).toEqual([]);
        expect(lifecycle(s, "realmImport")).toHaveLength(1);
        await recovered(s);
    });

    it("keeps an existing asset file, and a PNG that ends on a chunk boundary without IEND", async () => {
        const realm = await startRealm();
        const s = await server(realm);
        const asset = bytes("already stored");
        mkdirSync(assetDir(s), { recursive: true });
        writeFileSync(path.join(s.savePath, keyOf(asset)), "existing key must survive");
        const idat = chunk("IDAT", bytes("pixels"));
        realm.answer(
            "open-ended",
            file(
                "Image/PNG; charset=binary",
                png(ihdr, text("ccv3", v3("open")), text("chara-ext-asset_7", asset.toString("base64")), idat),
            ),
        );
        const answer = await lines(await download(s, "open-ended"));
        expect(answer.at(-1)).toEqual({
            kind: "png",
            card: v3("open"),
            image: keyOf(png(ihdr, idat)),
            assets: { "7": keyOf(asset) },
        });
        expect(readFileSync(path.join(s.savePath, keyOf(asset)), "utf8")).toBe("existing key must survive");
        expect(stored(s, keyOf(png(ihdr, idat)))).toEqual(png(ihdr, idat));
        await recovered(s);
    });

    it.each([
        {
            name: "ccv3 wins over chara, the last of each under 5 MiB",
            chunks: [text("chara", "Y"), text("ccv3", "first"), text("chara", "Z"), text("ccv3", "second")],
            card: "second",
        },
        { name: "an empty ccv3 falls back to chara", chunks: [text("ccv3", ""), text("chara", "X")], card: "X" },
        { name: "an empty card chunk only is a null card", chunks: [text("ccv3", "")], card: null },
        {
            name: "a 5 MiB text is kept over a later chunk of its key",
            chunks: [text("ccv3", "A".repeat(5 * 1024 * 1024)), text("ccv3", "later")],
            card: "A".repeat(5 * 1024 * 1024),
        },
        {
            name: "a text one short of 5 MiB is replaced",
            chunks: [text("ccv3", "A".repeat(5 * 1024 * 1024 - 1)), text("ccv3", "later")],
            card: "later",
        },
    ])("chooses the card text as the tab does: $name", async ({ chunks, card: expected }) => {
        const realm = await startRealm();
        const s = await server(realm);
        realm.answer("cards", file("image/png", png(ihdr, ...chunks, iend)));
        expect(await lines(await download(s, "cards"))).toEqual([
            { kind: "png", card: expected, image: keyOf(png(ihdr, iend)), assets: {} },
        ]);
        expect(assetFiles(s)).toEqual([path.basename(keyOf(png(ihdr, iend)))]);
        expect(staged(s)).toEqual([]);
    });

    it.each([
        ["not a PNG", "image/png", bytes("GIF89a not a png at all")],
        ["an empty file", "image/png", Buffer.alloc(0)],
        ["the signature only", "image/png", PNG_SIGNATURE],
        [
            "a truncated chunk",
            "image/png",
            png(ihdr, text("ccv3", v3("cut")), chunk("IDAT", bytes("pixels"))).subarray(0, -2),
        ],
        [
            "a partial chunk header",
            "image/png",
            Buffer.concat([png(ihdr, text("ccv3", v3("cut"))), Buffer.from([0, 0, 0])]),
        ],
        ["no card chunk", "image/png", png(ihdr, text("chara-ext-asset_0", bytes("QUJD").toString("base64")), iend)],
        ["a text chunk without a key", "image/png", png(ihdr, chunk("tEXt", bytes("ccv3 without NUL")), iend)],
        ["a CharX that is not a zip", "application/charx", bytes("not a zip")],
    ])("refuses %s as an invalid character file before anything is written", async (_name, type, body) => {
        const realm = await startRealm();
        const s = await server(realm);
        realm.answer("bad", file(type, body));
        await refused(await download(s, "bad"), 400, "Invalid character file");
        expect(assetFiles(s)).toEqual([]);
        expect(lifecycle(s, "realmImport")).toEqual([]);
        await recovered(s);
    });

    it("passes a legacy JSON answer (any other content type, or none) through as text", async () => {
        const realm = await startRealm();
        const s = await server(realm);
        const body = '{"card":{"spec":"chara_card_v3","data":{"name":"Legacy"}},"img":"resource-id"}';
        realm.answer("json-id", file("application/json; charset=utf-8", body));
        realm.answer("typeless", file(null, body));
        for (const id of ["json-id", "typeless"]) {
            expect(await lines(await download(s, id))).toEqual([{ kind: "json", body }]);
            expect(assetFiles(s)).toEqual([]);
            expect(staged(s)).toEqual([]);
        }
        expect(lifecycle(s, "realmImport")).toHaveLength(2);
        await recovered(s);
    });

    it("caps the download: a declared unencoded length before the body, the decoded bytes otherwise, JSON at 16 MiB", async () => {
        const realm = await startRealm();
        const s = await server(realm, { maxImportBytes: 64 });
        const long = "x".repeat(100);
        realm.answer("declared", file("image/png", long));
        await refused(await download(s, "declared"), 413, "File too large");
        const declared = await realm.received("declared");
        await waitFor(() => declared.closed);
        realm.answer("chunked", (_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.write(long.slice(0, 50));
            res.end(long.slice(50));
        });
        await refused(await download(s, "chunked"), 413, "File too large");
        // An encoded length is not the decoded length: only the spool's count applies.
        const small = JSON.stringify({ card: randomBytes(30).toString("base64") });
        const gzipped = gzipSync(small);
        expect(gzipped.length).toBeGreaterThan(64);
        expect(small.length).toBeLessThanOrEqual(64);
        realm.answer("gzipped", file("application/json", gzipped, 200, { "content-encoding": "gzip" }));
        expect(await lines(await download(s, "gzipped"))).toEqual([{ kind: "json", body: small }]);
        expect(staged(s)).toEqual([]);
        expect(assetFiles(s)).toEqual([]);

        const large = await server(realm, { maxImportBytes: 64 * 1024 * 1024 });
        const overJson = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
        realm.answer("big-json", file("application/json", overJson));
        await refused(await download(large, "big-json"), 413, "File too large");
        // The same length as a PNG is under the import cap: downloaded, then refused by the reader.
        realm.answer("big-png", file("image/png", overJson));
        await refused(await download(large, "big-png"), 400, "Invalid character file");
        await recovered(large);
    });

    it("answers 502 with Realm's text (its first 4 KiB) for an answer other than 200, or `Realm answered <status>`", async () => {
        const realm = await startRealm();
        const s = await server(realm);
        await refused(await download(s, "missing"), 502, '{"error":"Not found"}');
        realm.answer("long", file("text/plain", "e".repeat(5000), 500));
        await refused(await download(s, "long"), 502, "e".repeat(4096));
        realm.answer("silent", (_req, res) => {
            res.writeHead(403);
            res.end();
        });
        await refused(await download(s, "silent"), 502, "Realm answered 403");
        realm.answer("moved-nowhere", (_req, res) => {
            res.writeHead(302);
            res.end("  gone  ");
        });
        await refused(await download(s, "moved-nowhere"), 502, "gone");
        for (const request of realm.requests) await waitFor(() => request.closed);
        expect(staged(s)).toEqual([]);
        await recovered(s);
    });

    it("follows at most 3 redirects within the Realm origin and refuses any other destination without fetching it", async () => {
        const realm = await startRealm();
        const elsewhere = await startRealm();
        const s = await server(realm);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        realm.answer("hop", redirect(`${downloadPath("ok")}?cors=true&hop=1`));
        expect((await lines(await download(s, "hop"))).at(-1)).toMatchObject({ kind: "charx", card });
        expect((await realm.received("ok")).headers["x-risu-api-version"]).toBe("4");

        realm.answer("away", redirect(`${elsewhere.url}${downloadPath("ok")}?cors=true`));
        realm.answer("protocol-relative", redirect(`//127.0.0.1:${new URL(elsewhere.url).port}${downloadPath("ok")}`));
        realm.answer("lookalike", redirect("https://realm.risuai.net.evil.example/x"));
        realm.answer("port", redirect("https://cdn.risuai.net:8443/x"));
        realm.answer("plain-http", redirect("http://cdn.risuai.net/x"));
        for (const id of ["away", "protocol-relative", "lookalike", "port", "plain-http"]) {
            await refused(await download(s, id), 502, "Realm download failed");
            expect(realm.requestsFor(id)).toHaveLength(1);
        }
        expect(elsewhere.requests).toEqual([]);
        realm.answer("loop", redirect(`${downloadPath("loop")}?cors=true`));
        await refused(await download(s, "loop"), 502, "Realm download failed");
        expect(realm.requestsFor("loop")).toHaveLength(4);
        expect(warn.mock.calls.map(([first]) => first)).toEqual(Array(6).fill("[Server] Realm download failed:"));
        expect(staged(s)).toEqual([]);
        await recovered(s);
    });

    it("answers 502 when Realm cannot be reached", async () => {
        const realm = await startRealm();
        const s = await server(realm, { realm: { downloadOrigin: "http://127.0.0.1:1" } });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await refused(await download(s, "ok"), 502, "Realm download failed");
        expect(staged(s)).toEqual([]);
        expect(realm.requests).toEqual([]);
    });

    it("reads the body only after auth and admission: at most 4 KiB of JSON naming a Realm id, and never contacts Realm otherwise", async () => {
        const realm = await startRealm();
        const s = await server(realm);
        vi.spyOn(console, "log").mockImplementation(() => {});
        const oversized = bytes(JSON.stringify({ id: "ok", pad: "p".repeat(4097) }));
        for (const headers of [{}, { "risu-auth": await s.signer.jwt({ breakSignature: true }) }]) {
            const input = unreadBody();
            const res = await s.app.request(route, {
                method: "POST",
                body: input.body,
                duplex: "half",
                headers: { ...headers, "content-type": "application/json", "content-length": String(oversized.length) },
            } as RequestInit);
            responses.push(res);
            expect(res.status).toBe(400);
            expect(input.reads()).toBe(0);
        }
        await refused(await post(s, oversized), 413, "Request body too large");
        for (const body of [
            { id: "../x" },
            { id: "" },
            { id: "a".repeat(129) },
            { id: 5 },
            { id: null },
            { realm: "ok" },
            ["ok"],
            "not json",
            "",
        ]) {
            await refused(await post(s, body), 400, "Invalid Realm id");
        }
        await refused(
            await post(s, { id: "ok" }, { headers: { "content-type": "text/plain" } }),
            400,
            "Invalid Realm id",
        );
        await refused(await post(s, { id: "ok" }, { body: null } as RequestInit), 400, "Invalid Realm id");
        expect(realm.requests).toEqual([]);
        expect(staged(s)).toEqual([]);
        const exact = { id: "a-Z_0-9", pad: "" };
        exact.pad = "p".repeat(4096 - JSON.stringify(exact).length);
        expect(JSON.stringify(exact)).toHaveLength(4096);
        realm.answer("a-Z_0-9", file("application/charx", archive()));
        expect((await lines(await post(s, exact))).at(-1)).toMatchObject({ kind: "charx", card });
        await recovered(s);
    });

    it("refuses a download during maintenance and while another import holds the slot, without contacting Realm", async () => {
        const realm = await startRealm();
        const s = await server(realm, { maxImportBytes: 1024 });
        const release = deferred();
        const entered = deferred();
        const maintenance = s.context.snapshots.withMaintenance(async () => {
            entered.resolve();
            await release.promise;
        });
        try {
            await entered.promise;
            await refused(await download(s, "ok"), 503, "Maintenance in progress");
        } finally {
            release.resolve();
            await maintenance;
        }
        // A CharX upload in progress holds the shared slot.
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>(
            {
                start(c) {
                    controller = c;
                },
            },
            { highWaterMark: 0 },
        );
        const zip = archive();
        const pending = s.request("/api/import/charx", { method: "POST", body, duplex: "half" } as RequestInit, null);
        controller.enqueue(zip.subarray(0, 20));
        await waitFor(() => staged(s).length === 1);
        await refused(await download(s, "ok"), 409, "Another import is running");
        controller.enqueue(zip.subarray(20));
        controller.close();
        await (await pending).text();
        expect(realm.requests).toEqual([]);
        await recovered(s);
    });

    it("holds the slot while the download runs, aborts the download when the client leaves, and frees the slot", async () => {
        const realm = await startRealm();
        const s = await server(realm);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        realm.answer("stall", (_req, res) => {
            res.writeHead(200, { "content-type": "image/png" });
            res.write(PNG_SIGNATURE);
            // Never ends: the client has to leave.
        });
        const abort = new AbortController();
        const pending = download(s, "stall", { signal: abort.signal });
        const stalled = await realm.received("stall");
        await waitFor(() => staged(s).length === 1);
        const input = unreadBody();
        await refused(await post(s, input.body, {}, "/api/import/charx"), 409, "Another import is running");
        await refused(await post(s, input.body, {}, "/api/import/module"), 409, "Another import is running");
        await refused(await download(s, "ok"), 409, "Another import is running");
        expect(input.reads()).toBe(0);
        abort.abort();
        await refused(await pending, 502, "Realm download failed");
        await waitFor(() => stalled.closed);
        expect(staged(s)).toEqual([]);
        expect(assetFiles(s)).toEqual([]);
        await recovered(s);
    });

    it.each(["finish", "response cancel", "request abort"])(
        "holds admission through the PNG stream and shutdown waits for %s",
        async (ending) => {
            const realm = await startRealm();
            const s = await server(realm);
            firstAssetClock(s);
            const assets = [bytes("first asset"), bytes("second asset")];
            realm.answer(
                "two",
                file(
                    "image/png",
                    png(
                        ihdr,
                        text("ccv3", v3("two")),
                        text("chara-ext-asset_0", assets[0].toString("base64")),
                        text("chara-ext-asset_1", assets[1].toString("base64")),
                        iend,
                    ),
                ),
            );
            const abort = new AbortController();
            const res = await download(s, "two", { signal: abort.signal });
            await waitFor(() => assetFiles(s).length === 1);
            const input = unreadBody();
            await refused(await post(s, input.body, {}, "/api/import/charx"), 409, "Another import is running");
            let disposed = false;
            const disposing = s.context.dispose().then(() => {
                disposed = true;
            });
            await refused(await download(s, "ok"), 503, "The server is shutting down");
            expect(input.reads()).toBe(0);
            expect(disposed).toBe(false);
            expect(staged(s)).toHaveLength(1);
            if (ending === "finish") {
                const answer = await lines(res);
                expect(answer.at(-2)).toEqual({ done: 2, total: 2 });
                expect(answer.at(-1)).toEqual({
                    kind: "png",
                    card: v3("two"),
                    image: keyOf(png(ihdr, iend)),
                    assets: { "0": keyOf(assets[0]), "1": keyOf(assets[1]) },
                });
            } else if (ending === "response cancel") await res.body!.cancel();
            else abort.abort();
            await waitFor(() => disposed);
            await disposing;
            expect(staged(s)).toEqual([]);
            expect(assetFiles(s)).toHaveLength(ending === "finish" ? 3 : 1);
            expect(realm.requestsFor("two")).toHaveLength(1);
            await waitFor(() => realm.requestsFor("two")[0].closed);
        },
    );

    it("a response cancelled during the image copy stops the copy at its next piece and publishes no image", async () => {
        const realm = await startRealm();
        const s = await server(realm);
        const idat = chunk("IDAT", Buffer.alloc(3 * 1024 * 1024, 7));
        realm.answer("big", file("image/png", png(ihdr, text("ccv3", v3("big")), idat, iend)));
        const entered = deferred();
        const resume = deferred();
        const writes: number[] = [];
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[1] === "wx" && String(args[0]).endsWith("image.png")) {
                const write = handle.write.bind(handle) as (...writeArgs: unknown[]) => Promise<unknown>;
                vi.spyOn(handle, "write").mockImplementation((async (...writeArgs: unknown[]) => {
                    writes.push((writeArgs[0] as Uint8Array).byteLength);
                    if (writes.length === 1) {
                        entered.resolve();
                        await resume.promise;
                    }
                    return write(...writeArgs);
                }) as typeof handle.write);
            }
            return handle;
        });
        const res = await download(s, "big");
        await entered.promise;
        const cancelling = res.body!.cancel();
        resume.resolve();
        await cancelling;
        // The signature was in flight; the 3 MiB IDAT is never copied.
        expect(writes).toEqual([PNG_SIGNATURE.length]);
        await waitFor(() => staged(s).length === 0);
        expect(assetFiles(s)).toEqual([]);
        vi.restoreAllMocks();
        await recovered(s);
    });

    it.each(["maintenance", "write failure"])(
        "ends with one error line and stops writing after %s",
        async (failure) => {
            const realm = await startRealm();
            const s = await server(realm);
            firstAssetClock(s);
            const assets = [bytes("first asset"), bytes("second asset"), bytes("third asset")];
            realm.answer(
                "three",
                file(
                    "image/png",
                    png(
                        ihdr,
                        text("ccv3", v3("three")),
                        ...assets.map((asset, i) => text(`chara-ext-asset_${i}`, asset.toString("base64"))),
                        iend,
                    ),
                ),
            );
            const res = await download(s, "three");
            const release = deferred();
            const entered = deferred();
            let maintenance: Promise<void> | undefined;
            const blocked = path.join(s.savePath, keyOf(assets[1]));
            try {
                await waitFor(() => assetFiles(s).length === 1);
                if (failure === "maintenance") {
                    maintenance = s.context.snapshots.withMaintenance(async () => {
                        entered.resolve();
                        await release.promise;
                    });
                    await entered.promise;
                } else {
                    mkdirSync(blocked);
                    vi.spyOn(console, "error").mockImplementation(() => {});
                }
                expect(await lines(res)).toEqual([
                    { done: 1, total: 3 },
                    { error: failure === "maintenance" ? "Maintenance in progress" : "Import failed" },
                ]);
                expect(stored(s, keyOf(assets[0]))).toEqual(assets[0]);
                expect(existsSync(path.join(s.savePath, keyOf(assets[2])))).toBe(false);
                expect(existsSync(path.join(s.savePath, keyOf(png(ihdr, iend))))).toBe(false);
                expect(staged(s)).toEqual([]);
                expect(lifecycle(s, "realmImport")).toEqual([]);
            } finally {
                release.resolve();
                await maintenance;
                if (failure === "write failure") rmSync(blocked, { force: true, recursive: true });
            }
            await recovered(s);
        },
    );
});

describe("planPngFile caps", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-png-plan-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    async function plan(image: Buffer) {
        const file = path.join(dir, `${randomBytes(4).toString("hex")}.png`);
        writeFileSync(file, image);
        const handle = await fs.open(file, "r");
        try {
            return await planPngFile(handle, new AbortController().signal);
        } finally {
            await handle.close();
            rmSync(file, { force: true });
        }
    }
    /** A text chunk whose data is exactly `length` bytes. */
    const sized = (key: string, length: number) => text(key, Buffer.alloc(length - key.length - 1, 0x41));

    it("refuses a card or asset chunk over MAX_PNG_TEXT_CHUNK_BYTES and reads no other text chunk", async () => {
        const cap = MAX_PNG_TEXT_CHUNK_BYTES;
        await expect(plan(png(ihdr, sized("ccv3", cap), iend))).resolves.toEqual({ total: 0 });
        await expect(plan(png(ihdr, sized("ccv3", cap + 1), iend))).rejects.toThrow(PngFileError);
        await expect(plan(png(ihdr, text("ccv3", "x"), sized("chara-ext-asset_0", cap + 1), iend))).rejects.toThrow(
            "too large",
        );
        await expect(plan(png(ihdr, text("chara", "x"), sized("Comment", cap + 1), iend))).resolves.toEqual({
            total: 0,
        });
    }, 60_000);

    it("refuses more than MAX_PNG_CHUNKS chunks (the asset-chunk cap is in importPngCaps.test.ts, slow)", async () => {
        const empty = chunk("tIME", Buffer.alloc(0));
        const fill = (count: number) => Buffer.concat(Array<Buffer>(count).fill(empty));
        // The IHDR, the card chunk, and the IEND count too.
        await expect(plan(png(ihdr, text("ccv3", "x"), fill(MAX_PNG_CHUNKS - 3), iend))).resolves.toEqual({ total: 0 });
        await expect(plan(png(ihdr, text("ccv3", "x"), fill(MAX_PNG_CHUNKS - 2), iend))).rejects.toThrow(
            "too many chunks",
        );
    }, 60_000);
});
