// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMFormat } from "../../../shared/llm.ts";
import type {
    LlmRequestBody,
    LlmRequestEvent,
    StreamResponseChunk,
    ToolDescriptor,
} from "../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import {
    createRequestHistory,
    REQUEST_HISTORY_BOUNDS,
    type RequestHistory,
    type RequestHistoryRecord,
} from "../data/requestHistory.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import { createHistoryObserver } from "../llm/historyObserver.ts";
import { createRedactor } from "../llm/redact.ts";
import { createLlmRequests, type JobRequestSpec, type LlmRequestsOptions } from "../llm/requests.ts";
import { loadRequestDb, tokenScopeFor } from "../llm/settings.ts";
import {
    createTransport,
    deferFirstByte,
    type ExchangeDetail,
    type FetchLogEntry,
    STREAM_CAPTURE_BYTES,
} from "../llm/transport.ts";
import { sleep, waitFor } from "./testSupport.ts";

// Every request the server request layer admits writes its row in the durable history through
// `createHistoryObserver` (`server/src/llm/historyObserver.ts`), with its prompt, model, exchanges,
// first byte, and outcome, every content field redacted with the request's redactor at the write. The
// transport's history sink (`record`, `captures`, `teeBody`, `attempt` in
// `server/src/llm/transport.ts`): each exchange once with the bytes sent and received, a streamed
// body kept up to `STREAM_CAPTURE_BYTES` and the consumer unaffected, an unread body or a fetch still
// waiting flushed at the request's end and never recorded twice. `Redactor.trimPartial`: a credential
// cut in two at the capture bound leaves no fragment. Over the real request layer with an injected
// upstream and a real store on a temp file: the secret matrix (OpenAI bearer and a named key,
// Anthropic `x-api-key`, Gemini `?key=`, a Vertex token acquired mid-request, AWS SigV4), a streamed
// body stored and cut, a tool round, a retry, aborts while a fetch waits for its headers or its
// buffered answer, an aborted job, the Anthropic batch's exchanges and first byte (the results' first
// chunk; a `null` acknowledgement, a refused submit whose body cannot be read, an acknowledgement
// that is not JSON), and Horde's malformed submit id. The store's own rules are in
// `requestHistory.test.ts`, the observer's contract in `llmRequests.test.ts`, the HTTP wiring in
// `llmRoutes.test.ts`.

const SECRET = "sk-proxy-SENTINEL-1111";
const CLAUDE_KEY = "sk-ant-SENTINEL-3333";
const GOOGLE_KEY = "AIza-SENTINEL-4444";
const VERTEX_TOKEN = "vertex-token-SENTINEL-7777";
const BEDROCK_KEY = "AKIAEXAMPLE:bedrock-secret-SENTINEL-6666:us-east-1";
const PROVIDER = "https://mock.test/v1/chat/completions";
const CHAT = { chaId: "c", chatId: "k" };
const encode = (text: string) => new TextEncoder().encode(text);
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

// ---------------------------------------------------------------------------------------------
// The settings records, the store, and the request layer over a recording upstream (as
// `llmRequests.test.ts` builds them, plus `providers` and `secrets` overrides and the history).

type Records = Record<string, unknown> & {
    characters?: Record<string, unknown>;
    chats?: Record<string, Record<string, unknown>>;
};

