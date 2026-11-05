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
    MAX_FORM_VALUES_BYTES,
    MAX_TRIGGER_NAME_BYTES,
} from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { STRUCTURED_MEMORY_REBUILD_MODES } from "../../../shared/structuredMemory.ts";
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
    const invalidShape =
        'command must be { type: "button", data: string }, { type: "form", key: string, values: Record<string, string | string[]> }, { type: "manual", name: string }, { type: "memoryRecord", messageId?: string }, { type: "memoryTest" }, { type: "memoryRebuild", mode: "rebuild" | "backfill", turns: 1 | 2 }, or { type: "memoryRebuild", resume: true }';
    if (isPlainObject(value) && value.type === "memoryRecord") {
        if (value.messageId === undefined) {
            return { type: "memoryRecord" };
        }
        return isValidResourceId(value.messageId)
            ? { type: "memoryRecord", messageId: value.messageId }
            : "command.messageId must be an id when present";
    }
    if (isPlainObject(value) && value.type === "memoryTest") {
        return { type: "memoryTest" };
    }
    if (isPlainObject(value) && value.type === "memoryRebuild") {
        if (value.resume === true) {
            return { type: "memoryRebuild", resume: true };
        }
        const mode = STRUCTURED_MEMORY_REBUILD_MODES.find((entry) => entry === value.mode);
        return mode && (value.turns === 1 || value.turns === 2)
            ? { type: "memoryRebuild", mode, turns: value.turns }
            : invalidShape;
    }
    if (isPlainObject(value) && value.type === "manual" && typeof value.name === "string") {
        if (Buffer.byteLength(value.name, "utf8") > MAX_TRIGGER_NAME_BYTES) {
            return `command.name must be at most ${MAX_TRIGGER_NAME_BYTES} bytes`;
        }
        return { type: "manual", name: value.name };
    }
    if (isPlainObject(value) && value.type === "form" && typeof value.key === "string" && isPlainObject(value.values)) {
        if (Buffer.byteLength(value.key, "utf8") > MAX_COMMAND_DATA_BYTES) {
            return `command.key must be at most ${MAX_COMMAND_DATA_BYTES} bytes`;
        }
        const values: Record<string, string | string[]> = Object.create(null);
        for (const [key, entry] of Object.entries(value.values)) {
            if (typeof entry === "string") {
                values[key] = entry;
            } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
                values[key] = [...entry];
            } else {
                return invalidShape;
            }
        }
        if (Buffer.byteLength(JSON.stringify(values), "utf8") > MAX_FORM_VALUES_BYTES) {
            return `command.values must serialize to at most ${MAX_FORM_VALUES_BYTES} bytes`;
        }
        return { type: "form", key: value.key, values };
    }
    if (!isPlainObject(value) || value.type !== "button" || typeof value.data !== "string") {
        return invalidShape;
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
    if (
        body.requestId !== undefined &&
        (typeof body.requestId !== "string" || !GENERATION_ID_PATTERN.test(body.requestId))
    ) {
        return "requestId must be a generation id";
    }
    if (body.handoff !== undefined && body.handoff !== "prefer") {
        return 'handoff must be "prefer" when present';
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
    for (const field of ["continueMessageId", "rerollMessageId", "speakerChaId", "userMessageId"] as const) {
        if (context[field] !== undefined && !isValidResourceId(context[field])) {
            return `context.${field} must be an id when present`;
        }
    }
    if (context.rerollMessageId !== undefined && body.kind !== "reroll") {
        return "context.rerollMessageId is only for reroll jobs";
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
        ...(context.rerollMessageId !== undefined ? { rerollMessageId: context.rerollMessageId as string } : {}),
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
    const base = {
        context: parsed,
        hooks,
        clientId: body.clientId,
        ...(body.handoff === "prefer" ? { handoff: "prefer" as const } : {}),
        ...(body.requestId !== undefined ? { requestId: body.requestId as string } : {}),
    };
    return command !== undefined
        ? { ...base, kind: "command", command }
        : { ...base, kind: body.kind as Exclude<GenerationCreateBody["kind"], "command"> };
}

/**
 * `/api/generations`: JWT authentication, the authenticated limiter, and `no-store` on responses
 * these registrations produce. The earlier global body limiter in `server/src/app.ts`
 * (`server/src/routes/limitedBody.ts`) rejects a declared Content-Length above its cap with 413 before
 * these registrations run, without Cache-Control. Job-id reads and controls are participant-scoped
 * by client-id; current, stop and request-id cancel are available to any authenticated tab.
 * The socket `/api/generations/:id/ws` is handled outside these registrations by
 * `server/src/jobs/generationJobs.ts` handleUpgrade.
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

    /**
     * POST GenerationCreateBody, with optional requestId: { jobId }, or a replay
     * { jobId, replayed: true, owned, status }. `server/src/jobs/generationJobs.ts` create checks
     * x-resource-epoch, so request lookup follows the epoch check, before ordinary admission gates.
     * 400 for a malformed body; 404 for a missing chat; 412 for another epoch; 503 with Retry-After: 5
     * during shutdown or maintenance. 409: requestIdReused, requestCancelled, chatBusy { jobId },
     * stale, chatBindingIncomplete { problems }, chatBindingMismatch, memoryRebuilding, or
     * chatLoreOverrideOrphaned { entries: [{ id, name }] }.
     */
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
        const { ok, ...answer } = result;
        return c.json(answer);
    });

    /**
     * POST { requestId, clientId } with x-resource-epoch: an unknown id gets a tombstone and
     * { state: "cancelled" }; an admitted id gets { state: "aborted" | "ended", jobId, owned, status }.
     * Aborts that request regardless of owner, never a different job occupying its chat. 400 for
     * invalid ids; 412 for another epoch. Available during shutdown and maintenance.
     */
    app.post("/api/generations/cancel", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        const read = await readJsonBody(c);
        if (!read.ok) return read.response;
        const body = read.body;
        if (
            !isPlainObject(body) ||
            typeof body.requestId !== "string" ||
            !GENERATION_ID_PATTERN.test(body.requestId) ||
            !isValidResourceId(body.clientId)
        ) {
            return c.json({ error: "requestId and clientId must be valid ids" }, 400);
        }
        const result = jobs.cancel(
            { requestId: body.requestId, clientId: body.clientId },
            c.req.header(RESOURCE_EPOCH_HEADER),
        );
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    /**
     * GET ?characterId=&chatId=&clientId=: read-only chat-slot lookup
     * { jobId, kind, owned, stage?, sequence? }; 404 idle, 400 invalid ids. Optional clientId only
     * determines owned: it never attaches or grants channel access. Register before /:id, which
     * would otherwise capture "current" as a job id.
     */
    app.get("/api/generations/current", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        const characterId = c.req.query("characterId");
        const chatId = c.req.query("chatId");
        const clientId = c.req.query("clientId");
        if (
            !isValidResourceId(characterId) ||
            !isValidResourceId(chatId) ||
            (clientId !== undefined && !isValidResourceId(clientId))
        ) {
            return c.json({ error: "characterId, chatId and optional clientId must be valid ids" }, 400);
        }
        const current = jobs.current(characterId, chatId, clientId);
        return current ? c.json(current) : c.json({ error: "idle" }, 404);
    });

    /**
     * POST { characterId, chatId, jobId, clientId } with x-resource-epoch aborts only that chat's
     * named current job, including its sequence: { aborted } (false if already aborting). clientId
     * is attribution only. 400 invalid ids; 412 another epoch; 404 idle; 409 jobChanged, after which
     * the replacement must be looked up and confirmed again.
     */
    app.post("/api/generations/stop", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        const read = await readJsonBody(c);
        if (!read.ok) return read.response;
        const body = read.body;
        if (
            !isPlainObject(body) ||
            !isValidResourceId(body.characterId) ||
            !isValidResourceId(body.chatId) ||
            !isValidResourceId(body.clientId) ||
            typeof body.jobId !== "string" ||
            !GENERATION_ID_PATTERN.test(body.jobId)
        ) {
            return c.json({ error: "characterId, chatId, jobId and clientId must be valid ids" }, 400);
        }
        const result = jobs.stop(
            { characterId: body.characterId, chatId: body.chatId, jobId: body.jobId, clientId: body.clientId },
            c.req.header(RESOURCE_EPOCH_HEADER),
        );
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    /**
     * POST GenerationHandoffBody { clientId, target? } with x-resource-epoch: { offered: true }.
     * 400 invalid ids; 404 unknown job or non-participant; 412 another epoch;
     * 409 ended, unavailable, target already owns the job, or a takeover already reserved. Opens a requested offer.
     */
    app.post("/api/generations/:id/handoff", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        const read = await readJsonBody(c);
        if (!read.ok) return read.response;
        const body = read.body;
        if (
            !isPlainObject(body) ||
            !isValidResourceId(body.clientId) ||
            (body.target !== undefined && !isValidResourceId(body.target))
        ) {
            return c.json({ error: "clientId and optional target must be valid ids" }, 400);
        }
        const result = jobs.handoff(
            c.req.param("id"),
            { clientId: body.clientId, ...(body.target !== undefined ? { target: body.target as string } : {}) },
            c.req.header(RESOURCE_EPOCH_HEADER),
        );
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    /**
     * POST GenerationTakeoverBody { clientId } with x-resource-epoch: 200 { ticket }, valid for
     * one socket attach. The current owner can claim an eligible offer to reattach and replay its
     * requests; another client waits as a pending viewer until a safe ownership switch.
     * 400 invalid clientId; 404 unknown job; 412 another epoch;
     * 409 no open offer, another target, a reserved takeover, an ended job, or shutdown/maintenance.
     */
    app.post("/api/generations/:id/takeover", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) return denied;
        const read = await readJsonBody(c);
        if (!read.ok) return read.response;
        const body = read.body;
        if (!isPlainObject(body) || !isValidResourceId(body.clientId)) {
            return c.json({ error: "clientId must be a valid id" }, 400);
        }
        const result = jobs.takeover(
            c.req.param("id"),
            { clientId: body.clientId },
            c.req.header(RESOURCE_EPOCH_HEADER),
        );
        return result.ok ? c.json(result.body) : c.json(result.body, result.status);
    });

    /**
     * GET ?clientId=: GenerationStatus for a participant, valid ticket holder, or pending takeover
     * holder; 404 for an unknown job or a client without access. After the 60 s ended-job grace and
     * collection, a kept outcome still answers state: "ended", kept: true and a trimmed terminal,
     * but the collected job can no longer be attached.
     */
    app.get("/api/generations/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const status = jobs.status(c.req.param("id"), c.req.query("clientId"));
        return status ? c.json(status) : c.json({ error: "Generation not found" }, 404);
    });

    /** DELETE ?clientId= aborts a participant's job: { aborted }; 404 for an unknown or another client's job. */
    app.delete("/api/generations/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const aborted = jobs.abort(c.req.param("id"), c.req.query("clientId"));
        return aborted === null ? c.json({ error: "Generation not found" }, 404) : c.json({ aborted });
    });

    /**
     * POST ?clientId= { runId }, with x-resource-epoch, stops a participant's initial memory
     * summarization run after its summary in progress; the job continues. { stopped: true };
     * 400 invalid runId; 404 unknown/another client's job; 409 jobEnded, noMemoryRun or otherMemoryRun;
     * 412 another epoch.
     */
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

    /**
     * POST ?clientId= ChannelDrainedBody { callbackId }: the dispatched client reports that a
     * server-cancelled callback no longer runs in the tab, freeing its channel lane. { drained }
     * (false when it held none), also for an ended job still in grace; 400 invalid callbackId,
     * 404 unknown/another client's callback. Former owners may drain holds in their own lane;
     * another participant cannot release them. A collected kept outcome has no channel to drain.
     */
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
