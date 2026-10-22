// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GenerationContext, MemoryTaskInput } from "../../../shared/jobs.ts";
import { LLMFlags, LLMFormat, type LLMModel, LLMProvider, LLMTokenizer } from "../../../shared/llm.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { ChatTokenCounter } from "../../../shared/prompt/chatTokens.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createVectorCache } from "../data/vectorCache.ts";
import {
    admitProviderModels,
    type JobScope,
    loadJobScope,
    memorySettingsFingerprint,
    memoryTokenPolicy,
} from "../jobs/jobScope.ts";
import { createLlmRequests, type JobRequestSpec } from "../llm/requests.ts";
import { mainModelOf, mainModelTakesImages, tokenScopeFor } from "../llm/settings.ts";
import { createEmbeddings, HypaProcesser } from "../prompt/embeddings.ts";
import { createMemoryTaskHost, MemoryHostFailure, type MemoryTaskHostDeps } from "../prompt/memory/memoryTaskHost.ts";
import type { Tokenizers } from "../prompt/tokenizers/index.ts";
import { createTokenCounter, type TokenCounter } from "../prompt/tokens.ts";
import type { TransformersService } from "../prompt/transformers.ts";
import type { RegexOp, RegexOpResult } from "../scripts/worker.ts";
import { UNHURRIED_CBS, UNHURRIED_HYPAV3_SEPARATOR } from "./unhurriedLimits.ts";

// The detached memory task's host (`server/src/prompt/memory/memoryTaskHost.ts`) over a real
// resource store, the real request layer with a recording upstream, real embeddings over a vector
// cache, and a deterministic tokenizer stub whose counts show the routing. Pinned:
// - the returned tokenizer and `tokenize` count as the job's `ChatTokenCounter` (the runner's
//   construction over the job's scope) for the captured policy: a profile tokenizer, a `presetChain`
//   effective preset, a Plugin main model the job admitted with a server `memory` slot (the fresh
//   scope alone would count another way), a group speaker, and Google counting with the fresh scope's
//   token;
// - a summary request runs the outer loop (a failed attempt retries, a banned script spends a
//   retry) to `runInJob` with mode and source `memory`, one synthetic job id, the fresh request
//   settings, no tools, and the stub channel (the body interceptor is refused as unregistered, so the
//   body reaches the provider unchanged and the request is not ended); no request trigger runs;
// - CBS: `parseChatML` cannot write a chat variable; a reached limit fails the host and later calls
//   refuse with the same failure; a request-layer end (`endJob`) does the same;
// - the end: a check before every dispatch and after every settlement; the task's abort ends a
//   pending request, regex, embedding, and Google count; a throwing fence aborts the host's signal
//   with the fence's own error, so in-flight requests end;
// - `host.db` carries the input's `maxResponse` over the fresh scope's; failure texts carry neither
//   the request credentials nor the embedding keys.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PROVIDER = "https://mock.test/v1/chat/completions";
const PROXY_KEY = "sk-proxy-SENTINEL-1111";
const VOYAGE_KEY = "voyage-SENTINEL-2222";
const MEMORY_KEY = "memory-SENTINEL-3333";
const GOOGLE_TOKEN = "google-SENTINEL-4444";
const CHAT_ADDITIONAL = 3;
const JOB_ID = /^memory-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEXT = "Twelve chars";
const SAMPLE: OpenAIChat[] = [
    { role: "user", content: "Hello there, how are you today?" },
    { role: "assistant", content: "Fine.", name: "Cara" },
    { role: "system", content: "Memory", multimodals: [{ type: "image", base64: "data:image/png;base64,AAAA" }] },
];
const FORMATED: OpenAIChat[] = [
    { role: "system", content: "Summarize the conversation." },
    { role: "user", content: "Message one.\nMessage two." },
];
/** The provider descriptor the tab registers for the job's plugin provider `prov`. */
const PLUGIN_DESCRIPTOR: LLMModel = {
    id: "pluginmodel:::prov",
    name: "prov",
    shortName: "prov",
    fullName: "prov",
    internalID: "pluginmodel:::prov",
    provider: LLMProvider.AsIs,
    format: LLMFormat.Plugin,
    flags: [LLMFlags.hasFullSystemPrompt],
    parameters: ["temperature"],
    tokenizer: LLMTokenizer.Claude,
};
/** A `request` trigger with a write effect, as a job would run it before its memory request. */
const REQUEST_TRIGGER = {
    comment: "request",
    type: "request",
    conditions: [],
    effect: [{ type: "v2SetVar", indent: 0, var: "seen", operator: "=", value: "1", valueType: "value" }],
    lowLevelAccess: true,
};

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Whether `promise` has settled by the next macrotask: its outcome, else `"pending"`. */
async function settledBy(promise: Promise<unknown>): Promise<unknown> {
    return await Promise.race([
        promise.then(
            () => "resolved",
            (error) => error,
        ),
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
    ]);
}