function makeRecords(
    overrides: {
        preset?: Record<string, unknown>;
        secrets?: Record<string, unknown>;
        providers?: Record<string, unknown>;
    } = {},
): Records {
    const { aiModel = "reverse_proxy", ...fields } = overrides.preset ?? {};
    return {
        providers: normalizeProviders({ requestRetrys: 0, ...overrides.providers }),
        llmSecrets: normalizeLlmSecrets({
            credentials: { proxy: { key: SECRET } },
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
        personas: normalizePersonas([{ id: "u", name: "Uma" }]),
        characters: { c: { chaId: "c", name: "Cara" } },
        chats: { "c/k": { modelPresetId: "m", promptPresetId: "p", bindedPersona: "u" } },
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
const ids = {
    presetId: "p",
    modelPresetId: "m",
    personaId: "u",
    selectedPersonaId: "u",
    selectedCharacterId: "c",
    speakerId: null,
};

const dirs: string[] = [];
const stores: RequestHistory[] = [];
function openHistory(): RequestHistory {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-request-capture-"));
    dirs.push(dir);
    const store = createRequestHistory({ file: path.join(dir, "request-history.sqlite") });
    stores.push(store);
    return store;
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

type Upstream = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    at: number;
};

/**
 * The request layer over `records`, its upstream `respond`, and a fresh history written by the
 * observer. The clock reads one more each time from 1000; each upstream call notes it.
 */
function harness(
    records: Records,
    respond: (call: Upstream, index: number) => Response | Promise<Response>,
    options: Partial<LlmRequestsOptions> & { content?: boolean } = {},
) {
    const calls: Upstream[] = [];
    let tick = 1000;
    const now = () => tick++;
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
            at: now(),
        };
        calls.push(call);
        if (call.signal?.aborted) {
            throw new DOMException("This operation was aborted", "AbortError");
        }
        return await respond(call, calls.length - 1);
    }) as typeof fetch;
    const history = openHistory();
    const { content = true, ...rest } = options;
    const registry = createLlmRequests({
        store: fakeStore(records),
        kinds,
        tokens: { encode: async () => [7], count: async () => 1 } as never,
        vertexTokens: { get: async () => VERTEX_TOKEN, clear() {} } as never,
        claudeObserver: { register() {}, reset() {}, dispose() {} } as never,
        parentCallback: () => null,
        fetchImpl,
        now,
        observer: createHistoryObserver(history, { content: () => content }),
        ...rest,
    });
    return { registry, calls, history };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<LlmRequestEvent[]> {
    const events: LlmRequestEvent[] = [];
    const text = await new Response(stream).text();
    for (const frame of text.split("\n\n")) {
        if (frame.startsWith("data: ")) {
            events.push(JSON.parse(frame.slice("data: ".length)) as LlmRequestEvent);
        }
    }
    return events;
}

/** Runs one tab request to its end. */
async function run(
    registry: ReturnType<typeof createLlmRequests>,
    request: LlmRequestBody,
    signal = new AbortController().signal,
) {
    const started = registry.start(request, signal);
    if (!started.ok) {
        throw new Error(`start refused: ${started.status} ${started.error}`);
    }
    const events = await readAll(started.stream);
    return { id: started.id, events };
}

const terminal = (events: LlmRequestEvent[]) =>
    events.filter((event) => event.type === "result" || event.type === "end" || event.type === "error");
const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const chat = (content: string, extra: Record<string, unknown> = {}) =>
    json({ choices: [{ message: { role: "assistant", content, ...extra } }] });
const frame = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] });
const sseText = (frames: string[]) => frames.map((f) => `data: ${f}\n\n`).join("");
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
                for (const f of frames) {
                    if (ended) {
                        return;
                    }
                    controller.enqueue(encode(`data: ${f}\n\n`));
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
/** A response whose body yields `chunks` one per pull and then ends as `end` says. */
const chunked = (
    chunks: (string | Uint8Array)[],
    init: ResponseInit = { status: 200 },
    end: "close" | "error" | "open" = "close",
) =>
    new Response(
        new ReadableStream<Uint8Array>({
            pull(controller) {
                const next = chunks.shift();
                if (next !== undefined) {
                    controller.enqueue(typeof next === "string" ? encode(next) : next);
                    return;
                }
                if (end === "close") {
                    controller.close();
                } else if (end === "error") {
                    controller.error(new Error("reset"));
                } else {
                    return new Promise<void>(() => {});
                }
            },
        }),
        init,
    );
const afterTool = (call: Upstream) =>
    (JSON.parse(call.body).messages as { role: string }[]).some((message) => message.role === "tool");

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

/** A job's request over `records` (a `send` of chat `k`). */
function jobSpec(
    records: Records,
    options: {
        streaming?: boolean;
        signal?: AbortSignal;
        tools?: JobRequestSpec["tools"];
        formated?: unknown[];
    } = {},
): JobRequestSpec {
    const loaded = loadRequestDb(fakeStore(records), kinds, ids);
    return {
        jobId: "job",
        loaded,
        mode: "model",
        arg: {
            formated: (options.formated ?? [{ role: "user", content: "hi" }]) as never,
            bias: {},
            useStreaming: options.streaming === true,
        },
        source: "send",
        chatRef: CHAT,
        messageId: "m1",
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
        endJob: () => {},
        tools: options.tools ?? noTools(),
        toolCalls: { read: () => undefined, write: () => {} },
        signal: options.signal ?? new AbortController().signal,
    };
}

/** The newest row (a job's request has no id the caller sees). */
function newest(history: RequestHistory): RequestHistoryRecord {
    const item = history.list().items[0];
    expect(item).toBeDefined();
    return history.get(item.id)!;
}

const streamed = (row: RequestHistoryRecord) => row.exchanges!.filter((e) => e.responseType === "stream");

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------------------------

describe("the transport's history sink (record, captures, teeBody)", () => {
    type Recorded = { entry: FetchLogEntry; detail: ExchangeDetail };
    function transport(
        fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>,
        extra: { record?: boolean; onFirstByte?: () => void } = {},
    ) {
        const records: Recorded[] = [];
        const logs: FetchLogEntry[] = [];
        const captures = new Set<() => void>();
        const t = createTransport({
            signal: new AbortController().signal,
            log: (entry) => logs.push(entry),
            ...(extra.record === false ? {} : { record: (entry, detail) => void records.push({ entry, detail }) }),
            captures,
            fetchImpl: fetchImpl as typeof fetch,
            ...(extra.onFirstByte ? { onFirstByte: extra.onFirstByte } : {}),
        });
        return { t, records, logs, captures };
    }
    const URL_ = "https://mock.test/v1/stream";

    it("records a streamed fetch once at its body's end with the bytes sent and received, after the tab's pre-fetch entry, which is log-only", async () => {
        const { t, records, logs, captures } = transport(() =>
            chunked(["ab", "cd"], { status: 201, headers: { "x-marker": "1" } }),
        );
        const res = await t.fetchStream(URL_, { body: '{"q":1}', headers: { Authorization: "Bearer k" } });
        expect(logs).toEqual([expect.objectContaining({ response: "Streamed Fetch", responseType: "stream" })]);
        expect(records).toEqual([]);
        expect(captures.size).toBe(1);
        expect([res.status, res.headers.get("x-marker")]).toEqual([201, "1"]);
        expect(await res.text()).toBe("abcd");
        expect(captures.size).toBe(0);
        expect(records).toEqual([
            {
                entry: {
                    body: '{"q":1}',
                    header: JSON.stringify({ Authorization: "Bearer k" }, null, 2),
                    response: "abcd",
                    responseType: "stream",
                    success: true,
                    status: 201,
                    date: expect.any(String),
                    url: URL_,
                    chatId: undefined,
                },
                detail: { requestBytes: 7, responseBytes: 4 },
            },
        ]);
        expect(logs).toHaveLength(1);
    });

    it("keeps the first STREAM_CAPTURE_BYTES of a longer body with its cut recorded, leaves an incomplete last character out, and hands the consumer every byte", async () => {
        const head = "a".repeat(STREAM_CAPTURE_BYTES - 2);
        const { t, records } = transport(() => chunked([head, "\u{1F600}", "tail"]));
        const res = await t.fetchStream(URL_, { method: "GET" });
        expect((await res.text()).length).toBe(head.length + 2 + 4);
        expect(records).toHaveLength(1);
        const total = utf8(head) + 4 + 4;
        expect(records[0].detail).toEqual({ cuts: { response: total }, requestBytes: 0, responseBytes: total });
        expect(records[0].entry.response).toBe(head);
    });

    it("a consumer's cancel and a read failure record what was read so far, once", async () => {
        const cancelled = transport(() => chunked(["ab", "cd"], { status: 200 }, "open"));
        const res = await cancelled.t.fetchStream(URL_, { method: "GET" });
        const reader = res.body!.getReader();
        expect(await reader.read()).toEqual({ done: false, value: encode("ab") });
        // A read is pending when the cancel comes.
        const pending = reader.read();
        await reader.cancel("enough");
        expect(await pending).toMatchObject({ done: true });
        expect(cancelled.records).toHaveLength(1);
        expect(cancelled.records[0].entry).toMatchObject({ response: "ab", success: true, status: 200 });
        expect(cancelled.records[0].detail).toEqual({ requestBytes: 0, responseBytes: 2 });
        expect(cancelled.captures.size).toBe(0);

        const failing = transport(() => chunked(["ab"], { status: 200 }, "error"));
        const broken = await failing.t.fetchStream(URL_, { method: "GET" });
        await expect(broken.text()).rejects.toThrow("reset");
        expect(failing.records).toHaveLength(1);
        expect(failing.records[0].entry).toMatchObject({ response: "ab", success: true, status: 200 });
        expect(failing.records[0].detail).toEqual({ requestBytes: 0, responseBytes: 2 });
        expect(failing.captures.size).toBe(0);
    });

    it("the request's end (a captures flush) records an unread body, a fetch still waiting for its headers, and a buffered answer still being read, each with what is known; a later settle records nothing", async () => {
        // An unread body: flushed with nothing read; the bytes read later pass through uncounted.
        const unread = transport(() => chunked(["ab", "cd"]));
        const res = await unread.t.fetchStream(URL_, { body: "{}" });
        expect(unread.captures.size).toBe(1);
        for (const flush of [...unread.captures]) {
            flush();
        }
        expect(unread.captures.size).toBe(0);
        expect(unread.records).toHaveLength(1);
        expect(unread.records[0].entry).toMatchObject({ response: "", success: true, status: 200 });
        expect(unread.records[0].detail).toEqual({ requestBytes: 2, responseBytes: 0 });
        expect(await res.text()).toBe("abcd");
        expect(unread.records).toHaveLength(1);

        // Waiting for the headers: the attempt is recorded without a status; the answer that comes
        // later is neither teed nor recorded.
        let release!: (response: Response) => void;
        const waiting = transport(() => new Promise<Response>((resolve) => (release = resolve)));
        const later = waiting.t.fetchStream(URL_, { body: '{"q":1}' });
        await sleep(1);
        expect(waiting.captures.size).toBe(1);
        for (const flush of [...waiting.captures]) {
            flush();
        }
        expect(waiting.records).toHaveLength(1);
        expect(waiting.records[0].entry).toMatchObject({
            response: "The request ended before its answer was read",
            success: false,
            status: undefined,
        });
        expect(waiting.records[0].detail).toEqual({ requestBytes: 7, responseBytes: null });
        release(chunked(["late"]));
        expect(await (await later).text()).toBe("late");
        expect(waiting.records).toHaveLength(1);
        expect(waiting.captures.size).toBe(0);

        // A buffered answer still being read: recorded with its status, nothing read.
        let open!: ReadableStreamDefaultController<Uint8Array>;
        const buffered = transport(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            open = controller;
                        },
                    }),
                    { status: 200 },
                ),
        );
        const answer = buffered.t.fetchBuffered(URL_, { body: { q: 1 } });
        await sleep(1);
        expect(buffered.captures.size).toBe(1);
        for (const flush of [...buffered.captures]) {
            flush();
        }
        expect(buffered.records).toHaveLength(1);
        expect(buffered.records[0].entry).toMatchObject({
            response: "The request ended before its answer was read",
            success: false,
            status: 200,
        });
        expect(buffered.records[0].detail).toEqual({ requestBytes: utf8('{"q":1}'), responseBytes: null });
        open.enqueue(encode('{"ok":true}'));
        open.close();
        expect(await answer).toMatchObject({ ok: true, data: { ok: true }, status: 200 });
        expect(buffered.records).toHaveLength(1);
        expect(buffered.logs).toHaveLength(1);
        expect(buffered.captures.size).toBe(0);
    });

    it("a response without a body is recorded at once; a throwing sink is logged and the answer unchanged; logFetch false or no sink captures nothing and wraps nothing", async () => {
        const bodiless = transport(() => new Response(null, { status: 204 }));
        const none = await bodiless.t.fetchStream(URL_, { method: "DELETE" });
        expect(bodiless.records).toHaveLength(1);
        expect(bodiless.records[0].entry).toMatchObject({ response: "", status: 204, success: true });
        expect(bodiless.records[0].detail).toEqual({ requestBytes: 0, responseBytes: 0 });
        expect(none.body).toBeNull();
        expect(bodiless.captures.size).toBe(0);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const throwing = createTransport({
            signal: new AbortController().signal,
            log: () => {},
            record: () => {
                throw new Error("sink threw");
            },
            fetchImpl: (async () => chunked(["ab", "cd"])) as typeof fetch,
        });
        expect(await (await throwing.fetchStream(URL_, { method: "GET" })).text()).toBe("abcd");
        expect(logged.mock.calls.some((call) => call[0] === "[LLM]" && call[1] === "sink threw")).toBe(true);

        const quiet = transport(() => chunked(["ab"]));
        expect(await (await quiet.t.fetchStream(URL_, { method: "GET", logFetch: false })).text()).toBe("ab");
        expect(quiet.records).toEqual([]);
        expect(quiet.logs).toEqual([]);
        expect(quiet.captures.size).toBe(0);

        const original = chunked(["ab"]);
        const unsunk = transport(() => original, { record: false });
        const same = await unsunk.t.fetchStream(URL_, { method: "GET" });
        expect(same).toBe(original);
        expect(unsunk.captures.size).toBe(0);
        expect(unsunk.logs).toHaveLength(1);
    });

    it("a streamed fetch that fails before any response is recorded with the error and no response bytes", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { t, records, captures } = transport(() => {
            throw new TypeError("fetch failed");
        });
        await expect(t.fetchStream(URL_, { body: "{}" })).rejects.toThrow("could not reach");
        expect(records).toHaveLength(1);
        expect(records[0].entry).toMatchObject({
            response: expect.stringContaining("could not reach https://mock.test/v1/stream: fetch failed"),
            success: false,
            status: undefined,
        });
        expect(records[0].detail).toEqual({ requestBytes: 2, responseBytes: null });
        expect(captures.size).toBe(0);
    });

    it("a buffered fetch records its answer (JSON or not) with its sizes and status, and a failure after sending with no response bytes", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const answers = [json({ ok: 1 }), new Response("plain text", { status: 502 })];
        const { t, records, logs } = transport(() => answers.shift()!);
        expect(await t.fetchBuffered(URL_, { body: { q: "x" }, headers: { "x-k": "v" } })).toMatchObject({
            ok: true,
            data: { ok: 1 },
            status: 200,
        });
        expect(records[0].entry).toEqual({
            body: JSON.stringify({ q: "x" }, null, 2),
            header: JSON.stringify({ "x-k": "v" }, null, 2),
            response: JSON.stringify({ ok: 1 }, null, 2),
            success: true,
            status: 200,
            date: expect.any(String),
            url: URL_,
            chatId: undefined,
        });
        expect(records[0].detail).toEqual({ requestBytes: utf8('{"q":"x"}'), responseBytes: utf8('{"ok":1}') });
        expect(await t.fetchBuffered(URL_, { body: { q: "y" } })).toMatchObject({ ok: false, status: 502 });
        expect(records[1].entry).toMatchObject({ response: '"plain text"', success: false, status: 502 });
        expect(records[1].detail).toEqual({ requestBytes: utf8('{"q":"y"}'), responseBytes: utf8("plain text") });
        expect(logs).toHaveLength(2);

        const failing = transport(() => {
            throw new TypeError("fetch failed");
        });
        expect(await failing.t.fetchBuffered(URL_, { body: { q: 1 } })).toMatchObject({ ok: false, status: 400 });
        expect(failing.records).toHaveLength(1);
        expect(failing.records[0].entry).toMatchObject({
            response: expect.stringContaining("could not reach"),
            success: false,
            status: undefined,
        });
        expect(failing.records[0].detail).toEqual({ requestBytes: utf8('{"q":1}'), responseBytes: null });
        // The tab's log never had the failed attempt.
        expect(failing.logs).toEqual([]);
        expect(failing.captures.size).toBe(0);
    });

    it("an adapter's addLog is recorded as it is, with its logged texts' sizes", () => {
        const { t, records, logs } = transport(() => json({}));
        t.addLog({ body: { a: 1 }, response: "héllo", success: true, url: URL_, status: 200 });
        expect(logs).toHaveLength(1);
        expect(records).toHaveLength(1);
        expect(records[0].entry).toMatchObject({ body: JSON.stringify({ a: 1 }, null, 2), response: "héllo" });
        expect(records[0].detail).toEqual({ requestBytes: utf8(JSON.stringify({ a: 1 }, null, 2)), responseBytes: 6 });
    });

    it("firstByte: false leaves a call's answer out of onFirstByte; deferFirstByte keeps the first chunk's time and reports it only on answered()", async () => {
        let marks = 0;
        const { t } = transport(() => chunked(["ab"]), { onFirstByte: () => marks++ });
        expect(await (await t.fetchStream(URL_, { method: "GET", firstByte: false })).text()).toBe("ab");
        expect(marks).toBe(0);
        expect(await (await t.fetchStream(URL_, { method: "GET" })).text()).toBe("ab");
        expect(marks).toBe(1);

        let tick = 50;
        const marked: number[] = [];
        const hook = { mark: (at?: number) => void marked.push(at!), now: () => tick++ };
        const deferred = deferFirstByte(chunked(["x", "y"], { status: 202 }), hook);
        deferred.answered();
        expect(marked).toEqual([]);
        expect(await deferred.response.text()).toBe("xy");
        expect(marked).toEqual([]);
        deferred.answered();
        expect(marked).toEqual([50]);
        expect(deferred.response.status).toBe(202);
        // Without a hook, nothing is wrapped.
        const plain = chunked(["z"]);
        const bare = deferFirstByte(plain, undefined);
        expect(bare.response).toBe(plain);
        bare.answered();
    });
});

