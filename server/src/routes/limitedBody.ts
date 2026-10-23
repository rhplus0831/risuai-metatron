import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../types.ts";

/** Caps a route's body with 413, answers 400 for limiter read failures, and preserves downstream errors. */
export function limitedBody(maxSize: number, readError = "Invalid JSON body"): MiddlewareHandler<AppEnv> {
    const limitBody = bodyLimit({
        maxSize,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
    return async (c, next) => {
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
            return c.json({ error: readError }, 400);
        }
    };
}
