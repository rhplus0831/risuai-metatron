import type { Hono, MiddlewareHandler } from "hono";
import {
    GENERATION_KINDS,
    type GenerationClientEnv,
    type GenerationCommand,
    type GenerationContext,
    type GenerationCreateBody,
    MAX_COMMAND_DATA_BYTES,
} from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isValidResourceId } from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import { parseGenerationHooks } from "../jobs/channel.ts";
import type { GenerationJobs } from "../jobs/generationJobs.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_BROWSER_LANGUAGE_CHARS = 64;
const MAX_VIEWPORT_PX = 1_000_000;

/** `context.client`: a viewport of finite, non-negative sizes and a short language tag. */
function parseClientEnv(value: unknown): GenerationClientEnv | string {
    if (!isPlainObject(value) || !isPlainObject(value.viewport)) {
        return "context.client must be { viewport: { width, height }, browserLanguage }";
    }
    const { width, height } = value.viewport;
    for (const size of [width, height]) {
        if (typeof size !== "number" || !Number.isFinite(size) || size < 0 || size > MAX_VIEWPORT_PX) {
            return "context.client.viewport sizes must be finite non-negative numbers";
        }
    }
    if (typeof value.browserLanguage !== "string" || value.browserLanguage.length > MAX_BROWSER_LANGUAGE_CHARS) {
        return `context.client.browserLanguage must be a string of at most ${MAX_BROWSER_LANGUAGE_CHARS} characters`;
    }
    return {
        viewport: { width: width as number, height: height as number },
        browserLanguage: value.browserLanguage,
    };
}

/** `command`: required for a `command` job, refused for every other kind. Data only: no code, no permission. */
function parseCommand(kind: string, value: unknown): GenerationCommand | undefined | string {
    if (kind !== "command") {
        return value === undefined ? undefined : "command is only for a command job";
    }
    if (!isPlainObject(value) || value.type !== "button" || typeof value.data !== "string") {
        return 'command must be { type: "button", data: string }';
    }
    if (Buffer.byteLength(value.data, "utf8") > MAX_COMMAND_DATA_BYTES) {
        return `command.data must be at most ${MAX_COMMAND_DATA_BYTES} bytes`;
    }
    return { type: "button", data: value.data };
}

/** Checks a create body; returns the reason as a string when it is malformed. */
function parseCreateBody(body: unknown): GenerationCreateBody | string {
    if (!isPlainObject(body)) {
        return "Body must be an object";
    }
    if (typeof body.kind !== "string" || !GENERATION_KINDS.includes(body.kind as GenerationCreateBody["kind"])) {
        return "kind must be one of " + GENERATION_KINDS.join(", ");
    }
    if (!isValidResourceId(body.clientId)) {
        return "clientId must be a valid id";
    }
    const context = body.context;
    if (!isPlainObject(context)) {
        return "context must be an object";
    }
    if (!isValidResourceId(context.characterId) || !isValidResourceId(context.chatId)) {
        return "context must name a valid characterId and chatId";
    }
    for (const field of ["presetId", "personaId"] as const) {
        if (context[field] !== null && !isValidResourceId(context[field])) {
            return `context.${field} must be an id or null`;
        }
    }
    if (typeof context.mode !== "string" || typeof context.input !== "string") {
        return "context.mode and context.input must be strings";
    }
    if (typeof context.chatRevision !== "string") {
        return "context.chatRevision must be a string";
    }
    for (const field of ["continueMessageId", "speakerChaId", "triggerId"] as const) {
        if (context[field] !== undefined && !isValidResourceId(context[field])) {
            return `context.${field} must be an id when present`;
        }
    }
    if (
        context.selectedPersonaId !== undefined &&
        context.selectedPersonaId !== null &&
        !isValidResourceId(context.selectedPersonaId)
    ) {
        return "context.selectedPersonaId must be an id or null when present";
    }
    const client = context.client === undefined ? undefined : parseClientEnv(context.client);
    if (typeof client === "string") {
        return client;
    }
    const command = parseCommand(body.kind, body.command);
    if (typeof command === "string") {
        return command;
    }
    const parsed: GenerationContext = {
        characterId: context.characterId,
        chatId: context.chatId,
        presetId: context.presetId as string | null,
        personaId: context.personaId as string | null,
        mode: context.mode,
        input: context.input,
        chatRevision: context.chatRevision,
        ...(context.continueMessageId !== undefined ? { continueMessageId: context.continueMessageId as string } : {}),
        ...(context.speakerChaId !== undefined ? { speakerChaId: context.speakerChaId as string } : {}),
        ...(context.triggerId !== undefined ? { triggerId: context.triggerId as string } : {}),
        ...(context.selectedPersonaId !== undefined
            ? { selectedPersonaId: context.selectedPersonaId as string | null }
            : {}),
        ...(client !== undefined ? { client } : {}),
    };
    const hooks = parseGenerationHooks(body.hooks);
    if (typeof hooks === "string") {
        return hooks;
    }
    const base = { context: parsed, hooks, clientId: body.clientId };
    return command !== undefined
        ? { ...base, kind: "command", command }
        : { ...base, kind: body.kind as Exclude<GenerationCreateBody["kind"], "command"> };
}

/**
 * `/api/generations` (Phase 5, `generation-jobs`): `POST` creates a job (`{ jobId }`; 409
 * `chatBusy` with the running job's id, 409 `stale`, 404, 412 for another epoch, 503 while the
 * server shuts down or a restore runs), `GET /:id?clientId=` is the owner's status, and
 * `DELETE /:id?clientId=` aborts it. Another client's job is a 404. The socket is
 * `/api/generations/:id/ws` (`generationJobs.handleUpgrade`). Responses are never cached.
 */
export function registerGenerationRoutes(
    app: Hono<AppEnv>,
    arg: { jobs: GenerationJobs; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { jobs, auth, limiter } = arg;
    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        await next();
        c.header("Cache-Control", "no-store");
    };
    app.use("/api/generations", noStore);
    app.use("/api/generations/*", noStore);

    app.post("/api/generations", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const body = parseCreateBody(read.body);
        if (typeof body === "string") {
            return c.json({ error: body }, 400);
        }
        const result = jobs.create(body, c.req.header(RESOURCE_EPOCH_HEADER));
        if (!result.ok) {
            if (result.status === 503) {
                c.header("Retry-After", "5");
            }
            return c.json(result.body, result.status);
        }
        return c.json({ jobId: result.jobId });
    });

    app.get("/api/generations/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const status = jobs.status(c.req.param("id"), c.req.query("clientId"));
        return status ? c.json(status) : c.json({ error: "Generation not found" }, 404);
    });

    app.delete("/api/generations/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const aborted = jobs.abort(c.req.param("id"), c.req.query("clientId"));
        return aborted === null ? c.json({ error: "Generation not found" }, 404) : c.json({ aborted });
    });
}