describe("Redactor.trimPartial", () => {
    it("removes a trailing proper prefix of any secret form, the earliest cut winning, and leaves every other text as it is", () => {
        const redactor = createRedactor(["sk-long-secret-value", "ab", "q"]);
        expect(redactor.trimPartial("text sk-long-secret-val")).toBe("text ");
        expect(redactor.trimPartial("text sk-long-secret-value")).toBe("text sk-long-secret-value");
        expect(redactor.trimPartial("text s")).toBe("text ");
        expect(redactor.trimPartial("text a")).toBe("text ");
        // A one-character form has no proper prefix.
        expect(redactor.trimPartial("text q")).toBe("text q");
        expect(redactor.trimPartial("nothing here")).toBe("nothing here");
        expect(redactor.trimPartial("")).toBe("");
        // The JSON-escaped form of a secret with a quote: its prefix ends the text.
        const quoted = createRedactor(['k"ey']);
        expect(quoted.trimPartial('x k\\"e')).toBe("x ");
        expect(quoted.trimPartial("x k")).toBe("x ");
        // After `text`, a whole secret is already gone and the trailing partial is the only trace.
        const secret = "sk-proxy-SENTINEL-1111";
        const run = createRedactor([secret]);
        expect(run.trimPartial(run.text(`${secret} ${secret} ${secret.slice(0, 9)}`))).toBe("[redacted] [redacted] ");
    });
});