/** Characters per token by family: the routing shows in the counts. */
const CHARS_PER_TOKEN: Record<string, number> = { claude: 1, cl100k_base: 2, o200k_base: 3, gemmaSentencePiece: 4 };

/** The real counter over a deterministic encoder per family; `fetchImpl` answers Google's `countTokens`. */
function stubTokens(fetchImpl?: typeof fetch) {
    const encodes: string[] = [];
    const tokens = createTokenCounter({
        tokenizers: {
            encode: async (family: string, text: string) => {
                const per = CHARS_PER_TOKEN[family];
                if (per === undefined) {
                    throw new Error(`Unexpected tokenizer: ${family}`);
                }
                encodes.push(family);
                return new Array<number>(Math.ceil(text.length / per)).fill(1);
            },
        } as unknown as Tokenizers,
        ...(fetchImpl ? { fetchImpl } : {}),
    });
    return { tokens, encodes };
}

type StoreOptions = {
    /** Fields over the main profile (a reverse proxy to `PROVIDER` counting with `claude`). */
    main?: Record<string, unknown>;
    /** A second reverse-proxy profile `memory` as the model preset's `memory` aux slot. */
    memoryProfile?: boolean;
    providers?: Record<string, unknown>;
    llmSecrets?: Record<string, unknown>;
    /** The client-readable `secrets` section (`voyageApiKey`, `hypaCustomSettings`). */
    secrets?: Record<string, unknown>;
};

/**
 * A store with the default records, the persona `Uma`, the prompt presets `p` (`maxResponse` 500) and
 * `p2` (250), a reverse-proxy main profile, the characters `c` (with a `request` trigger) and `s`, the
 * group `g` of both, and the bound chats `c/k` and `g/gk`.
 */
