// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from "../../../shared/llm.ts";
import type { RequestContext } from "../llm/context.ts";
import { __testResponsesAPI, requestOpenAIResponseAPI } from "../llm/openAI/responses.ts";
import type { RequestDataArgumentExtended } from "../llm/request.ts";
import type { RequestDb } from "../llm/settings.ts";

// The OpenAI Responses adapter (`server/src/llm/openAI/responses.ts`) at the helper level, through
// its `__testResponsesAPI` seam and `requestOpenAIResponseAPI` over a fake request context: the body
// builder (roles, multimodals, tools, the parameters and the reasoning effort mapping), the endpoint,
// auth and header wiring per model kind, the additional parameters, the text extraction, the
// failure shapes, the continuation sanitization for `store: false`, the tool continuations
// (buffered and streaming) and the SSE parser. Phase 6 slice 11: these are the cases of the deleted
// browser test of the Responses helpers (`src/ts/process/request/openAI/`, the pre-cutover client
// code's), retargeted at the server port; its browser module mocks are the context's dependencies
// here (`ctx.transport` for `globalFetch`/`fetchNative`, `ctx.tools.call` for `callTool`). The
// streaming `response.failed` case lives in `llmRequests.test.ts` ("redacts a provider error the
// adapter put into the answer text").

/** The settings the adapter reads (`ctx.db`): the deleted test's flat database object. */
const settings = () => ({
    OaiCompAPIKeys: {} as Record<string, string>,
    additionalParams: [] as [string, string][],
    applyAdditionalParamsToAll: false,
    autofillRequestUrl: false,
    customModels: [] as { id: string; params: string; key: string }[],
    gptVisionQuality: "high",
    jsonSchema:
        '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}',
    jsonSchemaEnabled: false,
    localNetworkMode: false,
    modelTools: [] as string[],
    newOAIHandle: true,
    nanogptKey: "nanogpt-key",
    nanogptProvider: "",
    nanogptRequestModel: "nanogpt-model",
    nanogptUseSubscriptionEndpoint: false,
    openAIKey: "openai-key",
    proxyKey: "proxy-key",
    requestRetrys: 0,
    reasoningEffort: 2,
    seperateParametersEnabled: false,
    simplifiedToolUse: false,
    strictJsonSchema: true,
    temperature: 70,
    top_p: 0.9,
    verbosity: 0,
});

const db = settings();
const transport = {
    fetchBuffered: vi.fn(),
    fetchStream: vi.fn(),
    addLog: vi.fn(() => 0),
};
const tools = {
    call: vi.fn(),
    encode: vi.fn(),
    decode: vi.fn(),
};
const ctx: RequestContext = {
    db: db as unknown as RequestDb,
    selectedCharacterName: null,
    speakerName: null,
    userName: "User",
    signal: new AbortController().signal,
    transport,
    alertError: vi.fn(),
    redactText: (text) => text,
    tokenizeNum: async () => [],
    strongBan: async (_text, bias) => bias,
    parseCbs: async (text) => text,
    tools,
    inlays: {
        saveSignature: async (id) => id,
        writeImage: async (image) => image.id,
        setAsset: async () => {},
    },
    intercept: async (body) => body,
    supportsInlayImage: () => false,
    getModelInfo: () => {
        throw new Error("not resolved here");
    },
    vertexAccessToken: async () => "",
    registerClaudeObserver: () => {},
};

const baseArg = (overrides: Record<string, unknown> = {}): RequestDataArgumentExtended =>
    ({
        ctx,
        aiModel: "gpt-5-response-api",
        bias: {},
        biasString: [],
        formated: [
            { role: "system", content: "Follow policy." },
            {
                role: "user",
                content: "Describe this.",
                multimodals: [{ type: "image", base64: "data:image/png;base64,abc" }],
            },
            { role: "assistant", content: "Previous assistant prefill" },
            {
                role: "user",
                content: "Also read file.",
                multimodals: [{ type: "audio", base64: "data:application/pdf;base64,def" }],
            },
        ],
        maxTokens: 321,
        mode: "model",
        modelInfo: {
            flags: [LLMFlags.DeveloperRole],
            format: LLMFormat.OpenAIResponseAPI,
            id: "gpt-5-response-api",
            internalID: "gpt-5",
            name: "GPT-5 Responses",
            parameters: ["temperature", "top_p", "reasoning_effort", "verbosity"],
            provider: LLMProvider.OpenAI,
            tokenizer: LLMTokenizer.Unknown,
        },
        tools: [],
        ...overrides,
    }) as unknown as RequestDataArgumentExtended;

