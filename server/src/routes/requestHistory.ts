import type { Context, Hono, MiddlewareHandler } from "hono";
import type { RequestHistory, RequestHistoryStatus } from "../data/requestHistory.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

export const REQUEST_HISTORY_PATH = "/api/request-history";

const STATUSES: readonly RequestHistoryStatus[] = ["pending", "success", "error", "aborted", "interrupted"];
/** The store's list cursor: a row's `seq` as a decimal string. */
const CURSOR = /^[1-9][0-9]{0,15}$/;
/** A page size; the store clamps it to 1–200. */
const PAGE_SIZE = /^[0-9]{1,4}$/;

/**
 * The LLM request history (`docs/plan/request-history-diagnostics.md` slice 4), for the app's own
 * viewer: JWT, the shared limiter. Not a resource: no epoch, no maintenance gate (a restore leaves
 * the history as it is). The app's admission middleware refuses these routes during shutdown and
 * makes every answer `no-store`; the store's availability is checked again after the JWT check, in
 * the same synchronous block as the read or the delete (the store closes at dispose).
 *
 * - `GET /api/request-history?cursor&limit&chaId&chatId&jobId&status`: `{ items, next }`, summaries
 *   newest first; `next` is the cursor of the next page, null on the last. An empty parameter is
 *   absent; a malformed cursor, page size, or status is a 400.
 * - `GET /api/request-history/:id`: the row with its content (prompt, exchanges, error,
 *   truncation); 404 when there is none.
 * - `DELETE /api/request-history`: removes every row; 204, or 500 when the delete failed.
 *
 * Each answers 503 while the store is unavailable (it failed to open, or it is closed).
 */
export function registerRequestHistoryRoutes(
    app: Hono<AppEnv>,
    arg: { history: RequestHistory; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { history, auth, limiter } = arg;
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };
    const unavailable = (c: Context<AppEnv>) => {
        c.header("Retry-After", "5");
        return c.json({ error: "The request history is unavailable" }, 503);
    };
    /** A query parameter, with an empty value as absent. */
    const param = (c: Context<AppEnv>, name: string): string | undefined => c.req.query(name) || undefined;

    app.get(REQUEST_HISTORY_PATH, limiter, authenticated, (c) => {
        const cursor = param(c, "cursor");
        if (cursor !== undefined && (!CURSOR.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
            return c.json({ error: "Invalid cursor" }, 400);
        }
        const limit = param(c, "limit");
        if (limit !== undefined && !PAGE_SIZE.test(limit)) {
            return c.json({ error: "Invalid limit" }, 400);
        }
        const status = param(c, "status");
        if (status !== undefined && !STATUSES.includes(status as RequestHistoryStatus)) {
            return c.json({ error: "Invalid status" }, 400);
        }
        if (!history.available()) {
            return unavailable(c);
        }
        return c.json(
            history.list({
                cursor,
                limit: limit === undefined ? undefined : Number(limit),
                chaId: param(c, "chaId"),
                chatId: param(c, "chatId"),
                jobId: param(c, "jobId"),
                status: status as RequestHistoryStatus | undefined,
            }),
        );
    });

    app.get(`${REQUEST_HISTORY_PATH}/:id`, limiter, authenticated, (c) => {
        if (!history.available()) {
            return unavailable(c);
        }
        const record = history.get(c.req.param("id"));
        return record ? c.json(record) : c.json({ error: "No such request" }, 404);
    });

    app.delete(REQUEST_HISTORY_PATH, limiter, authenticated, (c) => {
        if (!history.available()) {
            return unavailable(c);
        }
        if (history.deleteAll() === null) {
            return history.available()
                ? c.json({ error: "The request history could not be deleted" }, 500)
                : unavailable(c);
        }
        return c.body(null, 204);
    });
}
