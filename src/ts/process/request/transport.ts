import { selectedCharacter } from "../../storage/characterStore.svelte";
import { currentChatRef } from "../../storage/chatStore.svelte";
import { settings, activePreset, activePersona } from "../../storage/settingsViews.svelte";
import {
    REQUEST_ARG_KEYS,
    type BufferedResponse,
    type LlmCallbackAnswer,
    type LlmRequestBody,
    type LlmRequestEvent,
    type RequestArgs,
    type StreamResponseChunk,
    type ToolCallRecord,
} from "../../../../shared/llm/request.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../../shared/resources.ts";
import { alertError } from "src/ts/alert";
import { appendFetchLog } from "src/ts/globalApi.svelte";
import { getModelInfo, isDynamicModel, LLMFlags, type LLMModel } from "src/ts/model/modellist";
import { activeChannelCall } from "src/ts/network/channelCallSource";
import { generationClientId } from "src/ts/network/generationJobs";
import { risuChatParserScoped } from "src/ts/parser/parser.svelte";
import { capturePluginContext, type PluginCallContext } from "src/ts/plugins/apiV3/pluginContext";
import { pluginHooks } from "src/ts/plugins/pluginHooks";
import { authFetch } from "src/ts/storage/nodeStorage";
import { epochMismatch, getResourceEpoch } from "src/ts/storage/resourceClient";
import { flushResources } from "src/ts/storage/resourceSync.svelte";
import { checkPersonaBinded } from "src/ts/util";
import { saveInlayedSignature, setInlayAsset, writeInlayImage } from "../files/inlays";
import { callTool, decodeToolCall, encodeToolCall } from "../mcp/mcp";
import type { MCPTool } from "../mcp/mcplib";
import type { ModelModeExtended } from "./shared";

type ClientResponse =
    | BufferedResponse
    | {
          type: "streaming";
          result: ReadableStream<StreamResponseChunk>;
          special?: { emotion?: string };
          model?: string;
      };

/** The client argument fields the transport reads besides the serializable ones. */
export type TransportArgument = RequestArgs & {
    currentChar?: { chaId?: string } | null;
    pluginContext?: PluginCallContext;
    tools?: MCPTool[];
};

/** The markers the adapters decode (`<tool_call>inner</tool_call>`; the widest of their patterns). */
const TOOL_CALL_MARKER = /<tool_call>(.*?)<\/tool_call>/gs;

function fail(result: string): ClientResponse {
    return { type: "fail", result };
}

function selectedChatRef(): { chaId: string; chatId: string } | null {
    return currentChatRef();
}

/** `decodeToolCall(inner)` for every marker in the prompt, by inner text (the server looks them up). */
async function collectToolRecords(
    formated: RequestArgs["formated"],
    chatRef: { chaId: string; chatId: string } | null,
): Promise<Record<string, ToolCallRecord>> {
    const records: Record<string, ToolCallRecord> = {};
    for (const message of formated) {
        if (typeof message.content !== "string" || !message.content.includes("<tool_call>")) {
            continue;
        }
        for (const match of message.content.matchAll(TOOL_CALL_MARKER)) {
            const inner = match[1];
            if (Object.hasOwn(records, inner)) {
                continue;
            }
            try {
                const record = await decodeToolCall(inner, chatRef);
                if (record) {
                    records[inner] = JSON.parse(JSON.stringify(record));
                }
            } catch (error) {
                console.error(error);
            }
        }
    }
    return records;
}

function dataUrlImage(mimeType: string, data: string): HTMLImageElement {
    const image = new Image();
    image.src = `data:${mimeType};base64,${data}`;
    return image;
}

/**
 * The client half of `POST /api/llm/request` (Phase 5, `request-layer-and-llm-secrets`): what
 * `requestChatDataMain` does for every format the tab does not run itself. The context ids and the
 * arguments are taken before the first await (so a selection change while the save flushes does not
 * move the request), the pending saves are flushed (an edit made just before reaches the provider;
 * a refused flush fails the request), and the SSE events are handled in order: logs go to the
 * request log, notices to `alertError`, inlays and tool records are written before any later event
 * is handled, callbacks (`mcpTool`, `cbs`) are answered without holding up the stream, and the
 * result or the stream becomes the `requestDataResponse` the caller expects.
 */
