import { selectedCharacter } from "../../storage/characterStore.svelte";
import {
    chatBinding,
    chatBindingProblems,
    chatBindingRefusalText,
    chatContextIds,
} from "../../storage/chatBinding.svelte";
import {
    type ChatRef,
    chatEntry,
    chatOwnerToken,
    currentChatRef,
    ensureChatLoaded,
    loadChat,
    pinChat,
} from "../../storage/chatStore.svelte";
import {
    settings,
    activeModelPreset,
    activePersona,
    activePreset,
    missingScopeTarget,
    scopedPresetRoot,
} from "../../storage/settingsViews.svelte";
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
import { language } from "src/lang";
import { alertError } from "src/ts/alert";
import { appendFetchLog } from "src/ts/globalApi.svelte";
import { getModelInfoForMode, isDynamicModel, LLMFlags, type LLMModel } from "src/ts/model/modellist";
import { activeChannelCall } from "src/ts/network/channelCallSource";
import { generationClientId } from "src/ts/network/generationJobs";
import { risuChatParserScoped } from "src/ts/parser/parser.svelte";
import { capturePluginContext, type PluginCallContext } from "src/ts/plugins/apiV3/pluginContext";
import { pluginHooks } from "src/ts/plugins/pluginHooks";
import { authFetch } from "src/ts/storage/serverAuth";
import { epochMismatch, getResourceEpoch } from "src/ts/storage/resourceClient";
import { flushResources } from "src/ts/storage/resourceSync.svelte";
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
    /** A chatless request's captured ids (`requestDataArgument.requestIds`). */
    requestIds?: { presetId: string; modelPresetId: string; personaId: string };
    tools?: MCPTool[];
    /** The request chat's owner when the request began (`requestChatData`); captured here otherwise. */
    chatOwner?: string;
};

/** The markers the adapters decode (`<tool_call>inner</tool_call>`; the widest of their patterns). */
const TOOL_CALL_MARKER = /<tool_call>(.*?)<\/tool_call>/gs;

function fail(result: string): ClientResponse {
    return { type: "fail", result };
}

