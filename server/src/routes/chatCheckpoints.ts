import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import type { CheckpointService } from "../data/checkpointService.ts";
import type { MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { storeErrorResponse } from "./resources.ts";

export const CHAT_CHECKPOINTS_PATH = "/api/chat-checkpoints";
/** Ids, a name, and one revision token; no checkpoint content comes from the tab. */
const MAX_CHECKPOINT_BODY_BYTES = 16 * 1024;

/** Authenticated checkpoint operations; mutations require epoch and an open maintenance gate. */
export function registerChatCheckpointRoutes(
    app: Hono<AppEnv>,
    {
        service,
        auth,
        limiter,
        maintenance,
    }: {
        service: CheckpointService;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maintenance: MaintenanceGate;
    },
) {
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };
    const limitBody = bodyLimit({
        maxSize: MAX_CHECKPOINT_BODY_BYTES,
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

    app.get(CHAT_CHECKPOINTS_PATH, limiter, authenticated, (c) => {
        const result = service.list({ body: c.req.query() });
        return c.json(result.body, result.status);
    });

    for (const [path, method] of [
        ["save", "save"],
        ["rename", "rename"],
        ["delete", "remove"],
        ["load", "load"],
    ] as const) {
        app.post(`${CHAT_CHECKPOINTS_PATH}/${path}`, limiter, authenticated, limitedBody, async (c) => {
            let size: number;
            try {
                size = (await c.req.arrayBuffer()).byteLength;
            } catch {
                return c.json({ error: "Invalid JSON body" }, 400);
            }
            // The limiter trusts a declared length; also check the actual bytes received.
            if (size > MAX_CHECKPOINT_BODY_BYTES) {
                return c.json({ error: "Request body too large" }, 413);
            }
            const parsed = await readJsonBody(c);
            if (!parsed.ok) {
                return parsed.response;
            }
            try {
                maintenance.assertOpen();
                const result = service[method]({ body: parsed.body, epoch: c.req.header(RESOURCE_EPOCH_HEADER) });
                return c.json(result.body, result.status);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        });
    }
}
