// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMFlags, LLMFormat, type LLMModel } from "../../../../../shared/llm.ts";
import { resolveModelInfo } from "../../../../../shared/llm/models.ts";
import type { RequestArgs, ToolCallRecord, ToolDescriptor } from "../../../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../../../shared/personas.ts";
import { normalizePresets } from "../../../../../shared/presets.ts";

// Phase 5 slice 7a, the parity gate between 7a and 7b (`implementation-plan.md`, "Slice 7a"): the
// client adapters as they are in `src/ts/process/request/` (unchanged since `250c0f96`) against the
// server port in `server/src/llm/`, with the same settings (one `RequestDb` read through
// `loadRequestDb`, mirrored to the client as its database), independently cloned arguments, frozen
// time and ids, and one recording upstream on each side. What reaches the upstream (method, URL,
// headers, body), what comes back (results, chunks), and the side effects (tool calls, remembered
// records, inlays, CBS parses, logs) must be equal. The formats whose client copy lived in
// `request.ts` itself (NovelAI, Ooba, Kobold, NovelList, Cohere, Horde, Ollama, Echo) have no client
// module left to run; their port is reviewed by diff and exercised in `server/src/tests/`.

// The server modules are loaded at run time, never imported: an import (even a type import) would
// put `server/src` into the client's TypeScript program, which `pnpm check` runs over `src/`.
const serverModule = <T = any>(file: string): Promise<T> =>
    vi.importActual<T>(new URL(`../../../../../server/src/${file}`, import.meta.url).pathname);
const [
    { normalizeLlmSecrets },
    { normalizeProviders },
    { reformater: serverReformater, requestChatDataMain },
    { loadRequestDb },
    { createTransport },
] = await Promise.all([
    serverModule<{ normalizeLlmSecrets: (input: unknown) => Record<string, any> }>("data/normalize/llmSecrets.ts"),
    serverModule<{ normalizeProviders: (input: unknown) => Record<string, any> }>("data/normalize/providers.ts"),
    serverModule<{
        reformater: (formated: unknown, modelInfo: unknown, db: unknown) => any;
        requestChatDataMain: (arg: unknown, model: string, ctx: unknown) => Promise<any>;
    }>("llm/request.ts"),
    serverModule<{
        loadRequestDb: (
            store: unknown,
            kinds: unknown,
            ids: Record<string, string | null>,
        ) => {
            db: Record<string, any>;
            selectedCharacterName: string | null;
            speakerName: string | null;
            userName: string;
        };
    }>("llm/settings.ts"),
    serverModule<{ createTransport: (options: Record<string, unknown>) => unknown }>("llm/transport.ts"),
]);

const clientState = vi.hoisted(() => ({
    db: {} as Record<string, any>,
    selectedCharacterName: null as string | null,
    userName: "User",
    upstream: null as null | ((call: Upstream) => CannedResponse),
    calls: [] as Upstream[],
    logs: [] as string[],
    alerts: [] as string[],
    parses: [] as string[],
    toolCalls: [] as { name: string; args: unknown }[],
    toolAnswer: [] as { type: "text"; text: string }[],
    records: [] as ToolCallRecord[],
    known: new Map<string, ToolCallRecord>(),
    inlays: [] as unknown[],
    observer: [] as unknown[],
    ids: 0,
}));

type Upstream = { url: string; method: string; headers: Record<string, string>; body: unknown };
type CannedResponse = { status: number; headers?: Record<string, string>; body: string };

const nextId = () => `id-${++clientState.ids}`;

