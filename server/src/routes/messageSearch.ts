import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
    MESSAGE_SEARCH_DEFAULT_LIMIT,
    MESSAGE_SEARCH_MAX_LIMIT,
    MESSAGE_SEARCH_MAX_QUERY,
    MESSAGE_SEARCH_MIN_QUERY,
    MESSAGE_SEARCH_PATH,
    type MessageSearchEpochConflict,
    type MessageSearchPage,
} from "../../../shared/messageSearch.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { MessageSearchPosition } from "../data/chatStore.ts";
import {
    isValidResourceId,
    MessageSearchEpochError,
    type MessageSearchLimits,
    type ResourceStore,
} from "../data/resourceStore.ts";
import type { MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { storeErrorResponse } from "./resources.ts";

export { MESSAGE_SEARCH_PATH };

/** The body holds a query of at most 200 code points, two ids, and a cursor. */
const MAX_SEARCH_BODY_BYTES = 4 * 1024;

/**
 * The scan's bounds and the concurrency cap, each replaceable (tests inject small limits and a
 * `yieldTurn` latch): 64 MiB of message JSON per request, 500 units and 4 MiB per batch, a
 * `setImmediate` turn between batches, and two searches at once server-wide (Decision 17).
 */
export type MessageSearchRouteOptions = Partial<MessageSearchLimits> & { maxConcurrent?: number };

const DEFAULT_LIMITS: MessageSearchLimits & { maxConcurrent: number } = {
    budgetBytes: 64 * 1024 * 1024,
    batchRows: 500,
    batchBytes: 4 * 1024 * 1024,
    yieldTurn: () => new Promise<void>((resolve) => setImmediate(resolve)),
    maxConcurrent: 2,
};

function resolveLimits(options: MessageSearchRouteOptions = {}) {
    const limits = { ...DEFAULT_LIMITS };
    for (const key of ["budgetBytes", "batchRows", "batchBytes", "maxConcurrent"] as const) {
        const value = options[key];
        if (value !== undefined) {
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new TypeError(`messageSearch.${key} must be a positive integer`);
            }
            limits[key] = value;
        }
    }
    if (options.yieldTurn) {
        limits.yieldTurn = options.yieldTurn;
    }
    return limits;
}

/** A UTF-16 surrogate without its pair (as `isValidResourceId` refuses in ids). */
const loneSurrogateRegex = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const QUERY_FIELDS = new Set(["query", "characterId", "chatId", "cursor", "limit"]);

/** The cursor's wire form: base64url of the JSON `[chatSeq, messageId, position]`. */
function encodeCursor(position: MessageSearchPosition): string {
    return Buffer.from(JSON.stringify([position.chatSeq, position.messageId, position.position]), "utf8").toString(
        "base64url",
    );
}

/**
 * A cursor this server issued, or null. Node's decoder skips characters outside the alphabet, so
 * only the canonical spelling of a well-formed value is accepted (it re-encodes to itself).
 */
function decodeCursor(cursor: string): MessageSearchPosition | null {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(cursor, "base64url")));
    } catch {
        return null;
    }
    if (!Array.isArray(value) || value.length !== 3) {
        return null;
    }
    const [chatSeq, messageId, position] = value as unknown[];
    if (
        !Number.isSafeInteger(chatSeq) ||
        (chatSeq as number) < 1 ||
        !isValidResourceId(messageId) ||
        !Number.isSafeInteger(position) ||
        (position as number) < 0
    ) {
        return null;
    }
    const decoded = { chatSeq: chatSeq as number, messageId, position: position as number };
    return encodeCursor(decoded) === cursor ? decoded : null;
}

type ParsedQuery = {
    query: string;
    characterId?: string;
    chatId?: string;
    cursor: MessageSearchPosition | null;
    limit: number;
};

function parseSearchQuery(body: Record<string, unknown>): ParsedQuery | string {
    for (const field of Object.keys(body)) {
        if (!QUERY_FIELDS.has(field)) {
            return `Unknown field: ${field}`;
        }
    }
    if (typeof body.query !== "string") {
        return "query must be a string";
    }
    // SQLite and JavaScript disagree on NUL and lone surrogates, so the snippet could not find the match.
    if (loneSurrogateRegex.test(body.query) || body.query.includes("\0")) {
        return "query must be well-formed text without NUL";
    }
    const query = body.query.normalize("NFC").trim();
    const length = [...query].length;
    if (length < MESSAGE_SEARCH_MIN_QUERY || length > MESSAGE_SEARCH_MAX_QUERY) {
        return `query must be ${MESSAGE_SEARCH_MIN_QUERY} to ${MESSAGE_SEARCH_MAX_QUERY} characters`;
    }
    if (body.characterId !== undefined && !isValidResourceId(body.characterId)) {
        return "characterId must be an id";
    }
    if (body.chatId !== undefined && !isValidResourceId(body.chatId)) {
        return "chatId must be an id";
    }
    if (body.chatId !== undefined && body.characterId === undefined) {
        return "chatId needs characterId";
    }
    let cursor: MessageSearchPosition | null = null;
    if (body.cursor !== undefined) {
        cursor = typeof body.cursor === "string" ? decodeCursor(body.cursor) : null;
        if (!cursor) {
            return "Invalid cursor";
        }
    }
    let limit = MESSAGE_SEARCH_DEFAULT_LIMIT;
    if (body.limit !== undefined) {
        if (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1) {
            return "limit must be a positive integer";
        }
        limit = Math.min(body.limit as number, MESSAGE_SEARCH_MAX_LIMIT);
    }
    return {
        query,
        ...(body.characterId !== undefined ? { characterId: body.characterId as string } : {}),
        ...(body.chatId !== undefined ? { chatId: body.chatId as string } : {}),
        cursor,
        limit,
    };
}

