// @vitest-environment node
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMFlags, LLMFormat } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import type { RequestArgs, StreamResponseChunk, ToolDescriptor } from "../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { RequestContext } from "../llm/context.ts";
import { requestChatDataMain } from "../llm/request.ts";
import { loadRequestDb } from "../llm/settings.ts";
import { createTransport } from "../llm/transport.ts";

// Exercise the public adapter boundary with real transport and explicit upstream reads.
// Oracles below are the SSE/delta contract, not captures of the current implementation.
const encoder = new TextEncoder();
const openai = (text: string) => ({ choices: [{ index: 0, delta: { content: text } }] });
const gemini = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const anthropic = (text: string) => ({ type: "content_block_delta", delta: { type: "text_delta", text } });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const providers = [
    { name: "OpenAI", modelId: "gpt4o", event: openai },
    { name: "Google", modelId: "gemini-2.5-flash", event: gemini },
    { name: "Vertex", modelId: "gemini-2.5-flash-vertex", event: gemini },
    { name: "Anthropic", modelId: "claude-3-5-sonnet-latest", event: anthropic },
];
const echo: ToolDescriptor = { name: "echo", description: "Echo a value", inputSchema: {} };
const callDelta = (args: string, first = true) => ({
    index: 0,
    ...(first
        ? { id: "call-1", type: "function", function: { name: "echo", arguments: args } }
        : {
              function: { arguments: args },
          }),
});

function response(chunks: (string | Uint8Array)[]) {
    let next = 0;
    return new Response(
        new ReadableStream<Uint8Array>({
            pull(controller) {
                if (next === chunks.length) return controller.close();
                const chunk = chunks[next++];
                controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            },
        }),
        { headers: { "content-type": "text/event-stream" } },
    );
}

type Options = {
    arg?: Partial<RequestArgs> & { saveSignatures?: boolean };
    profile?: Record<string, unknown>;
    tools?: ToolDescriptor[];
    controller?: AbortController;
    saveSignature?: RequestContext["inlays"]["saveSignature"];
};

async function start(modelId: string, upstream: (round: number) => Response, options: Options = {}) {
    const records: Record<string, unknown> = {
        providers: normalizeProviders({ useStreaming: true, requestRetrys: 0, streamGeminiThoughts: false }),
        llmSecrets: normalizeLlmSecrets({
            openAIKey: "fake-openai",
            claudeAPIKey: "fake-claude",
            google: { accessToken: "fake-google", projectId: "test-project" },
            vertexClientEmail: "test@example.test",
            vertexPrivateKey: "fake-private-key",
        }),
        ui: { autoSuggestPrefix: "" },
        customModels: [],
        credentials: [],
        presets: normalizePresets([{ id: "p", name: "Prompt", maxResponse: 500 }]),
        modelProfiles: normalizeModelProfiles([{ id: "main", name: "Connection", modelId, ...options.profile }]),
        modelPresets: normalizeModelPresets([{ id: "m", name: "Model", mainSlot: { profileId: "main" } }]),
        personas: normalizePersonas([{ id: "u", name: "User" }]),
    };
    const loaded = loadRequestDb(
        {
            readRefs: (refs: { kind: { name: string }; id: string }[]) => ({
                items: refs.map((ref) => ({
                    kind: ref.kind.name,
                    id: ref.id,
                    revision: null,
                    data: records[ref.kind.name] ?? null,
                })),
            }),
        } as never,
        { get: (name: string) => ({ name }) } as never,
        {
            presetId: "p",
            modelPresetId: "m",
            personaId: "u",
            selectedPersonaId: "u",
            selectedCharacterId: null,
            speakerId: null,
        },
    );
    const { db } = loaded;
    const controller = options.controller ?? new AbortController();
    const requests: Record<string, any>[] = [];
    const transport = createTransport({
        signal: controller.signal,
        log: () => {},
        fetchImpl: async (_input, init) => {
            const body = init?.body;
            requests.push(JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)));
            return upstream(requests.length);
        },
    });
    const call = vi.fn<RequestContext["tools"]["call"]>(async () => [{ type: "text", text: "tool-result" }]);
    // vi.fn observes rejected promises itself. Record manually so removing the adapter's
    // rejection handler really exposes an unhandled rejection to the test runner.
    const signatures: Parameters<RequestContext["inlays"]["saveSignature"]>[] = [];
    const saveSignature: RequestContext["inlays"]["saveSignature"] = (...args) => {
        signatures.push(args);
        return (options.saveSignature ?? (async (id) => id))(...args);
    };
    const intercept = vi.fn<RequestContext["intercept"]>(async (body) => body);
    const ctx: RequestContext = {
        db,
        selectedCharacterName: null,
        speakerName: null,
        userName: "User",
        signal: controller.signal,
        transport,
        alertError: () => {},
        redactText: (text) => text.replaceAll("fake-claude", "[REDACTED]"),
        tokenizeNum: async () => [7],
        strongBan: async (_text, bias) => bias,
        parseCbs: async (text) => text,
        tools: { call, encode: async () => "<tool_call>call-1</tool_call>", decode: async () => undefined },
        inlays: { saveSignature, writeImage: async (image) => image.id, setAsset: async () => {} },
        intercept,
        supportsInlayImage: () => false,
        getModelInfo: (id, profile = db) =>
            resolveModelInfo(id, {
                enableCustomFlags: profile.enableCustomFlags,
                customFlags: profile.customFlags,
                customModels: db.customModels,
            }),
        vertexAccessToken: async () => "fake-vertex",
        registerClaudeObserver: () => {},
    };
    const result = await requestChatDataMain(
        {
            formated: [{ role: "user", content: "Hello" }],
            bias: {},
            useStreaming: true,
            ...options.arg,
            tools: options.tools ?? [],
        },
        "model",
        ctx,
    );
    if (result.type !== "streaming") throw new Error(`Expected a stream: ${JSON.stringify(result)}`);
    return {
        stream: result.result as ReadableStream<StreamResponseChunk>,
        requests,
        call,
        signatures,
        intercept,
        controller,
    };
}

