import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isTabTokenScope, playgroundFamily } from "../../../shared/tokenizerChoice.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody, type JsonBodyResult } from "../http/body.ts";
import type { Tokenizers } from "../prompt/tokenizers/index.ts";
import { isTokenizerTextRefusal, tokenScopeFromTab, type TokenCounter } from "../prompt/tokens.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

export const TOKEN_COUNT_PATH = "/api/tokens/count";
export const TOKEN_ENCODE_PATH = "/api/tokens/encode";
export const MAX_TOKEN_BODY_BYTES = 2 * 1024 * 1024;
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
 * limiter; 503 with `Retry-After` during maintenance or shutdown. Counts run sequentially and a
 * tokenizer's text refusal yields only that entry's `null`; other failures reach the app's 500.
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
    const limitBody = bodyLimit({
        maxSize: MAX_TOKEN_BODY_BYTES,
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

    app.post(TOKEN_COUNT_PATH, noStore, limiter, authenticated, limitedBody, async (c) => {
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
        try {
            assertOpen();
            const tokenScope = tokenScopeFromTab(scope, googleAccessToken());
            const counts: (number | null)[] = [];
            for (const text of texts) {
                try {
                    counts.push(await counter.count(text, tokenScope));
                } catch (error) {
                    if (!isTokenizerTextRefusal(error) || shuttingDown()) {
                        throw error;
                    }
                    counts.push(null);
                }
            }
            return c.json({ counts });
        } catch (error) {
            if (shuttingDown()) {
                throw new MaintenanceError("The server is shutting down");
            }
            throw error;
        }
    });

    app.post(TOKEN_ENCODE_PATH, noStore, limiter, authenticated, limitedBody, async (c) => {
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
