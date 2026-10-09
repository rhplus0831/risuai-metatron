// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMFlags, LLMFormat } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import type { ModelModeExtended, RequestArgs, ToolCallRecord, ToolDescriptor } from "../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { RequestContext } from "../llm/context.ts";
import { requestChatDataMain } from "../llm/request.ts";
import { loadRequestDb } from "../llm/settings.ts";
import { createTransport } from "../llm/transport.ts";

// The provider adapters of the server request layer (`server/src/llm/`), run through
// `requestChatDataMain` with one `RequestDb` read (`loadRequestDb`), frozen time and ids, and one
// recording upstream: what reaches the upstream (method, URL, headers, body), what comes back
// (result, chunks), and the side effects (tool calls, remembered records, inlays, CBS parses,
// alerts, Claude observer registrations, logs), for OpenAI-compatible (buffered, streaming, a JSON
// schema, a tool round trip, a failure, a preview), a custom model, Mistral, the legacy instruct
// format, the auxiliary and sub models, the Responses API, Anthropic (buffered, streaming), Bedrock
// (SigV4), Google (buffered, streaming, a preview, a tool round trip), Vertex, NanoGPT's Messages,
// Legacy, and Responses formats (endpoint, key, request model, provider), and a request without a
// selected character. The NanoGPT cases and the named credential cases
// (`docs/plan/shared-api-keys.md`) are not part of the oracle capture below.
//
// Phase 6 slice 11: this was the Phase 5 slice 7a parity gate
// (`src/ts/process/request/tests/serverParity.test.ts`), which ran the pre-cutover browser adapters
// (the test oracles) beside the server and compared the ten outputs above. The expected values
// below are the browser oracle's recorded output, captured from that test's `runClient` at
// `2f658598` (the slice 11 tree) before the oracle was deleted; they were not produced by the
// server. The formats whose client copy lived in `request.ts` itself (NovelAI, Ooba, Kobold,
// NovelList, Cohere, Horde, Ollama, Echo) were never part of the gate and are exercised in the
// other `server/src/tests/` files.
//
// One seam differs from the capture: the fake tool `encode` below writes its marker as
// `<tool_call>${id}${name}</tool_call>`, while the gate's fake (and the real encoder,
// `src/ts/process/mcp/mcp.ts`) put U+F100 between the id and the name. So in the three tool round
// trips (OpenAI, Responses, Google) the `result` literal reads `call_1rollDice` where the capture
// read `call_1<U+F100>rollDice`. The marker is the fake encoder's output, not an adapter's, and every
// other compared field equals the capture; the fake, the `known` keys, the prompt text, and the
// literals agree with each other.

/** The deterministic ids: the adapters name inlays through `node:crypto`'s `randomUUID`. */
const ids = vi.hoisted(() => ({ next: 0 }));
const nextId = () => `id-${++ids.next}`;
vi.mock("node:crypto", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:crypto")>();
    const randomUUID = () => nextId();
    return { ...actual, default: { ...actual, randomUUID }, randomUUID };
});

/** The service accounts the Vertex token cache was asked for, in order. */
const vertexLogins: [string, string][] = [];

type Upstream = { url: string; method: string; headers: Record<string, string>; body: unknown };
type CannedResponse = { status: number; headers?: Record<string, string>; body: string };

const tokenize = (text: string) => Array.from(text).map((char) => char.codePointAt(0) ?? 0);

// ---------------------------------------------------------------------------------------------
// The settings: one store read.

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
/**
 * A reverse proxy has no flat default key (`docs/plan/model-profiles.md` O2): the fixture's
 * `reverse_proxy` profiles bind this named key unless the scenario names its own `credentialId`.
 */
const PROXY_CREDENTIAL = { id: "proxy", name: "Proxy key", type: "custom" };

type ProfileSlot = "main" | "sub" | "memory" | "translate" | "emotion" | "otherAx";

type Settings = {
    /**
     * The prompt preset's fields and the model fields together. `aiModel`, `subModel`, and
     * `seperateModels` name the main, sub, and auxiliary profiles' model ids; every other model
     * field (connection, compatibility, `credentialId`) goes on each of those profiles, as one
     * model preset used to hold them for every slot.
     */
    preset?: Record<string, unknown>;
    /** Per-profile fields over the derived ones (for example two different `credentialId`s). */
    profiles?: Partial<Record<ProfileSlot, Record<string, unknown>>>;
    providers?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
    customModels?: unknown[];
    /** The named credentials' readable records (their keys go in `secrets.credentials`). */
    credentials?: unknown[];
    selectedCharacterName?: string | null;
    /** The model preset `m` (its slots and toggle) and the profiles as given, over `preset`'s derived ones. */
    model?: { preset: Record<string, unknown>; profiles: Record<string, unknown>[] };
};

/** The model preset `m` and its profiles, from `Settings.preset` and `Settings.profiles`. */
function modelRecords(overrides: Settings) {
    const {
        aiModel = "reverse_proxy",
        subModel = "reverse_proxy",
        seperateModels = {},
        seperateModelsForAxModels = false,
        ...fields
    } = (overrides.preset ?? {}) as Record<string, any>;
    const profile = (slot: ProfileSlot, modelId: string) => ({
        id: slot,
        name: slot,
        forceReplaceUrl: PROVIDER,
        customProxyRequestModel: "mock-model",
        customAPIFormat: LLMFormat.OpenAICompatible,
        ...(modelId === "reverse_proxy" && !("credentialId" in fields) ? { credentialId: PROXY_CREDENTIAL.id } : {}),
        ...fields,
        modelId,
        ...overrides.profiles?.[slot],
    });
    const aux = Object.entries(seperateModels as Record<string, string>).filter(([, modelId]) => modelId);
    return {
        modelProfiles: normalizeModelProfiles([
            profile("main", aiModel),
            profile("sub", subModel),
            ...aux.map(([mode, modelId]) => profile(mode as ProfileSlot, modelId)),
        ]),
        modelPresets: normalizeModelPresets([
            {
                id: "m",
                name: "m",
                mainSlot: { profileId: "main" },
                subSlot: { profileId: "sub" },
                auxSlots: Object.fromEntries(aux.map(([mode]) => [mode, { profileId: mode }])),
                seperateModelsForAxModels,
            },
        ]),
    };
}

function settings(overrides: Settings = {}) {
    const secrets = overrides.secrets ?? {};
    const records: Record<string, unknown> = {
        providers: normalizeProviders({ requestRetrys: 0, ...overrides.providers }),
        llmSecrets: normalizeLlmSecrets({
            openAIKey: SECRETS.openAIKey,
            claudeAPIKey: SECRETS.claudeAPIKey,
            mistralKey: SECRETS.mistralKey,
            google: { accessToken: SECRETS.google, projectId: "proj-1" },
            ...secrets,
            credentials: {
                [PROXY_CREDENTIAL.id]: { key: SECRETS.proxyKey },
                ...(secrets.credentials as Record<string, unknown> | undefined),
            },
        }),
        ui: { autoSuggestPrefix: "" },
        customModels: overrides.customModels ?? [],
        credentials: [PROXY_CREDENTIAL, ...(overrides.credentials ?? [])],
        // `overrides.preset` mixes the prompt preset's and the model fields: the prompt preset
        // normalizer keeps its own (`docs/plan/split-preset.md`), `modelRecords` takes the rest.
        presets: normalizePresets([{ id: "p", name: "p", maxResponse: 300, temperature: 70, ...overrides.preset }]),
        ...(overrides.model
            ? {
                  modelProfiles: normalizeModelProfiles(overrides.model.profiles),
                  modelPresets: normalizeModelPresets([{ id: "m", name: "m", ...overrides.model.preset }]),
              }
            : modelRecords(overrides)),
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
        modelPresetId: "m",
        personaId: "u",
        selectedPersonaId: "u",
        selectedCharacterId: overrides.selectedCharacterName === null ? null : "c",
        speakerId: null,
    });
}

