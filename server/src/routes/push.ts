import type { Hono, MiddlewareHandler } from "hono";
import { PUSH_KEY_PATH, PUSH_SUBSCRIPTION_PATH } from "../../../shared/notifications.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { readJsonBody } from "../http/body.ts";
import type { PushService } from "../push/pushService.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";

/**
 * Browser Web Push key lookup and subscription writes backed by server/src/push/pushService.ts.
 * All routes run server/src/app.ts's authenticated limiter, then JWT authentication. PUT/DELETE
 * subscription bodies are capped at 16 KiB after auth and parsed as JSON; every answer is
 * no-store. No resource epoch is required. The app tracks subscription writes before their first
 * await and refuses them during shutdown, so admitted durable writes settle before context disposal.
 */

/** Shared public-key and subscription endpoint paths from shared/notifications.ts. */
export { PUSH_KEY_PATH, PUSH_SUBSCRIPTION_PATH };

/** A subscription is an endpoint and two keys. */
const MAX_PUSH_BODY_BYTES = 16 * 1024;

/**
 * Web Push registration, all authenticated (JWT) and rate-limited, the subscription routes
 * authenticated before their body (capped at 16 KiB) is read; every answer is `no-store`.
 *
 * - `GET /api/push/key`: `{ publicKey }`, null while push is off on the server;
 * - `PUT /api/push/subscription` `{ subscription }` (a `PushSubscription.toJSON()`): 204 once the file
 *   holds it; 400 for an invalid subscription or an endpoint outside the allowed push services; 503
 *   while push is off; 500 when the subscriptions file could not be written (nothing changed);
 * - `DELETE /api/push/subscription` `{ endpoint }`: 204 once the file no longer holds it (also when it
 *   was not registered); 500 when the file could not be written (the endpoint stays registered).
 */
export function registerPushRoutes(
    app: Hono<AppEnv>,
    arg: { push: PushService; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { push, auth, limiter } = arg;
    const limitBody = limitedBody(MAX_PUSH_BODY_BYTES);
    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        try {
            await next();
        } finally {
            c.header("Cache-Control", "no-store");
        }
    };
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };

    app.get(PUSH_KEY_PATH, noStore, limiter, authenticated, (c) => {
        return c.json({ publicKey: push.publicKey() });
    });

    app.put(PUSH_SUBSCRIPTION_PATH, noStore, limiter, authenticated, limitBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (push.publicKey() === null) {
            return c.json({ error: "Push notifications are off on this server" }, 503);
        }
        const outcome = isPlainObject(read.body) ? await push.register(read.body.subscription) : "invalid";
        switch (outcome) {
            case "ok":
                return c.body(null, 204);
            case "disabled":
                return c.json({ error: "Push notifications are off on this server" }, 503);
            case "unsaved":
                return c.json({ error: "The subscription could not be saved" }, 500);
            default:
                return c.json({ error: "Invalid push subscription" }, 400);
        }
    });

    app.delete(PUSH_SUBSCRIPTION_PATH, noStore, limiter, authenticated, limitBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body) || typeof read.body.endpoint !== "string") {
            return c.json({ error: "endpoint must be a string" }, 400);
        }
        if (!(await push.remove(read.body.endpoint))) {
            return c.json({ error: "The removal could not be saved" }, 500);
        }
        return c.body(null, 204);
    });
}
