import fs, { type FileHandle } from "node:fs/promises";
import { createStreamBody } from "@hono/node-server/utils/stream";
import type { Hono, MiddlewareHandler } from "hono";
import {
    ASSET_PREVIEW_PATH,
    ASSET_REPORT_PATH,
    ASSET_STATUS_PATH,
    ASSET_SCAN_PATH,
    ASSET_SWEEP_PATH,
} from "../../../shared/assetLifecycle.ts";
import { assetExtension, assetMimeType, isActiveAssetExtension } from "../../../shared/assetMime.ts";
import { AssetSweepConflict, type AssetLifecycle } from "../data/assetLifecycle.ts";
import { withAssetLocks } from "../http/assetLeases.ts";
import { ThumbnailBusy, ThumbnailsUnavailable, type ThumbnailService } from "../http/assetThumbnails.ts";
import { readJsonBody } from "../http/body.ts";
import { isMissingFileError, STORAGE_READ_FLAGS } from "../http/recordStream.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { decodeKeyHeader, resolveStorageKey } from "./storage.ts";

/**
 * Authenticated retention reporting, scan/sweep controls, and lease-free candidate previews over
 * server/src/data/assetLifecycle.ts. The storage limiter precedes JWT authentication; no-store wraps
 * every route answer, and server/src/app.ts tracks this family and covers shutdown refusals. POST
 * bodies use the app's default 100 MiB cap, with sweep JSON read after authentication.
 * Preview admission is rechecked under the asset key lock through file opening and thumbnail
 * generation. Unlike ordinary asset reads, previews neither renew leases nor verify content names;
 * only current image candidates may be shown. The app supplies assetHeaders before admission.
 */

/**
 * GET /api/assets/report answers 200 with the latest versioned report. GET /api/assets/status answers
 * 200 with only { running, version }. POST /api/assets/scan answers 202 with
 * the running report, or 409 while a scan or sweep is running. POST /api/assets/sweep validates
 * { dryRun, keys?, inlays? }, waits for completion, and answers 200 with deleted/skipped entries, or
 * 409 when its process-local scan/epoch/uptime gates fail. All require auth, use the storage rate-limit
 * bucket before authentication, answer 503 once closed, and set no-store on every answer, including 429.
 * GET /api/assets/preview/<hex> admits current past-grace candidates or orphan candidates' assets,
 * images only (no active extensions), serving a 256 WebP or inline original bytes. It never leases,
 * claims, or verifies. Admission is rechecked under the key lock, held through file opens and thumbnail
 * generation. Ineligible/missing files and thumbnail failures answer 404; auth failures answer 401.
 * The app applies assetHeaders before shutdown admission, covering every preview answer exactly once.
 */
