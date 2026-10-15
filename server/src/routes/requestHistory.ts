import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
    REQUEST_HISTORY_PATH,
    REQUEST_HISTORY_SHARE_PATH,
    REQUEST_HISTORY_SHARES_PATH,
    REQUEST_HISTORY_STATUSES,
    type RequestHistoryStatus,
    SHARE_JOB_ID,
    SHARE_REQUEST_ID,
} from "../../../shared/requestHistory.ts";
import type { RequestHistory, RequestHistoryShareQuery } from "../data/requestHistory.ts";
import type { RequestShares } from "../diagnostics/share.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

export { REQUEST_HISTORY_PATH, REQUEST_HISTORY_SHARE_PATH, REQUEST_HISTORY_SHARES_PATH };

/** The share route's body cap (its own, after the auth; the app's 100 MiB limit skips the route). */
export const SHARE_BODY_BYTES = 4 * 1024;

/** A share body: exactly `shared` and one of `jobId` (a job id of the server's shapes) or `requestId` (a request id). */
function parseShareBody(text: string): (RequestHistoryShareQuery & { shared: boolean }) | null {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return null;
    }
    const keys = Object.keys(body);
    const fields = body as Record<string, unknown>;
    if (keys.length !== 2 || typeof fields.shared !== "boolean") {
        return null;
    }
    if (Object.hasOwn(fields, "jobId")) {
        return typeof fields.jobId === "string" && SHARE_JOB_ID.test(fields.jobId)
            ? { jobId: fields.jobId, shared: fields.shared }
            : null;
    }
    if (Object.hasOwn(fields, "requestId")) {
        return typeof fields.requestId === "string" && SHARE_REQUEST_ID.test(fields.requestId)
            ? { requestId: fields.requestId, shared: fields.shared }
            : null;
    }
    return null;
}
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
 * - `DELETE /api/request-history`: removes every shared copy first (500, and nothing deleted, when
 *   one cannot be removed), then every row; 204, or 500 when the delete failed.
 * - `PUT /api/request-history/share` (slice 10): body `{ jobId | requestId, shared }` (JSON, 4 KiB,
 *   its own limit after the auth; 400 for anything else). Shares the job's requests to the
 *   diagnostics folder (`diagnostics/share.ts`) or withdraws the share, and answers
 *   `RequestHistoryShareResult`: 404 when there is no such request to share, 413 when its requests
 *   are too large, 500 when the copy or the mark could not be written or a withdrawal could not
 *   remove the copy.
 * - `GET /api/request-history/shares`: `{ items }`, the shares the folder holds (also those whose
 *   rows the caps removed), newest first; 500 when `shared/` could not be read.
 *
 * Each answers 503 while the store is unavailable (it failed to open, or it is closed). The writes
 * (the share route and "Delete all") check shutdown again right before they write, after every await.
 */
export function registerRequestHistoryRoutes(
    app: Hono<AppEnv>,
    arg: {
        history: RequestHistory;
        shares: RequestShares;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        shuttingDown: () => boolean;
    },
) {
    const { history, shares, auth, limiter, shuttingDown } = arg;
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
    const closing = (c: Context<AppEnv>) => {
        c.header("Retry-After", "5");
        return c.json({ error: "The server is shutting down" }, 503);
    };
    const limitShareBody = bodyLimit({
        maxSize: SHARE_BODY_BYTES,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
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
        if (status !== undefined && !(REQUEST_HISTORY_STATUSES as readonly string[]).includes(status)) {
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

    // Before `/:id`, which would take `shares` as an id.
    app.get(REQUEST_HISTORY_SHARES_PATH, limiter, authenticated, (c) => {
        const items = shares.list();
        return items ? c.json({ items }) : c.json({ error: "The shared copies could not be read" }, 500);
    });

    app.put(REQUEST_HISTORY_SHARE_PATH, limiter, authenticated, limitShareBody, async (c) => {
        let text: string;
        try {
            text = await c.req.text();
        } catch {
            return c.json({ error: "Could not read the request body" }, 400);
        }
        // The limiter trusts a declared length; the body read is measured again.
        if (Buffer.byteLength(text, "utf8") > SHARE_BODY_BYTES) {
            return c.json({ error: "Request body too large" }, 413);
        }
        const body = parseShareBody(text);
        if (!body) {
            return c.json({ error: "Expected { jobId | requestId, shared }" }, 400);
        }
        if (shuttingDown()) {
            return closing(c);
        }
        if (!history.available()) {
            return unavailable(c);
        }
        const { shared, ...query } = body;
        const outcome = shared ? shares.share(query) : shares.withdraw(query);
        if (!outcome.ok) {
            if (outcome.status === 503) {
                return unavailable(c);
            }
            return c.json({ error: outcome.error }, outcome.status);
        }
        return c.json(outcome.result);
    });

    app.get(`${REQUEST_HISTORY_PATH}/:id`, limiter, authenticated, (c) => {
        if (!history.available()) {
            return unavailable(c);
        }
        const record = history.get(c.req.param("id"));
        return record ? c.json(record) : c.json({ error: "No such request" }, 404);
    });

    app.delete(REQUEST_HISTORY_PATH, limiter, authenticated, (c) => {
        if (shuttingDown()) {
            return closing(c);
        }
        if (!history.available()) {
            return unavailable(c);
        }
        // A shared copy must not outlive the rows: removed first, and nothing is deleted when one stays.
        if (!shares.removeAll()) {
            return c.json({ error: "The shared copies could not be removed, so nothing was deleted" }, 500);
        }
        if (history.deleteAll() === null) {
            return history.available()
                ? c.json({ error: "The request history could not be deleted" }, 500)
                : unavailable(c);
        }
        return c.body(null, 204);
    });
}
