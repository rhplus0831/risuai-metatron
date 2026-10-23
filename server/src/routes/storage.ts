import { createHash, type Hash, randomUUID } from "node:crypto";
import { type BigIntStats, type Dirent, mkdirSync, rmSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createStreamBody } from "@hono/node-server/utils/stream";
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
    ASSET_BATCH_READ_PATH,
    ASSET_BATCH_WRITE_PATH,
    AssetBatchFormatError,
    type AssetRecordEvent,
    AssetRecordParser,
    MAX_ASSET_BATCH_NAME_BYTES,
    MAX_ASSET_BATCH_RECORDS,
} from "../../../shared/assetBatch.ts";
import { assetExtension, assetMimeType, isActiveAssetExtension } from "../../../shared/assetMime.ts";
import { mkdirDurable, syncDir } from "../data/durableWrite.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import { assetVerification, contentNameHash } from "../http/assetVerification.ts";
import {
    THUMBNAIL_VERSION,
    ThumbnailBusy,
    ThumbnailsUnavailable,
    type ThumbnailService,
} from "../http/assetThumbnails.ts";
import { readJsonBody } from "../http/body.ts";
import { isMissingFileError, iteratorStream, STORAGE_READ_FLAGS, storedFileRecord } from "../http/recordStream.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

/**
 * Folders under `save/` that hold user files. A logical key `<namespace>/<name>` is stored at
 * `save/<namespace>/<encodeFileName(name)>`; keys in any other namespace have no storage location.
 * Only `assets` remains: the database lives in the resource store (`save/data/`), and the
 * `save/database` and `save/remotes` folders of older versions are no longer read.
 */
export const STORAGE_NAMESPACES = ["assets"] as const;

/** Staging folder for atomic writes. It is not a namespace, so the API cannot reach it. */
const TMP_DIR = ".tmp";
const MAX_FILE_NAME_BYTES = 255;
/** Prefix of the hex fallback file name. A literal `~` in a readable name is always `%7E`. */
const HEX_FALLBACK_PREFIX = "~";
const hexHeaderRegex = /^(?:[0-9a-fA-F]{2})+$/;
const readableByteRegex = /^[a-z0-9._-]$/;
const windowsReservedStem = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Decodes bytes as UTF-8, or null when they are not valid UTF-8 (no replacement characters). */
function decodeUtf8Strict(bytes: Buffer): string | null {
    const text = bytes.toString("utf-8");
    return Buffer.from(text, "utf-8").equals(bytes) ? text : null;
}

/**
 * Decodes a `file-path` header segment (the hex UTF-8 bytes of a logical key). Returns null when the
 * segment is not well-formed hex or not valid UTF-8.
 */
export function decodeKeyHeader(header: string): string | null {
    if (!hexHeaderRegex.test(header)) {
        return null;
    }
    return decodeUtf8Strict(Buffer.from(header, "hex"));
}