vi.mock("uuid", () => ({ v4: () => nextId() }));
vi.mock("node:crypto", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:crypto")>();
    return { ...actual, randomUUID: () => nextId() };
});
vi.mock("src/lang", () => ({
    language: {
        errors: { unknownModel: "Error: Unknown model selected", httpError: "Error: error in request:" },
        pluginProviderNotFound: "Unknown Plugin detected. Please change the model or enable the corresponding plugin.",
    },
}));
vi.mock("src/ts/alert", () => ({ alertError: (message: string) => clientState.alerts.push(String(message)) }));
vi.mock("src/ts/storage/database.svelte", () => ({
    getDatabase: () => clientState.db,
    getCurrentCharacter: () =>
        clientState.selectedCharacterName === null ? undefined : { name: clientState.selectedCharacterName },
}));
vi.mock("src/ts/model/modellist", async () => {
    const llm = await vi.importActual<typeof import("../../../../../shared/llm.ts")>("../../../../../shared/llm.ts");
    const models = await vi.importActual<typeof import("../../../../../shared/llm/models.ts")>(
        "../../../../../shared/llm/models.ts",
    );
    return {
        LLMFlags: llm.LLMFlags,
        LLMFormat: llm.LLMFormat,
        LLMProvider: llm.LLMProvider,
        LLMTokenizer: llm.LLMTokenizer,
        getModelInfo: (id: string) =>
            models.resolveModelInfo(id, {
                enableCustomFlags: clientState.db.enableCustomFlags,
                customFlags: clientState.db.customFlags,
                customModels: clientState.db.customModels,
            }),
    };
});
vi.mock("src/ts/tokenizer", () => ({
    tokenizeNum: async (text: string) => tokenize(text),
    strongBan: async (text: string, bias: Record<number, number>) => ({ ...bias, [tokenize(text)[0]]: -100 }),
}));
vi.mock("src/ts/model/openrouter", () => ({ getFreeOpenRouterModels: async () => "free/model" }));
vi.mock("src/ts/globalApi.svelte", () => ({
    globalFetch: async (url: string, arg: Record<string, any> = {}) => {
        const canned = record({
            url,
            method: arg.method ?? "POST",
            headers: { ...(arg.headers ?? {}) },
            body: arg.body,
        });
        // The real `globalFetch` logs its call itself (`addFetchLogInGlobalFetch`).
        clientState.logs.push(url);
        let data: unknown;
        try {
            data = JSON.parse(canned.body);
        } catch {
            data = canned.body;
        }
        return {
            ok: canned.status >= 200 && canned.status < 300,
            data,
            headers: canned.headers ?? {},
            status: canned.status,
        };
    },
    fetchNative: async (url: string, arg: Record<string, any>) => {
        const canned = record({
            url,
            method: arg.method ?? "POST",
            headers: { ...(arg.headers ?? {}) },
            body: arg.body,
        });
        clientState.logs.push(url);
        return new Response(canned.body, { status: canned.status, headers: canned.headers ?? {} });
    },
    addFetchLog: (arg: { url: string }) => {
        clientState.logs.push(arg.url);
        return 0;
    },
    textifyReadableStream: (stream: ReadableStream<Uint8Array>) => new Response(stream).text(),
}));
vi.mock("src/ts/util", async () => {
    const util = await vi.importActual<Record<string, unknown>>(
        new URL("../../../../../server/src/llm/util.ts", import.meta.url).pathname,
    );
    return {
        ...util,
        getUserName: () => clientState.userName,
        getPersonaPrompt: () => clientState.db.personaPrompt,
    };
});
vi.mock("src/ts/parser/parser.svelte", () => ({
    risuChatParser: (text: string) => {
        clientState.parses.push(text);
        return text;
    },
}));
vi.mock("src/ts/observer.svelte", () => ({
    registerClaudeObserver: (arg: unknown) => clientState.observer.push(JSON.parse(JSON.stringify(arg))),
}));
vi.mock("src/ts/stores.svelte", () => ({ bodyIntercepterStore: [] }));
vi.mock("../../files/inlays", () => ({
    saveInlayedSignature: async (id: string, signature: unknown) => {
        clientState.inlays.push({ kind: "signature", id, signature });
        return id;
    },
    writeInlayImage: async (image: { src: string }, arg: { id?: string }) => {
        const [, mimeType, data] = image.src.match(/^data:([^;]+);base64,(.*)$/) ?? [];
        clientState.inlays.push({ kind: "image", id: arg.id, mimeType, data });
        return arg.id;
    },
    setInlayAsset: async (id: string, asset: { name: string; ext: string; data: string }) => {
        clientState.inlays.push({ kind: "audio", id, name: asset.name, ext: asset.ext, data: asset.data });
    },
    supportsInlayImage: () => resolveModelInfo(clientState.db.aiModel).flags.includes(LLMFlags.hasImageInput),
}));
vi.mock("../../mcp/mcp", () => ({
    callTool: async (name: string, args: unknown) => {
        clientState.toolCalls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
        return clientState.toolAnswer;
    },
    encodeToolCall: async (record: ToolCallRecord) => {
        record.call.id = record.call.id || nextId();
        clientState.records.push(JSON.parse(JSON.stringify(record)));
        return `<tool_call>${record.call.id}${record.call.name}</tool_call>\n\n`;
    },
    decodeToolCall: async (inner: string) => clientState.known.get(inner),
}));

import { requestClaude } from "../anthropic";
import { requestGoogleCloudVertex } from "../google";
import { requestOpenAI, requestOpenAILegacyInstruct, requestOpenAIResponseAPI } from "../openAI/requests";

const tokenize = (text: string) => Array.from(text).map((char) => char.codePointAt(0) ?? 0);

function record(call: Upstream): CannedResponse {
    const copy = JSON.parse(JSON.stringify(call));
    clientState.calls.push(copy);
    if (!clientState.upstream) {
        throw new Error("no upstream");
    }
    return clientState.upstream(copy);
}

(globalThis as { Image?: unknown }).Image = class {
    src = "";
};

// ---------------------------------------------------------------------------------------------
// The settings: one store read, served to both sides.

const SECRETS = {
    proxyKey: "sk-proxy-SENTINEL-1111",
    openAIKey: "sk-openai-SENTINEL-2222",
    claudeAPIKey: "sk-ant-SENTINEL-3333",
    google: "AIza-SENTINEL-4444",
    mistralKey: "mistral-SENTINEL-5555",
    bedrock: "AKIAEXAMPLE:bedrock-secret-SENTINEL-6666:us-east-1",
    vertexToken: "vertex-token-SENTINEL-7777",
};
const PROVIDER = "https://mock.test/v1/chat/completions";

type Settings = {
    preset?: Record<string, unknown>;
    providers?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
    customModels?: unknown[];
    selectedCharacterName?: string | null;
};

