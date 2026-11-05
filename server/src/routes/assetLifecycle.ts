import type { Hono, MiddlewareHandler } from "hono";
import { ASSET_REPORT_PATH, ASSET_SCAN_PATH, ASSET_SWEEP_PATH } from "../../../shared/assetLifecycle.ts";
import { AssetSweepConflict, type AssetLifecycle } from "../data/assetLifecycle.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

/**
 * GET /api/assets/report answers 200 with the latest report. POST /api/assets/scan answers 202 with
 * the running report, or 409 while a scan or sweep is running. POST /api/assets/sweep validates
 * { dryRun, keys?, inlays? }, waits for completion, and answers 200 with deleted/skipped entries, or
 * 409 when its process-local scan/epoch/uptime gates fail. All require auth, use the storage rate-limit
 * bucket before authentication, answer 503 once closed, and set no-store on every answer, including 429.
 */
export function registerAssetLifecycleRoutes(
    app: Hono<AppEnv>,
    arg: { auth: AuthStore; limiter: MiddlewareHandler<AppEnv>; lifecycle: AssetLifecycle },
) {
    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        c.header("Cache-Control", "no-store");
        try {
            await next();
        } finally {
            c.header("Cache-Control", "no-store");
        }
    };
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
