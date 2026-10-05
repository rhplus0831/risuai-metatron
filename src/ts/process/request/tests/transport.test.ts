// The default (happy-dom) environment, not `node`: the transport reads the settings through the
// record views (Phase 6 slice 7), whose records need Svelte's client `$state` (the node environment
// compiles `.svelte.ts` modules for the server, where `$state` is not a proxy).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmRequestBody, LlmRequestEvent, StreamResponseChunk } from "../../../../../shared/llm/request.ts";

// Phase 5 slice 7a, the client half of `POST /api/llm/request` (`src/ts/process/request/transport.ts`):
// the context and the arguments are taken before the first await; the pending saves are flushed
// (a refused flush fails, an abort anywhere before the POST sends nothing); the body's shape; the
// SSE events in order (frames split across reads, the chunk grammar, inlays and tool records
// written before any later event, callbacks answered without holding up the stream, one answer per
// callback id, nothing started after the request ended); the terminals (EOF without one is a
// failure); the HTTP refusals (412 through the epoch handler). The server side is in
// `server/src/tests/llmRequests.test.ts`.

const stubs = vi.hoisted(() => ({
    fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
    flush: vi.fn<() => Promise<unknown>>(),
    alertError: vi.fn(),
    appendFetchLog: vi.fn(),
    callTool: vi.fn<(name: string, args: unknown) => Promise<unknown>>(),
    decodeToolCall: vi.fn<(inner: string) => Promise<unknown>>(),
    encodeToolCall: vi.fn<(record: unknown) => Promise<string>>(),
    saveInlayedSignature: vi.fn<(id: string, signature: unknown) => Promise<string>>(),
    writeInlayImage: vi.fn<(image: unknown, arg: unknown) => Promise<string>>(),
    setInlayAsset: vi.fn<(id: string, asset: unknown) => Promise<void>>(),
    parserScoped: vi.fn<(text: string, arg: unknown, scope: unknown) => string>(),
    epochMismatch: vi.fn((epoch: string) =>
        Object.assign(new Error(`replaced ${epoch}`), { name: "ResourceEpochMismatchError" }),
    ),
    channelCall: null as { jobId: string; callbackId: string } | null,
    dynamicIds: new Set<string>(),
    db: {
        aiModel: "reverse_proxy",
        currentPluginProvider: "",
        customTokenizer: "tik",
        googleClaudeTokenizing: false,
        useTokenizerCaching: true,
    } as Record<string, unknown>,
    selected: {
        bound: null as { id: string } | null,
    },
}));

vi.mock("src/ts/alert", () => ({ alertError: stubs.alertError }));
vi.mock("src/ts/globalApi.svelte", () => ({ appendFetchLog: stubs.appendFetchLog }));
vi.mock("src/ts/model/modellist", () => ({
    LLMFlags: { hasImageInput: 3 },
    getModelInfo: (id: string) => ({
        id,
        tokenizer: 1,
        internalID: id === "reverse_proxy" ? undefined : `internal-${id}`,
        flags: id === "with-images" ? [3] : [],
    }),
    isDynamicModel: (id: string) => stubs.dynamicIds.has(id),
}));
vi.mock("src/ts/network/channelCallSource", () => ({ activeChannelCall: () => stubs.channelCall }));
vi.mock("src/ts/network/generationJobs", () => ({ generationClientId: () => "tab-1" }));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParserScoped: stubs.parserScoped }));
vi.mock("src/ts/plugins/apiV3/pluginContext", async () => {
    // The selection is the real one (the records' preset and persona are selected by id).
    const { selection } = await import("src/ts/storage/selection.svelte");
    return {
        capturePluginContext: (chatRef: { chaId: string; chatId: string } | null) =>
            chatRef
                ? {
                      chatRef,
                      presetId: selection.presetId,
                      personaId: stubs.selected.bound?.id ?? selection.personaId,
                  }
                : undefined,
    };
});
vi.mock("src/ts/plugins/pluginHooks", () => ({
    pluginHooks: { providerOptions: new Map([["legacy", { tokenizer: "llama" }]]) },
}));
// The stores' module effect (`modules.ts`' `getModules`) reads the selected chat; no module is enabled here.
vi.mock("src/ts/storage/database.svelte", () => ({ getCurrentChat: () => undefined }));
vi.mock("src/ts/storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => stubs.fetch(path, init),
}));
vi.mock("src/ts/storage/resourceClient", () => ({
    epochMismatch: stubs.epochMismatch,
    getResourceEpoch: () => "epoch-1",
}));
vi.mock("src/ts/storage/resourceSync.svelte", () => ({ flushResources: () => stubs.flush() }));
vi.mock("src/ts/util", () => ({ checkPersonaBinded: () => stubs.selected.bound }));
vi.mock("../../files/inlays", () => ({
    saveInlayedSignature: stubs.saveInlayedSignature,
    writeInlayImage: stubs.writeInlayImage,
    setInlayAsset: stubs.setInlayAsset,
}));
vi.mock("../../mcp/mcp", () => ({
    callTool: stubs.callTool,
    decodeToolCall: stubs.decodeToolCall,
    encodeToolCall: stubs.encodeToolCall,
}));