function settings(overrides: Settings = {}) {
    const records: Record<string, unknown> = {
        providers: normalizeProviders({ requestRetrys: 0, ...overrides.providers }),
        llmSecrets: normalizeLlmSecrets({
            openAIKey: SECRETS.openAIKey,
            claudeAPIKey: SECRETS.claudeAPIKey,
            mistralKey: SECRETS.mistralKey,
            google: { accessToken: SECRETS.google, projectId: "proj-1" },
            presets: { p: { proxyKey: SECRETS.proxyKey } },
            ...overrides.secrets,
        }),
        ui: { autoSuggestPrefix: "" },
        customModels: overrides.customModels ?? [],
        presets: normalizePresets([
            {
                id: "p",
                name: "p",
                aiModel: "reverse_proxy",
                subModel: "reverse_proxy",
                forceReplaceUrl: PROVIDER,
                customProxyRequestModel: "mock-model",
                customAPIFormat: LLMFormat.OpenAICompatible,
                maxResponse: 300,
                temperature: 70,
                ...overrides.preset,
            },
        ]),
        personas: normalizePersonas([{ id: "u", name: "Uma", personaPrompt: "Uma is curious." }]),
    };
    const characters: Record<string, unknown> = { c: { chaId: "c", name: overrides.selectedCharacterName ?? "Cara" } };
    const store = {
        readRefs: (refs: { kind: { name: string }; id: string }[]) => ({
            items: refs.map((ref) => ({
                kind: ref.kind.name,
                id: ref.id,
                revision: null,
                data: ref.kind.name === "characters" ? (characters[ref.id] ?? null) : (records[ref.kind.name] ?? null),
            })),
        }),
    } as never;
    const kinds = { get: (name: string) => ({ name }) } as never;
    return loadRequestDb(store, kinds, {
        presetId: "p",
        personaId: "u",
        selectedPersonaId: "u",
        selectedCharacterId: overrides.selectedCharacterName === null ? null : "c",
        speakerId: null,
    });
}

// ---------------------------------------------------------------------------------------------
// The two sides.

type Recorded = {
    calls: Upstream[];
    result: unknown;
    chunks: unknown[];
    logs: string[];
    alerts: string[];
    parses: string[];
    toolCalls: unknown[];
    records: ToolCallRecord[];
    inlays: unknown[];
    observer: unknown[];
};

type Scenario = {
    settings: Settings;
    arg: RequestArgs;
    mode?: "model" | "submodel" | "translate";
    tools?: ToolDescriptor[];
    /** The remembered tool calls the prompt's markers name. */
    known?: Record<string, ToolCallRecord>;
    toolAnswer?: { type: "text"; text: string }[];
    upstream: (call: Upstream) => CannedResponse;
};

/** `method`, `url`, the headers lowercased without the JSON default, and the body parsed when it is JSON. */
function normalize(call: Upstream) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(call.headers ?? {})) {
        headers[name.toLowerCase()] = value;
    }
    if (headers["content-type"] === "application/json") {
        delete headers["content-type"];
    }
    let body: unknown = call.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {}
    }
    return { method: call.method, url: call.url, headers, body };
}

async function drain(response: any): Promise<{ result: unknown; chunks: unknown[] }> {
    if (response.type !== "streaming") {
        return { result: response, chunks: [] };
    }
    const reader = (response.result as ReadableStream<unknown>).getReader();
    const chunks: unknown[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(JSON.parse(JSON.stringify(value)));
    }
    const { result, ...rest } = response;
    return { result: rest, chunks };
}

