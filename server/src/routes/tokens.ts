import type { Context, Hono, MiddlewareHandler } from "hono";
import { isTabTokenScope, playgroundFamily } from "../../../shared/tokenizerChoice.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody, type JsonBodyResult } from "../http/body.ts";
import type { Tokenizers } from "../prompt/tokenizers/index.ts";
import { isTokenizerTextRefusal, tokenScopeFromTab, type TokenCounter } from "../prompt/tokens.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";

/** Count endpoint exempted from the app's global body cap in favor of its authenticated cap. */
export const TOKEN_COUNT_PATH = "/api/tokens/count";
/** Playground endpoint sharing the count route's authenticated body cap. */
export const TOKEN_ENCODE_PATH = "/api/tokens/encode";
/** Both token routes bound the actual UTF-8 body bytes after authentication, independent of declared length. */
export const MAX_TOKEN_BODY_BYTES = 2 * 1024 * 1024;
/** Bounds a count batch, including repeated texts; exceeding it is 413. */
export const MAX_TOKEN_TEXTS = 512;

async function readTokenBody(c: Context<AppEnv>): Promise<JsonBodyResult> {
    let size: number;
    try {
        size = (await c.req.arrayBuffer()).byteLength;
    } catch {
        return { ok: false, response: c.json({ error: "Invalid JSON body" }, 400) };
    }
    // The limiter trusts a declared length; measure the bytes that arrived.
    if (size > MAX_TOKEN_BODY_BYTES) {
        return { ok: false, response: c.json({ error: "Request body too large" }, 413) };
    }
    const read = await readJsonBody(c);
    if (read.ok && !isPlainObject(read.body)) {
        return { ok: false, response: c.json({ error: "The body must be an object" }, 400) };
    }
    return read;
}

/**
 * Token counts for the tab's scope and ids for its tokenizer playground, sharing the app's counter
 * and tokenizers. Rate-limited, authenticated before reading, capped at 2 MiB of actual bytes,
 * every answer `no-store`. No epoch header: neither route writes. 400 for malformed bodies/scopes
 * or a refused encode text; 413 over the body cap or 512 count texts; 429 from the authenticated
 * limiter; 503 with `Retry-After: 5` during maintenance or shutdown. Counts run sequentially and a
 * tokenizer's text refusal yields only that entry's `null`; other failures reach the app's 500.
 * A disconnect ends this caller's batch and detaches its wait from a coalesced Google count
 * (`server/src/prompt/tokens.ts`); the disconnect aborts that fetch only when no other caller still waits.
 * Count bodies { scope: TabTokenScope, texts } answer { counts }; encode bodies { tokenizer, text }
 * answer { ids } using `shared/tokenizerChoice.ts` playgroundFamily for the tab's tokenizer family.
 * Requests hold no maintenance lease, so shutdown does not wait for remote Google counts.
 */
export function registerTokenRoutes(
    app: Hono<AppEnv>,
    arg: {
        counter: TokenCounter;
        tokenizers: Tokenizers;
        googleAccessToken: () => string | undefined;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maintenance: MaintenanceGate;
        shuttingDown: () => boolean;
    },
) {
    const { counter, tokenizers, googleAccessToken, auth, limiter, maintenance, shuttingDown } = arg;
    const assertOpen = () => {
        if (shuttingDown()) {
            throw new MaintenanceError("The server is shutting down");
        }
        maintenance.assertOpen();
    };
    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        await next();
        c.header("Cache-Control", "no-store");
    };
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        assertOpen();
        await next();
    };
    const limitBody = limitedBody(MAX_TOKEN_BODY_BYTES);

    app.post(TOKEN_COUNT_PATH, noStore, limiter, authenticated, limitBody, async (c) => {
        const read = await readTokenBody(c);
        if (!read.ok) {
            return read.response;
        }
        const { scope, texts } = read.body;
        if (!isTabTokenScope(scope)) {
            return c.json({ error: "scope must be the tab's tokenizer scope" }, 400);
        }
        if (!Array.isArray(texts) || !texts.every((text) => typeof text === "string")) {
            return c.json({ error: "texts must be an array of strings" }, 400);
        }
        if (texts.length > MAX_TOKEN_TEXTS) {
            return c.json({ error: "Too many texts" }, 413);
        }
        const signal = c.req.raw.signal;
        try {
            assertOpen();
            const tokenScope = tokenScopeFromTab(scope, googleAccessToken());
            const counts: (number | null)[] = [];
            for (const text of texts) {
                if (signal.aborted) {
                    break;
                }
                try {
                    counts.push(await counter.count(text, tokenScope, signal));
                } catch (error) {
                    if (!isTokenizerTextRefusal(error) || shuttingDown() || signal.aborted) {
                        throw error;
                    }
                    counts.push(null);
                }
            }
            signal.throwIfAborted();
            return c.json({ counts });
        } catch (error) {
            if (shuttingDown()) {
                throw new MaintenanceError("The server is shutting down");
            }
            if (signal.aborted) {
                return c.json({ error: "The request was aborted" }, 400);
            }
            throw error;
        }
    });

    app.post(TOKEN_ENCODE_PATH, noStore, limiter, authenticated, limitBody, async (c) => {
        const read = await readTokenBody(c);
        if (!read.ok) {
            return read.response;
        }
        const { tokenizer, text } = read.body;
        if (typeof tokenizer !== "string" || typeof text !== "string") {
            return c.json({ error: "tokenizer and text must be strings" }, 400);
        }
        try {
            assertOpen();
            if (c.req.raw.signal.aborted) {
                return c.json({ error: "The request was aborted" }, 400);
            }
            const ids = await tokenizers.encode(playgroundFamily(tokenizer), text);
            return c.json({ ids: Array.from(ids) });
        } catch (error) {
            if (shuttingDown()) {
                throw new MaintenanceError("The server is shutting down");
            }
            if (isTokenizerTextRefusal(error)) {
                return c.json({ error: error.message }, 400);
            }
            throw error;
        }
    });
}