// ---------------------------------------------------------------------------------------------
// One run: the request over a recording context.

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
    mode?: ModelModeExtended;
    tools?: ToolDescriptor[];
    /** The remembered tool calls the prompt's markers name. */
    known?: Record<string, ToolCallRecord>;
    toolAnswer?: { type: "text"; text: string }[];
    /** A format per model id, over the catalogue's (the `nanogpt` entry is Chat in the catalogue). */
    formats?: Record<string, LLMFormat>;
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

async function run(scenario: Scenario): Promise<Recorded> {
    const loaded = settings(scenario.settings);
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
    ids.next = 0;
    vertexLogins.length = 0;
    const controller = new AbortController();
    const transport = createTransport({
        signal: controller.signal,
        log: (entry) => logs.push(entry.url),
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
            // The scenario sees the parsed body.
            let parsed: unknown = call.body;
            try {
                parsed = typeof call.body === "string" ? JSON.parse(call.body) : call.body;
            } catch {}
            const canned = scenario.upstream({ ...JSON.parse(JSON.stringify(call)), body: parsed });
            return new Response(canned.body, { status: canned.status, headers: canned.headers ?? {} });
        }) as typeof fetch,
    });
    // As `buildContext`: the main profile's flags (the roots), or the request-local profile's.
    const getModelInfo: RequestContext["getModelInfo"] = (id, profile = db as never) => {
        const info = resolveModelInfo(id, {
            enableCustomFlags: profile.enableCustomFlags,
            customFlags: profile.customFlags,
            customModels: db.customModels,
        });
        const format = scenario.formats?.[id];
        return format === undefined ? info : { ...info, format };
    };
    const ctx: RequestContext = {
        db: db as never,
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
                return `<tool_call>${record.call.id}${record.call.name}</tool_call>\n\n`;
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
        vertexAccessToken: async (clientEmail, privateKey) => {
            vertexLogins.push([clientEmail, privateKey]);
            return SECRETS.vertexToken;
        },
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

// ---------------------------------------------------------------------------------------------
// The expected values (the browser oracle's recorded output; see the header).

/** No stream chunks and no side effects: a scenario spells out every output it has. */
const QUIET = { chunks: [], alerts: [], parses: [], toolCalls: [], records: [], inlays: [], observer: [] };
const PROXY_AUTH = { authorization: `Bearer ${SECRETS.proxyKey}` };
/** `prompt()` as the OpenAI-compatible adapter sends it. */
const MESSAGES = [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hello {{char}}" },
    { role: "assistant", content: "Hi {{user}}" },
    { role: "user", content: "Tell me more" },
];
/** The sampling fields `applyParameters` writes from the default preset (`temperature: 70`). */
const OPENAI_SAMPLING = {
    temperature: 0.7,
    top_p: 1,
    frequency_penalty: 0.7,
    presence_penalty: 0.7,
    repetition_penalty: 1,
    min_p: 0,
    top_a: 0,
    top_k: 0,
    thinking_tokens: null,
};
const MISTRAL_CALL = {
    method: "POST",
    url: "https://api.mistral.ai/v1/chat/completions",
    headers: { authorization: `Bearer ${SECRETS.mistralKey}` },
    body: {
        model: "mistral-small-latest",
        messages: MESSAGES,
        safe_prompt: false,
        max_tokens: 300,
        temperature: 0.7,
        presence_penalty: 0.7,
        frequency_penalty: 0.7,
        top_p: 1,
    },
};
/** `prompt()` as the Responses adapter sends it. */
const RESPONSES_INPUT = [
    { content: [{ type: "input_text", text: "Be brief." }], role: "system" },
    { content: [{ type: "input_text", text: "Hello {{char}}" }], role: "user" },
    {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hi {{user}}", annotations: [] }],
    },
    { content: [{ type: "input_text", text: "Tell me more" }], role: "user" },
];
const RESPONSES_URL = `${PROVIDER}/v1/responses`;
/** `prompt()` as the Anthropic adapter sends it (the system message is `system`). */
const ANTHROPIC_MESSAGES = [
    { role: "user", content: [{ type: "text", text: "Hello {{char}}" }] },
    { role: "assistant", content: [{ type: "text", text: "Hi {{user}}" }] },
    { role: "user", content: [{ type: "text", text: "Tell me more" }] },
];
/** `prompt()` as the Google adapter sends it (the system message is `systemInstruction`). */
const GOOGLE_CONTENTS = [
    { role: "user", parts: [{ text: "Hello {{char}}" }] },
    { role: "model", parts: [{ text: "Hi {{user}}" }] },
    { role: "user", parts: [{ text: "Tell me more" }] },
];
const GOOGLE_GENERATION = {
    maxOutputTokens: 300,
    temperature: 0.7,
    topP: 1,
    presencePenalty: 0.7,
    frequencyPenalty: 0.7,
    thinkingConfig: { thinkingBudget: null, includeThoughts: true },
};
const GOOGLE_SAFETY = [
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];
const GOOGLE_SYSTEM = { parts: [{ text: "Be brief." }] };
const GOOGLE_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${SECRETS.google}`;
const GOOGLE_BODY = {
    contents: GOOGLE_CONTENTS,
    generation_config: GOOGLE_GENERATION,
    safetySettings: GOOGLE_SAFETY,
    systemInstruction: GOOGLE_SYSTEM,
};
const ROLL_DICE: ToolDescriptor = {
    name: "rollDice",
    description: "roll",
    inputSchema: { type: "object", properties: { sides: { type: "number" } } },
};

const NANOGPT_KEY = "nanogpt-SENTINEL-8888";
const NANOGPT_MODEL = "nano/model-1";
/**
 * One `nanogpt` request in `format`, with the NanoGPT key, the request model and the provider (both
 * profile fields, `docs/plan/model-profiles.md` O7), and the provider settings given.
 */
const nanogpt = (
    format: LLMFormat,
    { nanogptProvider, ...providers }: Record<string, unknown>,
    answer: CannedResponse,
) =>
    run({
        settings: {
            preset: { aiModel: "nanogpt", nanogptRequestModel: NANOGPT_MODEL, nanogptProvider },
            providers,
            secrets: { nanogptKey: NANOGPT_KEY },
        },
        formats: { nanogpt: format },
        arg: prompt(),
        upstream: () => answer,
    });
/** Each upstream call's URL, headers, and body model. */
const sent = (recorded: Recorded) =>
    recorded.calls.map((call) => ({
        url: call.url,
        headers: call.headers,
        model: (call.body as { model?: unknown }).model,
    }));
/** No other provider's key (all present in the settings) reaches a NanoGPT request. */
function expectNoForeignKeys(runs: Recorded[]) {
    const wire = JSON.stringify(runs.map((recorded) => [recorded.calls, recorded.observer]));
    expect(wire).toContain(NANOGPT_KEY);
    for (const key of [SECRETS.claudeAPIKey, SECRETS.openAIKey, SECRETS.proxyKey]) {
        expect(wire).not.toContain(key);
    }
}

beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z"), toFake: ["Date"] });
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("the server provider adapters", () => {
    it("OpenAI-compatible, buffered: the proxy key, model, parameters, bias strings, additional parameters and headers, and the answer", async () => {
        const recorded = await run({
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
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: { ...PROXY_AUTH, "x-custom": "custom-value" },
                    body: {
                        model: "mock-model",
                        messages: MESSAGES,
                        max_tokens: 123,
                        // "hello" and "ban" are tokenized per character (the test tokenizer) and
                        // `strongBan` bans the first token of the `-101` string.
                        logit_bias: { 42: 3, 98: -100, 101: -5, 104: -5, 108: -5, 111: -5 },
                        stream: false,
                        // The parameters come from the preset (`applyParameters`), not from the
                        // caller's `temperature`; `top_k` is the additional parameter's.
                        temperature: 0.7,
                        top_p: 0.9,
                        frequency_penalty: 0.1,
                        presence_penalty: 0.2,
                        repetition_penalty: 1,
                        min_p: 0,
                        top_a: 0,
                        top_k: 3,
                        thinking_tokens: null,
                        // A `json::` prefix is read on the value, not the key: this one is a plain string field.
                        "json::extra": '{"a": True}',
                    },
                },
            ],
            result: { type: "success", result: "a plain answer" },
            logs: [PROVIDER],
        });
    });

    it("OpenAI-compatible, streaming: the cumulative chunks and the log", async () => {
        const recorded = await run({
            settings: { providers: { useStreaming: true } },
            arg: { ...prompt(), useStreaming: true },
            upstream: () =>
                sse([
                    { choices: [{ delta: { content: "Hel" } }] },
                    { choices: [{ delta: { content: "lo" } }] },
                    "[DONE]",
                ]),
        });
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        messages: MESSAGES,
                        max_tokens: 300,
                        stream: true,
                        ...OPENAI_SAMPLING,
                    },
                },
            ],
            result: { type: "streaming" },
            // One chunk with the whole text: the canned body arrives in one read.
            chunks: [{ "0": "Hello" }],
            // The transport's own entry and the adapter's "Streaming" entry, as on the client.
            logs: [PROVIDER, PROVIDER],
        });
    });

    it("OpenAI-compatible: a JSON schema from an interface, the extraction path, and the CBS parses in order", async () => {
        const recorded = await run({
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
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        messages: MESSAGES,
                        max_tokens: 300,
                        stream: false,
                        response_format: {
                            type: "json_schema",
                            json_schema: {
                                name: "format",
                                strict: true,
                                schema: {
                                    $schema: "https://json-schema.org/draft/2020-12/schema",
                                    type: "object",
                                    additionalProperties: false,
                                    properties: { answer: { type: "string" }, score: { type: "number" } },
                                    required: ["answer", "score"],
                                },
                            },
                        },
                        ...OPENAI_SAMPLING,
                    },
                },
            ],
            result: { type: "success", result: "forty-two" },
            logs: [PROVIDER],
            // The interface first (the schema), then the extraction path.
            parses: ["interface Answer {\n  answer: string\n  score: number\n}", "answer"],
        });
    });

    it("OpenAI-compatible: one tool round trip with a remembered record and a decoded earlier one", async () => {
        const earlier: ToolCallRecord = {
            call: { id: "earlier", name: "lookup", arg: '{"q":"x"}' },
            response: [{ type: "text", text: "found" }],
        };
        const recorded = await run({
            settings: { preset: { subModel: "reverse_proxy" } },
            arg: {
                ...prompt(),
                formated: [
                    { role: "user", content: "first" },
                    { role: "assistant", content: "I looked. <tool_call>earlierlookup</tool_call> Done." },
                    { role: "user", content: "roll" },
                ],
                rememberToolUsage: true,
            },
            tools: [ROLL_DICE],
            known: { earlierlookup: earlier },
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
        const transformed = [
            { role: "user", content: "first" },
            {
                role: "assistant",
                content: "I looked. ",
                tool_calls: [{ id: "earlier", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
            },
            { role: "tool", content: "found", tool_call_id: "earlier" },
            { role: "assistant", content: " Done." },
            { role: "user", content: "roll" },
        ];
        const tools = [
            {
                type: "function",
                function: {
                    name: "rollDice",
                    description: "roll",
                    parameters: { type: "object", properties: { sides: { type: "number" } } },
                },
            },
        ];
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        messages: transformed,
                        max_tokens: 300,
                        stream: false,
                        ...OPENAI_SAMPLING,
                        tools,
                    },
                },
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        messages: [
                            ...transformed,
                            {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "call_1",
                                        type: "function",
                                        function: { name: "rollDice", arguments: '{"sides":6}' },
                                    },
                                ],
                            },
                            { role: "tool", content: "4", tool_call_id: "call_1" },
                        ],
                        max_tokens: 300,
                        stream: false,
                        ...OPENAI_SAMPLING,
                        tools,
                    },
                },
            ],
            // The remembered marker, then the answer of the follow-up request.
            result: { type: "success", result: "\n\n<tool_call>call_1rollDice</tool_call>\n\n\n\nrolled a 4" },
            logs: [PROVIDER, PROVIDER],
            toolCalls: [{ name: "rollDice", args: { sides: 6 } }],
            // The OpenAI adapter remembers the arguments as the provider sent them: a JSON string.
            records: [
                {
                    call: { id: "call_1", name: "rollDice", arg: '{"sides":6}' },
                    response: [{ type: "text", text: "4" }],
                },
            ],
        });
    });

    it("OpenAI-compatible: a provider failure and a preview", async () => {
        const failed = await run({
            settings: {},
            arg: prompt(),
            upstream: () => json({ error: { message: `Incorrect API key ${SECRETS.proxyKey}` } }, 401),
        });
        expect(failed).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        messages: MESSAGES,
                        max_tokens: 300,
                        stream: false,
                        ...OPENAI_SAMPLING,
                    },
                },
            ],
            // The adapter's failure text (this context's `redactText` keeps the key; the request
            // layer redacts it before the tab sees it).
            result: { type: "fail", result: `Error: error in request:Incorrect API key ${SECRETS.proxyKey}` },
            logs: [PROVIDER],
        });

        const preview = await run({
            settings: {},
            arg: { ...prompt(), previewBody: true },
            upstream: () => chat("never"),
        });
        // No upstream call and no log for a preview: the result is the request that would be sent.
        expect(preview).toEqual({
            ...QUIET,
            calls: [],
            result: {
                type: "success",
                result: JSON.stringify({
                    url: PROVIDER,
                    body: {
                        model: "mock-model",
                        messages: MESSAGES,
                        max_tokens: 300,
                        stream: false,
                        ...OPENAI_SAMPLING,
                    },
                    headers: { Authorization: `Bearer ${SECRETS.proxyKey}`, "Content-Type": "application/json" },
                }),
            },
            logs: [],
        });
    });

    it("a custom model (`xcustom:::`), Mistral, and the legacy instruct format", async () => {
        const custom = await run({
            settings: {
                // A custom model holds no key (`docs/plan/model-profiles.md` O2): its profile binds one.
                preset: { aiModel: "xcustom:::mine", credentialId: "mine" },
                credentials: [{ id: "mine", name: "Mine", type: "custom" }],
                secrets: { credentials: { mine: { key: "custom-key" } } },
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
        expect(custom).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: "https://custom.test/v1/chat/completions",
                    headers: { authorization: "Bearer custom-key" },
                    body: { model: "mine-1", messages: MESSAGES, max_tokens: 300, stream: false, ...OPENAI_SAMPLING },
                },
            ],
            result: { type: "success", result: "custom answer" },
            logs: ["https://custom.test/v1/chat/completions"],
        });

        const mistral = await run({
            settings: { preset: { aiModel: "mistral-small-latest" } },
            arg: prompt(),
            upstream: () => chat("bonjour"),
        });
        expect(mistral).toEqual({
            ...QUIET,
            calls: [MISTRAL_CALL],
            result: { type: "success", result: "bonjour" },
            logs: [MISTRAL_CALL.url],
        });

        const legacy = await run({
            settings: { preset: { customAPIFormat: LLMFormat.OpenAILegacyInstruct } },
            arg: prompt(),
            upstream: () => json({ choices: [{ text: "instructed" }] }),
        });
        expect(legacy).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: PROXY_AUTH,
                    body: {
                        model: "gpt-3.5-turbo-instruct",
                        prompt: "\n## Instruction\nBe brief.\n## User\nHello {{char}}\n## Assistant\nHi {{user}}\n## User\nTell me more\n## Response\n",
                        max_tokens: 300,
                        temperature: 0.7,
                        top_p: 1,
                        stop: ["User:", " User:", "user:", " user:"],
                        presence_penalty: 0.7,
                        frequency_penalty: 0.7,
                    },
                },
            ],
            result: { type: "success", result: "instructed" },
            logs: [PROVIDER],
        });
    });

    it("the auxiliary model of a translate call (`seperateModels`) and the sub model", async () => {
        const aux = await run({
            // The auxiliary models are model preset fields (`docs/plan/split-preset.md`).
            settings: {
                preset: { seperateModelsForAxModels: true, seperateModels: { translate: "mistral-small-latest" } },
            },
            arg: prompt(),
            mode: "translate",
            upstream: () => chat("traduit"),
        });
        expect(aux).toEqual({
            ...QUIET,
            calls: [MISTRAL_CALL],
            result: { type: "success", result: "traduit" },
            logs: [MISTRAL_CALL.url],
        });

        const sub = await run({
            settings: { preset: { subModel: "mistral-small-latest" } },
            arg: prompt(),
            mode: "submodel",
            upstream: () => chat("sub"),
        });
        expect(sub).toEqual({
            ...QUIET,
            calls: [MISTRAL_CALL],
            result: { type: "success", result: "sub" },
            logs: [MISTRAL_CALL.url],
        });
    });

    it("the Responses API, buffered and streaming, with a tool call", async () => {
        const lookup: ToolDescriptor = {
            name: "lookup",
            description: "look",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
        };
        const buffered = await run({
            settings: { preset: { customAPIFormat: LLMFormat.OpenAIResponseAPI } },
            arg: { ...prompt(), rememberToolUsage: true },
            tools: [lookup],
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
        const responsesTools = [
            {
                type: "function",
                name: "lookup",
                description: "look",
                parameters: { type: "object", properties: { q: { type: "string" } } },
            },
        ];
        expect(buffered).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    // The proxy URL with the Responses path appended (`autofillRequestUrl`).
                    url: RESPONSES_URL,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        input: RESPONSES_INPUT,
                        max_output_tokens: 300,
                        tools: responsesTools,
                        store: false,
                        temperature: 0.7,
                        top_p: 1,
                        stream: false,
                    },
                },
                {
                    method: "POST",
                    url: RESPONSES_URL,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        // The continuation: the function call (without the server's item id) and its output.
                        input: [
                            ...RESPONSES_INPUT,
                            {
                                type: "function_call",
                                call_id: "fc_1",
                                name: "lookup",
                                arguments: '{"q":"x"}',
                                status: "completed",
                            },
                            { type: "function_call_output", call_id: "fc_1", output: "looked up" },
                        ],
                        max_output_tokens: 300,
                        tools: responsesTools,
                        store: false,
                        temperature: 0.7,
                        top_p: 1,
                        stream: false,
                    },
                },
            ],
            result: { type: "success", result: "<tool_call>fc_1lookup</tool_call>\n\n\n\nfinal answer" },
            logs: [RESPONSES_URL, RESPONSES_URL],
            toolCalls: [{ name: "lookup", args: { q: "x" } }],
            records: [
                {
                    call: { id: "fc_1", name: "lookup", arg: '{"q":"x"}' },
                    response: [{ type: "text", text: "looked up" }],
                },
            ],
        });

        const streaming = await run({
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
        const thoughtful = "<Thoughts>\n\nthinking\n\n</Thoughts>\nHello";
        expect(streaming).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: RESPONSES_URL,
                    headers: PROXY_AUTH,
                    body: {
                        model: "mock-model",
                        input: RESPONSES_INPUT,
                        max_output_tokens: 300,
                        store: false,
                        temperature: 0.7,
                        top_p: 1,
                        stream: true,
                    },
                },
            ],
            result: { type: "streaming" },
            // One chunk per event: the text, the reasoning summary placed before it, the rest of
            // the text, the completed event (its final text replaces the deltas, equal here), the
            // `[DONE]` frame, and the flush at the end of the body.
            chunks: [
                { "0": "Hel" },
                { "0": "<Thoughts>\n\nthinking\n\n</Thoughts>\nHel" },
                { "0": thoughtful },
                { "0": thoughtful },
                { "0": thoughtful },
                { "0": thoughtful },
            ],
            logs: [RESPONSES_URL, RESPONSES_URL],
        });
    });

    it("Anthropic, buffered: caching, prefill, the system prompt, and the warmer registration", async () => {
        const recorded = await run({
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
        const body = {
            model: "claude-sonnet-4-5-20250929",
            messages: [...ANTHROPIC_MESSAGES, { role: "assistant", content: [{ type: "text", text: "Prefill:" }] }],
            system: "Be brief.",
            max_tokens: 222,
            stream: false,
            temperature: 0.7,
            top_k: 5,
            top_p: 0.8,
        };
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: "https://api.anthropic.com/v1/messages",
                    headers: {
                        "x-api-key": SECRETS.claudeAPIKey,
                        "anthropic-version": "2023-06-01",
                        accept: "application/json",
                        // The one-hour cache beta; the messages of this prompt carry no `cache_control`.
                        "anthropic-beta": "extended-cache-ttl-2025-04-11",
                    },
                    body,
                },
            ],
            result: { type: "success", result: "claude says" },
            logs: ["https://api.anthropic.com/v1/messages"],
            // The warmer (`claudeRetrivalCaching`) is registered with the request as sent: the
            // same body and the raw headers.
            observer: [
                {
                    url: "https://api.anthropic.com/v1/messages",
                    body,
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": SECRETS.claudeAPIKey,
                        "anthropic-version": "2023-06-01",
                        accept: "application/json",
                        "anthropic-beta": "extended-cache-ttl-2025-04-11",
                    },
                },
            ],
        });
    });

    it("Anthropic, streaming: the cumulative chunks, and a provider error that stays answer text", async () => {
        const recorded = await run({
            settings: { preset: { aiModel: "claude-sonnet-4-5-20250929" }, providers: { useStreaming: true } },
            arg: { ...prompt(), useStreaming: true },
            upstream: () =>
                sse([
                    { type: "message_start", message: {} },
                    { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
                    { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
                    { type: "error", error: { type: "api_error", message: "mid-stream trouble" } },
                    { type: "message_stop" },
                ]),
        });
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: "https://api.anthropic.com/v1/messages",
                    headers: {
                        "x-api-key": SECRETS.claudeAPIKey,
                        "anthropic-version": "2023-06-01",
                        accept: "application/json",
                    },
                    body: {
                        model: "claude-sonnet-4-5-20250929",
                        messages: ANTHROPIC_MESSAGES,
                        system: "Be brief.",
                        max_tokens: 300,
                        stream: true,
                        temperature: 0.7,
                        top_k: 0,
                        top_p: 1,
                    },
                },
            ],
            result: { type: "streaming" },
            // One chunk (the canned body arrives in one read): the text, and the error appended to it as text.
            chunks: [{ "0": "HelloError:mid-stream trouble" }],
            logs: ["https://api.anthropic.com/v1/messages"],
        });
    });

    it("Bedrock: the Signature V4 headers with a frozen clock", async () => {
        const recorded = await run({
            settings: {
                preset: { aiModel: "anthropic.claude-opus-4-6-v1" },
                secrets: { claudeAPIKey: SECRETS.bedrock },
            },
            arg: { ...prompt(), useStreaming: false },
            upstream: () => json({ content: [{ type: "text", text: "from bedrock" }] }),
        });
        const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-opus-4-6-v1/invoke";
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    // The region from the credential's third field; the model id gets the `global.` prefix.
                    url,
                    headers: {
                        host: "bedrock-runtime.us-east-1.amazonaws.com",
                        accept: "application/json",
                        "x-amz-date": "20261001T120000Z",
                        "x-amz-content-sha256": "d4451d61810670410622f94c4ee47c6978ab8db110244fced77ef64f6a67d8fb",
                        authorization:
                            "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261001/us-east-1/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date, Signature=ca7cbce297238d45df439a669f4c6d488dc433e82778df1884bd8cd13cd54467",
                    },
                    // No `model` and no `stream` in the body; the Bedrock API version instead.
                    body: {
                        messages: ANTHROPIC_MESSAGES,
                        system: "Be brief.",
                        max_tokens: 300,
                        temperature: 0.7,
                        top_k: 0,
                        top_p: 1,
                        anthropic_version: "bedrock-2023-05-31",
                    },
                },
            ],
            result: { type: "success", result: "from bedrock" },
            logs: [url],
        });
    });

    it("Google, buffered: the key in the query, a thought signature, an inline image, audio, and the answer", async () => {
        const recorded = await run({
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
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: GOOGLE_URL,
                    headers: {},
                    body: { ...GOOGLE_BODY, generation_config: { ...GOOGLE_GENERATION, topK: 7 } },
                },
            ],
            // The image is inlined by its id; the audio is an asset the result does not name.
            result: { type: "success", result: "Here is a picture.\n\n{{inlayeddata::id-1}}" },
            logs: [GOOGLE_URL],
            // No signature: the answer carried none (`saveSignatures` alone writes nothing).
            inlays: [
                { kind: "image", id: "id-1", mimeType: "image/png", data: "AAAA" },
                // The audio id is the third generated one: the adapter draws an id for every inline part first.
                { kind: "audio", id: "id-3", name: "gemini-audio", ext: "wav", data: "data:audio/wav;base64,BBBB" },
            ],
        });
    });

    it("Google, streaming: the cumulative chunks, and a preview", async () => {
        const recorded = await run({
            settings: { preset: { aiModel: "gemini-2.5-flash" }, providers: { useStreaming: true } },
            arg: { ...prompt(), useStreaming: true },
            upstream: () =>
                sse([
                    { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
                    { candidates: [{ content: { parts: [{ text: "lo" }] } }] },
                ]),
        });
        const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${SECRETS.google}&alt=sse`;
        expect(recorded).toEqual({
            ...QUIET,
            calls: [{ method: "POST", url: streamUrl, headers: {}, body: GOOGLE_BODY }],
            result: { type: "streaming" },
            // One chunk with the whole text: the canned body arrives in one read.
            chunks: [{ "0": "Hello" }],
            logs: [streamUrl],
        });

        const preview = await run({
            settings: { preset: { aiModel: "gemini-2.5-flash" } },
            arg: { ...prompt(), previewBody: true },
            upstream: () => chat("never"),
        });
        // No upstream call and no log for a preview.
        expect(preview).toEqual({
            ...QUIET,
            calls: [],
            result: {
                type: "success",
                result: JSON.stringify({
                    url: GOOGLE_URL,
                    body: GOOGLE_BODY,
                    headers: { "Content-Type": "application/json" },
                }),
            },
            logs: [],
        });
    });

    it("Vertex: the bearer token (the server's cache stands in for the client's stored token) and the regional endpoint", async () => {
        const recorded = await run({
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
        const url =
            "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent";
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url,
                    // The token from the context's cache, no key in the query.
                    headers: { authorization: `Bearer ${SECRETS.vertexToken}` },
                    body: GOOGLE_BODY,
                },
            ],
            result: { type: "success", result: "vertex says" },
            logs: [url],
        });
    });

    it("Google: a tool round trip with a remembered record", async () => {
        const recorded = await run({
            settings: { preset: { aiModel: "gemini-2.5-flash" } },
            arg: { ...prompt(), useStreaming: false, rememberToolUsage: true },
            tools: [ROLL_DICE],
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
        const tools = {
            functionDeclarations: [
                {
                    name: "rollDice",
                    description: "roll",
                    parameters: { type: "object", properties: { sides: { type: "number" } } },
                },
            ],
        };
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                { method: "POST", url: GOOGLE_URL, headers: {}, body: { ...GOOGLE_BODY, tools } },
                {
                    method: "POST",
                    url: GOOGLE_URL,
                    headers: {},
                    body: {
                        ...GOOGLE_BODY,
                        // The continuation: the model's call as it came, and the tool's answer as
                        // a function part (the text parsed as JSON: a number).
                        contents: [
                            ...GOOGLE_CONTENTS,
                            {
                                role: "model",
                                parts: [{ functionCall: { id: "fc-1", name: "rollDice", args: { sides: 6 } } }],
                            },
                            {
                                role: "function",
                                parts: [{ functionResponse: { name: "rollDice", response: { data: 4 } } }],
                            },
                        ],
                        tools,
                    },
                },
            ],
            result: { type: "success", result: "\n\n<tool_call>fc-1rollDice</tool_call>\n\n\n\nrolled a 4" },
            logs: [GOOGLE_URL, GOOGLE_URL],
            toolCalls: [{ name: "rollDice", args: { sides: 6 } }],
            // The Google adapter remembers the arguments as the provider sent them: an object.
            records: [
                { call: { id: "fc-1", name: "rollDice", arg: { sides: 6 } }, response: [{ type: "text", text: "4" }] },
            ],
        });
    });

    it("NanoGPT Messages: the one Messages endpoint (the subscription flag has none), the NanoGPT key, request model, and provider, and no batch", async () => {
        const answer = json({ content: [{ type: "text", text: "nano says" }] });
        const runs = [
            // `claudeBatching` would post to `<url>/batches`, which NanoGPT does not have.
            await nanogpt(LLMFormat.NanoGPTMessages, { claudeBatching: true }, answer),
            await nanogpt(LLMFormat.NanoGPTMessages, { nanogptProvider: "prov-a" }, answer),
            await nanogpt(
                LLMFormat.NanoGPTMessages,
                { nanogptProvider: "prov-a", nanogptUseSubscriptionEndpoint: true },
                answer,
            ),
        ];
        const headers = { "x-api-key": NANOGPT_KEY, "anthropic-version": "2023-06-01", accept: "application/json" };
        const url = "https://nano-gpt.com/api/v1/messages";
        expect(runs.map(sent)).toEqual([
            [{ url, headers, model: NANOGPT_MODEL }],
            [{ url, headers: { ...headers, "x-provider": "prov-a" }, model: NANOGPT_MODEL }],
            [{ url, headers: { ...headers, "x-provider": "prov-a" }, model: NANOGPT_MODEL }],
        ]);
        for (const recorded of runs) {
            expect(recorded.result).toEqual({ type: "success", result: "nano says" });
        }
        expectNoForeignKeys(runs);
    });

    it("NanoGPT Legacy: the completions endpoint or its subscription twin, the NanoGPT key, request model, and provider", async () => {
        const answer = json({ choices: [{ text: "nano instructed" }] });
        const runs = [
            await nanogpt(LLMFormat.NanoGPTLegacy, {}, answer),
            await nanogpt(LLMFormat.NanoGPTLegacy, { nanogptProvider: "prov-b" }, answer),
            await nanogpt(LLMFormat.NanoGPTLegacy, { nanogptUseSubscriptionEndpoint: true }, answer),
            await nanogpt(
                LLMFormat.NanoGPTLegacy,
                { nanogptProvider: "prov-b", nanogptUseSubscriptionEndpoint: true },
                answer,
            ),
        ];
        const headers = { authorization: `Bearer ${NANOGPT_KEY}` };
        const url = "https://nano-gpt.com/api/v1/completions";
        const subscriptionUrl = "https://nano-gpt.com/api/subscription/v1/completions";
        expect(runs.map(sent)).toEqual([
            [{ url, headers, model: NANOGPT_MODEL }],
            [{ url, headers: { ...headers, "x-provider": "prov-b" }, model: NANOGPT_MODEL }],
            [{ url: subscriptionUrl, headers, model: NANOGPT_MODEL }],
            [{ url: subscriptionUrl, headers: { ...headers, "x-provider": "prov-b" }, model: NANOGPT_MODEL }],
        ]);
        for (const recorded of runs) {
            expect(recorded.result).toEqual({ type: "success", result: "nano instructed" });
        }
        expectNoForeignKeys(runs);
    });

    it("NanoGPT Responses: the one Responses endpoint, also under the subscription flag (NanoGPT has no subscription Responses route)", async () => {
        const answer = json({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "nano responded" }] }],
        });
        const runs = [
            await nanogpt(LLMFormat.NanoGPTResponses, { nanogptProvider: "prov-c" }, answer),
            await nanogpt(
                LLMFormat.NanoGPTResponses,
                { nanogptProvider: "prov-c", nanogptUseSubscriptionEndpoint: true },
                answer,
            ),
        ];
        const headers = { authorization: `Bearer ${NANOGPT_KEY}` };
        const url = "https://nano-gpt.com/api/v1/responses";
        expect(runs.map(sent)).toEqual([
            [{ url, headers: { ...headers, "x-provider": "prov-c" }, model: NANOGPT_MODEL }],
            // The Responses adapter drops the provider under the subscription flag (unchanged).
            [{ url, headers, model: NANOGPT_MODEL }],
        ]);
        for (const recorded of runs) {
            expect(recorded.result).toEqual({ type: "success", result: "nano responded" });
        }
        expectNoForeignKeys(runs);
    });

    it("a request without a selected character: the template and the prompt read no name", async () => {
        const recorded = await run({
            settings: { selectedCharacterName: null, preset: { customAPIFormat: LLMFormat.OpenAILegacyInstruct } },
            arg: { formated: [{ role: "user", content: "translate me" }], bias: {} },
            mode: "translate",
            upstream: () => json({ choices: [{ text: "translated" }] }),
        });
        expect(recorded).toEqual({
            ...QUIET,
            calls: [
                {
                    method: "POST",
                    url: PROVIDER,
                    headers: PROXY_AUTH,
                    body: {
                        model: "gpt-3.5-turbo-instruct",
                        prompt: "\n## User\ntranslate me\n## Response\n",
                        max_tokens: 300,
                        temperature: 0.7,
                        top_p: 1,
                        stop: ["User:", " User:", "user:", " user:"],
                        presence_penalty: 0.7,
                        frequency_penalty: 0.7,
                    },
                },
            ],
            result: { type: "success", result: "translated" },
            logs: [PROVIDER],
        });
    });
});