async function runClient(scenario: Scenario, loaded: ReturnType<typeof settings>): Promise<Recorded> {
    const db: Record<string, any> = JSON.parse(JSON.stringify(loaded.db));
    // The client read its stored Vertex token until its expiry; the server keeps one in memory.
    db.vertexAccessToken = SECRETS.vertexToken;
    db.vertexAccessTokenExpires = Date.now() + 10_000_000;
    clientState.db = db;
    clientState.selectedCharacterName = loaded.selectedCharacterName;
    clientState.userName = loaded.userName;
    clientState.upstream = scenario.upstream;
    clientState.toolAnswer = scenario.toolAnswer ?? [];
    clientState.known = new Map(Object.entries(scenario.known ?? {}));
    clientState.ids = 0;
    for (const key of ["calls", "logs", "alerts", "parses", "toolCalls", "records", "inlays", "observer"] as const) {
        clientState[key].length = 0;
    }
    // The client's Google adapter names an image inlay with the global `crypto.randomUUID`.
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(nextId as never);
    const arg: Record<string, any> = JSON.parse(JSON.stringify(scenario.arg));
    const model = scenario.mode ?? "model";
    const getModelInfo = (id: string): LLMModel =>
        resolveModelInfo(id, {
            enableCustomFlags: db.enableCustomFlags,
            customFlags: db.customFlags,
            customModels: db.customModels,
        });
    // The baseline `requestChatDataMain` (`250c0f96`): the defaults, the overrides, `reformater`.
    const targ: Record<string, any> = { ...arg, tools: scenario.tools ?? [] };
    targ.aiModel = arg.staticModel ? arg.staticModel : model === "model" ? db.aiModel : db.subModel;
    targ.modelInfo = getModelInfo(targ.aiModel);
    if (db.seperateModelsForAxModels && !arg.staticModel && db.seperateModels[model]) {
        targ.aiModel = db.seperateModels[model];
        targ.modelInfo = getModelInfo(targ.aiModel);
    }
    targ.formated = JSON.parse(JSON.stringify(arg.formated));
    targ.maxTokens = arg.maxTokens ?? db.maxResponse;
    targ.temperature = arg.temperature ?? db.temperature / 100;
    targ.bias = arg.bias;
    targ.useStreaming = arg.forceStreaming ? true : db.useStreaming && arg.useStreaming;
    targ.continue = arg.continue ?? false;
    targ.biasString = arg.biasString ?? [];
    targ.multiGen = db.genTime > 1 && targ.aiModel.startsWith("gpt") && !arg.continue && !arg.noMultiGen;
    targ.abortSignal = new AbortController().signal;
    targ.mode = model;
    targ.extractJson = arg.extractJson ?? db.extractJson;
    if (targ.aiModel === "reverse_proxy") {
        targ.modelInfo.internalID = db.customProxyRequestModel;
        targ.modelInfo.format = db.customAPIFormat;
        targ.customURL = db.forceReplaceUrl;
        targ.key = db.proxyKey;
    }
    if (targ.aiModel.startsWith("xcustom:::")) {
        const found = db.customModels.find((m: { id: string }) => m.id === targ.aiModel);
        targ.customURL = found?.url;
        targ.key = found?.key;
    }
    targ.formated = serverReformater(targ.formated, targ.modelInfo, db);
    let response: any;
    switch (targ.modelInfo.format) {
        case LLMFormat.OpenAICompatible:
        case LLMFormat.Mistral:
        case LLMFormat.NanoGPT:
            response = await requestOpenAI(targ as never);
            break;
        case LLMFormat.NanoGPTResponses:
        case LLMFormat.OpenAIResponseAPI:
            response = await requestOpenAIResponseAPI(targ as never);
            break;
        case LLMFormat.NanoGPTLegacy:
        case LLMFormat.OpenAILegacyInstruct:
            response = await requestOpenAILegacyInstruct(targ as never);
            break;
        case LLMFormat.NanoGPTMessages:
        case LLMFormat.Anthropic:
        case LLMFormat.AnthropicLegacy:
        case LLMFormat.AWSBedrockClaude:
            response = await requestClaude(targ as never);
            break;
        case LLMFormat.VertexAIGemini:
        case LLMFormat.GoogleCloud:
            response = await requestGoogleCloudVertex(targ as never);
            break;
        default:
            throw new Error(`no client adapter for format ${targ.modelInfo.format}`);
    }
    const { result, chunks } = await drain(response);
    return {
        calls: clientState.calls.map(normalize),
        result: JSON.parse(JSON.stringify(result)),
        chunks,
        logs: [...clientState.logs],
        alerts: [...clientState.alerts],
        parses: [...clientState.parses],
        toolCalls: [...clientState.toolCalls],
        records: [...clientState.records],
        inlays: [...clientState.inlays],
        observer: [...clientState.observer],
    };
}

async function runServer(scenario: Scenario, loaded: ReturnType<typeof settings>): Promise<Recorded> {
    const db = JSON.parse(JSON.stringify(loaded.db)) as Record<string, any>;
    const calls: Upstream[] = [];
    const logs: string[] = [];
    const alerts: string[] = [];
    const parses: string[] = [];
    const toolCalls: unknown[] = [];
    const records: ToolCallRecord[] = [];
    const inlays: unknown[] = [];
    const observer: unknown[] = [];
    const known = new Map(Object.entries(scenario.known ?? {}));
    clientState.ids = 0;
    const controller = new AbortController();
    const transport = createTransport({
        signal: controller.signal,
        log: (entry: { url: string }) => logs.push(entry.url),
        fetchImpl: (async (input: string | URL | Request, init: RequestInit = {}) => {
            const call: Upstream = {
                url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                method: init.method ?? "GET",
                headers: { ...(init.headers as Record<string, string>) },
                body:
                    typeof init.body === "string"
                        ? init.body
                        : init.body
                          ? new TextDecoder().decode(init.body as Uint8Array)
                          : undefined,
            };
            calls.push(JSON.parse(JSON.stringify(call)));
            // The scenario sees the parsed body on both sides.
            let parsed: unknown = call.body;
            try {
                parsed = typeof call.body === "string" ? JSON.parse(call.body) : call.body;
            } catch {}
            const canned = scenario.upstream({ ...JSON.parse(JSON.stringify(call)), body: parsed });
            return new Response(canned.body, { status: canned.status, headers: canned.headers ?? {} });
        }) as typeof fetch,
    });
    const getModelInfo = (id: string) =>
        resolveModelInfo(id, {
            enableCustomFlags: db.enableCustomFlags,
            customFlags: db.customFlags,
            customModels: db.customModels,
        });
    // Structurally `RequestContext` (`server/src/llm/context.ts`).
    const ctx = {
        db,
        selectedCharacterName: loaded.selectedCharacterName,
        speakerName: loaded.speakerName,
        userName: loaded.userName,
        signal: controller.signal,
        transport,
        alertError: (message) => alerts.push(String(message)),
        redactText: (text) => text,
        tokenizeNum: async (text) => tokenize(text),
        strongBan: async (text, bias) => ({ ...bias, [tokenize(text)[0]]: -100 }),
        parseCbs: async (text) => {
            parses.push(text);
            return text;
        },
        tools: {
            call: async (name, args) => {
                toolCalls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
                return scenario.toolAnswer ?? [];
            },
            encode: async (record) => {
                record.call.id = record.call.id || nextId();
                records.push(JSON.parse(JSON.stringify(record)));
                return `<tool_call>${record.call.id}${record.call.name}</tool_call>\n\n`;
            },
            decode: async (text) => known.get(text),
        },
        inlays: {
            saveSignature: async (id, signature) => {
                inlays.push({ kind: "signature", id, signature });
                return id;
            },
            writeImage: async (image) => {
                inlays.push({ kind: "image", id: image.id, mimeType: image.mimeType, data: image.data });
                return image.id;
            },
            setAsset: async (asset) => {
                inlays.push({ kind: "audio", id: asset.id, name: asset.name, ext: asset.ext, data: asset.data });
            },
        },
        intercept: async (body) => body,
        supportsInlayImage: () => getModelInfo(db.aiModel).flags.includes(LLMFlags.hasImageInput),
        getModelInfo,
        vertexAccessToken: async () => SECRETS.vertexToken,
        registerClaudeObserver: (arg) => observer.push(JSON.parse(JSON.stringify(arg))),
    };
    const response = await requestChatDataMain(
        { ...(JSON.parse(JSON.stringify(scenario.arg)) as RequestArgs), tools: scenario.tools ?? [] },
        scenario.mode ?? "model",
        ctx,
    );
    const { result, chunks } = await drain(response);
    return {
        calls: calls.map(normalize),
        result: JSON.parse(JSON.stringify(result)),
        chunks,
        logs,
        alerts,
        parses,
        toolCalls,
        records,
        inlays,
        observer,
    };
}

