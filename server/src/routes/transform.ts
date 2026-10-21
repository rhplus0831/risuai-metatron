import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CbsConditions } from "../../../shared/cbs/types.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    MAX_TRANSFORM_BODY_BYTES,
    MAX_TRANSFORM_REQUEST_TEXT_BYTES,
    MAX_TRANSFORM_TARGETS,
    MAX_TRANSFORM_TEXT_BYTES,
    TRANSFORM_TARGET_KINDS,
    type TransformContinueRequest,
    type TransformRequest,
    type TransformTarget,
} from "../../../shared/transform.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import { GenerationRunnerError } from "../jobs/generationJobs.ts";
import { ChatBindingError } from "../jobs/jobScope.ts";
import {
    TransformRequestError,
    TransformSnapshotError,
    type TransformService,
    TransformUnavailableError,
} from "../prompt/transform.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { parseClientEnv } from "./generations.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The routes' paths (the app's global body limiter leaves them to their own, after authentication). */
export const TRANSFORM_PATHS: readonly string[] = ["/api/transform", "/api/transform/continue"];

/** A correlation id or a handler-set value: a short string. */
const MAX_ID_CHARS = 128;
const MAX_HANDLERS_CHARS = 256;
const MAX_ERROR_CHARS = 2048;

const isShortString = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max;

/** `cbsConditions`: `firstmsg` a boolean, `chatRole` a short string, nothing else. */
function parseConditions(value: unknown): CbsConditions | string {
    if (!isPlainObject(value)) {
        return "cbsConditions must be an object";
    }
    const out: CbsConditions = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === "firstmsg" && typeof entry === "boolean") {
            out.firstmsg = entry;
        } else if (key === "chatRole" && (entry === null || (typeof entry === "string" && entry.length <= 32))) {
            if (entry !== null) {
                out.chatRole = entry;
            }
        } else {
            return `cbsConditions.${key} is not a condition`;
        }
    }
    return out;
}

export function parseTransformRequest(body: Record<string, unknown>): TransformRequest | string {
    if (!isValidResourceId(body.clientId)) {
        return "clientId must be a resource id";
    }
    if (body.mode !== "editdisplay" && body.mode !== "editprocess") {
        return "mode must be editdisplay or editprocess";
    }
    const context = body.context;
    if (!isPlainObject(context)) {
        return "context must be an object";
    }
    for (const key of [
        "characterId",
        "chatId",
        "presetId",
        "modelPresetId",
        "personaId",
        "selectedPersonaId",
    ] as const) {
        if (!isValidResourceId(context[key])) {
            return `context.${key} must be a resource id`;
        }
    }
    let client: TransformRequest["client"];
    if (body.client !== undefined) {
        const parsed = parseClientEnv(body.client);
        if (typeof parsed === "string") {
            return parsed.replace("context.client", "client");
        }
        // The emotions are not read by a render.
        client = { viewport: parsed.viewport, browserLanguage: parsed.browserLanguage };
    }
    if (body.handlers !== undefined && !isShortString(body.handlers, MAX_HANDLERS_CHARS)) {
        return `handlers must be a string of at most ${MAX_HANDLERS_CHARS} characters`;
    }
    if (!Array.isArray(body.targets) || body.targets.length === 0 || body.targets.length > MAX_TRANSFORM_TARGETS) {
        return `targets must hold 1 to ${MAX_TRANSFORM_TARGETS} targets`;
    }
    const ids = new Set<string>();
    let bytes = 0;
    const targets: TransformTarget[] = [];
    for (const [index, value] of body.targets.entries()) {
        if (!isPlainObject(value)) {
            return `targets[${index}] must be an object`;
        }
        if (!isShortString(value.id, MAX_ID_CHARS) || ids.has(value.id)) {
            return `targets[${index}].id must be a unique string of at most ${MAX_ID_CHARS} characters`;
        }
        ids.add(value.id);
        if (!TRANSFORM_TARGET_KINDS.includes(value.kind as TransformTarget["kind"])) {
            return `targets[${index}].kind is not a target kind`;
        }
        if (!isValidResourceId(value.sourceId)) {
            return `targets[${index}].sourceId must be a resource id`;
        }
        if (typeof value.chatIndex !== "number" || !Number.isSafeInteger(value.chatIndex) || value.chatIndex < -1) {
            return `targets[${index}].chatIndex must be an integer of -1 or more`;
        }
        if (value.kind === "message" ? !isValidResourceId(value.messageId) : value.messageId !== undefined) {
            return `targets[${index}].messageId must be a message id for a message target, and absent otherwise`;
        }
        if (typeof value.source !== "string") {
            return `targets[${index}].source must be a string`;
        }
        const size = Buffer.byteLength(value.source);
        if (size > MAX_TRANSFORM_TEXT_BYTES) {
            return `targets[${index}].source is over ${MAX_TRANSFORM_TEXT_BYTES} bytes`;
        }
        bytes += size;
        let cbsConditions: CbsConditions | undefined;
        if (value.cbsConditions !== undefined) {
            const parsed = parseConditions(value.cbsConditions);
            if (typeof parsed === "string") {
                return `targets[${index}].${parsed}`;
            }
            cbsConditions = parsed;
        }
        if (value.noCache !== undefined && typeof value.noCache !== "boolean") {
            return `targets[${index}].noCache must be a boolean`;
        }
        targets.push({
            id: value.id,
            kind: value.kind as TransformTarget["kind"],
            sourceId: value.sourceId,
            chatIndex: value.chatIndex,
            ...(value.kind === "message" ? { messageId: value.messageId as string } : {}),
            source: value.source,
            ...(cbsConditions ? { cbsConditions } : {}),
            ...(value.noCache ? { noCache: true } : {}),
        });
    }
    if (bytes > MAX_TRANSFORM_REQUEST_TEXT_BYTES) {
        return `the targets' sources are over ${MAX_TRANSFORM_REQUEST_TEXT_BYTES} bytes together`;
    }
    return {
        clientId: body.clientId,
        mode: body.mode,
        context: {
            characterId: context.characterId as string,
            chatId: context.chatId as string,
            presetId: context.presetId as string,
            modelPresetId: context.modelPresetId as string,
            personaId: context.personaId as string,
            selectedPersonaId: context.selectedPersonaId as string,
        },
        ...(client ? { client } : {}),
        targets,
        ...(body.handlers !== undefined ? { handlers: body.handlers as string } : {}),
    };
}