async function drain(stream: ReadableStream<StreamResponseChunk>) {
    const chunks: StreamResponseChunk[] = [];
    for await (const chunk of stream) chunks.push(structuredClone(chunk));
    for (const chunk of chunks) expect(chunk).toHaveProperty("0", expect.any(String));
    return chunks;
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    vi.stubGlobal(
        "fetch",
        vi.fn(() => {
            throw new Error("Unexpected real network call");
        }),
    );
});
afterEach(async () => {
    await setImmediate();
    process.off("unhandledRejection", onUnhandled);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(unhandled).toEqual([]);
});

describe.each(providers)("$name SSE", ({ modelId, event }) => {
    it("parses each event once and emits one cumulative snapshot per applicable read", async () => {
        const raw = JSON.stringify(event("x"));
        const wire = frame(event("x"));
        const count = 24;
        // One read, one event per read, two events per read, and one byte per read.
        const layouts = [
            { chunks: [wire.repeat(count)], step: count },
            { chunks: Array(count).fill(wire), step: 1 },
            { chunks: Array(count / 2).fill(wire.repeat(2)), step: 2 },
            { chunks: Array.from(encoder.encode(wire.repeat(count)), (byte) => Uint8Array.of(byte)), step: 1 },
        ];
        const parse = JSON.parse;
        for (const { chunks, step } of layouts) {
            let parses = 0;
            const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
                if (text === raw) parses++;
                return parse(text, reviver);
            });
            try {
                const run = await start(modelId, () => response(chunks));
                const snapshots = await drain(run.stream);
                expect(parses, `exact frame parses for ${chunks.length} reads`).toBe(count);
                expect(snapshots.map((chunk) => chunk["0"])).toEqual(
                    Array.from({ length: count / step }, (_, i) => "x".repeat((i + 1) * step)),
                );
            } finally {
                spy.mockRestore();
            }
        }
    });

    it("skips only malformed lines and accepts compact data, CRLF, and both EOF endings", async () => {
        for (const ending of ["\n", "", "\r"]) {
            const run = await start(modelId, () =>
                response([
                    frame({}),
                    `: keepalive\nevent: message\nid: ignored\n${frame(event("A"))}data: {broken\n` +
                        `data:${JSON.stringify(event("B"))}\r\n` +
                        `data:${JSON.stringify(event("C"))}${ending}`,
                ]),
            );
            expect((await drain(run.stream)).map((chunk) => chunk["0"])).toEqual(
                ending === "\n" ? ["", "ABC"] : ["", "AB", "ABC"],
            );
        }
    });

    it("preserves UTF-8 characters across every byte split inside a character", async () => {
        const text = "한글🙂";
        const bytes = encoder.encode(frame(event(text)));
        // A continuation byte identifies every possible cut inside a UTF-8 character.
        const cuts = Array.from(bytes.keys()).filter((i) => (bytes[i] & 0xc0) === 0x80);
        for (const cut of cuts) {
            const run = await start(modelId, () => response([bytes.slice(0, cut), bytes.slice(cut)]));
            expect(await drain(run.stream), `byte split ${cut}`).toEqual([{ "0": text }]);
        }
    });
});

