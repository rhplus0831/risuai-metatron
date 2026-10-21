// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRequestBody, LlmRequestEvent } from "../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import { createLlmRequests, type LlmRequestsOptions, type RequestObserver } from "../llm/requests.ts";

// The recorded provider bodies of the formats whose client functions lived in
// `src/ts/process/request/request.ts` itself (NovelAI, Kobold, Cohere, NovelList, Horde, Echo) and
// so have no client module left to run beside the port (`serverParity.test.ts` covers the others).
// The expectations are the bodies the client built at `250c0f96`, from the same settings; a change
// in `server/src/llm/request.ts` or in the settings the port reads shows here.

const SECRETS = {
    novelai: "nai-SENTINEL",
    cohere: "cohere-SENTINEL",
    novellist: "ain-SENTINEL",
    horde: "horde-SENTINEL-key",
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; signal: AbortSignal };

function harness(
    preset: Record<string, unknown>,
    providers: Record<string, unknown>,
    respond: (call: Call) => Response,
    options: Partial<LlmRequestsOptions> = {},
) {
    const records: Record<string, unknown> = {
        providers: normalizeProviders(providers),
        llmSecrets: normalizeLlmSecrets({
            cohereAPIKey: SECRETS.cohere,
            novellistAPI: SECRETS.novellist,
            novelai: { token: SECRETS.novelai, model: "kayra-v1" },
            hordeConfig: { apiKey: SECRETS.horde, model: "", softPrompt: "" },
        }),
        ui: { autoSuggestPrefix: "" },
        customModels: [],
        // `preset` mixes the prompt preset's fields and the profile's (`aiModel` is its `modelId`);
        // each normalizer keeps its own.
        presets: normalizePresets([{ id: "p", name: "p", maxResponse: 250, temperature: 60, ...preset }]),
        modelProfiles: normalizeModelProfiles([{ id: "main", name: "main", ...preset, modelId: preset.aiModel }]),
        modelPresets: normalizeModelPresets([
            { id: "m", name: "m", mainSlot: { profileId: "main" }, subSlot: { profileId: "main" } },
        ]),
        personas: normalizePersonas([{ id: "u", name: "Uma" }]),
    };
    const characters: Record<string, unknown> = { c: { chaId: "c", name: "Cara" } };
    const store = {
        readRefs: (refs: { kind: { name: string }; id: string }[]) => ({
            items: refs.map((ref) => ({
                kind: ref.kind.name,
                id: ref.id,
                revision: null,
                data: ref.kind.name === "characters" ? (characters[ref.id] ?? null) : (records[ref.kind.name] ?? null),
            })),
        }),
    } as unknown as ResourceStore;
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
        let body: unknown = typeof init.body === "string" ? init.body : undefined;
        try {
            body = JSON.parse(body as string);
        } catch {}
        const call: Call = {
            url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
            method: init.method ?? "GET",
            headers: Object.fromEntries(new Headers(init.headers as Record<string, string>)),
            body,
            signal: init.signal as AbortSignal,
        };
        calls.push(call);
        return respond(call);
    }) as typeof fetch;
    const registry = createLlmRequests({
        store,
        kinds: { get: (name: string) => ({ name }) } as unknown as ResourceKindRegistry,
        tokens: {
            encode: async (text: string) => Array.from(text).map((char) => char.codePointAt(0) ?? 0),
            count: async () => 1,
        } as never,
        vertexTokens: { get: async () => "", clear() {} } as never,
        claudeObserver: { register() {}, reset() {}, dispose() {} } as never,
        parentCallback: () => null,
        fetchImpl,
        ...options,
    });
    return { registry, calls };
}

function body(arg: Record<string, unknown> = {}): LlmRequestBody {
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
                aiModel: "x",
                currentPluginProvider: "",
                modelTokenizer: 1,
                pluginTokenizer: "none",
                customTokenizer: "",
                googleClaudeTokenizing: false,
                useTokenizerCaching: false,
            },
        },
        arg: {
            formated: [
                { role: "system", content: "Be brief." },
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Hi" },
                { role: "user", content: "More" },
            ],
            bias: {},
            useStreaming: false,
            ...arg,
        },
        tools: [],
        toolRecords: {},
    };
}

