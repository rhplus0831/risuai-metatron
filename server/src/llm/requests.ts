import { randomUUID } from "node:crypto";
import { LLMFormat, type LLMModel } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import {
    LLM_CALLBACK_TIMEOUT_MS,
    type LlmCallbackAnswer,
    type LlmCallbackName,
    type LlmCallbackPayloads,
    type LlmRequestBody,
    type LlmRequestEvent,
    type RPCToolCallContent,
    type StreamResponseChunk,
    type ToolCallRecord,
} from "../../../shared/llm/request.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { JobChannel } from "../jobs/channel.ts";
import type { TokenCounter, TokenCountScope } from "../prompt/tokens.ts";
import type { ClaudeObserver } from "./claudeObserver.ts";
import type { RequestContext } from "./context.ts";
import { collectSecrets, createRedactor, redactHeaderText, type Redactor } from "./redact.ts";
import { requestChatDataMain, type requestDataResponse } from "./request.ts";
import { loadRequestDb, RequestTargetGoneError } from "./settings.ts";
import { createTransport, type FetchLogEntry } from "./transport.ts";
import type { VertexTokenCache } from "./vertexToken.ts";

/** Live requests one client may hold at once. */
export const MAX_REQUESTS_PER_CLIENT = 32;
/** Unread event bytes a request may queue before it is ended (a reader that stopped reading). */
export const MAX_QUEUED_EVENT_BYTES = 64 * 1024 * 1024;
/** How long `dispose` waits for the requests it aborted. */
export const DISPOSE_WAIT_MS = 5000;
const STRONG_BAN_CACHE_SIZE = 500;

export type ParentCallback = {
    channel: JobChannel;
    unwatch: () => void;
    /** Ends the job (a barrier failure, a timeout, or a disconnect of a child callback ends it). */
    endJob: () => void;
};

export type LlmRequestsOptions = {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    tokens: TokenCounter;
    vertexTokens: VertexTokenCache;
    claudeObserver: ClaudeObserver;
    /** The job callback a request runs inside (`generationJobs.parentCallback`). */
    parentCallback: (
        jobId: string,
        clientId: string,
        callbackId: string,
        onSettled: () => void,
    ) => ParentCallback | null;
    fetchImpl?: typeof fetch;
    now?: () => number;
};

type PendingCallback = {
    name: LlmCallbackName;
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
};

type LiveRequest = {
    id: string;
    clientId: string;
    controller: AbortController;
    callbacks: Map<string, PendingCallback>;
    /** Callback ids answered or expired: a repeated answer is acknowledged and ignored. */
    finishedCallbacks: Set<string>;
};

export type StartResult =
    | { ok: true; id: string; stream: ReadableStream<Uint8Array> }
    | { ok: false; status: 400 | 409 | 429 | 503; error: string };

export type AnswerResult = "accepted" | "ignored" | "missing";

class CallbackFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CallbackFailedError";
    }
}

/**
 * A failure that ends the request whatever the adapter does with it: a `cbs` callback that failed,
 * any callback that timed out or answered a malformed value, and a child callback's barrier,
 * timeout, or disconnect. The adapters catch errors in many places (an extract path falls back to
 * the raw text, an interceptor's error is logged); the request's abort carries this, so the
 * terminal is an error even when the adapter would have returned a success.
 */
class FatalRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FatalRequestError";
    }
}