export async function requestServer(
    arg: TransportArgument,
    model: ModelModeExtended,
    abortSignal: AbortSignal | null,
    modelInfo: LLMModel,
): Promise<ClientResponse> {
    // Everything that depends on the selection is read now, before any await.
    const chatRef = arg.chatRef ?? null;
    // A parse the server asks for without a chat runs on the chat that was selected now.
    const parseChatRef = chatRef ?? selectedChatRef();
    const pluginContext = arg.pluginContext ?? capturePluginContext(parseChatRef);
    const presetId = pluginContext?.presetId || activePreset.id || "";
    const selectedPersonaId = activePersona.id ?? "";
    // `getUserName()` (no chat): the selected chat's bound persona, else the selected persona.
    const personaId = checkPersonaBinded()?.id ?? selectedPersonaId;
    const scope = { presetId, personaId: pluginContext?.personaId || personaId };
    const mainModel = getModelInfo(activePreset.aiModel);
    const args: Record<string, unknown> = {};
    for (const key of REQUEST_ARG_KEYS) {
        if (arg[key] !== undefined) {
            args[key] = arg[key];
        }
    }
    const requestArgs = JSON.parse(JSON.stringify(args)) as RequestArgs;
    const body: Omit<LlmRequestBody, "toolRecords"> = {
        clientId: generationClientId(),
        mode: model,
        context: {
            presetId,
            personaId,
            selectedPersonaId,
            selectedCharacterId: selectedCharacter()?.chaId ?? null,
            speakerId: arg.currentChar?.chaId ?? null,
            mainModel: { imageInput: mainModel.flags.includes(LLMFlags.hasImageInput) },
            // `encode`'s scope (`src/ts/tokenizer.ts`), as the tab would tokenize now.
            // A field a fresh store has not set yet is sent as the value `encode` treats it as.
            tokenizer: {
                aiModel: activePreset.aiModel ?? "",
                currentPluginProvider: activePreset.currentPluginProvider ?? "",
                modelTokenizer: mainModel.tokenizer,
                ...(mainModel.internalID !== undefined ? { modelInternalID: mainModel.internalID } : {}),
                pluginTokenizer:
                    pluginHooks.providerOptions.get(activePreset.currentPluginProvider)?.tokenizer ?? "none",
                customTokenizer: settings.providers.customTokenizer ?? "",
                googleClaudeTokenizing: !!settings.providers.googleClaudeTokenizing,
                useTokenizerCaching: !!settings.providers.useTokenizerCaching,
            },
        },
        arg: requestArgs,
        tools: JSON.parse(
            JSON.stringify(
                (arg.tools ?? []).map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                })),
            ),
        ),
        ...(isDynamicModel(modelInfo.id) ? { dynamicModel: JSON.parse(JSON.stringify(modelInfo)) } : {}),
    };
    const channelCall = activeChannelCall();
    if (channelCall) {
        body.channelCall = channelCall;
    }

    // The caller's abort is watched from here on: through the flush, the tool-record reads, the
    // POST, and the events.
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortSignal?.reason);
    if (abortSignal?.aborted) {
        return fail("Aborted");
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    const detach = () => abortSignal?.removeEventListener("abort", onAbort);
    try {
        await flushResources();
    } catch (error) {
        detach();
        return fail(`${error instanceof Error ? error.message : error}`);
    }
    if (controller.signal.aborted) {
        detach();
        return fail("Aborted");
    }
    // The request's chat as captured above (not the selection after the awaits).
    const toolRecords = await collectToolRecords(requestArgs.formated, chatRef);
    if (controller.signal.aborted) {
        detach();
        return fail("Aborted");
    }

    let response: Response;
    try {
        response = await authFetch("/api/llm/request", {
            method: "POST",
            headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
            body: JSON.stringify({ ...body, toolRecords }),
            signal: controller.signal,
            cache: "no-store",
        });
    } catch (error) {
        detach();
        return fail(controller.signal.aborted ? "Aborted" : `${error}`);
    }
    if (controller.signal.aborted) {
        detach();
        await response.body?.cancel().catch(() => {});
        return fail("Aborted");
    }
    if (!response.ok || !response.body) {
        detach();
        let error = `HTTP ${response.status}`;
        try {
            const parsed = await response.json();
            if (response.status === 412 && parsed?.error === "EpochMismatch" && typeof parsed.epoch === "string") {
                throw epochMismatch(parsed.epoch);
            }
            if (typeof parsed?.error === "string") {
                error = parsed.error;
            }
        } catch (thrown) {
            if (thrown instanceof Error && thrown.name === "ResourceEpochMismatchError") {
                return fail(thrown.message);
            }
        }
        return fail(error);
    }

    return await readEvents(response.body, {
        controller,
        detach,
        clientId: body.clientId,
        parseChatRef,
        toolChatRef: chatRef,
        scope,
    });
}

