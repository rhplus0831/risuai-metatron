// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { LLMFlags, LLMFormat, type LLMModel, LLMProvider, LLMTokenizer } from "../../../shared/llm.ts";
import type {
    LlmRequestBody,
    LlmRequestEvent,
    RequestSource,
    RPCToolCallContent,
    StreamResponseChunk,
    ToolCallRecord,
    ToolDescriptor,
} from "../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import { type CallbackResult, MAX_PROVIDER_TEXT_CHARS } from "../../../shared/jobs.ts";
import { failureOf } from "../jobs/generationJobs.ts";
import {
    createLlmRequests,
    JobRequestError,
    type JobRequestSpec,
    MAX_REQUESTS_PER_CLIENT,
    type LlmRequestsOptions,
    type RequestObserver,
} from "../llm/requests.ts";
import type { requestDataResponse } from "../llm/request.ts";
import { messages } from "../llm/messages.ts";
import { loadRequestDb, tokenScopeFor } from "../llm/settings.ts";
import { watchFirstByte } from "../llm/transport.ts";
import { sleep, waitFor } from "./testSupport.ts";

// Phase 5 slice 7a: the live requests of `POST /api/llm/request` (`server/src/llm/requests.ts`)
// over a fake store and a recording upstream, with the real ported adapters. The SSE grammar and
// its one terminal; the callback leg (`mcpTool`, `cbs`: ownership, duplicates, deadlines, a failed
// parse ending the request); the lifecycle (pre-aborted admission, an abort mid-stream, the
// per-client cap, maintenance, shutdown); the child interceptor's refusal and failure taxonomy; the
// secret-free projection (field by field, protocol intact, a short credential, content the tab
// must get unaltered refused instead); the warmer fence; local Ollama and a real Node WebSocket
// to an OobaLegacy upstream. The HTTP routes are in `llmRoutes.test.ts`.

const SECRET = "sk-proxy-SENTINEL-1111";
const PROVIDER = "https://mock.test/v1/chat/completions";
/** A request id as the layer makes them (`randomUUID`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Records = Record<string, unknown> & {
    characters?: Record<string, unknown>;
    /** The chats by `<characterId>/<chatId>`: their binding fields (`docs/plan/chat-binding.md`). */
    chats?: Record<string, Record<string, unknown>>;
};

/**
 * The settings records. `overrides.preset` mixes the prompt preset's fields and the profile's
 * (`aiModel` is its `modelId`): each normalizer keeps its own (`docs/plan/split-preset.md`,
 * `docs/plan/model-profiles.md`), so the prompt preset `p` and the profile `main` (both slots of
 * the model preset `m`) split it. A reverse proxy has no flat default key (O2): the `reverse_proxy`
 * profile binds the named key `proxy` (`overrides.proxyKey`, else `SECRET`) unless the preset
 * names its own `credentialId`.
 */
function makeRecords(
    overrides: { preset?: Record<string, unknown>; secrets?: Record<string, unknown>; proxyKey?: string } = {},
): Records {
    const { aiModel = "reverse_proxy", ...fields } = overrides.preset ?? {};
    return {
        providers: normalizeProviders({}),
        llmSecrets: normalizeLlmSecrets({
            credentials: { proxy: { key: overrides.proxyKey ?? SECRET } },
            ...overrides.secrets,
        }),
        ui: { autoSuggestPrefix: "" },
        customModels: [],
        credentials: [{ id: "proxy", name: "Proxy key", type: "custom" }],
        presets: normalizePresets([{ id: "p", name: "p", ...overrides.preset }]),
        modelProfiles: normalizeModelProfiles([
            {
                id: "main",
                name: "main",
                forceReplaceUrl: PROVIDER,
                customProxyRequestModel: "mock-model",
                customAPIFormat: LLMFormat.OpenAICompatible,
                ...(aiModel === "reverse_proxy" && !("credentialId" in fields) ? { credentialId: "proxy" } : {}),
                ...fields,
                modelId: aiModel,
            },
        ]),
        modelPresets: normalizeModelPresets([
            { id: "m", name: "m", mainSlot: { profileId: "main" }, subSlot: { profileId: "main" } },
        ]),
        personas: normalizePersonas([
            { id: "u", name: "Uma" },
            { id: "b", name: "Bound" },
        ]),
        characters: { c: { chaId: "c", name: "Cara" }, s: { chaId: "s", name: "Speaker" } },
        // Chat `k` is bound to the ids `body()` sends; `loose` has no binding.
        chats: {
            "c/k": { modelPresetId: "m", promptPresetId: "p", bindedPersona: "u" },
            "c/loose": {},
        },
    };
}

function fakeStore(records: Records): ResourceStore {
    return {
        readRefs: (refs: { kind: { name: string }; id: string }[]) => ({
            items: refs.map((ref) => ({
                kind: ref.kind.name,
                id: ref.id,
                revision: null,
                data:
                    ref.kind.name === "characters"
                        ? (records.characters?.[ref.id] ?? null)
                        : (records[ref.kind.name] ?? null),
            })),
        }),
        chatSummary: (characterId: string, id: string) => {
            const chat = records.chats?.[`${characterId}/${id}`];
            return chat ? { characterId, id, revision: "r1", name: id, fmIndex: -1, ...chat } : null;
        },
    } as unknown as ResourceStore;
}

const kinds = { get: (name: string) => ({ name }) } as unknown as ResourceKindRegistry;

/** The targets of the job a `channelCall` names: chat `k` with the ids `body()` sends. */
const JOB_TARGETS = { chatRef: { chaId: "c", chatId: "k" }, presetId: "p", modelPresetId: "m", personaId: "u" };

/** A job's tool set that offers nothing (slice 12a): no descriptors, so a call is never legitimate. */
function noTools(): JobRequestSpec["tools"] {
    return {
        descriptors: [],
        charge: () => true,
        limit: 64,
        call: async (name) => {
            throw new Error(`no tool is offered: ${name}`);
        },
    };
}

function body(arg: Record<string, unknown> = {}, extra: Partial<LlmRequestBody> = {}): LlmRequestBody {
    return {
        clientId: "client-a",
        mode: "model",
        context: {
            presetId: "p",
            modelPresetId: "m",
            personaId: "u",
            selectedPersonaId: "u",
            selectedCharacterId: "c",
            speakerId: null,
            mainModel: { imageInput: false },
            tokenizer: {
                aiModel: "reverse_proxy",
                currentPluginProvider: "",
                modelTokenizer: 1,
                pluginTokenizer: "none",
                customTokenizer: "",
                googleClaudeTokenizing: false,
                useTokenizerCaching: false,
            },
        },
        arg: { formated: [{ role: "user", content: "hi" }], bias: {}, useStreaming: false, ...arg },
        tools: [],
        toolRecords: {},
        ...extra,
    };
}

type Upstream = { url: string; method: string; headers: Record<string, string>; body: string; signal: AbortSignal };

/** A registry over `records` whose upstream is `respond` (recorded in `calls`). */
function harness(
    records: Records,
    respond: (call: Upstream, index: number) => Response | Promise<Response>,
    options: Partial<LlmRequestsOptions> = {},
) {
    const calls: Upstream[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const call: Upstream = {
            url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
            method: init.method ?? "GET",
            headers: Object.fromEntries(new Headers(init.headers as Record<string, string>)),
            body:
                typeof init.body === "string"
                    ? init.body
                    : init.body
                      ? new TextDecoder().decode(init.body as Uint8Array)
                      : "",
            signal: init.signal as AbortSignal,
        };
        calls.push(call);
        if (call.signal?.aborted) {
            // As `fetch` does with an already-aborted signal.
            throw new DOMException("This operation was aborted", "AbortError");
        }
        return await respond(call, calls.length - 1);
    }) as typeof fetch;
    const registry = createLlmRequests({
        store: fakeStore(records),
        kinds,
        tokens: { encode: async () => [7], count: async () => 1 } as never,
        vertexTokens: { get: async () => "vertex-token", clear() {} } as never,
        claudeObserver: { register() {}, reset() {}, dispose() {} } as never,
        parentCallback: () => null,
        fetchImpl,
        ...options,
    });
    return { registry, calls };
}

/** Runs one request to its end; `onEvent` can answer callbacks through the registry. */
async function run(
    registry: ReturnType<typeof createLlmRequests>,
    request: LlmRequestBody,
    onEvent?: (event: LlmRequestEvent, requestId: string) => void | Promise<void>,
    signal = new AbortController().signal,
) {
    const started = registry.start(request, signal);
    if (!started.ok) {
        throw new Error(`start refused: ${started.status} ${started.error}`);
    }
    const events = await readAll(started.stream, (event) => onEvent?.(event, started.id));
    return { id: started.id, events, raw: JSON.stringify(events) };
}

async function readAll(
    stream: ReadableStream<Uint8Array>,
    onEvent?: (event: LlmRequestEvent) => void | Promise<void>,
): Promise<LlmRequestEvent[]> {
    const events: LlmRequestEvent[] = [];
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            expect(frame.startsWith("data: ")).toBe(true);
            const event = JSON.parse(frame.slice("data: ".length)) as LlmRequestEvent;
            events.push(event);
            await onEvent?.(event);
        }
    }
    return events;
}

const types = (events: LlmRequestEvent[]) => events.map((event) => event.type);
const terminal = (events: LlmRequestEvent[]) =>
    events.filter((event) => event.type === "result" || event.type === "end" || event.type === "error");
const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const chat = (content: string, extra: Record<string, unknown> = {}) =>
    json({ choices: [{ message: { role: "assistant", content, ...extra } }] });
