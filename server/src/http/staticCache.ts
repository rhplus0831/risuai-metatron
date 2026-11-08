import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context, MiddlewareHandler } from "hono";
import { getMimeType } from "hono/utils/mime";
import type { AppEnv } from "../types.ts";

/**
 * Static representation negotiation and conditional caching before the fallback static server in
 * server/src/app.ts. Hashed /assets/ files are immutable; other files require revalidation. Fresh
 * Brotli/gzip siblings may serve compressible files, with validators specific to that representation;
 * range requests use identity. The client index is read and validated through one handle and must
 * contain a head tag before it can answer, including a 304: its injected __NODE__ flag lets the
 * client boot. Missing or rejected static paths fall through without cache headers.
 */

/** File extensions eligible for precompressed .br/.gz sibling negotiation; HTML stays identity. */
export const STATIC_COMPRESSIBLE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".json", ".svg", ".wasm"]);

type StaticEncoding = "br" | "gzip";
const encodingSuffixes = { br: ".br", gzip: ".gz" };
const headOpenTag = /<head(\s[^>]*)?>/i;

function matchesEtag(header: string, etag: string): boolean {
    return (
        header.trim() === "*" ||
        header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""))
    );
}

function setCacheHeaders(
    c: Context<AppEnv>,
    stat: BigIntStats,
    cacheControl: string,
    encoding?: StaticEncoding,
): boolean {
    const etag = `W/"${stat.size}-${stat.mtimeNs}${encoding ? `-${encoding}` : ""}"`;
    c.header("ETag", etag);
    c.header("Last-Modified", stat.mtime.toUTCString());
    c.header("Cache-Control", cacheControl);

    const ifNoneMatch = c.req.header("If-None-Match");
    // Even an empty If-None-Match takes precedence over If-Modified-Since.
    if (ifNoneMatch !== undefined) {
        return matchesEtag(ifNoneMatch, etag);
    }
    const ifModifiedSince = c.req.header("If-Modified-Since");
    return (
        ifModifiedSince !== undefined && Date.parse(ifModifiedSince) >= Math.floor(Number(stat.mtimeMs) / 1000) * 1000
    );
}

function tryDecodePath(requestPath: string): string {
    try {
        return decodeURI(requestPath);
    } catch {
        return requestPath.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
            try {
                return decodeURI(match);
            } catch {
                return match;
            }
        });
    }
}

/** Resolve files like serveStatic, leaving missing or rejected paths to later routes. */
async function staticFileStat(root: string, requestPath: string) {
    const filename = tryDecodePath(requestPath);
    if (/(?:^|[\/\\])\.{1,2}(?:$|[\/\\])|[\/\\]{2,}|\\/.test(filename)) {
        return undefined;
    }
    try {
        let filePath = path.join(root, filename);
        let stat = await fs.stat(filePath, { bigint: true });
        if (stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
            stat = await fs.stat(filePath, { bigint: true });
        }
        return stat.isFile() ? { filePath, stat } : undefined;
    } catch {
        return undefined;
    }
}

/** Rank supported encodings ahead of identity; equal qualities prefer br, then gzip. */
function acceptedEncodings(header: string | undefined): StaticEncoding[] {
    if (!header) {
        return [];
    }
    const quality = new Map<string, number>();
    for (const entry of header.split(",")) {
        const [name, ...params] = entry.split(";").map((part) => part.trim());
        const coding = name.toLowerCase();
        // The first occurrence wins; invalid or out-of-range quality values refuse that coding.
        if (!coding || quality.has(coding)) {
            continue;
        }
        let q = 1;
        for (const param of params) {
            if (/^q(?:\s*=|\s*$)/i.test(param)) {
                const match = /^q\s*=\s*(\d+(?:\.\d*)?|\.\d+)$/i.exec(param);
                const value = match ? Number(match[1]) : NaN;
                q = Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
                break;
            }
        }
        quality.set(coding, q);
    }
    const wildcard = quality.get("*") ?? 0;
    const identity = quality.get("identity") ?? (quality.get("*") === 0 ? 0 : 1);
    return (["br", "gzip"] as const)
        .map((encoding) => ({ encoding, q: quality.get(encoding) ?? wildcard }))
        .filter(({ q }) => q > 0 && q >= identity)
        .sort((a, b) => b.q - a.q)
        .map(({ encoding }) => encoding);
}

async function openCompressedFile(filePath: string, original: BigIntStats, header: string | undefined) {
    for (const encoding of acceptedEncodings(header)) {
        try {
            const siblingPath = filePath + encodingSuffixes[encoding];
            const siblingStat = await fs.stat(siblingPath, { bigint: true });
            if (!siblingStat.isFile() || siblingStat.mtimeNs < original.mtimeNs) {
                continue;
            }
            const handle = await fs.open(siblingPath, "r");
            let selected = false;
            try {
                const stat = await handle.stat({ bigint: true });
                if (stat.isFile() && stat.mtimeNs >= original.mtimeNs) {
                    selected = true;
                    return { handle, stat, encoding };
                }
            } finally {
                if (!selected) {
                    await handle.close();
                }
            }
        } catch {
            // Missing, unreadable, and stale siblings leave the other representations available.
        }
    }
    return undefined;
}

