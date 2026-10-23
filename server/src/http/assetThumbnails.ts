import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type sharp from "sharp";
import { decodeFileName, resolveStorageKey } from "../routes/storage.ts";
import { isMissingFileError } from "./recordStream.ts";

/** Bump when the encoder, sizing, format, animation policy, or input caps change. */
export const THUMBNAIL_VERSION = 1;
const MAX_INPUT_BYTES = 32n * 1024n * 1024n;
const MAX_INPUT_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ENTRY_NAME = /^([0-9a-f]{64})-w(256|512)-v([1-9]\d*)-(\d+--?\d+-\d+-\d+)\.(webp|orig)$/;

export class ThumbnailsUnavailable extends Error {}
export class ThumbnailBusy extends Error {}

export type ThumbnailOptions = {
    /** Returns the callable encoder; a failed load is remembered for this service's lifetime. */
    loadSharp?: () => Promise<typeof sharp>;
    /** Concurrent generations (default 2). */
    maxRunning?: number;
    /** Waiting generations (default 32); callers sharing one entry occupy only one place. */
    maxQueued?: number;
};

type ThumbnailRequest = {
    key: string;
    size: 256 | 512;
    source: { handle: FileHandle; stat: BigIntStats };
};
type ThumbnailResult = { kind: "webp"; path: string } | { kind: "original" } | { kind: "missing" };
export type ThumbnailService = ReturnType<typeof createThumbnailService>;

function keyHash(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}

function identity(stat: BigIntStats): string {
    return `${stat.size}-${stat.mtimeNs}-${stat.ino}-${stat.dev}`;
}

async function fileStat(file: string): Promise<BigIntStats | null> {
    try {
        return await fs.lstat(file, { bigint: true });
    } catch (error) {
        if (isMissingFileError(error)) {
            return null;
        }
        throw error;
    }
}

async function directoryEntries(directory: string): Promise<string[]> {
    try {
        return await fs.readdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

function isSupportedRaster(bytes: Buffer): boolean {
    if (
        bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
        (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
        bytes.toString("latin1", 0, 6) === "GIF87a" ||
        bytes.toString("latin1", 0, 6) === "GIF89a" ||
        (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP")
    ) {
        return true;
    }
    if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") {
        return false;
    }
    let boxSize = bytes.readUInt32BE(0);
    let brandOffset = 8;
    if (boxSize === 1) {
        if (bytes.length < 24) {
            return false;
        }
        const extendedSize = bytes.readBigUInt64BE(8);
        if (extendedSize > BigInt(bytes.length)) {
            return false;
        }
        boxSize = Number(extendedSize);
        brandOffset = 16;
    } else if (boxSize === 0) {
        boxSize = bytes.length;
    }
    if (boxSize > bytes.length || boxSize < brandOffset + 8 || (boxSize - brandOffset) % 4 !== 0) {
        return false;
    }
    for (let offset = brandOffset; offset < boxSize; offset += 4) {
        if (offset === brandOffset + 4) {
            continue;
        }
        const brand = bytes.toString("latin1", offset, offset + 4);
        if (brand === "avif" || brand === "avis") {
            return true;
        }
    }
    return false;
}

function isAnimatedPng(bytes: Buffer): boolean {
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return false;
    }
    for (let offset = PNG_SIGNATURE.length; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        if (length > bytes.length - offset - 12) {
            return false;
        }
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        if (type === "acTL") {
            return true;
        }
        if (type === "IDAT" || type === "IEND") {
            return false;
        }
        offset += length + 12;
    }
    return false;
}

/** Reads from position zero without changing the caller's handle position or reopening the path. */
async function sourceBytes({ handle, stat }: ThumbnailRequest["source"]): Promise<Buffer> {
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) {
            throw new Error("Thumbnail source shrank while it was read");
        }
        offset += bytesRead;
    }
    return bytes;
}

/**
 * Lazily caches WebP thumbnails and deterministic original decisions by the supplied source stat.
 * Callers own source handles and keep them open until `get` settles. Cache maintenance shares a
 * per-key lock so an older generation cannot remove a newer generation's entries.
 */