import { DBState } from "src/ts/stores.svelte";
import { installForwarding } from "src/ts/storage/forwarding.svelte";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { selectCharacter, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { activePreset } from "src/ts/storage/settingsViews.svelte";
import { takeRootPresetFields } from "src/ts/storage/tests/installFlatDatabase";
import { requestServer } from "../transport";

/**
 * The settings installed in the records (as `setDatabaseLite` installs a database), since the
 * transport reads them through the record views (Phase 6 slice 7): `stubs.db`'s preset fields in
 * each of the two presets, its section fields in their sections, two personas, two characters
 * (the transport reads the selected one, Phase 6 slice 8); preset-1, persona-1, and char-1
 * selected.
 */
function installSettings() {
    const raw = { ...stubs.db };
    const preset = takeRootPresetFields(raw);
    raw.botPresets = [
        { ...preset, id: "preset-1", name: "Preset 1" },
        { ...preset, id: "preset-2", name: "Preset 2" },
    ];
    raw.personas = [
        { id: "persona-1", name: "Persona 1" },
        { id: "persona-2", name: "Persona 2" },
    ];
    raw.characters = [
        { chaId: "char-1", type: "character", name: "Char 1", chatPage: 0, chats: [{ id: "chat-1", message: [] }] },
        { chaId: "char-2", type: "character", name: "Char 2", chatPage: 0, chats: [{ id: "chat-2", message: [] }] },
    ];
    initializeRecords(takeRecordFields(raw));
    DBState.db = installForwarding(raw) as never;
    selectPreset("preset-1");
    selectPersona("persona-1");
    selectCharacter("char-1");
}

const modelInfo = { id: "reverse_proxy", tokenizer: 1, flags: [] } as never;
const baseArg = () => ({ formated: [{ role: "user" as const, content: "hi" }], bias: {}, useStreaming: false });
const flushTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settledOrPending = async <T>(promise: Promise<T>) =>
    Promise.race([promise.then(() => "settled" as const), flushTick().then(() => "pending" as const)]);

/** The SSE text of `events`, as the server writes it. */
const frames = (events: LlmRequestEvent[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const sseResponse = (events: LlmRequestEvent[]) =>
    new Response(frames(events), { status: 200, headers: { "content-type": "text/event-stream" } });
/** An SSE response whose bytes the test pushes. */
function controlledResponse() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const encoder = new TextEncoder();
    return {
        response,
        push: (text: string) => controller.enqueue(encoder.encode(text)),
        pushBytes: (bytes: Uint8Array) => controller.enqueue(bytes),
        event: (event: LlmRequestEvent) => controller.enqueue(encoder.encode(frames([event]))),
        close: () => controller.close(),
    };
}
const posted = () => stubs.fetch.mock.calls.filter(([path]) => path === "/api/llm/request");
const postedBody = (): LlmRequestBody => JSON.parse(posted()[0][1]!.body as string);
const answers = () =>
    stubs.fetch.mock.calls
        .filter(([path]) => path.startsWith("/api/llm/request/") && path.endsWith("/answer"))
        .map(([path, init]) => ({ path, body: JSON.parse(init!.body as string) }));
const accepted = { type: "accepted", id: "req-1" } as const;
const success = { type: "result", response: { type: "success", result: "ok" } } as const;

async function collect(stream: ReadableStream<StreamResponseChunk>) {
    const reader = stream.getReader();
    const chunks: unknown[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            return chunks;
        }
        chunks.push(value);
    }
}

beforeEach(() => {
    vi.useRealTimers();
    for (const fn of Object.values(stubs)) {
        if (typeof fn === "function" && "mockReset" in fn) {
            (fn as { mockReset(): void }).mockReset();
        }
    }
    stubs.flush.mockResolvedValue({ ok: true });
    stubs.fetch.mockImplementation(async (path) =>
        path.endsWith("/answer") ? Response.json({ accepted: true }) : sseResponse([accepted, success]),
    );
    stubs.callTool.mockResolvedValue([{ type: "text", text: "tool says" }]);
    stubs.decodeToolCall.mockResolvedValue(undefined);
    stubs.encodeToolCall.mockResolvedValue("<tool_call>x</tool_call>");
    stubs.saveInlayedSignature.mockResolvedValue("sig");
    stubs.writeInlayImage.mockResolvedValue("img");
    stubs.setInlayAsset.mockResolvedValue(undefined);
    stubs.parserScoped.mockImplementation((text) => `parsed:${text}`);
    stubs.channelCall = null;
    stubs.dynamicIds.clear();
    installSettings();
    stubs.selected.bound = null;
    (globalThis as { Image?: unknown }).Image = class {
        src = "";
    };
});
afterEach(() => {
    vi.useRealTimers();
});

describe("the request body", () => {
    it("captures the ids, the tokenizer scope, and the arguments before the flush, so a selection change while saving does not move the request", async () => {
        let release!: () => void;
        stubs.flush.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
        stubs.selected.bound = { id: "bound-1" };
        const tools = [{ name: "t", description: "d", inputSchema: { type: "object" } }];
        const arg = {
            ...baseArg(),
            temperature: 0.5,
            staticModel: "",
            chatRef: { chaId: "char-9", chatId: "chat-9" },
            currentChar: { chaId: "speaker-1" },
            pluginContext: {
                chatRef: { chaId: "char-9", chatId: "chat-9" },
                presetId: "preset-ctx",
                personaId: "persona-ctx",
            },
            tools,
            escape: true,
        };
        const pending = requestServer(arg as never, "submodel", null, modelInfo);
        expect(stubs.fetch).not.toHaveBeenCalled();
        // The selection moves and the caller mutates its inputs while the save flushes.
        selectPreset("preset-2");
        selectPersona("persona-2");
        selectCharacter("char-2");
        activePreset.aiModel = "with-images";
        (tools[0].inputSchema as { type: string }).type = "mutated";
        arg.formated[0].content = "mutated";
        release();
        expect(await pending).toEqual({ type: "success", result: "ok" });
        const body = postedBody();
        expect(body).toEqual({
            clientId: "tab-1",
            mode: "submodel",
            context: {
                presetId: "preset-ctx",
                personaId: "bound-1",
                selectedPersonaId: "persona-1",
                selectedCharacterId: "char-1",
                speakerId: "speaker-1",
                mainModel: { imageInput: false },
                tokenizer: {
                    aiModel: "reverse_proxy",
                    currentPluginProvider: "",
                    modelTokenizer: 1,
                    pluginTokenizer: "none",
                    customTokenizer: "tik",
                    googleClaudeTokenizing: false,
                    useTokenizerCaching: true,
                },
            },
            arg: {
                formated: [{ role: "user", content: "hi" }],
                bias: {},
                useStreaming: false,
                temperature: 0.5,
                staticModel: "",
                chatRef: { chaId: "char-9", chatId: "chat-9" },
            },
            tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
            toolRecords: {},
        });
        const init = posted()[0][1]!;
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({ "content-type": "application/json", "x-resource-epoch": "epoch-1" });
    });

    it("falls back to the selection for a request without a chat, sends a dynamic model's descriptor, the active job callback, and the prompt's tool records", async () => {
        stubs.dynamicIds.add("dynamic_google_x");
        stubs.channelCall = { jobId: "job-1", callbackId: "cb-1" };
        activePreset.aiModel = "with-images";
        activePreset.currentPluginProvider = "legacy";
        stubs.decodeToolCall.mockImplementation(async (inner) =>
            inner === "id-1name" ? { call: { id: "id-1", name: "name", arg: {} }, response: [] } : undefined,
        );
        const dynamic = { id: "dynamic_google_x", tokenizer: 1, flags: [] as number[] };
        await requestServer(
            {
                ...baseArg(),
                formated: [
                    {
                        role: "assistant",
                        content:
                            "a <tool_call>id-1name</tool_call> b <tool_call>id-1name</tool_call> <tool_call>unknownx</tool_call>",
                    },
                ],
            } as never,
            "model",
            null,
            dynamic as never,
        );
        const body = postedBody();
        expect(body.context).toMatchObject({
            presetId: "preset-1",
            personaId: "persona-1",
            selectedCharacterId: "char-1",
            speakerId: null,
            mainModel: { imageInput: true },
            tokenizer: {
                aiModel: "with-images",
                modelInternalID: "internal-with-images",
                currentPluginProvider: "legacy",
                pluginTokenizer: "llama",
            },
        });
        expect(body.arg.chatRef).toBeUndefined();
        expect(body.dynamicModel).toEqual(dynamic);
        expect(body.channelCall).toEqual({ jobId: "job-1", callbackId: "cb-1" });
        expect(stubs.decodeToolCall).toHaveBeenCalledTimes(2);
        expect(body.toolRecords).toEqual({
            "id-1name": { call: { id: "id-1", name: "name", arg: {} }, response: [] },
        });
        activePreset.currentPluginProvider = "";
    });

    it("sends nothing when the flush is refused, or the caller aborted before, during the flush, or during the tool-record read", async () => {
        stubs.flush.mockRejectedValueOnce(new Error("saving refused"));
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "saving refused",
        });

        const before = new AbortController();
        before.abort();
        expect(await requestServer(baseArg() as never, "model", before.signal, modelInfo)).toEqual({
            type: "fail",
            result: "Aborted",
        });

        let release!: () => void;
        stubs.flush.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
        const during = new AbortController();
        const pending = requestServer(baseArg() as never, "model", during.signal, modelInfo);
        during.abort();
        release();
        expect(await pending).toEqual({ type: "fail", result: "Aborted" });

        let releaseRead!: (record: unknown) => void;
        stubs.decodeToolCall.mockReturnValueOnce(new Promise((resolve) => (releaseRead = resolve)));
        const reading = new AbortController();
        const reads = requestServer(
            { ...baseArg(), formated: [{ role: "assistant", content: "<tool_call>ab</tool_call>" }] } as never,
            "model",
            reading.signal,
            modelInfo,
        );
        await flushTick();
        reading.abort();
        releaseRead(undefined);
        expect(await reads).toEqual({ type: "fail", result: "Aborted" });
        expect(stubs.fetch).not.toHaveBeenCalled();
    });

    it("turns a refused POST into a fail result, a 412 through the epoch handler, and a network error into its message", async () => {
        stubs.fetch.mockResolvedValueOnce(
            Response.json({ error: "Too many requests are running for this client" }, { status: 429 }),
        );
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "Too many requests are running for this client",
        });
        stubs.fetch.mockResolvedValueOnce(Response.json({ error: "EpochMismatch", epoch: "epoch-2" }, { status: 412 }));
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "replaced epoch-2",
        });
        expect(stubs.epochMismatch).toHaveBeenCalledWith("epoch-2");
        stubs.fetch.mockResolvedValueOnce(new Response("gateway", { status: 502 }));
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "HTTP 502",
        });
        stubs.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "TypeError: fetch failed",
        });
    });
});