describe("OpenAI deltas and tool metadata", () => {
    it.each(["reasoning", "reasoning_content"])(
        "concatenates overlapping content, %s, and tool arguments",
        async (reasoningKey) => {
            const delta = (text: string, args: string, first: boolean) =>
                frame({
                    choices: [
                        {
                            index: 0,
                            delta: {
                                content: text,
                                [reasoningKey]: text,
                                tool_calls: [callDelta(args, first)],
                            },
                        },
                    ],
                });
            const run = await start(
                "gpt4o",
                (round) =>
                    response(
                        round === 1
                            ? [delta("a", "1", true), delta("ab", "12", false), "data: [DONE]\n\n"]
                            : [frame(openai("finished"))],
                    ),
                { tools: [echo] },
            );
            const chunks = await drain(run.stream);
            expect(chunks.slice(0, 2)).toEqual([
                { "0": "<Thoughts>\na\n</Thoughts>\na" },
                { "0": "<Thoughts>\naab\n</Thoughts>\naab" },
            ]);
            expect(run.call.mock.calls).toEqual([["echo", 112]]);
            expect(run.requests).toHaveLength(2);
            expect(run.requests[1].messages.at(-2)).toEqual({
                role: "assistant",
                content: "<Thoughts>\naab\n</Thoughts>\naab",
                tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "112" } }],
            });
            // The follow-up answer continues the stream (its joining is the tool wrapper's, not the parser's).
            expect(chunks.at(-1)?.["0"]).toMatch(/^<Thoughts>\naab\n<\/Thoughts>\naab[\s\S]*finished$/);
        },
    );

    it("extracts JSON text while preserving tool-call metadata", async () => {
        const run = await start(
            "gpt4o",
            (round) =>
                response([
                    round === 1
                        ? frame({
                              choices: [
                                  {
                                      index: 0,
                                      delta: {
                                          content: '{"answer":"visible"}',
                                          tool_calls: [callDelta("{}")],
                                      },
                                  },
                              ],
                          })
                        : frame(openai('{"answer":"done"}')),
                ]),
            {
                arg: { schema: '{"type":"object","properties":{"answer":{"type":"string"}}}', extractJson: "answer" },
                tools: [echo],
            },
        );
        const chunks = await drain(run.stream);
        expect(chunks[0]).toEqual({ "0": "visible" });
        expect(chunks.at(-1)?.["0"]).toMatch(/^visible[\s\S]*done$/);
        expect(run.call.mock.calls).toEqual([["echo", {}]]);
        expect(run.requests).toHaveLength(2);
        expect(run.requests[1].messages.at(-2)).toEqual({
            role: "assistant",
            content: "visible",
            tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } }],
        });
    });

    it("keeps tool-only answers from a DeepSeek think-tag model", async () => {
        const run = await start(
            "gpt4o",
            (round) =>
                response([
                    round === 1
                        ? frame({
                              choices: [
                                  {
                                      index: 0,
                                      delta: {
                                          tool_calls: [callDelta("{}")],
                                      },
                                  },
                              ],
                          })
                        : frame(openai("done")),
                ]),
            {
                tools: [echo],
                profile: { enableCustomFlags: true, customFlags: [LLMFlags.deepSeekThinkingOutput] },
            },
        );
        const chunks = await drain(run.stream);
        expect(chunks[0]).toEqual({ "0": "" });
        expect(chunks.at(-1)).toEqual({ "0": "done" });
        expect(run.call.mock.calls).toEqual([["echo", {}]]);
        expect(run.requests).toHaveLength(2);
        expect(run.requests[1].messages.at(-2).tool_calls).toEqual([
            { id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } },
        ]);
    });
});