describe("the history observer (createHistoryObserver)", () => {
    const entry = (overrides: Partial<FetchLogEntry> = {}): FetchLogEntry => ({
        url: "https://api.example/v1",
        header: "{}",
        body: "{}",
        response: "ok",
        success: true,
        date: "d",
        ...overrides,
    });
    const begin = (requestId: string) => ({
        requestId,
        jobId: "job",
        source: "send" as const,
        mode: "model" as const,
        chatRef: CHAT,
        messageId: "m1",
        startedAt: 5,
    });

    it("writes the row from begin to finish: identity, prompt, model, first byte, every exchange with the summed bytes and the last status, the error; a late exchange reaches the store but not the totals", () => {
        const history = openHistory();
        const observer = createHistoryObserver(history, { content: () => true });
        observer.begin(begin("r"));
        expect(history.get("r")).toMatchObject({
            jobId: "job",
            source: "send",
            mode: "model",
            chaId: "c",
            chatId: "k",
            messageId: "m1",
            startedAt: 5,
            status: "pending",
            content: true,
            prompt: null,
        });
        observer.prompt!("r", '[{"role":"user"}]');
        observer.describe!("r", {
            modelId: "gpt",
            profileId: "main",
            profileName: "Main",
            provider: "OpenAICompatible",
        });
        observer.firstByte("r", 7);
        observer.exchange!("r", entry({ status: 200 }), { requestBytes: 10, responseBytes: 20 });
        observer.exchange!("r", entry({ status: undefined, success: false }), { requestBytes: 5, responseBytes: null });
        observer.finish("r", { status: "error", completedAt: 9 }, { error: "boom" });
        expect(history.get("r")).toMatchObject({
            prompt: '[{"role":"user"}]',
            modelId: "gpt",
            profileId: "main",
            profileName: "Main",
            provider: "OpenAICompatible",
            firstByteAt: 7,
            completedAt: 9,
            status: "error",
            error: "boom",
            httpStatus: null,
            requestBytes: 15,
            responseBytes: 20,
            exchangeCount: 2,
        });
        observer.exchange!("r", entry({ status: 500 }), { requestBytes: 100, responseBytes: 100 });
        expect(history.get("r")).toMatchObject({
            exchangeCount: 3,
            requestBytes: 15,
            responseBytes: 20,
            httpStatus: null,
        });

        observer.begin(begin("s"));
        observer.exchange!("s", entry({ status: 401 }), { requestBytes: 1, responseBytes: 2 });
        observer.finish("s", { status: "success", completedAt: 9 });
        expect(history.get("s")).toMatchObject({ httpStatus: 401, requestBytes: 1, responseBytes: 2, error: null });

        // The totals count every exchange, also the ones past the 32 the store keeps.
        observer.begin(begin("t"));
        for (let i = 0; i < REQUEST_HISTORY_BOUNDS.exchanges + 1; i++) {
            observer.exchange!("t", entry({ status: 200 }), { requestBytes: 1, responseBytes: 2 });
        }
        observer.finish("t", { status: "success", completedAt: 9 });
        expect(history.get("t")).toMatchObject({
            exchangeCount: 33,
            storedExchanges: 32,
            requestBytes: 33,
            responseBytes: 66,
            httpStatus: 200,
        });
    });

    it("with content off the row is a summary: no prompt, no exchanges, the totals and the error kept", () => {
        const history = openHistory();
        const observer = createHistoryObserver(history, { content: () => false });
        observer.begin(begin("r"));
        observer.prompt!("r", "[]");
        observer.exchange!("r", entry({ status: 200 }), { requestBytes: 3, responseBytes: 4 });
        observer.finish("r", { status: "error", completedAt: 9 }, { error: "bad", providerCode: "overloaded_error" });
        expect(history.get("r")).toMatchObject({
            content: false,
            prompt: null,
            exchanges: null,
            exchangeCount: 0,
            httpStatus: 200,
            requestBytes: 3,
            responseBytes: 4,
            error: "bad",
            providerCode: "overloaded_error",
        });
        // The provider code of the end: stored when it is one, null otherwise or when absent.
        observer.begin(begin("s"));
        observer.finish("s", { status: "error", completedAt: 9 }, { error: "bad", providerCode: "not a code" });
        expect(history.get("s")).toMatchObject({ error: "bad", providerCode: null });
        observer.begin(begin("t"));
        observer.finish("t", { status: "error", completedAt: 9 }, { error: "bad" });
        expect(history.get("t")).toMatchObject({ error: "bad", providerCode: null });
    });

    it("a content getter that throws counts as off: the row is still written, as a summary, with a warning", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const history = openHistory();
            let throws = true;
            const observer = createHistoryObserver(history, {
                content: () => {
                    if (throws) {
                        throw new Error("settings unreadable");
                    }
                    return true;
                },
            });
            observer.begin(begin("r"));
            observer.prompt!("r", "[]");
            observer.exchange!("r", entry({ status: 200 }), { requestBytes: 3, responseBytes: 4 });
            observer.finish("r", { status: "success", completedAt: 9 });
            expect(history.get("r")).toMatchObject({
                status: "success",
                content: false,
                prompt: null,
                exchanges: null,
                exchangeCount: 0,
                httpStatus: 200,
                requestBytes: 3,
                responseBytes: 4,
            });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain("Could not read the content setting");
            // The getter is read at every begin: once it answers again, the next row has its content.
            throws = false;
            observer.begin(begin("s"));
            observer.prompt!("s", "[]");
            expect(history.get("s")).toMatchObject({ content: true, prompt: "[]" });
            expect(history.get("r")).toMatchObject({ content: false, prompt: null });
        } finally {
            warn.mockRestore();
        }
    });
});

