import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.ts";

const headOpenTag = /<head(\s[^>]*)?>/i;

function matchesEtag(header: string, etag: string): boolean {
    return (
        header.trim() === "*" ||
        header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""))
    );
}

function setCacheHeaders(c: Context<AppEnv>, stat: BigIntStats, cacheControl: string): boolean {
    const etag = `W/"${stat.size}-${stat.mtimeNs}"`;
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
async function staticFileStat(root: string, requestPath: string): Promise<BigIntStats | undefined> {
    const filename = tryDecodePath(requestPath);
    if (/(?:^|[\/\\])\.{1,2}(?:$|[\/\\])|[\/\\]{2,}|\\/.test(filename)) {
        return undefined;
    }
    try {
        const filePath = path.join(root, filename);
        let stat = await fs.stat(filePath, { bigint: true });
        if (stat.isDirectory()) {
            stat = await fs.stat(path.join(filePath, "index.html"), { bigint: true });
        }
        return stat.isFile() ? stat : undefined;
    } catch {
        return undefined;
    }
}

/** Answer conditional requests before serveStatic opens a body stream. */
export function createStaticCache(root: string): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        if (c.finalized) {
            return next();
        }
        const stat = await staticFileStat(root, c.req.path);
        if (!stat) {
            return next();
        }
        const cacheControl = c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        if (setCacheHeaders(c, stat, cacheControl)) {
            return c.body(null, 304);
        }
        return next();
    };
}

/** The validator and index text come from the same open file. */
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
