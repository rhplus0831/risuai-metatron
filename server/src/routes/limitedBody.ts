import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types.ts";

const TOO_LARGE = "Request body too large";

/**
 * What a route reads from a body `limitedBody` stopped: status 413 past the cap, 400 when the source
 * failed under it, with that failure as `cause`. `app.onError` answers it without logging, and the
 * limiter then sets the real answer. `drain` reads the source to its end and drops the bytes (a failed
 * read ends it too), for a route that must leave the connection usable for its answer.
 */
export class RequestBodyError extends HTTPException {
    readonly drain: () => Promise<void>;

    constructor(status: 400 | 413, message: string, drain: () => Promise<void>, cause?: unknown) {
        super(status, { message, cause });
        this.drain = drain;
    }
}

/**
 * Replaces the route's answer. It is a fresh response set over a cleared `c.res`, because the setter
 * merges the old headers onto the new response and `c.json` adds the prepared ones, and neither the
 * route's encoding and length nor a `Retry-After` describe this answer. Only `Cache-Control` and the
 * rate limit headers carry over: the wrappers inside the limiter have already answered with them.
 */
function replaceAnswer(c: Context<AppEnv>, status: 400 | 413, error: string) {
    const replaced = c.res;
    const headers = new Headers({ "content-type": "application/json" });
    for (const [name, value] of replaced.headers) {
        if (name === "cache-control" || name.startsWith("ratelimit-")) {
            headers.set(name, value);
        }
    }
    void replaced.body?.cancel().catch(() => {});
    c.res = undefined;
    c.res = new Response(JSON.stringify({ error }), { status, headers });
}

/**
 * Caps a route's body by counting it, without buffering it. A declared `Content-Length` over `maxSize`
 * is an immediate 413 with nothing read. Any other body reaches the route at once as a demand-driven
 * stream that reads its source only when the route reads, so a route that answers first (a failed
 * auth check) costs no body, and one that never reads it is refused by its declared length alone. The
 * stream passes exactly `maxSize` bytes and errors with `RequestBodyError` past that or when the source
 * fails.
 *
 * Those two recorded facts decide the response after the route has run, whatever it answered or
 * threw meanwhile: 413 `{ error: "Request body too large" }` on overflow, which wins over everything
 * else, then the configured 400 `{ error: readError }` on a source failure. With neither, the route's
 * own answer stands, an error included. The limiter assigns `c.res` instead of returning the answer
 * because Hono's `compose` drops a value returned once the route has answered.
 */
export function limitedBody(maxSize: number, readError = "Invalid JSON body"): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const original = c.req.raw;
        const source = original.body;
        if (!source) {
            return next();
        }
        const { headers } = original;
        if (!headers.has("transfer-encoding") && parseInt(headers.get("content-length") || "0", 10) > maxSize) {
            return c.json({ error: TOO_LARGE }, 413);
        }

        const reader = source.getReader();
        const drain = async () => {
            try {
                while (!(await reader.read()).done) {
                    // Dropped.
                }
            } catch {
                // A failed read is the end of the body too.
            }
        };
        let size = 0;
        let overflowed = false;
        let sourceFailed = false;
        const body = new ReadableStream<Uint8Array>(
            {
                async pull(controller) {
                    const read = await reader.read().catch((cause: unknown) => {
                        sourceFailed = true;
                        controller.error(new RequestBodyError(400, readError, drain, cause));
                        return null;
                    });
                    if (!read) {
                        return;
                    }
                    if (read.done) {
                        controller.close();
                        return;
                    }
                    size += read.value.byteLength;
                    if (size > maxSize) {
                        overflowed = true;
                        controller.error(new RequestBodyError(413, TOO_LARGE, drain));
                        return;
                    }
                    controller.enqueue(read.value);
                },
                cancel(reason) {
                    return reader.cancel(reason);
                },
            },
            { highWaterMark: 0 },
        );
        const counted = new Request(original, { body, duplex: "half" } as RequestInit);
        // A new request's signal follows its source only while that request object lives, and work that
        // outlives the handler (a streamed LLM answer, a proxied body) keeps the signal alone, so after
        // a garbage collection a disconnect would no longer reach it. The source's own signal has no
        // such link.
        Object.defineProperty(counted, "signal", { value: original.signal });
        c.req.raw = counted;

        try {
            await next();
        } catch (error) {
            // `compose` turns a route's `Error` into an answer before this point, so this is another
            // thrown value, or a call without `compose`.
            if (!overflowed && !sourceFailed) {
                throw error;
            }
        }
        if (overflowed) {
            // After the route, so that it could drain first; never awaited, so the answer is not held.
            void reader.cancel().catch(() => {});
        }
        if (overflowed || sourceFailed) {
            replaceAnswer(c, overflowed ? 413 : 400, overflowed ? TOO_LARGE : readError);
        }
    };
}