// ---------------------------------------------------------------------------------------------

describe("a request's row (over the request layer)", () => {
    it("a tab's buffered request: the row with its chat, prompt (redacted), model, first byte, one exchange with its sizes and status, and a success", async () => {
        const { registry, calls, history } = harness(makeRecords(), () => chat("hi there"));
        const { id, events } = await run(
            registry,
            body({ chatRef: CHAT, formated: [{ role: "user", content: `my key is ${SECRET}` }] }),
        );
        expect(terminal(events)).toEqual([{ type: "result", response: { type: "success", result: "hi there" } }]);
        const row = history.get(id)!;
        const answer = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi there" } }] });
        expect(row).toMatchObject({
            jobId: null,
            source: "tab",
            mode: "model",
            chaId: "c",
            chatId: "k",
            messageId: null,
            modelId: "reverse_proxy",
            profileId: "main",
            profileName: "main",
            provider: "OpenAICompatible",
            startedAt: 1000,
            status: "success",
            httpStatus: 200,
            error: null,
            requestBytes: utf8(calls[0].body),
            responseBytes: utf8(answer),
            content: true,
            exchangeCount: 1,
            storedExchanges: 1,
            truncated: false,
            prompt: JSON.stringify([{ role: "user", content: "my key is [redacted]" }]),
        });
        expect(row.firstByteAt).toBeGreaterThan(row.startedAt);
        expect(row.completedAt).toBeGreaterThan(row.firstByteAt!);
        expect(row.exchanges).toHaveLength(1);
        const [exchange] = row.exchanges!;
        expect(exchange).toMatchObject({ url: PROVIDER, success: true, status: 200, responseType: null });
        expect(JSON.parse(exchange.header)).toMatchObject({ Authorization: "[redacted]" });
        expect(JSON.parse(exchange.body)).toMatchObject({ model: "mock-model", messages: [{ role: "user" }] });
        expect(JSON.parse(exchange.response)).toEqual(JSON.parse(answer));
        expect(JSON.stringify(row)).not.toContain(SECRET);
        expect(calls[0].headers.authorization).toBe(`Bearer ${SECRET}`);
        await registry.dispose();
    });

    it("with content off the row is a summary with the totals (and a failure's provider code, read from the exchange the store does not keep); a request refused before its settings load ends as an error with no prompt", async () => {
        const off = harness(
            makeRecords(),
            (_call, index) =>
                index === 0
                    ? chat("x")
                    : json({ error: { message: "Overloaded, try later", type: "overloaded_error" } }, 529),
            { content: false },
        );
        const { id } = await run(off.registry, body());
        expect(off.history.get(id)).toMatchObject({
            content: false,
            prompt: null,
            exchanges: null,
            status: "success",
            httpStatus: 200,
            requestBytes: utf8(off.calls[0].body),
            modelId: "reverse_proxy",
            providerCode: null,
        });
        const failed = await run(off.registry, body());
        expect(off.history.get(failed.id)).toMatchObject({
            content: false,
            exchanges: null,
            status: "error",
            httpStatus: 529,
            providerCode: "overloaded_error",
            error: expect.stringContaining("Overloaded"),
        });
        const gone = harness(makeRecords(), () => chat("x"));
        const missing = await run(gone.registry, { ...body(), context: { ...body().context, presetId: "missing" } });
        expect(gone.history.get(missing.id)).toMatchObject({
            status: "error",
            error: "The request's preset no longer exists",
            prompt: null,
            modelId: null,
            exchangeCount: 0,
            httpStatus: null,
        });
        await Promise.all([off.registry.dispose(), gone.registry.dispose()]);
    });

    it("a secret never reaches the database (prompt, body, header, URL, response, error): OpenAI bearer with a named key, Anthropic x-api-key, Gemini ?key=, a Vertex token acquired mid-request, AWS SigV4 headers", async () => {
        const cases: {
            name: string;
            records: Records;
            secrets: string[];
            /** Where the credential reaches the upstream (the test is only meaningful if it does). */
            sent: (call: Upstream) => string | undefined;
            /** The secrets that are on the wire (SigV4 sends the access key id, never the secret key). */
            onWire?: string[];
            /** What the prompt carries: the stored credentials (a token acquired later cannot be in it). */
            inPrompt?: string[];
            urlCheck?: (url: string) => void;
        }[] = [
            {
                name: "OpenAI bearer (the named key `proxy`)",
                records: makeRecords(),
                secrets: [SECRET],
                sent: (call) => call.headers.authorization,
            },
            {
                name: "Anthropic x-api-key",
                records: makeRecords({
                    preset: { aiModel: "claude-sonnet-4-5-20250929" },
                    secrets: { claudeAPIKey: CLAUDE_KEY },
                }),
                secrets: [CLAUDE_KEY],
                sent: (call) => call.headers["x-api-key"],
            },
            {
                name: "Gemini ?key=",
                records: makeRecords({
                    preset: { aiModel: "gemini-2.5-flash" },
                    secrets: { google: { accessToken: GOOGLE_KEY, projectId: "proj-1" } },
                }),
                secrets: [GOOGLE_KEY],
                sent: (call) => call.url,
                urlCheck: (url) => expect(url).toContain("key=[redacted]"),
            },
            {
                name: "a Vertex token acquired mid-request",
                records: makeRecords({
                    preset: { aiModel: "gemini-2.5-flash-vertex" },
                    providers: { vertexRegion: "us-central1" },
                    secrets: {
                        google: { accessToken: "", projectId: "proj-1" },
                        vertexClientEmail: "svc@proj.iam.gserviceaccount.com",
                        vertexPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
                    },
                }),
                secrets: [VERTEX_TOKEN],
                sent: (call) => call.headers.authorization,
                // The token is added to the redactor when it is acquired, after the prompt was
                // written; the prompt carries a stored credential instead.
                inPrompt: [SECRET],
            },
            {
                name: "AWS SigV4 (Bedrock)",
                records: makeRecords({
                    preset: { aiModel: "anthropic.claude-opus-4-6-v1" },
                    secrets: { claudeAPIKey: BEDROCK_KEY },
                }),
                secrets: ["AKIAEXAMPLE", "bedrock-secret-SENTINEL-6666"],
                sent: (call) => call.headers.authorization,
                onWire: ["AKIAEXAMPLE"],
            },
        ];
        for (const c of cases) {
            // The upstream refuses, echoing what it was sent (the header, the URL) in its error.
            const { registry, calls, history } = harness(c.records, (call) =>
                json(
                    {
                        error: {
                            message: `bad key ${call.headers.authorization} ${call.headers["x-api-key"]} ${call.url}`,
                        },
                    },
                    401,
                ),
            );
            const inPrompt = c.inPrompt ?? c.secrets;
            const { id } = await run(
                registry,
                body({ formated: [{ role: "user", content: `my secrets: ${inPrompt.join(" ")}` }] }),
            );
            expect(calls.length, c.name).toBeGreaterThan(0);
            for (const secret of c.onWire ?? c.secrets) {
                expect(c.sent(calls[0]), c.name).toContain(secret);
            }
            const row = history.get(id)!;
            expect(row.status, c.name).toBe("error");
            expect(row.prompt, c.name).toBe(
                JSON.stringify([
                    { role: "user", content: `my secrets: ${inPrompt.map(() => "[redacted]").join(" ")}` },
                ]),
            );
            // One exchange per upstream call.
            expect(row.exchangeCount, c.name).toBe(calls.length);
            expect(row.exchanges!.length, c.name).toBe(calls.length);
            expect(row.error, c.name).toEqual(expect.any(String));
            c.urlCheck?.(row.exchanges![0].url);
            const text = JSON.stringify(row);
            for (const secret of [...c.secrets, ...inPrompt]) {
                expect(text, c.name).not.toContain(secret);
                expect(text, c.name).not.toContain(encodeURIComponent(secret));
            }
            await registry.dispose();
        }
    });

    it("a streamed answer is stored as the raw stream with its sizes, once per fetch (no placeholder beside the teed body)", async () => {
        const records = makeRecords({ providers: { useStreaming: true } });
        const frames = [frame("a"), frame("b"), frame("c")];
        const { registry, calls, history } = harness(records, () => sse(frames));
        const { id, events } = await run(registry, body({ useStreaming: true }));
        expect(terminal(events)).toEqual([{ type: "end" }]);
        const row = history.get(id)!;
        expect(row).toMatchObject({ status: "success", httpStatus: 200 });
        const [exchange] = streamed(row);
        expect(exchange).toMatchObject({
            url: PROVIDER,
            success: true,
            status: 200,
            responseType: "stream",
            response: sseText(frames),
        });
        expect(JSON.parse(exchange.body)).toMatchObject({ model: "mock-model", stream: true });
        expect(JSON.parse(exchange.header)).toMatchObject({ Authorization: "[redacted]" });
        // One fetch, one exchange: the adapter's post-fetch `addLog({ response: "Streaming" })`
        // placeholder (`openAI/requests.ts`) must not be a second one beside the teed body, as the
        // Gemini one was removed.
        expect(row.exchanges!.map((e) => e.response)).toEqual([sseText(frames)]);
        expect(row.exchangeCount).toBe(1);
        expect(row.requestBytes).toBe(utf8(calls[0].body));
        expect(row.responseBytes).toBe(utf8(sseText(frames)));
        await registry.dispose();
    });

    /** A streamed job request whose upstream refuses with `text` (read whole by the adapter). */
    async function refusedStream(text: string) {
        const records = makeRecords({ providers: { useStreaming: true } });
        const { registry, history } = harness(records, () =>
            chunked([text], { status: 400, headers: { "content-type": "text/plain" } }),
        );
        const response = await registry.runInJob(jobSpec(records, { streaming: true }));
        expect(response.type).toBe("fail");
        const row = newest(history);
        await registry.dispose();
        return { row, exchange: streamed(row)[0] };
    }

    it("a streamed body over the bound is stored cut at 4 MiB with the cut recorded, and counted whole", async () => {
        const text = "x".repeat(STREAM_CAPTURE_BYTES + 100 * 1024);
        const { row, exchange } = await refusedStream(text);
        expect(row).toMatchObject({ status: "error", httpStatus: 400, responseBytes: utf8(text), truncated: true });
        expect(exchange.success).toBe(false);
        expect(utf8(exchange.response)).toBe(REQUEST_HISTORY_BOUNDS.response);
        expect(row.truncation["exchange.0.response"]).toEqual({
            originalBytes: utf8(text),
            storedBytes: REQUEST_HISTORY_BOUNDS.response,
        });
    }, 20_000);

    it("a credential crossing the capture cut leaves no fragment, also when earlier redaction shrinks the text under the store's bound", async () => {
        // The capture ends 10 characters into a credential; the many credentials before it shrink
        // the redacted text well under 4 MiB, so the store would keep the fragment.
        const unit = `${SECRET} `;
        const head = STREAM_CAPTURE_BYTES - 10;
        const repeats = Math.floor(head / unit.length);
        const text = `${unit.repeat(repeats)}${"a".repeat(head - repeats * unit.length)}${SECRET} tail`;
        const { row, exchange } = await refusedStream(text);
        expect(row.responseBytes).toBe(utf8(text));
        expect(exchange.response).not.toContain(SECRET.slice(0, 4));
        expect(exchange.response.endsWith("[redacted] ") || exchange.response.endsWith("a")).toBe(true);
        expect(exchange.response.startsWith("[redacted] [redacted] ")).toBe(true);
        expect(utf8(exchange.response)).toBeLessThan(REQUEST_HISTORY_BOUNDS.response);
        expect(row.truncation["exchange.0.response"]).toMatchObject({ originalBytes: utf8(text) });
        expect(JSON.stringify(row)).not.toContain(SECRET);
    }, 20_000);

    it("a character split at the capture cut is left out rather than stored as a replacement character", async () => {
        const unit = `${SECRET} `;
        const head = STREAM_CAPTURE_BYTES - 2;
        const repeats = Math.floor((head - 1) / unit.length);
        const text = `${unit.repeat(repeats)}${"a".repeat(head - repeats * unit.length)}\u{1F600}tail`;
        const { row, exchange } = await refusedStream(text);
        expect(row.responseBytes).toBe(utf8(text));
        expect(exchange.response.endsWith("a")).toBe(true);
        expect(exchange.response).not.toContain("�");
        expect(utf8(exchange.response)).toBeLessThan(REQUEST_HISTORY_BOUNDS.response);
    }, 20_000);

    it("a buffered tool round is two exchanges in one row, with the bytes of both", async () => {
        const echo: ToolDescriptor = {
            name: "echo",
            description: "The echo tool",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
        };
        const toolCall = { id: "call-1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } };
        const records = makeRecords();
        const { registry, calls, history } = harness(records, (call) =>
            afterTool(call) ? chat("done") : chat("", { tool_calls: [toolCall] }),
        );
        const tools: JobRequestSpec["tools"] = {
            descriptors: [echo],
            charge: () => true,
            limit: 64,
            call: async () => [{ type: "text", text: "echoed hi" }],
        };
        const response = await registry.runInJob(jobSpec(records, { tools }));
        expect(response).toMatchObject({ type: "success", result: expect.stringMatching(/done$/) });
        expect(calls).toHaveLength(2);
        const row = newest(history);
        expect(row).toMatchObject({
            jobId: "job",
            source: "send",
            chaId: "c",
            chatId: "k",
            messageId: "m1",
            status: "success",
            exchangeCount: 2,
            storedExchanges: 2,
            httpStatus: 200,
            requestBytes: utf8(calls[0].body) + utf8(calls[1].body),
        });
        expect(row.exchanges!.map((e) => e.url)).toEqual([PROVIDER, PROVIDER]);
        expect(row.exchanges![0].response).toContain("tool_calls");
        expect(row.exchanges![1].response).toContain("done");
        expect(JSON.parse(row.exchanges![1].body).messages).toContainEqual(
            expect.objectContaining({ role: "tool", content: "echoed hi" }),
        );
        const answers = [
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: [toolCall] } }] }),
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }),
        ];
        expect(row.responseBytes).toBe(utf8(answers[0]) + utf8(answers[1]));
        await registry.dispose();
    });

    it("a retry is two rows with the same jobId, each with its own exchange", async () => {
        const records = makeRecords();
        const { registry, history } = harness(records, (_call, index) =>
            index === 0 ? json({ error: { message: "overloaded" } }, 500) : chat("second time"),
        );
        const spec = jobSpec(records);
        expect((await registry.runInJob(spec)).type).toBe("fail");
        expect((await registry.runInJob(spec)).type).toBe("success");
        const rows = history.list({ jobId: "job" }).items;
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.id)).size).toBe(2);
        // Newest first.
        expect(rows.map((r) => [r.status, r.httpStatus, r.storedExchanges])).toEqual([
            ["success", 200, 1],
            ["error", 500, 1],
        ]);
        expect(history.get(rows[1].id)!.error).toContain("overloaded");
        expect(history.get(rows[0].id)!.exchanges![0].response).toContain("second time");
        await registry.dispose();
    });

    it("a tab's request aborted while its fetch waits for the headers records that attempt before the end, without a status and without a duplicate", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { registry, calls, history } = harness(
            makeRecords(),
            (call) =>
                new Promise<Response>((_, reject) =>
                    call.signal.addEventListener("abort", () =>
                        reject(new DOMException("This operation was aborted", "AbortError")),
                    ),
                ),
        );
        const controller = new AbortController();
        const started = registry.start(body(), controller.signal);
        if (!started.ok) {
            throw new Error(started.error);
        }
        const events = readAll(started.stream);
        await waitFor(() => calls.length === 1);
        controller.abort();
        expect(terminal(await events)).toEqual([{ type: "error", message: "The client went away" }]);
        await waitFor(() => registry.liveIds().length === 0);
        // The fetch's rejection is processed after the end: it must not add a second exchange.
        await sleep(10);
        const row = history.get(started.id)!;
        expect(row).toMatchObject({
            status: "aborted",
            error: "The client went away",
            exchangeCount: 1,
            httpStatus: null,
            requestBytes: utf8(calls[0].body),
            responseBytes: 0,
        });
        expect(row.exchanges![0]).toMatchObject({
            url: PROVIDER,
            response: "The request ended before its answer was read",
            success: false,
            status: null,
        });
        expect(JSON.parse(row.exchanges![0].header)).toMatchObject({ Authorization: "[redacted]" });
        await registry.dispose();
    });

    it("a tab's request aborted while its buffered answer is being read records that exchange with its status before the end, once", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { registry, calls, history } = harness(
            makeRecords(),
            (call) =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            call.signal.addEventListener("abort", () =>
                                controller.error(new DOMException("aborted", "AbortError")),
                            );
                        },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );
        const controller = new AbortController();
        const started = registry.start(body(), controller.signal);
        if (!started.ok) {
            throw new Error(started.error);
        }
        const events = readAll(started.stream);
        await waitFor(() => calls.length === 1);
        await sleep(5);
        controller.abort();
        expect(terminal(await events)).toEqual([{ type: "error", message: "The client went away" }]);
        await waitFor(() => registry.liveIds().length === 0);
        await sleep(10);
        const row = history.get(started.id)!;
        expect(row).toMatchObject({
            status: "aborted",
            exchangeCount: 1,
            httpStatus: 200,
            requestBytes: utf8(calls[0].body),
            responseBytes: 0,
        });
        expect(row.exchanges![0]).toMatchObject({
            response: "The request ended before its answer was read",
            success: false,
            status: 200,
        });
        await registry.dispose();
    });

    it("an aborted job's request ends aborted with the reason, its stream's capture flushed with what was read", async () => {
        const records = makeRecords({ providers: { useStreaming: true } });
        const { registry, history } = harness(records, (call) => sse([frame("a"), frame("b")], 5000, call.signal));
        const controller = new AbortController();
        const open = await registry.runInJob(jobSpec(records, { streaming: true, signal: controller.signal }));
        expect(open.type).toBe("streaming");
        const reader = (open as { result: ReadableStream<StreamResponseChunk> }).result.getReader();
        expect((await reader.read()).value).toEqual({ "0": "a" });
        controller.abort(new Error("stop"));
        await expect(reader.read()).rejects.toThrow("stop");
        await waitFor(() => registry.liveIds().length === 0);
        await sleep(10);
        const row = newest(history);
        expect(row).toMatchObject({ status: "aborted", error: "stop", httpStatus: 200 });
        expect(row.firstByteAt).not.toBeNull();
        const [exchange] = streamed(row);
        expect(exchange).toMatchObject({ success: true, status: 200, response: sseText([frame("a")]) });
        expect(streamed(row)).toHaveLength(1);
        // The totals are those of the exchanges flushed before the end.
        expect(row.responseBytes).toBe(row.exchanges!.reduce((sum, e) => sum + utf8(e.response), 0));

        // A reader that cancels the stream ends the request aborted with its reason.
        const cancelled = await registry.runInJob(jobSpec(records, { streaming: true }));
        expect(cancelled.type).toBe("streaming");
        const stream = (cancelled as { result: ReadableStream<StreamResponseChunk> }).result;
        const second = stream.getReader();
        expect((await second.read()).value).toEqual({ "0": "a" });
        await second.cancel(new Error("enough"));
        await waitFor(() => registry.liveIds().length === 0);
        expect(newest(history)).toMatchObject({ status: "aborted", error: "enough", httpStatus: 200 });
        await registry.dispose();
    });
});