// ---------------------------------------------------------------------------------------------
// Named credentials (`docs/plan/shared-api-keys.md`, bound on the profile since
// `docs/plan/model-profiles.md`): a profile's binding replaces the model's default key, a profile
// without one keeps it, and a binding that cannot be honored refuses the request.

const NAMED = {
    work: "sk-named-work-SENTINEL-8888",
    home: "sk-named-home-SENTINEL-9999",
    bedrock: "AKIANAMED:named-bedrock-SENTINEL-1212:us-west-2",
    vertexKey: "-----BEGIN PRIVATE KEY-----\nnamed\n-----END PRIVATE KEY-----",
};

/** The `credentials` records and their keys, as `Settings` fields. */
function named(entries: { id: string; type: string; key?: string; clientEmail?: string; projectId?: string }[]) {
    return {
        credentials: entries.map(({ key: _key, ...record }) => ({ name: `Key ${record.id}`, ...record })),
        credentialKeys: Object.fromEntries(
            entries.filter((entry) => entry.key !== undefined).map((entry) => [entry.id, { key: entry.key }]),
        ),
    };
}

/** Settings with named credentials merged in (the profiles bind them with `credentialId`). */
function withNamed(base: Settings, entries: Parameters<typeof named>[0]): Settings {
    const { credentials, credentialKeys } = named(entries);
    return { ...base, credentials, secrets: { ...base.secrets, credentials: credentialKeys } };
}