/** `strongBan` of `src/ts/tokenizer.ts`, its `localStorage` cache an LRU here (keyed by the text alone, as the client keys it). */
function createStrongBan(cache: Map<string, string>) {
    return async (
        data: string,
        bias: { [key: number]: number },
        tokenizeNum: (text: string) => Promise<ArrayLike<number>>,
    ): Promise<{ [key: number]: number }> => {
        const cached = cache.get("strongBan_" + data);
        if (cached !== undefined) {
            cache.delete("strongBan_" + data);
            cache.set("strongBan_" + data, cached);
            return JSON.parse(cached);
        }
        let charAlt = [
            data,
            data.trim(),
            data.toLocaleUpperCase(),
            data.toLocaleLowerCase(),
            data[0].toLocaleUpperCase() + data.slice(1),
            data[0].toLocaleLowerCase() + data.slice(1),
        ];

        let banChars = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’«»「」…–―※";
        let unbanChars: number[] = [];

        for (const char of banChars) {
            unbanChars.push((await tokenizeNum(char))[0]);
        }

        for (const char of banChars) {
            const encoded = await tokenizeNum(char);
            if (encoded.length > 0) {
                if (!unbanChars.includes(encoded[0])) {
                    bias[encoded[0]] = -100;
                }
            }
            for (const alt of charAlt) {
                let fchar = char;

                const encoded = await tokenizeNum(alt + fchar);
                if (encoded.length > 0) {
                    if (!unbanChars.includes(encoded[0])) {
                        bias[encoded[0]] = -100;
                    }
                }
                const encoded2 = await tokenizeNum(fchar + alt);
                if (encoded2.length > 0) {
                    if (!unbanChars.includes(encoded2[0])) {
                        bias[encoded2[0]] = -100;
                    }
                }
            }
        }
        cache.set("strongBan_" + data, JSON.stringify(bias));
        while (cache.size > STRONG_BAN_CACHE_SIZE) {
            cache.delete(cache.keys().next().value!);
        }
        return bias;
    };
}

/** Whether `value` is what the client's `callTool` returns: MCP content entries. */
function isToolContent(value: unknown): value is RPCToolCallContent[] {
    return (
        Array.isArray(value) &&
        value.every(
            (entry) =>
                !!entry &&
                typeof entry === "object" &&
                ((entry.type === "text" && typeof entry.text === "string") ||
                    ((entry.type === "image" || entry.type === "audio") &&
                        typeof entry.data === "string" &&
                        typeof entry.mimeType === "string") ||
                    (entry.type === "resource" && !!entry.resource && typeof entry.resource === "object")),
        )
    );
}

/**
 * The live `POST /api/llm/request` requests (`request-layer-and-llm-secrets`). Each request reads its
 * settings from the store by the ids the client sent, runs `requestChatDataMain`, and answers with
 * one ordered SSE stream (`LlmRequestEvent`): `accepted`, side events (logs, notices, inlays, tool
 * records, callbacks), then either `result` or `streaming` with its chunks and exactly one terminal
 * (`result`, `end`, or `error`). A request ends once (`finalize`): its work finished, the client went
 * away (the stream was cancelled or the HTTP request aborted), its parent job callback settled, a
 * fatal callback failure, maintenance, or shutdown. Ending closes the stream at once (an aborted
 * request's terminal is an `error` with the reason), aborts every upstream fetch, rejects every
 * pending callback, and fences every later event, whether or not the adapter's work has stopped;
 * that work drains in the background (`dispose` waits for it, bounded).
 */
