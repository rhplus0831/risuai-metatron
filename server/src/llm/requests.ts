import { randomUUID } from "node:crypto";
import { LLMFormat, type LLMModel } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import { isToolContentEntry } from "../../../shared/llm/validate.ts";
import { MAX_PROVIDER_TEXT_CHARS } from "../../../shared/jobs.ts";
import {
    LLM_CALLBACK_TIMEOUT_MS,
    type LlmCallbackAnswer,
    type LlmCallbackName,
    type LlmCallbackPayloads,
    type LlmRequestBody,
    type LlmRequestEvent,
    type ModelModeExtended,
    type RequestArgs,
    type RPCToolCallContent,
    type StreamResponseChunk,
    type ToolCallRecord,
} from "../../../shared/llm/request.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { JobChannel } from "../jobs/channel.ts";
import type { TokenCounter, TokenCountScope } from "../prompt/tokens.ts";
import type { ClaudeObserver } from "./claudeObserver.ts";
import type { PluginProviderAnswer, RequestContext } from "./context.ts";
import { messages } from "./messages.ts";
import { collectSecrets, createRedactor, redactHeaderText, type Redactor } from "./redact.ts";
import { requestChatDataMain, type requestDataResponse } from "./request.ts";
import { type LoadedRequestDb, loadRequestDb, RequestTargetGoneError } from "./settings.ts";
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
    /** The server's local generation models (`transformers.runTextGeneration`), for a job's request. */
    localGeneration?: (
        text: string,
        model: string,
        config: Record<string, unknown>,
        signal: AbortSignal,
    ) => Promise<string>;
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
    return Array.isArray(value) && value.every(isToolContentEntry);
}

/**
 * `bodyIntercepter` through a job's channel (the client's `bodyIntercepterStore`): as a child of
 * the job callback the request runs inside (`parentId`), or as a root callback of the job that makes
 * the request itself. A body that carries a stored credential is never handed to a plugin; the
 * failure policy is the browser path's (a hook's throw keeps the body; a barrier failure, a timeout,
 * or a disconnect ends the job).
 */
function channelIntercept(p: {
    channel: JobChannel;
    parentId?: string;
    signal: AbortSignal;
    redactor: () => Redactor;
    endWith: (message: string, endsJob: boolean) => Error;
    fatal: (message: string) => Error;
    /**
     * A job's own request (`runInJob`): every outcome other than an answer, an unregistered hook, or a
     * hook's own throw ends the job (a protocol failure, a nesting or queue refusal, an abort), as
     * the job's other callbacks do.
     */
    strict?: boolean;
}): (value: unknown, type: string) => Promise<unknown> {
    const strict = p.strict === true;
    return async (value, type) => {
        if (p.signal.aborted) {
            throw p.signal.reason;
        }
        // A plugin sees the body in the tab: a body that carries a stored credential (one the user
        // put into a parameter) is not handed to it, and the request fails.
        if (p.redactor().carries(value)) {
            throw p.endWith(
                "The request body carries a stored credential; it is not sent to a plugin interceptor",
                false,
            );
        }
        const result = await p.channel.callback(
            "bodyIntercepter",
            { body: value, type },
            p.parentId ? { parentId: p.parentId } : {},
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
                throw p.endWith(`The bodyIntercepter callback was refused: ${result.error}`, strict);
            case "failed":
                if (result.failure === "hook") {
                    // An interceptor that threw: the browser path logs it and sends the body.
                    console.error("[LLM] bodyIntercepter:", p.redactor().text(result.error));
                    return value;
                }
                throw p.endWith(
                    `The bodyIntercepter callback failed: ${result.error}`,
                    strict || result.failure === "barrier",
                );
            case "timedOut":
            case "disconnected":
                throw p.endWith(`The bodyIntercepter callback ${result.outcome}: ${result.error}`, true);
            default:
                if (strict) {
                    throw p.endWith(`The bodyIntercepter callback ended: ${result.error}`, true);
                }
                throw p.fatal(`The bodyIntercepter callback ended: ${result.error}`);
        }
    };
}