export function registerAssetLifecycleRoutes(
    app: Hono<AppEnv>,
    arg: {
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        lifecycle: AssetLifecycle;
        savePath: string;
        thumbnails: ThumbnailService;
    },
) {
    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        c.header("Cache-Control", "no-store");
        try {
            await next();
        } finally {
            c.header("Cache-Control", "no-store");
        }
    };
    app.get(`${ASSET_PREVIEW_PATH}/*`, noStore, arg.limiter, async (c) => {
        const denied = await arg.auth.checkAuth(c);
        if (denied) {
            return new Response(denied.body, { status: 401, headers: denied.headers });
        }
        if (arg.lifecycle.closed) {
            return c.json({ error: "The server is shutting down" }, 503);
        }
        const key = decodeKeyHeader(c.req.path.slice(`${ASSET_PREVIEW_PATH}/`.length));
        const fullPath = key === null ? null : resolveStorageKey(arg.savePath, key);
        if (key === null || fullPath === null || !arg.lifecycle.previewable(key)) {
            return c.json({ error: "Not found" }, 404);
        }
        const extension = assetExtension(key);
        const mime = assetMimeType(extension);
        if (!mime.startsWith("image/") || isActiveAssetExtension(extension)) {
            return c.json({ error: "Not found" }, 404);
        }
        return withAssetLocks(
            [fullPath],
            async () => {
                if (arg.lifecycle.closed) {
                    return c.json({ error: "The server is shutting down" }, 503);
                }
                if (!arg.lifecycle.previewable(key)) {
                    return c.json({ error: "Not found" }, 404);
                }
                let handle: FileHandle | undefined;
                try {
                    handle = await fs.open(fullPath, STORAGE_READ_FLAGS);
                    let stat = await handle.stat({ bigint: true });
                    if (!stat.isFile()) return c.json({ error: "Not found" }, 404);
                    const thumbnail = await arg.thumbnails.get({ key, size: 256, source: { handle, stat } });
                    if (thumbnail.kind === "missing") return c.json({ error: "Not found" }, 404);
                    if (thumbnail.kind === "webp") {
                        await handle.close();
                        handle = undefined;
                        handle = await fs.open(thumbnail.path, STORAGE_READ_FLAGS);
                        stat = await handle.stat({ bigint: true });
                        if (!stat.isFile()) throw new Error("Thumbnail cache entry is not a regular file");
                    }
                    // HEAD bodies are discarded without cancellation by Hono; keep ownership to close below.
                    const body =
                        c.req.method === "HEAD" || stat.size === 0n
                            ? null
                            : createStreamBody(handle.createReadStream({ start: 0 }));
                    const headers = {
                        "Content-Type": thumbnail.kind === "webp" ? "image/webp" : mime,
                        "Content-Length": String(stat.size),
                        "Content-Disposition": "inline",
                    };
                    const response = body === null ? c.body(null, 200, headers) : c.body(body, 200, headers);
                    // The stream owns the open source (original) or cache handle after the lock is released.
                    if (body !== null) handle = undefined;
                    return response;
                } catch (error) {
                    if (
                        !isMissingFileError(error) &&
                        !(error instanceof ThumbnailsUnavailable) &&
                        !(error instanceof ThumbnailBusy)
                    ) {
                        console.error(`Thumbnail request failed: ${String(error).replace(/[\r\n]+/g, " ")}`);
                    }
                    return c.json({ error: "Not found" }, 404);
                } finally {
                    await handle?.close().catch(() => {});
                }
            },
            c.req.raw.signal,
        );
    });
    app.get(ASSET_REPORT_PATH, noStore, arg.limiter, async (c) => {
        const denied = await arg.auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        if (arg.lifecycle.closed) {
            return c.json({ error: "The server is shutting down" }, 503);
        }
        return c.json(arg.lifecycle.report());
    });
    app.get(ASSET_STATUS_PATH, noStore, arg.limiter, async (c) => {
        const denied = await arg.auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        if (arg.lifecycle.closed) {
            return c.json({ error: "The server is shutting down" }, 503);
        }
        return c.json({ running: arg.lifecycle.running, version: arg.lifecycle.version });
    });
    app.post(ASSET_SCAN_PATH, noStore, arg.limiter, async (c) => {
        const denied = await arg.auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        if (arg.lifecycle.closed) {
            return c.json({ error: "The server is shutting down" }, 503);
        }
        if (arg.lifecycle.running) {
            return c.json({ error: "A scan or sweep is already running" }, 409);
        }
        void arg.lifecycle.scan().catch((error: unknown) => console.error("[Server] Asset scan failed:", error));
        return c.json(arg.lifecycle.report(), 202);
    });
    app.post(ASSET_SWEEP_PATH, noStore, arg.limiter, async (c) => {
        const denied = await arg.auth.checkAuth(c);
        if (denied) return denied;
        if (arg.lifecycle.closed) return c.json({ error: "The server is shutting down" }, 503);
        const parsed = await readJsonBody(c);
        if (!parsed.ok) return parsed.response;
        const { dryRun, keys, inlays } = parsed.body;
        const list = (value: unknown) =>
            value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
        if (typeof dryRun !== "boolean" || !list(keys) || !list(inlays)) {
            return c.json({ error: "Expected dryRun and optional keys/inlays string arrays" }, 400);
        }
        try {
            return c.json(await arg.lifecycle.sweep({ dryRun, keys, inlays, signal: c.req.raw.signal }));
        } catch (error) {
            if (error instanceof AssetSweepConflict) return c.json({ error: error.message }, 409);
            throw error;
        }
    });
}