function percentEncodeByte(byte: number): string {
    return "%" + byte.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Maps a logical name to one path component, reversibly and without collisions on case-insensitive
 * filesystems. Lowercase ASCII letters, digits, `.`, `_` and `-` stay readable. Every other UTF-8 byte,
 * including uppercase letters, `/`, `\` and `%`, becomes `%XX`. A trailing dot and the first character
 * of a Windows device name (`con.png`) are escaped too, so `.` and `..` can never be produced. When
 * the readable form is longer than 255 bytes, the name is stored as `~` plus its lowercase hex bytes.
 * Returns null for an empty name or one that fits neither form.
 */
export function encodeFileName(name: string): string | null {
    if (name === "") {
        return null;
    }
    const bytes = Buffer.from(name, "utf-8");
    let readable = "";
    for (const byte of bytes) {
        const char = String.fromCharCode(byte);
        readable += readableByteRegex.test(char) ? char : percentEncodeByte(byte);
    }
    if (readable.endsWith(".")) {
        readable = readable.slice(0, -1) + percentEncodeByte(0x2e);
    }
    if (windowsReservedStem.test(readable.split(".")[0])) {
        readable = percentEncodeByte(readable.charCodeAt(0)) + readable.slice(1);
    }
    if (readable.length <= MAX_FILE_NAME_BYTES) {
        return readable;
    }
    const fallback = HEX_FALLBACK_PREFIX + bytes.toString("hex");
    return fallback.length <= MAX_FILE_NAME_BYTES ? fallback : null;
}

/** Inverse of `encodeFileName`. Returns null for any file name that `encodeFileName` would not produce. */
export function decodeFileName(fileName: string): string | null {
    let name: string | null;
    if (fileName.startsWith(HEX_FALLBACK_PREFIX)) {
        const hex = fileName.slice(HEX_FALLBACK_PREFIX.length);
        name = hexHeaderRegex.test(hex) ? decodeUtf8Strict(Buffer.from(hex, "hex")) : null;
    } else {
        try {
            name = decodeURIComponent(fileName);
        } catch {
            name = null;
        }
    }
    return name !== null && encodeFileName(name) === fileName ? name : null;
}

/** Splits a logical key into its namespace and the file name, or null when it has no storage location. */
function splitStorageKey(key: string): { namespace: string; fileName: string } | null {
    const slash = key.indexOf("/");
    if (slash <= 0) {
        return null;
    }
    const namespace = key.slice(0, slash);
    if (!(STORAGE_NAMESPACES as readonly string[]).includes(namespace)) {
        return null;
    }
    const fileName = encodeFileName(key.slice(slash + 1));
    return fileName === null ? null : { namespace, fileName };
}

/** Whether `key` is a logical key of the `assets` namespace that the storage routes can resolve. */
export function isAssetStorageKey(key: unknown): key is string {
    return typeof key === "string" && splitStorageKey(key)?.namespace === "assets";
}

/** The file for a logical key, or null when the key has no storage location. */
export function resolveStorageKey(savePath: string, key: string): string | null {
    const parts = splitStorageKey(key);
    if (parts === null) {
        return null;
    }
    const namespaceDir = path.resolve(savePath, parts.namespace);
    const fullPath = path.resolve(namespaceDir, parts.fileName);
    return path.dirname(fullPath) === namespaceDir ? fullPath : null;
}

/**
 * Reads a stored file by logical key in-process (a server job's asset read), with the read route's
 * rules: no symlinks, regular files only. Null when the key has no location or the file is missing.
 */
export async function readStorageFile(savePath: string, key: string): Promise<Uint8Array | null> {
    const fullPath = resolveStorageKey(savePath, key);
    if (fullPath === null) {
        return null;
    }
    let handle: FileHandle;
    try {
        handle = await fs.open(fullPath, STORAGE_READ_FLAGS);
    } catch (error) {
        if (isMissingFileError(error)) {
            return null;
        }
        throw error;
    }
    try {
        if (!(await handle.stat()).isFile()) {
            return null;
        }
        return new Uint8Array(await handle.readFile());
    } finally {
        await handle.close();
    }
}

/** Whether a logical key names a stored regular file (not a symlink), without reading it. */
export async function storageFileExists(savePath: string, key: string): Promise<boolean> {
    const fullPath = resolveStorageKey(savePath, key);
    if (fullPath === null) {
        return false;
    }
    try {
        return (await fs.lstat(fullPath)).isFile();
    } catch (error) {
        if (isMissingFileError(error)) {
            return false;
        }
        throw error;
    }
}

/**
 * Writes a stored file by logical key in-process (a server job's asset write), staged under
 * `save/.tmp/`, flushed, and renamed into place with its directory synced. The caller holds the job's
 * admission: a job ends before maintenance replaces the data. A caller that already hashed the
 * bytes can supply that digest; otherwise content names are hashed while streaming into staging.
 */
export async function writeStorageFile(
    savePath: string,
    key: string,
    bytes: Uint8Array,
    hashHex?: string,
): Promise<void> {
    const fullPath = resolveStorageKey(savePath, key);
    if (fullPath === null) {
        throw new Error(`No storage location for ${key}`);
    }
    const tmpPath = path.join(savePath, TMP_DIR);
    await mkdirDurable(path.dirname(fullPath));
    await fs.mkdir(tmpPath, { recursive: true });
    const stagedPath = path.join(tmpPath, `${randomUUID()}.tmp`);
    const expectedHex = contentNameHash(key);
    const hash = expectedHex !== null && hashHex === undefined ? createHash("sha256") : null;
    try {
        await fs.writeFile(stagedPath, hash ? hashedChunks(bytes, hash) : bytes, { flag: "wx", flush: true });
        const stat = expectedHex === null ? null : await fs.stat(stagedPath, { bigint: true });
        const digest = hash ? hash.digest("hex") : hashHex;
        await fs.rename(stagedPath, fullPath);
        if (stat) {
            assetVerification.recordVerification(fullPath, stat, digest === expectedHex);
        }
        await syncDir(path.dirname(fullPath));
    } catch (error) {
        await fs.rm(stagedPath, { force: true }).catch(() => {});
        throw error;
    }
}

/** Hashes each chunk as the staged write consumes it, without a separate pass under admission. */
function* hashedChunks(bytes: Uint8Array, hash: Hash): Generator<Uint8Array> {
    for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
        const chunk = bytes.subarray(offset, offset + 1024 * 1024);
        hash.update(chunk);
        yield chunk;
    }
}

/** Writes every byte of `bytes` at the handle's current position. */
async function writeAll(out: FileHandle, bytes: Uint8Array): Promise<void> {
    let done = 0;
    while (done < bytes.byteLength) {
        done += (await out.write(bytes, done, bytes.byteLength - done)).bytesWritten;
    }
}

/** A batch read's key list: 1 to `MAX_ASSET_BATCH_RECORDS` keys, each one a record name the framing can carry. */
function isBatchKeyList(keys: unknown): keys is string[] {
    return (
        Array.isArray(keys) &&
        keys.length > 0 &&
        keys.length <= MAX_ASSET_BATCH_RECORDS &&
        keys.every(
            (key) =>
                typeof key === "string" &&
                key.length > 0 &&
                Buffer.byteLength(key, "utf-8") <= MAX_ASSET_BATCH_NAME_BYTES,
        )
    );
}

/** A batch read's answer: one record per key, in order (`storedFileRecord`). */
async function* storedRecords(savePath: string, keys: string[]): AsyncGenerator<Uint8Array> {
    for (const key of keys) {
        yield* storedFileRecord(key, resolveStorageKey(savePath, key));
    }
}

/** Ignores malformed or multiple ranges; a valid range that cannot select any bytes is unsatisfiable. */
function assetByteRange(header: string, size: bigint): { start: number; end: number } | "unsatisfiable" | null {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!match || (!match[1] && !match[2])) {
        return null;
    }
    let start: bigint;
    let end: bigint;
    if (!match[1]) {
        const suffix = BigInt(match[2]);
        if (suffix === 0n) {
            return "unsatisfiable";
        }
        start = suffix >= size ? 0n : size - suffix;
        end = size - 1n;
    } else {
        start = BigInt(match[1]);
        end = match[2] ? BigInt(match[2]) : size - 1n;
        if (match[2] && end < start) {
            return null;
        }
        if (start >= size) {
            return "unsatisfiable";
        }
        if (end >= size) {
            end = size - 1n;
        }
    }
    // Node's stream offsets must be safe integers; decimal range bounds are compared before conversion.
    if (start > BigInt(Number.MAX_SAFE_INTEGER) || end > BigInt(Number.MAX_SAFE_INTEGER)) {
        return null;
    }
    return { start: Number(start), end: Number(end) };
}

/** GET and HEAD use weak comparison for If-None-Match; a wildcard is accepted only as the whole field. */
function matchesAssetEtag(header: string | undefined, etag: string): boolean {
    if (!header) {
        return false;
    }
    return (
        header.trim() === "*" ||
        header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""))
    );
}

type AssetRepresentation = {
    etag: string;
    weakEtag?: string;
    cacheControl: string;
    contentType: string;
    disposition: "inline" | "attachment";
};

function matchedAssetEtag(header: string | undefined, representation: AssetRepresentation): string | null {
    // Keep the validator a cached copy matched so its 304 can upgrade that copy to immutable.
    return matchesAssetEtag(header, representation.etag)
        ? representation.etag
        : representation.weakEtag && matchesAssetEtag(header, representation.weakEtag)
          ? representation.weakEtag
          : null;
}

/** Owns the handle until a byte stream takes it, including conditional, HEAD, and range answers. */
async function serveAssetFile(
    c: Context<AppEnv>,
    handle: FileHandle,
    stat: BigIntStats,
    representation: AssetRepresentation,
): Promise<Response> {
    try {
        const matchedEtag = matchedAssetEtag(c.req.header("If-None-Match"), representation);
        const unchanged = matchedEtag !== null;
        const rangeHeader = c.req.header("Range");
        const range =
            !unchanged &&
            c.req.method !== "HEAD" &&
            stat.size > 0n &&
            c.req.header("If-Range") === undefined &&
            rangeHeader !== undefined
                ? assetByteRange(rangeHeader, stat.size)
                : null;
        if (range === "unsatisfiable") {
            await handle.close();
            c.header("Content-Range", `bytes */${stat.size}`);
            return c.json({ error: "Range not satisfiable" }, 416);
        }
        const noBody = unchanged || c.req.method === "HEAD" || stat.size === 0n;
        if (noBody) {
            await handle.close();
        }
        const body = noBody ? null : createStreamBody(handle.createReadStream(range ?? {}));
        c.header("Content-Type", representation.contentType);
        c.header("Content-Disposition", representation.disposition);
        c.header("ETag", matchedEtag ?? representation.etag);
        c.header("Cache-Control", representation.cacheControl);
        if (unchanged) {
            return c.body(null, 304);
        }
        c.header("Content-Length", range ? String(range.end - range.start + 1) : String(stat.size));
        if (range) {
            c.header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
        }
        return body === null ? c.body(null, 200) : c.body(body, range ? 206 : 200);
    } catch (error) {
        await handle.close().catch(() => {});
        throw error;
    }
}

function thumbnailRedirect(
    c: Context<AppEnv>,
    hex: string,
    reason: "original" | "unavailable" | "busy" | "error",
    cacheControl = "no-store",
): Response {
    c.header("ETag", undefined);
    c.header("Content-Type", undefined);
    c.header("Content-Length", undefined);
    c.header("Content-Range", undefined);
    c.header("Content-Disposition", "inline");
    c.header("Cache-Control", cacheControl);
    c.header("x-risu-thumbnail", reason);
    return c.redirect(`/api/asset/${hex}`, 307);
}

function thumbnailFailure(c: Context<AppEnv>, hex: string, error: unknown): Response {
    if (error instanceof ThumbnailsUnavailable) {
        return thumbnailRedirect(c, hex, "unavailable");
    }
    if (error instanceof ThumbnailBusy) {
        return thumbnailRedirect(c, hex, "busy");
    }
    console.error(`Thumbnail request failed: ${String(error).replace(/[\r\n]+/g, " ")}`);
    return thumbnailRedirect(c, hex, "error");
}

const assetHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
    await next();
    c.header(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Accept-Ranges", "bytes");
    if (!c.res.headers.has("Content-Disposition")) {
        c.header("Content-Disposition", "inline");
    }
    if (c.res.status >= 400 || !c.res.headers.has("Cache-Control")) {
        c.header("Cache-Control", "no-store");
    }
};

/**
 * `/api/*` storage routes over `save/`. Individual keys are hex-encoded in the `file-path` header
 * or `/api/asset/<hex>` path; the server maps them with `resolveStorageKey`. One server process owns `save/`.
 * Writes and removals answer 503 while a restore or an import holds `maintenance`; one admitted
 * before maintenance began finishes first (`MaintenanceGate.enter`). The batch routes
 * (`/api/assets/write`, `/api/assets/read`) carry many assets per request in the backup archive's
 * record framing (`shared/assetBatch.ts`), each record named by its logical key.
 */
export function registerStorageRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maintenance: MaintenanceGate;
        thumbnails: ThumbnailService;
        /** Most records of one batch write (default `MAX_ASSET_BATCH_RECORDS`; tests lower it). */
        maxBatchRecords?: number;
    },
) {
    const { savePath, auth, limiter, maintenance, thumbnails, maxBatchRecords } = arg;

    /** Admits a mutation, or answers 503 while maintenance holds the files. */
    function enterMaintenanceGate(c: Context<AppEnv>): { leave: () => void } | { closed: Response } {
        try {
            return { leave: maintenance.enter() };
        } catch (error) {
            if (!(error instanceof MaintenanceError)) {
                throw error;
            }
            c.header("Retry-After", "5");
            return { closed: c.json({ error: error.message }, 503) };
        }
    }
    const tmpPath = path.join(savePath, TMP_DIR);
    // Staged writes left by a crashed process are never renamed into place; drop them at startup.
    rmSync(tmpPath, { recursive: true, force: true });
    mkdirSync(tmpPath, { recursive: true });

    app.get("/api/read", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const header = c.req.header("file-path");
        if (!header) {
            console.log("no path");
            return c.json({ error: "File path required" }, 400);
        }
        const key = decodeKeyHeader(header);
        if (key === null) {
            return c.json({ error: "Invaild Path" }, 400);
        }
        // A missing file is an empty 200, which the client's asset reader reads as null. Keys outside the
        // storage namespaces (stale paths from an old database) read as missing too.
        const fullPath = resolveStorageKey(savePath, key);
        if (fullPath === null) {
            return c.body(null, 200);
        }
        let handle: FileHandle;
        try {
            handle = await fs.open(fullPath, STORAGE_READ_FLAGS);
        } catch (error) {
            if (isMissingFileError(error)) {
                return c.body(null, 200);
            }
            throw error;
        }
        // Size and bytes come from the same handle, so an atomic replace mid-request cannot mix them.
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) {
                await handle.close();
                return c.body(null, 200);
            }
            c.header("Content-Type", "application/octet-stream");
            c.header("Content-Length", String(stat.size));
            if (c.req.method === "HEAD") {
                await handle.close();
                return c.body(null, 200);
            }
            return c.body(createStreamBody(handle.createReadStream()), 200);
        } catch (error) {
            await handle.close().catch(() => {});
            throw error;
        }
    });

    app.get("/api/asset/*", assetHeaders, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            // The asset URL answers 401 for every failed JWT check.
            return new Response(denied.body, {
                status: 401,
                headers: denied.headers,
            });
        }
        const widths = c.req.queries("w");
        if (widths !== undefined && (widths.length !== 1 || (widths[0] !== "256" && widths[0] !== "512"))) {
            return c.json({ error: "Invalid thumbnail width" }, 400);
        }
        const thumbnailSize = widths === undefined ? undefined : widths[0] === "256" ? 256 : 512;
        const hex = c.req.path.slice("/api/asset/".length);
        if (!hex) {
            return c.json({ error: "Not found" }, 404);
        }
        const key = decodeKeyHeader(hex);
        if (key === null) {
            return c.json({ error: "Invaild Path" }, 400);
        }
        const fullPath = resolveStorageKey(savePath, key);
        if (fullPath === null) {
            return c.json({ error: "Not found" }, 404);
        }
        let handle: FileHandle;
        try {
            handle = await fs.open(fullPath, STORAGE_READ_FLAGS);
        } catch (error) {
            if (isMissingFileError(error)) {
                return c.json({ error: "Not found" }, 404);
            }
            if (thumbnailSize !== undefined) {
                return thumbnailFailure(c, hex, error);
            }
            throw error;
        }
        // The validator, length, and bytes describe the same open file even after an atomic replace.
        try {
            const stat = await handle.stat({ bigint: true });
            if (!stat.isFile()) {
                await handle.close();
                return c.json({ error: "Not found" }, 404);
            }
            const expectedHex = contentNameHash(key);
            const verification =
                expectedHex === null ? "unknown" : assetVerification.lookupVerification(fullPath, stat);
            const verified = verification === "verified";
            if (expectedHex !== null && verification === "unknown") {
                assetVerification.request(fullPath, expectedHex);
            }
            const cacheControl = verified ? "private, max-age=31536000, immutable" : "private, no-cache";
            if (thumbnailSize === undefined) {
                const weakEtag = `W/"${stat.size}-${stat.mtimeNs}-${stat.ino}"`;
                const extension = assetExtension(key);
                const active = isActiveAssetExtension(extension);
                return await serveAssetFile(c, handle, stat, {
                    etag: verified ? `"sha256-${expectedHex}"` : weakEtag,
                    weakEtag: verified ? weakEtag : undefined,
                    cacheControl,
                    contentType: active ? "application/octet-stream" : assetMimeType(extension),
                    disposition: active ? "attachment" : "inline",
                });
            }
            const suffix = `-w${thumbnailSize}-v${THUMBNAIL_VERSION}`;
            const weakEtag = `W/"${stat.size}-${stat.mtimeNs}-${stat.ino}-${stat.dev}${suffix}"`;
            const representation: AssetRepresentation = {
                etag: verified ? `"sha256-${expectedHex}${suffix}"` : weakEtag,
                weakEtag: verified ? weakEtag : undefined,
                cacheControl,
                contentType: "image/webp",
                disposition: "inline",
            };
            const ifNoneMatch = c.req.header("If-None-Match");
            if (ifNoneMatch?.trim() !== "*" && matchedAssetEtag(ifNoneMatch, representation) !== null) {
                return await serveAssetFile(c, handle, stat, representation);
            }
            let thumbnail;
            try {
                thumbnail = await thumbnails.get({ key, size: thumbnailSize, source: { handle, stat } });
            } finally {
                await handle.close();
            }
            if (thumbnail.kind === "original") {
                return thumbnailRedirect(c, hex, "original", cacheControl);
            }
            if (thumbnail.kind === "missing") {
                return c.json({ error: "Not found" }, 404);
            }
            const cached = await fs.open(thumbnail.path, STORAGE_READ_FLAGS);
            try {
                const cachedStat = await cached.stat({ bigint: true });
                if (!cachedStat.isFile()) {
                    throw new Error("Thumbnail cache entry is not a regular file");
                }
                return await serveAssetFile(c, cached, cachedStat, representation);
            } catch (error) {
                await cached.close().catch(() => {});
                throw error;
            }
        } catch (error) {
            await handle.close().catch(() => {});
            if (thumbnailSize !== undefined) {
                return thumbnailFailure(c, hex, error);
            }
            throw error;
        }
    });

    app.get("/api/remove", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const header = c.req.header("file-path");
        if (!header) {
            return c.json({ error: "File path required" }, 400);
        }
        // Batch form: each key hex-encoded on its own, joined with `$$` (not a hex character).
        const fullPaths = new Map<string, string>();
        for (const segment of header.split("$$")) {
            if (!segment) {
                return c.json({ error: "File path required" }, 400);
            }
            const key = decodeKeyHeader(segment);
            const fullPath = key === null ? null : resolveStorageKey(savePath, key);
            if (key === null || fullPath === null) {
                return c.json({ error: "Invaild Path" }, 400);
            }
            fullPaths.set(fullPath, key);
        }
        const admitted = enterMaintenanceGate(c);
        if ("closed" in admitted) {
            return admitted.closed;
        }
        try {
            // Sequential; a filesystem error (e.g. missing file) stops the batch with a 500 and
            // leaves earlier deletions in place.
            for (const [fullPath, key] of fullPaths) {
                try {
                    await fs.rm(fullPath);
                } finally {
                    assetVerification.forgetVerification(fullPath);
                    await thumbnails.removeKey(key).catch((error: unknown) => {
                        console.error("Thumbnail removal failed:", error);
                    });
                }
            }
        } finally {
            admitted.leave();
        }
        return c.json({ success: true });
    });

    app.get("/api/list", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        // Only files whose names `encodeFileName` would produce, so every listed key reads back the same file.
        const content: string[] = [];
        for (const namespace of STORAGE_NAMESPACES) {
            let entries: Dirent[];
            try {
                entries = await fs.readdir(path.join(savePath, namespace), { withFileTypes: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                    continue;
                }
                throw error;
            }
            for (const entry of entries) {
                if (!entry.isFile()) {
                    continue;
                }
                const name = decodeFileName(entry.name);
                if (name !== null) {
                    content.push(`${namespace}/${name}`);
                }
            }
        }
        return c.json({ success: true, content });
    });

    app.post("/api/write", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const header = c.req.header("file-path");
        if (!header) {
            return c.json({ error: "File path required" }, 400);
        }
        const key = decodeKeyHeader(header);
        const fullPath = key === null ? null : resolveStorageKey(savePath, key);
        if (key === null || fullPath === null) {
            return c.json({ error: "Invaild Path" }, 400);
        }
        // Raw request bytes, whatever the content type; zero-length writes are allowed.
        const fileContent = new Uint8Array(await c.req.arrayBuffer());
        const hashHex =
            contentNameHash(key) === null ? undefined : createHash("sha256").update(fileContent).digest("hex");
        const admitted = enterMaintenanceGate(c);
        if ("closed" in admitted) {
            return admitted.closed;
        }
        try {
            // Flush the staged file before renaming, then sync its directory before acknowledging
            // the write. Directory-sync refusals (EINVAL/EPERM) are tolerated on unsupported mounts.
            await writeStorageFile(savePath, key, fileContent, hashHex);
        } finally {
            admitted.leave();
        }
        return c.json({ success: true });
    });

    // Records named by their logical keys, written as `/api/write` writes (always overwriting; a
    // zero-length record is an empty file) but streamed: each record's bytes go into a staged file as
    // they arrive, so memory holds a chunk, not a record. Each file is synced before close and rename.
    // Only publication into the target directory holds the gate, one record at a time and never
    // across the body read, because maintenance waits for every admitted mutation. At the first
    // failure the writing stops and the staged file is removed, but the rest of the body is still read
    // and dropped before the answer: `@hono/node-server` resets a connection whose body is left unread,
    // which the client would see as a network failure and resend. Records renamed before the failure
    // stay in place. A successful batch syncs each target directory once, outside the gate, before
    // answering; a failed batch skips that sync because none of its writes are acknowledged.
    app.post(ASSET_BATCH_WRITE_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parser = new AssetRecordParser({ maxRecords: maxBatchRecords });
        let written = 0;
        const targetDirs = new Set<string>();
        /** The record whose bytes are being staged. */
        let staged: {
            target: string;
            file: string;
            out: FileHandle;
            expectedHex: string | null;
            hash: Hash | null;
        } | null = null;
        /** The first failure: the answer, or the error that becomes a 500, once the body is read. */
        let failure: { response: Response } | { error: unknown } | null = null;
        const refuse = (error: unknown) =>
            error instanceof AssetBatchFormatError
                ? { response: c.json({ error: "Invalid asset batch" }, 400) }
                : { error };
        const dropStaged = async () => {
            const current = staged;
            staged = null;
            if (current) {
                await current.out.close().catch(() => {});
                await fs.rm(current.file, { force: true }).catch(() => {});
            }
        };
        /** Applies one parser event; an answer when it refuses the batch. */
        const apply = async (event: AssetRecordEvent): Promise<Response | null> => {
            if (event.type === "start") {
                const target = resolveStorageKey(savePath, event.name);
                if (target === null) {
                    return c.json({ error: "Invaild Path", index: event.index }, 400);
                }
                await fs.mkdir(tmpPath, { recursive: true });
                const file = path.join(tmpPath, `${randomUUID()}.tmp`);
                const expectedHex = contentNameHash(event.name);
                staged = {
                    target,
                    file,
                    out: await fs.open(file, "wx"),
                    expectedHex,
                    hash: expectedHex === null ? null : createHash("sha256"),
                };
                return null;
            }
            const current = staged!;
            if (event.type === "data") {
                current.hash?.update(event.bytes);
                await writeAll(current.out, event.bytes);
                return null;
            }
            const stat = current.hash ? await current.out.stat({ bigint: true }) : null;
            const ok = current.hash?.digest("hex") === current.expectedHex;
            await current.out.sync();
            await current.out.close();
            const admitted = enterMaintenanceGate(c);
            if ("closed" in admitted) {
                return admitted.closed;
            }
            try {
                const targetDir = path.dirname(current.target);
                await mkdirDurable(targetDir);
                await fs.rename(current.file, current.target);
                targetDirs.add(targetDir);
                if (stat) {
                    assetVerification.recordVerification(current.target, stat, ok);
                }
            } finally {
                admitted.leave();
            }
            staged = null;
            written += 1;
            return null;
        };

        const body = c.req.raw.body;
        if (body) {
            const reader = body.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    if (failure) {
                        continue;
                    }
                    try {
                        for (const event of parser.events(value)) {
                            const refused = await apply(event);
                            if (refused) {
                                failure = { response: refused };
                                break;
                            }
                        }
                    } catch (error) {
                        failure = refuse(error);
                    }
                    if (failure) {
                        await dropStaged();
                    }
                }
            } catch (error) {
                // The body could not be read to its end: the client is gone.
                await dropStaged();
                throw error;
            }
        }
        if (!failure) {
            try {
                parser.end();
            } catch (error) {
                failure = refuse(error);
                await dropStaged();
            }
        }
        if (failure) {
            if ("error" in failure) {
                throw failure.error;
            }
            return failure.response;
        }
        for (const dir of targetDirs) {
            await syncDir(dir);
        }
        return c.json({ success: true, written });
    });

    // One record per asked key, in the order asked (duplicates included), each read as the backup
    // export reads a file (no symlinks, size and bytes from one handle). A key with no storage
    // location, a missing file, a symlink, or a non-regular file is a zero-length record, as `/api/read`
    // answers an empty 200. A file that cannot be read fails the stream. Like `/api/read`, it stays
    // open under maintenance.
    app.post(ASSET_BATCH_READ_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const keys: unknown = parsed.body.keys;
        if (!isBatchKeyList(keys)) {
            return c.json({ error: `keys must be a list of 1 to ${MAX_ASSET_BATCH_RECORDS} keys` }, 400);
        }
        c.header("Content-Type", "application/octet-stream");
        c.header("Cache-Control", "no-store");
        // Files open one at a time inside the stream; a client that leaves cancels it, which closes
        // the open one (`iteratorStream`).
        return c.body(iteratorStream(storedRecords(savePath, keys)), 200);
    });
}