describe("the events", () => {
    it("reads frames split across reads and inside a multibyte character, routes logs and notices, and answers the result", async () => {
        const controlled = controlledResponse();
        stubs.fetch.mockResolvedValueOnce(controlled.response);
        const pending = requestServer(baseArg() as never, "model", null, modelInfo);
        const text = frames([
            accepted,
            { type: "log", entry: { url: "u", body: "b" } },
            { type: "notice", kind: "alertError", message: "注意 ünïcode" },
            { type: "result", response: { type: "multiline", result: [["char", "héllo"]] } },
        ]);
        const bytes = new TextEncoder().encode(text);
        // Cut inside the "注" of the notice and inside "héllo".
        const cut1 = text.indexOf("注") + 1;
        const cut2 = text.indexOf("héllo") + 2;
        const at = (index: number) => new TextEncoder().encode(text.slice(0, index)).length;
        for (const [from, to] of [
            [0, 7],
            [7, at(cut1) + 1],
            [at(cut1) + 1, at(cut2) + 1],
            [at(cut2) + 1, bytes.length],
        ]) {
            controlled.pushBytes(bytes.slice(from, to));
            await flushTick();
        }
        controlled.close();
        expect(await pending).toEqual({ type: "multiline", result: [["char", "héllo"]] });
        expect(stubs.appendFetchLog).toHaveBeenCalledWith({ url: "u", body: "b" });
        expect(stubs.alertError).toHaveBeenCalledWith("注意 ünïcode");
    });

    it("rebuilds a stream from set, append, and remove, passes OobaLegacy's strings through, and closes at `end`", async () => {
        stubs.fetch.mockResolvedValueOnce(
            sseResponse([
                accepted,
                { type: "streaming", special: { emotion: "joy" }, model: "m" },
                { type: "chunk", set: { "0": "Hel", __tool_calls: "{}" } },
                { type: "chunk", append: { "0": "lo" } },
                { type: "chunk", set: { "0": "<Thoughts>x</Thoughts>Hello" }, remove: ["__tool_calls"] },
                { type: "chunkText", value: "raw string" },
                { type: "end" },
            ]),
        );
        const response = await requestServer({ ...baseArg(), useStreaming: true } as never, "model", null, modelInfo);
        expect(response).toMatchObject({ type: "streaming", special: { emotion: "joy" }, model: "m" });
        expect(await collect((response as { result: ReadableStream<StreamResponseChunk> }).result)).toEqual([
            { "0": "Hel", __tool_calls: "{}" },
            { "0": "Hello", __tool_calls: "{}" },
            { "0": "<Thoughts>x</Thoughts>Hello" },
            "raw string",
        ]);
    });

    it("fails a request the server ended without a terminal, errors a stream ended early or by an `error`, and fails on a malformed frame", async () => {
        stubs.fetch.mockResolvedValueOnce(sseResponse([accepted]));
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "The server ended the request without an answer",
        });
        stubs.fetch.mockResolvedValueOnce(sseResponse([accepted, { type: "error", message: "CBS: parser broke" }]));
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "CBS: parser broke",
        });

        stubs.fetch.mockResolvedValueOnce(
            sseResponse([accepted, { type: "streaming" }, { type: "chunk", set: { "0": "a" } }]),
        );
        const early = (await requestServer(baseArg() as never, "model", null, modelInfo)) as {
            result: ReadableStream<StreamResponseChunk>;
        };
        await expect(collect(early.result)).rejects.toThrow("The server ended the stream early");

        stubs.fetch.mockResolvedValueOnce(
            sseResponse([accepted, { type: "streaming" }, { type: "error", message: "upstream reset" }]),
        );
        const errored = (await requestServer(baseArg() as never, "model", null, modelInfo)) as {
            result: ReadableStream<StreamResponseChunk>;
        };
        await expect(collect(errored.result)).rejects.toThrow("upstream reset");

        stubs.fetch.mockResolvedValueOnce(new Response("data: {not json\n\n", { status: 200 }));
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "The server sent a malformed event",
        });
    });

    it("writes an inlay or a tool record before any later event is handled, and a write failure ends the request", async () => {
        let releaseSignature!: () => void;
        stubs.saveInlayedSignature.mockReturnValueOnce(
            new Promise<string>((resolve) => (releaseSignature = () => resolve("sig"))),
        );
        const signature = { signatures: [], sourceFormat: 5, source: "s" } as never;
        stubs.fetch.mockResolvedValueOnce(
            sseResponse([
                accepted,
                { type: "inlay", inlay: { kind: "signature", id: "sig-1", signature } },
                { type: "inlay", inlay: { kind: "image", id: "img-1", mimeType: "image/png", data: "AAAA" } },
                {
                    type: "inlay",
                    inlay: {
                        kind: "audio",
                        id: "aud-1",
                        name: "gemini-audio",
                        ext: "wav",
                        data: "data:audio/wav;base64,BBBB",
                    },
                },
                {
                    type: "toolRecord",
                    record: { call: { id: "c1", name: "n", arg: "{}" }, response: [{ type: "text", text: "t" }] },
                },
                success,
            ]),
        );
        const pending = requestServer(baseArg() as never, "model", null, modelInfo);
        await flushTick();
        expect(await settledOrPending(pending)).toBe("pending");
        expect(stubs.writeInlayImage).not.toHaveBeenCalled();
        releaseSignature();
        expect(await pending).toEqual({ type: "success", result: "ok" });
        expect(stubs.saveInlayedSignature).toHaveBeenCalledWith("sig-1", signature);
        expect(stubs.writeInlayImage).toHaveBeenCalledWith(
            expect.objectContaining({ src: "data:image/png;base64,AAAA" }),
            { id: "img-1" },
        );
        expect(stubs.setInlayAsset).toHaveBeenCalledWith("aud-1", {
            name: "gemini-audio",
            type: "audio",
            data: "data:audio/wav;base64,BBBB",
            height: 0,
            width: 0,
            ext: "wav",
        });
        // The record is remembered with the request's chat (slice 11b); this request has none.
        expect(stubs.encodeToolCall).toHaveBeenCalledWith(
            {
                call: { id: "c1", name: "n", arg: "{}" },
                response: [{ type: "text", text: "t" }],
            },
            null,
        );

        stubs.encodeToolCall.mockRejectedValueOnce(new Error("storage full"));
        let postSignal: AbortSignal | undefined;
        stubs.fetch.mockImplementationOnce(async (_path, init) => {
            postSignal = init?.signal as AbortSignal;
            return sseResponse([
                accepted,
                { type: "toolRecord", record: { call: { id: "c2", name: "n", arg: "{}" }, response: [] } },
                { type: "callback", id: "cb-after", name: "mcpTool", payload: { name: "t", args: {} } },
                success,
            ]);
        });
        expect(await requestServer(baseArg() as never, "model", null, modelInfo)).toEqual({
            type: "fail",
            result: "storage full",
        });
        expect(postSignal?.aborted).toBe(true);
        await flushTick();
        expect(stubs.callTool).not.toHaveBeenCalled();
    });
});