/** An SSE upstream body; with `signal` it errors when the fetch is aborted, as a socket would. */
const sse = (frames: string[], delayMs = 0, signal?: AbortSignal) =>
    new Response(
        new ReadableStream<Uint8Array>({
            async start(controller) {
                let ended = false;
                let wake = () => {};
                signal?.addEventListener("abort", () => {
                    if (!ended) {
                        ended = true;
                        controller.error(new DOMException("aborted", "AbortError"));
                        wake();
                    }
                });
                for (const frame of frames) {
                    if (ended) {
                        return;
                    }
                    controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
                    if (delayMs) {
                        await Promise.race([sleep(delayMs), new Promise<void>((resolve) => (wake = resolve))]);
                    }
                }
                if (!ended) {
                    ended = true;
                    controller.close();
                }
            },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
    );
/** Whether the upstream request is the follow-up after a tool result (the tool tests answer it differently). */
const afterTool = (call: Upstream) =>
    (JSON.parse(call.body).messages as { role: string }[]).some((message) => message.role === "tool");
const answer = (
    registry: ReturnType<typeof createLlmRequests>,
    id: string,
    callbackId: string,
    value: unknown,
    clientId = "client-a",
) => registry.answer(id, clientId, { callbackId, outcome: "answered", value });

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("a buffered request", () => {
    it("reads the profile's model and its bound proxy key, logs the upstream call with its credential masked, and answers one result", async () => {
        const { registry, calls } = harness(makeRecords(), () => chat("plain answer"));
        const { events, raw } = await run(registry, body());
        expect(types(events)).toEqual(["accepted", "log", "result"]);
        expect(terminal(events)).toEqual([{ type: "result", response: { type: "success", result: "plain answer" } }]);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(PROVIDER);
        expect(calls[0].headers.authorization).toBe(`Bearer ${SECRET}`);
        expect(JSON.parse(calls[0].body)).toMatchObject({
            model: "mock-model",
            messages: [{ role: "user", content: "hi" }],
        });
        const log = events.find((event) => event.type === "log") as { entry: Record<string, string> };
        expect(JSON.parse(log.entry.header)).toMatchObject({ Authorization: "[redacted]" });
        expect(log.entry.url).toBe(PROVIDER);
        expect(raw).not.toContain(SECRET);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("sends a model's answer as it is (recorded: success text is not redacted) but redacts a fail result and a preview", async () => {
        const { registry } = harness(makeRecords(), (_call, index) =>
            index === 1 ? json({ error: { message: `bad key ${SECRET}` } }, 401) : chat(`echo ${SECRET}`),
        );
        const success = await run(registry, body());
        expect(terminal(success.events)[0]).toEqual({
            type: "result",
            response: { type: "success", result: `echo ${SECRET}` },
        });
        const failed = await run(registry, body());
        const fail = terminal(failed.events)[0] as { response: { type: string; result: string } };
        expect(fail.response.type).toBe("fail");
        expect(fail.response.result).toContain("[redacted]");
        expect(failed.raw).not.toContain(SECRET);
        const preview = await run(registry, body({ previewBody: true }));
        const previewResult = (terminal(preview.events)[0] as { response: { result: string } }).response.result;
        expect(JSON.parse(previewResult)).toMatchObject({
            url: PROVIDER,
            headers: { Authorization: "Bearer [redacted]" },
        });
        expect(preview.raw).not.toContain(SECRET);
        await registry.dispose();
    });

    it("answers a missing preset or persona as a fail result that is not retried, never a redirect to another record", async () => {
        const { registry, calls } = harness(makeRecords(), () => chat("x"));
        const gone = await run(registry, { ...body(), context: { ...body().context, presetId: "missing" } });
        expect(terminal(gone.events)).toEqual([
            {
                type: "result",
                response: { type: "fail", result: "The request's preset no longer exists", noRetry: true },
            },
        ]);
        const persona = await run(registry, { ...body(), context: { ...body().context, personaId: "missing" } });
        expect((terminal(persona.events)[0] as { response: { result: string } }).response.result).toContain("persona");
        expect(calls).toHaveLength(0);
        await registry.dispose();
    });

    it("names the tab's selected character for the prompt and the replying character for Ollama's unstringlize, from the ids sent", async () => {
        // The Ollama fields are profile fields (`docs/plan/model-profiles.md` O7).
        const records = makeRecords({
            preset: { aiModel: "ollama-hosted", ollamaURL: "http://ollama.test", ollamaModel: "llama" },
        });
        const realFetch = globalThis.fetch;
        const seen: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
            return json({ message: { content: "trimmed answer\nSpeaker: a second turn" }, done: true });
        }) as typeof fetch;
        try {
            const { registry } = harness(records, () => chat("x"));
            const { events } = await run(registry, {
                ...body(),
                context: { ...body().context, speakerId: "s" },
            });
            // `unstringlizeChat` cuts the answer where the replying character speaks again, as the client did with `arg.currentChar`.
            expect(terminal(events)[0]).toEqual({
                type: "result",
                response: { type: "success", result: "trimmed answer", model: "ollama-hosted" },
            });
            expect(seen.map((url) => new URL(url).pathname)).toEqual(["/api/chat"]);
            await registry.dispose();
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it("refuses a Plugin or WebLLM model (they run in the tab) without a retry", async () => {
        const { registry, calls } = harness(makeRecords({ preset: { aiModel: "custom" } }), () => chat("x"));
        const { events } = await run(registry, body());
        expect(terminal(events)).toEqual([
            {
                type: "result",
                response: {
                    type: "fail",
                    result: "Plugin Legacy runs in the browser, not on the server.",
                    noRetry: true,
                },
            },
        ]);
        expect(calls).toHaveLength(0);
        await registry.dispose();
    });

    it("uses a dynamic model's descriptor only for the id the preset names and only for a server format", async () => {
        const dynamic = {
            id: "dynamic_google_gemini-x",
            name: "Gemini X",
            shortName: "Gemini X",
            fullName: "Gemini X",
            internalID: "gemini-x",
            provider: 2,
            format: LLMFormat.OpenAICompatible,
            flags: [],
            parameters: ["temperature"],
            tokenizer: 0,
        };
        const records = makeRecords({ preset: { aiModel: "dynamic_google_gemini-x" } });
        const { registry, calls } = harness(records, () => chat("dyn"));
        await run(registry, body({}, { dynamicModel: { ...dynamic, format: LLMFormat.Plugin } as never }));
        // A Plugin hint is ignored: the id resolves as an unknown OpenAI-compatible model and reaches the provider.
        expect(calls).toHaveLength(1);
        await run(registry, body({}, { dynamicModel: { ...dynamic, id: "other" } as never }));
        expect(calls).toHaveLength(2);
        expect(JSON.parse(calls[1].body).model).toBe("dynamic_google_gemini-x");
        await run(registry, body({}, { dynamicModel: dynamic as never }));
        expect(JSON.parse(calls[2].body).model).toBe("gemini-x");
        await registry.dispose();
    });
});

describe("a streaming request", () => {
    it("announces `streaming`, sends each cumulative change as a suffix append, and ends with exactly one `end`", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        const { registry } = harness(records, () =>
            sse(
                ["Hel", "lo ", "wor", "ld"]
                    .map((part) => JSON.stringify({ choices: [{ delta: { content: part } }] }))
                    .concat("[DONE]"),
            ),
        );
        const { events } = await run(registry, body({ useStreaming: true }));
        expect(events[0]).toEqual({ type: "accepted", id: expect.any(String) });
        expect(types(events).filter((type) => type !== "log")).toEqual([
            "accepted",
            "streaming",
            "chunk",
            "chunk",
            "chunk",
            "chunk",
            "end",
        ]);
        const chunks = events.filter((event) => event.type === "chunk") as {
            set?: Record<string, string>;
            append?: Record<string, string>;
        }[];
        expect(chunks[0]).toEqual({ type: "chunk", set: { "0": "Hel" } });
        expect(chunks.slice(1)).toEqual([
            { type: "chunk", append: { "0": "lo " } },
            { type: "chunk", append: { "0": "wor" } },
            { type: "chunk", append: { "0": "ld" } },
        ]);
        expect(terminal(events)).toHaveLength(1);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("redacts a provider error the adapter put into the answer text (Responses API), keeping the answer-text representation", async () => {
        const records = makeRecords({ preset: { customAPIFormat: LLMFormat.OpenAIResponseAPI } });
        (records.providers as Record<string, unknown>).useStreaming = true;
        const { registry } = harness(records, () =>
            sse([JSON.stringify({ type: "response.failed", error: { message: `Invalid API key ${SECRET}` } })]),
        );
        const { events, raw } = await run(registry, body({ useStreaming: true }));
        const set = (events.find((event) => event.type === "chunk") as { set: Record<string, string> }).set;
        expect(set["0"]).toContain("Invalid API key [redacted]");
        expect(raw).not.toContain(SECRET);
        expect(types(events).at(-1)).toBe("end");
        await registry.dispose();
    });

    it("ends a stream whose upstream fails after it began with one `error` terminal", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        const { registry } = harness(
            records,
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        async start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`,
                                ),
                            );
                            await sleep(30);
                            controller.error(new Error(`socket reset by ${SECRET}`));
                        },
                    }),
                    { status: 200, headers: { "content-type": "text/event-stream" } },
                ),
        );
        const { events, raw } = await run(registry, body({ useStreaming: true }));
        expect(types(events).filter((type) => type !== "log")).toEqual(["accepted", "streaming", "chunk", "error"]);
        expect(raw).not.toContain(SECRET);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });
});

describe("the callback leg", () => {
    const tools = [{ name: "rollDice", description: "roll", inputSchema: { type: "object" } }];
    const toolCall = (id = "call_1", args: unknown = { sides: 6 }) =>
        chat("", {
            tool_calls: [{ id, type: "function", function: { name: "rollDice", arguments: JSON.stringify(args) } }],
        });

    it("runs a tool through an `mcpTool` callback, sends the remembered record before the result, and ignores a repeated answer", async () => {
        const { registry, calls } = harness(makeRecords(), (call) => (afterTool(call) ? chat("rolled") : toolCall()));
        const results: string[] = [];
        const { events } = await run(registry, body({ rememberToolUsage: true }, { tools }), (event, id) => {
            if (event.type === "callback" && event.name === "mcpTool") {
                expect(event.payload).toEqual({ name: "rollDice", args: { sides: 6 } });
                results.push(answer(registry, id, event.id, [{ type: "text", text: "4" }]));
                results.push(answer(registry, id, event.id, [{ type: "text", text: "5" }]));
                results.push(answer(registry, id, "unknown-callback", []));
                results.push(answer(registry, id, event.id, [], "client-b"));
            }
        });
        expect(results).toEqual(["accepted", "ignored", "missing", "missing"]);
        expect(JSON.parse(calls[1].body).messages).toContainEqual({
            role: "tool",
            content: "4",
            tool_call_id: "call_1",
        });
        const sequence = types(events).filter((type) => type !== "log");
        expect(sequence.indexOf("toolRecord")).toBeLessThan(sequence.indexOf("result"));
        const record = (events.find((event) => event.type === "toolRecord") as { record: unknown }).record;
        // The OpenAI adapter remembers the arguments as the provider sent them: a JSON string.
        expect(record).toEqual({
            call: { id: "call_1", name: "rollDice", arg: '{"sides":6}' },
            response: [{ type: "text", text: "4" }],
        });
        expect(terminal(events)[0]).toMatchObject({ response: { type: "success" } });
        expect((terminal(events)[0] as { response: { result: string } }).response.result).toContain(
            "<tool_call>call_1rollDice</tool_call>",
        );
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("asks the tab to parse the interface schema and the extraction path in order, and fails the request when a `cbs` parse fails", async () => {
        const records = makeRecords({
            preset: {
                jsonSchemaEnabled: true,
                jsonSchema: "interface Answer {\n  answer: string\n}",
                extractJson: "{{getvar::path}}",
            },
        });
        const { registry } = harness(records, () => chat('{"answer":"forty-two"}'));
        const asked: string[] = [];
        const ok = await run(registry, body(), (event, id) => {
            if (event.type === "callback" && event.name === "cbs") {
                asked.push(event.payload.text);
                expect(event.payload.chatRef).toBeNull();
                answer(
                    registry,
                    id,
                    event.id,
                    event.payload.text === "{{getvar::path}}" ? "answer" : event.payload.text,
                );
            }
        });
        expect(asked[0]).toMatch(/^interface Answer/);
        expect(asked).toContain("{{getvar::path}}");
        expect(terminal(ok.events)[0]).toEqual({ type: "result", response: { type: "success", result: "forty-two" } });

        // The adapter's own catch would fall back to the raw text; the failure ends the request anyway.
        const failed = await run(registry, body(), (event, id) => {
            if (event.type === "callback" && event.name === "cbs" && event.payload.text === "{{getvar::path}}") {
                registry.answer(id, "client-a", { callbackId: event.id, outcome: "failed", error: "parser broke" });
            } else if (event.type === "callback" && event.name === "cbs") {
                answer(registry, id, event.id, event.payload.text);
            }
        });
        expect(terminal(failed.events)).toEqual([{ type: "error", message: "CBS: parser broke" }]);
        const malformed = await run(registry, body(), (event, id) => {
            if (event.type === "callback") {
                answer(registry, id, event.id, 42);
            }
        });
        expect(terminal(malformed.events)).toEqual([
            { type: "error", message: "The cbs callback answered a value that is not a string" },
        ]);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("sends the request's chat for a local stop string parse, and the selected chat is the tab's business", async () => {
        const records = makeRecords({
            preset: {
                aiModel: "ooba",
                localStopStrings: ["{{user}}:\\nend"],
                textgenWebUIBlockingURL: "https://ooba.test/api",
            },
        });
        const { registry, calls } = harness(records, () => json({ choices: [{ text: "done" }] }));
        const chatRef = { chaId: "c", chatId: "k" };
        const asked: unknown[] = [];
        await run(registry, body({ chatRef }), (event, id) => {
            if (event.type === "callback" && event.name === "cbs") {
                asked.push(event.payload);
                answer(registry, id, event.id, "Uma:\nend");
            }
        });
        expect(asked).toEqual([{ text: "{{user}}:\nend", chatRef }]);
        expect(JSON.parse(calls[0].body).stop).toEqual(["Uma:\nend"]);
        await registry.dispose();
    });

    it("ends the request when a callback is not answered by its absolute deadline, and treats an answer past it as late", async () => {
        let now = 1_000_000;
        const { registry } = harness(makeRecords(), (call) => (afterTool(call) ? chat("rolled") : toolCall()), {
            now: () => now,
        });
        // A late answer: the clock passed the deadline before the answer arrived (the timer did not fire yet).
        const late = await run(registry, body({}, { tools }), (event, id) => {
            if (event.type === "callback") {
                now += 60_001;
                expect(answer(registry, id, event.id, [{ type: "text", text: "4" }])).toBe("ignored");
            }
        });
        expect(terminal(late.events)).toEqual([
            { type: "error", message: "The client did not answer the mcpTool callback in time" },
        ]);

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const started = registry.start(body({}, { tools }), new AbortController().signal);
        expect(started.ok).toBe(true);
        const events = readAll((started as { stream: ReadableStream<Uint8Array> }).stream);
        await vi.advanceTimersByTimeAsync(10);
        expect(registry.liveIds()).toHaveLength(1);
        // The timer wakes early: the clock decides. At the deadline the request ends.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(registry.liveIds()).toHaveLength(1);
        now += 60_001;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(terminal(await events)).toEqual([
            { type: "error", message: "The client did not answer the mcpTool callback in time" },
        ]);
        expect(registry.liveIds()).toEqual([]);
        vi.useRealTimers();
        await registry.dispose();
    });

    it("refuses a callback payload or a remembered record that carries a stored credential instead of altering it", async () => {
        let variant: "key" | "id" = "key";
        const { registry, calls } = harness(makeRecords(), (call) =>
            afterTool(call)
                ? chat("x")
                : variant === "key"
                  ? toolCall("call_1", { [SECRET]: "value" })
                  : toolCall(SECRET, {}),
        );
        const key = await run(registry, body({ rememberToolUsage: true }, { tools }));
        expect(types(key.events)).not.toContain("callback");
        expect(terminal(key.events)).toEqual([
            {
                type: "error",
                message: "The mcpTool callback's payload carries a stored credential; it is not sent to the tab",
            },
        ]);
        expect(key.raw).not.toContain(SECRET);
        variant = "id";
        const id = await run(registry, body({ rememberToolUsage: true }, { tools }), (event, requestId) => {
            if (event.type === "callback") {
                answer(registry, requestId, event.id, [{ type: "text", text: "4" }]);
            }
        });
        expect(types(id.events)).not.toContain("toolRecord");
        expect(terminal(id.events)).toEqual([
            { type: "error", message: "A remembered tool call carries a stored credential; it is not sent to the tab" },
        ]);
        expect(id.raw).not.toContain(SECRET);
        // The record is refused after the tool ran and before the follow-up request: one upstream call each.
        expect(calls).toHaveLength(2);
        await registry.dispose();
    });

    it("keeps the event types, ids, names, and a clean tool record intact with a short stored credential", async () => {
        const { registry } = harness(makeRecords({ proxyKey: "q7" }), (call) =>
            afterTool(call) ? chat("done") : toolCall("call-1", { value: "input" }),
        );
        const { events } = await run(registry, body({ rememberToolUsage: true }, { tools }), (event, id) => {
            if (event.type === "callback") {
                expect(event.name).toBe("mcpTool");
                answer(registry, id, event.id, [{ type: "text", text: "hello" }]);
            }
        });
        expect(types(events).filter((type) => type !== "log")).toEqual([
            "accepted",
            "callback",
            "toolRecord",
            "result",
        ]);
        expect((events.find((event) => event.type === "toolRecord") as { record: unknown }).record).toEqual({
            call: { id: "call-1", name: "rollDice", arg: '{"value":"input"}' },
            response: [{ type: "text", text: "hello" }],
        });
        await registry.dispose();
    });
});

describe("the lifecycle", () => {
    it("refuses a request whose client was gone before admission, and registers nothing", async () => {
        const { registry, calls } = harness(makeRecords(), () => chat("x"));
        const controller = new AbortController();
        controller.abort();
        expect(registry.start(body(), controller.signal)).toEqual({
            ok: false,
            status: 400,
            error: "The client went away",
        });
        await sleep(5);
        expect(registry.liveIds()).toEqual([]);
        expect(calls).toHaveLength(0);
        await registry.dispose();
    });

    it("ends a request when its client goes away mid-stream: the upstream fetch is aborted, the entry removed, and nothing is delivered later", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        let upstreamSignal: AbortSignal | undefined;
        const { registry } = harness(records, (call) => {
            upstreamSignal = call.signal;
            return sse(
                ["Hel", "lo", "wor", "ld"].map((part) => JSON.stringify({ choices: [{ delta: { content: part } }] })),
                20,
                call.signal,
            );
        });
        const controller = new AbortController();
        const { events } = await run(
            registry,
            body({ useStreaming: true }),
            (event) => {
                if (event.type === "chunk") {
                    controller.abort();
                }
            },
            controller.signal,
        );
        expect(types(events).filter((type) => type !== "log")).toEqual(["accepted", "streaming", "chunk", "error"]);
        expect(terminal(events)).toEqual([{ type: "error", message: "The client went away" }]);
        expect(upstreamSignal?.aborted).toBe(true);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("ends a request whose stream the reader cancelled", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        let upstreamSignal: AbortSignal | undefined;
        const { registry } = harness(records, (call) => {
            upstreamSignal = call.signal;
            return sse([JSON.stringify({ choices: [{ delta: { content: "a" } }] })], 1000, call.signal);
        });
        const started = registry.start(body({ useStreaming: true }), new AbortController().signal);
        if (!started.ok) {
            throw new Error("not started");
        }
        const reader = started.stream.getReader();
        await reader.read();
        await reader.cancel();
        await waitFor(() => registry.liveIds().length === 0);
        expect(upstreamSignal?.aborted).toBe(true);
        await registry.dispose();
    });

    it("caps the live requests per client and refuses new ones during maintenance and after shutdown began", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        const { registry } = harness(records, (call) =>
            sse([JSON.stringify({ choices: [{ delta: { content: "a" } }] })], 5000, call.signal),
        );
        const started: ReadableStream<Uint8Array>[] = [];
        for (let i = 0; i < MAX_REQUESTS_PER_CLIENT; i++) {
            const result = registry.start(body({ useStreaming: true }), new AbortController().signal);
            expect(result.ok).toBe(true);
            started.push((result as { stream: ReadableStream<Uint8Array> }).stream);
        }
        expect(registry.start(body(), new AbortController().signal)).toMatchObject({ ok: false, status: 429 });
        expect(registry.start({ ...body(), clientId: "client-b" }, new AbortController().signal)).toMatchObject({
            ok: true,
        });
        expect(registry.liveIds()).toHaveLength(MAX_REQUESTS_PER_CLIENT + 1);

        registry.pause("The server data is being replaced");
        expect(registry.start(body(), new AbortController().signal)).toMatchObject({ ok: false, status: 503 });
        await waitFor(() => registry.liveIds().length === 0);
        for (const stream of started) {
            expect(terminal(await readAll(stream))).toEqual([
                { type: "error", message: "The server data is being replaced" },
            ]);
        }
        registry.resume();
        expect(registry.start(body(), new AbortController().signal)).toMatchObject({ ok: true });
        registry.beginShutdown();
        expect(registry.start(body(), new AbortController().signal)).toMatchObject({ ok: false, status: 503 });
        await registry.dispose();
        expect(registry.liveIds()).toEqual([]);
    });

    it("does not register the Claude warmer for a request that maintenance ended while its adapter was still preparing", async () => {
        const records = makeRecords({ preset: { customAPIFormat: LLMFormat.Anthropic } });
        (records.providers as Record<string, unknown>).claudeRetrivalCaching = true;
        const registrations: string[] = [];
        let paused = false;
        const { registry } = harness(records, () => json({ content: [{ type: "text", text: "claude" }] }), {
            claudeObserver: {
                register: () => registrations.push(paused ? "after pause" : "live"),
                reset: () => (paused = true),
                dispose() {},
            } as never,
        });
        const live = await run(registry, body());
        expect(terminal(live.events)[0]).toEqual({ type: "result", response: { type: "success", result: "claude" } });
        expect(registrations).toEqual(["live"]);
        const started = registry.start(body(), new AbortController().signal);
        registry.pause("maintenance");
        expect(started.ok).toBe(true);
        await readAll((started as { stream: ReadableStream<Uint8Array> }).stream);
        await sleep(10);
        expect(registrations).toEqual(["live"]);
        await registry.dispose();
    });

    it("aborts a local Ollama request with the request (buffered), with no late success and no live entry", async () => {
        const records = makeRecords({
            preset: { aiModel: "ollama-hosted", ollamaURL: "http://ollama.test", ollamaModel: "llama" },
        });
        const realFetch = globalThis.fetch;
        let upstreamSignal: AbortSignal | undefined;
        let release!: (response: Response) => void;
        globalThis.fetch = (async (_input: unknown, init: RequestInit = {}) => {
            upstreamSignal = init.signal as AbortSignal;
            return await new Promise<Response>((resolve, reject) => {
                release = resolve;
                upstreamSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
        }) as typeof fetch;
        try {
            const { registry } = harness(records, () => chat("x"));
            const controller = new AbortController();
            const started = registry.start(body(), controller.signal);
            expect(started.ok).toBe(true);
            await waitFor(() => upstreamSignal !== undefined);
            controller.abort();
            const events = await readAll((started as { stream: ReadableStream<Uint8Array> }).stream);
            expect(terminal(events)).toEqual([{ type: "error", message: "The client went away" }]);
            expect(upstreamSignal?.aborted).toBe(true);
            await waitFor(() => registry.liveIds().length === 0);
            release(json({ message: { content: "late answer" }, done: true }));
            await sleep(10);
            expect(registry.liveIds()).toEqual([]);
            await registry.dispose();
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe("OobaLegacy over a real Node WebSocket", () => {
    async function socketServer(onMessage: (socket: import("ws").WebSocket) => void) {
        const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        server.on("connection", (socket) => socket.on("message", () => onMessage(socket)));
        const { port } = server.address() as { port: number };
        return { url: `ws://127.0.0.1:${port}/api/v1/stream`, close: () => server.close() };
    }

    function oobaRecords(streamUrl: string) {
        const records = makeRecords({
            preset: {
                aiModel: "mancer",
                textgenWebUIStreamURL: streamUrl,
                textgenWebUIBlockingURL: "http://ooba.test/api",
            },
        });
        (records.providers as Record<string, unknown>).useStreaming = true;
        return records;
    }

    it("streams the cumulative text as strings (`chunkText`, recorded) and ends at `stream_end`", async () => {
        const server = await socketServer((socket) => {
            socket.send(JSON.stringify({ event: "text_stream", text: "Hel" }));
            socket.send(JSON.stringify({ event: "text_stream", text: "lo" }));
            socket.send(JSON.stringify({ event: "stream_end" }));
        });
        try {
            const { registry } = harness(oobaRecords(server.url), () => chat("x"));
            const { events } = await run(registry, body({ useStreaming: true }));
            expect(types(events)).toEqual(["accepted", "streaming", "chunkText", "chunkText", "end"]);
            expect(events.filter((event) => event.type === "chunkText")).toEqual([
                { type: "chunkText", value: "Hel" },
                { type: "chunkText", value: "Hello" },
            ]);
            expect(registry.liveIds()).toEqual([]);
            await registry.dispose();
        } finally {
            server.close();
        }
    });

    it("ends the stream with an error on a malformed frame or a close before `stream_end`, without killing the process", async () => {
        const malformed = await socketServer((socket) => socket.send("not-json"));
        const closing = await socketServer((socket) => socket.close(1011));
        try {
            const { registry } = harness(oobaRecords(malformed.url), () => chat("x"));
            const bad = await run(registry, body({ useStreaming: true }));
            expect(types(bad.events)).toEqual(["accepted", "streaming", "error"]);
            expect((terminal(bad.events)[0] as { message: string }).message).toMatch(/JSON/);
            const { registry: registry2 } = harness(oobaRecords(closing.url), () => chat("x"));
            const closed = await run(registry2, body({ useStreaming: true }));
            expect(types(closed.events)).toEqual(["accepted", "streaming", "error"]);
            expect((terminal(closed.events)[0] as { message: string }).message).toMatch(
                /closed before the stream ended/,
            );
            expect(registry.liveIds()).toEqual([]);
            expect(registry2.liveIds()).toEqual([]);
            await registry.dispose();
            await registry2.dispose();
        } finally {
            malformed.close();
            closing.close();
        }
    });
});

/** The ids of the job targets a job's request runs on (`JOB_TARGETS`). */
const ids = {
    presetId: "p",
    modelPresetId: "m",
    personaId: "u",
    selectedPersonaId: "u",
    selectedCharacterId: "c",
    speakerId: null,
};
/** A spec over `records` with recording sinks; `channel.callback` answers `intercept`. */
function jobSpec(
    records: Records,
    options: {
        intercept?: CallbackResult;
        streaming?: boolean;
        signal?: AbortSignal;
        /** The job's MCP tools (slice 12a); none by default. */
        tools?: JobRequestSpec["tools"];
        /** What the request is recorded as (request history slice 1); a Lua request of no chat by default. */
        source?: RequestSource;
        chatRef?: { chaId: string; chatId: string } | null;
        messageId?: string | null;
    } = {},
) {
    const loaded = loadRequestDb(fakeStore(records), kinds, ids);
    const alerts: string[] = [];
    const ended: string[] = [];
    const spec: JobRequestSpec = {
        jobId: "job",
        loaded,
        mode: "model",
        arg: { formated: [{ role: "user", content: "hi" }], bias: {}, useStreaming: options.streaming === true },
        source: options.source ?? "lua",
        chatRef: options.chatRef ?? null,
        ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
        tokenScope: tokenScopeFor(loaded.db),
        mainModelImageInput: false,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "aborted" }),
            callback: async () => options.intercept ?? { outcome: "refused", refusal: "unregistered", error: "none" },
        },
        parseCbs: (text) => text,
        inlays: {
            saveSignature: async (id) => id,
            writeImage: async (image) => image.id,
            setAsset: async () => {},
        },
        alertError: (text) => alerts.push(text),
        endJob: (message) => ended.push(message),
        tools: options.tools ?? noTools(),
        toolCalls: { read: () => undefined, write: () => {} },
        signal: options.signal ?? new AbortController().signal,
    };
    return { spec, alerts, ended };
}

describe("a job's in-process request (runInJob, slice 8a)", () => {
    it("sends the stored key, keeps a model's answer as it is, and redacts a failure's text and the exchanges it reports (a job has no tab log)", async () => {
        // The `requestLog` notice is gone (request history slice 3): a job's exchanges reach only
        // the observer, redacted at the write.
        const exchanges: Record<string, unknown>[] = [];
        const observer: RequestObserver = {
            begin() {},
            firstByte() {},
            exchange: (_id, entry) => void exchanges.push(entry),
            finish() {},
        };
        const { registry, calls } = harness(
            makeRecords(),
            (_call, index) =>
                index === 0 ? chat(`echo ${SECRET}`) : json({ error: { message: `bad key ${SECRET}` } }, 401),
            { observer },
        );
        const { spec } = jobSpec(makeRecords());
        const success = await registry.runInJob(spec);
        expect(success).toMatchObject({ type: "success", result: `echo ${SECRET}` });
        expect(calls[0].headers.authorization).toContain(SECRET);
        const failure = await registry.runInJob(spec);
        expect(failure.type).toBe("fail");
        expect(JSON.stringify(failure)).not.toContain(SECRET);
        expect(exchanges).toHaveLength(2);
        expect(JSON.stringify(exchanges)).not.toContain(SECRET);
        expect(JSON.parse(exchanges[0].header as string)).toMatchObject({ Authorization: "[redacted]" });
        expect(exchanges[1]).toMatchObject({
            status: 401,
            success: false,
            response: expect.stringContaining("[redacted]"),
        });
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("refuses a plugin or a tab's dynamic model without a provider request (they run in the browser)", async () => {
        for (const aiModel of ["pluginmodel:::example", "dynamic_google_future-model"]) {
            const records = makeRecords({ preset: { aiModel } });
            const { registry, calls } = harness(records, () => chat("never"));
            const { spec } = jobSpec(records);
            const response = await registry.runInJob(spec);
            expect(response.type).toBe("fail");
            expect(calls).toHaveLength(0);
            expect(registry.liveIds()).toEqual([]);
            await registry.dispose();
        }
    });

    it("runs the interceptor as a root callback of the job: an unregistered hook is skipped, a hook's throw keeps the body, and every other refusal or failure ends the job", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).additionalParams = [["marker", "value"]];
        for (const [intercept, calls, ends] of [
            [{ outcome: "refused", refusal: "unregistered", error: "none" }, 1, 0],
            [{ outcome: "failed", failure: "hook", error: "plugin threw" }, 1, 0],
            [{ outcome: "failed", failure: "protocol", error: "malformed" }, 0, 1],
            [{ outcome: "refused", refusal: "nesting", error: "deep" }, 0, 1],
            [{ outcome: "failed", failure: "barrier", error: "stale" }, 0, 1],
            [{ outcome: "disconnected", error: "gone" }, 0, 1],
        ] as [CallbackResult, number, number][]) {
            const { registry, calls: made } = harness(records, () => chat("done"));
            const { spec, ended } = jobSpec(records, { intercept });
            const response = await registry.runInJob(spec);
            expect(made, JSON.stringify(intercept)).toHaveLength(calls);
            expect(response.type).toBe(calls === 1 ? "success" : "fail");
            if (calls === 0) {
                expect((response as { result: string }).result).toMatch(/bodyIntercepter/);
            }
            expect(ended, JSON.stringify(intercept)).toHaveLength(ends);
            expect(registry.liveIds()).toEqual([]);
            await registry.dispose();
        }
    });

    it("hands a stream back live: read to its end it drains normally; aborted unread, its reader rejects with the reason and the registry drains at once", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        const frame = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] });
        const normal = harness(records, () => sse([frame("hi"), frame(" there")]));
        const done = await normal.registry.runInJob(jobSpec(records, { streaming: true }).spec);
        expect(done.type).toBe("streaming");
        const chunks: StreamResponseChunk[] = [];
        const reader = (done as { result: ReadableStream<StreamResponseChunk> }).result.getReader();
        for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) {
                break;
            }
            chunks.push(value);
        }
        expect(chunks.at(-1)?.["0"]).toBe("hi there");
        expect(normal.registry.liveIds()).toEqual([]);

        const controller = new AbortController();
        const slow = harness(records, (call) => sse([frame("a"), frame("b")], 5000, call.signal));
        const streaming = await slow.registry.runInJob(
            jobSpec(records, { streaming: true, signal: controller.signal }).spec,
        );
        expect(streaming.type).toBe("streaming");
        expect(slow.registry.liveIds()).toHaveLength(1);
        controller.abort(new Error("stop"));
        await waitFor(() => slow.registry.liveIds().length === 0);
        await expect(
            (streaming as { result: ReadableStream<StreamResponseChunk> }).result.getReader().read(),
        ).rejects.toThrow("stop");
        // A request of a job whose signal already aborted rejects instead of answering.
        await expect(slow.registry.runInJob(jobSpec(records, { signal: controller.signal }).spec)).rejects.toThrow(
            "stop",
        );
        await Promise.all([normal.registry.dispose(), slow.registry.dispose()]);
    });
});