/**
 * Serve negotiated siblings and answer conditional requests before serveStatic handles identity. Only
 * a regular file of `root` is handled for GET and HEAD; a missing or rejected path passes on with no
 * cache headers. `/assets/*` (hashed build names) is `public, max-age=31536000, immutable`, every other
 * file (`sw.js`, `manifest.json`) `no-cache`.
 *
 * A file of `STATIC_COMPRESSIBLE_EXTENSIONS` is served from its `.br` or `.gz` sibling when
 * `Accept-Encoding` accepts that coding at least as much as identity (codings matched in any case,
 * `q=0` refusing one, `*` covering the unnamed; equal qualities prefer Brotli, then gzip) and the
 * sibling is a regular file no older than the original; else the next acceptable coding, else
 * identity, which a missing header also gets. The sibling answer has its own length and the
 * original's MIME type. Each representation has its own weak size/mtime ETag (the coding in it) and
 * `Last-Modified`, and every answer of a compressible file, identity and 304 included, carries
 * `Vary: Accept-Encoding`. HTML is not compressible, so the index is never negotiated.
 *
 * `If-None-Match` (weak comparison, `*` only as the whole field) alone decides a bodyless 304; only
 * without it does an `If-Modified-Since` at or after the mtime, floored to whole seconds, answer 304.
 * A request with `Range` or `If-Range` always gets identity, through `serveStatic`; an `If-Range`
 * other than the exact `Last-Modified` date (the ETag is weak, so no tag satisfies it) drops the
 * Range, and the answer is the full 200.
 */
export function createStaticCache(root: string): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        if (c.finalized || (c.req.method !== "GET" && c.req.method !== "HEAD")) {
            return next();
        }
        const file = await staticFileStat(root, c.req.path);
        if (!file) {
            return next();
        }
        const { filePath, stat } = file;
        const compressible = STATIC_COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
        if (compressible) {
            c.header("Vary", "Accept-Encoding", { append: true });
        }
        // Range and If-Range always validate and serve the original representation.
        const compressed =
            compressible && c.req.header("Range") === undefined && c.req.header("If-Range") === undefined
                ? await openCompressedFile(filePath, stat, c.req.header("Accept-Encoding"))
                : undefined;
        const cacheControl = c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        if (compressed) {
            let streaming = false;
            try {
                c.header("Content-Type", getMimeType(filePath) || "application/octet-stream");
                c.header("Content-Encoding", compressed.encoding);
                if (setCacheHeaders(c, compressed.stat, cacheControl, compressed.encoding)) {
                    return c.body(null, 304);
                }
                c.header("Content-Length", compressed.stat.size.toString());
                if (c.req.method === "HEAD") {
                    return c.body(null, 200);
                }
                const body = Readable.toWeb(compressed.handle.createReadStream());
                const response = c.body(body, 200);
                streaming = true;
                return response;
            } finally {
                if (!streaming) {
                    await compressed.handle.close();
                }
            }
        }
        if (setCacheHeaders(c, stat, cacheControl)) {
            return c.body(null, 304);
        }
        const ifRange = c.req.header("If-Range");
        if (ifRange !== undefined && c.req.header("Range") !== undefined) {
            const validator = ifRange.trim();
            const etag = c.res.headers.get("ETag");
            const lastModified = c.res.headers.get("Last-Modified");
            // If-Range requires a strong ETag match or the exact Last-Modified date.
            const matches =
                (etag !== null && !etag.startsWith("W/") && validator === etag) ||
                (lastModified !== null && Date.parse(validator) === Date.parse(lastModified));
            if (!matches) {
                c.req.raw.headers.delete("Range");
            }
        }
        return next();
    };
}

/**
 * The client index (`/`, `/index.html`, the client routes): `no-cache`, a weak size/mtime ETag,
 * `Last-Modified`, and the same conditional 304 as `createStaticCache`, else the text with
 * `globalThis.__NODE__ = true` injected after the `<head>` tag, which the client needs to mount. The
 * validator and index text come from the same open file, and an index without `<head>` throws before
 * any conditional answer, so the unflagged file is never served.
 */
export async function serveCachedIndex(c: Context<AppEnv>, indexPath: string) {
    const handle = await fs.open(indexPath, "r");
    try {
        const stat = await handle.stat({ bigint: true });
        const mainIndex = await handle.readFile("utf-8");
        if (!headOpenTag.test(mainIndex)) {
            throw new Error("dist/index.html has no <head>");
        }
        if (setCacheHeaders(c, stat, "no-cache")) {
            return c.body(null, 304);
        }
        return c.html(mainIndex.replace(headOpenTag, (tag) => `${tag}<script>globalThis.__NODE__ = true</script>`));
    } finally {
        await handle.close();
    }
}
