import type { Hono, MiddlewareHandler } from "hono";
import {
    MODEL_MODES,
    REQUEST_ARG_KEYS,
    type LlmCallbackAnswer,
    type LlmRequestBody,
    type ModelModeExtended,
    type RequestArgs,
    type ToolCallRecord,
    type ToolDescriptor,
} from "../../../shared/llm/request.ts";
import { isModelDescriptor } from "../../../shared/llm/validate.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import type { LlmRequests } from "../llm/requests.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";
const optionalNumber = (value: unknown) => value === undefined || typeof value === "number";
const isChatRef = (value: unknown) =>
    isPlainObject(value) && typeof value.chaId === "string" && typeof value.chatId === "string";

const BOOLEAN_ARGS = [
    "useStreaming",
    "forceStreaming",
    "isGroupChat",
    "useEmotion",
    "continue",
    "noMultiGen",
    "imageResponse",
    "previewBody",
    "rememberToolUsage",
] as const;
const NUMBER_ARGS = ["temperature", "maxTokens", "PresensePenalty", "frequencyPenalty"] as const;
const STRING_ARGS = ["chatId", "schema", "extractJson", "staticModel"] as const;

function parseArgs(value: unknown): RequestArgs | string {
    if (!isPlainObject(value)) {
        return "arg must be an object";
    }
    for (const key of Object.keys(value)) {
        if (!(REQUEST_ARG_KEYS as readonly string[]).includes(key)) {
            return `arg.${key} is not a request field`;
        }
    }
    if (
        !Array.isArray(value.formated) ||
        !value.formated.every(
            (message) =>
                isPlainObject(message) && typeof message.role === "string" && typeof message.content === "string",
        )
    ) {
        return "arg.formated must be chat messages";
    }
    if (!isPlainObject(value.bias) || !Object.values(value.bias).every((entry) => typeof entry === "number")) {
        return "arg.bias must map token ids to numbers";
    }
    if (
        value.biasString !== undefined &&
        !(
            Array.isArray(value.biasString) &&
            value.biasString.every(
                (entry) =>
                    Array.isArray(entry) &&
                    entry.length === 2 &&
                    typeof entry[0] === "string" &&
                    typeof entry[1] === "number",
            )
        )
    ) {
        return "arg.biasString must be [text, bias] pairs";
    }
    for (const key of BOOLEAN_ARGS) {
        if (!optionalBoolean(value[key])) {
            return `arg.${key} must be a boolean`;
        }
    }
    for (const key of NUMBER_ARGS) {
        if (!optionalNumber(value[key])) {
            return `arg.${key} must be a number`;
        }
    }
    for (const key of STRING_ARGS) {
        if (!optionalString(value[key])) {
            return `arg.${key} must be a string`;
        }
    }
    if (value.chatRef !== undefined && value.chatRef !== null && !isChatRef(value.chatRef)) {
        return "arg.chatRef must be { chaId, chatId } or null";
    }
    return value as RequestArgs;
}

