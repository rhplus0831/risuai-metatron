import type { Hono, MiddlewareHandler } from "hono";
import { isValidResourceId, RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";
import { storeErrorResponse } from "./resources.ts";

export const CHAT_TRASH_PATH = "/api/chat-trash";

export function registerChatTrashRoutes(
    app: Hono<AppEnv>,
    {
        store,
        auth,
        limiter,
        maintenance,
        chatHeld,
    }: {
        store: ResourceStore;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maintenance: MaintenanceGate;
        chatHeld: (characterId: string, id: string) => boolean;
    },
) {
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        await next();
    };
    const limitBody = limitedBody(16 * 1024);
    for (const action of ["trash", "restore", "delete"] as const) {
        app.post(`${CHAT_TRASH_PATH}/${action}`, limiter, authenticated, limitBody, async (c) => {
            try {
                maintenance.assertOpen();
                const parsed = await readJsonBody(c);
                maintenance.assertOpen();
                if (!parsed.ok) return parsed.response;
                const { characterId, chatId, revision } = parsed.body;
                if (
                    !isValidResourceId(characterId) ||
                    !isValidResourceId(chatId) ||
                    typeof revision !== "string" ||
                    Object.keys(parsed.body).some((key) => !["characterId", "chatId", "revision"].includes(key))
                ) {
                    return c.json({ error: "InvalidChatTrashRequest" }, 400);
                }
                const result = store.changeChatTrash(
                    action,
                    { characterId, chatId, revision },
                    c.req.header(RESOURCE_EPOCH_HEADER),
                    chatHeld,
                );
                return "error" in result ? c.json(result, 409) : c.json(result, 200);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        });
    }
}