function openStore(options: StoreOptions = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-memory-task-host-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds });
    const kind = (name: string) => kinds.get(name)!;
    const replace = (name: string, update: (data: any) => unknown) => {
        const record = store.get(kind(name), "main")!;
        store.put(kind(name), "main", update(record.data), record.revision);
    };
    const presetId = (store.get(kind("presets"), "main")!.data as { id: string }[])[0].id;
    const modelPresetId = (store.get(kind("modelPresets"), "main")!.data as { id: string }[])[0].id;
    const personaId = (store.get(kind("personas"), "main")!.data as { id: string }[])[0].id;
    const proxyProfile = (profile: Record<string, unknown>, id: string, extra: Record<string, unknown> = {}) => ({
        ...profile,
        id,
        name: id,
        modelId: "reverse_proxy",
        forceReplaceUrl: PROVIDER,
        customProxyRequestModel: "mock-model",
        customAPIFormat: LLMFormat.OpenAICompatible,
        credentialId: "proxy",
        customTokenizer: "claude",
        ...extra,
    });
    replace("personas", (personas: Record<string, unknown>[]) => [{ ...personas[0], name: "Uma" }]);
    replace("presets", (presets: Record<string, unknown>[]) => [
        { ...presets[0], maxResponse: 500 },
        { id: "p2", name: "P2", maxResponse: 250 },
    ]);
    replace("modelProfiles", (profiles: Record<string, unknown>[]) => [
        proxyProfile(profiles[0], `${profiles[0].id}`, options.main),
        ...(options.memoryProfile ? [proxyProfile(profiles[0], "memory")] : []),
    ]);
    replace("modelPresets", (presets: Record<string, unknown>[]) => [
        {
            ...presets[0],
            ...(options.memoryProfile
                ? { seperateModelsForAxModels: true, auxSlots: { memory: { profileId: "memory" } } }
                : {}),
        },
    ]);
    replace("providers", (providers: Record<string, unknown>) => ({
        ...providers,
        requestRetrys: 0,
        useStreaming: false,
        banCharacterset: [],
        ...options.providers,
    }));
    replace("llmSecrets", (secrets: Record<string, unknown>) => ({
        ...secrets,
        supaMemoryKey: MEMORY_KEY,
        google: { accessToken: GOOGLE_TOKEN, projectId: "" },
        credentials: { proxy: { key: PROXY_KEY } },
        ...options.llmSecrets,
    }));
    replace("secrets", (secrets: Record<string, unknown>) => ({ ...secrets, ...options.secrets }));
    replace("credentials", () => [{ id: "proxy", name: "Proxy key", type: "custom" }]);
    const characters = kind("characters");
    const character = (chaId: string, name: string, extra: Record<string, unknown> = {}) => ({
        chaId,
        type: "character",
        name,
        firstMessage: "",
        desc: "",
        globalLore: [],
        ...extra,
    });
    store.put(characters, "c", character("c", "Cara", { triggerscript: [REQUEST_TRIGGER] }), null);
    store.put(characters, "s", character("s", "Speaker"), null);
    store.put(
        characters,
        "g",
        { chaId: "g", type: "group", name: "G", firstMessage: "", desc: "", characters: ["c", "s"] },
        null,
    );
    const binding = { modelPresetId, promptPresetId: presetId, bindedPersona: personaId };
    store.applyChanges({
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create" as const,
                        chat: { id: "k", name: "k", message: [], scriptstate: { $seen: "stored" }, ...binding },
                    },
                ],
            },
            {
                characterId: "g",
                chatId: "gk",
                baseRevision: null,
                ops: [{ op: "create" as const, chat: { id: "gk", name: "gk", message: [], ...binding } }],
            },
        ],
    });
    const context = (
        characterId: string,
        chatId: string,
        extra: Partial<GenerationContext> = {},
    ): GenerationContext => ({
        characterId,
        chatId,
        presetId,
        modelPresetId,
        personaId,
        mode: "normal",
        input: "",
        chatRevision: store.chatRevision(characterId, chatId) ?? "",
        ...extra,
    });
    return {
        dir,
        store,
        kinds,
        ids: { presetId, modelPresetId, personaId },
        replace,
        context,
        /** The job's scope of chat `c/k`, as the runner loads it. */
        jobScope: (extra: Partial<GenerationContext> = {}, options: Parameters<typeof loadJobScope>[3] = {}) =>
            loadJobScope(store, kinds, context("c", "k", extra), options),
        dispose() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

type Store = ReturnType<typeof openStore>;

/** The input the job hands off from `scope`: the captured policy, counts, and ids of that scope. */
function inputOf(scope: JobScope, over: Partial<MemoryTaskInput> = {}): MemoryTaskInput {
    return {
        chatRef: { chaId: scope.characterId, chatId: scope.chatId },
        epoch: "epoch-1",
        admittedRevision: scope.chatRevision,
        sourceGeneration: scope.chatSourceGeneration ?? 0,
        speakerId: null,
        binding: {
            presetId: scope.promptPreset.id,
            modelPresetId: scope.modelPreset.id,
            personaId: scope.effectivePersona.id,
        },
        effective: { presetId: scope.promptPreset.id, modelPresetId: scope.modelPreset.id, fromChain: false },
        history: [],
        sources: [],
        historyStart: 0,
        currentTokens: 0,
        maxContext: scope.db.maxContext,
        maxResponse: scope.db.maxResponse,
        tokenPolicy: memoryTokenPolicy(scope, CHAT_ADDITIONAL),
        settingsFingerprint: memorySettingsFingerprint(scope),
        ...over,
    };
}

/** The job's `ChatTokenCounter` as the prompt runner builds it over the job's scope (its construction, kept verbatim). */
function runnerCounter(scope: JobScope, tokens: TokenCounter): ChatTokenCounter {
    const db = scope.db;
    const requestDb = scope.request.db;
    return new ChatTokenCounter(CHAT_ADDITIONAL, db.aiModel.startsWith("gpt") ? "noName" : "name", {
        encode: (text) => tokens.encode(text, tokenScopeFor(requestDb)),
        supportsInlayImage: () => mainModelTakesImages(requestDb),
        mainModel: () => mainModelOf(requestDb),
        requestModel: () => {
            if (requestDb.aiModel === "openrouter") return requestDb.openrouterRequestModel;
            if (requestDb.aiModel === "nanogpt") return requestDb.nanogptRequestModel;
            return undefined;
        },
        gptVisionQuality: () => db.gptVisionQuality,
    });
}

type Upstream = { url: string; headers: Record<string, string>; body: any; signal: AbortSignal };
type HostOptions = {
    /** The provider's answer by call index (default a success `ok`). */
    respond?: (call: Upstream, index: number) => Response | Promise<Response>;
    tokens?: TokenCounter;
    /** The embedding providers' fetch (default: refused). */
    embeddingFetch?: typeof fetch;
    /** The script worker's regex (default: a `true` test result). */
    regex?: (op: RegexOp, opts?: { deadlineMs?: number }) => Promise<RegexOpResult>;
};

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const chat = (content: string, extra: Record<string, unknown> = {}) =>
    json({ choices: [{ message: { role: "assistant", content, ...extra } }] });
/** A provider that answers only when its fetch is aborted (as a socket would), and tells when it started. */
function pendingUpstream() {
    const started = deferred<AbortSignal>();
    const respond = (call: Upstream) =>
        new Promise<Response>((_, reject) => {
            started.resolve(call.signal);
            call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                once: true,
            });
        });
    return { respond, started: started.promise };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