/** Runs both sides on independent clones and returns them; the caller asserts what must match. */
async function both(scenario: Scenario) {
    const loaded = settings(scenario.settings);
    const client = await runClient(scenario, loaded);
    const server = await runServer(scenario, loaded);
    return { client, server };
}

function expectSame({ client, server }: { client: Recorded; server: Recorded }) {
    expect(server.calls).toEqual(client.calls);
    expect(server.result).toEqual(client.result);
    expect(server.chunks).toEqual(client.chunks);
    expect(server.toolCalls).toEqual(client.toolCalls);
    expect(server.records).toEqual(client.records);
    expect(server.inlays).toEqual(client.inlays);
    expect(server.parses).toEqual(client.parses);
    expect(server.alerts).toEqual(client.alerts);
    expect(server.observer).toEqual(client.observer);
    expect(server.logs).toEqual(client.logs);
}

const json = (data: unknown, status = 200): CannedResponse => ({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
});
const sse = (frames: unknown[]): CannedResponse => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""),
});
const chat = (content: string, extra: Record<string, unknown> = {}) =>
    json({ choices: [{ message: { role: "assistant", content, ...extra } }] });
const prompt = (): RequestArgs => ({
    formated: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hello {{char}}" },
        { role: "assistant", content: "Hi {{user}}" },
        { role: "user", content: "Tell me more" },
    ],
    bias: {},
    useStreaming: false,
});

beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z"), toFake: ["Date"] });
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("the server port against the client adapters", () => {
    it("OpenAI-compatible, buffered: the proxy key, model, parameters, bias strings, additional parameters and headers, and the answer", async () => {
        const sides = await both({
            settings: {
                providers: {
                    additionalParams: [
                        ["header::X-Custom", "custom-value"],
                        ["top_k", "3"],
                        ["json::extra", '{"a": True}'],
                    ],
                },
                preset: { PresensePenalty: 20, frequencyPenalty: 10, top_p: 0.9 },
            },
            arg: {
                ...prompt(),
                biasString: [
                    ["hello", -5],
                    ["[[42]]", 3],
                    ["ban", -101],
                ],
                temperature: 0.4,
                maxTokens: 123,
            },
            upstream: () => chat("a plain answer"),
        });
        expectSame(sides);
        expect(sides.server.calls).toHaveLength(1);
        expect(sides.server.calls[0]).toMatchObject({
            method: "POST",
            url: PROVIDER,
            headers: { authorization: `Bearer ${SECRETS.proxyKey}`, "x-custom": "custom-value" },
            // The parameters come from the preset (`applyParameters`), not from the caller's `temperature`.
            body: { model: "mock-model", temperature: 0.7, max_tokens: 123, top_k: 3 },
        });
        expect((sides.server.calls[0].body as { logit_bias: Record<string, number> }).logit_bias).toMatchObject({
            42: 3,
        });
        expect(sides.server.result).toEqual({ type: "success", result: "a plain answer" });
    });

    it("OpenAI-compatible, streaming: the cumulative chunks and the log", async () => {
        const sides = await both({
            settings: { providers: { useStreaming: true } },
            arg: { ...prompt(), useStreaming: true },
            upstream: () =>
                sse([
                    { choices: [{ delta: { content: "Hel" } }] },
                    { choices: [{ delta: { content: "lo" } }] },
                    "[DONE]",
                ]),
        });
        expectSame(sides);
        expect(sides.server.chunks.at(-1)).toEqual({ "0": "Hello" });
        // The transport's own entry and the adapter's "Streaming" entry, as on the client.
        expect(sides.server.logs).toEqual([PROVIDER, PROVIDER]);
    });

    it("OpenAI-compatible: a JSON schema from an interface, the extraction path, and the CBS parses in the same order", async () => {
        const sides = await both({
            settings: {
                preset: {
                    jsonSchemaEnabled: true,
                    jsonSchema: "interface Answer {\n  answer: string\n  score: number\n}",
                    extractJson: "answer",
                },
            },
            arg: { ...prompt() },
            upstream: () => chat('{"answer":"forty-two","score":1}'),
        });
        expectSame(sides);
        expect((sides.server.calls[0].body as { response_format: unknown }).response_format).toMatchObject({
            type: "json_schema",
            json_schema: {
                name: "format",
                strict: true,
                schema: {
                    type: "object",
                    properties: { answer: { type: "string" }, score: { type: "number" } },
                    required: ["answer", "score"],
                    additionalProperties: false,
                },
            },
        });
        expect(sides.server.result).toEqual({ type: "success", result: "forty-two" });
        expect(sides.server.parses).toEqual(["interface Answer {\n  answer: string\n  score: number\n}", "answer"]);
    });

    it("OpenAI-compatible: one tool round trip with a remembered record and a decoded earlier one", async () => {
        const earlier: ToolCallRecord = {
            call: { id: "earlier", name: "lookup", arg: '{"q":"x"}' },
            response: [{ type: "text", text: "found" }],
        };
        const sides = await both({
            settings: { preset: { subModel: "reverse_proxy" } },
            arg: {
                ...prompt(),
                formated: [
                    { role: "user", content: "first" },
                    { role: "assistant", content: "I looked. <tool_call>earlierlookup</tool_call> Done." },
                    { role: "user", content: "roll" },
                ],
                rememberToolUsage: true,
            },
            tools: [
                {
                    name: "rollDice",
                    description: "roll",
                    inputSchema: { type: "object", properties: { sides: { type: "number" } } },
                },
            ],
            known: { "earlierlookup": earlier },
            toolAnswer: [{ type: "text", text: "4" }],
            upstream: (call) =>
                (call.body as { messages: { role: string; tool_call_id?: string }[] }).messages.some(
                    (m) => m.tool_call_id === "call_1",
                )
                    ? chat("rolled a 4")
                    : chat("", {
                          tool_calls: [
                              {
                                  id: "call_1",
                                  type: "function",
                                  function: { name: "rollDice", arguments: '{"sides":6}' },
                              },
                          ],
                      }),
        });
        expectSame(sides);
        expect(sides.server.calls).toHaveLength(2);
        expect((sides.server.calls[0].body as { messages: unknown[] }).messages).toEqual([
            { role: "user", content: "first" },
            {
                role: "assistant",
                content: "I looked. ",
                tool_calls: [{ id: "earlier", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
            },
            { role: "tool", tool_call_id: "earlier", content: "found" },
            { role: "assistant", content: " Done." },
            { role: "user", content: "roll" },
        ]);
        expect((sides.server.calls[0].body as { tools: unknown[] }).tools).toHaveLength(1);
        expect(sides.server.toolCalls).toEqual([{ name: "rollDice", args: { sides: 6 } }]);
        expect(sides.server.records).toEqual([
            { call: { id: "call_1", name: "rollDice", arg: '{"sides":6}' }, response: [{ type: "text", text: "4" }] },
        ]);
        expect(sides.server.result).toMatchObject({ type: "success" });
        expect((sides.server.result as { result: string }).result).toContain("<tool_call>call_1rollDice</tool_call>");
    });

    it("OpenAI-compatible: a provider failure and a preview", async () => {
        const failed = await both({
            settings: {},
            arg: prompt(),
            upstream: () => json({ error: { message: `Incorrect API key ${SECRETS.proxyKey}` } }, 401),
        });
        expectSame(failed);
        expect(failed.server.result).toMatchObject({ type: "fail" });
        const preview = await both({
            settings: {},
            arg: { ...prompt(), previewBody: true },
            upstream: () => chat("never"),
        });
        expectSame(preview);
        expect(preview.server.calls).toHaveLength(0);
        expect(JSON.parse((preview.server.result as { result: string }).result)).toMatchObject({
            url: PROVIDER,
            body: { model: "mock-model" },
        });
    });

    it("a custom model (`xcustom:::`), Mistral, and the legacy instruct format", async () => {
        const custom = await both({
            settings: {
                preset: { aiModel: "xcustom:::mine" },
                // The model's key is an `llmSecrets` credential (7b): `loadRequestDb` merges it back.
                secrets: { customModels: { "xcustom:::mine": { key: "custom-key" } } },
                customModels: [
                    {
                        id: "xcustom:::mine",
                        name: "Mine",
                        internalId: "mine-1",
                        url: "https://custom.test/v1/chat/completions",
                        format: LLMFormat.OpenAICompatible,
                        flags: [LLMFlags.hasFullSystemPrompt],
                        tokenizer: 0,
                        params: "",
                    },
                ],
            },
            arg: prompt(),
            upstream: () => chat("custom answer"),
        });
        expectSame(custom);
        expect(custom.server.calls[0]).toMatchObject({
            url: "https://custom.test/v1/chat/completions",
            headers: { authorization: "Bearer custom-key" },
            body: { model: "mine-1" },
        });

        const mistral = await both({
            settings: { preset: { aiModel: "mistral-small-latest" } },
            arg: prompt(),
            upstream: () => chat("bonjour"),
        });
        expectSame(mistral);
        expect(mistral.server.calls[0]).toMatchObject({
            url: "https://api.mistral.ai/v1/chat/completions",
            headers: { authorization: `Bearer ${SECRETS.mistralKey}` },
        });

        const legacy = await both({
            settings: { preset: { customAPIFormat: LLMFormat.OpenAILegacyInstruct } },
            arg: prompt(),
            upstream: () => json({ choices: [{ text: "instructed" }] }),
        });
        expectSame(legacy);
        expect(legacy.server.calls[0].body).toMatchObject({
            model: "gpt-3.5-turbo-instruct",
            prompt: expect.any(String),
        });
        expect(legacy.server.result).toEqual({ type: "success", result: "instructed" });
    });

    it("the auxiliary model of a translate call (`seperateModels`) and the sub model", async () => {
        const aux = await both({
            settings: {
                providers: { seperateModelsForAxModels: true, seperateModels: { translate: "mistral-small-latest" } },
            },
            arg: prompt(),
            mode: "translate",
            upstream: () => chat("traduit"),
        });
        expectSame(aux);
        expect(aux.server.calls[0].url).toBe("https://api.mistral.ai/v1/chat/completions");
        const sub = await both({
            settings: { preset: { subModel: "mistral-small-latest" } },
            arg: prompt(),
            mode: "submodel",
            upstream: () => chat("sub"),
        });
        expectSame(sub);
        expect(sub.server.calls[0].url).toBe("https://api.mistral.ai/v1/chat/completions");
    });

    it("the Responses API, buffered and streaming, with a tool call", async () => {
        const buffered = await both({
            settings: { preset: { customAPIFormat: LLMFormat.OpenAIResponseAPI } },
            arg: { ...prompt(), rememberToolUsage: true },
            tools: [
                {
                    name: "lookup",
                    description: "look",
                    inputSchema: { type: "object", properties: { q: { type: "string" } } },
                },
            ],
            toolAnswer: [{ type: "text", text: "looked up" }],
            upstream: (call) =>
                (call.body as { input: { type?: string }[] }).input.some((item) => item.type === "function_call_output")
                    ? json({
                          status: "completed",
                          output: [{ type: "message", content: [{ type: "output_text", text: "final answer" }] }],
                      })
                    : json({
                          status: "completed",
                          output: [{ type: "function_call", call_id: "fc_1", name: "lookup", arguments: '{"q":"x"}' }],
                      }),
        });
        expectSame(buffered);
        expect(buffered.server.calls).toHaveLength(2);
        expect(buffered.server.calls[0].url).toMatch(/^https:\/\/mock\.test\//);
        expect(buffered.server.toolCalls).toEqual([{ name: "lookup", args: { q: "x" } }]);
        expect(buffered.server.records).toHaveLength(1);

        const streaming = await both({
            settings: { preset: { customAPIFormat: LLMFormat.OpenAIResponseAPI }, providers: { useStreaming: true } },
            arg: { ...prompt(), useStreaming: true },
            upstream: () =>
                sse([
                    { type: "response.output_text.delta", delta: "Hel" },
                    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
                    { type: "response.output_text.delta", delta: "lo" },
                    {
                        type: "response.completed",
                        response: { output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] },
                    },
                    "[DONE]",
                ]),
        });
        expectSame(streaming);
        expect(streaming.server.chunks.length).toBeGreaterThan(0);
    });

    it("Anthropic, buffered: caching, prefill, the system prompt, and the warmer registration", async () => {
        const sides = await both({
            settings: {
                preset: { aiModel: "claude-sonnet-4-5-20250929", top_k: 5, top_p: 0.8 },
                providers: { claudeRetrivalCaching: true, claude1HourCaching: true, automaticCachePoint: true },
            },
            arg: {
                ...prompt(),
                formated: [...prompt().formated, { role: "assistant", content: "Prefill:" }],
                maxTokens: 222,
            },
            upstream: () => json({ content: [{ type: "text", text: "claude says" }] }),
        });
        expectSame(sides);
        expect(sides.server.calls[0]).toMatchObject({
            url: "https://api.anthropic.com/v1/messages",
            headers: { "x-api-key": SECRETS.claudeAPIKey },
            body: { model: "claude-sonnet-4-5-20250929", max_tokens: 222, system: "Be brief." },
        });
        expect(sides.server.observer).toHaveLength(1);
        expect(sides.server.result).toEqual({ type: "success", result: "claude says" });
    });

    it("Anthropic, streaming: the cumulative chunks, and a provider error that stays answer text", async () => {
        const stream = (frames: unknown[]) =>
            sse(frames.map((frame) => (typeof frame === "string" ? frame : { ...(frame as object) })));
        const sides = await both({
            settings: { preset: { aiModel: "claude-sonnet-4-5-20250929" }, providers: { useStreaming: true } },
            arg: { ...prompt(), useStreaming: true },
            upstream: () =>
                stream([
                    { type: "message_start", message: {} },
                    { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
                    { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
                    { type: "error", error: { type: "api_error", message: "mid-stream trouble" } },
                    { type: "message_stop" },
                ]),
        });
        expectSame(sides);
        expect(sides.server.chunks.at(-1)).toEqual({ "0": "HelloError:mid-stream trouble" });
    });

    it("Bedrock: the Signature V4 headers are identical with a frozen clock and the same body", async () => {
        const sides = await both({
            settings: {
                preset: { aiModel: "anthropic.claude-opus-4-6-v1" },
                secrets: { claudeAPIKey: SECRETS.bedrock },
            },
            arg: { ...prompt(), useStreaming: false },
            upstream: () => json({ content: [{ type: "text", text: "from bedrock" }] }),
        });
        expectSame(sides);
        const call = sides.server.calls[0];
        expect(call.url).toMatch(/^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\//);
        expect(call.headers.authorization).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20261001\/us-east-1\/bedrock\/aws4_request/,
        );
        expect(call.headers["x-amz-date"]).toBe("20261001T120000Z");
        expect(sides.server.result).toEqual({ type: "success", result: "from bedrock" });
    });

    it("Google, buffered: the key in the query, a thought signature, an inline image, audio, and the answer", async () => {
        const sides = await both({
            settings: { preset: { aiModel: "gemini-2.5-flash", top_k: 7 }, providers: { saveSignatures: true } },
            arg: { ...prompt(), useStreaming: false },
            upstream: () =>
                json({
                    candidates: [
                        {
                            content: {
                                parts: [
                                    { text: "Here is a picture." },
                                    { inlineData: { mimeType: "image/png", data: "AAAA" } },
                                    { inlineData: { mimeType: "audio/wav", data: "BBBB" } },
                                ],
                            },
                        },
                    ],
                    usageMetadata: { totalTokenCount: 10 },
                }),
        });
        expectSame(sides);
        expect(sides.server.calls[0].url).toBe(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${SECRETS.google}`,
        );
        expect(sides.server.calls[0].body).toMatchObject({
            generation_config: { topK: 7 },
            systemInstruction: { parts: [{ text: "Be brief." }] },
        });
        expect(sides.server.inlays).toEqual([
            { kind: "image", id: "id-1", mimeType: "image/png", data: "AAAA" },
            // The audio id is the third generated one: the adapter draws an id for every inline part first.
            { kind: "audio", id: "id-3", name: "gemini-audio", ext: "wav", data: "data:audio/wav;base64,BBBB" },
        ]);
        expect(sides.server.result).toEqual({ type: "success", result: "Here is a picture.\n\n{{inlayeddata::id-1}}" });
    });

    it("Google, streaming: the cumulative chunks, and a preview", async () => {
        const sides = await both({
            settings: { preset: { aiModel: "gemini-2.5-flash" }, providers: { useStreaming: true } },
            arg: { ...prompt(), useStreaming: true },
            upstream: () =>
                sse([
                    { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
                    { candidates: [{ content: { parts: [{ text: "lo" }] } }] },
                ]),
        });
        expectSame(sides);
        expect(sides.server.calls[0].url).toContain("models/gemini-2.5-flash:streamGenerateContent");
        expect(sides.server.calls[0].url).toContain(`key=${SECRETS.google}`);
        expect(sides.server.chunks.at(-1)).toEqual({ "0": "Hello" });
        const preview = await both({
            settings: { preset: { aiModel: "gemini-2.5-flash" } },
            arg: { ...prompt(), previewBody: true },
            upstream: () => chat("never"),
        });
        expectSame(preview);
        expect(preview.server.calls).toHaveLength(0);
    });

    it("Vertex: the bearer token (the server's cache stands in for the client's stored token) and the regional endpoint", async () => {
        const sides = await both({
            settings: {
                preset: { aiModel: "gemini-2.5-flash-vertex" },
                providers: { vertexRegion: "us-central1" },
                secrets: {
                    vertexClientEmail: "svc@proj.iam.gserviceaccount.com",
                    vertexPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
                },
            },
            arg: { ...prompt(), useStreaming: false },
            upstream: () => json({ candidates: [{ content: { parts: [{ text: "vertex says" }] } }] }),
        });
        expectSame(sides);
        expect(sides.server.calls[0]).toMatchObject({
            url: "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
            headers: { authorization: `Bearer ${SECRETS.vertexToken}` },
        });
        expect(sides.server.result).toEqual({ type: "success", result: "vertex says" });
    });

    it("Google: a tool round trip with a remembered record", async () => {
        const sides = await both({
            settings: { preset: { aiModel: "gemini-2.5-flash" } },
            arg: { ...prompt(), useStreaming: false, rememberToolUsage: true },
            tools: [
                {
                    name: "rollDice",
                    description: "roll",
                    inputSchema: { type: "object", properties: { sides: { type: "number" } } },
                },
            ],
            toolAnswer: [{ type: "text", text: "4" }],
            upstream: (call) =>
                JSON.stringify(call.body).includes("functionResponse")
                    ? json({ candidates: [{ content: { parts: [{ text: "rolled a 4" }] } }] })
                    : json({
                          candidates: [
                              {
                                  content: {
                                      parts: [{ functionCall: { id: "fc-1", name: "rollDice", args: { sides: 6 } } }],
                                  },
                              },
                          ],
                      }),
        });
        expectSame(sides);
        expect(sides.server.calls).toHaveLength(2);
        expect(sides.server.toolCalls).toEqual([{ name: "rollDice", args: { sides: 6 } }]);
        expect(sides.server.records).toEqual([
            { call: { id: "fc-1", name: "rollDice", arg: { sides: 6 } }, response: [{ type: "text", text: "4" }] },
        ]);
    });

    it("a request without a selected character: the template and the prompt read no name on either side", async () => {
        const sides = await both({
            settings: { selectedCharacterName: null, preset: { customAPIFormat: LLMFormat.OpenAILegacyInstruct } },
            arg: { formated: [{ role: "user", content: "translate me" }], bias: {} },
            mode: "translate",
            upstream: () => json({ choices: [{ text: "translated" }] }),
        });
        expectSame(sides);
        expect(sides.server.result).toEqual({ type: "success", result: "translated" });
    });
});