/** A log entry's secret-free projection: the fields a credential could be in, redacted. */
function redactLogEntry(entry: unknown, redactor: Redactor): Record<string, unknown> {
    const source = entry as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };
    for (const field of ["body", "header", "response", "url"]) {
        if (typeof source[field] === "string") {
            out[field] = redactor.text(source[field] as string);
        }
    }
    return out;
}

/** A failure's or a preview's text, redacted (a model's answer is the user's text and stays as it is). */
function redactResponse(response: requestDataResponse, redactor: Redactor): requestDataResponse {
    if (response.type === "multiline") {
        return { ...response, result: response.result.map(([role, text]) => [role, redactor.text(text)]) };
    }
    if (response.type === "streaming") {
        return response;
    }
    return { ...response, result: redactor.text(response.result) };
}

/**
 * A request a server job makes in-process (Lua `LLM`, `simpleLLM`, `axLLM` in slice 8a): the job's
 * frozen settings (`loaded`, read once at the job's start), its derived token scope, and the job's
 * own sinks instead of a tab's SSE stream.
 */
export type JobRequestSpec = {
    jobId: string;
    loaded: LoadedRequestDb;
    mode: ModelModeExtended;
    arg: RequestArgs;
    tokenScope: TokenCountScope;
    mainModelImageInput: boolean;
    /** The job's channel: `bodyIntercepter` runs as a root callback of the job. */
    channel: JobChannel;
    /** The job's own CBS evaluation (with the request's chat). */
    parseCbs: (text: string, chatRef?: { chaId: string; chatId: string } | null) => string;
    /** Persists what an adapter writes (signatures and audio on the server; images through the tab). */
    inlays: RequestContext["inlays"];
    /** A redacted request-log entry (the tab's `requestLog` notice). */
    log: (entry: Record<string, unknown>) => void;
    /** A redacted `alertError` text for the tab. */
    alertError: (text: string) => void;
    /** Ends the job: a barrier failure, a timeout, or a disconnect of an interceptor callback. */
    endJob: (message: string) => void;
    /**
     * The remembered tool calls of the job's chat (`chat.toolCalls`, slice 11b): read as stored now,
     * and a new record written with the chat.
     */
    toolCalls: {
        read(): Record<string, ToolCallRecord> | undefined;
        write(record: ToolCallRecord): void;
    };
    /** The job's and the calling host task's signal: the request ends with it. */
    signal: AbortSignal;
};

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

    type ContextParts = {
        loaded: LoadedRequestDb;
        tokenScope: TokenCountScope;
        controller: AbortController;
        /** The request's redactor as it is now (a Vertex token joins it when acquired). */
        redactor: () => Redactor;
        extraModels: (modelId: string) => LLMModel[];
        /** A log entry, its header line already redacted. */
        log: (entry: FetchLogEntry) => void;
        alertError: (text: string) => void;
        parseCbs: RequestContext["parseCbs"];
        tools: RequestContext["tools"];
        inlays: RequestContext["inlays"];
        intercept: RequestContext["intercept"];
        /** A job's request: its tab's plugin providers (`RequestContext.pluginProvider`). */
        pluginProvider?: RequestContext["pluginProvider"];
        supportsInlayImage: () => boolean;
        /** A job's own request: models the server knows only through a tab (see `runInJob`). */
        browserOnlyModels?: boolean;
    };

    /** The `RequestContext` both entries share (`start` for a tab, `runInJob` for a job). */
    function buildContext(p: ContextParts): RequestContext {
        const { db } = p.loaded;
        const modelInfo = (modelId: string): LLMModel => {
            const model = resolveModelInfo(modelId, {
                enableCustomFlags: db.enableCustomFlags,
                customFlags: db.customFlags,
                customModels: db.customModels,
                extraModels: p.extraModels(modelId),
                // A job's plugin provider descriptors, returned as registered (the tab's
                // `pluginModels` branch: custom flags do not apply to them).
                pluginModels: db.pluginModels,
            });
            // A plugin model or a tab's dynamic model reaches the server only as the tab's descriptor;
            // without one, the catalogue would read it as an OpenAI-compatible model and send it to
            // OpenAI. A job has no tab descriptor: such a model runs in the browser (refused).
            if (p.browserOnlyModels && (modelId.startsWith("pluginmodel:::") || modelId.startsWith("dynamic_"))) {
                return { ...model, format: LLMFormat.Plugin };
            }
            return model;
        };
        const tokenizeNum = (text: string) => options.tokens.encode(text, p.tokenScope);
        const transport = createTransport({
            signal: p.controller.signal,
            log: (entry: FetchLogEntry) => p.log({ ...entry, header: redactHeaderText(entry.header) }),
            intercept: p.intercept,
            redact: (text) => p.redactor().text(text),
            fetchImpl: options.fetchImpl,
        });
        return {
            db,
            selectedCharacterName: p.loaded.selectedCharacterName,
            speakerName: p.loaded.speakerName,
            userName: p.loaded.userName,
            signal: p.controller.signal,
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
                p.alertError(text);
            },
            redactText: (text) => p.redactor().text(text),
            tokenizeNum,
            strongBan: (text, bias) => strongBan(text, bias, tokenizeNum),
            parseCbs: p.parseCbs,
            tools: p.tools,
            inlays: p.inlays,
            supportsInlayImage: p.supportsInlayImage,
            getModelInfo: modelInfo,
            intercept: p.intercept,
            ...(p.pluginProvider ? { pluginProvider: p.pluginProvider } : {}),
            // A job's request only (`browserOnlyModels`): a tab runs its local models itself.
            ...(p.browserOnlyModels && options.localGeneration
                ? {
                      localGeneration: (text: string, model: string, config: Record<string, unknown>) =>
                          options.localGeneration!(text, model, config, p.controller.signal),
                  }
                : {}),
            vertexAccessToken: async (clientEmail, privateKey) => {
                const token = await options.vertexTokens.get(clientEmail, privateKey, p.controller.signal);
                p.redactor().add(token);
                return token;
            },
            registerClaudeObserver: (arg) => {
                // Work that drains after the request ended (maintenance reset the warmer) must
                // not register the old request and its key again.
                if (!p.controller.signal.aborted) {
                    options.claudeObserver.register(arg);
                }
            },
        };
    }

    /**
     * Runs a job's request in-process (`JobRequestSpec`): admitted like a tab's request (refused
     * during shutdown and maintenance, ended by `pause`/`beginShutdown`, waited for by `dispose`),
     * without the per-client count. A failure's and a preview's text are redacted; a model's answer
     * is not. A stream is handed back live: the request ends when it is read to the end, cancelled,
     * or the job's signal aborts. An abort of the job rejects; any other failure is a `fail` result.
     */
    async function runInJob(spec: JobRequestSpec): Promise<requestDataResponse> {
        if (!accepting) {
            return { type: "fail", result: "The server is shutting down", noRetry: true };
        }
        if (paused) {
            return { type: "fail", result: "The server is under maintenance", noRetry: true };
        }
        if (spec.signal.aborted) {
            throw spec.signal.reason ?? new Error("The job ended");
        }
        const id = randomUUID();
        const controller = new AbortController();
        // A job's requests are not a client's: the client count never sees this id.
        const live: LiveRequest = {
            id,
            clientId: `\u0000job:${spec.jobId}`,
            controller,
            callbacks: new Map(),
            finishedCallbacks: new Set(),
        };
        requests.set(id, live);
        let resolveDrained!: () => void;
        const drained = new Promise<void>((resolve) => {
            resolveDrained = resolve;
        });
        draining.add(drained);
        let finalized = false;
        const onJobAbort = () => controller.abort(spec.signal.reason ?? new Error("The job ended"));
        spec.signal.addEventListener("abort", onJobAbort, { once: true });
        const finalize = () => {
            if (finalized) {
                return;
            }
            finalized = true;
            spec.signal.removeEventListener("abort", onJobAbort);
            if (!controller.signal.aborted) {
                controller.abort(new Error("The request finished"));
            }
            requests.delete(id);
            draining.delete(drained);
            resolveDrained();
        };
        const redactor = createRedactor(collectSecrets(spec.loaded.db));
        const fatal = (message: string) => {
            const error = new FatalRequestError(message);
            controller.abort(error);
            return error;
        };
        const endWith = (message: string, endsJob: boolean) => {
            const error = fatal(message);
            if (endsJob) {
                spec.endJob(redactor.text(message));
            }
            return error;
        };
        const ctx = buildContext({
            loaded: spec.loaded,
            tokenScope: spec.tokenScope,
            controller,
            redactor: () => redactor,
            extraModels: () => [],
            log: (entry) => spec.log(redactLogEntry(entry, redactor)),
            alertError: (text) => spec.alertError(redactor.text(text)),
            parseCbs: async (text, chatRef) => spec.parseCbs(text, chatRef),
            tools: {
                // Server-side requests send no tools until slice 12 (recorded): nothing calls a tool.
                call: async () => {
                    throw fatal("Tools are not available to server-side requests yet");
                },
                // A remembered call is conversation data, stored with the job's chat as it is: one
                // that carries a stored credential is refused (the chat goes to the tab).
                encode: async (record) => {
                    record.call.id = record.call.id || randomUUID();
                    if (redactor.carries(record)) {
                        throw fatal("A remembered tool call carries a stored credential; it is not stored");
                    }
                    spec.toolCalls.write(record);
                    return `<tool_call>${record.call.id}\uf100${record.call.name}</tool_call>\n\n`;
                },
                decode: async (text) => decodeToolCall(text, spec.toolCalls.read()),
            },
            pluginProvider: (name, argument) => {
                // The tab's plugin gets the prompt and the parameters, never a stored credential.
                if (redactor.carries(argument) || redactor.carries(name)) {
                    return Promise.resolve({
                        success: false,
                        content: "The request carries a stored credential; it is not sent to a plugin provider",
                    });
                }
                return new Promise<PluginProviderAnswer>((resolve, reject) => {
                    // Pending until the first message: a `chunk` makes it a stream, an answer a text.
                    // The stream holds one value at most: the texts are cumulative, so a newer one
                    // replaces one the reader has not taken yet (a slow reader keeps no backlog).
                    let out: ReadableStreamDefaultController<StreamResponseChunk> | null = null;
                    let ended = false;
                    let latest: string | null = null;
                    let waiting = false;
                    let finished = false;
                    const gaveUp = new AbortController();
                    const deliver = () => {
                        if (!out || !waiting) {
                            return;
                        }
                        if (latest !== null) {
                            waiting = false;
                            const text = latest;
                            latest = null;
                            out.enqueue({ "0": text });
                        } else if (finished) {
                            waiting = false;
                            out.close();
                        }
                    };
                    const onChunk = (text: string) => {
                        if (ended) {
                            return;
                        }
                        if (!out) {
                            const stream = new ReadableStream<StreamResponseChunk>(
                                {
                                    start(streamController) {
                                        out = streamController;
                                    },
                                    pull() {
                                        waiting = true;
                                        deliver();
                                    },
                                    // The reader stopped: the callback ends and the tab stops the provider.
                                    cancel() {
                                        ended = true;
                                        latest = null;
                                        gaveUp.abort(new Error("The provider's stream was cancelled"));
                                    },
                                },
                                { highWaterMark: 0 },
                            );
                            resolve({ success: true, stream });
                            if (text === "") {
                                // The first chunk only says "a stream": an empty one carries no text.
                                return;
                            }
                        }
                        latest = text;
                        deliver();
                    };
                    /** The provider failed: the stream errors, or (before any chunk) the request does. */
                    const fail = (error: Error) => {
                        if (ended) {
                            return;
                        }
                        ended = true;
                        latest = null;
                        if (out) {
                            try {
                                out.error(error);
                            } catch {}
                        } else {
                            reject(error);
                        }
                    };
                    void spec.channel
                        .callback(
                            "provider",
                            { name, argument },
                            {
                                timeoutMs: PROVIDER_CALLBACK_TIMEOUT_MS,
                                onChunk,
                                signal: AbortSignal.any([controller.signal, gaveUp.signal]),
                            },
                        )
                        .then((result) => {
                            switch (result.outcome) {
                                case "answered": {
                                    const value = result.value as Record<string, unknown> | null;
                                    const isObject = typeof value === "object" && value !== null;
                                    if (
                                        isObject &&
                                        typeof value.content === "string" &&
                                        value.content.length > MAX_PROVIDER_TEXT_CHARS
                                    ) {
                                        // The limit of a streamed text holds for an answer's text too.
                                        fail(new Error("The provider's text is too long"));
                                        return;
                                    }
                                    if (out) {
                                        if (isObject && value.success === true) {
                                            if (!ended) {
                                                // The newest text still waiting goes out before the end.
                                                ended = true;
                                                finished = true;
                                                deliver();
                                            }
                                        } else {
                                            fail(
                                                new Error(
                                                    isObject && typeof value.content === "string"
                                                        ? redactor.text(value.content)
                                                        : "The provider failed",
                                                ),
                                            );
                                        }
                                    } else if (isObject && value.none === true) {
                                        ended = true;
                                        resolve({ none: true });
                                    } else if (
                                        isObject &&
                                        typeof value.success === "boolean" &&
                                        typeof value.content === "string"
                                    ) {
                                        ended = true;
                                        resolve({ success: value.success, content: value.content });
                                    } else {
                                        fail(endWith("The provider callback answered a malformed value", true));
                                    }
                                    return;
                                }
                                case "refused":
                                    if (result.refusal === "unregistered") {
                                        // Not among the providers the tab registered for this job.
                                        if (!ended && !out) {
                                            ended = true;
                                            resolve({ success: false, content: messages.pluginProviderNotFound });
                                        }
                                        return;
                                    }
                                    fail(endWith(`The provider callback was refused: ${result.error}`, true));
                                    return;
                                case "failed":
                                    if (result.failure === "hook") {
                                        // The provider threw or is unloaded: the request fails, as in the tab.
                                        fail(new Error(redactor.text(result.error)));
                                        return;
                                    }
                                    fail(endWith(`The provider callback failed: ${result.error}`, true));
                                    return;
                                case "aborted":
                                    // The request ended, or its reader stopped: nothing left to tell.
                                    fail(new Error(redactor.text(errorText(controller.signal.reason ?? result.error))));
                                    return;
                                default:
                                    fail(endWith(`The provider callback ${result.outcome}: ${result.error}`, true));
                            }
                        });
                });
            },
            inlays: spec.inlays,
            intercept: channelIntercept({
                channel: spec.channel,
                signal: controller.signal,
                redactor: () => redactor,
                endWith,
                fatal,
                strict: true,
            }),
            supportsInlayImage: () => spec.mainModelImageInput,
            browserOnlyModels: true,
        });
        const failed = (error: unknown): requestDataResponse => {
            if (spec.signal.aborted) {
                throw spec.signal.reason ?? new Error("The job ended");
            }
            const reason = controller.signal.aborted ? controller.signal.reason : error;
            return { type: "fail", result: redactor.text(errorText(reason)), noRetry: true };
        };
        let response: requestDataResponse;
        try {
            response = await requestChatDataMain({ ...spec.arg, tools: [] }, spec.mode, ctx);
        } catch (error) {
            // Classified before the cleanup, whose own abort would otherwise become the reason.
            try {
                return failed(error);
            } finally {
                finalize();
            }
        }
        if (controller.signal.aborted) {
            if (response.type === "streaming") {
                await response.result.cancel(controller.signal.reason).catch(() => {});
            }
            try {
                return failed(controller.signal.reason);
            } finally {
                finalize();
            }
        }
        if (response.type !== "streaming") {
            finalize();
            return response.type === "fail" || spec.arg.previewBody ? redactResponse(response, redactor) : response;
        }
        const reader = response.result.getReader();
        let output!: ReadableStreamDefaultController<StreamResponseChunk>;
        let settled = false;
        const end = () => {
            settled = true;
            controller.signal.removeEventListener("abort", onAbort);
            finalize();
        };
        // An abort ends the request at once, whether or not the stream is being read, and the
        // stream errors with the (redacted) reason: a reader never mistakes it for the end.
        const onAbort = () => {
            if (settled) {
                return;
            }
            const reason = new Error(redactor.text(errorText(controller.signal.reason)));
            reader.cancel(controller.signal.reason).catch(() => {});
            end();
            try {
                output.error(reason);
            } catch {}
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        const stream = new ReadableStream<StreamResponseChunk>(
            {
                start(c) {
                    output = c;
                },
                async pull(out) {
                    try {
                        const { done, value } = await reader.read();
                        if (settled) {
                            return;
                        }
                        if (done) {
                            end();
                            out.close();
                            return;
                        }
                        out.enqueue(value as StreamResponseChunk);
                    } catch (error) {
                        if (settled) {
                            return;
                        }
                        const reason = controller.signal.aborted ? controller.signal.reason : error;
                        end();
                        out.error(new Error(redactor.text(errorText(reason))));
                    }
                },
                cancel(reason) {
                    reader.cancel(reason).catch(() => {});
                    end();
                },
            },
            { highWaterMark: 0 },
        );
        return { ...response, result: stream };
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
                case "log":
                    return { ...event, entry: redactLogEntry(event.entry, redactor) };
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
            redactor = createRedactor(collectSecrets(loaded.db));
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
                googleAccessToken: loaded.db.google?.accessToken,
            };
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
            const viaChannel = parent
                ? channelIntercept({
                      channel: parent.channel,
                      parentId: body.channelCall!.callbackId,
                      signal: controller.signal,
                      redactor: () => redactor,
                      endWith,
                      fatal,
                  })
                : null;
            const intercept = async (value: unknown, type: string): Promise<unknown> =>
                // No job callback: interceptors are not applied (recorded).
                viaChannel ? viaChannel(value, type) : value;

            const toolRecords = new Map<string, ToolCallRecord>(Object.entries(body.toolRecords));
            const ctx = buildContext({
                loaded,
                tokenScope,
                controller,
                redactor: () => redactor,
                extraModels: (modelId) => dynamicModelFor(body, modelId),
                log: (entry) => emitRedacted({ type: "log", entry }),
                alertError: (text) => emitRedacted({ type: "notice", kind: "alertError", message: text }),
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
                intercept,
                supportsInlayImage: () => body.context.mainModel.imageInput,
            });

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
        runInJob,
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

/** A `provider` callback may take as long as a job may run (`JOB_MAX_DURATION_MS`). */
const PROVIDER_CALLBACK_TIMEOUT_MS = 30 * 60_000;

/**
 * The client's `decodeToolCall` over a chat's `toolCalls`: the marker (whole, or its inner text
 * `<id>\uf100<name>`) names the call by id.
 */
function decodeToolCall(text: string, calls: Record<string, ToolCallRecord> | undefined): ToolCallRecord | undefined {
    text = text.trim();
    if (text.startsWith("<tool_call>")) {
        text = text.slice("<tool_call>".length).trim();
    }
    if (text.endsWith("</tool_call>")) {
        text = text.slice(0, -"</tool_call>".length).trim();
    }
    const [callId] = text.split("\uf100");
    if (!callId || !calls || !Object.hasOwn(calls, callId)) {
        return undefined;
    }
    return structuredClone(calls[callId]);
}

/** The request's dynamic model, accepted only for the id it names and a format the server runs. */
function dynamicModelFor(body: LlmRequestBody, id: string): LLMModel[] {
    const hint = body.dynamicModel;
    if (!hint || hint.id !== id || hint.format === LLMFormat.Plugin || hint.format === LLMFormat.WebLLM) {
        return [];
    }
    return [structuredClone(hint)];
}