/**
 * `POST /api/chats/search` (`docs/plan/search.md` slice 4a): one page of a message search over the
 * stored chats (`store.searchMessages`; the body is `MessageSearchQuery`, the answer
 * `MessageSearchPage`, both in `shared/messageSearch.ts`). Rate-limited, authenticated before the
 * body is read, the body capped at 4 KiB of actual bytes (the app's 100 MiB limit is skipped for
 * it), every answer `no-store`. No epoch header: it is a read. 400 for a bad body (query under 2 or
 * over 200 code points after NFC and trimming, NUL or ill-formed text, an unknown field, a bad
 * cursor or id, `chatId` without `characterId`, a non-positive `limit`; a larger one is clamped to
 * 100) and for a request whose client went away; 404 for a named character or chat that does not
 * exist; 409 `{ reason: "epoch" }` when a restore replaced the data during the scan (search again);
 * 429 past `maxConcurrent` running searches; 503 with `Retry-After` during maintenance (checked at
 * admission and between batches) and once the store closed. The app tracks the handler like a
 * resource handler, so shutdown waits for a running search; maintenance does not.
 */
export function registerMessageSearchRoutes(
    app: Hono<AppEnv>,
    arg: {
        store: ResourceStore;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maintenance: MaintenanceGate;
        limits?: MessageSearchRouteOptions;
    },
) {
    const { store, auth, limiter, maintenance } = arg;
    const { maxConcurrent, ...limits } = resolveLimits(arg.limits);
    /** Searches of this server context running now. */
    let running = 0;

    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        await next();
        c.header("Cache-Control", "no-store");
    };
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };
    const limitBody = bodyLimit({
        maxSize: MAX_SEARCH_BODY_BYTES,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
    const limitedBody: MiddlewareHandler<AppEnv> = async (c, next) => {
        let downstream = false;
        try {
            return await limitBody(c, async () => {
                downstream = true;
                await next();
            });
        } catch (error) {
            if (downstream) {
                throw error;
            }
            return c.json({ error: "Invalid JSON body" }, 400);
        }
    };

    app.post(MESSAGE_SEARCH_PATH, noStore, limiter, authenticated, limitedBody, async (c) => {
        let size: number;
        try {
            size = (await c.req.arrayBuffer()).byteLength;
        } catch {
            return c.json({ error: "Invalid JSON body" }, 400);
        }
        // The limiter trusts a declared length; measure the bytes that arrived.
        if (size > MAX_SEARCH_BODY_BYTES) {
            return c.json({ error: "Request body too large" }, 413);
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const request = parseSearchQuery(read.body);
        if (typeof request === "string") {
            return c.json({ error: request }, 400);
        }
        const signal = c.req.raw.signal;
        try {
            maintenance.assertOpen();
        } catch (error) {
            return storeErrorResponse(c, error);
        }
        if (running >= maxConcurrent) {
            c.header("Retry-After", "1");
            return c.json({ error: "Too many searches are running" }, 429);
        }
        running += 1;
        try {
            const outcome = await store.searchMessages(request, {
                ...limits,
                signal,
                between: () => maintenance.assertOpen(),
            });
            if ("notFound" in outcome) {
                return c.json(
                    { error: outcome.notFound === "chat" ? "The chat does not exist" : "The character does not exist" },
                    404,
                );
            }
            const page: MessageSearchPage = {
                hits: outcome.hits,
                next: outcome.next ? encodeCursor(outcome.next) : null,
                scannedBytes: outcome.scannedBytes,
            };
            return c.json(page);
        } catch (error) {
            if (error instanceof MessageSearchEpochError) {
                const body: MessageSearchEpochConflict = { error: error.message, reason: "epoch" };
                return c.json(body, 409);
            }
            if (signal.aborted) {
                // The tab went away: nobody reads the answer.
                return c.json({ error: "The request was aborted" }, 400);
            }
            return storeErrorResponse(c, error);
        } finally {
            running -= 1;
        }
    });
}
