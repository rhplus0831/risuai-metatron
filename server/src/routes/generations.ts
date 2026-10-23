import type { Hono, MiddlewareHandler } from "hono";
import {
    GENERATION_ID_PATTERN,
    GENERATION_KINDS,
    type GenerationClientEnv,
    type GenerationCommand,
    type GenerationContext,
    type GenerationCreateBody,
    MAX_CLIENT_EMOTION_NAME_CHARS,
    MAX_CLIENT_EMOTIONS,
    MAX_COMMAND_DATA_BYTES,
    MAX_TRIGGER_NAME_BYTES,
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
/** A group's members at most (the tab sends the chat's character, or each member of its group). */
const MAX_CLIENT_EMOTION_CHARACTERS = 256;

/** `context.client`: a viewport of finite, non-negative sizes and a short language tag. */
export function parseClientEnv(value: unknown): GenerationClientEnv | string {
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
    let emotions: Record<string, string[]> | undefined;
    if (value.emotions !== undefined) {
        if (!isPlainObject(value.emotions) || Object.keys(value.emotions).length > MAX_CLIENT_EMOTION_CHARACTERS) {
            return "context.client.emotions must be a map of character ids to emotion names";
        }
        emotions = {};
        for (const [id, names] of Object.entries(value.emotions)) {
            if (
                !isValidResourceId(id) ||
                !Array.isArray(names) ||
                names.length > MAX_CLIENT_EMOTIONS ||
                names.some((name) => typeof name !== "string" || name.length > MAX_CLIENT_EMOTION_NAME_CHARS)
            ) {
                return `context.client.emotions must map character ids to at most ${MAX_CLIENT_EMOTIONS} names`;
            }
            emotions[id] = names as string[];
        }
    }
    return {
        viewport: { width: width as number, height: height as number },
        browserLanguage: value.browserLanguage,
        ...(emotions ? { emotions } : {}),
    };
}

/** `command`: required for a `command` job, refused for every other kind. Data only: no code, no permission. */
function parseCommand(kind: string, value: unknown): GenerationCommand | undefined | string {
    if (kind !== "command") {
        return value === undefined ? undefined : "command is only for a command job";
    }
    if (isPlainObject(value) && value.type === "manual" && typeof value.name === "string") {
        if (Buffer.byteLength(value.name, "utf8") > MAX_TRIGGER_NAME_BYTES) {
            return `command.name must be at most ${MAX_TRIGGER_NAME_BYTES} bytes`;
        }
        return { type: "manual", name: value.name };
    }
    if (!isPlainObject(value) || value.type !== "button" || typeof value.data !== "string") {
        return 'command must be { type: "button", data: string } or { type: "manual", name: string }';
    }
    if (Buffer.byteLength(value.data, "utf8") > MAX_COMMAND_DATA_BYTES) {
        return `command.data must be at most ${MAX_COMMAND_DATA_BYTES} bytes`;
    }
    return { type: "button", data: value.data };
}

/** The kinds whose job runs the input stage (`userMessageId`). */
const INPUT_KINDS: readonly string[] = ["send", "continue", "reroll", "group"];

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
    for (const field of ["presetId", "modelPresetId", "personaId"] as const) {
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
    for (const field of ["continueMessageId", "speakerChaId", "userMessageId"] as const) {
        if (context[field] !== undefined && !isValidResourceId(context[field])) {
            return `context.${field} must be an id when present`;
        }
    }
    // Only a send runs the input stage that appends the user message.
    if (context.userMessageId !== undefined && !INPUT_KINDS.includes(body.kind)) {
        return "context.userMessageId is only for send, continue, reroll, and group jobs";
    }
    // A `risu-id` attribute: any nonempty text (not a resource id), bounded.
    if (
        context.triggerId !== undefined &&
        (typeof context.triggerId !== "string" ||
            context.triggerId === "" ||
            Buffer.byteLength(context.triggerId, "utf8") > MAX_TRIGGER_NAME_BYTES)
    ) {
        return `context.triggerId must be a nonempty string of at most ${MAX_TRIGGER_NAME_BYTES} bytes when present`;
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
        modelPresetId: context.modelPresetId as string | null,
        personaId: context.personaId as string | null,
        mode: context.mode,
        input: context.input,
        chatRevision: context.chatRevision,
        ...(context.continueMessageId !== undefined ? { continueMessageId: context.continueMessageId as string } : {}),
        ...(context.speakerChaId !== undefined ? { speakerChaId: context.speakerChaId as string } : {}),
        ...(context.userMessageId !== undefined ? { userMessageId: context.userMessageId as string } : {}),
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
 * `/api/generations`: `POST` creates a job (`{ jobId }`; 409 `chatBusy` with the running job's id,
 * 409 `stale`, 409 `chatBindingIncomplete` with `problems` or `chatBindingMismatch` when the
 * context's ids are not the chat's complete binding, 404, 412 for another epoch, 503 while the
 * server shuts down or a restore runs), `GET /:id?clientId=` is the owner's status, and
 * `DELETE /:id?clientId=` aborts it, and `POST /:id/memory-stop?clientId=` (`{ runId }`, the epoch
 * checked) stops the job's initial memory summarization run `runId` after its summary in progress
 * (`{ stopped: true }`; 409 `jobEnded`, `noMemoryRun`, or `otherMemoryRun`; 412 for another epoch),
 * and `POST /:id/drained?clientId=` (`ChannelDrainedBody`) reports a callback of the job the server
 * cancelled as no longer running in the tab, freeing the client's channel lane (`{ drained }`, false
 * when it held none; also for an ended job still kept). Another client's job is a 404. The socket is
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

    app.post("/api/generations/:id/memory-stop", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const runId = isPlainObject(read.body) ? read.body.runId : undefined;
        if (typeof runId !== "string" || !GENERATION_ID_PATTERN.test(runId)) {
            return c.json({ error: "runId must be a run id" }, 400);
        }
        const result = jobs.requestMemoryStop(
            c.req.param("id"),
            c.req.query("clientId"),
            runId,
            c.req.header(RESOURCE_EPOCH_HEADER),
        );
        return result.ok ? c.json({ stopped: true }) : c.json(result.body, result.status);
    });

    app.post("/api/generations/:id/drained", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const callbackId = isPlainObject(read.body) ? read.body.callbackId : undefined;
        if (typeof callbackId !== "string" || !GENERATION_ID_PATTERN.test(callbackId)) {
            return c.json({ error: "callbackId must be a callback id" }, 400);
        }
        const drained = jobs.callbackDrained(c.req.param("id"), c.req.query("clientId"), callbackId);
        return drained === null ? c.json({ error: "Generation not found" }, 404) : c.json({ drained });
    });
}
