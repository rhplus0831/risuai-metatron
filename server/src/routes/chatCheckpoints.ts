import type { Handler, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import type { CheckpointService } from "../data/checkpointService.ts";
import type { MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { storeErrorResponse } from "./resources.ts";

export const CHAT_CHECKPOINTS_PATH = "/api/chat-checkpoints";
/** Ids, a name, a revision token, or a policy; no checkpoint content comes from the tab. */
const MAX_CHECKPOINT_BODY_BYTES = 16 * 1024;

/**
 * Authenticated checkpoint operations; mutations require epoch and an open maintenance gate.
 * JWT and the authenticated limiter precede body reads. Writes accept at most 16 KiB of received
 * bytes after authentication (413 past it); 400 for malformed input, 404 for missing targets, 412
 * for a stale epoch, 503 with Retry-After: 5 during maintenance or shutdown. `server/src/app.ts`
 * gives every response Cache-Control: no-store, including reads and refusals. Checkpoint content
 * always comes from the server; the tab supplies ids, names, policies and revision tokens only.
 */
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

    /** GET ?characterId=&chatId= → { epoch, checkpoints }, newest first; 400 invalid ids, 404 missing chat. */
    app.get(CHAT_CHECKPOINTS_PATH, limiter, authenticated, (c) => {
        const result = service.list({ body: c.req.query() });
        return c.json(result.body, result.status);
    });
    /** GET ?characterId=&chatId= → { epoch, policy: { autoEvery, autoKeep } | null }; 400/404. */
    app.get(`${CHAT_CHECKPOINTS_PATH}/policy`, limiter, authenticated, (c) => {
        const result = service.readPolicy({ body: c.req.query() });
        return c.json(result.body, result.status);
    });

    function mutationHandler(method: "save" | "rename" | "remove" | "load" | "writePolicy"): Handler<AppEnv> {
        return async (c) => {
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
        };
    }

    for (const [path, method] of [
        ["save", "save"],
        ["rename", "rename"],
        ["delete", "remove"],
        ["load", "load"],
    ] as const) {
        /**
         * POST bodies all name { characterId, chatId } and require x-resource-epoch:
         * save adds { name } → { epoch, checkpoint }, 409 reason: "generating";
         * rename adds { id, baseRevision, name } → { epoch, checkpoint }, 409 with current revision;
         * delete adds { id, baseRevision } → { epoch, ok: true }, 409 with current revision;
         * load adds { id, chatBaseRevision } → { epoch, chatRevision, safety }, atomic replacement,
         * 409 with current revision or reason: "generating" (`data/checkpointService.ts` load).
         */
        app.post(`${CHAT_CHECKPOINTS_PATH}/${path}`, limiter, authenticated, limitedBody, mutationHandler(method));
    }
    /** PUT { characterId, chatId, autoEvery, autoKeep } or { characterId, chatId, off: true },
     * with x-resource-epoch → { epoch, policy: { autoEvery, autoKeep } | null }. */
    app.put(`${CHAT_CHECKPOINTS_PATH}/policy`, limiter, authenticated, limitedBody, mutationHandler("writePolicy"));
}