async function run(registry: ReturnType<typeof createLlmRequests>, request: LlmRequestBody) {
    const started = registry.start(request, new AbortController().signal);
    if (!started.ok) {
        throw new Error(started.error);
    }
    const text = await new Response(started.stream).text();
    const events = text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as LlmRequestEvent);
    return events.find((event) => event.type === "result" || event.type === "error") as {
        type: string;
        response?: unknown;
        message?: string;
    };
}

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
    vi.useRealTimers();
});

describe("the legacy formats on the server", () => {
    it("NovelAI: the stringlized prompt, the generation parameters, the bias sequences, and the bearer token", async () => {
        const { registry, calls } = harness({ aiModel: "novelai_kayra", NAIadventure: true }, {}, () =>
            json({ output: "a story" }),
        );
        const result = await run(registry, body({ biasString: [["ab", -2]], temperature: 0.5, maxTokens: 99 }));
        expect(result).toEqual({ type: "result", response: { type: "success", result: "a story" } });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            url: "https://text.novelai.net/ai/generate",
            method: "POST",
            headers: { authorization: `Bearer ${SECRETS.novelai}` },
        });
        expect(calls[0].body).toMatchObject({
            model: "kayra-v1",
            parameters: {
                temperature: 0.5,
                max_length: 99,
                min_length: 1,
                prefix: "theme_textadventure",
                use_string: true,
                order: [6, 2, 3, 0, 4, 1, 5, 8],
                stop_sequences: [[49287], [49405]],
                logit_bias_exp: [{ sequence: [97, 98], bias: -2, ensure_sequence_finish: false, generate_once: true }],
            },
        });
        expect((calls[0].body as { input: string }).input).toContain("Hello");
        expect((calls[0].body as { input: string }).input.endsWith("Cara:")).toBe(true);
        await registry.dispose();
    });

    it("Kobold: the templated prompt at `api/v1/generate` with the sampler parameters", async () => {
        const { registry, calls } = harness(
            { aiModel: "kobold", koboldURL: "http://kobold.test/", maxContext: 4000, top_p: 0.9, top_k: 40 },
            {},
            () => json({ results: [{ text: "kobold says" }] }),
        );
        const result = await run(registry, body({ maxTokens: 77 }));
        expect(result).toEqual({ type: "result", response: { type: "success", result: "kobold says" } });
        expect(calls[0]).toMatchObject({ url: "http://kobold.test/api/v1/generate", method: "POST" });
        expect(calls[0].body).toMatchObject({
            max_length: 77,
            max_context_length: 4000,
            n: 1,
            temperature: 0.6,
            top_p: 0.9,
            top_k: 40,
        });
        expect(typeof (calls[0].body as { prompt: unknown }).prompt).toBe("string");
        await registry.dispose();
    });

    it("Cohere: the last user message, the chat history in Cohere roles, the preamble, and the safety mode", async () => {
        const { registry, calls } = harness({ aiModel: "cohere-command-r", top_k: 3 }, {}, () =>
            json({ text: "cohere says" }),
        );
        const result = await run(registry, body());
        expect(result).toEqual({ type: "result", response: { type: "success", result: "cohere says" } });
        expect(calls[0]).toMatchObject({
            url: "https://api.cohere.com/v1/chat",
            method: "POST",
            headers: { authorization: `Bearer ${SECRETS.cohere}` },
        });
        expect(calls[0].body).toMatchObject({
            message: "More",
            chat_history: [
                { role: "USER", message: "Hello" },
                { role: "CHATBOT", message: "Hi" },
            ],
            preamble: "Be brief.",
            safety_mode: "NONE",
            temperature: 0.6,
            k: 3,
        });
        await registry.dispose();
    });

    it("NovelList: the AIN-formatted text and a multiline answer", async () => {
        const { registry, calls } = harness({ aiModel: "novellist" }, {}, () =>
            json({ data: ["こんにちは」Cara「元気？"] }),
        );
        const result = await run(registry, body({ maxTokens: 50 }));
        expect(result).toMatchObject({ type: "result", response: { type: "multiline" } });
        expect(calls[0]).toMatchObject({
            url: "https://api.tringpt.com//api",
            method: "POST",
            headers: { authorization: `Bearer ${SECRETS.novellist}` },
        });
        expect(calls[0].body).toMatchObject({ length: 50, model: "supertrin" });
        // The AIN text as the client built it: the reformated system line, then the turns.
        expect((calls[0].body as { text: string }).text.startsWith("system: Be brief.")).toBe(true);
        expect((calls[0].body as { text: string }).text).toContain("Hello");
        await registry.dispose();
    });

    it("Horde: the async request with the api key header, then the status polls until the generation is done", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const realFetch = globalThis.fetch;
        const seen: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
        let polls = 0;
        globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
            seen.push({
                url: input,
                method: init.method ?? "GET",
                headers: (init.headers as Record<string, string>) ?? {},
                body: init.body ? JSON.parse(init.body as string) : undefined,
            });
            if (input.endsWith("/generate/text/async")) {
                return json({ id: "gen-1", kudos: 1, message: "" }, 202);
            }
            polls++;
            return json(
                polls < 2
                    ? { is_possible: true, done: false }
                    : { is_possible: true, done: true, generations: [{ text: "horde says" }] },
            );
        }) as typeof fetch;
        try {
            const { registry } = harness({ aiModel: "horde:::auto", maxContext: 2000, top_k: 1, top_p: 0.5 }, {}, () =>
                json({}),
            );
            const pending = run(registry, body());
            await vi.advanceTimersByTimeAsync(2000);
            await vi.advanceTimersByTimeAsync(2000);
            expect(await pending).toEqual({ type: "result", response: { type: "success", result: "horde says" } });
            expect(seen[0]).toMatchObject({
                url: "https://stablehorde.net/api/v2/generate/text/async",
                method: "POST",
                headers: { apikey: SECRETS.horde, "content-type": "application/json" },
                body: {
                    params: { n: 1, max_context_length: 2100, max_length: 250, temperature: 0.6, top_k: 1, top_p: 0.5 },
                    trusted_workers: false,
                },
            });
            expect((seen[0].body as { models?: unknown }).models).toBeUndefined();
            expect(seen.slice(1).map((entry) => entry.url)).toEqual([
                "https://stablehorde.net/api/v2/generate/text/status/gen-1",
                "https://stablehorde.net/api/v2/generate/text/status/gen-1",
            ]);
            await registry.dispose();
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it("Echo: the configured message after the configured delay, no upstream", async () => {
        const { registry, calls } = harness({ aiModel: "echo_model" }, { echoMessage: "pong", echoDelay: 0 }, () =>
            json({}),
        );
        expect(await run(registry, body())).toEqual({ type: "result", response: { type: "success", result: "pong" } });
        expect(calls).toHaveLength(0);
        await registry.dispose();
    });
});

