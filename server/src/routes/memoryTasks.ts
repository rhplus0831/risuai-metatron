import type { Hono, MiddlewareHandler } from "hono";
import {
    MEMORY_TASKS_PATH,
    type MemoryTaskCancelAnswer,
    type MemoryTaskStartAnswer,
    type MemoryTaskStartBody,
} from "../../../shared/events.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import type { MemoryTasks } from "../prompt/memory/memoryTasks.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";

export { MEMORY_TASKS_PATH };

/** The body holds two ids. */
const MAX_START_BODY_BYTES = 4 * 1024;

const REFUSAL_TEXT = {
    shuttingDown: "The server is shutting down",
    maintenance: "The server data is being replaced",
    chatGone: "Chat not found",
    queueFull: "Too many chats are waiting for their memory task",
} as const;

/**
 * The memory task routes (`shared/events.ts`), both refused with 503 `{ reason: "notEnabled" }` while
 * `enabled()` is false (no Retry-After: it is the server's configuration, not a passing state):
 *
 * - `POST /api/memory/tasks` `{ characterId, chatId }`: a manual start (`MemoryTasks.start`), answered
 *   `MemoryTaskStartAnswer`; 404 for a chat that is gone, 429 `queueFull`, 503 (`Retry-After`) during
 *   shutdown and maintenance. The body is read after authentication and capped at 4 KiB.
 * - `DELETE /api/memory/tasks/:characterId/:chatId`: cancels the chat's queued and running task and a
 *   waiting manual start, answered `MemoryTaskCancelAnswer`; 404 for a chat that is gone.
 *
 * Both are authenticated, rate-limited, and epoch-checked (412 `EpochMismatch`); 400 for an id that is
 * not a resource id. The app makes every answer `no-store` and refuses them during shutdown. The epoch check and the service call run in one synchronous step.
 */
export function registerMemoryTaskRoutes(
    app: Hono<AppEnv>,
    arg: {
        tasks: Pick<MemoryTasks, "start" | "cancel"> | null;
        enabled: () => boolean;
        store: ResourceStore;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
    },
) {
    const { tasks, enabled, store, auth, limiter } = arg;
    const limitBody = limitedBody(MAX_START_BODY_BYTES);
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };

    app.post(MEMORY_TASKS_PATH, limiter, authenticated, limitBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        for (const field of ["characterId", "chatId"] as const) {
            if (!isValidResourceId(read.body[field])) {
                return c.json({ error: `${field} must be an id` }, 400);
            }
        }
        const body = read.body as MemoryTaskStartBody;
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (!tasks || !enabled()) {
            return c.json({ error: "Memory tasks are not enabled", reason: "notEnabled" }, 503);
        }
        const result = tasks.start({ chaId: body.characterId, chatId: body.chatId });
        switch (result.outcome) {
            case "refused":
                switch (result.reason) {
                    case "chatGone":
                        return c.json({ error: REFUSAL_TEXT.chatGone }, 404);
                    case "queueFull":
                        return c.json({ error: REFUSAL_TEXT.queueFull, reason: result.reason }, 429);
                    case "shuttingDown":
                    case "maintenance":
                        c.header("Retry-After", "5");
                        return c.json({ error: REFUSAL_TEXT[result.reason], reason: result.reason }, 503);
                }
            case "running":
            case "queued":
                return c.json({ outcome: result.outcome, status: result.status } satisfies MemoryTaskStartAnswer);
            case "pendingManual":
                return c.json({ outcome: "pendingManual" } satisfies MemoryTaskStartAnswer);
        }
    });

    app.delete(`${MEMORY_TASKS_PATH}/:characterId/:chatId`, limiter, authenticated, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (!tasks || !enabled()) {
            return c.json({ error: "Memory tasks are not enabled", reason: "notEnabled" }, 503);
        }
        if (store.chatRevision(characterId, chatId) === null) {
            return c.json({ error: REFUSAL_TEXT.chatGone }, 404);
        }
        const cancelled = tasks.cancel({ chaId: characterId, chatId });
        return c.json({ cancelled } satisfies MemoryTaskCancelAnswer);
    });
}
