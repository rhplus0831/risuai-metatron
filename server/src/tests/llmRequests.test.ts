// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { LLMFormat } from "../../../shared/llm.ts";
import type { LlmRequestBody, LlmRequestEvent } from "../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizePresets } from "../../../shared/presets.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { CallbackResult } from "../../../shared/jobs.ts";
import { createLlmRequests, MAX_REQUESTS_PER_CLIENT, type LlmRequestsOptions } from "../llm/requests.ts";
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

type Records = Record<string, unknown> & { characters?: Record<string, unknown> };

function makeRecords(overrides: { preset?: Record<string, unknown>; secrets?: Record<string, unknown> } = {}): Records {
    return {
        providers: normalizeProviders({}),
        llmSecrets: normalizeLlmSecrets({ presets: { p: { proxyKey: SECRET } }, ...overrides.secrets }),
        ui: { autoSuggestPrefix: "" },
        customModels: [],
        presets: normalizePresets([
            {
                id: "p",
                name: "p",
                aiModel: "reverse_proxy",
                forceReplaceUrl: PROVIDER,
                customProxyRequestModel: "mock-model",
                customAPIFormat: LLMFormat.OpenAICompatible,
                ...overrides.preset,
            },
        ]),
        personas: normalizePersonas([
            { id: "u", name: "Uma" },
            { id: "b", name: "Bound" },
        ]),
        characters: { c: { chaId: "c", name: "Cara" }, s: { chaId: "s", name: "Speaker" } },
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
    } as unknown as ResourceStore;
}

const kinds = { get: (name: string) => ({ name }) } as unknown as ResourceKindRegistry;

function body(arg: Record<string, unknown> = {}, extra: Partial<LlmRequestBody> = {}): LlmRequestBody {
    return {
        clientId: "client-a",
        mode: "model",
        context: {
            presetId: "p",
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
    it("reads the preset's model and the stored proxy key, logs the upstream call with its credential masked, and answers one result", async () => {
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
        const records = makeRecords({
            preset: { aiModel: "ollama-hosted" },
        });
        (records.providers as Record<string, unknown>).ollamaURL = "http://ollama.test";
        (records.providers as Record<string, unknown>).ollamaModel = "llama";
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
        const { registry } = harness(makeRecords({ secrets: { presets: { p: { proxyKey: "q7" } } } }), (call) =>
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
        const records = makeRecords({ preset: { aiModel: "ollama-hosted" } });
        (records.providers as Record<string, unknown>).ollamaURL = "http://ollama.test";
        (records.providers as Record<string, unknown>).ollamaModel = "llama";
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