describe("Gemini final state", () => {
    it("preserves a signed function call through the tool round trip", async () => {
        const run = await start(
            "gemini-2.5-flash",
            (round) =>
                response(
                    round === 1
                        ? [
                              frame({
                                  candidates: [
                                      {
                                          content: {
                                              parts: [
                                                  {
                                                      functionCall: { name: "echo", args: { value: "kept" } },
                                                      thoughtSignature: "function-sign",
                                                  },
                                              ],
                                          },
                                      },
                                  ],
                              }),
                              // A subsequent read must not save the earlier function's signature again.
                              frame({ usageMetadata: { totalTokenCount: 9 } }),
                          ]
                        : [frame(gemini("done"))],
                ),
            { tools: [echo], arg: { saveSignatures: true } },
        );
        const chunks = await drain(run.stream);
        expect(run.signatures).toHaveLength(1);
        const marker = `{{inlayeddata::${run.signatures[0][0]}}}`;
        expect(run.signatures[0][1]).toEqual({
            source: "gemini-2.5-flash",
            sourceFormat: LLMFormat.GoogleCloud,
            signatures: [{ type: "function", content: 'echo({"value":"kept"})' }],
        });
        expect(run.requests).toHaveLength(2);
        expect(run.requests[1].contents.at(-2)).toEqual({
            role: "model",
            parts: [
                { text: marker },
                { functionCall: { name: "echo", args: { value: "kept" } }, thoughtSignature: "function-sign" },
            ],
        });
        expect(run.call.mock.calls).toEqual([["echo", { value: "kept" }]]);
        expect(chunks.at(-1)?.["0"]).toMatch(/done$/);
        expect(chunks.at(-1)?.["0"].startsWith(marker)).toBe(true);
    });

    it("emits events preceding DONE in the same read and ignores later events", async () => {
        const run = await start("gemini-2.5-flash", () =>
            response([frame(gemini("A")) + frame(gemini("B")) + "data: [DONE]\n\n" + frame(gemini("ignored"))]),
        );
        expect(await drain(run.stream)).toEqual([{ "0": "AB" }]);
        expect(run.intercept.mock.calls).toEqual([[expect.objectContaining({ "0": "AB" }), "meta_gemini_stream"]]);
    });

    it.each(["fulfilled", "rejected"])(
        "saves each signature part once with a %s save and preserves thoughts",
        async (outcome) => {
            const run = await start(
                "gemini-2.5-flash",
                () =>
                    response([
                        frame({
                            candidates: [
                                {
                                    content: {
                                        parts: [{ text: "think", thought: true, thoughtSignature: "thought-sign" }],
                                    },
                                },
                            ],
                        }),
                        frame({
                            candidates: [{ content: { parts: [{ text: "A", thoughtSignature: "answer-sign" }] } }],
                        }),
                        frame(gemini("B")),
                    ]),
                {
                    arg: { saveSignatures: true },
                    saveSignature: async (id) => {
                        if (outcome === "rejected") throw new Error("signature store unavailable");
                        return id;
                    },
                },
            );
            const chunks = await drain(run.stream);
            // Let a missing rejection handler surface within this test (Vitest fails on unhandled rejections).
            await setImmediate();
            expect(run.signatures).toHaveLength(2);
            const [first, second] = run.signatures.map(([id]) => `{{inlayeddata::${id}}}`);
            const thought = "<Thoughts>\n\nthink\n\n</Thoughts>\n\n";
            expect(chunks).toEqual([
                { "0": thought + first },
                { "0": thought + first + "A" + second },
                { "0": thought + first + "A" + second + "B" },
            ]);
            expect(run.signatures.map(([, signature]) => signature)).toEqual([
                {
                    source: "gemini-2.5-flash",
                    sourceFormat: LLMFormat.GoogleCloud,
                    signatures: [{ type: "text", content: "think" }],
                },
                {
                    source: "gemini-2.5-flash",
                    sourceFormat: LLMFormat.GoogleCloud,
                    signatures: [{ type: "text", content: "A" }],
                },
            ]);
            expect(run.intercept.mock.calls).toEqual([
                [
                    expect.objectContaining({
                        "0": first + "A" + second + "B",
                        __thoughts: "think",
                        __last_thought: "",
                        __sign_text: "answer-sign",
                    }),
                    "meta_gemini_stream",
                ],
            ]);
        },
    );

    it.each([
        ["usageMetadata", { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }],
        ["modelStatus", { state: "ready" }],
    ])("keeps a standalone %s line in the final metadata intercept", async (key, value) => {
        const run = await start("gemini-2.5-flash", () => response([frame({ [key]: value })]));
        expect(await drain(run.stream)).toEqual([{ "0": "" }]);
        expect(run.intercept.mock.calls).toEqual([
            [
                expect.objectContaining({
                    "0": "",
                    [`__${key}`]: JSON.stringify(value),
                }),
                "meta_gemini_stream",
            ],
        ]);
    });
});