describe("the Anthropic batch's exchanges and first byte", () => {
    const BATCHES = "https://api.anthropic.com/v1/messages/batches";
    const records = () =>
        makeRecords({
            preset: { aiModel: "claude-sonnet-4-5-20250929" },
            secrets: { claudeAPIKey: CLAUDE_KEY },
            providers: { claudeBatching: true },
        });
    const jsonl = (text: string) =>
        new Response(
            JSON.stringify({
                custom_id: "x",
                result: { type: "succeeded", message: { content: [{ type: "text", text }] } },
            }) + "\n",
            { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );

    /** Runs a batch request under fake timers, advancing the poll sleeps until it ends. */
    async function runBatch(respond: (call: Upstream, index: number) => Response) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { registry, calls, history } = harness(records(), respond);
        let settled = false;
        const pending = run(registry, body()).finally(() => (settled = true));
        for (let i = 0; !settled && i < 8; i++) {
            await vi.advanceTimersByTimeAsync(3000);
        }
        const result = await pending;
        const row = history.get(result.id)!;
        await registry.dispose();
        return { result, calls, row };
    }

    it("the first byte is the results' first chunk, not the acknowledgement's nor a pending poll's; the submit, the final poll, and the results are the exchanges", async () => {
        let polls = 0;
        const { result, calls, row } = await runBatch((call) => {
            if (call.method === "POST") {
                return json({ id: "batch-1" });
            }
            if (call.url.endsWith("/results")) {
                return jsonl("batch says");
            }
            return json({ processing_status: ++polls < 2 ? "in_progress" : "ended" });
        });
        expect(terminal(result.events)).toEqual([{ type: "end" }]);
        expect(calls.map((c) => [c.method, c.url])).toEqual([
            ["POST", BATCHES],
            ["GET", `${BATCHES}/batch-1`],
            ["GET", `${BATCHES}/batch-1`],
            ["GET", `${BATCHES}/batch-1/results`],
        ]);
        expect(calls[0].headers["x-api-key"]).toBe(CLAUDE_KEY);
        expect(row.status).toBe("success");
        expect(row.firstByteAt).toBeGreaterThan(calls[3].at);
        expect(row.completedAt).toBeGreaterThan(row.firstByteAt!);
        expect(row.exchanges!.map((e) => [e.url, e.success, e.status, e.body === ""])).toEqual([
            [BATCHES, true, 200, false],
            [`${BATCHES}/batch-1`, true, 200, true],
            [`${BATCHES}/batch-1/results`, true, 200, true],
        ]);
        expect(row.exchangeCount).toBe(3);
        expect(JSON.parse(row.exchanges![0].header)).toMatchObject({ "x-api-key": "[redacted]" });
        expect(JSON.parse(row.exchanges![0].body)).toMatchObject({
            requests: [{ params: { model: expect.any(String) } }],
        });
        expect(row.exchanges![1].response).toContain("ended");
        expect(row.exchanges![2].response).toContain("batch says");
        expect(JSON.stringify(row)).not.toContain(CLAUDE_KEY);
    });

    it("a `null` acknowledgement, a refused submit whose body cannot be read, and an acknowledgement that is not JSON each end the request with the submit's first byte and one exchange", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const nul = await runBatch(() => json(null));
        expect(terminal(nul.result.events)[0]).toMatchObject({
            type: "result",
            response: { type: "fail", result: "No results URL returned from Claude batch request" },
        });
        expect(nul.calls).toHaveLength(1);
        expect(nul.row).toMatchObject({ status: "error", exchangeCount: 1, httpStatus: 200 });
        expect(nul.row.firstByteAt).toBeGreaterThan(nul.calls[0].at);
        expect(nul.row.exchanges![0]).toMatchObject({ url: BATCHES, response: "null", success: false, status: 200 });

        const refused = await runBatch(() => chunked(["rate "], { status: 429 }, "error"));
        expect(terminal(refused.result.events)[0]).toMatchObject({ type: "error", message: "reset" });
        expect(refused.row).toMatchObject({ status: "error", error: "reset", exchangeCount: 1, httpStatus: 429 });
        expect(refused.row.firstByteAt).toBeGreaterThan(refused.calls[0].at);
        expect(refused.row.exchanges![0]).toMatchObject({
            url: BATCHES,
            success: false,
            status: 429,
            response: expect.stringContaining("The refused batch's answer could not be read: reset"),
        });

        const garbled = await runBatch(() => new Response("not json", { status: 200 }));
        expect(terminal(garbled.result.events)[0]).toMatchObject({ type: "error" });
        expect(garbled.row).toMatchObject({ status: "error", exchangeCount: 1, httpStatus: 200 });
        expect(garbled.row.firstByteAt).toBeGreaterThan(garbled.calls[0].at);
        expect(garbled.row.exchanges![0]).toMatchObject({
            success: false,
            status: 200,
            response: expect.stringContaining("The batch acknowledgement could not be read"),
        });
    });
});