const headersOf = (recorded: Recorded) => recorded.calls.map((call) => call.headers);
const wireOf = (recorded: Recorded) => JSON.stringify([recorded.calls, recorded.observer]);
const claudeAnswer = () => json({ content: [{ type: "text", text: "from claude" }] });

describe("named credentials", () => {
    it("a catalogue model's profile binding replaces its default key, and an unbound profile keeps the default", async () => {
        const bound = await run({
            settings: withNamed({ preset: { aiModel: "gpt-5.5", credentialId: "work" } }, [
                { id: "work", type: "openai", key: NAMED.work },
            ]),
            arg: prompt(),
            upstream: () => chat("bound"),
        });
        expect(bound.calls.map((call) => [call.url, call.headers.authorization])).toEqual([
            ["https://api.openai.com/v1/chat/completions", `Bearer ${NAMED.work}`],
        ]);
        expect(wireOf(bound)).not.toContain(SECRETS.openAIKey);
        expect(bound.result).toMatchObject({ type: "success", result: "bound" });

        // A profile without a binding stays on its default key, though a named key exists.
        const unbound = await run({
            settings: withNamed({ preset: { aiModel: "gpt-5.5" } }, [{ id: "work", type: "openai", key: NAMED.work }]),
            arg: prompt(),
            upstream: () => chat("default"),
        });
        expect(headersOf(unbound).map((headers) => headers.authorization)).toEqual([`Bearer ${SECRETS.openAIKey}`]);
        expect(wireOf(unbound)).not.toContain(NAMED.work);
    });

    it("two Anthropic models on one model preset send two different keys", async () => {
        const settings = withNamed(
            {
                preset: { aiModel: "claude-sonnet-4-5-20250929", subModel: "claude-opus-4-6" },
                profiles: { main: { credentialId: "work" }, sub: { credentialId: "home" } },
            },
            [
                { id: "work", type: "anthropic", key: NAMED.work },
                { id: "home", type: "custom", key: NAMED.home },
            ],
        );
        const main = await run({ settings, arg: prompt(), upstream: claudeAnswer });
        const sub = await run({ settings, arg: prompt(), mode: "submodel", upstream: claudeAnswer });
        expect(headersOf(main).map((headers) => headers["x-api-key"])).toEqual([NAMED.work]);
        expect(headersOf(sub).map((headers) => headers["x-api-key"])).toEqual([NAMED.home]);
        expect((main.calls[0].body as { model: string }).model).toBe("claude-sonnet-4-5-20250929");
        expect((sub.calls[0].body as { model: string }).model).toBe("claude-opus-4-6");
        for (const recorded of [main, sub]) {
            expect(wireOf(recorded)).not.toContain(SECRETS.claudeAPIKey);
        }
    });

    it("two custom models share one key on their profiles; an unbound custom model sends no key", async () => {
        const customModel = (id: string) => ({
            id,
            name: id,
            internalId: `${id}-internal`,
            url: "https://custom.test/v1/chat/completions",
            format: LLMFormat.OpenAICompatible,
            flags: [LLMFlags.hasFullSystemPrompt],
            tokenizer: 0,
            params: "",
        });
        const base = (aiModel: string, credentialId?: string): Settings => ({
            preset: { aiModel, ...(credentialId ? { credentialId } : {}) },
            customModels: [customModel("xcustom:::a"), customModel("xcustom:::b"), customModel("xcustom:::c")],
        });
        const entries = [
            { id: "shared", type: "custom", key: NAMED.work },
            { id: "other", type: "custom", key: NAMED.home },
        ];
        const runs = await Promise.all(
            (
                [
                    ["xcustom:::a", "shared"],
                    ["xcustom:::b", "shared"],
                    ["xcustom:::c", undefined],
                ] as const
            ).map(([aiModel, credentialId]) =>
                run({
                    settings: withNamed(base(aiModel, credentialId), entries),
                    arg: prompt(),
                    upstream: () => chat("custom"),
                }),
            ),
        );
        expect(runs.map((recorded) => headersOf(recorded)[0].authorization)).toEqual([
            `Bearer ${NAMED.work}`,
            `Bearer ${NAMED.work}`,
            // `c`'s profile binds nothing, and a custom model has no flat default key (O2).
            "Bearer ",
        ]);
        expect(wireOf(runs[2])).not.toContain(SECRETS.openAIKey);
        expect(runs.map((recorded) => recorded.calls[0].url)).toEqual(
            Array(3).fill("https://custom.test/v1/chat/completions"),
        );
    });

    it("a reverse proxy binds on its profile; an unbound reverse proxy sends no key", async () => {
        const entries = [
            { id: "work", type: "custom", key: NAMED.work },
            { id: "home", type: "custom", key: NAMED.home },
        ];
        const bound = await run({
            settings: withNamed({ preset: { credentialId: "work" } }, entries),
            arg: prompt(),
            upstream: () => chat("proxied"),
        });
        expect(bound.calls.map((call) => [call.url, call.headers.authorization])).toEqual([
            [PROVIDER, `Bearer ${NAMED.work}`],
        ]);
        expect(wireOf(bound)).not.toContain(SECRETS.proxyKey);

        // A reverse proxy has no flat default key (`docs/plan/model-profiles.md` O2).
        const unbound = await run({
            settings: withNamed({ preset: { credentialId: undefined } }, entries),
            arg: prompt(),
            upstream: () => chat("proxied"),
        });
        expect(headersOf(unbound).map((headers) => headers.authorization)).toEqual(["Bearer "]);
        for (const secret of [SECRETS.proxyKey, SECRETS.openAIKey, NAMED.work, NAMED.home]) {
            expect(wireOf(unbound)).not.toContain(secret);
        }
    });

    it("a keyIdentifier model takes a bound key, else its OaiCompAPIKeys entry, and never falls back to the OpenAI key", async () => {
        const deepseek = (settings: Settings) =>
            run({
                settings: { ...settings, preset: { ...settings.preset, aiModel: "deepseek-v4-flash" } },
                arg: prompt(),
                upstream: () => chat("deep"),
            });
        const bound = await deepseek(
            withNamed({ preset: { credentialId: "work" }, secrets: { OaiCompAPIKeys: { deepseek: "ds-stored" } } }, [
                { id: "work", type: "custom", key: NAMED.work },
            ]),
        );
        const stored = await deepseek({ secrets: { OaiCompAPIKeys: { deepseek: "ds-stored" } } });
        const missing = await deepseek({});
        expect([bound, stored, missing].map((recorded) => headersOf(recorded)[0].authorization)).toEqual([
            `Bearer ${NAMED.work}`,
            "Bearer ds-stored",
            // No entry: an empty key, never another provider's.
            "Bearer ",
        ]);
        for (const recorded of [bound, stored, missing]) {
            expect(recorded.calls[0].url).toBe("https://api.deepseek.com/beta/chat/completions");
            expect(wireOf(recorded)).not.toContain(SECRETS.openAIKey);
        }
    });

    it("Ollama cloud sends a bound key to ollama.com instead of the stored Ollama key", async () => {
        const recorded = await run({
            settings: withNamed(
                {
                    // The Ollama fields are profile fields (`docs/plan/model-profiles.md` O7).
                    preset: {
                        aiModel: "ollama-cloud",
                        credentialId: "work",
                        ollamaRequestFormat: LLMFormat.OpenAICompatible,
                        ollamaCloudModel: "gpt-oss:120b",
                    },
                    secrets: { ollamaApiKey: "ollama-stored" },
                },
                [{ id: "work", type: "ollama", key: NAMED.work }],
            ),
            arg: prompt(),
            upstream: () => chat("cloud"),
        });
        expect(recorded.calls.map((call) => [call.url, call.headers.authorization])).toEqual([
            ["https://ollama.com/v1/chat/completions", `Bearer ${NAMED.work}`],
        ]);
        expect(wireOf(recorded)).not.toContain("ollama-stored");
    });

    it("Bedrock signs with a bound composite key and takes its region", async () => {
        const recorded = await run({
            settings: withNamed(
                {
                    preset: { aiModel: "anthropic.claude-opus-4-6-v1", credentialId: "aws" },
                    secrets: { claudeAPIKey: SECRETS.bedrock },
                },
                [{ id: "aws", type: "bedrock", key: NAMED.bedrock }],
            ),
            arg: { ...prompt(), useStreaming: false },
            upstream: () => json({ content: [{ type: "text", text: "from bedrock" }] }),
        });
        expect(recorded.calls).toHaveLength(1);
        expect(recorded.calls[0].url).toBe(
            "https://bedrock-runtime.us-west-2.amazonaws.com/model/global.anthropic.claude-opus-4-6-v1/invoke",
        );
        expect(recorded.calls[0].headers.authorization).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIANAMED\/20261001\/us-west-2\//,
        );
        expect(wireOf(recorded)).not.toContain("AKIAEXAMPLE");
        expect(wireOf(recorded)).not.toContain("named-bedrock-SENTINEL");
    });

    it("Vertex logs in with a bound service account and sends to its project, else to the global project", async () => {
        const vertex = (projectId?: string) =>
            run({
                settings: withNamed(
                    {
                        preset: { aiModel: "gemini-2.5-flash-vertex", credentialId: "sa" },
                        providers: { vertexRegion: "us-central1" },
                        secrets: {
                            vertexClientEmail: "svc@proj.iam.gserviceaccount.com",
                            vertexPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
                        },
                    },
                    [
                        {
                            id: "sa",
                            type: "vertex",
                            key: NAMED.vertexKey,
                            clientEmail: "named@proj-2.iam.gserviceaccount.com",
                            ...(projectId ? { projectId } : {}),
                        },
                    ],
                ),
                arg: { ...prompt(), useStreaming: false },
                upstream: () => json({ candidates: [{ content: { parts: [{ text: "vertex says" }] } }] }),
            });
        const own = await vertex("proj-2");
        expect(vertexLogins).toEqual([["named@proj-2.iam.gserviceaccount.com", NAMED.vertexKey]]);
        expect(own.calls.map((call) => [call.url, call.headers.authorization])).toEqual([
            [
                "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-2/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
                `Bearer ${SECRETS.vertexToken}`,
            ],
        ]);
        const global = await vertex();
        expect(vertexLogins).toEqual([["named@proj-2.iam.gserviceaccount.com", NAMED.vertexKey]]);
        expect(global.calls[0].url).toContain("/projects/proj-1/");
    });

    it("refuses a binding it cannot honor, without an upstream call, a retry, or the default key", async () => {
        const refusal = async (settings: Settings) => {
            const recorded = await run({ settings, arg: prompt(), upstream: () => chat("must not run") });
            expect(recorded.calls).toEqual([]);
            const result = recorded.result as { type: string; noRetry?: boolean; result: string };
            expect(result).toMatchObject({ type: "fail", noRetry: true });
            for (const secret of [...Object.values(NAMED), SECRETS.openAIKey, SECRETS.claudeAPIKey]) {
                expect(result.result).not.toContain(secret);
            }
            return result.result;
        };
        const gpt = (credentialId: string) => ({ preset: { aiModel: "gpt-5.5", credentialId } });
        expect(await refusal(withNamed(gpt("gone"), []))).toContain("no longer exists");
        expect(await refusal(withNamed(gpt("work"), [{ id: "work", type: "openai" }]))).toContain("has no key");
        expect(await refusal(withNamed(gpt("work"), [{ id: "work", type: "anthropic", key: NAMED.work }]))).toContain(
            "not accepted",
        );
        expect(
            await refusal(
                withNamed({ preset: { aiModel: "gemini-2.5-flash-vertex", credentialId: "sa" } }, [
                    { id: "sa", type: "vertex", key: NAMED.vertexKey },
                ]),
            ),
        ).toContain("no client email");
        expect(
            await refusal(
                withNamed({ preset: { aiModel: "mancer", credentialId: "work" } }, [
                    { id: "work", type: "custom", key: NAMED.work },
                ]),
            ),
        ).toContain("does not accept");
        // The message names the model and the credential, never its key.
        expect(await refusal(withNamed(gpt("work"), [{ id: "work", type: "anthropic", key: NAMED.work }]))).toMatch(
            /gpt-5\.5.*Key work/,
        );
        // A reverse proxy and a custom model refuse the same way.
        await refusal(withNamed({ preset: { credentialId: "gone" } }, []));
    });
});