async function collectStream(stream: ReadableStream<Record<string, string>>) {
    const reader = stream.getReader();
    const chunks: Record<string, string>[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            return chunks;
        }
        chunks.push(value);
    }
}

function sseStream(events: string[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const event of events) {
                controller.enqueue(encoder.encode(event));
            }
            controller.close();
        },
    });
}

/** A `fetchStream` answer: the `Response` the adapter reads (`status`, the content type, `body`). */
const streamResponse = (events: string[]) =>
    ({
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: sseStream(events),
    }) as unknown as Response;

describe("OpenAI Responses API helpers", () => {
    beforeEach(() => {
        transport.fetchBuffered.mockReset();
        transport.fetchStream.mockReset();
        transport.addLog.mockReset();
        tools.call.mockReset();
        tools.encode.mockReset();
        tools.decode.mockReset();
        Object.assign(db, settings());
    });

    it("builds a Responses request body for text, developer role, multimodal input, tools, and model parameters", async () => {
        db.modelTools = ["search"];
        const sourceMessages = baseArg().formated;

        const body = await __testResponsesAPI.buildResponsesBody(
            baseArg({
                formated: sourceMessages,
                schema: '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}',
                tools: [
                    {
                        name: "lookup",
                        description: "Lookup data",
                        inputSchema: { type: "object", properties: { query: { type: "string" } } },
                    },
                ],
            }),
        );

        expect(body).toMatchObject({
            model: "gpt-5",
            max_output_tokens: 321,
            store: false,
            temperature: 0.7,
            top_p: 0.9,
            reasoning: { effort: "high", summary: "auto" },
            text: {
                verbosity: "low",
                format: {
                    type: "json_schema",
                    name: "format",
                    strict: true,
                },
            },
        });
        expect(body.input[0]).toMatchObject({
            role: "developer",
            content: [{ type: "input_text", text: "Follow policy." }],
        });
        expect(body.input[1].content).toEqual([
            { type: "input_text", text: "Describe this." },
            { type: "input_image", detail: "high", image_url: "data:image/png;base64,abc" },
        ]);
        expect(body.input[2]).toMatchObject({
            role: "assistant",
            type: "message",
            content: [{ type: "output_text", text: "Previous assistant prefill", annotations: [] }],
        });
        expect(body.input[3].content).toEqual([
            { type: "input_text", text: "Also read file." },
            { type: "input_file", file_data: "data:application/pdf;base64,def" },
        ]);
        // The tool's schema passes through the server's real `simplifySchema` (the browser test
        // mocked it as the identity): a plain object schema comes out as it went in.
        expect(body.tools).toEqual([
            {
                type: "function",
                name: "lookup",
                description: "Lookup data",
                parameters: { type: "object", properties: { query: { type: "string" } } },
            },
            { type: "web_search_preview" },
        ]);
        expect(sourceMessages[1]).toMatchObject({
            role: "user",
            content: "Describe this.",
            multimodals: [{ type: "image", base64: "data:image/png;base64,abc" }],
        });
    });

    it("requests reasoning summaries for Responses reasoning models", async () => {
        const body = await __testResponsesAPI.buildResponsesBody(baseArg());

        expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    });

    it("maps Responses reasoning effort none when the model supports it", async () => {
        db.reasoningEffort = -1;

        const body = await __testResponsesAPI.buildResponsesBody(
            baseArg({
                modelInfo: {
                    ...baseArg().modelInfo,
                    parameters: ["reasoning_effort", "reasoning_effort_none"],
                },
            }),
        );

        expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
    });

    it("maps Responses reasoning low to medium for min-medium models", async () => {
        db.reasoningEffort = 0;

        const body = await __testResponsesAPI.buildResponsesBody(
            baseArg({
                modelInfo: {
                    ...baseArg().modelInfo,
                    parameters: ["reasoning_effort", "reasoning_effort_min_medium"],
                },
            }),
        );

        expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    });

    it("maps Responses reasoning effort xhigh when the model supports it", async () => {
        db.reasoningEffort = 3;

        const body = await __testResponsesAPI.buildResponsesBody(
            baseArg({
                modelInfo: {
                    ...baseArg().modelInfo,
                    parameters: ["reasoning_effort", "reasoning_effort_xhigh"],
                },
            }),
        );

        expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    });

    it("does not request reasoning summaries for Responses non-reasoning models", async () => {
        const body = await __testResponsesAPI.buildResponsesBody(
            baseArg({
                modelInfo: {
                    ...baseArg().modelInfo,
                    parameters: ["temperature", "top_p", "verbosity"],
                },
            }),
        );

        expect(body.reasoning?.summary).toBeUndefined();
    });

    it("lets reverse proxy additional params override Responses reasoning summaries", async () => {
        db.additionalParams = [["reasoning.summary", "detailed"]];

        const result = await requestOpenAIResponseAPI(
            baseArg({
                aiModel: "reverse_proxy",
                customURL: "https://proxy.example/v1/responses",
                previewBody: true,
            }),
        );

        expect(result.type).toBe("success");
        const preview = JSON.parse(result.result as string);
        expect(preview.body.reasoning).toEqual({ effort: "high", summary: "detailed" });
    });

    it("uses OpenAI defaults and an externally clean non-streaming body", async () => {
        transport.fetchBuffered.mockResolvedValueOnce({
            ok: true,
            data: { output_text: "ok" },
        });

        const result = await requestOpenAIResponseAPI(baseArg());

        expect(result).toEqual({ type: "success", result: "ok" });
        expect(transport.fetchBuffered).toHaveBeenCalledWith(
            "https://api.openai.com/v1/responses",
            expect.objectContaining({
                body: expect.objectContaining({
                    model: "gpt-5",
                    stream: false,
                }),
                headers: expect.objectContaining({ Authorization: "Bearer openai-key" }),
            }),
        );
        expect(transport.fetchBuffered.mock.calls[0][1].body).not.toHaveProperty("__lastOutput");
    });

    it("leaves system messages as system without the developer-role flag", async () => {
        const body = await __testResponsesAPI.buildResponsesBody(
            baseArg({
                modelInfo: {
                    ...baseArg().modelInfo,
                    flags: [],
                },
            }),
        );

        expect(body.input[0]).toMatchObject({
            role: "system",
            content: [{ type: "input_text", text: "Follow policy." }],
        });
    });

    it("applies custom model Responses endpoint, key, and additional params", async () => {
        db.OaiCompAPIKeys = { customKey: "custom-key" };
        db.customModels = [
            {
                id: "xcustom:::responses",
                params: 'header::X-Custom=yes\nmetadata.tier=gold\nextra=json::{"enabled":true}',
                key: "",
            },
        ];

        const result = await requestOpenAIResponseAPI(
            baseArg({
                aiModel: "xcustom:::responses",
                previewBody: true,
                modelInfo: {
                    ...baseArg().modelInfo,
                    endpoint: "https://custom.example/v1/responses",
                    keyIdentifier: "customKey",
                },
            }),
        );

        expect(result.type).toBe("success");
        const preview = JSON.parse(result.result as string);
        expect(preview.url).toBe("https://custom.example/v1/responses");
        expect(preview.headers.Authorization).toBe("Bearer custom-key");
        expect(preview.headers["X-Custom"]).toBe("yes");
        expect(preview.body.metadata.tier).toBe("gold");
        expect(preview.body.extra).toEqual({ enabled: true });
    });

    // The server's `extractResponsesText` is async (its JSON extraction may ask the tab to parse
    // CBS); the browser oracle's was synchronous. The results are the same.
    it("does not duplicate top-level output_text when message output blocks are also present", async () => {
        const text = await __testResponsesAPI.extractResponsesText(
            {
                output_text: "final text",
                output: [{ type: "message", content: [{ type: "output_text", text: "final text" }] }],
            },
            baseArg(),
        );

        expect(text).toBe("final text");
    });

    it("preserves reasoning summaries and refusal-only responses", async () => {
        expect(
            await __testResponsesAPI.extractResponsesText(
                {
                    output: [
                        { type: "reasoning", summary: [{ text: "reasoned" }] },
                        { type: "message", content: [{ type: "output_text", text: "answer" }] },
                    ],
                },
                baseArg(),
            ),
        ).toBe("<Thoughts>\n\nreasoned\n\n</Thoughts>\nanswer");

        expect(
            await __testResponsesAPI.extractResponsesText(
                {
                    output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot comply." }] }],
                },
                baseArg(),
            ),
        ).toBe("Cannot comply.");
    });

    it("extracts OpenRouter-style reasoning content reasoning_text with final output_text", async () => {
        const text = await __testResponsesAPI.extractResponsesText(
            {
                output: [
                    {
                        id: "rs_tmp_15f15eqwfj4",
                        type: "reasoning",
                        status: "completed",
                        content: [{ type: "reasoning_text", text: "Hmm, the user just greeted me..." }],
                        summary: [],
                        format: "unknown",
                    },
                    { type: "message", content: [{ type: "output_text", text: "Hello there!" }] },
                ],
            },
            baseArg(),
        );

        expect(text).toBe("<Thoughts>\n\nHmm, the user just greeted me...\n\n</Thoughts>\nHello there!");
    });

    it("does not add an empty thoughts block for OpenAI-style empty reasoning summaries", async () => {
        const text = await __testResponsesAPI.extractResponsesText(
            {
                output: [
                    { id: "rs_0d1786ac1d609512016a07343fdca8819ca2d651a07a09a86d", type: "reasoning", summary: [] },
                    { type: "message", content: [{ type: "output_text", text: "Only final answer." }] },
                ],
            },
            baseArg(),
        );

        expect(text).toBe("Only final answer.");
    });

    it("treats incomplete non-streaming Responses results as failures even when partial text exists", async () => {
        transport.fetchBuffered.mockResolvedValueOnce({
            ok: true,
            data: {
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output_text: "partial",
            },
        });

        const result = await requestOpenAIResponseAPI(baseArg());

        expect(result).toEqual({ type: "fail", result: "Incomplete response: max_output_tokens\npartial" });
    });

    it("treats failed non-streaming Responses results as useful failures", async () => {
        transport.fetchBuffered.mockResolvedValueOnce({
            ok: true,
            data: {
                status: "failed",
                error: { message: "bad request" },
            },
        });

        const result = await requestOpenAIResponseAPI(baseArg());

        expect(result).toEqual({ type: "fail", result: '{"message":"bad request"}' });
    });

    it("handles an omitted aiModel in the Responses path without crashing", async () => {
        const result = await requestOpenAIResponseAPI(
            baseArg({
                aiModel: undefined,
                previewBody: true,
                modelInfo: {
                    ...baseArg().modelInfo,
                    internalID: undefined,
                },
            }),
        );

        expect(result.type).toBe("success");
        const preview = JSON.parse(result.result as string);
        expect(preview.url).toBe("https://api.openai.com/v1/responses");
        expect(preview.body.model).toBe("gpt-4.1");
    });

    it("wires NanoGPT Responses endpoint, model, auth, and provider header", async () => {
        db.nanogptProvider = "provider-a";

        const result = await requestOpenAIResponseAPI(
            baseArg({
                aiModel: "nanogpt",
                previewBody: true,
                modelInfo: {
                    ...baseArg().modelInfo,
                    internalID: "nanogpt",
                    format: LLMFormat.NanoGPTResponses,
                },
            }),
        );

        expect(result.type).toBe("success");
        const preview = JSON.parse(result.result as string);
        expect(preview.url).toBe("https://nano-gpt.com/api/v1/responses");
        expect(preview.body.model).toBe("nanogpt-model");
        expect(preview.headers.Authorization).toBe("Bearer nanogpt-key");
        expect(preview.headers["X-Provider"]).toBe("provider-a");
    });

    it("applies reverse proxy Responses endpoint autofill and additional params", async () => {
        db.autofillRequestUrl = true;
        db.additionalParams = [
            ["header::X-Test", "ok"],
            ["metadata.source", "risu"],
        ];

        const result = await requestOpenAIResponseAPI(
            baseArg({
                aiModel: "reverse_proxy",
                customURL: "https://proxy.example/api",
                previewBody: true,
                key: undefined,
            }),
        );

        expect(result.type).toBe("success");
        const preview = JSON.parse(result.result as string);
        expect(preview.url).toBe("https://proxy.example/api/v1/responses");
        expect(preview.headers.Authorization).toBe("Bearer proxy-key");
        expect(preview.headers["X-Test"]).toBe("ok");
        expect(preview.body.metadata.source).toBe("risu");
    });

    it("strips internal Responses continuation state from external request bodies", () => {
        const body: any = {
            model: "gpt-5",
            store: false,
            input: [
                {
                    id: "rs_reasoning_bad",
                    type: "reasoning",
                    content: [{ type: "reasoning_text", text: "private reasoning" }],
                    summary: [],
                },
                {
                    id: "fc_bad",
                    type: "function_call",
                    call_id: "call_1",
                    name: "lookup",
                    arguments: "{}",
                    status: "completed",
                },
            ],
            __lastOutput: [{ type: "function_call", call_id: "call_1" }],
        };
        const external = __testResponsesAPI.toExternalResponsesBody(body);

        body.input.push({ id: "later_mutation", type: "message", role: "assistant", content: [] });

        expect(external).toEqual({
            model: "gpt-5",
            store: false,
            input: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" }],
        });
        expect(JSON.stringify(external.input)).not.toContain("rs_reasoning_bad");
        expect(JSON.stringify(external.input)).not.toContain("private reasoning");
    });

    it("sanitizes non-streaming Responses tool continuation input with reasoning before a function call for store false", async () => {
        tools.call.mockResolvedValueOnce([{ type: "text", text: "tool result" }]);
        transport.fetchBuffered
            .mockResolvedValueOnce({
                ok: true,
                data: {
                    output: [
                        {
                            id: "rs_reasoning_bad",
                            type: "reasoning",
                            summary: [],
                        },
                        {
                            id: "fc_allowed_server_id",
                            type: "function_call",
                            call_id: "call_lookup_1",
                            name: "lookup",
                            arguments: '{"count":100,"offset":0}',
                            status: "completed",
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                data: { output_text: "final answer" },
            });

        const result = await requestOpenAIResponseAPI(
            baseArg({
                tools: [
                    {
                        name: "lookup",
                        description: "Lookup data",
                        inputSchema: {
                            type: "object",
                            properties: { count: { type: "number" }, offset: { type: "number" } },
                        },
                    },
                ],
            }),
        );

        expect(result).toEqual({ type: "success", result: "final answer" });
        expect(transport.fetchBuffered).toHaveBeenCalledTimes(2);
        const followupBody = transport.fetchBuffered.mock.calls[1][1].body;
        const followupInputJSON = JSON.stringify(followupBody.input);
        expect(followupInputJSON).not.toContain("rs_reasoning_bad");
        expect(followupInputJSON).not.toContain("fc_allowed_server_id");
        expect(followupBody.input).toEqual(
            expect.arrayContaining([
                {
                    type: "function_call",
                    call_id: "call_lookup_1",
                    name: "lookup",
                    arguments: '{"count":100,"offset":0}',
                    status: "completed",
                },
                {
                    type: "function_call_output",
                    call_id: "call_lookup_1",
                    output: "tool result",
                },
            ]),
        );
    });

    it("sanitizes streaming Responses tool continuation input for store false", async () => {
        tools.call.mockResolvedValueOnce([{ type: "text", text: "stream tool result" }]);
        transport.fetchStream
            .mockResolvedValueOnce(
                streamResponse([
                    'data: {"type":"response.completed","response":{"output_text":"Need a lookup","output":[{"id":"rs_stream_ignored","type":"function_call","call_id":"call_stream_1","name":"lookup","arguments":"{\\"query\\":\\"x\\"}","status":"completed"}]}}\n\n',
                ]),
            )
            .mockResolvedValueOnce(
                streamResponse([
                    'data: {"type":"response.completed","response":{"output_text":"stream final","output":[{"type":"message","content":[{"type":"output_text","text":"stream final"}]}]}}\n\n',
                ]),
            );

        const result = await requestOpenAIResponseAPI(
            baseArg({
                useStreaming: true,
                tools: [
                    {
                        name: "lookup",
                        description: "Lookup data",
                        inputSchema: { type: "object", properties: { query: { type: "string" } } },
                    },
                ],
            }),
        );

        expect(result.type).toBe("streaming");
        await collectStream(result.result as ReadableStream<Record<string, string>>);
        expect(transport.fetchStream).toHaveBeenCalledTimes(2);
        const followupBody = JSON.parse(transport.fetchStream.mock.calls[1][1].body as string);
        expect(JSON.stringify(followupBody.input)).not.toContain("rs_stream_ignored");
        expect(followupBody.input).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "function_call",
                    call_id: "call_stream_1",
                    name: "lookup",
                    arguments: '{"query":"x"}',
                    status: "completed",
                }),
                expect.objectContaining({
                    type: "function_call_output",
                    call_id: "call_stream_1",
                    output: "stream tool result",
                }),
            ]),
        );
        expect(followupBody.input.find((item: any) => item.type === "function_call")).not.toHaveProperty("id");
    });

    it("parses split CRLF SSE chunks, final unterminated events, text deltas, and function call deltas", async () => {
        const stream = __testResponsesAPI.getResponsesTranStream(baseArg());
        const chunksPromise = collectStream(stream.readable);
        const writer = stream.writable.getWriter();
        const encoder = new TextEncoder();

        await writer.write(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hel"}\r\n\r'));
        await writer.write(encoder.encode('\ndata: {"type":"response.output_text.delta","delta":"lo"}\r\n\r\n'));
        await writer.write(
            encoder.encode(
                'data: {"type":"response.function_call_arguments.delta","call_id":"call_1","delta":"{\\"q\\":"}\r\n\r\n',
            ),
        );
        await writer.write(
            encoder.encode(
                'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}","status":"completed"}}',
            ),
        );
        await writer.close();

        const chunks = await chunksPromise;
        expect(chunks.at(-1)).toEqual({
            "0": "Hello",
            __tool_calls: JSON.stringify({
                call_1: {
                    type: "function_call",
                    call_id: "call_1",
                    name: "lookup",
                    arguments: '{"q":"x"}',
                    status: "completed",
                },
            }),
        });
    });

    it("does not duplicate text from a completed streaming event", async () => {
        const stream = __testResponsesAPI.getResponsesTranStream(baseArg());
        const chunksPromise = collectStream(stream.readable);
        const writer = stream.writable.getWriter();
        const encoder = new TextEncoder();

        await writer.write(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'));
        await writer.write(
            encoder.encode(
                'data: {"type":"response.completed","response":{"output_text":"Hello","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}]}}\n\n',
            ),
        );
        await writer.close();

        const chunks = await chunksPromise;
        expect(chunks.at(-1)?.["0"]).toBe("Hello");
    });

    it("streams reasoning_text deltas as thoughts", async () => {
        const stream = __testResponsesAPI.getResponsesTranStream(baseArg());
        const chunksPromise = collectStream(stream.readable);
        const writer = stream.writable.getWriter();
        const encoder = new TextEncoder();

        await writer.write(encoder.encode('data: {"type":"response.reasoning_text.delta","delta":"Thinking"}\n\n'));
        await writer.write(encoder.encode('data: {"type":"response.output_text.delta","delta":"Answer"}\n\n'));
        await writer.close();

        const chunks = await chunksPromise;
        expect(chunks.at(-1)?.["0"]).toBe("<Thoughts>\n\nThinking\n\n</Thoughts>\nAnswer");
    });

    it("uses completed streaming reasoning content without duplicating final output text", async () => {
        const stream = __testResponsesAPI.getResponsesTranStream(baseArg());
        const chunksPromise = collectStream(stream.readable);
        const writer = stream.writable.getWriter();
        const encoder = new TextEncoder();

        await writer.write(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'));
        await writer.write(
            encoder.encode(
                'data: {"type":"response.completed","response":{"output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"Reasoned once"}],"summary":[]},{"type":"message","content":[{"type":"output_text","text":"Hello"}]}]}}\n\n',
            ),
        );
        await writer.close();

        const chunks = await chunksPromise;
        expect(chunks.at(-1)?.["0"]).toBe("<Thoughts>\n\nReasoned once\n\n</Thoughts>\nHello");
    });
});