describe("Horde's malformed submit id", () => {
    it("ends the request as an error with the submit's first byte; the row has no exchanges (Horde fetches outside the transport)", async () => {
        const realFetch = globalThis.fetch;
        const urls: string[] = [];
        globalThis.fetch = (async (input: string) => {
            urls.push(input);
            return json({ id: 42, kudos: 1, message: "" }, 202);
        }) as typeof fetch;
        try {
            const records = makeRecords({
                preset: { aiModel: "horde:::auto" },
                secrets: { hordeConfig: { apiKey: "horde-SENTINEL-key", model: "", softPrompt: "" } },
            });
            const { registry, history } = harness(records, () => json({}));
            const { id, events } = await run(registry, body());
            expect(terminal(events)).toEqual([{ type: "error", message: "Horde did not return a request id" }]);
            expect(urls).toEqual(["https://stablehorde.net/api/v2/generate/text/async"]);
            const row = history.get(id)!;
            expect(row).toMatchObject({
                status: "error",
                error: "Horde did not return a request id",
                provider: "Horde",
                exchangeCount: 0,
                exchanges: [],
                httpStatus: null,
            });
            expect(row.firstByteAt).toBeGreaterThan(row.startedAt);
            expect(JSON.stringify(row)).not.toContain("horde-SENTINEL-key");
            await registry.dispose();
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});