export function createLlmRequests(options: LlmRequestsOptions) {
    const now = options.now ?? Date.now;
    const requests = new Map<string, LiveRequest>();
    const draining = new Set<Promise<void>>();
    const strongBanCache = new Map<string, string>();
    const strongBan = createStrongBan(strongBanCache);
    let accepting = true;
    let paused = false;

    function countOf(clientId: string) {
        let count = 0;
        for (const request of requests.values()) {
            if (request.clientId === clientId) {
                count++;
            }
        }
        return count;
    }

    function start(body: LlmRequestBody, signal: AbortSignal): StartResult {
        if (!accepting) {
            return { ok: false, status: 503, error: "The server is shutting down" };
        }
        if (paused) {
            return { ok: false, status: 503, error: "The server is under maintenance" };
        }
        if (countOf(body.clientId) >= MAX_REQUESTS_PER_CLIENT) {
            return { ok: false, status: 429, error: "Too many requests are running for this client" };
        }
        if (signal.aborted) {
            // The client went away before admission: nothing starts.
            return { ok: false, status: 400, error: "The client went away" };
        }

        const id = randomUUID();
        const controller = new AbortController();
        const live: LiveRequest = {
            id,
            clientId: body.clientId,
            controller,
            callbacks: new Map(),
            finishedCallbacks: new Set(),
        };

        let parent: ParentCallback | null = null;
        if (body.channelCall) {
            parent = options.parentCallback(body.channelCall.jobId, body.clientId, body.channelCall.callbackId, () =>
                controller.abort(new Error("The job callback this request ran inside ended")),
            );
            if (!parent) {
                return { ok: false, status: 409, error: "The job callback this request names is not running" };
            }
        }

        let redactor: Redactor = createRedactor([]);
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        let closed = false;
        let terminalSent = false;
        let finalized = false;
        const encoder = new TextEncoder();

        const emit = (event: LlmRequestEvent) => {
            if (closed) {
                return;
            }
            const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
            // The queue is measured in bytes (the strategy below), so this is what is still unread.
            if (-(streamController.desiredSize ?? 0) + bytes.byteLength > MAX_QUEUED_EVENT_BYTES) {
                controller.abort(new Error("The client stopped reading the request's events"));
                return;
            }
            if (event.type === "result" || event.type === "end" || event.type === "error") {
                terminalSent = true;
            }
            streamController.enqueue(bytes);
        };
        /**
         * The secret-free projection of an event (`redact.ts`), field by field: the event's type,
         * ids, names, and chat refs are protocol and stay as they are (a short credential such as
         * `a` would otherwise rewrite them); the content a credential could be in is redacted.
         */
        const project = (event: LlmRequestEvent): LlmRequestEvent => {
            switch (event.type) {
                case "log": {
                    const entry = event.entry as Record<string, unknown>;
                    const out: Record<string, unknown> = { ...entry };
                    for (const field of ["body", "header", "response", "url"]) {
                        if (typeof entry[field] === "string") {
                            out[field] = redactor.text(entry[field] as string);
                        }
                    }
                    return { ...event, entry: out };
                }
                case "notice":
                case "error":
                    return { ...event, message: redactor.text(event.message) };
                case "result": {
                    const response = event.response;
                    if (response.type === "multiline") {
                        return {
                            ...event,
                            response: {
                                ...response,
                                result: response.result.map(([role, text]) => [role, redactor.text(text)]),
                            },
                        };
                    }
                    return { ...event, response: { ...response, result: redactor.text(response.result) } };
                }
                default:
                    // Callbacks and tool records are never rewritten: one that carries a stored
                    // credential is refused before it is sent (`redactor.carries`).
                    return event;
            }
        };
        const emitRedacted = (event: LlmRequestEvent) => emit(project(event));

        const stream = new ReadableStream<Uint8Array>(
            {
                start(c) {
                    streamController = c;
                },
                cancel() {
                    closed = true;
                    controller.abort(new Error("The client went away"));
                },
            },
            { highWaterMark: 0, size: (chunk) => chunk.byteLength },
        );

        const onClientAbort = () => controller.abort(new Error("The client went away"));
        // Registered before anything can finalize it, so finalizing always removes it.
        requests.set(id, live);

        /** Ends the request once: the terminal, the stream, the registry entry, the callbacks. */
        function finalize() {
            if (finalized) {
                return;
            }
            finalized = true;
            signal.removeEventListener("abort", onClientAbort);
            parent?.unwatch();
            if (!controller.signal.aborted) {
                controller.abort(new Error("The request finished"));
            } else if (!terminalSent) {
                // Ended from outside the adapter's flow: the reason is the terminal.
                emitRedacted({ type: "error", message: errorText(controller.signal.reason) });
            }
            for (const [callbackId, pending] of live.callbacks) {
                clearTimeout(pending.timer);
                live.finishedCallbacks.add(callbackId);
                pending.reject(new CallbackFailedError("The request ended"));
            }
            live.callbacks.clear();
            requests.delete(id);
            if (!closed) {
                closed = true;
                try {
                    streamController.close();
                } catch {}
            }
        }
        controller.signal.addEventListener("abort", finalize, { once: true });
        if (signal.aborted) {
            onClientAbort();
        } else {
            signal.addEventListener("abort", onClientAbort, { once: true });
        }
        const fatal = (message: string) => {
            const error = new FatalRequestError(message);
            controller.abort(error);
            return error;
        };

        function callback<N extends LlmCallbackName>(name: N, payload: LlmCallbackPayloads[N]): Promise<unknown> {
            if (controller.signal.aborted) {
                return Promise.reject(new CallbackFailedError("The request ended"));
            }
            const callbackId = randomUUID();
            const deadline = now() + LLM_CALLBACK_TIMEOUT_MS;
            return new Promise((resolve, reject) => {
                const expire = () => {
                    if (!live.callbacks.has(callbackId)) {
                        return;
                    }
                    if (now() < deadline) {
                        pending.timer = setTimeout(expire, Math.max(1, deadline - now()));
                        return;
                    }
                    live.callbacks.delete(callbackId);
                    live.finishedCallbacks.add(callbackId);
                    reject(fatal(`The client did not answer the ${name} callback in time`));
                };
                const pending: PendingCallback = {
                    name,
                    deadline,
                    timer: setTimeout(expire, LLM_CALLBACK_TIMEOUT_MS),
                    resolve,
                    reject,
                };
                live.callbacks.set(callbackId, pending);
                const event = { type: "callback", id: callbackId, name, payload } as LlmRequestEvent;
                if (redactor.carries(payload)) {
                    // The tab would get a payload other than the one to evaluate (a redacted parse
                    // input or tool argument): an explicit failure instead of a wrong answer.
                    live.callbacks.delete(callbackId);
                    clearTimeout(pending.timer);
                    reject(
                        fatal(`The ${name} callback's payload carries a stored credential; it is not sent to the tab`),
                    );
                    return;
                }
                emit(event);
            });
        }

        const run = async () => {
            emit({ type: "accepted", id });
            let loaded;
            try {
                loaded = loadRequestDb(options.store, options.kinds, {
                    presetId: body.context.presetId,
                    personaId: body.context.personaId,
                    selectedPersonaId: body.context.selectedPersonaId,
                    selectedCharacterId: body.context.selectedCharacterId,
                    speakerId: body.context.speakerId,
                });
            } catch (error) {
                if (error instanceof RequestTargetGoneError) {
                    emit({ type: "result", response: { type: "fail", result: error.message, noRetry: true } });
                    return;
                }
                throw error;
            }
            const { db } = loaded;
            redactor = createRedactor(collectSecrets(db));

            const modelInfo = (modelId: string): LLMModel =>
                resolveModelInfo(modelId, {
                    enableCustomFlags: db.enableCustomFlags,
                    customFlags: db.customFlags,
                    customModels: db.customModels,
                    extraModels: dynamicModelFor(body, modelId),
                });
            // The client's `encode` scope, read in the tab when the request started (its main model,
            // whatever preset the request uses), with the stored Google key for a remote count.
            const tokenizer = body.context.tokenizer;
            const tokenScope: TokenCountScope = {
                aiModel: tokenizer.aiModel,
                currentPluginProvider: tokenizer.currentPluginProvider,
                model: {
                    tokenizer: tokenizer.modelTokenizer,
                    ...(tokenizer.modelInternalID !== undefined ? { internalID: tokenizer.modelInternalID } : {}),
                },
                pluginTokenizer: tokenizer.pluginTokenizer,
                customTokenizer: tokenizer.customTokenizer,
                googleClaudeTokenizing: tokenizer.googleClaudeTokenizing,
                useTokenizerCaching: tokenizer.useTokenizerCaching,
                googleAccessToken: db.google?.accessToken,
            };
            const tokenizeNum = (text: string) => options.tokens.encode(text, tokenScope);
            /** Ends the request (and, for a barrier failure, a timeout, or a disconnect, the job). */
            const endWith = (message: string, endsJob: boolean) => {
                const error = fatal(message);
                if (endsJob) {
                    try {
                        parent?.endJob();
                    } catch (thrown) {
                        console.error("[LLM] ending the job:", redactor.text(errorText(thrown)));
                    }
                }
                return error;
            };
            const intercept = async (value: unknown, type: string): Promise<unknown> => {
                if (!parent) {
                    // No job callback: interceptors are not applied (recorded).
                    return value;
                }
                if (controller.signal.aborted) {
                    throw controller.signal.reason;
                }
                // A plugin sees the body in the tab: a body that carries a stored credential (one
                // the user put into a parameter) is not handed to it, and the request fails.
                if (redactor.carries(value)) {
                    throw endWith(
                        "The request body carries a stored credential; it is not sent to a plugin interceptor",
                        false,
                    );
                }
                const result = await parent.channel.callback(
                    "bodyIntercepter",
                    { body: value, type },
                    { parentId: body.channelCall!.callbackId },
                );
                switch (result.outcome) {
                    case "answered":
                        return result.value ?? value;
                    case "refused":
                        if (result.refusal === "unregistered") {
                            // The job's hook list has no interceptor: nothing to apply.
                            return value;
                        }
                        // A nesting or queue rule: a registered hook is never skipped silently.
                        throw endWith(`The bodyIntercepter callback was refused: ${result.error}`, false);
                    case "failed":
                        if (result.failure === "hook") {
                            // An interceptor that threw: the browser path logs it and sends the body.
                            console.error("[LLM] bodyIntercepter:", redactor.text(result.error));
                            return value;
                        }
                        throw endWith(
                            `The bodyIntercepter callback failed: ${result.error}`,
                            result.failure === "barrier",
                        );
                    case "timedOut":
                    case "disconnected":
                        throw endWith(`The bodyIntercepter callback ${result.outcome}: ${result.error}`, true);
                    default:
                        throw fatal(`The bodyIntercepter callback ended: ${result.error}`);
                }
            };
            const transport = createTransport({
                signal: controller.signal,
                log: (entry: FetchLogEntry) =>
                    emitRedacted({ type: "log", entry: { ...entry, header: redactHeaderText(entry.header) } }),
                intercept,
                redact: (text) => redactor.text(text),
                fetchImpl: options.fetchImpl,
            });

            const toolRecords = new Map<string, ToolCallRecord>(Object.entries(body.toolRecords));
            const ctx: RequestContext = {
                db,
                selectedCharacterName: loaded.selectedCharacterName,
                speakerName: loaded.speakerName,
                userName: loaded.userName,
                signal: controller.signal,
                transport,
                alertError: (message) => {
                    let text: string;
                    if (typeof message === "string") {
                        text = message;
                    } else {
                        try {
                            text = message instanceof Error ? message.message : JSON.stringify(message);
                        } catch {
                            text = `${message}`;
                        }
                    }
                    emitRedacted({ type: "notice", kind: "alertError", message: text });
                },
                redactText: (text) => redactor.text(text),
                tokenizeNum,
                strongBan: (text, bias) => strongBan(text, bias, tokenizeNum),
                parseCbs: async (text, chatRef) => {
                    let value: unknown;
                    try {
                        value = await callback("cbs", { text, chatRef: chatRef ?? null });
                    } catch (error) {
                        // A parse the tab could not do fails the request (the adapters would fall back).
                        throw error instanceof FatalRequestError ? error : fatal(`CBS: ${errorText(error)}`);
                    }
                    if (typeof value !== "string") {
                        throw fatal("The cbs callback answered a value that is not a string");
                    }
                    return value;
                },
                tools: {
                    call: async (name, args) => {
                        // A tool's own error (the tab answered `failed`) goes back to the model, as the
                        // adapters handle a throwing `callTool`; a timeout or a malformed answer is fatal.
                        const value = await callback("mcpTool", { name, args });
                        if (!isToolContent(value)) {
                            throw fatal("The mcpTool callback answered a value that is not tool content");
                        }
                        return value;
                    },
                    encode: async (record) => {
                        record.call.id = record.call.id || randomUUID();
                        // The marker's inner text is what a later decode looks up.
                        toolRecords.set(`${record.call.id}\uf100${record.call.name}`, record);
                        toolRecords.set(record.call.id, record);
                        // The tab stores it as it is (its ids are the marker's): one that carries a
                        // stored credential (an argument, an upstream id, a tool's answer) is refused.
                        if (redactor.carries(record)) {
                            throw fatal(
                                "A remembered tool call carries a stored credential; it is not sent to the tab",
                            );
                        }
                        emit({ type: "toolRecord", record });
                        return `<tool_call>${record.call.id}\uf100${record.call.name}</tool_call>\n\n`;
                    },
                    decode: async (text) => toolRecords.get(text),
                },
                inlays: {
                    saveSignature: async (inlayId, signature) => {
                        emit({ type: "inlay", inlay: { kind: "signature", id: inlayId, signature } });
                        return inlayId;
                    },
                    writeImage: async (image) => {
                        emit({ type: "inlay", inlay: { kind: "image", ...image } });
                        return image.id;
                    },
                    setAsset: async (asset) => {
                        emit({ type: "inlay", inlay: { kind: "audio", ...asset } });
                    },
                },
                supportsInlayImage: () => body.context.mainModel.imageInput,
                getModelInfo: modelInfo,
                intercept,
                vertexAccessToken: async (clientEmail, privateKey) => {
                    const token = await options.vertexTokens.get(clientEmail, privateKey, controller.signal);
                    redactor.add(token);
                    return token;
                },
                registerClaudeObserver: (arg) => {
                    // Work that drains after the request ended (maintenance reset the warmer) must
                    // not register the old request and its key again.
                    if (!controller.signal.aborted) {
                        options.claudeObserver.register(arg);
                    }
                },
            };

            const response = await requestChatDataMain({ ...body.arg, tools: body.tools }, body.mode, ctx);
            await deliver(response);
        };

        async function deliver(response: requestDataResponse) {
            if (controller.signal.aborted) {
                // Ended while the adapter ran (a fatal callback, the client, maintenance): its
                // result is not delivered; a stream is cancelled.
                if (response.type === "streaming") {
                    await response.result.cancel(controller.signal.reason).catch(() => {});
                }
                return;
            }
            if (response.type !== "streaming") {
                // A failure and a preview may carry a request's credentials; a model's answer is
                // the user's text and is sent as it is (redaction would rewrite URLs in it).
                const exposesRequest = response.type === "fail" || !!body.arg.previewBody;
                (exposesRequest ? emitRedacted : emit)({ type: "result", response });
                return;
            }
            emit({
                type: "streaming",
                ...(response.special ? { special: response.special } : {}),
                ...(response.model ? { model: response.model } : {}),
            });
            const reader = response.result.getReader();
            const onAbort = () => {
                reader.cancel(controller.signal.reason).catch(() => {});
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            let previous: Record<string, string> = {};
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    if (typeof value === "string") {
                        emit({ type: "chunkText", value });
                        continue;
                    }
                    const next = { ...(value as StreamResponseChunk) };
                    const set: Record<string, string> = {};
                    const append: Record<string, string> = {};
                    const remove: string[] = [];
                    for (const [key, text] of Object.entries(next)) {
                        const before = previous[key];
                        if (before === text) {
                            continue;
                        }
                        if (typeof before === "string" && typeof text === "string" && text.startsWith(before)) {
                            append[key] = text.slice(before.length);
                        } else {
                            set[key] = text;
                        }
                    }
                    for (const key of Object.keys(previous)) {
                        if (!Object.hasOwn(next, key)) {
                            remove.push(key);
                        }
                    }
                    previous = next;
                    if (!Object.keys(set).length && !Object.keys(append).length && !remove.length) {
                        // The same snapshot again (an adapter re-enqueues its state at the end).
                        continue;
                    }
                    emit({
                        type: "chunk",
                        ...(Object.keys(set).length ? { set } : {}),
                        ...(Object.keys(append).length ? { append } : {}),
                        ...(remove.length ? { remove } : {}),
                    });
                }
                if (!controller.signal.aborted) {
                    emit({ type: "end" });
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    emitRedacted({ type: "error", message: errorText(error) });
                }
            } finally {
                controller.signal.removeEventListener("abort", onAbort);
            }
        }

        const work = run()
            .catch((error) => {
                if (!controller.signal.aborted) {
                    // A failure before any response: the client's adapters would have rejected; the
                    // transport turns it into a fail result.
                    emitRedacted({ type: "error", message: errorText(error) });
                }
            })
            .finally(() => {
                finalize();
                draining.delete(work);
            });
        draining.add(work);
        return { ok: true, id, stream };
    }

    function answer(requestId: string, clientId: string, message: LlmCallbackAnswer): AnswerResult {
        const live = requests.get(requestId);
        if (!live || live.clientId !== clientId) {
            return "missing";
        }
        const pending = live.callbacks.get(message.callbackId);
        if (!pending) {
            return live.finishedCallbacks.has(message.callbackId) ? "ignored" : "missing";
        }
        live.callbacks.delete(message.callbackId);
        live.finishedCallbacks.add(message.callbackId);
        clearTimeout(pending.timer);
        if (now() >= pending.deadline) {
            const error = new FatalRequestError(`The client did not answer the ${pending.name} callback in time`);
            live.controller.abort(error);
            pending.reject(error);
            return "ignored";
        }
        if (message.outcome === "answered") {
            pending.resolve(message.value);
        } else {
            pending.reject(new CallbackFailedError(message.error));
        }
        return "accepted";
    }

    function abortAll(reason: string) {
        for (const live of [...requests.values()]) {
            live.controller.abort(new Error(reason));
        }
    }

    return {
        start,
        answer,
        /** Maintenance began: live requests end and new ones are refused until `resume`. */
        pause(reason: string) {
            paused = true;
            abortAll(reason);
            options.vertexTokens.clear();
            options.claudeObserver.reset();
        },
        resume() {
            paused = false;
        },
        beginShutdown() {
            accepting = false;
            abortAll("The server is shutting down");
            options.claudeObserver.dispose();
        },
        async dispose() {
            accepting = false;
            abortAll("The server is shutting down");
            options.claudeObserver.dispose();
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                Promise.all([...draining]),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, DISPOSE_WAIT_MS);
                }),
            ]);
            clearTimeout(timer);
            options.vertexTokens.clear();
        },
        /** For tests: the live request ids. */
        liveIds: () => [...requests.keys()],
    };
}

export type LlmRequests = ReturnType<typeof createLlmRequests>;

function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return `${error}`;
}

/** The request's dynamic model, accepted only for the id it names and a format the server runs. */
function dynamicModelFor(body: LlmRequestBody, id: string): LLMModel[] {
    const hint = body.dynamicModel;
    if (!hint || hint.id !== id || hint.format === LLMFormat.Plugin || hint.format === LLMFormat.WebLLM) {
        return [];
    }
    return [structuredClone(hint)];
}
