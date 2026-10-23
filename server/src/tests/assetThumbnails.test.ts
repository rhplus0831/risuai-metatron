// @vitest-environment node
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerContext } from "../app.ts";
import { THUMBNAIL_VERSION, type ThumbnailOptions } from "../http/assetThumbnails.ts";
import { assetVerification } from "../http/assetVerification.ts";
import { resolveStorageKey } from "../routes/storage.ts";
import { createSigner, hex, json, TEST_INDEX_HTML } from "./testSupport.ts";

const immutable = "private, max-age=31536000, immutable";
const revalidate = "private, no-cache";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const assetUrl = (key: string) => `/api/asset/${hex(key)}`;
const variantUrl = (key: string, size = 256) => `${assetUrl(key)}?w=${size}`;
const identity = (stat: BigIntStats) => `${stat.size}-${stat.mtimeNs}-${stat.ino}-${stat.dev}`;
const weakTag = (stat: BigIntStats, size = 256) => `W/"${identity(stat)}-w${size}-v${THUMBNAIL_VERSION}"`;
const strongTag = (bytes: Buffer, size = 256) => `"sha256-${digest(bytes)}-w${size}-v${THUMBNAIL_VERSION}"`;
const entryName = (key: string, stat: BigIntStats, size = 256, extension = "webp", version = THUMBNAIL_VERSION) =>
    `${digest(key)}-w${size}-v${version}-${identity(stat)}.${extension}`;
const roots = new Set<string>();
const contexts: ReturnType<typeof createServerContext>[] = [];

beforeEach(() => {
    // Keep JWT validity, rate limits, and the sweep cutoff independent of machine load.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
    await assetVerification.idle();
    vi.restoreAllMocks();
    for (const context of contexts.splice(0)) await context.dispose();
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    roots.clear();
    vi.useRealTimers();
});

async function server(thumbnailOptions: ThumbnailOptions = {}, existingRoot?: string) {
    const rootDir = existingRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), "risu-thumbnails-")));
    roots.add(rootDir);
    const savePath = path.join(rootDir, "save");
    if (!existingRoot) {
        await fs.mkdir(path.join(rootDir, "dist"));
        await fs.writeFile(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
        await fs.mkdir(path.join(savePath, "server"), { recursive: true });
        await fs.writeFile(path.join(savePath, "server", "password"), "pw");
    }
    const context = createServerContext({ rootDir, thumbnailOptions });
    contexts.push(context);
    const signer = await createSigner();
    const login = await context.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
    expect(login.status).toBe(200);
    await login.arrayBuffer();
    const request = async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("risu-auth", await signer.jwt());
        return context.app.request(url, { ...init, headers });
    };
    return {
        rootDir,
        savePath,
        context,
        signer,
        request,
        cachePath: path.join(savePath, "cache", "thumbnails"),
        assetPath: (key: string) => resolveStorageKey(savePath, key)!,
        read: (key: string, init: RequestInit = {}, size = 256) => request(variantUrl(key, size), init),
        async write(key: string, bytes: Buffer) {
            const response = await request("/api/write", {
                method: "POST",
                headers: { "file-path": hex(key) },
                body: new Uint8Array(bytes),
            });
            await response.arrayBuffer();
            expect(response.status).toBe(200);
        },
    };
}
type Server = Awaited<ReturnType<typeof server>>;
async function restart(s: Server, options: ThumbnailOptions) {
    await assetVerification.idle();
    await s.context.dispose();
    return server(options, s.rootDir);
}
async function list(directory: string) {
    return fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
}
/** Entry names across key directories, which never hold another key's entry or stay empty. */
async function entries(s: Server) {
    const names: string[] = [];
    for (const top of await list(s.cachePath)) {
        if (!top.isDirectory()) {
            // Never equal to an entry name, so a file outside its key directory fails any expectation.
            names.push(`top-level file ${top.name}`);
            continue;
        }
        const children = await list(path.join(s.cachePath, top.name));
        expect(children.map((child) => child.name)).not.toEqual([]);
        for (const child of children) {
            expect(child.name.startsWith(`${top.name}-`)).toBe(true);
            names.push(child.name);
        }
    }
    return names.sort();
}
/** An entry lives in the directory named by its key hash, the entry name's prefix. */
const cacheFile = (s: Server, name: string) => path.join(s.cachePath, name.slice(0, 64), name);
const sourceStat = (s: Server, key: string) => fs.stat(s.assetPath(key), { bigint: true });
const png = (width = 1024, height = 1536, background = { r: 240, g: 20, b: 40, alpha: 0.5 }) =>
    sharp({ create: { width, height, channels: 4, background } })
        .png()
        .toBuffer();
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