/** A host over `scope` with the real request layer (a recording upstream), real embeddings, and a fenced task. */
function hostOf(h: Store, scope: JobScope, input: MemoryTaskInput, options: HostOptions = {}) {
    const calls: Upstream[] = [];
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
        const call: Upstream = {
            url: String(url),
            headers: Object.fromEntries(new Headers(init.headers as Record<string, string>)),
            body: typeof init.body === "string" ? JSON.parse(init.body) : null,
            signal: init.signal as AbortSignal,
        };
        calls.push(call);
        if (call.signal?.aborted) {
            throw new DOMException("This operation was aborted", "AbortError");
        }
        return await (options.respond ?? (() => chat("ok")))(call, calls.length - 1);
    }) as typeof fetch;
    const tokens = options.tokens ?? stubTokens().tokens;
    const registry = createLlmRequests({
        store: h.store,
        kinds: h.kinds,
        tokens,
        vertexTokens: { get: async () => "vertex-token", clear() {} } as never,
        claudeObserver: { register() {}, reset() {}, dispose() {} } as never,
        parentCallback: () => null,
        fetchImpl,
    });
    const specs: JobRequestSpec[] = [];
    const cache = createVectorCache({ file: path.join(h.dir, "vectors.sqlite") });
    cleanups.push(async () => {
        await registry.dispose();
        cache.close();
    });
    const regexCalls: { op: RegexOp; opts?: { deadlineMs?: number } }[] = [];
    const deps: MemoryTaskHostDeps = {
        llm: {
            runInJob: (spec) => {
                specs.push(spec);
                return registry.runInJob(spec);
            },
        },
        embeddings: createEmbeddings({
            cache,
            transformers: {} as TransformersService,
            fetchImpl:
                options.embeddingFetch ??
                (async () => {
                    throw new Error("no embedding provider in this test");
                }),
        }),
        scriptWorkers: {
            regex: (op, opts) => {
                regexCalls.push({ op, opts });
                return options.regex
                    ? options.regex(op, opts)
                    : Promise.resolve({ value: true } as unknown as RegexOpResult);
            },
        },
        tokens,
        rootDir: REPO_ROOT,
        cbsTimeLimits: UNHURRIED_CBS,
        separatorLimits: UNHURRIED_HYPAV3_SEPARATOR,
    };
    const controller = new AbortController();
    let fenceError: unknown = null;
    const { host, tokenizer } = createMemoryTaskHost({
        scope,
        input,
        deps,
        signal: controller.signal,
        fence: () => {
            if (fenceError !== null) {
                throw fenceError;
            }
        },
    });
    return {
        host,
        tokenizer,
        calls,
        specs,
        regexCalls,
        controller,
        /** The task's fence throws `error` from now on (the writer lease closed, the task ended). */
        closeFence(error: unknown) {
            fenceError = error;
        },
    };
}

const messagesOf = (call: Upstream) => call.body.messages.map((m: any) => ({ role: m.role, content: m.content }));

/** The host's tokenizer and `tokenize` count as the job's counter over `jobScope` does. */
async function expectCountsAsJob(
    tokenizer: { tokenizeChat(chat: OpenAIChat): Promise<number> },
    host: { tokenize(text: string): Promise<number> },
    jobScope: JobScope,
    tokens: TokenCounter,
) {
    const expected = runnerCounter(jobScope, tokens);
    for (const message of SAMPLE) {
        expect(await tokenizer.tokenizeChat(message), message.content).toBe(await expected.tokenizeChat(message));
    }
    expect(await host.tokenize(TEXT)).toBe(await tokens.count(TEXT, tokenScopeFor(jobScope.request.db)));
}