export function createThumbnailService(options: ThumbnailOptions & { savePath: string; assetsPath: string }) {
    const cachePath = path.join(options.savePath, "cache", "thumbnails");
    const tmpPath = path.join(options.savePath, ".tmp");
    const maxRunning = options.maxRunning ?? 2;
    const maxQueued = options.maxQueued ?? 32;
    if (!Number.isSafeInteger(maxRunning) || maxRunning < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
        throw new RangeError("Invalid thumbnail generation limits");
    }
    const loadSharp = options.loadSharp ?? (async () => (await import("sharp")).default);
    let encoder: Promise<typeof sharp> | undefined;
    const flights = new Map<string, Promise<ThumbnailResult>>();
    const locks = new Map<string, Promise<void>>();
    const waiting: Array<() => void> = [];
    let running = 0;

    function getEncoder(): Promise<typeof sharp> {
        encoder ??= Promise.resolve()
            .then(loadSharp)
            .then((loaded) => {
                loaded.concurrency(1);
                loaded.cache(false);
                return loaded;
            })
            .catch((cause: unknown) => {
                throw new ThumbnailsUnavailable("Thumbnail encoder unavailable", { cause });
            });
        return encoder;
    }

    async function acquire(): Promise<void> {
        if (running < maxRunning) {
            running += 1;
            return;
        }
        if (waiting.length >= maxQueued) {
            throw new ThumbnailBusy("Thumbnail generation queue full");
        }
        await new Promise<void>((resolve) => waiting.push(resolve));
    }

    function release(): void {
        const next = waiting.shift();
        if (next) {
            next();
        } else {
            running -= 1;
        }
    }

    async function withKeyLock<T>(hash: string, work: () => Promise<T>): Promise<T> {
        const result = (locks.get(hash) ?? Promise.resolve()).then(work);
        const tail = result.then(
            () => {},
            () => {},
        );
        locks.set(hash, tail);
        try {
            return await result;
        } finally {
            if (locks.get(hash) === tail) {
                locks.delete(hash);
            }
        }
    }

    async function publish(key: string, base: string, bytes: Buffer | null): Promise<ThumbnailResult> {
        const hash = keyHash(key);
        const target = path.join(cachePath, `${base}.${bytes === null ? "orig" : "webp"}`);
        await withKeyLock(hash, async () => {
            // These directories are derived data and must not appear until an entry is published.
            await fs.mkdir(cachePath, { recursive: true });
            await fs.mkdir(tmpPath, { recursive: true });
            const staged = path.join(tmpPath, `${randomUUID()}.tmp`);
            let published = false;
            try {
                await fs.writeFile(staged, bytes ?? Buffer.alloc(0), { flag: "wx", flush: true });
                await fs.rename(staged, target);
                published = true;
                // A replace or removal during encoding may make even the just-published entry stale.
                const sourcePath = resolveStorageKey(options.savePath, key);
                const current = sourcePath === null ? null : await fileStat(sourcePath);
                const currentIdentity = current?.isFile() ? identity(current) : null;
                for (const name of await directoryEntries(cachePath)) {
                    if (
                        name.startsWith(`${hash}-`) &&
                        (!currentIdentity || ENTRY_NAME.exec(name)?.[4] !== currentIdentity)
                    ) {
                        await fs.rm(path.join(cachePath, name), { force: true });
                    }
                }
            } catch (error) {
                await fs.rm(staged, { force: true }).catch(() => {});
                if (published) {
                    await fs.rm(target, { force: true }).catch(() => {});
                }
                throw error;
            }
        });
        return bytes === null ? { kind: "original" } : { kind: "webp", path: target };
    }

    async function generate(request: ThumbnailRequest, base: string): Promise<ThumbnailResult> {
        const { key, size, source } = request;
        if (source.stat.size === 0n || source.stat.size > MAX_INPUT_BYTES) {
            return publish(key, base, null);
        }
        const bytes = await sourceBytes(source);
        // Limit server-side decoding to the raster formats avatars use.
        if (!isSupportedRaster(bytes)) {
            return publish(key, base, null);
        }
        const sharp = await getEncoder();
        let metadata;
        try {
            // Inspect dimensions before applying our cap; sharp's default cap can reject metadata too.
            metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
        } catch (error) {
            if (
                error instanceof Error &&
                (error.message === "Input buffer contains unsupported image format" ||
                    error.message === "Input image exceeds pixel limit")
            ) {
                return publish(key, base, null);
            }
            throw error;
        }
        const { width, height, pages } = metadata;
        if (!width || !height) {
            throw new Error("Thumbnail source has no image dimensions");
        }
        if (
            width * height > MAX_INPUT_PIXELS ||
            (pages ?? 1) > 1 ||
            isAnimatedPng(bytes) ||
            Math.min(width, height) <= size
        ) {
            return publish(key, base, null);
        }
        const webp = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize({ width: size, height: size, fit: "outside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
        return publish(key, base, webp);
    }

    return {
        /** A cache hit needs no encoder or generation slot; concurrent misses share one generation. */
        async get(request: ThumbnailRequest): Promise<ThumbnailResult> {
            if (!request.source.stat.isFile()) {
                return { kind: "missing" };
            }
            const base = `${keyHash(request.key)}-w${request.size}-v${THUMBNAIL_VERSION}-${identity(request.source.stat)}`;
            const existing = flights.get(base);
            if (existing) {
                return existing;
            }
            // Include lookup in the flight so a completed generation cannot race a delayed cache miss.
            const flight = Promise.resolve()
                .then(async (): Promise<ThumbnailResult> => {
                    const webpPath = path.join(cachePath, `${base}.webp`);
                    if ((await fileStat(webpPath))?.isFile()) {
                        return { kind: "webp", path: webpPath };
                    }
                    if ((await fileStat(path.join(cachePath, `${base}.orig`)))?.isFile()) {
                        return { kind: "original" };
                    }
                    await acquire();
                    try {
                        return await generate(request, base);
                    } finally {
                        release();
                    }
                })
                .finally(() => flights.delete(base));
            flights.set(base, flight);
            return flight;
        },
        /** Removes every size and version of a key, serialized with publication and sweeping. */
        async removeKey(key: string): Promise<void> {
            const hash = keyHash(key);
            await withKeyLock(hash, async () => {
                for (const name of await directoryEntries(cachePath)) {
                    if (name.startsWith(`${hash}-`)) {
                        await fs.rm(path.join(cachePath, name), { force: true });
                    }
                }
            });
        },
        /** Drops stale entries after listen, leaving files created during this sweep for the next run. */
        async sweep(signal: AbortSignal): Promise<void> {
            const started = BigInt(Date.now()) * 1_000_000n;
            const sources = new Map<string, string>();
            if (signal.aborted) {
                return;
            }
            for (const name of await directoryEntries(options.assetsPath)) {
                if (signal.aborted) {
                    return;
                }
                const decoded = decodeFileName(name);
                if (decoded === null) {
                    continue;
                }
                const stat = await fileStat(path.join(options.assetsPath, name));
                if (stat?.isFile()) {
                    sources.set(keyHash(`assets/${decoded}`), identity(stat));
                }
            }
            for (const name of await directoryEntries(cachePath)) {
                if (signal.aborted) {
                    return;
                }
                const parsed = ENTRY_NAME.exec(name);
                const hash = /^([0-9a-f]{64})-/.exec(name)?.[1] ?? name;
                await withKeyLock(hash, async () => {
                    if (signal.aborted) {
                        return;
                    }
                    const file = path.join(cachePath, name);
                    const stat = await fileStat(file);
                    if (!stat || stat.mtimeNs >= started || signal.aborted) {
                        return;
                    }
                    if (
                        !stat.isFile() ||
                        !parsed ||
                        parsed[3] !== String(THUMBNAIL_VERSION) ||
                        sources.get(parsed[1]) !== parsed[4]
                    ) {
                        await fs.rm(file, { force: true });
                    }
                });
            }
        },
    };
}