// `docs/plan/model-profiles.md`: each slot's profile chooses the model, the key, the endpoint, and
// the compatibility options of its own request.
describe("model profiles", () => {
    const OPENAI = "https://api.openai.com/v1/chat/completions";
    const failure = (recorded: Recorded) => {
        expect(recorded.calls).toEqual([]);
        expect(recorded.result).toMatchObject({ type: "fail", noRetry: true });
        return (recorded.result as { result: string }).result;
    };
    const summaryOf = (recorded: Recorded) =>
        recorded.calls.map((call) => [call.url, call.headers.authorization, (call.body as { model: string }).model]);

    it("sends one model id from two profiles with two keys: the main request and the memory request", async () => {
        const settings = withNamed(
            {
                model: {
                    preset: {
                        mainSlot: { profileId: "chat" },
                        subSlot: { profileId: "chat" },
                        seperateModelsForAxModels: true,
                        auxSlots: { memory: { profileId: "summary" } },
                    },
                    profiles: [
                        { id: "chat", modelId: "gpt-5.5", credentialId: "work" },
                        { id: "summary", modelId: "gpt-5.5", credentialId: "home" },
                    ],
                },
            },
            [
                { id: "work", type: "openai", key: NAMED.work },
                { id: "home", type: "custom", key: NAMED.home },
            ],
        );
        const main = await run({ settings, arg: prompt(), upstream: () => chat("main") });
        const memory = await run({ settings, arg: prompt(), mode: "memory", upstream: () => chat("memory") });
        const emotion = await run({ settings, arg: prompt(), mode: "emotion", upstream: () => chat("emotion") });
        expect(summaryOf(main)).toEqual([[OPENAI, `Bearer ${NAMED.work}`, "gpt-5.5"]]);
        expect(summaryOf(memory)).toEqual([[OPENAI, `Bearer ${NAMED.home}`, "gpt-5.5"]]);
        // An unset auxiliary slot uses the sub slot.
        expect(summaryOf(emotion)).toEqual([[OPENAI, `Bearer ${NAMED.work}`, "gpt-5.5"]]);
    });

    it("sends an auxiliary reverse proxy to its own URL with its own key, beside a main proxy on another URL", async () => {
        const proxy = (id: string, url: string, requestModel: string, credentialId: string) => ({
            id,
            modelId: "reverse_proxy",
            forceReplaceUrl: url,
            customProxyRequestModel: requestModel,
            customAPIFormat: LLMFormat.OpenAICompatible,
            credentialId,
        });
        const settings = withNamed(
            {
                model: {
                    preset: {
                        mainSlot: { profileId: "main" },
                        subSlot: { profileId: "main" },
                        seperateModelsForAxModels: true,
                        auxSlots: { translate: { profileId: "aux" } },
                    },
                    profiles: [
                        proxy("main", "https://main.test/v1/chat/completions", "main-model", "work"),
                        proxy("aux", "https://aux.test/v1/chat/completions", "aux-model", "home"),
                    ],
                },
            },
            [
                { id: "work", type: "custom", key: NAMED.work },
                { id: "home", type: "custom", key: NAMED.home },
            ],
        );
        const main = await run({ settings, arg: prompt(), upstream: () => chat("main") });
        const translate = await run({ settings, arg: prompt(), mode: "translate", upstream: () => chat("aux") });
        expect(summaryOf(main)).toEqual([
            ["https://main.test/v1/chat/completions", `Bearer ${NAMED.work}`, "main-model"],
        ]);
        expect(summaryOf(translate)).toEqual([
            ["https://aux.test/v1/chat/completions", `Bearer ${NAMED.home}`, "aux-model"],
        ]);
        expect(wireOf(translate)).not.toContain("main.test");
    });

    it("applies an auxiliary profile's custom flags and system replacement to its request only", async () => {
        const settings: Settings = {
            model: {
                preset: {
                    mainSlot: { profileId: "main" },
                    subSlot: { profileId: "main" },
                    seperateModelsForAxModels: true,
                    auxSlots: { emotion: { profileId: "plain" } },
                },
                profiles: [
                    { id: "main", modelId: "gpt-5.5" },
                    // No flags: the model loses its full system prompt support for this profile.
                    {
                        id: "plain",
                        modelId: "gpt-5.5",
                        enableCustomFlags: true,
                        customFlags: [],
                        systemContentReplacement: "[{{slot}}]",
                    },
                ],
            },
        };
        const firstMessage = (recorded: Recorded) => (recorded.calls[0].body as { messages: unknown[] }).messages[0];
        const main = await run({ settings, arg: prompt(), upstream: () => chat("main") });
        const emotion = await run({ settings, arg: prompt(), mode: "emotion", upstream: () => chat("emotion") });
        // GPT-5.5 sends its full system prompt as the developer turn.
        expect(firstMessage(main)).toEqual({ role: "developer", content: "Be brief." });
        expect(firstMessage(emotion)).toEqual({ role: "user", content: "[Be brief.]" });
    });

    it("refuses a missing profile and a missing key, each without an upstream call", async () => {
        const settings = withNamed(
            {
                model: {
                    preset: {
                        mainSlot: { profileId: "gone" },
                        subSlot: { profileId: "keyless" },
                        seperateModelsForAxModels: true,
                        auxSlots: { otherAx: { profileId: "gone-too" } },
                    },
                    profiles: [{ id: "keyless", modelId: "gpt-5.5", credentialId: "deleted-key" }],
                },
            },
            [],
        );
        const upstream = () => chat("must not run");
        expect(failure(await run({ settings, arg: prompt(), upstream }))).toContain("model profile no longer exists");
        expect(failure(await run({ settings, arg: prompt(), mode: "otherAx", upstream }))).toContain(
            "model profile no longer exists",
        );
        const keyless = failure(await run({ settings, arg: prompt(), mode: "submodel", upstream }));
        expect(keyless).toContain("credential no longer exists");
        expect(keyless).not.toContain(SECRETS.openAIKey);
    });

    it("uses the main profile for a matching static model, and no profile otherwise (O5)", async () => {
        const settings = withNamed(
            {
                model: {
                    preset: { mainSlot: { profileId: "main" }, subSlot: { profileId: "main" } },
                    profiles: [{ id: "main", modelId: "gpt-5.5", credentialId: "work" }],
                },
            },
            [{ id: "work", type: "openai", key: NAMED.work }],
        );
        const matching = await run({
            settings,
            arg: { ...prompt(), staticModel: "gpt-5.5" },
            upstream: () => chat("a"),
        });
        expect(summaryOf(matching)).toEqual([[OPENAI, `Bearer ${NAMED.work}`, "gpt-5.5"]]);

        // A main proxy profile lends neither its URL nor its key to another static model.
        const proxied = withNamed(
            {
                model: {
                    preset: { mainSlot: { profileId: "main" }, subSlot: { profileId: "main" } },
                    profiles: [
                        {
                            id: "main",
                            modelId: "reverse_proxy",
                            forceReplaceUrl: "https://main.test/v1/chat/completions",
                            customAPIFormat: LLMFormat.OpenAICompatible,
                            credentialId: "work",
                        },
                    ],
                },
            },
            [{ id: "work", type: "custom", key: NAMED.work }],
        );
        const other = await run({
            settings: proxied,
            arg: { ...prompt(), staticModel: "gpt-5.4" },
            upstream: () => chat("b"),
        });
        expect(summaryOf(other)).toEqual([[OPENAI, `Bearer ${SECRETS.openAIKey}`, "gpt-5.4"]]);
        // A definition that needs a profile refuses as a static model.
        const custom = await run({
            settings: proxied,
            arg: { ...prompt(), staticModel: "xcustom:::m1" },
            upstream: () => chat("c"),
        });
        expect(failure(custom)).toContain("without a model profile");
    });

    it("sends a bare auxiliary slot with the flat default key and default options, and refuses one that needs a profile", async () => {
        const settings: Settings = {
            model: {
                preset: {
                    mainSlot: { profileId: "main" },
                    subSlot: { profileId: "main" },
                    seperateModelsForAxModels: true,
                    auxSlots: { memory: { modelId: "gpt-5.5" }, translate: { modelId: "openrouter" } },
                },
                profiles: [
                    {
                        id: "main",
                        modelId: "reverse_proxy",
                        forceReplaceUrl: PROVIDER,
                        customAPIFormat: LLMFormat.OpenAICompatible,
                        credentialId: PROXY_CREDENTIAL.id,
                        enableCustomFlags: true,
                        customFlags: [],
                    },
                ],
            },
        };
        const memory = await run({ settings, arg: prompt(), mode: "memory", upstream: () => chat("bare") });
        expect(summaryOf(memory)).toEqual([[OPENAI, `Bearer ${SECRETS.openAIKey}`, "gpt-5.5"]]);
        // The main profile's empty custom flags do not reach the bare slot.
        expect((memory.calls[0].body as { messages: unknown[] }).messages[0]).toEqual({
            role: "developer",
            content: "Be brief.",
        });
        expect(wireOf(memory)).not.toContain(SECRETS.proxyKey);
        const translate = await run({ settings, arg: prompt(), mode: "translate", upstream: () => chat("x") });
        expect(failure(translate)).toContain('"openrouter" without a model profile');
    });
});