describe("a job's MCP tools (runInJob, slice 12a)", () => {
    // The job's tool set reaches the real OpenAI-compatible adapter: its descriptors go out as the
    // body's tools, every tool call the model asks for is charged before the lookup (an unknown
    // name too), the job's `call` answers the follow-up request, a spent budget or a throwing tool
    // ends the request and the job with no further provider request, and a text failure result is
    // ordinary model input. Buffered and streaming (`wrapToolStream`).
    const ids = {
        presetId: "p",
        modelPresetId: "m",
        personaId: "u",
        selectedPersonaId: "u",
        selectedCharacterId: "c",
        speakerId: null,
    };
    const echo: ToolDescriptor = {
        name: "echo",
        description: "The echo tool",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
    };
    const toolCall = (name: string, args: unknown, id = "call-1") => ({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
    });
    function jobTools(
        options: {
            charge?: () => boolean;
            call?: (name: string, args: unknown) => Promise<RPCToolCallContent[]>;
        } = {},
    ) {
        const calls: { name: string; args: unknown }[] = [];
        const tools: JobRequestSpec["tools"] = {
            descriptors: [echo],
            charge: options.charge ?? (() => true),
            limit: 64,
            call: async (name, args) => {
                calls.push({ name, args });
                return options.call
                    ? options.call(name, args)
                    : [{ type: "text", text: `echoed ${(args as { text: string }).text}` }];
            },
        };
        return { tools, calls };
    }
    function spec(records: Records, tools: JobRequestSpec["tools"], streaming = false, signal?: AbortSignal) {
        const loaded = loadRequestDb(fakeStore(records), kinds, ids);
        const ended: string[] = [];
        /** Each `endJob` with the request it names (slice 6). */
        const endedWith: [string, { requestId: string } | undefined][] = [];
        const jobSpec: JobRequestSpec = {
            jobId: "job",
            loaded,
            mode: "model",
            arg: { formated: [{ role: "user", content: "hi" }], bias: {}, useStreaming: streaming },
            source: "lua",
            chatRef: null,
            tokenScope: tokenScopeFor(loaded.db),
            mainModelImageInput: false,
            channel: {
                notice() {},
                ask: async () => ({ outcome: "aborted" }),
                callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
            },
            parseCbs: (text) => text,
            inlays: {
                saveSignature: async (id) => id,
                writeImage: async (image) => image.id,
                setAsset: async () => {},
            },
            alertError: () => {},
            endJob: (message, failure) => {
                ended.push(message);
                endedWith.push([message, failure]);
            },
            tools,
            toolCalls: { read: () => undefined, write: () => {} },
            signal: signal ?? new AbortController().signal,
        };
        return { spec: jobSpec, ended, endedWith };
    }
    const toolMessages = (call: Upstream) =>
        (JSON.parse(call.body).messages as { role: string; content: string; tool_call_id?: string }[]).filter(
            (message) => message.role === "tool",
        );

    it("offers the descriptors, charges every call the model asks for before the lookup, runs the known one through the job, and sends the results back", async () => {
        const records = makeRecords();
        const { registry, calls } = harness(records, (call) =>
            afterTool(call)
                ? chat("done")
                : chat("", { tool_calls: [toolCall("echo", { text: "hi" }), toolCall("nope", {}, "call-2")] }),
        );
        let charged = 0;
        const tools = jobTools({
            charge: () => {
                charged++;
                return true;
            },
        });
        const job = spec(records, tools.tools);
        // The adapter joins the tool round's (empty) assistant text and the final answer with blank lines.
        expect(await registry.runInJob(job.spec)).toMatchObject({
            type: "success",
            result: expect.stringMatching(/^\s*done$/),
        });
        expect(JSON.parse(calls[0].body).tools).toMatchObject([{ type: "function", function: { name: "echo" } }]);
        expect(charged).toBe(2);
        expect(tools.calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
        expect(toolMessages(calls[1])).toEqual([
            { role: "tool", content: "echoed hi", tool_call_id: "call-1" },
            { role: "tool", content: "No tool found with name: nope", tool_call_id: "call-2" },
        ]);
        expect(job.ended).toEqual([]);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("ends the request and the job at the spent budget, before any tool runs and with no further provider request, buffered and streaming", async () => {
        const limit = "The job reached its tool call limit (64)";
        const buffered = makeRecords();
        const plain = harness(buffered, () => chat("", { tool_calls: [toolCall("nope", {})] }));
        const spent = jobTools({ charge: () => false });
        const job = spec(buffered, spent.tools);
        // The result names the admitted request (slice 6); without an observer no provider code is read.
        expect(await plain.registry.runInJob(job.spec)).toEqual({
            type: "fail",
            result: limit,
            noRetry: true,
            request: { id: expect.stringMatching(UUID), providerCode: null },
        });
        expect(job.ended).toEqual([limit]);
        expect(job.endedWith).toEqual([[limit, { requestId: expect.stringMatching(UUID) }]]);
        expect(plain.calls).toHaveLength(1);
        expect(spent.calls).toEqual([]);
        expect(plain.registry.liveIds()).toEqual([]);
        await plain.registry.dispose();

        const streamed = makeRecords();
        (streamed.providers as Record<string, unknown>).useStreaming = true;
        const frame = JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall("echo", { text: "hi" }) }] } }],
        });
        const live = harness(streamed, () => sse([frame, "[DONE]"]));
        const spentLive = jobTools({ charge: () => false });
        const streamingJob = spec(streamed, spentLive.tools, true);
        const response = await live.registry.runInJob(streamingJob.spec);
        expect(response.type).toBe("streaming");
        const reader = (response as { result: ReadableStream<StreamResponseChunk> }).result.getReader();
        await expect(
            (async () => {
                for (;;) {
                    const { done } = await reader.read();
                    if (done) {
                        return;
                    }
                }
            })(),
        ).rejects.toThrow(limit);
        expect(streamingJob.ended).toEqual([limit]);
        expect(live.calls).toHaveLength(1);
        expect(spentLive.calls).toEqual([]);
        await waitFor(() => live.registry.liveIds().length === 0);
        await live.registry.dispose();
    });

    it("ends the job when a tool throws (a fatal outcome), while a text failure result goes back to the model as ordinary input", async () => {
        const records = makeRecords();
        const fatal = "The mcpTool callback failed (barrier): stale";
        const thrown = harness(records, () => chat("", { tool_calls: [toolCall("echo", { text: "x" })] }));
        const failing = jobTools({
            call: async () => {
                throw new Error(fatal);
            },
        });
        const failed = spec(records, failing.tools);
        expect(await thrown.registry.runInJob(failed.spec)).toEqual({
            type: "fail",
            result: fatal,
            noRetry: true,
            request: { id: expect.stringMatching(UUID), providerCode: null },
        });
        expect(failed.ended).toEqual([fatal]);
        expect(failed.endedWith).toEqual([[fatal, { requestId: expect.stringMatching(UUID) }]]);
        expect(failing.calls).toHaveLength(1);
        expect(thrown.calls).toHaveLength(1);
        expect(thrown.registry.liveIds()).toEqual([]);
        await thrown.registry.dispose();

        const text = harness(records, (call) =>
            afterTool(call) ? chat("recovered") : chat("", { tool_calls: [toolCall("echo", { text: "x" })] }),
        );
        const answering = jobTools({ call: async () => [{ type: "text", text: "Tool call failed with error: boom" }] });
        const ok = spec(records, answering.tools);
        expect(await text.registry.runInJob(ok.spec)).toMatchObject({
            type: "success",
            result: expect.stringMatching(/^\s*recovered$/),
        });
        expect(toolMessages(text.calls[1])).toEqual([
            { role: "tool", content: "Tool call failed with error: boom", tool_call_id: "call-1" },
        ]);
        expect(ok.ended).toEqual([]);
        await text.registry.dispose();
    });
});