// The prompt preset's context size override (`maxContextOverride`, `maxContextOverrideSize`;
// `maxContextOverrideOf` in `shared/sections.ts`) reaches the provider through the request database
// (`loadRequestDb` → `forwardPresetRoots`) and `requestChatDataMain`, which re-applies it after the
// request-local profile overlay (`forwardProfileRoots`) for a main-slot request only. Kobold's
// `max_context_length` is `db.maxContext` as the adapter sees it. The harness's sub slot names the
// main profile, so a sub or auxiliary request shares the profile and must still get its own size.
describe("the prompt preset's context size override on the server", () => {
    async function koboldContextLength(
        preset: Record<string, unknown>,
        request: { mode?: LlmRequestBody["mode"]; arg?: Record<string, unknown> } = {},
    ): Promise<number> {
        const { registry, calls } = harness(
            { aiModel: "kobold", koboldURL: "http://kobold.test/", maxContext: 4000, ...preset },
            {},
            () => json({ results: [{ text: "kobold says" }] }),
        );
        const result = await run(registry, { ...body(request.arg), ...(request.mode ? { mode: request.mode } : {}) });
        expect(result).toEqual({ type: "result", response: { type: "success", result: "kobold says" } });
        expect(calls).toHaveLength(1);
        await registry.dispose();
        return (calls[0].body as { max_context_length: number }).max_context_length;
    }
    const on = { maxContextOverride: true, maxContextOverrideSize: 12000 };

    it("a main request gets the override, including a main-mode static request on the main profile", async () => {
        expect(await koboldContextLength(on)).toBe(12000);
        expect(await koboldContextLength(on, { arg: { staticModel: "kobold" } })).toBe(12000);
    });

    it("a sub or auxiliary request and a named-profile request keep the profile's size even on the main profile", async () => {
        expect(await koboldContextLength(on, { mode: "submodel" })).toBe(4000);
        expect(await koboldContextLength(on, { mode: "memory" })).toBe(4000);
        expect(await koboldContextLength(on, { mode: "translate" })).toBe(4000);
        expect(await koboldContextLength(on, { arg: { profileId: "main" } })).toBe(4000);
    });

    it("the override is off, 0 (unset), negative, or not finite: the profile's size", async () => {
        expect(await koboldContextLength({})).toBe(4000);
        expect(await koboldContextLength({ maxContextOverride: false, maxContextOverrideSize: 12000 })).toBe(4000);
        expect(await koboldContextLength({ maxContextOverride: true, maxContextOverrideSize: 0 })).toBe(4000);
        expect(await koboldContextLength({ maxContextOverride: true, maxContextOverrideSize: -3 })).toBe(4000);
        // The stored record is normalized: a non-finite size is the default 0.
        expect(await koboldContextLength({ maxContextOverride: true, maxContextOverrideSize: Infinity })).toBe(4000);
    });
});