type ReadOptions = {
    controller: AbortController;
    detach: () => void;
    clientId: string;
    /** The request's chat: a remembered tool call is stored with it (none: this browser's own store). */
    toolChatRef: { chaId: string; chatId: string } | null;
    /** The chat a parse without its own target runs on (the request's, else the one selected at its start). */
    parseChatRef: { chaId: string; chatId: string } | null;
    scope: { presetId: string; personaId: string };
};

async function readEvents(body: ReadableStream<Uint8Array>, options: ReadOptions): Promise<ClientResponse> {
    if (options.controller.signal.aborted) {
        await body.cancel().catch(() => {});
        options.detach();
        return fail("Aborted");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let requestId = "";
    let settled = false;
    let resolveResponse!: (response: ClientResponse) => void;
    const responsePromise = new Promise<ClientResponse>((resolve) => (resolveResponse = resolve));
    let stream: ReadableStreamDefaultController<StreamResponseChunk> | null = null;
    let current: Record<string, string> = {};
    // One ordered lane: an inlay or a tool record is written before any later event is handled.
    let lane: Promise<void> = Promise.resolve();
    // One answer per callback id, computed once: a repeat (in flight or done) reuses it.
    const answers = new Map<string, Promise<LlmCallbackAnswer>>();
    /** Set when the request ended here (cancelled, failed): nothing more is handled or started. */
    let stopped = false;

    const respond = (response: ClientResponse) => {
        if (!settled) {
            settled = true;
            resolveResponse(response);
        }
    };
    const stop = (reason?: unknown) => {
        stopped = true;
        options.controller.abort(reason);
        reader.cancel(reason).catch(() => {});
        options.detach();
    };
    if (options.controller.signal.aborted) {
        stopped = true;
    }
    options.controller.signal.addEventListener("abort", () => (stopped = true), { once: true });

    async function postAnswer(answer: LlmCallbackAnswer) {
        // A failed POST is retried with the same answer, never rerun; a dead request is not retried.
        for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
            try {
                const res = await authFetch(`/api/llm/request/${encodeURIComponent(requestId)}/answer`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ clientId: options.clientId, ...answer }),
                    cache: "no-store",
                });
                if (res.ok || res.status === 404) {
                    return;
                }
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }

    async function compute(event: Extract<LlmRequestEvent, { type: "callback" }>): Promise<LlmCallbackAnswer> {
        try {
            let value: unknown;
            if (event.name === "mcpTool") {
                value = await callTool(event.payload.name, event.payload.args);
            } else {
                const target = event.payload.chatRef ?? options.parseChatRef;
                const parseArg = target ? { chatRef: target } : {};
                value = risuChatParserScoped(event.payload.text, parseArg, options.scope);
            }
            return { callbackId: event.id, outcome: "answered", value: JSON.parse(JSON.stringify(value ?? null)) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { callbackId: event.id, outcome: "failed", error: message || "The callback failed" };
        }
    }

    async function runCallback(event: Extract<LlmRequestEvent, { type: "callback" }>) {
        let answer = answers.get(event.id);
        if (!answer) {
            if (stopped) {
                // Not started after the request ended (one already running cannot be stopped).
                return;
            }
            answer = compute(event);
            answers.set(event.id, answer);
        }
        await postAnswer(await answer);
    }

    async function handle(event: LlmRequestEvent) {
        if (stopped) {
            return;
        }
        switch (event.type) {
            case "accepted":
                requestId = event.id;
                return;
            case "log":
                appendFetchLog(event.entry as Parameters<typeof appendFetchLog>[0]);
                return;
            case "notice":
                alertError(event.message);
                return;
            case "inlay": {
                const inlay = event.inlay;
                if (inlay.kind === "signature") {
                    await saveInlayedSignature(inlay.id, inlay.signature);
                } else if (inlay.kind === "image") {
                    await writeInlayImage(dataUrlImage(inlay.mimeType, inlay.data), { id: inlay.id });
                } else {
                    await setInlayAsset(inlay.id, {
                        name: inlay.name,
                        type: "audio",
                        data: inlay.data,
                        height: 0,
                        width: 0,
                        ext: inlay.ext,
                    });
                }
                return;
            }
            case "toolRecord":
                // Stored with the request's chat (the server reads it there for a later request).
                await encodeToolCall(event.record, options.toolChatRef);
                return;
            case "callback":
                // Not awaited: the server waits for the answer, and later events keep coming.
                void runCallback(event);
                return;
            case "result":
                respond(event.response);
                return;
            case "streaming": {
                const result = new ReadableStream<StreamResponseChunk>({
                    start(c) {
                        stream = c;
                    },
                    cancel(reason) {
                        stream = null;
                        stop(reason);
                    },
                });
                respond({
                    type: "streaming",
                    result,
                    ...(event.special ? { special: event.special } : {}),
                    ...(event.model ? { model: event.model } : {}),
                });
                return;
            }
            case "chunk": {
                const next = { ...current };
                for (const key of event.remove ?? []) {
                    delete next[key];
                }
                for (const [key, value] of Object.entries(event.set ?? {})) {
                    next[key] = value;
                }
                for (const [key, value] of Object.entries(event.append ?? {})) {
                    next[key] = (next[key] ?? "") + value;
                }
                current = next;
                stream?.enqueue({ ...next });
                return;
            }
            case "chunkText":
                // OobaLegacy enqueues its cumulative text as a string; so does the transport.
                stream?.enqueue(event.value as unknown as StreamResponseChunk);
                return;
            case "end":
                stream?.close();
                stream = null;
                return;
            case "error":
                if (!settled) {
                    respond(fail(event.message));
                } else {
                    stream?.error(new Error(event.message));
                    stream = null;
                }
                return;
        }
    }

    const pump = async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                let index: number;
                while ((index = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const data = frame
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.replace(/^data:\s?/, ""))
                        .join("\n");
                    if (!data) {
                        continue;
                    }
                    let event: LlmRequestEvent;
                    try {
                        event = JSON.parse(data);
                    } catch {
                        throw new Error("The server sent a malformed event");
                    }
                    lane = lane.then(() => handle(event));
                    if (event.type === "inlay" || event.type === "toolRecord") {
                        // A write failure must not let a later marker through: wait here.
                        await lane;
                    }
                }
            }
            await lane;
            // The request is over: a tool still running answers nobody.
            stopped = true;
            // The stream ended without a terminal event: a truncated answer is a failure.
            if (!settled) {
                respond(fail("The server ended the request without an answer"));
            } else if (stream) {
                stream.error(new Error("The server ended the stream early"));
                stream = null;
            }
        } catch (error) {
            const message = options.controller.signal.aborted
                ? "Aborted"
                : `${error instanceof Error ? error.message : error}`;
            if (!settled) {
                respond(fail(message));
            } else if (stream) {
                stream.error(new Error(message));
                stream = null;
            }
            stop(error);
        } finally {
            options.detach();
        }
    };
    void pump();
    return await responsePromise;
}