describe("a job's request names its failure (request history slice 6)", () => {
    // `runInJob`'s results carry `request: { id, providerCode }`, a stream that fails while read
    // errors with `JobRequestError`, and a fatal end from inside the request names it: through
    // `endJob(message, { requestId })` for a new fatal, and through `markFailure` on the job's abort
    // reason for a failure latched before the request's own `endJob` (the already-latched case).
    const ids = {
        presetId: "p",
        modelPresetId: "m",
        personaId: "u",
        selectedPersonaId: "u",
        selectedCharacterId: "c",
        speakerId: null,
    };
    /** An observer that takes exchanges (the production history observer does), recording the ends. */
    function observing() {
        const begun: string[] = [];
        const finished: [string, { status: string }, { error?: string; providerCode?: string | null } | undefined][] =
            [];
        const observer: RequestObserver = {
            begin: (request) => void begun.push(request.requestId),
            firstByte() {},
            exchange() {},
            finish: (id, end, detail) => void finished.push([id, end, detail]),
        };
        return { observer, begun, finished };
    }
    function spec(
        records: Records,
        options: {
            streaming?: boolean;
            signal?: AbortSignal;
            tools?: JobRequestSpec["tools"];
            parseCbs?: (text: string) => string;
        } = {},
    ) {
        const loaded = loadRequestDb(fakeStore(records), kinds, ids);
        const endedWith: [string, { requestId: string } | undefined][] = [];
        const jobSpec: JobRequestSpec = {
            jobId: "job",
            loaded,
            mode: "model",
            arg: { formated: [{ role: "user", content: "hi" }], bias: {}, useStreaming: options.streaming === true },
            source: "send",
            chatRef: { chaId: "c", chatId: "k" },
            tokenScope: tokenScopeFor(loaded.db),
            mainModelImageInput: false,
            channel: {
                notice() {},
                ask: async () => ({ outcome: "aborted" }),
                callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
            },
            parseCbs: options.parseCbs ?? ((text) => text),
            inlays: {
                saveSignature: async (id) => id,
                writeImage: async (image) => image.id,
                setAsset: async () => {},
            },
            alertError: () => {},
            endJob: (message, failure) => void endedWith.push([message, failure]),
            tools: options.tools ?? noTools(),
            toolCalls: { read: () => undefined, write: () => {} },
            signal: options.signal ?? new AbortController().signal,
        };
        return { spec: jobSpec, endedWith };
    }
    /** An SSE upstream whose body errors once its frames were read, as a dropped socket does. */
    const breaking = (frames: string[]) => {
        let next = 0;
        return new Response(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (next < frames.length) {
                        controller.enqueue(new TextEncoder().encode(`data: ${frames[next++]}\n\n`));
                    } else {
                        controller.error(new Error("socket hang up"));
                    }
                },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
        );
    };
    const readToEnd = async (response: requestDataResponse) => {
        expect(response.type).toBe("streaming");
        const reader = (response as { result: ReadableStream<StreamResponseChunk> }).result.getReader();
        const chunks: StreamResponseChunk[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return chunks;
            }
            chunks.push(value);
        }
    };

    it("a buffered failure names its request and the provider's code from the answer body; the observer's end carries the code; without an observer that takes exchanges the code is null", async () => {
        const records = makeRecords();
        const refusal = json(
            { error: { message: "Rate limit reached for gpt", type: "requests", code: "rate_limit_exceeded" } },
            429,
        );
        const seen = observing();
        const { registry } = harness(records, () => refusal.clone(), { observer: seen.observer });
        const job = spec(records);
        const result = await registry.runInJob(job.spec);
        expect(result).toMatchObject({
            type: "fail",
            request: { id: seen.begun[0], providerCode: "rate_limit_exceeded" },
        });
        expect(seen.begun).toHaveLength(1);
        expect(seen.finished).toEqual([
            [
                seen.begun[0],
                expect.objectContaining({ status: "error" }),
                { error: expect.stringContaining("Rate limit"), providerCode: "rate_limit_exceeded" },
            ],
        ]);
        expect(job.endedWith).toEqual([]);
        await registry.dispose();

        // A code the pattern refuses is not a code; a success has none.
        const texty = observing();
        const text = harness(
            records,
            (_call, index) =>
                index === 0 ? json({ error: { message: "m", code: "rate limit exceeded" } }, 429) : chat("ok"),
            {
                observer: texty.observer,
            },
        );
        expect(await text.registry.runInJob(spec(records).spec)).toMatchObject({
            type: "fail",
            request: { providerCode: null },
        });
        expect(texty.finished[0][2]).toEqual({ error: expect.any(String) });
        expect(await text.registry.runInJob(spec(records).spec)).toMatchObject({
            type: "success",
            request: { id: texty.begun[1], providerCode: null },
        });
        expect(texty.finished[1][2]).toBeUndefined();
        await text.registry.dispose();

        // The code is read from the exchanges the observer takes: an observer without `exchange`, or none, sees no body.
        const blind: RequestObserver = { begin() {}, firstByte() {}, finish() {} };
        const noExchange = harness(records, () => refusal.clone(), { observer: blind });
        expect(await noExchange.registry.runInJob(spec(records).spec)).toMatchObject({
            type: "fail",
            request: { id: expect.stringMatching(UUID), providerCode: null },
        });
        await noExchange.registry.dispose();
        const unobserved = harness(records, () => refusal.clone());
        expect(await unobserved.registry.runInJob(spec(records).spec)).toMatchObject({
            type: "fail",
            request: { providerCode: null },
        });
        await unobserved.registry.dispose();
    });

    it("a stream that fails after its chunks errors with JobRequestError naming the request and the code of the error event the capture holds; a streamed success names the request with no code", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        const chunk = JSON.stringify({ choices: [{ delta: { content: "Hel" } }] });
        const seen = observing();
        const { registry } = harness(
            records,
            (_call, index) =>
                index === 0
                    ? breaking([chunk, JSON.stringify({ error: { message: "Overloaded", code: "server_overloaded" } })])
                    : sse([chunk, "[DONE]"]),
            { observer: seen.observer },
        );
        const broken = await registry.runInJob(spec(records, { streaming: true }).spec);
        expect(broken.request).toEqual({ id: seen.begun[0], providerCode: null });
        let caught: unknown;
        try {
            await readToEnd(broken);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(JobRequestError);
        expect(caught).toMatchObject({
            requestId: seen.begun[0],
            providerCode: "server_overloaded",
            message: expect.stringContaining("socket hang up"),
        });
        await waitFor(() => seen.finished.length === 1);
        expect(seen.finished[0]).toEqual([
            seen.begun[0],
            expect.objectContaining({ status: "error" }),
            { error: expect.stringContaining("socket hang up"), providerCode: "server_overloaded" },
        ]);

        const fine = await registry.runInJob(spec(records, { streaming: true }).spec);
        expect(fine.request).toEqual({ id: seen.begun[1], providerCode: null });
        expect((await readToEnd(fine)).length).toBeGreaterThan(0);
        await waitFor(() => seen.finished.length === 2);
        expect(seen.finished[1][2]).toBeUndefined();
        await waitFor(() => registry.liveIds().length === 0);
        await registry.dispose();
    });

    it("a failure latched before the request's own endJob (an MCP tool's barrier failure that aborted the job) still names the request: the abort reason is marked with its id, and the request rejects with that reason", async () => {
        // The production path: `tryCallback` latches a `LuaJobFatalError` (unannotated) and aborts the
        // run signal before the tool call rejects; the request's `endWith` then calls `endJob` with
        // the id, but the latch keeps the first error. Here the tool does what the latch does.
        const records = makeRecords();
        const controller = new AbortController();
        const latched = new Error("The mcpTool callback failed (barrier): stale");
        const tools: JobRequestSpec["tools"] = {
            descriptors: [{ name: "echo", description: "d", inputSchema: { type: "object", properties: {} } }],
            charge: () => true,
            limit: 64,
            call: async () => {
                controller.abort(latched);
                throw latched;
            },
        };
        const seen = observing();
        const { registry, calls } = harness(
            records,
            () =>
                chat("", {
                    tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } }],
                }),
            { observer: seen.observer },
        );
        const job = spec(records, { tools, signal: controller.signal });
        await expect(registry.runInJob(job.spec)).rejects.toBe(latched);
        expect(seen.begun).toHaveLength(1);
        expect(failureOf(latched)).toEqual({ requestId: seen.begun[0] });
        // The request's own end still names the request (the latch would keep the earlier error).
        expect(job.endedWith).toEqual([[latched.message, { requestId: seen.begun[0] }]]);
        expect(calls).toHaveLength(1);
        expect(seen.finished).toEqual([
            [
                seen.begun[0],
                expect.objectContaining({ status: "aborted" }),
                { error: expect.stringContaining("barrier") },
            ],
        ]);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("a fatal latched directly by the job's CBS while the request evaluates its schema's CBS names the request the same way, before any provider call", async () => {
        // The production path: the request's `parseCbs` is the job's evaluator, which latches a
        // `CbsLimitError` as a fatal (`bindings.ts`) and aborts the run signal before it throws.
        const schema = makeRecords({
            preset: { jsonSchemaEnabled: true, jsonSchema: "interface A {\n    x: string\n}" },
        });
        const controller = new AbortController();
        const latched = new Error("CBS limit reached (Ann)");
        const seen = observing();
        const { registry, calls } = harness(schema, () => chat("never"), { observer: seen.observer });
        const job = spec(schema, {
            signal: controller.signal,
            parseCbs: () => {
                controller.abort(latched);
                throw latched;
            },
        });
        await expect(registry.runInJob(job.spec)).rejects.toBe(latched);
        expect(calls).toEqual([]);
        expect(seen.begun).toHaveLength(1);
        expect(failureOf(latched)).toEqual({ requestId: seen.begun[0] });
        expect(job.endedWith).toEqual([]);
        expect(seen.finished[0][1]).toMatchObject({ status: "aborted" });
        await registry.dispose();
    });

    it("the job's own abort (a string reason) rejects without marking anything, and a request refused before admission names no request", async () => {
        const records = makeRecords({
            preset: { jsonSchemaEnabled: true, jsonSchema: "interface A {\n    x: string\n}" },
        });
        const controller = new AbortController();
        const { registry } = harness(records, () => chat("x"));
        const job = spec(records, {
            signal: controller.signal,
            parseCbs: (text) => {
                controller.abort("aborted");
                return text;
            },
        });
        await expect(registry.runInJob(job.spec)).rejects.toBe("aborted");
        registry.beginShutdown();
        const refused = await registry.runInJob(spec(records).spec);
        expect(refused).toEqual({ type: "fail", result: "The server is shutting down", noRetry: true });
        expect("request" in refused).toBe(false);
        await registry.dispose();
    });
});