describe("the token counter", () => {
    it("counts as the job's counter with the profile's tokenizer, where the same text under another tokenizer counts differently", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const { tokens } = stubTokens();
        const jobScope = h.jobScope();
        const input = inputOf(jobScope);
        expect(input.tokenPolicy.tokenizer.customTokenizer).toBe("claude");
        const { host, tokenizer } = hostOf(h, h.jobScope(), input, { tokens });
        await expectCountsAsJob(tokenizer, host, jobScope, tokens);
        // The claude family counts one token per character; the default o200k family would count a third.
        expect(await host.tokenize(TEXT)).toBe(TEXT.length);
        const other = openStore({ main: { customTokenizer: "" } });
        cleanups.push(() => other.dispose());
        expect(await runnerCounter(other.jobScope(), tokens).tokenizeChat(SAMPLE[0])).not.toBe(
            await tokenizer.tokenizeChat(SAMPLE[0]),
        );
    });

    it("counts as the job's counter under a `presetChain` pick: the effective preset `p2` loaded with chain binding", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const { tokens } = stubTokens();
        const jobScope = h.jobScope({ presetId: "p2" }, { binding: "chain" });
        expect(jobScope.promptPreset.id).toBe("p2");
        const input = inputOf(jobScope, {
            binding: { presetId: h.ids.presetId, modelPresetId: h.ids.modelPresetId, personaId: h.ids.personaId },
            effective: { presetId: "p2", modelPresetId: h.ids.modelPresetId, fromChain: true },
        });
        expect(input.maxResponse).toBe(250);
        const taskScope = h.jobScope({ presetId: input.effective.presetId }, { binding: "chain" });
        const { host, tokenizer } = hostOf(h, taskScope, input, { tokens });
        await expectCountsAsJob(tokenizer, host, jobScope, tokens);
        expect(host.db.maxResponse).toBe(250);
    });

    it("counts a Plugin main model as the job admitted it (its descriptor's tokenizer), while the fresh scope alone would count with the unknown-model fallback, and requests the server `memory` slot", async () => {
        const h = openStore({ main: { modelId: "pluginmodel:::prov" }, memoryProfile: true });
        cleanups.push(() => h.dispose());
        const { tokens } = stubTokens();
        const jobScope = h.jobScope();
        admitProviderModels(jobScope, [{ name: "prov", model: PLUGIN_DESCRIPTOR }]);
        const input = inputOf(jobScope);
        expect(input.tokenPolicy.mainModel).toMatchObject({ id: "pluginmodel:::prov", format: LLMFormat.Plugin });
        expect(input.tokenPolicy.tokenizer.model).toEqual({
            tokenizer: LLMTokenizer.Claude,
            internalID: "pluginmodel:::prov",
        });
        // The task's scope has no admitted descriptor: the plugin id resolves to the catalogue fallback.
        const taskScope = h.jobScope();
        expect(taskScope.request.db.pluginModels ?? []).toEqual([]);
        const { host, tokenizer, calls, specs } = hostOf(h, taskScope, input, { tokens });
        await expectCountsAsJob(tokenizer, host, jobScope, tokens);
        const fresh = runnerCounter(taskScope, tokens);
        expect(await fresh.tokenizeChat(SAMPLE[0])).not.toBe(await tokenizer.tokenizeChat(SAMPLE[0]));
        // The request's own counting is the captured scope too, and it dispatches the fresh `memory` slot.
        expect(await host.request(FORMATED)).toMatchObject({ type: "success", result: "ok" });
        expect(specs[0].tokenScope).toEqual({ ...input.tokenPolicy.tokenizer, googleAccessToken: GOOGLE_TOKEN });
        expect(calls[0].url).toBe(PROVIDER);
        expect(calls[0].body.model).toBe("mock-model");
    });

    it("counts as the job's counter for a group speaker, and the request projection names the speaker and the group as the runner does", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const { tokens } = stubTokens();
        const context = h.context("g", "gk", { speakerChaId: "s" });
        const jobScope = loadJobScope(h.store, h.kinds, context);
        const input = inputOf(jobScope, { speakerId: "s" });
        const taskScope = loadJobScope(h.store, h.kinds, h.context("g", "gk", { speakerChaId: input.speakerId! }));
        const { host, tokenizer, specs } = hostOf(h, taskScope, input, { tokens });
        await expectCountsAsJob(tokenizer, host, jobScope, tokens);
        expect(host.userName()).toBe("Uma");
        await host.request(FORMATED);
        expect(specs[0].loaded).toBe(taskScope.request);
        expect(specs[0].loaded).toMatchObject({ selectedCharacterName: "G", speakerName: "Speaker", userName: "Uma" });
        expect(specs[0].chatRef).toEqual({ chaId: "g", chatId: "gk" });
    });

    it("counts through Google's endpoint with the fresh scope's token (the policy carries none) and the job's model id", async () => {
        const h = openStore({
            main: { modelId: "gemini-3-flash-preview" },
            providers: { googleClaudeTokenizing: true },
            llmSecrets: { google: { accessToken: "google-OLD", projectId: "" } },
        });
        cleanups.push(() => h.dispose());
        const jobScope = h.jobScope();
        const input = inputOf(jobScope);
        expect(input.tokenPolicy.tokenizer).toMatchObject({
            googleClaudeTokenizing: true,
            model: { tokenizer: LLMTokenizer.GoogleCloud, internalID: "gemini-3-flash-preview" },
        });
        expect(JSON.stringify(input)).not.toContain("google-OLD");
        // The token changed between the hand-off and the task's start: the task counts with the new one.
        h.replace("llmSecrets", (secrets: Record<string, unknown>) => ({
            ...secrets,
            google: { accessToken: GOOGLE_TOKEN, projectId: "" },
        }));
        const urls: string[] = [];
        const { tokens } = stubTokens((async (url: string | URL | Request) => {
            urls.push(String(url));
            return json({ totalTokens: 7 });
        }) as typeof fetch);
        const { host, tokenizer } = hostOf(h, h.jobScope(), input, { tokens });
        expect(await tokenizer.tokenizeChat({ role: "user", content: "anything" })).toBe(7 + CHAT_ADDITIONAL);
        expect(await host.tokenize("anything else")).toBe(7);
        expect(urls).toHaveLength(2);
        for (const url of urls) {
            expect(url).toBe(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:countTokens?key=${GOOGLE_TOKEN}`,
            );
        }
    });
});

describe("a summary request", () => {
    it("runs the outer loop to `runInJob`: a failed attempt retries, a banned script spends a retry, each attempt is the job's `memory` request with one synthetic id and no tools, and the owner's `request` trigger never runs", async () => {
        const h = openStore({ providers: { requestRetrys: 2, banCharacterset: ["Latn"] } });
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const input = inputOf(scope);
        const answers = [
            () => json({ error: { message: "upstream hiccup" } }, 400),
            () => chat("blocked Latin answer"),
            () => chat("한국어 요약"),
        ];
        const { host, calls, specs } = hostOf(h, scope, input, { respond: (_, index) => answers[index]() });
        const response = await host.request(FORMATED);
        expect(response).toMatchObject({ type: "success", result: "한국어 요약" });
        expect(calls).toHaveLength(3);
        for (const call of calls) {
            expect(call.url).toBe(PROVIDER);
            expect(messagesOf(call)).toEqual(FORMATED);
        }
        expect(specs).toHaveLength(3);
        expect(specs[0].jobId).toMatch(JOB_ID);
        for (const spec of specs) {
            expect(spec).toMatchObject({
                jobId: specs[0].jobId,
                mode: "memory",
                source: "memory",
                chatRef: input.chatRef,
                messageId: null,
                mainModelImageInput: input.tokenPolicy.supportsInlayImage,
                tokenScope: { ...input.tokenPolicy.tokenizer, googleAccessToken: GOOGLE_TOKEN },
            });
            expect(spec.loaded).toBe(scope.request);
            expect(spec.tools.descriptors).toEqual([]);
            expect(spec.tools.limit).toBe(0);
            expect(spec.arg.useStreaming).toBe(false);
            expect(spec.arg.noMultiGen).toBe(true);
        }
        // No trigger ran: the owner's `request` trigger would have set `seen` to `1`.
        const stored = h.store.readChatSource("c", "k").data as { scriptstate?: Record<string, string> };
        expect(stored.scriptstate).toEqual({ $seen: "stored" });
        expect(host.signal.aborted).toBe(false);
    });

    it("has its body interceptor refused as unregistered by the stub channel: the body reaches the provider unchanged and the request is not ended", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const { host, calls } = hostOf(h, scope, inputOf(scope));
        expect(await host.request(FORMATED)).toMatchObject({ type: "success", result: "ok" });
        expect(calls).toHaveLength(1);
        expect(messagesOf(calls[0])).toEqual(FORMATED);
        expect(calls[0].headers.authorization).toBe(`Bearer ${PROXY_KEY}`);
        expect(host.signal.aborted).toBe(false);
    });

    it("redacts the request credentials and the embedding keys from a failure's text, as `redact` does", async () => {
        const h = openStore({ secrets: { voyageApiKey: VOYAGE_KEY } });
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const leak = `denied: proxy ${PROXY_KEY}, voyage ${VOYAGE_KEY}, memory ${MEMORY_KEY}, google ${GOOGLE_TOKEN}`;
        const { host } = hostOf(h, scope, inputOf(scope), { respond: () => json({ error: { message: leak } }, 400) });
        const response = await host.request(FORMATED);
        expect(response.type).toBe("fail");
        const text = response.type === "fail" ? response.result : "";
        expect(text).toContain("denied");
        for (const secret of [PROXY_KEY, VOYAGE_KEY, MEMORY_KEY, GOOGLE_TOKEN]) {
            expect(text).not.toContain(secret);
        }
        expect(text.match(/\[redacted\]/g)).toHaveLength(4);
        expect(host.redact(leak)).toBe(
            "denied: proxy [redacted], voyage [redacted], memory [redacted], google [redacted]",
        );
    });

    it("fails the host when the request layer ends the run (the tool budget): the request rejects with `MemoryHostFailure`, which later calls repeat", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const toolCall = { id: "t1", type: "function", function: { name: "nope", arguments: "{}" } };
        const { host, calls } = hostOf(h, scope, inputOf(scope), {
            respond: () => chat("", { tool_calls: [toolCall] }),
        });
        const error = await host.request(FORMATED).then(
            () => null,
            (e) => e,
        );
        expect(error).toBeInstanceOf(MemoryHostFailure);
        expect((error as Error).message).toBe("The job reached its tool call limit (0)");
        expect(host.signal.aborted).toBe(true);
        expect(host.signal.reason).toBe(error);
        expect(() => host.fence()).toThrow(error);
        expect(() => host.parseChatML("plain")).toThrow(error);
        await expect(host.request(FORMATED)).rejects.toBe(error);
        expect(calls).toHaveLength(1);
    });

    it("ends with the task's abort: the pending upstream fetch is aborted and the request rejects with the abort reason", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const upstream = pendingUpstream();
        const { host, controller } = hostOf(h, scope, inputOf(scope), { respond: upstream.respond });
        const request = host.request(FORMATED);
        const fetchSignal = await upstream.started;
        expect(fetchSignal.aborted).toBe(false);
        const reason = new Error("the task was cancelled");
        controller.abort(reason);
        expect(fetchSignal.aborted).toBe(true);
        await expect(request).rejects.toBe(reason);
        expect(host.signal.reason).toBe(reason);
    });
});

describe("the fence", () => {
    it("is checked before every dispatch: once it throws, nothing reaches the provider, the worker, the encoder, or CBS, and the host's signal carries the fence's own error", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const stub = stubTokens();
        const { host, tokenizer, calls, specs, regexCalls, closeFence } = hostOf(h, scope, inputOf(scope), {
            tokens: stub.tokens,
        });
        const error = new Error("the writer lease closed the task");
        closeFence(error);
        await expect(host.request(FORMATED)).rejects.toBe(error);
        await expect(host.regex({ op: "test", pattern: "a", flags: "", input: "a" })).rejects.toBe(error);
        await expect(tokenizer.tokenizeChat(SAMPLE[0])).rejects.toBe(error);
        await expect(host.tokenize(TEXT)).rejects.toBe(error);
        expect(() => host.parseChatML("plain text, not ChatML")).toThrow(error);
        await expect(host.completions({ model: "m", prompt: "p", max_tokens: 1, temperature: 0 })).rejects.toBe(error);
        await expect(host.summarizer("text")).rejects.toBe(error);
        expect(calls).toEqual([]);
        expect(specs).toEqual([]);
        expect(regexCalls).toEqual([]);
        expect(stub.encodes).toEqual([]);
        expect(host.signal.aborted).toBe(true);
        expect(host.signal.reason).toBe(error);
        expect(host.embeddings.signal.aborted).toBe(true);
    });

    it("aborts the host's signal when it throws, so a request in flight ends: its upstream fetch is aborted and it rejects with the fence's error", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const upstream = pendingUpstream();
        const { host, closeFence } = hostOf(h, scope, inputOf(scope), { respond: upstream.respond });
        const request = host.request(FORMATED);
        const fetchSignal = await upstream.started;
        const error = new Error("the chat was replaced");
        closeFence(error);
        expect(host.signal.aborted).toBe(false);
        expect(() => host.fence()).toThrow(error);
        expect(host.signal.aborted).toBe(true);
        expect(host.signal.reason).toBe(error);
        expect(fetchSignal.aborted).toBe(true);
        await expect(request).rejects.toBe(error);
    });
});

describe("the task's abort", () => {
    it("ends a regex the worker still runs: the host stops waiting with the abort reason, and a regex asked afterwards is not dispatched", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const worker = deferred<RegexOpResult>();
        const { host, controller, regexCalls } = hostOf(h, scope, inputOf(scope), { regex: () => worker.promise });
        const op: RegexOp = { op: "test", pattern: "\\n\\n", flags: "g", input: "a\n\nb" };
        const pending = host.regex(op, { deadlineMs: 5 });
        expect(regexCalls).toEqual([{ op, opts: { deadlineMs: 5 } }]);
        expect(await settledBy(pending)).toBe("pending");
        const reason = new Error("cancelled");
        controller.abort(reason);
        expect(await settledBy(pending)).toBe(reason);
        await expect(host.regex(op)).rejects.toBe(reason);
        expect(regexCalls).toHaveLength(1);
        worker.resolve({ value: true } as unknown as RegexOpResult);
    });

    it("ends an embedding request: the provider fetch runs on the host's signal with the stored memory key and is aborted", async () => {
        const h = openStore({ providers: { hypaModel: "ada" } });
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const started = deferred<{ signal: AbortSignal; authorization: string }>();
        const embeddingFetch = ((_url: string, init: RequestInit) =>
            new Promise<Response>((_, reject) => {
                const signal = init.signal as AbortSignal;
                started.resolve({ signal, authorization: new Headers(init.headers).get("authorization") ?? "" });
                signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                    once: true,
                });
            })) as unknown as typeof fetch;
        const { host, controller } = hostOf(h, scope, inputOf(scope), { embeddingFetch });
        expect(host.embeddings.signal).toBe(host.signal);
        const embeds = new HypaProcesser(host.embeddings, "ada").getEmbeds("some text");
        const fetching = await started.promise;
        expect(fetching.authorization).toBe(`Bearer ${MEMORY_KEY}`);
        expect(fetching.signal.aborted).toBe(false);
        controller.abort(new Error("cancelled"));
        expect(fetching.signal.aborted).toBe(true);
        await expect(embeds).rejects.toThrow();
    });

    it("ends a Google token count the counter still awaits: the tokenizer and `tokenize` reject with the abort reason at once", async () => {
        const h = openStore({
            main: { modelId: "gemini-3-flash-preview" },
            providers: { googleClaudeTokenizing: true },
        });
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const googleCalls: string[] = [];
        const { tokens } = stubTokens((async (url: string | URL | Request) => {
            googleCalls.push(String(url));
            return await new Promise<Response>(() => {});
        }) as typeof fetch);
        const { host, tokenizer, controller } = hostOf(h, scope, inputOf(scope), { tokens });
        const counted = tokenizer.tokenizeChat({ role: "user", content: "never counted" });
        const plain = host.tokenize("never counted either");
        expect(await settledBy(counted)).toBe("pending");
        expect(await settledBy(plain)).toBe("pending");
        expect(googleCalls).toHaveLength(2);
        const reason = new Error("cancelled");
        controller.abort(reason);
        expect(await settledBy(counted)).toBe(reason);
        expect(await settledBy(plain)).toBe(reason);
    });
});

describe("CBS", () => {
    it("`parseChatML` reads the job's chat variables and persona; a variable write is never run (no `runVar`), and the stored chat stays as it was", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const { host } = hostOf(h, scope, inputOf(scope));
        expect(host.parseChatML("not ChatML")).toBeNull();
        const parsed = host.parseChatML(
            "<|im_start|>system<|im_sep|>{{setvar::seen::1}}seen={{getvar::seen}} user={{user}}<|im_end|>",
        );
        // `{{setvar}}` runs only under `runVar`, which the memory host never sets: the text keeps it.
        expect(parsed).toEqual([{ role: "system", content: "{{setvar::seen::1}}seen=stored user=Uma", thoughts: [] }]);
        const stored = h.store.readChatSource("c", "k").data as { scriptstate?: Record<string, string> };
        expect(stored.scriptstate).toEqual({ $seen: "stored" });
    });

    it("fails the host at a reached limit: the parse throws `MemoryHostFailure`, and later parses and requests refuse with the same failure", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const scope = h.jobScope();
        const { host, calls } = hostOf(h, scope, inputOf(scope));
        let failure: unknown;
        try {
            host.parseChatML("<|im_start|>user<|im_sep|>{{range::[0,1e18]}}<|im_end|>");
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(MemoryHostFailure);
        expect((failure as Error).message).toBe("CBS limit reached: one template took more than 10000000 steps");
        expect(host.signal.aborted).toBe(true);
        expect(host.signal.reason).toBe(failure);
        expect(() => host.parseChatML("<|im_start|>user<|im_sep|>fine<|im_end|>")).toThrow(failure as Error);
        await expect(host.request(FORMATED)).rejects.toBe(failure);
        expect(calls).toEqual([]);
    });
});

describe("the host's database", () => {
    it("is the fresh scope's with the input's `maxResponse`, so the response correction matches the captured count", async () => {
        const h = openStore();
        cleanups.push(() => h.dispose());
        const jobScope = h.jobScope();
        const input = inputOf(jobScope);
        expect(input.maxResponse).toBe(500);
        // The main preset's response size changed between the hand-off and the task's start.
        h.replace("presets", (presets: Record<string, unknown>[]) => [{ ...presets[0], maxResponse: 900 }, presets[1]]);
        const taskScope = h.jobScope();
        expect(taskScope.db.maxResponse).toBe(900);
        const { host } = hostOf(h, taskScope, input);
        expect(host.db.maxResponse).toBe(500);
        expect(host.db.maxContext).toBe(taskScope.db.maxContext);
        expect(host.db.characters).toBe(taskScope.db.characters);
        expect(host.db.hypaV3Presets).toBe(taskScope.db.hypaV3Presets);
        expect(host.separatorLimits).toBe(UNHURRIED_HYPAV3_SEPARATOR);
        expect(host.progress({ open: true, miniMsg: "", msg: "", subMsg: "" })).toBeUndefined();
        await expect(host.completions({ model: "m", prompt: "p", max_tokens: 1, temperature: 0 })).rejects.toThrow(
            "openai-completions is not available to a memory task",
        );
        await expect(host.summarizer("text")).rejects.toThrow("The local summarizer is not available to a memory task");
    });
});