/** The native encoder is the I/O seam: gate or fail its output while keeping real decoding. */
function encoder(beforeEncode: () => Promise<void> = async () => {}) {
    const encode = vi.fn(beforeEncode);
    const factory = new Proxy(sharp, {
        apply(target, thisArg, args) {
            const pipeline = Reflect.apply(target, thisArg, args) as sharp.Sharp;
            const toBuffer = pipeline.toBuffer.bind(pipeline);
            // This service uses the promise/no-arguments overload; the rest of sharp stays real.
            pipeline.toBuffer = (async () => {
                await encode();
                return toBuffer();
            }) as sharp.Sharp["toBuffer"];
            return pipeline;
        },
    });
    return { loadSharp: vi.fn(async () => factory), encode };
}
function security(response: Response) {
    expect(response.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-disposition")).toBe("inline");
}
async function redirect(response: Response, key: string, reason = "original", cache = revalidate) {
    await response.arrayBuffer();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(assetUrl(key));
    expect(response.headers.get("x-risu-thumbnail")).toBe(reason);
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(cache);
    security(response);
}

function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}
/** Two complete PNG frames, with APNG control chunks before the first IDAT. */
async function apng() {
    const frames = await Promise.all([png(), png(1024, 1536, { r: 20, g: 30, b: 240, alpha: 0.5 })]);
    const idats = frames.map((frame) => {
        const data: Buffer[] = [];
        for (let offset = 8; offset < frame.length;) {
            const length = frame.readUInt32BE(offset);
            if (frame.toString("ascii", offset + 4, offset + 8) === "IDAT") {
                data.push(frame.subarray(offset + 8, offset + 8 + length));
            }
            offset += length + 12;
        }
        return Buffer.concat(data);
    });
    const animation = Buffer.alloc(8);
    animation.writeUInt32BE(2);
    const frameControl = (sequence: number) => {
        const control = Buffer.alloc(26);
        control.writeUInt32BE(sequence, 0);
        control.writeUInt32BE(1024, 4);
        control.writeUInt32BE(1536, 8);
        control.writeUInt16BE(1, 20);
        control.writeUInt16BE(10, 22);
        return chunk("fcTL", control);
    };
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32BE(2);
    return Buffer.concat([
        frames[0].subarray(0, 33),
        chunk("acTL", animation),
        frameControl(0),
        chunk("IDAT", idats[0]),
        frameControl(1),
        chunk("fdAT", Buffer.concat([sequence, idats[1]])),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
async function animated(format: "gif" | "webp") {
    const red = Buffer.alloc(1024 * 1536 * 3);
    const blue = Buffer.alloc(red.length);
    for (let offset = 0; offset < red.length; offset += 3) {
        red[offset] = 255;
        blue[offset + 2] = 255;
    }
    const frames = sharp(Buffer.concat([red, blue]), {
        raw: { width: 1024, height: 3072, channels: 3, pageHeight: 1536 },
    });
    return frames[format]({ loop: 0, delay: [100, 100] }).toBuffer();
}

describe("asset thumbnails", () => {
    it("refuses missing and rejected JWTs before accessing stored files", async () => {
        const loader = vi.fn(async () => sharp);
        const s = await server({ loadSharp: loader });
        const key = "assets/private.png";
        await s.write(key, await png());
        const tokens = [undefined, "pw", await s.signer.jwt({ breakSignature: true }), await s.signer.jwt({ exp: 1 })];
        const accesses = [
            vi.spyOn(fs, "open"),
            vi.spyOn(fs, "stat"),
            vi.spyOn(fs, "lstat"),
            vi.spyOn(fs, "readFile"),
            vi.spyOn(fs, "readdir"),
        ];
        for (const method of ["GET", "HEAD"]) {
            for (const token of tokens) {
                const response = await s.context.app.request(variantUrl(key), {
                    method,
                    headers: token === undefined ? {} : { "risu-auth": token },
                });
                await response.arrayBuffer();
                expect(response.status).toBe(401);
                expect(response.headers.get("cache-control")).toBe("no-store");
            }
        }
        // Static serving may stat `dist/` first; nothing under `save/` is touched before the JWT check.
        for (const access of accesses) {
            expect(access.mock.calls.filter(([file]) => String(file).startsWith(s.savePath))).toEqual([]);
        }
        expect(loader).not.toHaveBeenCalled();
        expect(await entries(s)).toEqual([]);
    });

    it("caches alpha-preserving WebP variants at both short-side sizes and leaves the original unchanged", async () => {
        let s = await server();
        const bytes = await png();
        const key = "assets/portrait.png";
        await s.write(key, bytes);
        const stat = await sourceStat(s, key);
        const cached = new Map<number, Buffer>();
        for (const size of [256, 512]) {
            const response = await s.read(key, {}, size);
            const body = Buffer.from(await response.arrayBuffer());
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("image/webp");
            expect(response.headers.get("content-length")).toBe(String(body.length));
            security(response);
            expect(await sharp(body).metadata()).toMatchObject({
                format: "webp",
                width: size,
                height: size * 1.5,
                hasAlpha: true,
            });
            const { data, info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
            expect(info.channels).toBe(4);
            expect(data[3]).toBeGreaterThan(0);
            expect(data[3]).toBeLessThan(255);
            expect(await fs.readFile(cacheFile(s, entryName(key, stat, size)))).toEqual(body);
            cached.set(size, body);
        }
        expect(await entries(s)).toEqual([entryName(key, stat, 256), entryName(key, stat, 512)].sort());
        const original = await s.request(assetUrl(key));
        expect(original.status).toBe(200);
        expect(original.headers.get("content-type")).toBe("image/png");
        expect(original.headers.get("etag")).toBe(`W/"${stat.size}-${stat.mtimeNs}-${stat.ino}"`);
        expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
        const loader = vi.fn(async () => {
            throw new Error("disk hit must not load sharp");
        });
        s = await restart(s, { loadSharp: loader });
        for (const size of [256, 512]) {
            const response = await s.read(key, {}, size);
            expect(response.status).toBe(200);
            expect(Buffer.from(await response.arrayBuffer())).toEqual(cached.get(size));
        }
        expect(loader).not.toHaveBeenCalled();
    });

    it("persists original decisions for small, animated, non-image, and non-raster inputs without decoding again", async () => {
        const animation = await apng();
        expect((await sharp(animation, { animated: true }).metadata()).pages).toBeUndefined();
        const gif = await animated("gif");
        const webp = await animated("webp");
        for (const bytes of [gif, webp])
            expect((await sharp(bytes, { animated: true, pages: -1 }).metadata()).pages).toBe(2);
        const cases = [
            ["small.png", await png(200, 300)],
            ["boundary.png", await png(256, 384)],
            ["animated.gif", gif],
            ["animated.webp", webp],
            ["animated.png", animation],
            ["not-image.png", Buffer.from("This is plain text, despite the extension.")],
            [
                "vector.svg",
                Buffer.from(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><rect width="1024" height="1536" fill="red"/></svg>',
                ),
            ],
        ] as const;
        const loader = vi.fn(async () => sharp);
        let s = await server({ loadSharp: loader });
        const markers: string[] = [];
        for (const [name, bytes] of cases) {
            const key = `assets/${name}`;
            await s.write(key, bytes);
            await redirect(await s.read(key), key);
            const marker = entryName(key, await sourceStat(s, key), 256, "orig");
            expect((await fs.readFile(cacheFile(s, marker))).length).toBe(0);
            markers.push(marker);
        }
        expect(loader).toHaveBeenCalledTimes(1);
        expect(await entries(s)).toEqual(markers.sort());
        const coldLoader = vi.fn(async () => {
            throw new Error("marker hit must not load sharp");
        });
        s = await restart(s, { loadSharp: coldLoader });
        for (const [name] of cases) await redirect(await s.read(`assets/${name}`), `assets/${name}`);
        expect(coldLoader).not.toHaveBeenCalled();
    });

    it("marks inputs above the byte and pixel caps as originals", async () => {
        const observed = encoder();
        let s = await server({ loadSharp: observed.loadSharp });
        const byteKey = "assets/too-many-bytes.png";
        await s.write(byteKey, await png());
        await fs.truncate(s.assetPath(byteKey), 32 * 1024 * 1024 + 1);
        await redirect(await s.read(byteKey), byteKey);
        expect(observed.loadSharp).not.toHaveBeenCalled();
        const pixelKey = "assets/too-many-pixels.png";
        await s.write(pixelKey, await png(8000, 5001));
        await redirect(await s.read(pixelKey), pixelKey);
        expect(observed.encode).not.toHaveBeenCalled();
        for (const key of [byteKey, pixelKey]) {
            expect(await fs.readFile(cacheFile(s, entryName(key, await sourceStat(s, key), 256, "orig")))).toEqual(
                Buffer.alloc(0),
            );
        }
        const loader = vi.fn(async () => {
            throw new Error("caps are cached");
        });
        s = await restart(s, { loadSharp: loader });
        for (const key of [byteKey, pixelKey]) await redirect(await s.read(key), key);
        expect(loader).not.toHaveBeenCalled();
    });

    it("uses verified or full-stat variant validators without matching originals, other sizes, or other versions", async () => {
        const s = await server();
        const bytes = await png();
        for (const [key, verified] of [
            [`assets/${digest(bytes)}.png`, true],
            [`assets/${digest("different bytes")}.png`, false],
        ] as const) {
            await s.write(key, bytes);
            const stat = await sourceStat(s, key);
            for (const size of [256, 512]) {
                const expected = verified ? strongTag(bytes, size) : weakTag(stat, size);
                const original = verified
                    ? `"sha256-${digest(bytes)}"`
                    : `W/"${stat.size}-${stat.mtimeNs}-${stat.ino}"`;
                const otherSize = verified
                    ? strongTag(bytes, size === 256 ? 512 : 256)
                    : weakTag(stat, size === 256 ? 512 : 256);
                for (const candidate of [
                    undefined,
                    original,
                    otherSize,
                    expected.replace(`-v${THUMBNAIL_VERSION}"`, `-v${THUMBNAIL_VERSION + 1}"`),
                ]) {
                    const response = await s.read(
                        key,
                        { headers: candidate ? { "If-None-Match": candidate } : {} },
                        size,
                    );
                    await response.arrayBuffer();
                    expect(response.status).toBe(200);
                    expect(response.headers.get("etag")).toBe(expected);
                    expect(response.headers.get("cache-control")).toBe(verified ? immutable : revalidate);
                }
            }
        }
    });

    it("shortcuts exact variant matches without loading or encoding and upgrades a weak tag to immutable", async () => {
        const observed = encoder();
        let s = await server({ loadSharp: observed.loadSharp });
        const bytes = await png();
        const key = `assets/${digest(bytes)}.png`;
        await fs.mkdir(path.dirname(s.assetPath(key)), { recursive: true });
        await fs.writeFile(s.assetPath(key), bytes);
        const stat = await sourceStat(s, key);
        const weak = weakTag(stat);
        const first = await s.read(key);
        await first.arrayBuffer();
        expect(first.status).toBe(200);
        expect(first.headers.get("etag")).toBe(weak);
        expect(first.headers.get("cache-control")).toBe(revalidate);
        await assetVerification.idle();
        const encodeCount = observed.encode.mock.calls.length;
        for (const tag of [weak, strongTag(bytes)]) {
            const response = await s.read(key, { headers: { "If-None-Match": tag } });
            expect(response.status).toBe(304);
            expect(response.headers.get("etag")).toBe(tag);
            expect(response.headers.get("cache-control")).toBe(immutable);
            expect(await response.text()).toBe("");
        }
        expect(observed.encode).toHaveBeenCalledTimes(encodeCount);
        // Remove derived files and restart: a disk hit or a memoized loader cannot disguise generation.
        await fs.rm(s.cachePath, { recursive: true });
        const cold = encoder(async () => {
            throw new Error("conditional hit must not encode");
        });
        s = await restart(s, { loadSharp: cold.loadSharp });
        const customKey = "assets/unverified.png";
        await s.write(customKey, bytes);
        const customWeak = weakTag(await sourceStat(s, customKey));
        const unverified = await s.read(customKey, { headers: { "If-None-Match": customWeak } });
        expect(unverified.status).toBe(304);
        expect(unverified.headers.get("etag")).toBe(customWeak);
        expect(unverified.headers.get("cache-control")).toBe(revalidate);
        expect(await unverified.text()).toBe("");
        await assetVerification.idle();
        for (const method of ["GET", "HEAD"]) {
            for (const tag of [weak, strongTag(bytes)]) {
                const response = await s.read(key, {
                    method,
                    headers: { "If-None-Match": tag, Range: "bytes=999999-" },
                });
                expect(response.status).toBe(304);
                expect(response.headers.get("etag")).toBe(tag);
                expect(response.headers.get("cache-control")).toBe(immutable);
                expect(await response.text()).toBe("");
                security(response);
            }
        }
        expect(cold.loadSharp).not.toHaveBeenCalled();
        expect(cold.encode).not.toHaveBeenCalled();
        expect(await entries(s)).toEqual([]);
    });

    it("evaluates wildcard preconditions after deciding between WebP and an original redirect", async () => {
        const s = await server();
        const small = await png(200, 300);
        for (const key of ["assets/small.png", `assets/${digest(small)}.png`]) {
            await s.write(key, small);
            for (let request = 0; request < 2; request++) {
                await redirect(
                    await s.read(key, { headers: { "If-None-Match": "*" } }),
                    key,
                    "original",
                    key.includes(digest(small)) ? immutable : revalidate,
                );
            }
            expect(
                (await fs.readFile(cacheFile(s, entryName(key, await sourceStat(s, key), 256, "orig")))).length,
            ).toBe(0);
        }
        const key = "assets/large.png";
        await s.write(key, await png());
        const response = await s.read(key, { headers: { "If-None-Match": "*" } });
        expect(response.status).toBe(304);
        expect(response.headers.get("etag")).toBe(weakTag(await sourceStat(s, key)));
        expect(await response.text()).toBe("");
        expect(await fs.stat(cacheFile(s, entryName(key, await sourceStat(s, key))))).toMatchObject({
            size: expect.any(Number),
        });
    });

    it("serves ranges and bodyless HEAD using the thumbnail file length", async () => {
        const s = await server();
        const key = "assets/ranges.png";
        const bytes = await png();
        await s.write(key, bytes);
        // A cold HEAD must generate too, but never send the image body.
        const head = await s.read(key, { method: "HEAD", headers: { Range: "bytes=1-3" } });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect(head.headers.get("content-type")).toBe("image/webp");
        const body = Buffer.from(await (await s.read(key)).arrayBuffer());
        expect(body.length).not.toBe(bytes.length);
        expect(head.headers.get("content-length")).toBe(String(body.length));
        expect(head.headers.get("content-range")).toBeNull();
        const range = await s.read(key, { headers: { Range: "bytes=2-8" } });
        expect(range.status).toBe(206);
        expect(range.headers.get("content-range")).toBe(`bytes 2-8/${body.length}`);
        expect(range.headers.get("content-length")).toBe("7");
        expect(range.headers.get("content-type")).toBe("image/webp");
        expect(Buffer.from(await range.arrayBuffer())).toEqual(body.subarray(2, 9));
        security(range);
        const unsatisfiable = await s.read(key, { headers: { Range: `bytes=${body.length}-` } });
        await unsatisfiable.arrayBuffer();
        expect(unsatisfiable.status).toBe(416);
        expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${body.length}`);
        expect(unsatisfiable.headers.get("cache-control")).toBe("no-store");
    });

    it("rejects invalid, empty, or repeated widths and reports missing sources", async () => {
        const loader = vi.fn(async () => sharp);
        const s = await server({ loadSharp: loader });
        const key = "assets/width.png";
        await s.write(key, await png());
        for (const query of ["w=128", "w=abc", "w=0256", "w=256.0", "w=", "w", "w=256&w=256", "w=256&w=512"]) {
            const response = await s.request(`${assetUrl(key)}?${query}`);
            await response.arrayBuffer();
            expect(response.status, query).toBe(400);
            expect(response.headers.get("cache-control"), query).toBe("no-store");
        }
        const missing = await s.read("assets/missing.png");
        await missing.arrayBuffer();
        expect(missing.status).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("no-store");
        expect(loader).not.toHaveBeenCalled();
        expect(await entries(s)).toEqual([]);
    });

    it("redirects a full generation queue without caching the busy decision", async () => {
        const entered = deferred();
        const release = deferred();
        const observed = encoder(async () => {
            entered.resolve();
            await release.promise;
        });
        const s = await server({ loadSharp: observed.loadSharp, maxRunning: 1, maxQueued: 0 });
        await s.write("assets/running.png", await png());
        await s.write("assets/waiting.png", await png());
        const running = s.read("assets/running.png");
        try {
            await entered.promise;
            await redirect(await s.read("assets/waiting.png"), "assets/waiting.png", "busy", "no-store");
            expect(await entries(s)).toEqual([]);
        } finally {
            release.resolve();
            await (await running).arrayBuffer();
        }
        const retry = await s.read("assets/waiting.png");
        await retry.arrayBuffer();
        expect(retry.status).toBe(200);
    });

    it("redirects an unavailable encoder without writing an original marker", async () => {
        const loadSharp = vi.fn(async () => {
            throw new Error("native module unavailable");
        });
        const s = await server({ loadSharp });
        const bytes = await png();
        const key = `assets/${digest(bytes)}.png`;
        await s.write(key, bytes);
        for (let request = 0; request < 2; request++) await redirect(await s.read(key), key, "unavailable", "no-store");
        expect(loadSharp).toHaveBeenCalled();
        expect(await entries(s)).toEqual([]);
    });

    it("logs unexpected encoder and I/O failures and redirects without caching them", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const observed = encoder(async () => {
            throw new Error("encoder out of memory");
        });
        const s = await server({ loadSharp: observed.loadSharp });
        const bytes = await png();
        const key = `assets/${digest(bytes)}.png`;
        await s.write(key, bytes);
        await redirect(await s.read(key), key, "error", "no-store");
        expect(observed.encode).toHaveBeenCalledTimes(1);
        expect(error.mock.calls.flat().join("\n")).toContain("encoder out of memory");
        expect(await entries(s)).toEqual([]);
        observed.encode.mockResolvedValue(undefined);
        const open = fs.open.bind(fs);
        const failure = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            if (args[0] === s.assetPath(key)) throw Object.assign(new Error("source I/O failed"), { code: "EIO" });
            return open(...args);
        });
        await redirect(await s.read(key), key, "error", "no-store");
        failure.mockRestore();
        expect(error.mock.calls.flat().join("\n")).toContain("source I/O failed");
        expect(await entries(s)).toEqual([]);
        const retry = await s.read(key);
        await retry.arrayBuffer();
        expect(retry.status).toBe(200);
    });

    it("coalesces concurrent requests for one entry into one deferred encoding", async () => {
        const entered = deferred();
        const release = deferred();
        const secondStatted = deferred();
        const observed = encoder(async () => {
            entered.resolve();
            await release.promise;
        });
        const s = await server({ loadSharp: observed.loadSharp, maxRunning: 1, maxQueued: 0 });
        const key = "assets/shared.png";
        await s.write(key, await png());
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
            // Both requests see a miss even if a broken implementation delays its lookup until
            // after publication. A late disk hit must not conceal the lack of single flight.
            if (String(args[0]).startsWith(s.cachePath + path.sep)) {
                throw Object.assign(new Error("uncached thumbnail"), { code: "ENOENT" });
            }
            return lstat(...args);
        });
        const first = s.read(key);
        let second: Promise<Response> | undefined;
        try {
            await entered.promise;
            const open = fs.open.bind(fs);
            vi.spyOn(fs, "open").mockImplementation(async (...args) => {
                const handle = await open(...args);
                if (args[0] === s.assetPath(key)) {
                    handle.stat = new Proxy(handle.stat, {
                        apply(target, thisArg, args) {
                            return Reflect.apply(target, thisArg, args).then((stat: BigIntStats) => {
                                // The route's stat continuation runs before the waiting test resumes.
                                queueMicrotask(secondStatted.resolve);
                                return stat;
                            });
                        },
                    });
                }
                return handle;
            });
            second = s.read(key);
            await secondStatted.promise;
        } finally {
            release.resolve();
        }
        const responses = await Promise.all([first, second!]);
        const bodies = await Promise.all(
            responses.map(async (response) => {
                expect(response.status).toBe(200);
                return Buffer.from(await response.arrayBuffer());
            }),
        );
        expect(bodies[1]).toEqual(bodies[0]);
        expect(observed.encode).toHaveBeenCalledTimes(1);
        expect(await entries(s)).toEqual([entryName(key, await sourceStat(s, key))]);
    });

    it("keeps an in-flight thumbnail bound to the opened source across replacement, including verified names", async () => {
        const oldBytes = await png();
        const newBytes = await png(1200, 1800, { r: 20, g: 30, b: 240, alpha: 1 });
        for (const verified of [false, true]) {
            for (const replaceBeforeRead of [false, true]) {
                const entered = deferred();
                const release = deferred();
                const readEntered = deferred();
                const readRelease = deferred();
                const observed = encoder(async () => {
                    entered.resolve();
                    await release.promise;
                });
                const s = await server({ loadSharp: observed.loadSharp });
                const key = verified ? `assets/${digest(oldBytes)}.png` : "assets/replaced.png";
                await s.write(key, oldBytes);
                const oldTag = verified ? strongTag(oldBytes) : weakTag(await sourceStat(s, key));
                const open = fs.open.bind(fs);
                let intercepted = false;
                const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
                    const handle = await open(...args);
                    if (replaceBeforeRead && !intercepted && args[0] === s.assetPath(key)) {
                        intercepted = true;
                        handle.read = new Proxy(handle.read, {
                            async apply(target, thisArg, args) {
                                // The route has already statted and verified this handle. Replace
                                // its pathname before any source bytes reach the native decoder.
                                readEntered.resolve();
                                await readRelease.promise;
                                return Reflect.apply(target, thisArg, args);
                            },
                        });
                    }
                    return handle;
                });
                const pending = s.read(key);
                try {
                    if (replaceBeforeRead) {
                        await Promise.race([
                            readEntered.promise,
                            entered.promise.then(() => {
                                throw new Error("encoding bypassed the source handle");
                            }),
                        ]);
                        await s.write(key, newBytes);
                        readRelease.resolve();
                        await entered.promise;
                    } else {
                        await entered.promise;
                        await s.write(key, newBytes);
                    }
                } finally {
                    readRelease.resolve();
                    release.resolve();
                    opening.mockRestore();
                }
                const response = await pending;
                if (response.status === 200) {
                    expect(response.headers.get("etag")).toBe(oldTag);
                    const { data } = await sharp(Buffer.from(await response.arrayBuffer()))
                        .raw()
                        .toBuffer({ resolveWithObject: true });
                    expect(data[0]).toBeGreaterThan(data[2]);
                } else {
                    await redirect(response, key, "error", "no-store");
                }
                const current = await s.read(key);
                expect(current.status).toBe(200);
                expect(current.headers.get("etag")).toBe(weakTag(await sourceStat(s, key)));
                expect(current.headers.get("cache-control")).toBe(revalidate);
                const { data } = await sharp(Buffer.from(await current.arrayBuffer()))
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                expect(data[2]).toBeGreaterThan(data[0]);
                expect(await entries(s)).toEqual([entryName(key, await sourceStat(s, key))]);
            }
        }
    });

    it("replaces stale cache entries after overwrites, including equal-size equal-mtime new inodes", async () => {
        const s = await server();
        const key = "assets/overwrite.png";
        const bytes = await png();
        await s.write(key, bytes);
        // Integral seconds can be restored exactly through fs.utimes on every supported filesystem.
        await fs.utimes(s.assetPath(key), 1234, 1234);
        const originalStat = await sourceStat(s, key);
        for (const size of [256, 512]) await (await s.read(key, {}, size)).arrayBuffer();
        expect(await entries(s)).toHaveLength(2);
        // Same key, size, and mtime; only the new inode can distinguish this replacement.
        await s.write(key, bytes);
        await fs.utimes(s.assetPath(key), 1234, 1234);
        const replacementStat = await sourceStat(s, key);
        expect(replacementStat.size).toBe(originalStat.size);
        expect(replacementStat.mtimeNs).toBe(originalStat.mtimeNs);
        expect(replacementStat.ino).not.toBe(originalStat.ino);
        const replacement = await s.read(key, { headers: { "If-None-Match": weakTag(originalStat) } });
        await replacement.arrayBuffer();
        expect(replacement.status).toBe(200);
        expect(replacement.headers.get("etag")).toBe(weakTag(replacementStat));
        expect(await entries(s)).toEqual([entryName(key, replacementStat)]);
        await s.write(key, await png(200, 300));
        await redirect(await s.read(key), key);
        expect(await entries(s)).toEqual([entryName(key, await sourceStat(s, key), 256, "orig")]);
    });

    it("removes every cached size and original marker for a removed asset", async () => {
        const s = await server();
        const key = "assets/remove.png";
        await s.write(key, await png(400, 600));
        await (await s.read(key)).arrayBuffer();
        await redirect(await s.read(key, {}, 512), key);
        const other = "assets/keep.png";
        await s.write(other, await png());
        await (await s.read(other)).arrayBuffer();
        expect(await entries(s)).toHaveLength(3);
        const response = await s.request("/api/remove", { headers: { "file-path": hex(key) } });
        await response.arrayBuffer();
        expect(response.status).toBe(200);
        expect(await entries(s)).toEqual([entryName(other, await sourceStat(s, other))]);
        expect((await s.read(key)).status).toBe(404);
    });

    it("keeps one key's cache maintenance independent of unrelated cached keys", async () => {
        const small = await png(20, 30);
        const portrait = await png(400, 600);
        const measurements = [];
        for (const librarySize of [2, 64]) {
            const s = await server();
            const keep: string[] = [];
            for (let index = 0; index < librarySize; index += 1) {
                const key = `assets/library-${index}.png`;
                await s.write(key, small);
                await redirect(await s.read(key), key);
                keep.push(entryName(key, await sourceStat(s, key), 256, "orig"));
            }
            keep.sort();
            expect(await entries(s)).toEqual(keep);

            async function measure(work: () => Promise<void>) {
                const counts = { calls: 0, entries: 0 };
                const readdir = fs.readdir.bind(fs);
                const reading = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
                    const directory = String(args[0]);
                    const inCache = directory === s.cachePath || directory.startsWith(s.cachePath + path.sep);
                    if (inCache) counts.calls += 1;
                    const names = await readdir(...args);
                    if (inCache) counts.entries += names.length;
                    return names;
                });
                try {
                    await work();
                    return counts;
                } finally {
                    reading.mockRestore();
                }
            }

            const key = "assets/maintained.png";
            await s.write(key, portrait);
            const originalStat = await sourceStat(s, key);
            const publish = await measure(async () => {
                const response = await s.read(key);
                await response.arrayBuffer();
                expect(response.status).toBe(200);
                await redirect(await s.read(key, {}, 512), key);
            });
            // Assertions inspect the whole cache outside the measured operations.
            expect(await entries(s)).toEqual(
                [...keep, entryName(key, originalStat), entryName(key, originalStat, 512, "orig")].sort(),
            );

            await s.write(key, small);
            const replacementStat = await sourceStat(s, key);
            expect(identity(replacementStat)).not.toBe(identity(originalStat));
            const replace = await measure(async () => {
                await redirect(await s.read(key), key);
            });
            expect(await entries(s)).toEqual([...keep, entryName(key, replacementStat, 256, "orig")].sort());

            const handle = await fs.open(s.assetPath(key), "r");
            try {
                const source = { handle, stat: await handle.stat({ bigint: true }) };
                const remove = await measure(async () => {
                    const response = await s.request("/api/remove", { headers: { "file-path": hex(key) } });
                    await response.arrayBuffer();
                    expect(response.status).toBe(200);
                });
                expect(await entries(s)).toEqual(keep);
                await expect(fs.stat(s.assetPath(key))).rejects.toMatchObject({ code: "ENOENT" });

                // An open handle can finish generation after its source pathname was removed.
                const publishAfterRemoval = await measure(async () => {
                    expect(await s.context.thumbnails.get({ key, size: 256, source })).toEqual({ kind: "original" });
                });
                expect(await entries(s)).toEqual(keep);
                measurements.push({ publish, replace, remove, publishAfterRemoval });
            } finally {
                await handle.close();
            }
        }
        expect(measurements[1]).toEqual(measurements[0]);
    });

    it("sweeps the flat cache layout and unknown top-level directories while keeping current key entries", async () => {
        const s = await server();
        const key = "assets/current.png";
        await s.write(key, await png(400, 600));
        const stat = await sourceStat(s, key);
        const response = await s.read(key);
        await response.arrayBuffer();
        expect(response.status).toBe(200);
        await redirect(await s.read(key, {}, 512), key);
        const keep = [entryName(key, stat), entryName(key, stat, 512, "orig")].sort();
        expect(await entries(s)).toEqual(keep);

        const flat = [entryName(key, stat, 256, "webp", 1), entryName(key, stat, 512, "orig", 1)];
        for (const name of flat) {
            const file = path.join(s.cachePath, name);
            await fs.writeFile(file, "obsolete");
            await fs.utimes(file, 1, 1);
        }
        const unknown = path.join(s.cachePath, "unknown-layout");
        await fs.mkdir(path.join(unknown, "nested"), { recursive: true });
        await fs.writeFile(path.join(unknown, "nested", "entry"), "obsolete");
        await fs.utimes(unknown, 1, 1);
        const empty = path.join(s.cachePath, digest("assets/empty.png"));
        await fs.mkdir(empty);
        await fs.utimes(empty, 1, 1);
        for (const name of keep) await fs.utimes(cacheFile(s, name), 1, 1);

        await s.context.thumbnails.sweep(new AbortController().signal);
        expect(await entries(s)).toEqual(keep);
    });

    it("leaves cache paths at or after the sweep cutoff until a later sweep", async () => {
        const s = await server();
        const started = Date.now();
        const files: string[] = [];
        for (const offset of [0, 1]) {
            const key = `assets/recent-${offset}.png`;
            await s.write(key, await png(20, 30));
            const name = entryName(key, await sourceStat(s, key), 256, "orig", 1);
            const unknown = path.join(s.cachePath, `unknown-${offset}`);
            const recent = [path.join(s.cachePath, name), path.join(unknown, "entry"), cacheFile(s, name)];
            const mtime = started / 1000 + offset;
            for (const file of recent) {
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, "recent");
                await fs.utimes(file, mtime, mtime);
                files.push(file);
            }
            await fs.utimes(unknown, mtime, mtime);
            await fs.utimes(path.dirname(cacheFile(s, name)), 1, 1);
        }

        await s.context.thumbnails.sweep(new AbortController().signal);
        for (const file of files) expect(await fs.readFile(file, "utf8")).toBe("recent");

        vi.setSystemTime(started + 2000);
        await s.context.thumbnails.sweep(new AbortController().signal);
        expect(await entries(s)).toEqual([]);
    });

    it("bypasses other-version WebP and original entries and sweeps stale identities while retaining current entries", async () => {
        const s = await server();
        const key = "assets/versioned.png";
        await s.write(key, await png());
        const stat = await sourceStat(s, key);
        const oldWebp = entryName(key, stat, 256, "webp", THUMBNAIL_VERSION + 1);
        const oldMarker = entryName(key, stat, 512, "orig", THUMBNAIL_VERSION + 1);
        await fs.mkdir(path.dirname(cacheFile(s, oldWebp)), { recursive: true });
        await fs.writeFile(
            cacheFile(s, oldWebp),
            await sharp(await png(20, 30))
                .webp()
                .toBuffer(),
        );
        await fs.writeFile(cacheFile(s, oldMarker), "");
        for (const size of [256, 512]) {
            const response = await s.read(key, {}, size);
            expect(response.status).toBe(200);
            expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({
                width: size,
                height: size * 1.5,
            });
        }
        const small = "assets/current-original.png";
        await s.write(small, await png(200, 300));
        await redirect(await s.read(small), small);
        const keep = [
            entryName(key, stat),
            entryName(key, stat, 512),
            entryName(small, await sourceStat(s, small), 256, "orig"),
        ].sort();
        const stale = [
            entryName(key, { ...stat, size: stat.size + 1n }),
            entryName(key, { ...stat, mtimeNs: stat.mtimeNs + 1n }, 256, "orig"),
            entryName(key, { ...stat, ino: stat.ino + 1n }),
            entryName(key, { ...stat, dev: stat.dev + 1n }, 512, "orig"),
            entryName("assets/deleted.png", stat),
            entryName("assets/deleted-marker.png", stat, 256, "orig"),
        ];
        for (const name of stale) {
            await fs.mkdir(path.dirname(cacheFile(s, name)), { recursive: true });
            await fs.writeFile(cacheFile(s, name), "");
        }
        // Explicit old mtimes make the sweep's 'created during sweep' guard deterministic.
        for (const name of await entries(s)) await fs.utimes(cacheFile(s, name), 1, 1);
        await s.context.thumbnails.sweep(new AbortController().signal);
        expect(await entries(s)).toEqual(keep);
    });
});
