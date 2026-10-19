// @vitest-environment node
import zlib from "node:zlib";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResourceKind } from "../data/kinds.ts";
import { COMPRESS_MIN_BYTES, compressedJson, pickEncoding } from "../http/compressedJson.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

const servers: ResourceTestClient[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

const docs: ResourceKind = { name: "docs", schemaVersion: 1, normalize: (input) => input };

/** A server holding one `docs` record whose JSON is well over the compression threshold. */
async function serverWithLargeDoc() {
    const s = await createResourceTestClient({ resourceKinds: [docs], epochKind: "docs" });
    servers.push(s);
    await s.readEpoch();
    const created = await s.put("docs", "big", { baseRevision: null, data: { text: "x".repeat(COMPRESS_MIN_BYTES) } });
    expect(created.status).toBe(200);
    return s;
}

/** The four compressed reads of the `big` record. */
const reads: { label: string; send: (s: ResourceTestClient, encoding?: string) => Promise<Response> }[] = [
    {
        label: "GET /api/resources",
        send: (s, encoding) => s.request("/api/resources?kinds=docs", { headers: acceptHeaders(encoding) }),
    },
    {
        label: "POST /api/resources/read",
        send: (s, encoding) =>
            s.json(
                "/api/resources/read",
                { refs: [{ kind: "docs", id: "big" }] },
                { headers: acceptHeaders(encoding) },
            ),
    },
    {
        label: "GET /api/resources/:kind",
        send: (s, encoding) => s.request("/api/resources/docs", { headers: acceptHeaders(encoding) }),
    },
    {
        label: "GET /api/resources/:kind/:id",
        send: (s, encoding) => s.request("/api/resources/docs/big", { headers: acceptHeaders(encoding) }),
    },
];

function acceptHeaders(encoding: string | undefined): Record<string, string> {
    return encoding === undefined ? {} : { "accept-encoding": encoding };
}

function decode(encoding: string | null, bytes: Buffer): unknown {
    const text =
        encoding === "zstd" ? zlib.zstdDecompressSync(bytes) : encoding === "gzip" ? zlib.gunzipSync(bytes) : bytes;
    return JSON.parse(text.toString("utf8"));
}

describe("pickEncoding", () => {
    it.each([
        [undefined, null],
        ["", null],
        ["gzip, deflate, br, zstd", "zstd"],
        ["gzip, deflate, br", "gzip"],
        ["ZSTD", "zstd"],
        ["br, deflate", null],
        ["identity", null],
        ["zstd;q=0, gzip", "gzip"],
        ["gzip;q=1, zstd;q=0.5", "gzip"],
        ["zstd;q=0.5, gzip;q=0.5", "zstd"],
        ["gzip ; q = 0.8", "gzip"],
        ["gzip;q=0, zstd;q=0, identity;q=0", null],
        ["gzip;q=0, gzip", null],
        ["*", "zstd"],
        ["*;q=1, zstd;q=0", "gzip"],
        ["identity;q=0, *;q=1", "zstd"],
        ["*;q=0", null],
        ["gzip;q=abc", null],
    ])("%j picks %j", (header, expected) => {
        expect(pickEncoding(header)).toBe(expected);
    });
});

describe("resource read compression", () => {
    it.each(reads)("$label answers zstd, gzip, and identity with the same JSON", async ({ send }) => {
        const s = await serverWithLargeDoc();
        const plain = await send(s);
        expect(plain.status).toBe(200);
        expect(plain.headers.get("content-encoding")).toBeNull();
        expect(plain.headers.get("vary")).toContain("Accept-Encoding");
        const expected = await plain.json();

        for (const [header, encoding] of [
            ["gzip, deflate, br, zstd", "zstd"],
            ["gzip, deflate, br", "gzip"],
        ] as const) {
            const res = await send(s, header);
            expect(res.status, header).toBe(200);
            expect(res.headers.get("content-encoding"), header).toBe(encoding);
            expect(res.headers.get("content-type"), header).toBe("application/json");
            expect(res.headers.get("vary"), header).toContain("Accept-Encoding");
            expect(res.headers.get("cache-control"), header).toBe("no-store");
            expect(res.headers.get("ratelimit-limit"), header).not.toBeNull();
            const bytes = Buffer.from(await res.arrayBuffer());
            expect(Number(res.headers.get("content-length")), header).toBe(bytes.byteLength);
            expect(bytes.byteLength, header).toBeLessThan(COMPRESS_MIN_BYTES / 4);
            expect(decode(encoding, bytes), header).toEqual(expected);
        }
    });

    it("sends a body under the threshold uncompressed, still varying on Accept-Encoding", async () => {
        const s = await createResourceTestClient({ resourceKinds: [docs], epochKind: "docs" });
        servers.push(s);
        await s.readEpoch();
        await s.put("docs", "small", { baseRevision: null, data: { text: "short" } });
        const res = await s.request("/api/resources/docs/small", { headers: { "accept-encoding": "zstd, gzip" } });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(res.headers.get("vary")).toContain("Accept-Encoding");
        expect(((await res.json()) as { data: unknown }).data).toEqual({ text: "short" });
    });

    it("leaves error answers as they were", async () => {
        const s = await serverWithLargeDoc();
        const missing = await s.request("/api/resources/docs/absent", { headers: { "accept-encoding": "zstd" } });
        expect(missing.status).toBe(404);
        expect(missing.headers.get("content-encoding")).toBeNull();
        expect(missing.headers.get("vary")).toBeNull();
        expect(await missing.json()).toEqual({ error: "Resource not found", epoch: s.epoch });

        const empty = await s.json("/api/resources/read", { refs: [] }, { headers: { "accept-encoding": "zstd" } });
        expect(empty.status).toBe(400);
        expect(empty.headers.get("content-encoding")).toBeNull();
        expect(empty.headers.get("vary")).toBeNull();
    });
});

describe("compressedJson threshold", () => {
    const app = new Hono();
    app.get("/:units", (c) => compressedJson(c, { text: "한".repeat(Number(c.req.param("units"))) }));

    it("counts UTF-8 bytes, not UTF-16 code units", async () => {
        // `{"text":"…"}` adds 11 bytes; each 한 is 3 UTF-8 bytes and 1 code unit.
        const under = Math.floor((COMPRESS_MIN_BYTES - 11) / 3) - 1;
        const over = Math.ceil((COMPRESS_MIN_BYTES - 11) / 3);
        expect(over).toBeLessThan(COMPRESS_MIN_BYTES);

        const small = await app.request(`/${under}`, { headers: { "accept-encoding": "gzip" } });
        expect(small.headers.get("content-encoding")).toBeNull();

        const large = await app.request(`/${over}`, { headers: { "accept-encoding": "gzip" } });
        expect(large.headers.get("content-encoding")).toBe("gzip");
        expect(decode("gzip", Buffer.from(await large.arrayBuffer()))).toEqual({ text: "한".repeat(over) });
    });
});