describe("the callbacks", () => {
    it("parses a `cbs` callback with the captured chat and scope (or the payload's chat), and answers each callback once by id", async () => {
        stubs.selected.bound = { id: "bound-1" };
        selectPreset("preset-1");
        stubs.parserScoped.mockImplementationOnce(() => {
            throw new Error("bad macro");
        });
        stubs.fetch.mockResolvedValueOnce(
            sseResponse([
                accepted,
                { type: "callback", id: "cb-1", name: "cbs", payload: { text: "{{user}}", chatRef: null } },
                {
                    type: "callback",
                    id: "cb-2",
                    name: "cbs",
                    payload: { text: "{{char}}", chatRef: { chaId: "other", chatId: "k" } },
                },
                {
                    type: "callback",
                    id: "cb-2",
                    name: "cbs",
                    payload: { text: "{{char}}", chatRef: { chaId: "other", chatId: "k" } },
                },
                { type: "callback", id: "cb-3", name: "mcpTool", payload: { name: "roll", args: { sides: 6 } } },
                success,
            ]),
        );
        await requestServer(
            { ...baseArg(), chatRef: { chaId: "char-9", chatId: "chat-9" } } as never,
            "model",
            null,
            modelInfo,
        );
        await flushTick();
        await flushTick();
        const scope = { presetId: "preset-1", personaId: "bound-1" };
        expect(stubs.parserScoped.mock.calls).toEqual([
            ["{{user}}", { chatRef: { chaId: "char-9", chatId: "chat-9" } }, scope],
            ["{{char}}", { chatRef: { chaId: "other", chatId: "k" } }, scope],
        ]);
        expect(stubs.callTool).toHaveBeenCalledTimes(1);
        expect(stubs.callTool).toHaveBeenCalledWith("roll", { sides: 6 });
        const sent = answers();
        expect(sent.every((entry) => entry.path === "/api/llm/request/req-1/answer")).toBe(true);
        expect(sent.map((entry) => entry.body)).toEqual([
            { clientId: "tab-1", callbackId: "cb-1", outcome: "failed", error: "bad macro" },
            { clientId: "tab-1", callbackId: "cb-2", outcome: "answered", value: "parsed:{{char}}" },
            { clientId: "tab-1", callbackId: "cb-2", outcome: "answered", value: "parsed:{{char}}" },
            {
                clientId: "tab-1",
                callbackId: "cb-3",
                outcome: "answered",
                value: [{ type: "text", text: "tool says" }],
            },
        ]);
    });

    it("parses on the chat selected when the request started for a request without a chat", async () => {
        stubs.fetch.mockResolvedValueOnce(
            sseResponse([
                accepted,
                { type: "callback", id: "cb-1", name: "cbs", payload: { text: "x", chatRef: null } },
                success,
            ]),
        );
        const pending = requestServer(baseArg() as never, "model", null, modelInfo);
        selectCharacter("char-2");
        await pending;
        await flushTick();
        expect(stubs.parserScoped.mock.calls[0]).toEqual([
            "x",
            { chatRef: { chaId: "char-1", chatId: "chat-1" } },
            { presetId: "preset-1", personaId: "persona-1" },
        ]);
        selectCharacter(null);
        stubs.fetch.mockResolvedValueOnce(
            sseResponse([
                accepted,
                { type: "callback", id: "cb-2", name: "cbs", payload: { text: "y", chatRef: null } },
                success,
            ]),
        );
        await requestServer(baseArg() as never, "model", null, modelInfo);
        await flushTick();
        expect(stubs.parserScoped.mock.calls[1]).toEqual(["y", {}, { presetId: "preset-1", personaId: "persona-1" }]);
    });

    it("keeps the stream flowing while a tool runs, and starts no queued tool after the consumer cancelled", async () => {
        let releaseTool!: (value: unknown) => void;
        stubs.callTool.mockReturnValueOnce(new Promise((resolve) => (releaseTool = resolve)));
        let postSignal: AbortSignal | undefined;
        const controlled = controlledResponse();
        stubs.fetch.mockImplementationOnce(async (_path, init) => {
            postSignal = init?.signal as AbortSignal;
            return controlled.response;
        });
        const pending = requestServer({ ...baseArg(), useStreaming: true } as never, "model", null, modelInfo);
        controlled.event(accepted);
        controlled.event({ type: "streaming" });
        const response = (await pending) as { result: ReadableStream<StreamResponseChunk> };
        const reader = response.result.getReader();
        controlled.event({ type: "callback", id: "slow", name: "mcpTool", payload: { name: "slow", args: {} } });
        controlled.event({ type: "chunk", set: { "0": "while the tool runs" } });
        expect(await reader.read()).toEqual({ done: false, value: { "0": "while the tool runs" } });
        expect(stubs.callTool).toHaveBeenCalledTimes(1);
        expect(answers()).toHaveLength(0);
        // The consumer stops: the POST is aborted, and a callback already read but not started never starts.
        controlled.event({ type: "callback", id: "queued", name: "mcpTool", payload: { name: "queued", args: {} } });
        await reader.cancel("enough");
        expect(postSignal?.aborted).toBe(true);
        releaseTool([{ type: "text", text: "late" }]);
        await flushTick();
        await flushTick();
        expect(stubs.callTool).toHaveBeenCalledTimes(1);
        // The request is dead: the late answer is not posted either.
        expect(answers()).toHaveLength(0);
    });
});