/** A refusal that a retry would only repeat (the chat's binding). */
function refuse(result: string): ClientResponse {
    return { type: "fail", result, noRetry: true };
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
 * The client half of `POST /api/llm/request`: what `requestChatDataMain` does for every format the
 * tab does not run itself. The context ids and the arguments are taken before the first await (so a
 * selection change while the save flushes does not move the request), the pending saves are flushed
 * (an edit made just before reaches the provider; a refused flush fails the request), and the SSE
 * events are handled in order: logs go to the request log, notices to `alertError`, inlays and tool
 * records are written before any later event is handled, callbacks (`mcpTool`, `cbs`) are answered
 * without holding up the stream, and the result or the stream becomes the `requestDataResponse` the
 * caller expects.
 */
export async function requestServer(
    arg: TransportArgument,
    model: ModelModeExtended,
    abortSignal: AbortSignal | null,
    modelInfo: LLMModel,
): Promise<ClientResponse> {
    // Everything that depends on the selection is read now, before any await. A plugin context's
    // chat is the request's chat when the caller named none; the server sees it as `arg.chatRef`.
    const chatRef = arg.chatRef ?? arg.pluginContext?.chatRef ?? null;
    // A parse the server asks for without a chat runs on the chat that was selected now.
    const parseChatRef = chatRef ?? selectedChatRef();
    const pluginContext = arg.pluginContext ?? capturePluginContext(parseChatRef);
    // The ids: a chat's request names its captured context's (the chat's binding when it was
    // captured, or a job callback's targets), else the chat's complete binding; a request without a
    // chat names the ids its caller captured (`requestIds`), else the settings views' (the selected
    // chat's bound ids where they exist, else the tab's selection; `requestChatDataMain` computes with
    // the same ids). It sends no `chatRef`: it is not a send, so no binding refuses it.
    let ids: { presetId: string; modelPresetId: string; personaId: string };
    if (arg.pluginContext) {
        ids = {
            presetId: arg.pluginContext.presetId,
            modelPresetId: arg.pluginContext.modelPresetId,
            personaId: arg.pluginContext.personaId,
        };
    } else if (chatRef) {
        const binding = chatBinding(chatRef);
        if (!binding?.ok) {
            return refuse(chatBindingRefusalText(chatBindingProblems(binding)));
        }
        ids = chatContextIds(binding.ids);
    } else if (arg.requestIds) {
        ids = {
            presetId: arg.requestIds.presetId,
            modelPresetId: arg.requestIds.modelPresetId,
            personaId: arg.requestIds.personaId,
        };
    } else {
        ids = {
            presetId: activePreset.id ?? "",
            modelPresetId: activeModelPreset.id ?? "",
            // `getUserName()` (no chat): the selected chat's bound persona, else the tab's persona.
            personaId: activePersona.id ?? "",
        };
    }
    const { presetId, modelPresetId, personaId } = ids;
    const presetScope = { presetId, modelPresetId };
    // A captured preset that is gone refuses the request here, as the server would by its ids.
    const missing = missingScopeTarget(presetScope);
    if (missing) {
        return fail(`The ${missing} this request runs with no longer exists`);
    }
    // A chat's request has one persona, the chat's; without a chat the captured one, else the
    // view's one, is forwarded.
    const selectedPersonaId = chatRef ? personaId : (arg.requestIds?.personaId ?? activePersona.id ?? "");
    const scope = { presetId, modelPresetId, personaId };
    // The main model and tokenizer of the model preset whose id the request carries.
    const aiModel = (scopedPresetRoot(presetScope, "aiModel") as string | undefined) ?? "";
    const currentPluginProvider = (scopedPresetRoot(presetScope, "currentPluginProvider") as string | undefined) ?? "";
    const mainModel = getModelInfoForMode("model", presetScope);
    const args: Record<string, unknown> = {};
    for (const key of REQUEST_ARG_KEYS) {
        if (arg[key] !== undefined) {
            args[key] = arg[key];
        }
    }
    if (chatRef) {
        args.chatRef = { chaId: chatRef.chaId, chatId: chatRef.chatId };
    }
    const requestArgs = JSON.parse(JSON.stringify(args)) as RequestArgs;
    const body: Omit<LlmRequestBody, "toolRecords"> = {
        clientId: generationClientId(),
        mode: model,
        context: {
            presetId,
            modelPresetId,
            personaId,
            selectedPersonaId,
            // The request chat's character, else the selected one.
            selectedCharacterId: chatRef ? chatRef.chaId : (selectedCharacter()?.chaId ?? null),
            speakerId: arg.currentChar?.chaId ?? null,
            mainModel: { imageInput: mainModel.flags.includes(LLMFlags.hasImageInput) },
            // `encode`'s scope (`src/ts/tokenizer.ts`), as the tab would tokenize now.
            // A field a fresh store has not set yet is sent as the value `encode` treats it as.
            tokenizer: {
                aiModel,
                currentPluginProvider,
                modelTokenizer: mainModel.tokenizer,
                ...(mainModel.internalID !== undefined ? { modelInternalID: mainModel.internalID } : {}),
                pluginTokenizer: pluginHooks.providerOptions.get(currentPluginProvider)?.tokenizer ?? "none",
                customTokenizer: (scopedPresetRoot(presetScope, "customTokenizer") as string | undefined) ?? "",
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
    // The request's chat and its parse chat stay loaded until its events end: its tool records are
    // read and stored there, and the server's CBS callbacks parse there (`detach` releases them).
    const targets = [chatRef, parseChatRef].filter(
        (ref, index, all): ref is ChatRef =>
            ref !== null &&
            all.findIndex((other) => other?.chaId === ref.chaId && other.chatId === ref.chatId) === index,
    );
    const releases = targets.map((ref) => pinChat(ref));
    // Their owners when the request began (the request chat's from `requestChatData`, else now): a
    // chat replaced (even under the same ids) or deleted meanwhile is another chat's request, refused
    // before the POST and in every later callback.
    const owners = targets.map((ref) =>
        ref === chatRef && arg.chatOwner !== undefined ? arg.chatOwner : chatOwnerToken(ref.chaId),
    );
    const targetsHeld = () =>
        targets.every((ref, index) => chatEntry(ref) !== undefined && chatOwnerToken(ref.chaId) === owners[index]);
    const detach = () => {
        abortSignal?.removeEventListener("abort", onAbort);
        for (const release of releases) {
            release();
        }
    };
    try {
        await flushResources();
        for (const ref of targets) {
            if (!(await ensureChatLoaded(ref)) || !targetsHeld()) {
                // A captured chat that is gone (deleted or replaced meanwhile): nothing is requested for it.
                detach();
                return fail("The chat this request is for no longer exists");
            }
        }
    } catch (error) {
        detach();
        return fail(`${error instanceof Error ? error.message : error}`);
    }
    if (controller.signal.aborted) {
        detach();
        return fail("Aborted");
    }
    // The request's chat as captured above (not the selection after the awaits).
    let toolRecords: Awaited<ReturnType<typeof collectToolRecords>>;
    try {
        toolRecords = await collectToolRecords(requestArgs.formated, chatRef);
    } catch (error) {
        detach();
        throw error;
    }
    if (!targetsHeld()) {
        detach();
        return fail("The chat this request is for no longer exists");
    }
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
            if (response.status === 409 && parsed?.error === "chatBindingIncomplete") {
                return refuse(chatBindingRefusalText(Array.isArray(parsed.problems) ? parsed.problems : []));
            }
            if (response.status === 409 && parsed?.error === "chatBindingMismatch") {
                // The server holds a newer binding than this tab: read the chat again for the next request.
                if (chatRef) {
                    void loadChat(chatRef).catch((loadError) => console.error("[Request]", loadError));
                }
                return refuse(language.chatBinding.mismatch);
            }
            if (response.status === 404 && chatRef && typeof parsed?.error === "string") {
                // The request's chat is gone on the server: a retry would only repeat it.
                return refuse(parsed.error);
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
        pluginContext,
        scope,
        targetsHeld,
    });
}

/**
 * A `cbs` callback's parse in its chat: the request's pinned chats are loaded already; another chat
 * the callback names is pinned and loaded for the parse (a chat that is gone fails the callback).
 */
async function parseInLoadedChat(
    text: string,
    target: ChatRef | null,
    scope: { presetId: string; modelPresetId: string; personaId: string },
): Promise<string> {
    if (!target) {
        return risuChatParserScoped(text, {}, scope);
    }
    const owner = chatOwnerToken(target.chaId);
    const release = pinChat(target);
    try {
        if (!(await ensureChatLoaded(target)) || chatOwnerToken(target.chaId) !== owner || !chatEntry(target)) {
            throw new Error("The chat this parse is for no longer exists");
        }
        return risuChatParserScoped(text, { chatRef: target }, scope);
    } finally {
        release();
    }
}

type ReadOptions = {
    pluginContext?: PluginCallContext;
    controller: AbortController;
    detach: () => void;
    clientId: string;
    /** The request's chat: a remembered tool call is stored with it (none: this browser's own store). */
    toolChatRef: { chaId: string; chatId: string } | null;
    /** The chat a parse without its own target runs on (the request's, else the one selected at its start). */
    parseChatRef: { chaId: string; chatId: string } | null;
    scope: { presetId: string; modelPresetId: string; personaId: string };
    /** Whether the request's chats are still the ones it began with (a callback or record for a replaced chat is refused). */
    targetsHeld: () => boolean;
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
            if (!options.targetsHeld()) {
                throw new Error("The chat this request is for no longer exists");
            }
            let value: unknown;
            if (event.name === "mcpTool") {
                // The request's chat chooses the module MCP servers, not the selection now.
                value = await callTool(
                    event.payload.name,
                    event.payload.args,
                    options.toolChatRef ?? options.parseChatRef,
                    options.pluginContext,
                );
            } else {
                const target = event.payload.chatRef ?? options.parseChatRef;
                value = await parseInLoadedChat(event.payload.text, target, options.scope);
            }
            if (!options.targetsHeld()) {
                // A late answer for a request whose chat is gone or replaced is refused (a tool that
                // ran may have had its effects; its answer is not accepted).
                throw new Error("The chat this request is for no longer exists");
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
        if (
            (event.type === "result" ||
                event.type === "streaming" ||
                event.type === "chunk" ||
                event.type === "chunkText" ||
                event.type === "end") &&
            !options.targetsHeld()
        ) {
            // The request's chat was deleted or replaced while the reply came: the reply is not
            // accepted (a stream handed out already fails), and the request ends.
            const gone = "The chat this request is for no longer exists";
            if (!settled) {
                respond(fail(gone));
            } else {
                stream?.error(new Error(gone));
                stream = null;
            }
            stop(new Error(gone));
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
                // Stored with the request's chat (the server reads it there for a later request),
                // never with a chat that replaced it meanwhile.
                if (!options.targetsHeld()) {
                    throw new Error("The chat this request is for no longer exists");
                }
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