describe("the child interceptor of a job callback", () => {
    type Outcome = CallbackResult | ((payload: unknown) => CallbackResult);

    function withParent(outcome: Outcome, options: { registered?: boolean } = {}) {
        const payloads: unknown[] = [];
        let ended = 0;
        let settled: (() => void) | null = null;
        const records = makeRecords();
        (records.providers as Record<string, unknown>).additionalParams = [["marker", "value"]];
        const { registry, calls } = harness(records, () => chat("done"), {
            parentCallback: (jobId, clientId, callbackId, onSettled) => {
                if (jobId !== "job" || clientId !== "client-a" || callbackId !== "cb" || options.registered === false) {
                    return null;
                }
                settled = onSettled;
                return {
                    channel: {
                        callback: async (_name: string, payload: unknown) => {
                            payloads.push(payload);
                            return typeof outcome === "function" ? outcome(payload) : outcome;
                        },
                    } as never,
                    targets: { ...JOB_TARGETS },
                    unwatch() {},
                    endJob: () => ended++,
                };
            },
        });
        return { registry, calls, payloads, ended: () => ended, settle: () => settled?.() };
    }
    const channelCall = { jobId: "job", callbackId: "cb" };

    it("skips interception for a request outside a job (recorded), and refuses a `channelCall` that is not running", async () => {
        const { registry, calls, payloads } = withParent({ outcome: "answered", value: null }, { registered: false });
        await run(registry, body());
        expect(payloads).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(registry.start(body({}, { channelCall }), new AbortController().signal)).toMatchObject({
            ok: false,
            status: 409,
        });
        await registry.dispose();
    });

    it("hands the body to the registered interceptor and sends what it answers", async () => {
        const { registry, calls, payloads } = withParent((payload) => ({
            outcome: "answered",
            value: { ...(payload as { body: Record<string, unknown> }).body, intercepted: true },
        }));
        const { events } = await run(registry, body({}, { channelCall }));
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({ type: "openai_basic" });
        expect(JSON.parse(calls[0].body)).toMatchObject({ intercepted: true, marker: "value" });
        expect(terminal(events)[0]).toMatchObject({ response: { type: "success" } });
        await registry.dispose();
    });

    it("sends the body as it is when the job has no interceptor or the hook threw, and fails the request on a nesting or queue refusal", async () => {
        const unregistered = withParent({ outcome: "refused", refusal: "unregistered", error: "none" });
        await run(unregistered.registry, body({}, { channelCall }));
        expect(unregistered.calls).toHaveLength(1);
        const threw = withParent({ outcome: "failed", failure: "hook", error: "plugin threw" });
        const thrown = await run(threw.registry, body({}, { channelCall }));
        expect(threw.calls).toHaveLength(1);
        expect(terminal(thrown.events)[0]).toMatchObject({ response: { type: "success" } });
        expect(threw.ended()).toBe(0);
        const nesting = withParent({ outcome: "refused", refusal: "nesting", error: "one level deep" });
        const refused = await run(nesting.registry, body({}, { channelCall }));
        expect(nesting.calls).toHaveLength(0);
        expect(terminal(refused.events)).toEqual([
            { type: "error", message: "The bodyIntercepter callback was refused: one level deep" },
        ]);
        expect(nesting.ended()).toBe(0);
        await Promise.all([unregistered.registry.dispose(), threw.registry.dispose(), nesting.registry.dispose()]);
    });

    it("ends the request and the owning job on a barrier failure, a timeout, or a disconnect of the child callback", async () => {
        for (const [outcome, endsJob] of [
            [{ outcome: "failed", failure: "barrier", error: "stale" }, true],
            [{ outcome: "failed", failure: "protocol", error: "bad" }, false],
            [{ outcome: "timedOut", error: "late" }, true],
            [{ outcome: "disconnected", error: "gone" }, true],
        ] as [CallbackResult, boolean][]) {
            const parent = withParent(outcome);
            const { events } = await run(parent.registry, body({}, { channelCall }));
            expect(parent.calls).toHaveLength(0);
            expect(types(terminal(events))).toEqual(["error"]);
            expect(parent.ended()).toBe(endsJob ? 1 : 0);
            await parent.registry.dispose();
        }
    });

    it("ends the request when the job callback it runs inside settles", async () => {
        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        let settled: (() => void) | null = null;
        const { registry } = harness(
            records,
            (call) => sse([JSON.stringify({ choices: [{ delta: { content: "a" } }] })], 5000, call.signal),
            {
                parentCallback: (_jobId, _clientId, _callbackId, onSettled) => {
                    settled = onSettled;
                    return {
                        channel: { callback: async () => ({ outcome: "refused", refusal: "unregistered" }) } as never,
                        targets: { ...JOB_TARGETS },
                        unwatch() {},
                        endJob() {},
                    };
                },
            },
        );
        const started = registry.start(body({ useStreaming: true }, { channelCall }), new AbortController().signal);
        expect(started.ok).toBe(true);
        await waitFor(() => settled !== null);
        settled!();
        const events = await readAll((started as { stream: ReadableStream<Uint8Array> }).stream);
        expect(terminal(events)).toEqual([
            { type: "error", message: "The job callback this request ran inside ended" },
        ]);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("refuses to hand a body that carries a stored credential to a plugin interceptor (in a value or a property name)", async () => {
        for (const params of [[["echo", SECRET]], [[SECRET, "value"]]]) {
            const parent = withParent({ outcome: "answered", value: null });
            const records = makeRecords();
            (records.providers as Record<string, unknown>).additionalParams = params;
            const { registry, calls } = harness(records, () => chat("x"), {
                parentCallback: () => ({
                    channel: { callback: async () => ({ outcome: "answered", value: null }) } as never,
                    targets: { ...JOB_TARGETS },
                    unwatch() {},
                    endJob() {},
                }),
            });
            const { events, raw } = await run(registry, body({}, { channelCall }));
            expect(calls).toHaveLength(0);
            expect(terminal(events)).toEqual([
                {
                    type: "error",
                    message: "The request body carries a stored credential; it is not sent to a plugin interceptor",
                },
            ]);
            expect(raw).not.toContain(SECRET);
            await registry.dispose();
            await parent.registry.dispose();
        }
    });
});

// `docs/plan/chat-binding.md`, slice 2: a request for a chat (`arg.chatRef`) runs on that chat's binding
// (`chatRequestRefusal`): outside a job callback the chat's complete binding, inside a callback of that
// chat's job the job's targets (a `presetChain` pick included). A refusal is a 409 before registration
// and before the provider, with the problems for an incomplete binding, and releases the callback
// watch. A request without a chat is not checked (decision 10).
describe("a chat's request and its binding", () => {
    const chatRef = { chaId: "c", chatId: "k" };
    const context = (ids: Record<string, unknown>) => ({ context: { ...body().context, ...ids } });

    it("runs a chat request on the chat's binding, refuses other ids (mismatch) or an incomplete binding (with its problems) before the provider, and leaves a request without a chat alone", async () => {
        const records = makeRecords();
        const { registry, calls } = harness(records, () => chat("done"));
        const refused = (request: LlmRequestBody) => registry.start(request, new AbortController().signal);

        const ok = await run(registry, body({ chatRef }));
        expect(terminal(ok.events)[0]).toMatchObject({ response: { type: "success", result: "done" } });
        expect(calls).toHaveLength(1);

        expect(refused(body({ chatRef }, context({ personaId: "b" })))).toEqual({
            ok: false,
            status: 409,
            error: "chatBindingMismatch",
        });
        expect(refused(body({ chatRef }, context({ presetId: "other" })))).toMatchObject({
            status: 409,
            error: "chatBindingMismatch",
        });
        expect(refused(body({ chatRef: { chaId: "c", chatId: "loose" } }))).toEqual({
            ok: false,
            status: 409,
            error: "chatBindingIncomplete",
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "promptPresetId", reason: "unset" },
                { field: "personaId", reason: "unset" },
            ],
        });
        records.chats!["c/k"] = { ...records.chats!["c/k"], bindedPersona: "zz", bindingReview: true };
        expect(refused(body({ chatRef }))).toEqual({
            ok: false,
            status: 409,
            error: "chatBindingIncomplete",
            problems: [{ field: "personaId", reason: "gone" }, { field: "review" }],
        });
        expect(calls).toHaveLength(1);
        expect(registry.liveIds()).toEqual([]);

        // No chat: the ids are the caller's (the tab's selection), as before.
        const free = await run(registry, body({}, context({ personaId: "b" })));
        expect(terminal(free.events)[0]).toMatchObject({ response: { type: "success" } });
        expect(calls).toHaveLength(2);
        await registry.dispose();
    });

    it("inside a callback of the chat's own job compares with the job's targets (a presetChain pick), checks another chat against the store, and unwatches the callback on a refusal", async () => {
        const records = makeRecords();
        // The pick exists as a prompt preset (the job re-scoped on it).
        (records.presets as Record<string, unknown>[]).push({
            ...(records.presets as object[])[0],
            id: "picked",
            name: "picked",
        });
        let unwatched = 0;
        const { registry, calls } = harness(records, () => chat("done"), {
            parentCallback: (jobId, clientId, callbackId) =>
                jobId === "job" && clientId === "client-a" && callbackId === "cb"
                    ? {
                          channel: {
                              callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
                          } as never,
                          // The job picked `picked` for its prompt preset: its callbacks run on it.
                          targets: { ...JOB_TARGETS, presetId: "picked" },
                          unwatch: () => unwatched++,
                          endJob() {},
                      }
                    : null,
        });
        const channelCall = { jobId: "job", callbackId: "cb" };
        const refused = (request: LlmRequestBody) => registry.start(request, new AbortController().signal);

        const picked = await run(registry, body({ chatRef }, { channelCall, ...context({ presetId: "picked" }) }));
        expect(terminal(picked.events)[0]).toMatchObject({ response: { type: "success" } });
        expect(calls).toHaveLength(1);
        // The request's end released its watch (the usual cleanup); each refusal below releases its own.
        expect(unwatched).toBe(1);

        // The chat's stored binding is not the job's: refused, and the callback watch is released.
        expect(refused(body({ chatRef }, { channelCall }))).toEqual({
            ok: false,
            status: 409,
            error: "chatBindingMismatch",
        });
        expect(unwatched).toBe(2);
        expect(
            refused(body({ chatRef }, { channelCall, ...context({ presetId: "picked", personaId: "b" }) })),
        ).toMatchObject({
            status: 409,
            error: "chatBindingMismatch",
        });
        expect(unwatched).toBe(3);

        // Another chat's request inside this job's callback: that chat's own binding.
        expect(refused(body({ chatRef: { chaId: "c", chatId: "loose" } }, { channelCall }))).toMatchObject({
            status: 409,
            error: "chatBindingIncomplete",
        });
        expect(unwatched).toBe(4);
        expect(calls).toHaveLength(1);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("answers 404 for a chat that does not exist (or whose character does not), before registration and the provider, releasing the callback watch of another chat's job", async () => {
        const records = makeRecords();
        let unwatched = 0;
        const { registry, calls } = harness(records, () => chat("done"), {
            parentCallback: (jobId, clientId, callbackId) =>
                jobId === "job" && clientId === "client-a" && callbackId === "cb"
                    ? {
                          channel: {
                              callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
                          } as never,
                          targets: { ...JOB_TARGETS },
                          unwatch: () => unwatched++,
                          endJob() {},
                      }
                    : null,
        });
        const refused = (request: LlmRequestBody) => registry.start(request, new AbortController().signal);
        const gone = { ok: false, status: 404, error: "The chat this request is for no longer exists" };

        // The store path: the chat is not listed, or its character is not.
        expect(refused(body({ chatRef: { chaId: "c", chatId: "nope" } }))).toEqual(gone);
        expect(refused(body({ chatRef: { chaId: "zz", chatId: "k" } }))).toEqual(gone);
        expect(unwatched).toBe(0);
        // Inside a callback of chat `k`'s job, a request for another chat that does not exist: the
        // same 404, and the callback watch the admission took is released.
        const channelCall = { jobId: "job", callbackId: "cb" };
        expect(refused(body({ chatRef: { chaId: "c", chatId: "nope" } }, { channelCall }))).toEqual(gone);
        expect(unwatched).toBe(1);
        // A callback that is not running is refused first (409), as before.
        expect(
            refused(
                body({ chatRef: { chaId: "c", chatId: "nope" } }, { channelCall: { ...channelCall, callbackId: "x" } }),
            ),
        ).toMatchObject({
            status: 409,
            error: "The job callback this request names is not running",
        });
        expect(unwatched).toBe(1);
        expect(calls).toHaveLength(0);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });
});

describe("a job's plugin provider model (runInJob, slice 11b)", () => {
    const ids = {
        presetId: "p",
        modelPresetId: "m",
        personaId: "u",
        selectedPersonaId: "u",
        selectedCharacterId: "c",
        speakerId: null,
    };
    /** A provider descriptor as the tab registers it (`hooks.providers`), admitted for the job. */
    const descriptor = (name: string): LLMModel => ({
        id: `pluginmodel:::${name}`,
        name,
        shortName: name,
        fullName: name,
        internalID: `pluginmodel:::${name}`,
        provider: LLMProvider.AsIs,
        format: LLMFormat.Plugin,
        flags: [LLMFlags.hasFullSystemPrompt],
        parameters: ["temperature"],
        tokenizer: LLMTokenizer.Unknown,
    });
    type ProviderCall = {
        payload: { name: string; argument: Record<string, unknown> };
        options: { timeoutMs?: number; onChunk?: (text: string) => void; signal?: AbortSignal };
        settle: (result: CallbackResult) => void;
    };
    /**
     * A job spec whose channel hands every `provider` callback to the test (`calls`), refusing a
     * provider the tab did not register (`registered`) as the hub does, and settling `aborted` when
     * the callback's signal fires. `admitted` names the descriptors `admitProviderModels` would put
     * on the request projection.
     */
    function providerSpec(
        records: Records,
        options: {
            admitted?: string[];
            registered?: string[];
            formated?: JobRequestSpec["arg"]["formated"];
            toolCalls?: Record<string, ToolCallRecord>;
            signal?: AbortSignal;
        } = {},
    ) {
        const loaded = loadRequestDb(fakeStore(records), kinds, ids);
        const db = { ...loaded.db, pluginModels: (options.admitted ?? ["prov"]).map(descriptor) };
        const registered = options.registered ?? ["prov"];
        const calls: ProviderCall[] = [];
        const ended: string[] = [];
        const spec: JobRequestSpec = {
            jobId: "job",
            loaded: { ...loaded, db },
            mode: "model",
            arg: { formated: options.formated ?? [{ role: "user", content: "hi" }], bias: {}, useStreaming: false },
            source: "lua",
            chatRef: null,
            tokenScope: tokenScopeFor(db),
            mainModelImageInput: false,
            channel: {
                notice() {},
                ask: async () => ({ outcome: "aborted" }),
                callback: (name, payload, callbackOptions) =>
                    new Promise<CallbackResult>((resolve) => {
                        if (name !== "provider") {
                            resolve({ outcome: "refused", refusal: "unregistered", error: "none" });
                            return;
                        }
                        const provider = payload as ProviderCall["payload"];
                        if (!registered.includes(provider.name)) {
                            resolve({ outcome: "refused", refusal: "unregistered", error: "not registered" });
                            return;
                        }
                        const extra = (callbackOptions ?? {}) as ProviderCall["options"];
                        extra.signal?.addEventListener(
                            "abort",
                            () => resolve({ outcome: "aborted", error: "The request ended" }),
                            { once: true },
                        );
                        calls.push({ payload: provider, options: extra, settle: resolve });
                    }),
            },
            parseCbs: (text) => text,
            inlays: {
                saveSignature: async (id) => id,
                writeImage: async (image) => image.id,
                setAsset: async () => {},
            },
            alertError: () => {},
            endJob: (message) => ended.push(message),
            tools: noTools(),
            toolCalls: { read: () => options.toolCalls, write: () => {} },
            signal: options.signal ?? new AbortController().signal,
        };
        return { spec, calls, ended };
    }
    const pluginRecords = (aiModel = "pluginmodel:::prov") => makeRecords({ preset: { aiModel } });
    /** Starts the request and waits for its provider callback. */
    async function startProvider(records: Records, options: Parameters<typeof providerSpec>[1] = {}) {
        const { registry, calls: http } = harness(records, () => chat("never"));
        const built = providerSpec(records, options);
        const pending = registry.runInJob(built.spec);
        await waitFor(() => built.calls.length === 1);
        return { registry, http, pending, ...built, call: built.calls[0] };
    }
    type Streamed = { result: ReadableStream<StreamResponseChunk> };

    it("calls the provider in the tab with the prompt and the parameters built here (no provider request, no credential), for 30 minutes and cancelled with the request, and takes a text answer as the model's", async () => {
        const { registry, http, pending, call, calls } = await startProvider(pluginRecords());
        expect(http).toHaveLength(0);
        expect(call.payload.name).toBe("prov");
        expect(call.payload.argument).toMatchObject({
            prompt_chat: [{ role: "user", content: "hi" }],
            mode: "model",
            bias: [],
            max_tokens: expect.any(Number),
            temperature: expect.any(Number),
        });
        expect(JSON.stringify(call.payload)).not.toContain(SECRET);
        expect(call.options.timeoutMs).toBe(30 * 60_000);
        expect(call.options.signal?.aborted).toBe(false);
        call.settle({ outcome: "answered", value: { success: true, content: "hello from the plugin" } });
        expect(await pending).toMatchObject({
            type: "success",
            result: "hello from the plugin",
            model: "pluginmodel:::prov",
        });
        expect(calls).toHaveLength(1);
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("maps the other answers: a failure's text, no answer, a provider that threw (its message, recorded), a text over the cap, and a protocol failure, a disconnect, or a malformed value ending the job", async () => {
        for (const [result, expected, ends] of [
            [
                { outcome: "answered", value: { success: false, content: "the plugin says no" } },
                { type: "fail", result: "the plugin says no", model: "pluginmodel:::prov" },
                0,
            ],
            [{ outcome: "answered", value: { none: true } }, { type: "fail", result: messages.errors.unknownModel }, 0],
            [
                { outcome: "failed", failure: "hook", error: "boom" },
                { type: "fail", result: expect.stringMatching(/^Plugin Error from .*: boom$/) },
                0,
            ],
            [
                { outcome: "answered", value: { success: true, content: "x".repeat(MAX_PROVIDER_TEXT_CHARS + 1) } },
                { type: "fail", result: expect.stringMatching(/too long/) },
                0,
            ],
            [
                { outcome: "failed", failure: "protocol", error: "malformed" },
                { type: "fail", result: expect.stringMatching(/provider callback failed: malformed/) },
                1,
            ],
            [
                { outcome: "disconnected", error: "gone" },
                { type: "fail", result: expect.stringMatching(/disconnected/) },
                1,
            ],
            [
                { outcome: "answered", value: { success: true } },
                { type: "fail", result: expect.stringMatching(/malformed value/) },
                1,
            ],
            [
                { outcome: "answered", value: "text" },
                { type: "fail", result: expect.stringMatching(/malformed value/) },
                1,
            ],
        ] as [CallbackResult, Record<string, unknown>, number][]) {
            const label = JSON.stringify(result).slice(0, 80);
            const { registry, pending, call, ended } = await startProvider(pluginRecords());
            call.settle(result);
            expect(await pending, label).toMatchObject(expected);
            expect(ended, label).toHaveLength(ends);
            expect(registry.liveIds()).toEqual([]);
            await registry.dispose();
        }
        // The cap itself passes.
        const atCap = await startProvider(pluginRecords());
        atCap.call.settle({
            outcome: "answered",
            value: { success: true, content: "x".repeat(MAX_PROVIDER_TEXT_CHARS) },
        });
        expect(((await atCap.pending) as { result: string }).result).toHaveLength(MAX_PROVIDER_TEXT_CHARS);
        await atCap.registry.dispose();
    });

    it("refuses a provider the tab did not register as the unknown-plugin failure without a request or ending the job (admitted or not), a dynamic model without any callback, and reaches the legacy `custom` model's provider by `currentPluginProvider`", async () => {
        for (const admitted of [["other"], []]) {
            const records = pluginRecords("pluginmodel:::other");
            const { registry, calls: http } = harness(records, () => chat("never"));
            const built = providerSpec(records, { admitted });
            expect(await registry.runInJob(built.spec)).toMatchObject({
                type: "fail",
                result: messages.pluginProviderNotFound,
                model: "pluginmodel:::other",
            });
            expect(built.calls).toEqual([]);
            expect(built.ended).toEqual([]);
            expect(http).toHaveLength(0);
            await registry.dispose();
        }
        const dynamicRecords = makeRecords({ preset: { aiModel: "dynamic_google_future-model" } });
        const dynamic = harness(dynamicRecords, () => chat("never"));
        const dynamicSpec = providerSpec(dynamicRecords, { registered: ["dynamic_google_future-model"] });
        expect((await dynamic.registry.runInJob(dynamicSpec.spec)).type).toBe("fail");
        expect(dynamicSpec.calls).toEqual([]);
        expect(dynamic.calls).toHaveLength(0);
        await dynamic.registry.dispose();

        // `currentPluginProvider` is a profile field (`docs/plan/model-profiles.md`).
        const legacy = await startProvider(
            makeRecords({ preset: { aiModel: "custom", currentPluginProvider: "legacy" } }),
            { registered: ["legacy"] },
        );
        expect(legacy.http).toHaveLength(0);
        expect(legacy.call.payload.name).toBe("legacy");
        legacy.call.settle({ outcome: "answered", value: { success: true, content: "legacy text" } });
        expect(await legacy.pending).toMatchObject({ type: "success", result: "legacy text", model: "custom" });
        await legacy.registry.dispose();
    });

    it("turns the first `chunk` into a stream of the cumulative text that holds only the newest text not yet read, delivers the last text before the end, and closes on the answer", async () => {
        const { registry, pending, call } = await startProvider(pluginRecords());
        const onChunk = call.options.onChunk!;
        expect(onChunk).toBeTypeOf("function");
        // The first chunk (empty: it only says "a stream") answers the request.
        onChunk("");
        const response = await pending;
        expect(response).toMatchObject({ type: "streaming", model: "pluginmodel:::prov" });
        const reader = (response as Streamed).result.getReader();
        // Three texts before any read: the reader gets the newest only.
        onChunk("a");
        onChunk("ab");
        onChunk("abc");
        expect(await reader.read()).toEqual({ done: false, value: { "0": "abc" } });
        // A pending read takes the next text at once.
        const waiting = reader.read();
        onChunk("abcd");
        expect(await waiting).toEqual({ done: false, value: { "0": "abcd" } });
        // The text still waiting when the answer comes goes out before the end.
        onChunk("abcde");
        call.settle({ outcome: "answered", value: { success: true, streamed: true } });
        expect(await reader.read()).toEqual({ done: false, value: { "0": "abcde" } });
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        onChunk("late");
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });

    it("ends an empty stream at once, errors the stream with a failure's (redacted) text after chunks, fails it for an answer over the cap, and aborts the callback when the reader cancels (later chunks dropped)", async () => {
        const empty = await startProvider(pluginRecords());
        empty.call.options.onChunk!("");
        empty.call.settle({ outcome: "answered", value: { success: true, streamed: true } });
        const emptyStream = (await empty.pending) as Streamed;
        expect(await emptyStream.result.getReader().read()).toEqual({ done: true, value: undefined });
        expect(empty.registry.liveIds()).toEqual([]);
        await empty.registry.dispose();

        const failing = await startProvider(pluginRecords());
        failing.call.options.onChunk!("");
        failing.call.options.onChunk!("partial");
        const reader = ((await failing.pending) as Streamed).result.getReader();
        expect(await reader.read()).toEqual({ done: false, value: { "0": "partial" } });
        failing.call.settle({ outcome: "answered", value: { success: false, content: `broke with ${SECRET}` } });
        const error = await reader.read().then(
            () => "resolved",
            (thrown: unknown) => String(thrown),
        );
        expect(error).toMatch(/broke with/);
        expect(error).not.toContain(SECRET);
        expect(failing.ended).toEqual([]);
        expect(failing.registry.liveIds()).toEqual([]);
        await failing.registry.dispose();

        const over = await startProvider(pluginRecords());
        over.call.options.onChunk!("");
        const overStream = (await over.pending) as Streamed;
        over.call.settle({
            outcome: "answered",
            value: { success: true, content: "x".repeat(MAX_PROVIDER_TEXT_CHARS + 1) },
        });
        await expect(overStream.result.getReader().read()).rejects.toThrow(/too long/);
        await over.registry.dispose();

        const cancelled = await startProvider(pluginRecords());
        cancelled.call.options.onChunk!("");
        const cancelReader = ((await cancelled.pending) as Streamed).result.getReader();
        expect(cancelled.call.options.signal?.aborted).toBe(false);
        await cancelReader.cancel();
        expect(cancelled.call.options.signal?.aborted).toBe(true);
        cancelled.call.options.onChunk!("after the cancel");
        expect(cancelled.ended).toEqual([]);
        expect(cancelled.registry.liveIds()).toEqual([]);
        await cancelled.registry.dispose();
    });

    it("aborts the callback with the request while the provider runs, and sends nothing to a plugin when the prompt carries a stored credential", async () => {
        const controller = new AbortController();
        const aborted = await startProvider(pluginRecords(), { signal: controller.signal });
        controller.abort(new Error("stop"));
        expect(aborted.call.options.signal?.aborted).toBe(true);
        const outcome = await aborted.pending.then(
            (response) => ({ response }),
            (thrown: unknown) => ({ thrown: String(thrown) }),
        );
        expect(JSON.stringify(outcome)).toMatch(/stop/);
        expect(aborted.registry.liveIds()).toEqual([]);
        await aborted.registry.dispose();

        const records = pluginRecords();
        const { registry, calls: http } = harness(records, () => chat("never"));
        const built = providerSpec(records, { formated: [{ role: "user", content: `my key is ${SECRET}` }] });
        const response = await registry.runInJob(built.spec);
        expect(response).toMatchObject({ type: "fail", result: expect.stringMatching(/stored credential/) });
        expect(JSON.stringify(response)).not.toContain(SECRET);
        expect(built.calls).toEqual([]);
        expect(http).toHaveLength(0);
        await registry.dispose();
    });

    it("decodes a remembered tool call of the job's chat into the provider's tool messages, by the marker's inner text, and drops a marker the chat does not hold", async () => {
        const record: ToolCallRecord = {
            call: { id: "call_1", name: "rollDice", arg: '{"sides":6}' },
            response: [{ type: "text", text: "4" }],
        };
        const records = makeRecords();
        const { registry, calls } = harness(records, () => chat("done"));
        const built = providerSpec(records, {
            formated: [
                { role: "user", content: "roll" },
                { role: "assistant", content: "<tool_call>call_1rollDice</tool_call>\n\nI rolled." },
                { role: "assistant", content: "<tool_call>missingrollDice</tool_call>" },
            ],
            toolCalls: { call_1: record },
        });
        expect((await registry.runInJob(built.spec)).type).toBe("success");
        const sent = JSON.parse(calls[0].body).messages as Record<string, unknown>[];
        expect(sent).toContainEqual({ role: "tool", content: "4", tool_call_id: "call_1" });
        const withCall = sent.find((message) => Array.isArray(message.tool_calls)) as
            { tool_calls: { id: string; function: { name: string; arguments: string } }[] } | undefined;
        expect(withCall?.tool_calls).toEqual([
            { id: "call_1", type: "function", function: { name: "rollDice", arguments: '{"sides":6}' } },
        ]);
        expect(JSON.stringify(sent)).not.toContain("missing");
        expect(registry.liveIds()).toEqual([]);
        await registry.dispose();
    });
});

describe("the request observer (request history slice 1)", () => {
    // `LlmRequestsOptions.observer` over both entry points: `begin` at admission with the request's
    // identity, `firstByte` at most once on the layer's clock (`options.now`), `finish` exactly once
    // with the end's status; a throwing observer never reaches the request; an unobserved run makes
    // the same upstream calls and emits the same events.
    type Seen = [kind: "begin" | "firstByte" | "finish", ...rest: unknown[]];
    /** A clock that reads one more each time, from `from`. */
    const ticking = (from: number) => {
        let at = from;
        return () => at++;
    };
    /** A recording observer over `now`. */
    function observe(now: () => number = ticking(1000)) {
        const seen: Seen[] = [];
        const observer: RequestObserver = {
            begin: (request) => void seen.push(["begin", request]),
            firstByte: (requestId, at) => void seen.push(["firstByte", requestId, at]),
            finish: (requestId, end) => void seen.push(["finish", requestId, end]),
        };
        const options: Partial<LlmRequestsOptions> = { observer, now };
        return { seen, options, kinds: () => seen.map((entry) => entry[0]) };
    }
    const status = (seen: Seen[]) => (seen.at(-1)?.[2] as { status: string } | undefined)?.status;
    const firstByteAt = (seen: Seen[]) => seen.find((entry) => entry[0] === "firstByte")?.[2] as number | undefined;
    /** The events without what differs between two runs: the request id and the logs' wall clock. */
    const comparable = (events: LlmRequestEvent[]) =>
        events.map((event) =>
            event.type === "accepted"
                ? { type: "accepted" }
                : event.type === "log"
                  ? { ...event, entry: { ...(event.entry as Record<string, unknown>), date: "" } }
                  : event,
        );
    const wire = (calls: Upstream[]) => calls.map(({ url, method, body }) => ({ url, method, body }));
    const CHAT = { chaId: "c", chatId: "k" };

    it("reports a tab's buffered request: begin with its id, source, and chat, the first body chunk on the layer's clock, and a success once delivered; an unobserved run makes the same calls and emits the same events", async () => {
        const observed = observe();
        const a = harness(makeRecords(), () => chat("hi there"), observed.options);
        const ra = await run(a.registry, body({ chatRef: CHAT }));
        const b = harness(makeRecords(), () => chat("hi there"));
        const rb = await run(b.registry, body({ chatRef: CHAT }));
        expect(terminal(ra.events)).toEqual([{ type: "result", response: { type: "success", result: "hi there" } }]);
        expect(comparable(ra.events)).toEqual(comparable(rb.events));
        expect(wire(a.calls)).toEqual(wire(b.calls));
        expect(observed.seen).toEqual([
            [
                "begin",
                {
                    requestId: ra.id,
                    jobId: null,
                    source: "tab",
                    mode: "model",
                    chatRef: CHAT,
                    messageId: null,
                    startedAt: 1000,
                },
            ],
            ["firstByte", ra.id, expect.any(Number)],
            ["finish", ra.id, { status: "success", completedAt: expect.any(Number) }],
        ]);
        const at = firstByteAt(observed.seen)!;
        expect(at).toBeGreaterThan(1000);
        expect((observed.seen[2][2] as { completedAt: number }).completedAt).toBeGreaterThan(at);
        await Promise.all([a.registry.dispose(), b.registry.dispose()]);
    });

    it("classifies a tab's ends: a provider failure is an error after its first byte, a fetch that fails before any response an error without one, an empty body counts at its end, a streamed answer is one first byte and a success, a client that leaves mid-stream is aborted", async () => {
        const failed = observe();
        const a = harness(makeRecords(), () => json({ error: { message: "bad" } }, 500), failed.options);
        expect(terminal((await run(a.registry, body())).events)[0]).toMatchObject({ response: { type: "fail" } });
        expect(failed.kinds()).toEqual(["begin", "firstByte", "finish"]);
        expect(status(failed.seen)).toBe("error");

        const unreachable = observe();
        const b = harness(
            makeRecords(),
            () => {
                throw new TypeError("fetch failed");
            },
            unreachable.options,
        );
        expect(terminal((await run(b.registry, body())).events)[0]).toMatchObject({ response: { type: "fail" } });
        expect(unreachable.kinds()).toEqual(["begin", "finish"]);
        expect(status(unreachable.seen)).toBe("error");

        const empty = observe();
        const c = harness(makeRecords(), () => new Response("", { status: 200 }), empty.options);
        expect(terminal((await run(c.registry, body())).events)[0]).toMatchObject({ response: { type: "fail" } });
        expect(empty.kinds()).toEqual(["begin", "firstByte", "finish"]);
        expect(status(empty.seen)).toBe("error");

        const records = makeRecords();
        (records.providers as Record<string, unknown>).useStreaming = true;
        const frame = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] });
        const streamed = observe();
        const d = harness(records, () => sse([frame("a"), frame("b"), frame("c")]), streamed.options);
        const rd = await run(d.registry, body({ useStreaming: true }));
        expect(terminal(rd.events)).toEqual([{ type: "end" }]);
        expect(streamed.kinds()).toEqual(["begin", "firstByte", "finish"]);
        expect(status(streamed.seen)).toBe("success");

        const left = observe();
        const e = harness(records, (call) => sse([frame("a"), frame("b")], 20, call.signal), left.options);
        const controller = new AbortController();
        const re = await run(
            e.registry,
            body({ useStreaming: true }),
            (event) => {
                if (event.type === "chunk") {
                    controller.abort();
                }
            },
            controller.signal,
        );
        expect(terminal(re.events)).toEqual([{ type: "error", message: "The client went away" }]);
        expect(left.kinds()).toEqual(["begin", "firstByte", "finish"]);
        expect(status(left.seen)).toBe("aborted");
        await Promise.all([a, b, c, d, e].map((h) => h.registry.dispose()));
    });

    it("a throwing observer is logged and never reaches the request; a clock reading 0 is reported as 0", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const throwing: RequestObserver = {
            begin: () => {
                throw new Error("begin threw");
            },
            firstByte: () => {
                throw new Error("firstByte threw");
            },
            finish: () => {
                throw new Error("finish threw");
            },
        };
        const a = harness(makeRecords(), () => chat("fine"), { observer: throwing });
        const ra = await run(a.registry, body());
        expect(terminal(ra.events)).toEqual([{ type: "result", response: { type: "success", result: "fine" } }]);
        expect(a.registry.liveIds()).toEqual([]);
        const thrown = logged.mock.calls.filter((call) => call[0] === "[LLM] request observer:").map((call) => call[1]);
        expect(thrown).toEqual(["begin threw", "firstByte threw", "finish threw"]);

        const zero = observe(() => 0);
        const b = harness(makeRecords(), () => chat("fine"), zero.options);
        const rb = await run(b.registry, body());
        expect(zero.seen).toEqual([
            ["begin", expect.objectContaining({ requestId: rb.id, startedAt: 0 })],
            ["firstByte", rb.id, 0],
            ["finish", rb.id, { status: "success", completedAt: 0 }],
        ]);
        await Promise.all([a.registry.dispose(), b.registry.dispose()]);
    });

    it("reports a job's request with its job, source, chat, and message: a fail is an error, a stream read to its end a success, and the job's abort of an unread stream aborted", async () => {
        const records = makeRecords();
        const observed = observe();
        const { registry } = harness(
            records,
            (_call, index) => (index === 0 ? chat("ok") : json({ error: { message: "bad key" } }, 401)),
            observed.options,
        );
        const spec = jobSpec(records, { source: "send", chatRef: CHAT, messageId: "m1" }).spec;
        expect((await registry.runInJob(spec)).type).toBe("success");
        expect(observed.seen).toEqual([
            [
                "begin",
                {
                    requestId: expect.any(String),
                    jobId: "job",
                    source: "send",
                    mode: "model",
                    chatRef: CHAT,
                    messageId: "m1",
                    startedAt: 1000,
                },
            ],
            ["firstByte", expect.any(String), expect.any(Number)],
            ["finish", expect.any(String), { status: "success", completedAt: expect.any(Number) }],
        ]);
        const id = (observed.seen[0][1] as { requestId: string }).requestId;
        expect(observed.seen.map((entry) => entry[1])).toEqual([expect.anything(), id, id]);
        expect((await registry.runInJob(jobSpec(records).spec)).type).toBe("fail");
        expect(observed.kinds().slice(3)).toEqual(["begin", "firstByte", "finish"]);
        expect(status(observed.seen)).toBe("error");
        await registry.dispose();

        const streaming = makeRecords();
        (streaming.providers as Record<string, unknown>).useStreaming = true;
        const frame = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] });
        const read = observe();
        const normal = harness(streaming, () => sse([frame("hi"), frame(" there")]), read.options);
        const done = await normal.registry.runInJob(jobSpec(streaming, { streaming: true }).spec);
        expect(done.type).toBe("streaming");
        await (done as { result: ReadableStream<StreamResponseChunk> }).result.pipeTo(new WritableStream());
        expect(read.kinds()).toEqual(["begin", "firstByte", "finish"]);
        expect(status(read.seen)).toBe("success");

        const left = observe();
        const controller = new AbortController();
        const slow = harness(streaming, (call) => sse([frame("a"), frame("b")], 5000, call.signal), left.options);
        const open = await slow.registry.runInJob(
            jobSpec(streaming, { streaming: true, signal: controller.signal }).spec,
        );
        expect(open.type).toBe("streaming");
        await waitFor(() => left.kinds().includes("firstByte"));
        controller.abort(new Error("stop"));
        await waitFor(() => slow.registry.liveIds().length === 0);
        expect(left.kinds()).toEqual(["begin", "firstByte", "finish"]);
        expect(status(left.seen)).toBe("aborted");
        await Promise.all([normal.registry.dispose(), slow.registry.dispose()]);
    });

    it("watchFirstByte marks a body once at its first chunk, an empty body at its end, a missing body at once, never a body that fails before its first chunk, and keeps the response's status, headers, and text", async () => {
        const encode = (text: string) => new TextEncoder().encode(text);
        let marks = 0;
        const chunked = watchFirstByte(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encode("ab"));
                        controller.enqueue(encode("cd"));
                        controller.close();
                    },
                }),
                { status: 201, statusText: "Created", headers: { "x-marker": "1" } },
            ),
            () => marks++,
        );
        expect(marks).toBe(0);
        expect(await chunked.text()).toBe("abcd");
        expect(marks).toBe(1);
        expect([chunked.status, chunked.statusText, chunked.headers.get("x-marker")]).toEqual([201, "Created", "1"]);

        marks = 0;
        const empty = watchFirstByte(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.close();
                    },
                }),
            ),
            () => marks++,
        );
        expect(marks).toBe(0);
        expect(await empty.text()).toBe("");
        expect(marks).toBe(1);

        marks = 0;
        const bodiless = new Response(null, { status: 204 });
        expect(watchFirstByte(bodiless, () => marks++)).toBe(bodiless);
        expect(marks).toBe(1);

        marks = 0;
        const failing = watchFirstByte(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.error(new Error("reset"));
                    },
                }),
            ),
            () => marks++,
        );
        await expect(failing.text()).rejects.toThrow("reset");
        expect(marks).toBe(0);
    });
});
