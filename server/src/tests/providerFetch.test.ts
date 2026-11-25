// @vitest-environment node
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { RequestContext } from "../llm/context.ts";
import { providerFetch } from "../llm/providerFetch.ts";
import { requestChatDataMain } from "../llm/request.ts";
import { buildRequestDb } from "../llm/settings.ts";
import { createTransport } from "../llm/transport.ts";
import { allowListenerOrigin } from "./testSupport.ts";

// Goal-derived bounds, independent of the production constant. Undici's timeout clock has
// coarse ticks, so exercise either side with a one-second margin, entirely in virtual time.
const THIRTY_MINUTES = 30 * 60 * 1000;
const BEFORE_DEADLINE = THIRTY_MINUTES - 1000;
const AFTER_DEADLINE = THIRTY_MINUTES + 1000;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

async function upstream() {
    const received = deferred<ServerResponse>();
    // Only the provider's response waits are under test; the listener has no request deadline.
    const server = createServer({ requestTimeout: 0, headersTimeout: 0 }, (request, response) => {
        request.resume();
        received.resolve(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = allowListenerOrigin(server);
    return {
        url,
        received: received.promise,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function readBody(response: Response, firstByte: () => void) {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) {
        text += decoder.decode(chunk, { stream: true });
        firstByte();
    }
    return text + decoder.decode();
}

async function longResponse<T>(send: (url: string, signal: AbortSignal, firstByte: () => void) => Promise<T>) {
    const server = await upstream();
    const controller = new AbortController();
    const firstByte = deferred<void>();
    try {
        const result = send(server.url, controller.signal, () => firstByte.resolve());
        // A premature header failure must be observed even before the body is released.
        void result.catch(() => {});
        const response = await server.received;
        await vi.advanceTimersByTimeAsync(BEFORE_DEADLINE);
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.write('{"message":{"content":"long');
        await Promise.race([
            firstByte.promise,
            result.then(() => {
                throw new Error("The response ended before its body was released");
            }),
        ]);
        // The total exchange exceeds thirty minutes; each individual wait stays below it.
        await vi.advanceTimersByTimeAsync(BEFORE_DEADLINE);
        response.end(' answer"},"done":true}');
        return await result;
    } finally {
        controller.abort();
        await server.close();
    }
}

function ollamaContext(url: string, signal: AbortSignal, firstByte: () => void): RequestContext {
    const { db } = buildRequestDb(
        [
            normalizeProviders({ useStreaming: false }),
            normalizeLlmSecrets({}),
            { autoSuggestPrefix: "" },
            [],
            [],
            normalizePresets([{ id: "p", name: "Prompt" }]),
            normalizeModelPresets([{ id: "m", name: "Model", mainSlot: { profileId: "local" } }]),
            normalizeModelProfiles([
                { id: "local", name: "Local", modelId: "ollama-hosted", ollamaURL: url, ollamaModel: "llama" },
            ]),
            normalizePersonas([{ id: "u", name: "User" }]),
        ],
        {
            presetId: "p",
            modelPresetId: "m",
            personaId: "u",
            selectedPersonaId: "u",
            selectedCharacterId: null,
            speakerId: null,
        },
        { selectedCharacterName: null, speakerName: null },
    );
    return {
        db,
        signal,
        selectedCharacterName: null,
        speakerName: null,
        userName: "User",
        firstByte: { now: () => Date.now(), mark: firstByte },
        transport: createTransport({ signal, log: () => {} }),
        alertError: () => {},
        redactText: (text) => text,
        tokenizeNum: async () => [],
        strongBan: async (_text, bias) => bias,
        parseCbs: async (text) => text,
        tools: { call: async () => [], encode: async () => "", decode: async () => undefined },
        inlays: { saveSignature: async (id) => id, writeImage: async (image) => image.id, setAsset: async () => {} },
        intercept: async (body) => body,
        supportsInlayImage: () => false,
        getModelInfo: (id) => resolveModelInfo(id),
        vertexAccessToken: async () => "",
        registerClaudeObserver: () => {},
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("provider response waits", () => {
    it("providerFetch allows thirty minutes for headers and between chunks, then times out", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        expect(
            await longResponse((url, signal, firstByte) =>
                providerFetch(url, { signal }).then((r) => readBody(r, firstByte)),
            ),
        ).toBe('{"message":{"content":"long answer"},"done":true}');

        for (const phase of ["headers", "body"] as const) {
            const server = await upstream();
            const controller = new AbortController();
            try {
                const response = providerFetch(server.url, { signal: controller.signal });
                void response.catch(() => {});
                const peer = await server.received;
                let failed: Promise<void>;
                if (phase === "headers") {
                    failed = expect(response).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
                } else {
                    peer.writeHead(200, { connection: "close" });
                    peer.write("first");
                    const reader = (await response).body!.getReader();
                    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
                    failed = expect(reader.read()).rejects.toMatchObject({ cause: { code: "UND_ERR_BODY_TIMEOUT" } });
                }
                await vi.advanceTimersByTimeAsync(AFTER_DEADLINE);
                await failed;
            } finally {
                controller.abort();
                await server.close();
            }
        }
    });

    it("default buffered and streamed transports and local Ollama use the thirty-minute waits", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const buffered = await longResponse((url, signal, firstByte) =>
            createTransport({ signal, log: () => {}, onFirstByte: firstByte }).fetchBuffered(url, { method: "GET" }),
        );
        expect(buffered).toMatchObject({
            ok: true,
            status: 200,
            data: { message: { content: "long answer" }, done: true },
        });

        const streamed = await longResponse((url, signal, firstByte) =>
            createTransport({ signal, log: () => {} })
                .fetchStream(url, { method: "GET" })
                .then((response) => readBody(response, firstByte)),
        );
        expect(streamed).toBe('{"message":{"content":"long answer"},"done":true}');

        const ollama = await longResponse((url, signal, firstByte) =>
            requestChatDataMain(
                { formated: [{ role: "user", content: "Hello" }], bias: {}, useStreaming: false, tools: [] },
                "model",
                ollamaContext(url, signal, firstByte),
            ),
        );
        expect(ollama).toEqual({ type: "success", result: "long answer", model: "ollama-hosted" });
    });

    it("uses an injected fetch unchanged and passes caller aborts to the default fetch", async () => {
        vi.stubGlobal("fetch", () => {
            throw new Error("A supplied fetchImpl must handle the request itself");
        });
        vi.spyOn(console, "error").mockImplementation(() => {});
        for (const mode of ["buffered", "streamed"] as const) {
            const injected = vi.fn<typeof fetch>(async () => Response.json({ answer: "custom" }));
            const custom = createTransport({
                signal: new AbortController().signal,
                log: () => {},
                fetchImpl: injected,
            });
            if (mode === "buffered") {
                expect(await custom.fetchBuffered("https://provider.test/chat")).toMatchObject({
                    ok: true,
                    status: 200,
                    data: { answer: "custom" },
                });
            } else {
                const response = await custom.fetchStream("https://provider.test/chat", { method: "GET" });
                expect(await response.json()).toEqual({ answer: "custom" });
            }
            expect(injected).toHaveBeenCalledTimes(1);
            expect(injected.mock.calls[0][1]).not.toHaveProperty("dispatcher");

            for (const source of ["request", "call"] as const) {
                const request = new AbortController();
                const call = new AbortController();
                const started = deferred<RequestInit>();
                const upstreamFetch = vi.fn<typeof fetch>(async (_url, init = {}) => {
                    started.resolve(init);
                    return new Promise<Response>((_resolve, reject) => {
                        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
                    });
                });
                vi.stubGlobal("fetch", upstreamFetch);
                const transport = createTransport({ signal: request.signal, log: () => {} });
                const result =
                    mode === "buffered"
                        ? transport.fetchBuffered("https://provider.test/chat", { abortSignal: call.signal })
                        : transport.fetchStream("https://provider.test/chat", { method: "GET", signal: call.signal });
                void result.catch(() => {});
                const init = await started.promise;
                const stopped = new DOMException("Generation stopped", "AbortError");
                (source === "request" ? request : call).abort(stopped);
                expect(init.signal!.reason).toBe(stopped);
                if (mode === "buffered") {
                    expect(await result).toMatchObject({ ok: false });
                } else {
                    await expect(result).rejects.toBe(stopped);
                }
                expect(upstreamFetch).toHaveBeenCalledTimes(1);
            }
            vi.stubGlobal("fetch", () => {
                throw new Error("A supplied fetchImpl must handle the request itself");
            });
        }
    });
});