describe("Horde's first byte", () => {
    // Horde answers only in a response that ends the request (`requestHorde`'s `watchHorde`): a
    // refused submit at its first chunk; an impossible or finished poll, or a submit or poll whose
    // body cannot be read, at the first chunk it kept, on the layer's clock; nothing for an accepted
    // submit, an unfinished poll, a fetch that fails before any chunk, or a body still being read
    // when the client left. Each case runs observed and unobserved: the terminal event and the fetch
    // sequence must agree (the observer changes nothing about the request).
    const ASYNC = "https://stablehorde.net/api/v2/generate/text/async";
    const STATUS = "https://stablehorde.net/api/v2/generate/text/status/gen-1";
    const accepted = () => json({ id: "gen-1", kudos: 1, message: "" }, 202);
    const finished = () => json({ is_possible: true, done: true, generations: [{ text: "horde says" }] });
    type Seen = [kind: "begin" | "firstByte" | "finish", ...rest: unknown[]];
    type Fetched = { url: string; method: string; at: number };

    /**
     * One Horde request whose upstream answers each fetch from `answers` in order (a throw rejects
     * the fetch; `json({})` once they run out, for the fire-and-forget DELETE), over a clock that
     * reads one more each time from 1000 (else `options.now`): the terminal event, the fetches with
     * the clock at each, and what the observer saw (none without one).
     */
    async function runHorde(
        answers: () => (() => Response)[],
        options: { observe?: boolean; now?: () => number } = {},
    ) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const realFetch = globalThis.fetch;
        let tick = 1000;
        const now = options.now ?? (() => tick++);
        const seen: Seen[] = [];
        const observer: RequestObserver = {
            begin: (request) => void seen.push(["begin", request]),
            firstByte: (requestId, at) => void seen.push(["firstByte", requestId, at]),
            finish: (requestId, end) => void seen.push(["finish", requestId, end]),
        };
        const fetched: Fetched[] = [];
        const queue = answers();
        globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
            fetched.push({ url: input, method: init.method ?? "GET", at: now() });
            const next = queue.shift();
            return next ? next() : json({});
        }) as typeof fetch;
        try {
            const { registry } = harness(
                { aiModel: "horde:::auto" },
                {},
                () => json({}),
                options.observe === false ? { now } : { now, observer },
            );
            let settled = false;
            const pending = run(registry, body()).finally(() => (settled = true));
            for (let i = 0; !settled && i < 8; i++) {
                await vi.advanceTimersByTimeAsync(2000);
            }
            const result = await pending;
            await registry.dispose();
            return { result, fetched, seen, kinds: seen.map((entry) => entry[0]) };
        } finally {
            globalThis.fetch = realFetch;
            vi.useRealTimers();
        }
    }
    /** Both runs of one script; they must agree on the terminal event and the fetch sequence. */
    async function both(answers: () => (() => Response)[]) {
        const observed = await runHorde(answers);
        const unobserved = await runHorde(answers, { observe: false });
        expect(unobserved.result).toEqual(observed.result);
        expect(unobserved.fetched.map(({ url, method }) => [url, method])).toEqual(
            observed.fetched.map(({ url, method }) => [url, method]),
        );
        expect(unobserved.seen).toEqual([]);
        return observed;
    }
    const status = (seen: Seen[]) => (seen.at(-1)?.[2] as { status: string }).status;
    const firstByteAt = (seen: Seen[]) => seen.find((entry) => entry[0] === "firstByte")?.[2] as number | undefined;

    it("a finished poll is the answer: nothing for the accepted submit or an unfinished poll (one `done` without generations too), the first byte once at the finished poll's first chunk, then a success", async () => {
        const observed = await both(() => [
            accepted,
            () => json({ is_possible: true, done: false }),
            () => json({ is_possible: true, done: true, generations: [] }),
            finished,
        ]);
        expect(observed.result).toEqual({ type: "result", response: { type: "success", result: "horde says" } });
        expect(observed.fetched.map((entry) => entry.url)).toEqual([ASYNC, STATUS, STATUS, STATUS]);
        expect(observed.kinds).toEqual(["begin", "firstByte", "finish"]);
        expect(status(observed.seen)).toBe("success");
        // Kept at the finished poll's first chunk: after that poll's fetch, before the end.
        const at = firstByteAt(observed.seen)!;
        expect(at).toBeGreaterThan(observed.fetched[3].at);
        expect((observed.seen[2][2] as { completedAt: number }).completedAt).toBeGreaterThan(at);
        expect((observed.seen[0][1] as { startedAt: number }).startedAt).toBe(1000);
    });

    it("a response that ends the request reports the first byte it kept: a refused submit, a submit or poll whose body is not JSON (an HTML 502), a poll body of `null`, an impossible generation; a poll whose fetch fails before any chunk reports none", async () => {
        const html = (status: number) =>
            new Response("<html><body>Bad Gateway</body></html>", { status, headers: { "content-type": "text/html" } });
        const cases: [name: string, answers: () => (() => Response)[], terminal: unknown, kinds: Seen[0][]][] = [
            [
                "refused submit",
                () => [() => new Response("insufficient kudos", { status: 401 })],
                { type: "result", response: { type: "fail", result: "insufficient kudos" } },
                ["begin", "firstByte", "finish"],
            ],
            ["accepted submit not JSON", () => [() => html(202)], { type: "error" }, ["begin", "firstByte", "finish"]],
            ["poll not JSON", () => [accepted, () => html(502)], { type: "error" }, ["begin", "firstByte", "finish"]],
            ["poll null", () => [accepted, () => json(null)], { type: "error" }, ["begin", "firstByte", "finish"]],
            [
                "impossible",
                () => [accepted, () => json({ is_possible: false })],
                { type: "result", response: { type: "fail", result: "Response not possible", noRetry: true } },
                ["begin", "firstByte", "finish"],
            ],
            [
                "poll fetch failed",
                () => [
                    accepted,
                    () => {
                        throw new TypeError("fetch failed");
                    },
                ],
                { type: "error", message: "fetch failed" },
                ["begin", "finish"],
            ],
        ];
        for (const [name, answers, terminal, kinds] of cases) {
            const observed = await both(answers);
            expect(observed.result, name).toMatchObject(terminal as object);
            expect(observed.kinds, name).toEqual(kinds);
            expect(status(observed.seen), name).toBe("error");
            if (kinds.includes("firstByte")) {
                // Kept after the fetch of the response that ended the request (not the DELETE after it).
                const ending = observed.fetched.filter((entry) => entry.method !== "DELETE").at(-1)!;
                expect(firstByteAt(observed.seen), name).toBeGreaterThan(ending.at);
            }
        }
        // The impossible generation is withdrawn, as the client does.
        const impossible = await runHorde(() => [accepted, () => json({ is_possible: false })]);
        expect(impossible.fetched.map(({ url, method }) => [url, method])).toEqual([
            [ASYNC, "POST"],
            [STATUS, "GET"],
            [STATUS, "DELETE"],
        ]);
    });

    it("reads the layer's clock: a clock at 0 reports 0", async () => {
        const observed = await runHorde(() => [accepted, finished], { now: () => 0 });
        expect(observed.result).toEqual({ type: "result", response: { type: "success", result: "horde says" } });
        expect(observed.seen).toEqual([
            ["begin", expect.objectContaining({ source: "tab", startedAt: 0 })],
            ["firstByte", expect.any(String), 0],
            ["finish", expect.any(String), { status: "success", completedAt: 0 }],
        ]);
    });

    it("a poll body still being read when the client left reports nothing: the request is aborted, and the chunk it kept is never reported", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const realFetch = globalThis.fetch;
        const seen: Seen[] = [];
        const observer: RequestObserver = {
            begin: (request) => void seen.push(["begin", request]),
            firstByte: (requestId, at) => void seen.push(["firstByte", requestId, at]),
            finish: (requestId, end) => void seen.push(["finish", requestId, end]),
        };
        let release!: () => void;
        let pulledAgain!: () => void;
        const chunkTaken = new Promise<void>((resolve) => (pulledAgain = resolve));
        const urls: string[] = [];
        globalThis.fetch = (async (input: string) => {
            urls.push(input);
            if (input.endsWith("/generate/text/async")) {
                return accepted();
            }
            // One chunk, then open until `release`.
            let pulls = 0;
            return new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (pulls++ === 0) {
                            controller.enqueue(new TextEncoder().encode("{"));
                            return;
                        }
                        pulledAgain();
                        return new Promise<void>((resolve) => {
                            release = () => {
                                controller.enqueue(new TextEncoder().encode(' "is_possible": false }'));
                                controller.close();
                                resolve();
                            };
                        });
                    },
                }),
                { status: 200 },
            );
        }) as typeof fetch;
        try {
            const { registry } = harness({ aiModel: "horde:::auto" }, {}, () => json({}), { observer });
            const controller = new AbortController();
            const started = registry.start(body(), controller.signal);
            if (!started.ok) {
                throw new Error(started.error);
            }
            const text = new Response(started.stream).text();
            await vi.advanceTimersByTimeAsync(2000);
            await chunkTaken;
            expect(urls).toEqual([ASYNC, STATUS]);
            expect(seen.map((entry) => entry[0])).toEqual(["begin"]);
            controller.abort();
            expect(seen.map((entry) => entry[0])).toEqual(["begin", "finish"]);
            expect((seen[1][2] as { status: string }).status).toBe("aborted");
            expect(registry.liveIds()).toEqual([]);
            // The body ends after the request did: its interpretation reports nothing.
            release();
            await vi.advanceTimersByTimeAsync(2000);
            expect(await text).toContain("The client went away");
            expect(seen.map((entry) => entry[0])).toEqual(["begin", "finish"]);
            await registry.dispose();
        } finally {
            globalThis.fetch = realFetch;
            vi.useRealTimers();
        }
    });
});
