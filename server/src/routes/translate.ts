import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import type { TranslateMessageRequest, TranslationRunner } from "../translation/runner.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

export const TRANSLATE_MESSAGE_PATH = "/api/translate/message";

/** The body holds ids and a flag only. */
const MAX_TRANSLATE_BODY_BYTES = 16 * 1024;

const ID_FIELDS = ["characterId", "chatId", "messageId", "presetId", "modelPresetId", "personaId"] as const;

function parseTranslateMessage(body: Record<string, unknown>): TranslateMessageRequest | string {
    for (const field of ID_FIELDS) {
        if (!isValidResourceId(body[field])) {
            return `${field} must be an id`;
        }
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
        return "force must be a boolean";
    }
    return {
        characterId: body.characterId as string,
        chatId: body.chatId as string,
        messageId: body.messageId as string,
        presetId: body.presetId as string,
        modelPresetId: body.modelPresetId as string,
        personaId: body.personaId as string,
        force: body.force === true,
    };
}

/**
 * `POST /api/translate/message` (`docs/plan/translation.md` slice 1.3): translates one stored message
 * on the server (`server/src/translation/runner.ts`) and answers `{ outcome, translation }` as JSON
 * (`applied`, `ignored` with `translation: null`, or `fresh`). The body is `{ characterId, chatId,
 * messageId, presetId, modelPresetId, personaId, force? }`, the ids the chat displays with
 * (`chatDisplayIds`). Authenticated before the body is read, rate-limited, the body capped at 16
 * KiB, the resource epoch checked (412 `EpochMismatch`). The run does not end when the tab goes
 * away. 404 for a chat, message, preset, model preset, or persona that is gone; 409 `generating`
 * (a generation owns the message), `chatBindingMismatch` (an id that is not the chat's bound one),
 * or a chat replaced meanwhile; 429 past the running cap; 502 when the translation request failed;
 * 503 during maintenance and shutdown (`Retry-After`); 504 past the deadline.
 */
export function registerTranslateRoutes(
    app: Hono<AppEnv>,
    arg: { runner: TranslationRunner; store: ResourceStore; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { runner, store, auth, limiter } = arg;
    const limitBody = bodyLimit({
        maxSize: MAX_TRANSLATE_BODY_BYTES,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };

    app.post(TRANSLATE_MESSAGE_PATH, limiter, authenticated, limitBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const body = parseTranslateMessage(read.body);
        if (typeof body === "string") {
            return c.json({ error: body }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        const result = await runner.translate(body);
        c.header("Cache-Control", "no-store");
        if (result.ok) {
            return c.json({ outcome: result.outcome, translation: result.translation });
        }
        if (result.status === 503) {
            c.header("Retry-After", "5");
        }
        return c.json(
            { error: result.error, ...(result.problems ? { problems: result.problems } : {}) },
            result.status,
        );
    });
}