describe("Anthropic stream lifecycle", () => {
    const modelId = "claude-3-5-sonnet-latest";
    it("closes Thoughts exactly once when a read ends after the first text event", async () => {
        const run = await start(modelId, () =>
            response([
                frame({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } }) +
                    frame(anthropic("A")),
                frame(anthropic("B")),
            ]),
        );
        expect(await drain(run.stream)).toEqual([
            { "0": "<Thoughts>\nthink</Thoughts>\n\nA" },
            { "0": "<Thoughts>\nthink</Thoughts>\n\nAB" },
        ]);
    });

    it("errors on an upstream body failure without waiting for an abort", async () => {
        let upstream!: ReadableStreamDefaultController<Uint8Array>;
        const controller = new AbortController();
        const run = await start(
            modelId,
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(body) {
                            upstream = body;
                            body.enqueue(encoder.encode(frame(anthropic("partial"))));
                        },
                    }),
                ),
            { controller },
        );
        const reader = run.stream.getReader();
        expect(await reader.read()).toEqual({ done: false, value: { "0": "partial" } });
        try {
            // Nothing aborts the request: a failure that surfaced only on an abort would never settle.
            const reading = reader.read().then(
                () => "unexpected success",
                (error) => error.message,
            );
            upstream.error(new Error("synthetic upstream socket reset"));
            expect(await reading).toBe("synthetic upstream socket reset");
            expect(controller.signal.aborted).toBe(false);
        } finally {
            controller.abort();
            await reader.cancel().catch(() => {});
        }
    });

    it("cancels the upstream body when the returned stream is cancelled", async () => {
        const cancel = vi.fn();
        const run = await start(
            modelId,
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(body) {
                            body.enqueue(encoder.encode(frame(anthropic("partial"))));
                        },
                        cancel,
                    }),
                ),
        );
        const reader = run.stream.getReader();
        expect((await reader.read()).value).toEqual({ "0": "partial" });
        await reader.cancel("consumer stopped");
        await setImmediate();
        expect(cancel.mock.calls).toEqual([["consumer stopped"]]);
    });

    it("renders a redacted overload error without making another upstream request", async () => {
        const run = await start(modelId, (round) =>
            response([
                round === 1
                    ? frame({ type: "error", error: { message: "overload for fake-claude" } })
                    : frame(anthropic("unexpected retry")),
            ]),
        );
        expect(await drain(run.stream)).toEqual([{ "0": "Error:overload for [REDACTED]" }]);
        expect(run.requests).toHaveLength(1);
    });
});

it.each(providers.slice(0, 2))(
    "$name does not replay tool calls after an empty follow-up body",
    async ({ modelId, name }) => {
        const event =
            name === "OpenAI"
                ? { choices: [{ index: 0, delta: { tool_calls: [callDelta("{}")] } }] }
                : { candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: {} } }] } }] };
        const run = await start(
            modelId,
            (round) => {
                if (round === 1) return response([frame(event)]);
                if (round === 2) return response([]);
                // A broken parser must fail the assertions, not loop forever in the test.
                return new Response("unexpected repeated tool round", { status: 500 });
            },
            { tools: [echo] },
        );
        const chunks = await drain(run.stream);
        expect(run.call.mock.calls).toEqual([["echo", {}]]);
        expect(run.requests).toHaveLength(2);
        expect(chunks.at(-1)).toEqual({ "0": "" });
    },
);
