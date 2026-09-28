import { randomUUID } from "node:crypto";
import { constants, type Dirent, mkdirSync, rmSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createStreamBody } from "@hono/node-server/utils/stream";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

/**
 * Folders under `save/` that hold user data. A logical key `<namespace>/<name>` is stored at
 * `save/<namespace>/<encodeFileName(name)>`; keys in any other namespace have no storage location.
 */
export const STORAGE_NAMESPACES = ["database", "assets", "remotes"] as const;

/** Staging folder for atomic writes. It is not a namespace, so the API cannot reach it. */
const TMP_DIR = ".tmp";
const MAX_FILE_NAME_BYTES = 255;
/** Prefix of the hex fallback file name. A literal `~` in a readable name is always `%7E`. */
const HEX_FALLBACK_PREFIX = "~";
const hexHeaderRegex = /^(?:[0-9a-fA-F]{2})+$/;
const readableByteRegex = /^[a-z0-9._-]$/;
const windowsReservedStem = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const missingFileCodes = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);
// No symlinks, and a FIFO opens without blocking so the `isFile` check can reject it.
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

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

/** The file for a logical key, or null when the key has no storage location. */
export function resolveStorageKey(savePath: string, key: string): string | null {
    const slash = key.indexOf("/");
    if (slash <= 0) {
        return null;
    }
    const namespace = key.slice(0, slash);
    if (!(STORAGE_NAMESPACES as readonly string[]).includes(namespace)) {
        return null;
    }
    const fileName = encodeFileName(key.slice(slash + 1));
    if (fileName === null) {
        return null;
    }
    const namespaceDir = path.resolve(savePath, namespace);
    const fullPath = path.resolve(namespaceDir, fileName);
    return path.dirname(fullPath) === namespaceDir ? fullPath : null;
}

function isMissingFileError(error: unknown): boolean {
    return missingFileCodes.has((error as NodeJS.ErrnoException)?.code ?? "");
}

/**
 * `/api/*` storage routes over `save/`. The client sends each logical key hex-encoded in the
 * `file-path` header; the server maps it with `resolveStorageKey`. One server process owns `save/`.
 */
export function registerStorageRoutes(
    app: Hono<AppEnv>,
    arg: { savePath: string; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { savePath, auth, limiter } = arg;
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
        // A missing file is an empty 200, which NodeStorage reads as null. Keys outside the
        // storage namespaces (stale paths from an old database) read as missing too.
        const fullPath = resolveStorageKey(savePath, key);
        if (fullPath === null) {
            return c.body(null, 200);
        }
        let handle: FileHandle;
        try {
            handle = await fs.open(fullPath, readFlags);
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
        const fullPaths = new Set<string>();
        for (const segment of header.split("$$")) {
            if (!segment) {
                return c.json({ error: "File path required" }, 400);
            }
            const key = decodeKeyHeader(segment);
            const fullPath = key === null ? null : resolveStorageKey(savePath, key);
            if (fullPath === null) {
                return c.json({ error: "Invaild Path" }, 400);
            }
            fullPaths.add(fullPath);
        }
        // Sequential; a filesystem error (e.g. missing file) stops the batch with a 500 and
        // leaves earlier deletions in place.
        for (const fullPath of fullPaths) {
            await fs.rm(fullPath);
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
        if (fullPath === null) {
            return c.json({ error: "Invaild Path" }, 400);
        }
        // Raw request bytes, whatever the content type; zero-length writes are allowed.
        const fileContent = new Uint8Array(await c.req.arrayBuffer());
        // Stage then rename, so a reader or a crash sees the old or the new file, never a partial one.
        // This is atomic replacement, not a durability guarantee (no fsync).
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.mkdir(tmpPath, { recursive: true });
        const stagedPath = path.join(tmpPath, `${randomUUID()}.tmp`);
        try {
            await fs.writeFile(stagedPath, fileContent, { flag: "wx" });
            await fs.rename(stagedPath, fullPath);
        } catch (error) {
            await fs.rm(stagedPath, { force: true }).catch(() => {});
            throw error;
        }
        return c.json({ success: true });
    });
}