/** Checks a request body; returns the reason as a string when it is malformed. */
export function parseLlmRequestBody(body: unknown): LlmRequestBody | string {
    if (!isPlainObject(body)) {
        return "Body must be an object";
    }
    if (!isValidResourceId(body.clientId)) {
        return "clientId must be a valid id";
    }
    if (typeof body.mode !== "string" || !MODEL_MODES.includes(body.mode as ModelModeExtended)) {
        return "mode must be one of " + MODEL_MODES.join(", ");
    }
    const context = body.context;
    if (!isPlainObject(context)) {
        return "context must be an object";
    }
    for (const field of ["presetId", "personaId", "selectedPersonaId"] as const) {
        if (!isValidResourceId(context[field])) {
            return `context.${field} must be an id`;
        }
    }
    for (const field of ["selectedCharacterId", "speakerId"] as const) {
        if (context[field] !== null && !isValidResourceId(context[field])) {
            return `context.${field} must be an id or null`;
        }
    }
    const mainModel = context.mainModel;
    if (!isPlainObject(mainModel) || typeof mainModel.imageInput !== "boolean") {
        return "context.mainModel must be { imageInput }";
    }
    const tokenizer = context.tokenizer;
    if (
        !isPlainObject(tokenizer) ||
        typeof tokenizer.aiModel !== "string" ||
        typeof tokenizer.currentPluginProvider !== "string" ||
        typeof tokenizer.modelTokenizer !== "number" ||
        !optionalString(tokenizer.modelInternalID) ||
        typeof tokenizer.pluginTokenizer !== "string" ||
        typeof tokenizer.customTokenizer !== "string" ||
        typeof tokenizer.googleClaudeTokenizing !== "boolean" ||
        typeof tokenizer.useTokenizerCaching !== "boolean"
    ) {
        return "context.tokenizer must be the tab's tokenizer scope";
    }
    const arg = parseArgs(body.arg);
    if (typeof arg === "string") {
        return arg;
    }
    if (
        !Array.isArray(body.tools) ||
        !body.tools.every(
            (tool) => isPlainObject(tool) && typeof tool.name === "string" && typeof tool.description === "string",
        )
    ) {
        return "tools must be { name, description, inputSchema } entries";
    }
    if (
        !isPlainObject(body.toolRecords) ||
        !Object.values(body.toolRecords).every(
            (record) =>
                isPlainObject(record) &&
                isPlainObject(record.call) &&
                typeof record.call.id === "string" &&
                typeof record.call.name === "string" &&
                Array.isArray(record.response),
        )
    ) {
        return "toolRecords must map markers to tool-call records";
    }
    if (body.dynamicModel !== undefined && !isModelDescriptor(body.dynamicModel)) {
        return "dynamicModel must be a model descriptor";
    }
    if (
        body.channelCall !== undefined &&
        !(
            isPlainObject(body.channelCall) &&
            typeof body.channelCall.jobId === "string" &&
            typeof body.channelCall.callbackId === "string"
        )
    ) {
        return "channelCall must be { jobId, callbackId }";
    }
    return {
        clientId: body.clientId,
        mode: body.mode as ModelModeExtended,
        context: {
            presetId: context.presetId as string,
            personaId: context.personaId as string,
            selectedPersonaId: context.selectedPersonaId as string,
            selectedCharacterId: context.selectedCharacterId as string | null,
            speakerId: context.speakerId as string | null,
            mainModel: { imageInput: mainModel.imageInput },
            tokenizer: {
                aiModel: tokenizer.aiModel,
                currentPluginProvider: tokenizer.currentPluginProvider,
                modelTokenizer: tokenizer.modelTokenizer as LlmRequestBody["context"]["tokenizer"]["modelTokenizer"],
                ...(typeof tokenizer.modelInternalID === "string"
                    ? { modelInternalID: tokenizer.modelInternalID }
                    : {}),
                pluginTokenizer: tokenizer.pluginTokenizer,
                customTokenizer: tokenizer.customTokenizer,
                googleClaudeTokenizing: tokenizer.googleClaudeTokenizing,
                useTokenizerCaching: tokenizer.useTokenizerCaching,
            },
        },
        arg,
        tools: (body.tools as Record<string, unknown>[]).map((tool) => ({
            name: tool.name as string,
            description: tool.description as string,
            inputSchema: tool.inputSchema,
        })) as ToolDescriptor[],
        toolRecords: body.toolRecords as Record<string, ToolCallRecord>,
        ...(body.dynamicModel !== undefined
            ? { dynamicModel: body.dynamicModel as LlmRequestBody["dynamicModel"] }
            : {}),
        ...(body.channelCall !== undefined
            ? { channelCall: body.channelCall as unknown as NonNullable<LlmRequestBody["channelCall"]> }
            : {}),
    };
}

function parseAnswer(body: unknown): (LlmCallbackAnswer & { clientId: string }) | string {
    if (!isPlainObject(body) || !isValidResourceId(body.clientId) || typeof body.callbackId !== "string") {
        return "An answer is { clientId, callbackId, outcome, value | error }";
    }
    if (body.outcome === "answered" && Object.hasOwn(body, "value")) {
        return { clientId: body.clientId, callbackId: body.callbackId, outcome: "answered", value: body.value };
    }
    if (body.outcome === "failed" && typeof body.error === "string") {
        return { clientId: body.clientId, callbackId: body.callbackId, outcome: "failed", error: body.error };
    }
    return "outcome must be answered (with value) or failed (with error)";
}

/**
 * `POST /api/llm/request` (Phase 5, `request-layer-and-llm-secrets`): runs one provider request on
 * the server with the stored settings and credentials (JWT only; `x-resource-epoch`, 412 for another
 * epoch; 503 during maintenance and shutdown; 429 past the per-client cap; 409 for a `channelCall`
 * that is not running) and answers with an SSE stream of `LlmRequestEvent`s. Not a job: no chat
 * lock, no persistence. `POST /api/llm/request/:id/answer` answers one of its callbacks
 * (`{ accepted }`, `{ ignored }` for a repeat or a late answer, 404 for an unknown request).
 */
export function registerLlmRoutes(
    app: Hono<AppEnv>,
    arg: { requests: LlmRequests; store: ResourceStore; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { requests, store, auth, limiter } = arg;

    app.post("/api/llm/request", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const body = parseLlmRequestBody(read.body);
        if (typeof body === "string") {
            return c.json({ error: body }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        const started = requests.start(body, c.req.raw.signal);
        if (!started.ok) {
            if (started.status === 503) {
                c.header("Retry-After", "5");
            }
            return c.json({ error: started.error }, started.status);
        }
        return new Response(started.stream, {
            headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        });
    });

    app.post("/api/llm/request/:id/answer", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const answer = parseAnswer(read.body);
        if (typeof answer === "string") {
            return c.json({ error: answer }, 400);
        }
        const { clientId, ...message } = answer;
        const result = requests.answer(c.req.param("id"), clientId, message);
        if (result === "missing") {
            return c.json({ error: "Request not found" }, 404);
        }
        c.header("Cache-Control", "no-store");
        return c.json({ [result]: true });
    });
}