export function parseTransformContinue(body: Record<string, unknown>): TransformContinueRequest | string {
    if (!isValidResourceId(body.clientId)) {
        return "clientId must be a resource id";
    }
    if (!isShortString(body.snapshotId, MAX_ID_CHARS)) {
        return "snapshotId must be a string";
    }
    if (!Array.isArray(body.texts) || body.texts.length === 0 || body.texts.length > MAX_TRANSFORM_TARGETS) {
        return `texts must hold 1 to ${MAX_TRANSFORM_TARGETS} entries`;
    }
    let bytes = 0;
    const texts: TransformContinueRequest["texts"] = [];
    for (const [index, value] of body.texts.entries()) {
        if (!isPlainObject(value) || !isShortString(value.id, MAX_ID_CHARS)) {
            return `texts[${index}] must be { id, text } or { id, error }`;
        }
        if (typeof value.text === "string" && value.error === undefined) {
            const size = Buffer.byteLength(value.text);
            if (size > MAX_TRANSFORM_TEXT_BYTES) {
                return `texts[${index}].text is over ${MAX_TRANSFORM_TEXT_BYTES} bytes`;
            }
            bytes += size;
            texts.push({ id: value.id, text: value.text });
        } else if (typeof value.error === "string" && value.text === undefined) {
            texts.push({ id: value.id, error: value.error.slice(0, MAX_ERROR_CHARS) });
        } else {
            return `texts[${index}] must be { id, text } or { id, error }`;
        }
    }
    if (bytes > MAX_TRANSFORM_REQUEST_TEXT_BYTES) {
        return `the texts are over ${MAX_TRANSFORM_REQUEST_TEXT_BYTES} bytes together`;
    }
    return { clientId: body.clientId, snapshotId: body.snapshotId, texts };
}

/**
 * The script transform: `POST /api/transform` (a `TransformRequest`) and
 * `POST /api/transform/continue` (the second call after the tab's plugin handlers), both answering
 * a `TransformResponse` as JSON. Authenticated, rate-limited, the body capped at
 * `MAX_TRANSFORM_BODY_BYTES`, the resource epoch checked (412 `EpochMismatch`). A render writes
 * nothing, so it does not hold the maintenance gate: a maintenance stops it (503, `Retry-After`). A
 * missing chat, preset, or persona is 404; a snapshot that is gone is 409 `SnapshotExpired`; an id
 * that is not the chat's bound one (the display rule) is 409 `chatBindingMismatch`.
 */
export function registerTransformRoutes(
    app: Hono<AppEnv>,
    arg: { transforms: TransformService; store: ResourceStore; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { transforms, store, auth, limiter } = arg;
    const limitBody = bodyLimit({
        maxSize: MAX_TRANSFORM_BODY_BYTES,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });

    /** Authentication before the body is read. */
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };

    const answer = async <T>(
        c: Parameters<MiddlewareHandler<AppEnv>>[0],
        parse: (body: Record<string, unknown>) => T | string,
        run: (body: T, signal: AbortSignal) => Promise<unknown>,
    ) => {
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const body = parse(read.body);
        if (typeof body === "string") {
            return c.json({ error: body }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            return c.json(await run(body, c.req.raw.signal));
        } catch (error) {
            if (error instanceof TransformUnavailableError) {
                c.header("Retry-After", "5");
                return c.json({ error: error.message }, 503);
            }
            if (error instanceof TransformSnapshotError) {
                return c.json({ error: "SnapshotExpired" }, 409);
            }
            if (error instanceof TransformRequestError) {
                return c.json({ error: error.message }, 400);
            }
            if (error instanceof ChatBindingError) {
                return c.json(error.refusal, 409);
            }
            if (error instanceof GenerationRunnerError && error.status === 404) {
                return c.json({ error: error.message }, 404);
            }
            if (c.req.raw.signal.aborted) {
                // The tab went away: nobody reads the answer.
                return c.json({ error: "The request was aborted" }, 400);
            }
            throw error;
        }
    };

    app.post(TRANSFORM_PATHS[0], limiter, authenticated, limitBody, (c) =>
        answer(c, parseTransformRequest, (body, signal) => transforms.transform(body, signal)),
    );
    app.post(TRANSFORM_PATHS[1], limiter, authenticated, limitBody, (c) =>
        answer(c, parseTransformContinue, (body, signal) => transforms.resume(body, signal)),
    );
}
