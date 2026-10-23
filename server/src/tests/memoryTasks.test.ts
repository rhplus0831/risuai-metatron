// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, character, Message } from "../../../shared/database.ts";
import type { EventFeedFrame } from "../../../shared/events.ts";
import type {
    GenerationContext,
    MemoryChatRef,
    MemoryEntrySource,
    MemoryTaskInput,
    MemoryTaskService,
} from "../../../shared/jobs.ts";
import { LLMFormat } from "../../../shared/llm.ts";
import type { SerializableHypaV3Data } from "../../../shared/memory.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import { createVectorCache } from "../data/vectorCache.ts";
import {
    type JobScope,
    loadJobScope,
    memorySettingsFingerprint,
    memoryTokenPolicy,
    scopeChat,
} from "../jobs/jobScope.ts";
import { createLlmRequests } from "../llm/requests.ts";
import { createEmbeddings } from "../prompt/embeddings.ts";
import { emptyHypaV3Execution, hypaV3SourceHash, prepareHypaV3, selectHypaV3 } from "../prompt/memory/hypav3.ts";
import { createMemoryTaskHost, type MemoryTaskHostDeps } from "../prompt/memory/memoryTaskHost.ts";
import {
    createMemoryTasks,
    MEMORY_TASK_LIMITS,
    type MemoryTaskEvent,
    type MemoryTaskLimits,
} from "../prompt/memory/memoryTasks.ts";
import type { Tokenizers } from "../prompt/tokenizers/index.ts";
import { createTokenCounter } from "../prompt/tokens.ts";
import type { TransformersService } from "../prompt/transformers.ts";
import type { RegexOp, RegexOpResult } from "../scripts/worker.ts";
import {
    allowListenerOrigin,
    createResourceTestClient,
    createSigner,
    createTestServer,
    json as jsonInit,
    TEST_INDEX_HTML,
    waitFor,
} from "./testSupport.ts";
import { UNHURRIED_CBS, UNHURRIED_HYPAV3_SEPARATOR, UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

// The detached HypaV3 memory task service (`server/src/prompt/memory/memoryTasks.ts`) over a real
// resource store on a temp dir, the real request layer with a scripted upstream (each summary
// request is answered by the test), real embeddings over a vector cache with a scripted provider, a
// deterministic tokenizer, and an injected clock. Pinned:
// - a hand-off runs after the current turn and only without a writer lease, saves one summary per
//   commit, warms the new summaries' vectors, and a later selection with the same settings embeds no
//   summary document;
// - the queue: one running and one queued input per chat (a newer hand-off replaces the queued one
//   and reruns once), the running cap, the pending-chat limit, and the retained-size cap (idle inputs
//   evicted least recently used first, running and queued ones never);
// - persistence: edits saved between and after the task's writes survive, a reset refuses the next
//   write (`writeSkipped`), and a deleted chat, a deleted, edited, inserted, or re-enabled message, a
//   whole-chat replace, an epoch change, maintenance, and shutdown each end the task with nothing
//   written past the valid prefix;
// - the writer lease closes the running task's fence (a late provider result writes nothing) and
//   makes a manual start queue; the start checks end a task `skipped` with the reason; a stale
//   retained input is not reused by a manual start (`pendingManual`); a late completion never
//   overwrites a newer task's status; a warming failure keeps the summaries; every terminal carries
//   `terminalRevision`; the deadline fails the task;
// - re-entrant callers: nested publications are delivered in order, a listener that resets the epoch
//   stops the old epoch's terminals, a hand-off from an abort callback survives the epoch reset, an
//   abort callback never sees an ended task as running, and a listener re-registering itself is
//   called once per event.
// The last block is the service's wiring in a server context (`createServerContext`) on a listening
// server with loopback chat and embedding providers: the `memoryTask` frames and `hello` snapshot of
// the live-update socket, the maintenance listener's and shutdown's order, the invalidation notice,
// the epoch reset at a restore, and the start and cancel routes (open through `memoryTaskOptions`,
// closed in production).

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PROVIDER = "https://mock.test/v1/chat/completions";
const EMBEDDINGS = "https://api.openai.com/v1/embeddings";
const PROXY_KEY = "sk-proxy-SENTINEL-1111";
const MEMORY_KEY = "memory-SENTINEL-3333";
const GREETING = "Hello there, traveler.";
const MAX_CONTEXT = 1000;
const CHAT_ADDITIONAL = 3;
/** A `request` trigger with a write effect: the owner's summaries stay in the job. */
const REQUEST_TRIGGER = {
    comment: "request",
    type: "request",
    conditions: [],
    effect: [{ type: "v2SetVar", indent: 0, var: "seen", operator: "=", value: "1", valueType: "value" }],
    lowLevelAccess: true,
};
/** Two scanned entries per window and one protected entry: `n` history entries plan `ceil((n − 1) / 2)` summaries. */
const PRESET_SETTINGS = {
    memoryTokensRatio: 0.2,
    // The lookahead target is 0: every window up to the protected tail is planned.
    extraSummarizationRatio: 0.85,
    maxChatsPerSummary: 2,
    queryChatCount: 1,
};
const TERMINAL = new Set(["done", "failed", "cancelled", "skipped"]);
const CHATS = ["k1", "k2", "k3", "k4"];

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Yields `count` turns of the event loop (every microtask and immediate queued so far runs). */
async function turns(count = 5): Promise<void> {
    for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

/** Characters per token by family; the main profile counts with `claude` (one per character). */
const CHARS_PER_TOKEN: Record<string, number> = { claude: 1, cl100k_base: 2, o200k_base: 3, gemmaSentencePiece: 4 };

function stubTokens() {
    return createTokenCounter({
        tokenizers: {
            encode: async (family: string, text: string) => {
                const per = CHARS_PER_TOKEN[family];
                if (per === undefined) {
                    throw new Error(`Unexpected tokenizer: ${family}`);
                }
                return new Array<number>(Math.ceil(text.length / per)).fill(1);
            },
        } as unknown as Tokenizers,
    });
}

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const chatAnswer = (content: string) => json({ choices: [{ message: { role: "assistant", content } }] });

type UpstreamRequest = {
    index: number;
    body: any;
    signal: AbortSignal;
    /** Answers the request with a summary text. */
    answer(text: string): void;
    /** Answers the request with a provider error. */
    fail(message: string): void;
};

/**
 * The summary provider: every request waits for the test's answer. Unless `ignoreAbort`, an aborted
 * request rejects as a socket would.
 */
function scriptedProvider(options: { ignoreAbort?: boolean } = {}) {
    const requests: UpstreamRequest[] = [];
    const arrivals: (() => void)[] = [];
    const pending = new Set<ReturnType<typeof deferred<Response>>>();
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
        const signal = init.signal as AbortSignal;
        const response = deferred<Response>();
        const request: UpstreamRequest = {
            index: requests.length,
            body: typeof init.body === "string" ? JSON.parse(init.body) : null,
            signal,
            answer: (text) => response.resolve(chatAnswer(text)),
            fail: (message) => response.resolve(json({ error: { message } }, 400)),
        };
        if (String(url) !== PROVIDER) {
            throw new Error(`Unexpected upstream ${String(url)}`);
        }
        if (signal.aborted) {
            throw new DOMException("This operation was aborted", "AbortError");
        }
        if (!options.ignoreAbort) {
            signal.addEventListener("abort", () => response.reject(new DOMException("aborted", "AbortError")), {
                once: true,
            });
        }
        pending.add(response);
        void response.promise.then(
            () => pending.delete(response),
            () => pending.delete(response),
        );
        requests.push(request);
        for (const arrival of arrivals.splice(0)) {
            arrival();
        }
        return await response.promise;
    }) as typeof fetch;
    return {
        fetchImpl,
        requests,
        /** Resolves once the request with `index` (in arrival order) has reached the provider. */
        request(index: number): Promise<UpstreamRequest> {
            return new Promise((resolve) => {
                const check = () => {
                    const found = requests[index];
                    if (found) {
                        resolve(found);
                    } else {
                        arrivals.push(check);
                    }
                };
                check();
            });
        },
        /** Ends every unanswered request as an aborted socket would (the harness's cleanup). */
        abortAll() {
            for (const response of [...pending]) {
                response.reject(new DOMException("aborted", "AbortError"));
            }
        },
        /** The summary texts the provider was asked for (the window's messages joined). */
        asked: (request: UpstreamRequest): string => request.body.messages.map((m: any) => m.content).join("\n"),
    };
}

/** The embedding provider: a vector per input, or a thrown failure. Records every request body. */
function scriptedEmbeddings(options: { fail?: boolean } = {}) {
    const bodies: { input: string[] }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
        if (String(url) !== EMBEDDINGS) {
            throw new Error(`Unexpected embedding provider ${String(url)}`);
        }
        const body = JSON.parse(init.body as string);
        const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
        bodies.push({ input });
        if (options.fail) {
            throw new Error("the embedding provider is down");
        }
        return json({
            data: input.map((text) => ({ embedding: [1, (text.length % 7) + 1, (text.charCodeAt(0) % 5) + 1] })),
        });
    }) as typeof fetch;
    return {
        fetchImpl,
        bodies,
        /** The requests whose input holds any of `texts`. */
        embedding: (texts: string[]) => bodies.filter((body) => body.input.some((text) => texts.includes(text))),
    };
}

type StoreOptions = {
    /** The `memory` aux slot's profile model (a second reverse-proxy profile). */
    memoryModelId?: string;
    hypaSettings?: Record<string, unknown>;
    memorySection?: Record<string, unknown>;
    /** The `secrets` section over its defaults (a custom embedding server's settings). */
    secrets?: Record<string, unknown>;
    /** The profiles' reverse-proxy URL (default `PROVIDER`; a listening loopback provider for a server context). */
    providerUrl?: string;
    /** The owner `c`'s record over its defaults. */
    owner?: Record<string, unknown>;
};

const m = (id: string, data: string, role: "user" | "char"): Message => ({ chatId: id, role, data });
/** Seven messages: the plan scans the greeting and six of them, keeping the last one. */
const MESSAGES = (): Message[] =>
    [1, 2, 3, 4, 5, 6, 7].map((i) =>
        m(`m${i}`, `${i % 2 ? "User" : "Char"} line ${i} of the story.`, i % 2 ? "user" : "char"),
    );

/**
 * A store with the default records, the persona `Uma`, the prompt presets `p` and `p2`, a
 * reverse-proxy main profile counting with `claude`, HypaV3 selected with a two-message window, the
 * `ada` embedding model, the character `c` (memory on, a greeting) and the bound chats `k1`..`k4` of
 * seven messages each.
 */
function openStore(options: StoreOptions = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-memory-tasks-"));
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
        forceReplaceUrl: options.providerUrl ?? PROVIDER,
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
        proxyProfile(profiles[0], `${profiles[0].id}`),
        ...(options.memoryModelId ? [proxyProfile(profiles[0], "memory", { modelId: options.memoryModelId })] : []),
    ]);
    replace("modelPresets", (presets: Record<string, unknown>[]) => [
        {
            ...presets[0],
            ...(options.memoryModelId
                ? { seperateModelsForAxModels: true, auxSlots: { memory: { profileId: "memory" } } }
                : {}),
        },
    ]);
    replace("providers", (providers: Record<string, unknown>) => ({
        ...providers,
        requestRetrys: 0,
        useStreaming: false,
        banCharacterset: [],
    }));
    replace("llmSecrets", (secrets: Record<string, unknown>) => ({
        ...secrets,
        supaMemoryKey: MEMORY_KEY,
        credentials: { proxy: { key: PROXY_KEY } },
    }));
    replace("credentials", () => [{ id: "proxy", name: "Proxy key", type: "custom" }]);
    if (options.secrets) {
        replace("secrets", (section: Record<string, unknown>) => ({ ...section, ...options.secrets }));
    }
    replace("memoryTranslateMedia", (section: Record<string, unknown>) => ({
        ...section,
        hypaV3: true,
        hypav2: false,
        hanuraiEnable: false,
        hypaModel: "ada",
        ...options.memorySection,
    }));
    replace("hypaV3Presets", (data: { items: { settings: Record<string, unknown> }[]; selectedId: string }) => ({
        ...data,
        items: [
            { ...data.items[0], settings: { ...data.items[0].settings, ...PRESET_SETTINGS, ...options.hypaSettings } },
        ],
    }));
    const characters = kind("characters");
    store.put(
        characters,
        "c",
        {
            chaId: "c",
            type: "character",
            name: "Cara",
            firstMessage: GREETING,
            desc: "",
            globalLore: [],
            supaMemory: true,
            ...options.owner,
        },
        null,
    );
    const binding = { modelPresetId, promptPresetId: presetId, bindedPersona: personaId };
    store.applyChanges({
        chats: CHATS.map((chatId) => ({
            characterId: "c",
            chatId,
            baseRevision: null,
            ops: [
                {
                    op: "create" as const,
                    chat: { id: chatId, name: chatId, fmIndex: -1, message: MESSAGES(), ...binding },
                },
            ],
        })),
    });
    const context = (chatId: string, extra: Partial<GenerationContext> = {}): GenerationContext => ({
        characterId: "c",
        chatId,
        presetId,
        modelPresetId,
        personaId,
        mode: "normal",
        input: "",
        chatRevision: store.chatRevision("c", chatId) ?? "",
        ...extra,
    });
    const revision = (chatId: string) => store.chatRevision("c", chatId);
    return {
        dir,
        store,
        kinds,
        ids: { presetId, modelPresetId, personaId },
        replace,
        revision,
        jobScope: (chatId: string, extra: Partial<GenerationContext> = {}) =>
            loadJobScope(store, kinds, context(chatId, extra)),
        /** Applies `ops` to chat `chatId` on its current revision. */
        write: (chatId: string, ops: ChatOp[]) =>
            store.applyChanges({ chats: [{ characterId: "c", chatId, baseRevision: revision(chatId)!, ops }] }),
        updateOwner: (update: (owner: Record<string, unknown>) => Record<string, unknown>) => {
            const record = store.get(characters, "c")!;
            store.put(characters, "c", update(record.data as Record<string, unknown>), record.revision);
        },
        chat: (chatId: string) => store.readChatSource("c", chatId).data as Chat | null,
        memory: (chatId: string) =>
            (store.chatMeta("c", chatId)?.data as Chat | undefined)?.hypaV3Data as SerializableHypaV3Data | undefined,
        summaries: (chatId: string) =>
            (
                (store.chatMeta("c", chatId)?.data as Chat | undefined)?.hypaV3Data as
                    SerializableHypaV3Data | undefined
            )?.summaries.map((summary) => summary.text) ?? [],
        dispose() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

type Store = ReturnType<typeof openStore>;

/**
 * The chat's prompt history as the job's memory step gets it, with the D15 sources: the greeting,
 * then the enabled messages after the last reset, cut to the first `entries` of them.
 */
function historyOf(h: Store, chatId: string, entries?: number): Pick<MemoryTaskInput, "history" | "sources"> {
    const chat = h.chat(chatId)!;
    const owner = h.store.get(h.kinds.get("characters")!, "c")!.data as character;
    const active: Message[] = [];
    for (let i = chat.message.length - 1; i >= 0; i--) {
        const message = chat.message[i];
        if (message.disabled === true) continue;
        if (message.disabled === "allBefore") break;
        active.push(message);
    }
    active.reverse();
    const greeting =
        chat.fmIndex === -1 ? owner.firstMessage : (owner.alternateGreetings?.[chat.fmIndex as number] ?? "");
    const history: OpenAIChat[] = [
        { role: "assistant", content: greeting },
        ...active.map((message): OpenAIChat => ({
            role: message.role === "user" ? "user" : "assistant",
            content: message.data,
            memo: message.chatId,
        })),
    ];
    const sources: MemoryEntrySource[] = [
        { kind: "greeting", fmIndex: chat.fmIndex, textHash: hypaV3SourceHash(greeting) },
        ...active.map((message): MemoryEntrySource => ({
            kind: "message",
            id: message.chatId,
            textHash: hypaV3SourceHash(message.data),
        })),
    ];
    const count = entries ?? history.length;
    return { history: history.slice(0, count), sources: sources.slice(0, count) };
}

/** The input a job of `scope` hands off: `entries` history entries, over the context so the plan summarizes. */
function inputOf(
    h: Store,
    scope: JobScope,
    over: Partial<MemoryTaskInput> & { entries?: number } = {},
): MemoryTaskInput {
    const { entries, ...rest } = over;
    return {
        chatRef: { chaId: scope.characterId, chatId: scope.chatId },
        epoch: h.store.epoch(),
        admittedRevision: scope.chatRevision,
        sourceGeneration: scope.chatSourceGeneration ?? 0,
        speakerId: null,
        binding: {
            presetId: scope.promptPreset.id,
            modelPresetId: scope.modelPreset.id,
            personaId: scope.effectivePersona.id,
        },
        effective: { presetId: scope.promptPreset.id, modelPresetId: scope.modelPreset.id, fromChain: false },
        ...historyOf(h, scope.chatId, entries),
        historyStart: 0,
        currentTokens: 2000,
        maxContext: MAX_CONTEXT,
        maxResponse: 100,
        tokenPolicy: memoryTokenPolicy(scope, CHAT_ADDITIONAL),
        settingsFingerprint: memorySettingsFingerprint(scope),
        ...rest,
    };
}

const sizeOf = (input: MemoryTaskInput) => Buffer.byteLength(JSON.stringify(input));
const ref = (chatId: string): MemoryChatRef => ({ chaId: "c", chatId });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

type HarnessOptions = StoreOptions & {
    limits?: Partial<MemoryTaskLimits>;
    /** Whether the store's invalidation notices reach the service (default yes, as the server wires them). */
    invalidations?: boolean;
    ignoreAbort?: boolean;
    embeddingFail?: boolean;
};

/** The service over a fresh store, the real request layer, real embeddings, and an injected clock. */
function harness(options: HarnessOptions = {}) {
    const h = openStore(options);
    const provider = scriptedProvider({ ignoreAbort: options.ignoreAbort });
    const embeddings = scriptedEmbeddings({ fail: options.embeddingFail });
    const tokens = stubTokens();
    const registry = createLlmRequests({
        store: h.store,
        kinds: h.kinds,
        tokens,
        vertexTokens: { get: async () => "vertex-token", clear() {} } as never,
        claudeObserver: { register() {}, reset() {}, dispose() {} } as never,
        parentCallback: () => null,
        fetchImpl: provider.fetchImpl,
    });
    const cache = createVectorCache({ file: path.join(h.dir, "vectors.sqlite") });
    const hostDeps: MemoryTaskHostDeps = {
        llm: { runInJob: (spec) => registry.runInJob(spec) },
        embeddings: createEmbeddings({
            cache,
            transformers: {} as TransformersService,
            fetchImpl: embeddings.fetchImpl,
        }),
        scriptWorkers: {
            regex: async (op: RegexOp): Promise<RegexOpResult> => {
                if (op.op !== "split") {
                    throw new Error(`Unexpected regex op ${op.op}`);
                }
                return { value: op.input.split(new RegExp(op.pattern, op.flags)) };
            },
        },
        tokens,
        rootDir: REPO_ROOT,
        cbsTimeLimits: UNHURRIED_CBS,
        separatorLimits: UNHURRIED_HYPAV3_SEPARATOR,
    };
    const clock = { now: 1_000_000 };
    const gate: MaintenanceGate & { active: boolean } = {
        active: false,
        assertOpen() {
            if (gate.active) {
                throw new MaintenanceError();
            }
        },
        enter() {
            gate.assertOpen();
            return () => {};
        },
    };
    const service = createMemoryTasks({
        store: h.store,
        kinds: h.kinds,
        gate,
        hostDeps,
        now: () => clock.now,
        limits: { drainWaitMs: 1000, ...options.limits },
    });
    const events: MemoryTaskEvent[] = [];
    const waiters: { test: (event: MemoryTaskEvent) => boolean; resolve: (event: MemoryTaskEvent) => void }[] = [];
    service.onStatus((event) => {
        events.push(event);
        for (const waiter of [...waiters]) {
            if (waiter.test(event)) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(event);
            }
        }
    });
    if (options.invalidations !== false) {
        h.store.onChatInvalidated((notice) => service.invalidate(notice));
    }
    cleanups.push(async () => {
        service.beginShutdown();
        provider.abortAll();
        await service.drain();
        await registry.dispose();
        cache.close();
        h.dispose();
    });
    /** The next published event `test` accepts (registered before the action that publishes it). */
    const nextEvent = (test: (event: MemoryTaskEvent) => boolean) =>
        new Promise<MemoryTaskEvent>((resolve) => waiters.push({ test, resolve }));
    const nextTerminal = (chatId: string) =>
        nextEvent((event) => event.chatRef.chatId === chatId && TERMINAL.has(event.status.state));
    return {
        ...h,
        provider,
        embeddings,
        hostDeps,
        service,
        events,
        clock,
        gate,
        nextEvent,
        nextTerminal,
        /** The states published for `chatId`, in order. */
        states: (chatId: string) => events.filter((e) => e.chatRef.chatId === chatId).map((e) => e.status.state),
        input: (chatId: string, over: Partial<MemoryTaskInput> & { entries?: number } = {}) =>
            inputOf(h, h.jobScope(chatId), over),
        /**
         * A later job's selection over the chat with the same settings: prepared from the stored
         * memory, no summarization, similar summaries selected.
         */
        async selectAgain(chatId: string) {
            const scope = h.jobScope(chatId);
            const input = inputOf(h, scope, { currentTokens: 300 });
            const { host, tokenizer } = createMemoryTaskHost({
                scope,
                input,
                deps: hostDeps,
                signal: new AbortController().signal,
                fence: () => {},
            });
            const outcome = await prepareHypaV3(
                host,
                input.history,
                input.currentTokens,
                input.maxContext,
                structuredClone(scopeChat(scope)) as Chat,
                tokenizer,
            );
            if (!outcome.ok) {
                throw new Error(outcome.result.error);
            }
            return await selectHypaV3(host, outcome.prepared, emptyHypaV3Execution(outcome.prepared), {
                trimUncovered: { tooMuchToken: "too much" },
            });
        },
    };
}

type Harness = ReturnType<typeof harness>;

/** Hands `chatId` off (its full history unless `entries`) and returns the input. */
function handOff(t: Harness, chatId: string, over: Partial<MemoryTaskInput> & { entries?: number } = {}) {
    const input = t.input(chatId, over);
    t.service.handOff(input);
    return input;
}

/** Answers the next `count` summary requests in arrival order with `Summary <n>`. */
async function answerAll(t: Harness, count: number, from = 0) {
    for (let i = from; i < from + count; i++) {
        (await t.provider.request(i)).answer(`Summary ${i + 1}`);
    }
}

describe("a hand-off's run", () => {
    it("starts after the writer lease is released, saves one summary per commit before the next request, warms the summaries' vectors, and a later selection embeds no summary document", async () => {
        const t = harness();
        const lease = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        const queued = t.nextEvent((e) => e.status.state === "queued");
        handOff(t, "k1", { entries: 4 });
        const queuedEvent = await queued;
        expect(queuedEvent.status).toMatchObject({ state: "queued", done: 0, total: 0 });
        await turns();
        // The lease holds the queued input back: no request, no task.
        expect(t.provider.requests).toHaveLength(0);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "queued" });
        expect(t.service.aliveCount()).toBe(0);

        const terminal = t.nextTerminal("k1");
        lease.release();
        const first = await t.provider.request(0);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "running", done: 0, total: 2 });
        expect(t.provider.asked(first)).toContain(GREETING);
        expect(t.provider.asked(first)).toContain("User line 1");
        const writesBefore = t.store.writeCount();
        const revisionBefore = t.revision("k1")!;
        expect(t.summaries("k1")).toEqual([]);
        first.answer("Summary 1");
        const second = await t.provider.request(1);
        // The first summary is stored (one commit) before the second request is made.
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
        expect(t.store.writeCount()).toBe(writesBefore + 1);
        expect(t.memory("k1")!.summaries[0]).toMatchObject({ chatMemos: [null, "m1"], isImportant: false });
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "running", done: 1, total: 2 });
        expect(t.provider.asked(second)).toContain("Char line 2");
        expect(t.embeddings.bodies).toHaveLength(0);
        second.answer("Summary 2 first part.\n\nSummary 2 second part.");
        const done = await terminal;
        expect(t.summaries("k1")).toEqual(["Summary 1", "Summary 2 first part.\n\nSummary 2 second part."]);
        // The last entry is the protected tail: the second window scans `m2` alone.
        expect(t.memory("k1")!.summaries[1].chatMemos).toEqual(["m2"]);
        expect(done.status).toEqual({
            taskId: queuedEvent.status.taskId,
            state: "done",
            done: 2,
            total: 2,
            terminalRevision: t.revision("k1"),
            lastCommittedRevision: t.revision("k1"),
        });
        expect(t.revision("k1")).not.toBe(revisionBefore);
        expect(t.store.writeCount()).toBe(writesBefore + 2);
        // Running at the start, with the plan's total, and after each saved summary.
        expect(t.states("k1")).toEqual(["queued", "running", "running", "running", "running", "done"]);
        // Warming embedded every chunk of the new summaries as documents.
        const chunks = ["Summary 1", "Summary 2 first part.", "Summary 2 second part."];
        expect(t.embeddings.bodies.flatMap((body) => body.input).sort()).toEqual([...chunks].sort());
        const warmed = t.embeddings.bodies.length;

        const selection = await t.selectAgain("k1");
        expect(selection.error).toBeUndefined();
        expect(selection.memory!.metrics!.lastSimilarSummaries.length).toBeGreaterThan(0);
        const later = t.embeddings.bodies.slice(warmed);
        expect(later.length).toBeGreaterThan(0);
        expect(later.flatMap((body) => body.input).some((text) => chunks.includes(text))).toBe(false);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "done" });
    });

    it("starts after the current turn of the hand-off (the handing-off job's terminal goes first) without a lease", async () => {
        const t = harness();
        handOff(t, "k1", { entries: 2 });
        expect(t.service.aliveCount()).toBe(0);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "queued" });
        await Promise.resolve();
        expect(t.service.aliveCount()).toBe(1);
        const terminal = t.nextTerminal("k1");
        (await t.provider.request(0)).answer("Summary 1");
        expect((await terminal).status).toMatchObject({ state: "done", done: 1, total: 1 });
    });
});

describe("the queue", () => {
    it("a hand-off during a run replaces the queued input (same task id) and reruns once with the latest input", async () => {
        const t = harness();
        const firstInput = handOff(t, "k1", { entries: 4 });
        const first = await t.provider.request(0);
        const running = t.service.status(ref("k1"))!;
        expect(running).toMatchObject({ state: "running", total: 2 });
        // Two newer hand-offs while it runs: the second replaces the first as the queued input. The
        // running status stays the chat's effective one: no queued status is published yet.
        const eventsBefore = t.events.length;
        handOff(t, "k1", { entries: 6 });
        const latest = handOff(t, "k1");
        expect(latest.history).toHaveLength(8);
        expect(t.events).toHaveLength(eventsBefore);
        expect(t.service.queuedCount()).toBe(1);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "running", taskId: running.taskId });
        // The running task's input is kept with the queued one and the latest; the replaced one is freed.
        expect(t.service.retainedBytes()).toBe(sizeOf(firstInput) + sizeOf(latest));

        const firstDone = t.nextTerminal("k1");
        first.answer("Summary 1");
        (await t.provider.request(1)).answer("Summary 2");
        expect((await firstDone).status).toMatchObject({ taskId: running.taskId, state: "done", done: 2, total: 2 });
        // The queued status is republished right after the terminal, then the rerun starts under its id.
        const queued = t.events.at(-1)!;
        expect(queued.status).toMatchObject({ state: "queued" });
        const queuedId = queued.status.taskId;
        expect(queuedId).not.toBe(running.taskId);
        const rerun = t.nextEvent((e) => e.status.state === "running");
        expect((await rerun).status).toMatchObject({ taskId: queuedId, state: "running" });
        const third = await t.provider.request(2);
        // Two summaries cover the first three entries: the latest (eight-entry) input plans two more
        // windows; the replaced six-entry one would have planned one.
        expect(t.service.status(ref("k1"))).toMatchObject({ taskId: queuedId, state: "running", done: 0, total: 2 });
        expect(t.provider.asked(third)).toContain("Char line 4");
        const rerunDone = t.nextTerminal("k1");
        third.answer("Summary 3");
        (await t.provider.request(3)).answer("Summary 4");
        expect((await rerunDone).status).toMatchObject({ taskId: queuedId, state: "done", done: 2, total: 2 });
        await turns();
        expect(t.provider.requests).toHaveLength(4);
        expect(t.service.queuedCount()).toBe(0);
        expect(t.summaries("k1")).toEqual(["Summary 1", "Summary 2", "Summary 3", "Summary 4"]);
        expect(t.events.filter((e) => e.status.state === "running").map((e) => e.status.taskId)).toEqual([
            ...new Array<string>(4).fill(running.taskId),
            ...new Array<string>(4).fill(queuedId),
        ]);
    });

    it("runs the chats in parallel up to the running cap, counting a task until its work settles", async () => {
        const t = harness({ limits: { maxRunning: 2 } });
        handOff(t, "k1", { entries: 2 });
        handOff(t, "k2", { entries: 2 });
        handOff(t, "k3", { entries: 2 });
        const first = await t.provider.request(0);
        const second = await t.provider.request(1);
        await turns();
        expect(t.provider.requests).toHaveLength(2);
        expect(t.service.aliveCount()).toBe(2);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "running" });
        expect(t.service.status(ref("k2"))).toMatchObject({ state: "running" });
        expect(t.service.status(ref("k3"))).toMatchObject({ state: "queued" });
        const k1Done = t.nextTerminal("k1");
        first.answer("Summary 1");
        await k1Done;
        const third = await t.provider.request(2);
        expect(t.service.status(ref("k3"))).toMatchObject({ state: "running" });
        expect(t.service.aliveCount()).toBe(2);
        const k2Done = t.nextTerminal("k2");
        const k3Done = t.nextTerminal("k3");
        second.answer("Summary 2");
        third.answer("Summary 3");
        await Promise.all([k2Done, k3Done]);
        await turns();
        expect(t.service.aliveCount()).toBe(0);
        expect(t.summaries("k2")).toEqual(["Summary 2"]);
        expect(t.summaries("k3")).toEqual(["Summary 3"]);
    });

    it("drops a hand-off past the pending-chat limit (a hand-off of a queued chat still replaces its input)", async () => {
        const t = harness({ limits: { maxPendingChats: 1 } });
        const lease1 = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        const lease2 = await t.service.acquireSummaryWriter(ref("k2"), "job-2");
        handOff(t, "k1", { entries: 6 });
        handOff(t, "k2", { entries: 2 });
        expect(t.service.queuedCount()).toBe(1);
        expect(t.service.status(ref("k2"))).toBeNull();
        expect(t.states("k2")).toEqual([]);
        const replaced = handOff(t, "k1", { entries: 2 });
        expect(t.service.queuedCount()).toBe(1);
        expect(t.service.retainedBytes()).toBe(sizeOf(replaced));
        lease2.release();
        lease1.release();
        const terminal = t.nextTerminal("k1");
        (await t.provider.request(0)).answer("Summary 1");
        expect((await terminal).status).toMatchObject({ state: "done", done: 1, total: 1 });
        await turns();
        expect(t.provider.requests).toHaveLength(1);
        expect(t.summaries("k2")).toEqual([]);
    });

    it("evicts idle latest inputs least recently used first for the retained-size cap, never a running or queued one, and drops a hand-off that cannot fit", async () => {
        const probe = harness();
        const size = sizeOf(probe.input("k1", { entries: 2 }));
        const t = harness({ limits: { maxRetainedBytes: size * 2 + 16 } });
        for (const chatId of CHATS) {
            expect(sizeOf(t.input(chatId, { entries: 2 }))).toBe(size);
        }
        // k1 runs to its end: its input stays as the chat's idle latest one.
        const k1Done = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 2 });
        (await t.provider.request(0)).answer("Summary 1");
        await k1Done;
        expect(t.service.retainedBytes()).toBe(size);
        // k2 runs (its input is held by the task), k3 queues: k1's idle input is evicted for it.
        handOff(t, "k2", { entries: 2 });
        const second = await t.provider.request(1);
        const k3Lease = await t.service.acquireSummaryWriter(ref("k3"), "job-3");
        handOff(t, "k3", { entries: 2 });
        expect(t.service.retainedBytes()).toBe(size * 2);
        expect(t.service.status(ref("k3"))).toMatchObject({ state: "queued" });
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "done" });
        // Nothing idle is left: a fourth chat's hand-off is dropped.
        handOff(t, "k4", { entries: 2 });
        expect(t.service.status(ref("k4"))).toBeNull();
        expect(t.service.retainedBytes()).toBe(size * 2);
        expect(t.service.queuedCount()).toBe(1);
        // A manual start of k1 finds no retained input: its next send hands off.
        expect(t.service.start(ref("k1"))).toEqual({ outcome: "pendingManual" });
        expect(t.service.pendingManual(ref("k1"))).toBe(true);
        const k2Done = t.nextTerminal("k2");
        second.answer("Summary 2");
        await k2Done;
        await turns();
        // k2's input is idle now; k3 is still queued behind the lease.
        expect(t.service.retainedBytes()).toBe(size * 2);
        k3Lease.release();
        const k3Done = t.nextTerminal("k3");
        (await t.provider.request(2)).answer("Summary 3");
        await k3Done;
        expect(t.summaries("k3")).toEqual(["Summary 3"]);
        expect(t.summaries("k4")).toEqual([]);
    });
});

describe("persistence", () => {
    it("a summary edited between two task writes and one edited after the last write both survive", async () => {
        const t = harness();
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 4 });
        (await t.provider.request(0)).answer("Summary 1");
        const second = await t.provider.request(1);
        const stored = t.memory("k1")!;
        t.write("k1", [
            {
                op: "meta",
                set: {
                    hypaV3Data: {
                        ...stored,
                        summaries: [{ ...stored.summaries[0], text: "Summary 1 (edited)", isImportant: true }],
                    },
                },
            },
        ]);
        second.answer("Summary 2");
        const done = await terminal;
        expect(done.status).toMatchObject({ state: "done", done: 2, total: 2 });
        expect(t.memory("k1")!.summaries.map((s) => [s.text, s.isImportant])).toEqual([
            ["Summary 1 (edited)", true],
            ["Summary 2", false],
        ]);
        // An edit after the task's last write: the task writes nothing more.
        const after = t.memory("k1")!;
        t.write("k1", [
            {
                op: "meta",
                set: {
                    hypaV3Data: {
                        ...after,
                        summaries: [after.summaries[0], { ...after.summaries[1], text: "Summary 2 (edited)" }],
                    },
                },
            },
        ]);
        await turns();
        expect(t.summaries("k1")).toEqual(["Summary 1 (edited)", "Summary 2 (edited)"]);
    });

    it("a reset saved meanwhile makes the next write skip: the task ends `skipped` (`writeSkipped`) with the summaries before it", async () => {
        const t = harness();
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 6 });
        (await t.provider.request(0)).answer("Summary 1");
        const second = await t.provider.request(1);
        const committed = t.revision("k1");
        t.write("k1", [{ op: "meta", set: { hypaV3Data: { summaries: [] } } }]);
        second.answer("Summary 2");
        const end = await terminal;
        expect(end.status).toEqual({
            taskId: end.status.taskId,
            state: "skipped",
            reason: "writeSkipped",
            done: 1,
            total: 3,
            terminalRevision: t.revision("k1"),
            lastCommittedRevision: committed,
        });
        await turns();
        expect(t.provider.requests).toHaveLength(2);
        expect(t.summaries("k1")).toEqual([]);
    });
});

describe("a changed source", () => {
    /** Runs k1 (six entries, three windows), saves the first summary, and returns the second request pending. */
    async function afterFirstSummary(t: Harness) {
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 6 });
        (await t.provider.request(0)).answer("Summary 1");
        const second = await t.provider.request(1);
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
        return { terminal, second, committed: t.revision("k1")! };
    }

    it("a deleted chat cancels the task (`sourceChanged`, revision null) before the pending request settles, which writes nothing", async () => {
        const t = harness();
        const { terminal, second } = await afterFirstSummary(t);
        t.write("k1", [{ op: "delete" }]);
        const end = await terminal;
        expect(end.status).toMatchObject({
            state: "cancelled",
            reason: "sourceChanged",
            done: 1,
            terminalRevision: null,
        });
        expect(second.signal.aborted).toBe(true);
        second.answer("Summary 2");
        await turns();
        expect(t.chat("k1")).toBeNull();
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "cancelled" });
        expect(t.provider.requests).toHaveLength(2);
    });

    for (const [name, change] of [
        ["deleted", (t: Harness) => t.write("k1", [{ op: "remove", ids: ["m3"] }])],
        ["edited", (t: Harness) => t.write("k1", [{ op: "setText", id: "m2", text: "Char line 2, rewritten." }])],
        [
            "inserted",
            (t: Harness) =>
                t.write("k1", [
                    { op: "append", messages: [m("x1", "An inserted line.", "user")], anchor: { after: "m2" } },
                ]),
        ],
        ["re-enabled", (t: Harness) => t.write("k1", [{ op: "patchMessage", id: "d1", set: { disabled: false } }])],
    ] as const) {
        it(`a message ${name} in the second window after the first summary: the task ends \`skipped\` (\`sourceInvalid\`) with the first summary kept and no third request`, async () => {
            const t = harness();
            // A disabled message between the first and second windows, absent from the history.
            t.write("k1", [
                {
                    op: "append",
                    messages: [{ ...m("d1", "A hidden line.", "user"), disabled: true }],
                    anchor: { after: "m2" },
                },
            ]);
            const { terminal, second, committed } = await afterFirstSummary(t);
            change(t);
            second.answer("Summary 2");
            const end = await terminal;
            expect(end.status).toEqual({
                taskId: end.status.taskId,
                state: "skipped",
                reason: "sourceInvalid",
                done: 1,
                total: 3,
                terminalRevision: t.revision("k1"),
                lastCommittedRevision: committed,
            });
            await turns();
            expect(t.provider.requests).toHaveLength(2);
            expect(t.summaries("k1")).toEqual(["Summary 1"]);
        });
    }

    it("a whole-chat replace keeping ids and texts cancels the task (`sourceChanged`); the pending answer writes nothing", async () => {
        const t = harness();
        const { terminal, second } = await afterFirstSummary(t);
        const chat = t.chat("k1")!;
        t.write("k1", [{ op: "replace", chat: { ...chat, scriptstate: { replaced: "yes" } } }]);
        const end = await terminal;
        expect(end.status).toMatchObject({
            state: "cancelled",
            reason: "sourceChanged",
            done: 1,
            terminalRevision: t.revision("k1"),
        });
        second.answer("Summary 2");
        await turns();
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
        expect(t.provider.requests).toHaveLength(2);
        // The replaced chat's retained input is gone: a manual start waits for the next send.
        expect(t.service.start(ref("k1"))).toEqual({ outcome: "pendingManual" });
    });

    it("an invalidation notice at or below the task's source generation (a listener seeing newer state) leaves the task, the retained input, and the manual start alone", async () => {
        const t = harness();
        const { terminal, second } = await afterFirstSummary(t);
        const input = t.input("k1");
        const notice = { epoch: t.store.epoch(), characterId: "c", id: "k1", sourceGeneration: input.sourceGeneration };
        t.service.invalidate(notice);
        t.service.invalidate({ ...notice, sourceGeneration: input.sourceGeneration - 1 });
        t.service.invalidate({ ...notice, epoch: "another-epoch", sourceGeneration: input.sourceGeneration + 1 });
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "running", done: 1 });
        expect(second.signal.aborted).toBe(false);
        // A newer generation ends it.
        t.service.invalidate({ ...notice, sourceGeneration: input.sourceGeneration + 1 });
        expect((await terminal).status).toMatchObject({ state: "cancelled", reason: "sourceChanged", done: 1 });
        expect(t.service.start(ref("k1"))).toEqual({ outcome: "pendingManual" });
        t.service.invalidate(notice);
        expect(t.service.pendingManual(ref("k1"))).toBe(true);
    });

    it("an epoch change (a restore) ends every task without a status, keeps its work counted until it settles, and frees its input then", async () => {
        const t = harness({ ignoreAbort: true });
        const { second } = await afterFirstSummary(t);
        const file = path.join(t.dir, "snapshot.sqlite");
        await t.store.backupTo(file);
        const validated = t.store.readSnapshot(file);
        const before = t.events.length;
        t.store.replaceAll(validated);
        t.service.resetEpoch();
        expect(t.events).toHaveLength(before);
        expect(t.service.status(ref("k1"))).toBeNull();
        expect(t.service.snapshot()).toEqual([]);
        expect(t.service.aliveCount()).toBe(1);
        expect(second.signal.aborted).toBe(true);
        second.answer("Summary 2");
        await turns();
        expect(t.service.aliveCount()).toBe(0);
        expect(t.service.retainedBytes()).toBe(0);
        expect(t.events).toHaveLength(before);
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
        // The new epoch admits a fresh hand-off.
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 6 });
        (await t.provider.request(2)).answer("Summary 2");
        (await t.provider.request(3)).answer("Summary 3");
        expect((await terminal).status).toMatchObject({ state: "done", done: 2, total: 2 });
        expect(t.summaries("k1")).toEqual(["Summary 1", "Summary 2", "Summary 3"]);
    });

    it("maintenance cancels the running and queued tasks (`maintenance`) and refuses hand-offs until `resume`, which restarts nothing", async () => {
        const t = harness();
        const { terminal, second } = await afterFirstSummary(t);
        const lease = await t.service.acquireSummaryWriter(ref("k2"), "job-2");
        handOff(t, "k2", { entries: 2 });
        const k2Terminal = t.nextTerminal("k2");
        t.gate.active = true;
        t.service.pause();
        expect((await terminal).status).toMatchObject({ state: "cancelled", reason: "maintenance", done: 1 });
        expect((await k2Terminal).status).toMatchObject({
            state: "cancelled",
            reason: "maintenance",
            done: 0,
            total: 0,
        });
        expect(t.service.queuedCount()).toBe(0);
        handOff(t, "k3", { entries: 2 });
        expect(t.service.status(ref("k3"))).toBeNull();
        expect(t.service.start(ref("k3"))).toEqual({ outcome: "refused", reason: "maintenance" });
        second.answer("Summary 2");
        await turns();
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
        t.gate.active = false;
        t.service.resume();
        lease.release();
        await turns();
        expect(t.provider.requests).toHaveLength(2);
        expect(t.service.snapshot().map((e) => [e.chatRef.chatId, e.status.state])).toEqual([
            ["k1", "cancelled"],
            ["k2", "cancelled"],
        ]);
        const k3Terminal = t.nextTerminal("k3");
        handOff(t, "k3", { entries: 2 });
        (await t.provider.request(2)).answer("Summary 3");
        expect((await k3Terminal).status).toMatchObject({ state: "done" });
    });

    it("shutdown cancels the tasks (`shutdown`), refuses hand-offs and starts, and `drain` resolves once the aborted work settles", async () => {
        const t = harness({ ignoreAbort: true });
        const { terminal, second } = await afterFirstSummary(t);
        t.service.beginShutdown();
        expect((await terminal).status).toMatchObject({ state: "cancelled", reason: "shutdown", done: 1 });
        handOff(t, "k2", { entries: 2 });
        expect(t.service.status(ref("k2"))).toBeNull();
        expect(t.service.start(ref("k2"))).toEqual({ outcome: "refused", reason: "shuttingDown" });
        expect(t.service.aliveCount()).toBe(1);
        let drained = false;
        const drain = t.service.drain().then(() => {
            drained = true;
        });
        await turns();
        expect(drained).toBe(false);
        second.answer("Summary 2");
        await drain;
        expect(t.service.aliveCount()).toBe(0);
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
    });
});

describe("the writer lease", () => {
    it("closes the running task's fence at acquisition: a late provider result writes nothing, and a manual start meanwhile only queues", async () => {
        const t = harness({ ignoreAbort: true });
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 4 });
        const first = await t.provider.request(0);
        const lease = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        expect((await terminal).status).toMatchObject({
            state: "cancelled",
            reason: "writerLease",
            done: 0,
            total: 2,
            terminalRevision: t.revision("k1"),
        });
        expect(first.signal.aborted).toBe(true);
        // The provider still answers: the task is ended, so nothing is saved.
        first.answer("Summary 1");
        await turns();
        expect(t.summaries("k1")).toEqual([]);
        expect(t.service.aliveCount()).toBe(0);
        const started = t.service.start(ref("k1"));
        expect(started).toMatchObject({ outcome: "queued", status: { state: "queued" } });
        await turns();
        expect(t.provider.requests).toHaveLength(1);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "queued" });
        // The lease holder (the job) saves its own summary meanwhile; the task runs after the release.
        t.write("k1", [
            {
                op: "meta",
                set: {
                    hypaV3Data: { summaries: [{ text: "Job summary", chatMemos: [null, "m1"], isImportant: false }] },
                },
            },
        ]);
        const rerun = t.nextTerminal("k1");
        lease.release();
        const second = await t.provider.request(1);
        expect(t.provider.asked(second)).toContain("Char line 2");
        second.answer("Summary 2");
        expect((await rerun).status).toMatchObject({ state: "done", done: 1, total: 1 });
        expect(t.summaries("k1")).toEqual(["Job summary", "Summary 2"]);
    });

    it("a hand-off while the lease is held queues and runs after the release; a second lease holder keeps it queued", async () => {
        const t = harness();
        const first = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        const second = await t.service.acquireSummaryWriter(ref("k1"), "job-2");
        handOff(t, "k1", { entries: 2 });
        first.release();
        first.release();
        await turns();
        expect(t.provider.requests).toHaveLength(0);
        const terminal = t.nextTerminal("k1");
        second.release();
        (await t.provider.request(0)).answer("Summary 1");
        expect((await terminal).status).toMatchObject({ state: "done" });
    });
});

describe("the start checks", () => {
    for (const [name, reason, options, change] of [
        [
            "the owner's memory turned off",
            "memoryOff",
            {},
            (t: Harness) => t.updateOwner((o) => ({ ...o, supaMemory: false })),
        ],
        [
            "HypaV2 selected",
            "notHypaV3",
            {},
            (t: Harness) => t.replace("memoryTranslateMedia", (s: any) => ({ ...s, hypav2: true })),
        ],
        ["a Plugin `memory` slot", "pluginModel", { memoryModelId: "pluginmodel:::prov" }, () => {}],
        [
            "an applicable `request` trigger",
            "requestTrigger",
            {},
            (t: Harness) => t.updateOwner((o) => ({ ...o, triggerscript: [REQUEST_TRIGGER] })),
        ],
        [
            "a local summarization model",
            "localSummarization",
            {},
            (t: Harness) =>
                t.replace("hypaV3Presets", (d: any) => ({
                    ...d,
                    items: [{ ...d.items[0], settings: { ...d.items[0].settings, summarizationModel: "localModel" } }],
                })),
        ],
        [
            "a changed memory setting (the fingerprint)",
            "staleInput",
            {},
            (t: Harness) =>
                t.replace("hypaV3Presets", (d: any) => ({
                    ...d,
                    items: [{ ...d.items[0], settings: { ...d.items[0].settings, memoryTokensRatio: 0.3 } }],
                })),
        ],
        [
            "a changed chat binding",
            "bindingInvalid",
            {},
            (t: Harness) => t.write("k1", [{ op: "meta", set: { promptPresetId: "p2" } }]),
        ],
        [
            "a whole-chat replace before the start (no invalidation listener)",
            "staleInput",
            { invalidations: false },
            (t: Harness) => t.write("k1", [{ op: "replace", chat: t.chat("k1")! }]),
        ],
    ] as const) {
        it(`${name}: the task ends \`skipped\` (\`${reason}\`) without a request`, async () => {
            const t = harness(options);
            const terminal = t.nextTerminal("k1");
            handOff(t, "k1", { entries: 4 });
            change(t);
            const end = await terminal;
            expect(end.status).toEqual({
                taskId: end.status.taskId,
                state: "skipped",
                reason,
                done: 0,
                total: 0,
                terminalRevision: t.revision("k1"),
            });
            await turns();
            expect(t.provider.requests).toHaveLength(0);
            expect(t.summaries("k1")).toEqual([]);
            expect(t.states("k1")).toEqual(["queued", "running", "skipped"]);
        });
    }

    it("a chat deleted before the start (no invalidation listener): `skipped` (`chatGone`) with a null revision", async () => {
        const t = harness({ invalidations: false });
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 4 });
        t.write("k1", [{ op: "delete" }]);
        expect((await terminal).status).toMatchObject({ state: "skipped", reason: "chatGone", terminalRevision: null });
    });

    it("stored coverage past the input's history: `skipped` (`staleInput`) after the preparation, with the stored summary kept", async () => {
        const t = harness();
        t.write("k1", [
            {
                op: "meta",
                set: {
                    hypaV3Data: {
                        summaries: [{ text: "Covers more", chatMemos: ["m1", "m2", "m3", "m4"], isImportant: false }],
                    },
                },
            },
        ]);
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 3 });
        const end = await terminal;
        expect(end.status).toMatchObject({
            state: "skipped",
            reason: "staleInput",
            done: 0,
            total: 0,
            terminalRevision: t.revision("k1"),
        });
        expect(t.provider.requests).toHaveLength(0);
        expect(t.summaries("k1")).toEqual(["Covers more"]);
    });

    it("an input of another epoch or source generation is not accepted by a hand-off", async () => {
        const t = harness();
        const input = t.input("k1", { entries: 2 });
        t.service.handOff({ ...input, epoch: "another-epoch" });
        t.service.handOff({ ...input, sourceGeneration: input.sourceGeneration + 1 });
        expect(t.service.status(ref("k1"))).toBeNull();
        expect(t.service.queuedCount()).toBe(0);
        expect(t.service.retainedBytes()).toBe(0);
    });
});

describe("a manual start", () => {
    it("reuses the chat's retained input while it is current, and after a changed setting discards it and waits for the next send (`pendingManual`), which a hand-off satisfies", async () => {
        const t = harness();
        const k1Done = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 2 });
        (await t.provider.request(0)).answer("Summary 1");
        await k1Done;
        expect(t.service.pendingManual(ref("k1"))).toBe(false);
        // The retained input is current: queued again under a new task id.
        const started = t.service.start(ref("k1"));
        expect(started).toMatchObject({ outcome: "queued", status: { state: "queued" } });
        expect(t.service.start(ref("k1"))).toEqual(started);
        const again = t.nextTerminal("k1");
        // The stored summary covers the input: nothing to summarize.
        expect((await again).status).toMatchObject({ state: "done", done: 0, total: 0 });
        expect(t.provider.requests).toHaveLength(1);
        // The ended task's work settles a turn later; the input is the chat's idle latest one then.
        await turns();

        t.replace("hypaV3Presets", (d: any) => ({
            ...d,
            items: [{ ...d.items[0], settings: { ...d.items[0].settings, memoryTokensRatio: 0.3 } }],
        }));
        expect(t.service.start(ref("k1"))).toEqual({ outcome: "pendingManual" });
        expect(t.service.pendingManual(ref("k1"))).toBe(true);
        expect(t.service.retainedBytes()).toBe(0);
        await turns();
        expect(t.provider.requests).toHaveLength(1);
        // A whole-chat replace discards the pending manual start.
        t.write("k1", [{ op: "replace", chat: t.chat("k1")! }]);
        expect(t.service.pendingManual(ref("k1"))).toBe(false);
        expect(t.service.start(ref("k1"))).toEqual({ outcome: "pendingManual" });
        handOff(t, "k1", { entries: 2 });
        expect(t.events.at(-1)!.status.state).toBe("queued");
        expect(t.service.pendingManual(ref("k1"))).toBe(false);
        expect(t.service.start(ref("k1"))).toMatchObject({ outcome: "queued" });
        expect(t.service.cancel(ref("k1"))).toBe(true);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "cancelled", reason: "cancelled" });
        expect(t.service.cancel(ref("k1"))).toBe(false);
    });

    it("refuses a gone chat and a full queue, and reports a running task", async () => {
        const t = harness({ limits: { maxPendingChats: 1 } });
        expect(t.service.start(ref("nope"))).toEqual({ outcome: "refused", reason: "chatGone" });
        handOff(t, "k1", { entries: 4 });
        await t.provider.request(0);
        expect(t.service.start(ref("k1"))).toMatchObject({
            outcome: "running",
            status: { state: "running", total: 2 },
        });
        const k2Done = t.nextTerminal("k2");
        handOff(t, "k2", { entries: 2 });
        (await t.provider.request(1)).answer("Summary 2");
        await k2Done;
        const lease = await t.service.acquireSummaryWriter(ref("k3"), "job-3");
        handOff(t, "k3", { entries: 2 });
        expect(t.service.start(ref("k2"))).toEqual({ outcome: "refused", reason: "queueFull" });
        lease.release();
    });
});

describe("late work and terminals", () => {
    it("a late completion after a cancel does not overwrite a newer task's status", async () => {
        const t = harness({ ignoreAbort: true });
        handOff(t, "k1", { entries: 2 });
        const first = await t.provider.request(0);
        const cancelled = t.nextTerminal("k1");
        expect(t.service.cancel(ref("k1"))).toBe(true);
        expect((await cancelled).status).toMatchObject({ state: "cancelled", reason: "cancelled" });
        expect(t.service.aliveCount()).toBe(1);
        const newer = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 2 });
        (await t.provider.request(1)).answer("Summary 1");
        const done = await newer;
        expect(done.status).toMatchObject({ state: "done", done: 1, total: 1 });
        const seen = t.events.length;
        // The cancelled task's provider answers now: its result is dropped, nothing is published.
        first.answer("Late summary");
        await turns();
        expect(t.service.aliveCount()).toBe(0);
        expect(t.events).toHaveLength(seen);
        expect(t.service.status(ref("k1"))).toEqual(done.status);
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
    });

    it("a warming failure keeps the summaries: the task ends `done` with `warmingFailed` and the redacted error", async () => {
        const t = harness({ embeddingFail: true });
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 2 });
        (await t.provider.request(0)).answer("Summary 1");
        const end = await terminal;
        expect(end.status).toMatchObject({ state: "done", reason: "warmingFailed", done: 1, total: 1 });
        expect(end.status.state === "done" ? end.status.error : "").toContain("the embedding provider is down");
        expect(t.embeddings.bodies).toHaveLength(1);
        expect(t.summaries("k1")).toEqual(["Summary 1"]);
    });

    it("a failed first request ends `failed` with the redacted provider error, no commit, and the chat's revision", async () => {
        const t = harness();
        const revision = t.revision("k1");
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 4 });
        (await t.provider.request(0)).fail(`denied for ${PROXY_KEY}`);
        const end = await terminal;
        expect(end.status).toMatchObject({ state: "failed", done: 0, total: 2, terminalRevision: revision });
        expect(end.status).not.toHaveProperty("lastCommittedRevision");
        const error = end.status.state === "failed" ? end.status.error! : "";
        expect(error).toContain("Summarization failed");
        expect(error).toContain("denied for");
        expect(error).not.toContain(PROXY_KEY);
        await turns();
        expect(t.provider.requests).toHaveLength(1);
        expect(t.summaries("k1")).toEqual([]);
    });

    it("a queued task cancelled before it starts carries the chat's revision", async () => {
        const t = harness();
        const lease = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        handOff(t, "k1", { entries: 2 });
        const queued = t.events.at(-1)!;
        expect(t.service.cancel(ref("k1"))).toBe(true);
        expect(t.events.at(-1)!.status).toEqual({
            taskId: queued.status.taskId,
            state: "cancelled",
            reason: "cancelled",
            done: 0,
            total: 0,
            terminalRevision: t.revision("k1"),
        });
        expect(t.service.queuedCount()).toBe(0);
        lease.release();
        await turns();
        expect(t.provider.requests).toHaveLength(0);
    });

    it("the deadline fails the task once the clock passes it, closing its writes", async () => {
        const t = harness({ limits: { taskDeadlineMs: 60_000 } });
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 4 });
        const first = await t.provider.request(0);
        t.clock.now += 60_000;
        first.answer("Summary 1");
        const end = await terminal;
        expect(end.status).toMatchObject({
            state: "failed",
            reason: "deadline",
            done: 0,
            total: 2,
            terminalRevision: t.revision("k1"),
        });
        await turns();
        expect(t.summaries("k1")).toEqual([]);
        expect(t.provider.requests).toHaveLength(1);
    });

    it("a terminal status is reported for the retention time, then forgotten", async () => {
        const t = harness({ limits: { terminalRetentionMs: 600_000 } });
        const terminal = t.nextTerminal("k1");
        handOff(t, "k1", { entries: 2 });
        (await t.provider.request(0)).answer("Summary 1");
        await terminal;
        t.clock.now += 599_999;
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "done" });
        expect(t.service.snapshot()).toHaveLength(1);
        t.clock.now += 1;
        expect(t.service.status(ref("k1"))).toBeNull();
        expect(t.service.snapshot()).toEqual([]);
        // The chat's retained input outlives the status: a manual start reuses it.
        expect(t.service.start(ref("k1"))).toMatchObject({ outcome: "queued" });
    });
});

describe("re-entrant callers", () => {
    it("a listener that cancels on `queued` leaves the other listeners seeing `queued` before `cancelled`", async () => {
        const t = harness();
        const lease = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        const seen: string[] = [];
        t.service.onStatus((event) => {
            if (event.status.state === "queued") {
                t.service.cancel(ref("k1"));
            }
        });
        t.service.onStatus((event) => seen.push(event.status.state));
        handOff(t, "k1", { entries: 2 });
        expect(seen).toEqual(["queued", "cancelled"]);
        expect(t.states("k1")).toEqual(["queued", "cancelled"]);
        expect(t.service.status(ref("k1"))).toMatchObject({ state: "cancelled" });
        lease.release();
    });

    it("a listener that restores and resets the epoch while maintenance ends the tasks: no old-epoch terminal follows", async () => {
        const t = harness();
        const file = path.join(t.dir, "snapshot.sqlite");
        await t.store.backupTo(file);
        const validated = t.store.readSnapshot(file);
        const lease1 = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        const lease2 = await t.service.acquireSummaryWriter(ref("k2"), "job-2");
        handOff(t, "k1", { entries: 2 });
        handOff(t, "k2", { entries: 2 });
        const oldEpoch = t.store.epoch();
        const seen: [string, string, string][] = [];
        let reset = false;
        t.service.onStatus((event) => {
            seen.push([event.chatRef.chatId, event.status.state, event.epoch === oldEpoch ? "old" : "new"]);
            if (!reset && event.status.state === "cancelled") {
                reset = true;
                t.store.replaceAll(validated);
                t.service.resetEpoch();
            }
        });
        // A listener after the resetting one: the old epoch's event does not reach it.
        const later: string[] = [];
        t.service.onStatus((event) => later.push(`${event.chatRef.chatId}:${event.status.state}`));
        t.service.pause();
        expect(seen).toEqual([["k1", "cancelled", "old"]]);
        expect(later).toEqual([]);
        expect(t.service.snapshot()).toEqual([]);
        expect(t.service.queuedCount()).toBe(0);
        expect(t.service.retainedBytes()).toBe(0);
        lease1.release();
        lease2.release();
    });

    it("a hand-off made from an abort callback of a task the epoch reset ends is admitted to the new registry", async () => {
        const t = harness();
        handOff(t, "k1", { entries: 2 });
        const first = await t.provider.request(0);
        const admitted = t.input("k2", { entries: 2 });
        first.signal.addEventListener("abort", () => t.service.handOff(admitted), { once: true });
        t.service.resetEpoch();
        expect(t.service.queuedCount()).toBe(1);
        expect(t.service.snapshot().map((e) => [e.chatRef.chatId, e.status.state])).toEqual([["k2", "queued"]]);
        const terminal = t.nextTerminal("k2");
        (await t.provider.request(1)).answer("Summary 2");
        expect((await terminal).status).toMatchObject({ state: "done" });
        expect(t.summaries("k2")).toEqual(["Summary 2"]);
        await turns();
        expect(t.service.aliveCount()).toBe(0);
        // Only k2's idle latest input is retained; the ended task's input was freed when it settled.
        expect(t.service.retainedBytes()).toBe(sizeOf(admitted));
    });

    it("an abort callback of a task the writer lease ends never sees it running: a manual start made there queues the retained input", async () => {
        const t = harness();
        handOff(t, "k1", { entries: 2 });
        const first = await t.provider.request(0);
        let started: unknown;
        let seen: unknown;
        first.signal.addEventListener(
            "abort",
            () => {
                seen = t.service.status(ref("k1"));
                started = t.service.start(ref("k1"));
            },
            { once: true },
        );
        const lease = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        expect(seen).toMatchObject({ state: "cancelled", reason: "writerLease" });
        expect(started).toMatchObject({ outcome: "queued" });
        const states = t.states("k1");
        // Running at the start and with the plan's total, the lease's terminal, then the queued input.
        expect(states.slice(0, 4)).toEqual(["queued", "running", "running", "cancelled"]);
        expect(states.length).toBeGreaterThan(4);
        expect(states.slice(4).every((state) => state === "queued")).toBe(true);
        lease.release();
        const terminal = t.nextTerminal("k1");
        (await t.provider.request(1)).answer("Summary 1");
        expect((await terminal).status).toMatchObject({ state: "done" });
    });

    it("a listener that removes and registers itself again during delivery is called once per event", async () => {
        const t = harness();
        const lease = await t.service.acquireSummaryWriter(ref("k1"), "job-1");
        let calls = 0;
        const listen = () => {
            const off = t.service.onStatus(() => {
                calls++;
                if (calls < 4) {
                    off();
                    listen();
                }
            });
        };
        listen();
        handOff(t, "k1", { entries: 2 });
        expect(calls).toBe(1);
        lease.release();
    });
});

// -------------------------------------------------------------------------------------------------
// The server wiring

type MemoryTaskFrame = Extract<EventFeedFrame, { type: "memoryTask" }>;
type ChangeFrame = Extract<EventFeedFrame, { type: "change" }>;
type HelloFrame = Extract<EventFeedFrame, { type: "hello" }>;
type Terminal = Extract<MemoryTaskStatusOf, { terminalRevision: string | null }>;
type MemoryTaskStatusOf = MemoryTaskFrame["status"];

const isTaskOf =
    (chatId: string) =>
    (frame: EventFeedFrame): frame is MemoryTaskFrame =>
        frame.type === "memoryTask" && frame.characterId === "c" && frame.chatId === chatId;
const isChangeOf =
    (chatId: string) =>
    (frame: EventFeedFrame): frame is ChangeFrame =>
        frame.type === "change" && frame.changes.chats.some((chat) => chat.characterId === "c" && chat.id === chatId);
const isTerminal = (frame: MemoryTaskFrame) => TERMINAL.has(frame.status.state);

type HeldRequest = {
    body: any;
    /** Answers with a summary text (nothing when the request layer closed the connection already). */
    answer(text: string): void;
    /** Answers with a provider error. */
    fail(message: string): void;
};

/**
 * A listening chat provider: every request waits for the test's answer (the context's request layer
 * uses the real `fetch`, so the profile's reverse-proxy URL points here).
 */
async function loopbackProvider() {
    const requests: HeldRequest[] = [];
    const arrivals: (() => void)[] = [];
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        res.on("error", () => {});
        const send = (status: number, body: unknown) => {
            try {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(body));
            } catch {
                // The connection is gone (the task was ended): the answer reaches nothing.
            }
        };
        requests.push({
            body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
            answer: (text) => send(200, { choices: [{ message: { role: "assistant", content: text } }] }),
            fail: (message) => send(400, { error: { message } }),
        });
        for (const arrival of arrivals.splice(0)) {
            arrival();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = allowListenerOrigin(server);
    return {
        url: `${origin}/v1/chat/completions`,
        requests,
        /** Resolves once the request with `index` (in arrival order) has arrived. */
        request(index: number): Promise<HeldRequest> {
            return new Promise((resolve) => {
                const check = () => {
                    if (requests[index]) {
                        resolve(requests[index]);
                    } else {
                        arrivals.push(check);
                    }
                };
                check();
            });
        },
        close() {
            server.closeAllConnections();
            server.close();
        },
    };
}

/** A listening embedding server (`hypaModel: "custom"`): a vector per input. */
async function loopbackEmbedder() {
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                data: input.map((text) => ({ embedding: [1, (text.length % 7) + 1, (text.charCodeAt(0) % 5) + 1] })),
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `${allowListenerOrigin(server)}/v1`,
        close() {
            server.closeAllConnections();
            server.close();
        },
    };
}

type SocketClient = {
    frames: EventFeedFrame[];
    closed: Promise<number>;
    ws: WsClient;
};

/**
 * A server context with the real memory task service (the runner's, as in production) and the manual
 * routes open, on a listening server, seeded with `openStore`'s records (written through the resource routes from a local store of
 * the same content, so a scope read from the local store is a scope of the server's data: the inputs
 * a job would hand off carry the server's epoch and chat revisions).
 */
async function wiring(options: { limits?: Partial<MemoryTaskLimits> } = {}) {
    const provider = await loopbackProvider();
    const embedder = await loopbackEmbedder();
    const local = openStore({
        providerUrl: provider.url,
        memorySection: { hypaModel: "custom" },
        secrets: { hypaCustomSettings: { url: embedder.url, key: "custom-KEY-4444", model: "emb" } },
    });
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-memory-wiring-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
    // The tokenizers load their vocabularies from `public/token`.
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    const clock = { now: 1_000_000 };
    const server = createTestServer({
        rootDir,
        scriptWorkerOptions: UNHURRIED_SCRIPT_WORKERS,
        cbsTimeLimits: UNHURRIED_CBS,
        generationHypaV3SeparatorLimits: UNHURRIED_HYPAV3_SEPARATOR,
        memoryTaskOptions: {
            now: () => clock.now,
            limits: { drainWaitMs: 1000, ...options.limits },
        },
    });
    const node = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => node.once("listening", () => resolve()));
    allowListenerOrigin(node);
    server.context.attachWebSocket(node);
    const port = (node.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const signer = await createSigner();
    await fetch(`${base}/api/login`, jsonInit({ password: "pw", publicKey: signer.publicJwk }));
    const sockets: SocketClient[] = [];
    cleanups.push(async () => {
        for (const socket of sockets.splice(0)) {
            socket.ws.terminate();
        }
        await server.close();
        node.closeAllConnections();
        await new Promise((resolve) => node.close(resolve));
        provider.close();
        embedder.close();
        local.dispose();
    });

    const w = {
        rootDir,
        base,
        context: server.context,
        provider,
        local,
        clock,
        epoch: "",
        /** The server's revision of each chat at its creation. */
        revisions: {} as Record<string, string>,
        /** A request with a JWT and the epoch header (`epoch`: another value; null: none). */
        async api(
            url: string,
            init: RequestInit = {},
            epoch: string | null | undefined = undefined,
        ): Promise<{ status: number; headers: Headers; body: any }> {
            const headers: Record<string, string> = {
                "risu-auth": await signer.jwt(),
                "content-type": "application/json",
                ...((init.headers as Record<string, string> | undefined) ?? {}),
            };
            const value = epoch === undefined ? w.epoch : epoch;
            if (value !== null) {
                headers["x-resource-epoch"] = value;
            }
            const res = await fetch(`${base}${url}`, { ...init, headers });
            let body: any = null;
            try {
                body = await res.json();
            } catch {}
            return { status: res.status, headers: res.headers, body };
        },
        start: (body: unknown, epoch?: string | null) =>
            w.api(
                "/api/memory/tasks",
                { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) },
                epoch,
            ),
        cancel: (characterId: string, chatId: string, epoch?: string | null) =>
            w.api(
                `/api/memory/tasks/${encodeURIComponent(characterId)}/${encodeURIComponent(chatId)}`,
                { method: "DELETE" },
                epoch,
            ),
        /** The chat as stored on the server (`revision` and `data` null once it is gone). */
        async chat(chatId: string): Promise<{ revision: string | null; data: Chat | null }> {
            const read = await w.api("/api/resources/read", {
                method: "POST",
                body: JSON.stringify({ chats: [{ characterId: "c", id: chatId }] }),
            });
            expect(read.status).toBe(200);
            return read.body.chats[0];
        },
        /** The input a job of the server's chat would hand off. */
        input: (chatId: string, over: Partial<MemoryTaskInput> & { entries?: number } = {}) =>
            inputOf(local, local.jobScope(chatId), { epoch: w.epoch, admittedRevision: w.revisions[chatId], ...over }),
        handOff(chatId: string, over: Partial<MemoryTaskInput> & { entries?: number } = {}) {
            const input = w.input(chatId, over);
            server.context.memoryTasks!.handOff(input);
            return input;
        },
        /** A live-update socket, resolved once its `hello` arrived. */
        async socket(): Promise<SocketClient> {
            const ws = new WsClient(`ws://127.0.0.1:${port}/api/events/ws?risu-auth=${await signer.jwt()}`);
            const frames: EventFeedFrame[] = [];
            const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
            ws.on("error", () => {});
            ws.on("message", (data) => frames.push(JSON.parse(String(data)) as EventFeedFrame));
            const client = { frames, closed, ws };
            sockets.push(client);
            await waitFor(() => frames.length > 0);
            return client;
        },
        /** The first frame of `client` that `test` accepts, once it arrived. */
        async frame<T extends EventFeedFrame>(
            client: SocketClient,
            test: (frame: EventFeedFrame) => frame is T,
        ): Promise<T> {
            await waitFor(() => client.frames.some(test));
            return client.frames.find(test)!;
        },
        /** The chat's first terminal frame on `client`. */
        terminal: (client: SocketClient, chatId: string) =>
            w.frame(client, (frame): frame is MemoryTaskFrame => isTaskOf(chatId)(frame) && isTerminal(frame)),
        /** Answers the chat's summary requests in arrival order until its task ends; the terminal frame. */
        async drive(
            client: SocketClient,
            chatId: string,
            from: number,
        ): Promise<{ terminal: MemoryTaskFrame; answered: number }> {
            let answered = 0;
            for (let index = from; ; index++) {
                const next = await Promise.race([
                    provider.request(index).then((request) => ({ request })),
                    w.terminal(client, chatId).then((terminal) => ({ terminal })),
                ]);
                if ("terminal" in next) {
                    return { terminal: next.terminal, answered };
                }
                next.request.answer(`Summary ${index + 1}`);
                answered++;
            }
        },
    };
    w.epoch = (await w.api("/api/resources/ui")).body.epoch;
    const kind = (name: string) => local.kinds.get(name)!;
    for (const name of [
        "personas",
        "presets",
        "modelProfiles",
        "modelPresets",
        "providers",
        "credentials",
        "memoryTranslateMedia",
        "hypaV3Presets",
        "secrets",
    ]) {
        const current = await w.api(`/api/resources/${name}/main`);
        const put = await w.api(`/api/resources/${name}/main`, {
            method: "PUT",
            body: JSON.stringify({
                baseRevision: current.body.revision,
                data: local.store.get(kind(name), "main")!.data,
            }),
        });
        expect(put.status, name).toBe(200);
    }
    const secrets = await w.api("/api/resources/llmSecrets/main");
    const credential = await w.api("/api/llm-secrets/credentials/~proxy/key", {
        method: "PUT",
        body: JSON.stringify({ value: PROXY_KEY, baseRevision: secrets.body.revision }),
    });
    expect(credential.status).toBe(200);
    const owner = await w.api("/api/resources/characters/c", {
        method: "PUT",
        body: JSON.stringify({ baseRevision: null, data: local.store.get(kind("characters"), "c")!.data }),
    });
    expect(owner.status).toBe(200);
    const created = await w.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            chats: CHATS.map((chatId) => ({
                characterId: "c",
                chatId,
                baseRevision: null,
                ops: [{ op: "create", chat: local.chat(chatId) }],
            })),
        }),
    });
    expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200);
    CHATS.forEach((chatId, index) => {
        w.revisions[chatId] = created.body.chats[index].revision;
    });
    return w;
}

describe("the server wiring", () => {
    it("answers 400, not 500, when the task body stream fails without a declared length", async () => {
        const s = await createResourceTestClient();
        cleanups.push(() => s.close());
        const res = await s.request("/api/memory/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"characterId":'));
                    controller.error(new DOMException("The client went away", "AbortError"));
                },
            }),
            duplex: "half",
        } as RequestInit);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    });

    it("frames reach a socket in publication order (a summary's `change` before the status counting it) and `hello` reports a running task and a recent failure, one status per chat", async () => {
        const w = await wiring();
        const a = await w.socket();
        expect(a.frames[0]).toEqual({ type: "hello", epoch: w.epoch, memoryTasks: [] });

        w.handOff("k1");
        const { terminal: done, answered } = await w.drive(a, "k1", 0);
        expect(answered).toBeGreaterThan(0);
        const k1 = a.frames.filter(isTaskOf("k1"));
        expect(k1[0].status.state).toBe("queued");
        expect(k1.slice(1, -1).every((frame) => frame.status.state === "running")).toBe(true);
        expect(k1.at(-1)).toBe(done);
        const status = done.status as Terminal;
        expect(status).toMatchObject({ state: "done", done: answered, total: answered });
        expect(status.reason).toBeUndefined();
        for (let i = 1; i < k1.length; i++) {
            expect(k1[i].status.done).toBeGreaterThanOrEqual(k1[i - 1].status.done);
        }
        // One `change` frame per saved summary, each before the first status that counts it; the
        // terminal carries the last one's revision.
        const writes = a.frames.filter(isChangeOf("k1"));
        expect(writes).toHaveLength(answered);
        for (const frame of k1) {
            if (frame.status.done > 0) {
                expect(a.frames.indexOf(frame)).toBeGreaterThan(a.frames.indexOf(writes[frame.status.done - 1]));
            }
        }
        const last = writes.at(-1)!.changes.chats.find((chat) => chat.id === "k1")!.revision;
        expect(status.terminalRevision).toBe(last);
        expect(status.lastCommittedRevision).toBe(last);
        const stored = (await w.chat("k1"))!;
        expect(stored.revision).toBe(last);
        expect((stored.data!.hypaV3Data as SerializableHypaV3Data).summaries).toHaveLength(answered);

        // The done task's status expires; a failure and a running task remain for `hello`.
        w.clock.now += MEMORY_TASK_LIMITS.terminalRetentionMs;
        w.handOff("k2");
        (await w.provider.request(answered)).fail("the provider broke");
        const failed = await w.terminal(a, "k2");
        expect(failed.status).toMatchObject({ state: "failed", done: 0, terminalRevision: w.revisions.k2 });
        expect((failed.status as Terminal).error).toContain("the provider broke");
        expect(JSON.stringify(a.frames)).not.toContain(PROXY_KEY);
        w.handOff("k3");
        await w.provider.request(answered + 1);
        const running = a.frames.filter(isTaskOf("k3")).at(-1)!;
        expect(running.status.state).toBe("running");

        const b = await w.socket();
        const hello = b.frames[0] as HelloFrame;
        expect(hello.type).toBe("hello");
        expect(hello.epoch).toBe(w.epoch);
        expect(hello.memoryTasks.map((entry) => [entry.characterId, entry.chatId, entry.status.state]).sort()).toEqual([
            ["c", "k2", "failed"],
            ["c", "k3", "running"],
        ]);
        expect(hello.memoryTasks.find((entry) => entry.chatId === "k3")!.status).toEqual(running.status);
        expect(hello.memoryTasks.find((entry) => entry.chatId === "k2")!.status).toEqual(failed.status);
    });

    it("maintenance ends a running task `cancelled` (`maintenance`) before the request layer pauses, refuses a start meanwhile (503, Retry-After), and the late provider result writes nothing", async () => {
        const w = await wiring();
        const a = await w.socket();
        w.handOff("k1");
        const held = await w.provider.request(0);
        await w.context.snapshots.withMaintenance(async () => {
            const terminal = await w.terminal(a, "k1");
            expect(terminal.status).toMatchObject({
                state: "cancelled",
                reason: "maintenance",
                done: 0,
                terminalRevision: w.revisions.k1,
            });
            const refused = await w.start({ characterId: "c", chatId: "k2" });
            expect(refused.status).toBe(503);
            expect(refused.body).toEqual({ error: "The server data is being replaced", reason: "maintenance" });
            expect(refused.headers.get("retry-after")).toBe("5");
            expect(refused.headers.get("cache-control")).toBe("no-store");
        });
        held.answer("A late summary");
        // Once the maintenance ended, a hand-off runs again (its first request is the sync point).
        w.handOff("k2");
        await w.provider.request(1);
        expect(a.frames.filter(isTaskOf("k2")).at(-1)!.status.state).toBe("running");
        const stored = (await w.chat("k1"))!;
        expect(stored.revision).toBe(w.revisions.k1);
        expect(stored.data!.hypaV3Data).toBeUndefined();
        expect(a.frames.filter(isChangeOf("k1"))).toEqual([]);
        const states = a.frames.filter(isTaskOf("k1")).map((frame) => frame.status.state);
        expect(states[0]).toBe("queued");
        expect(states.slice(1, -1).every((state) => state === "running")).toBe(true);
        expect(states.at(-1)).toBe("cancelled");
    });

    it("shutdown ends a running task `cancelled` (`shutdown`) whose terminal reaches the socket before its 1001, refuses the routes (503), and the late result writes nothing", async () => {
        const w = await wiring();
        const a = await w.socket();
        w.handOff("k1");
        const held = await w.provider.request(0);
        w.context.beginShutdown();
        const terminal = await w.terminal(a, "k1");
        expect(terminal.status).toMatchObject({
            state: "cancelled",
            reason: "shutdown",
            terminalRevision: w.revisions.k1,
        });
        expect(await a.closed).toBe(1001);
        expect(a.frames.at(-1)).toBe(terminal);
        held.answer("A late summary");
        const refused = await w.start({ characterId: "c", chatId: "k1" });
        expect(refused.status).toBe(503);
        expect(refused.body).toEqual({ error: "The server is shutting down" });
        expect(refused.headers.get("retry-after")).toBe("5");
        expect(refused.headers.get("cache-control")).toBe("no-store");
        expect((await w.cancel("c", "k1")).status).toBe(503);
        await w.context.dispose();
        const db = new DatabaseSync(path.join(w.rootDir, "save", "data", "resources.sqlite"), { readOnly: true });
        try {
            const row = db.prepare("SELECT meta FROM chats WHERE characterId = 'c' AND id = 'k1'").get() as {
                meta: string;
            };
            expect((JSON.parse(row.meta) as Chat).hypaV3Data).toBeUndefined();
        } finally {
            db.close();
        }
    });

    it("the chat's deletion cancels its running task (`sourceChanged`, revision null) after the deletion's `change` frame; the late result writes nothing", async () => {
        const w = await wiring();
        const a = await w.socket();
        w.handOff("k1");
        const held = await w.provider.request(0);
        const deleted = await w.api("/api/resources/batch", {
            method: "POST",
            body: JSON.stringify({
                chats: [{ characterId: "c", chatId: "k1", baseRevision: w.revisions.k1, ops: [{ op: "delete" }] }],
            }),
        });
        expect(deleted.status).toBe(200);
        const terminal = await w.terminal(a, "k1");
        expect(terminal.status).toMatchObject({ state: "cancelled", reason: "sourceChanged", terminalRevision: null });
        const change = a.frames.find(isChangeOf("k1"))!;
        expect(change.changes.chats).toEqual([{ characterId: "c", id: "k1", revision: null }]);
        expect(a.frames.indexOf(change)).toBeLessThan(a.frames.indexOf(terminal));
        held.answer("A late summary");
        expect(await w.chat("k1")).toMatchObject({ revision: null, data: null });
        expect((await w.start({ characterId: "c", chatId: "k1" })).status).toBe(404);
        expect((await w.cancel("c", "k1")).status).toBe(404);
        expect(a.frames.filter(isChangeOf("k1"))).toEqual([change]);
    });

    it("a restore publishes `epoch` after the maintenance terminals and empties the registry: the socket stays open, a new `hello` carries the new epoch and no old status, and no old-epoch frame follows", async () => {
        const w = await wiring();
        const a = await w.socket();
        w.handOff("k2");
        (await w.provider.request(0)).fail("the provider broke");
        await w.terminal(a, "k2");
        w.handOff("k1");
        const held = await w.provider.request(1);
        const snapshot = await w.context.snapshots.snapshotNow();
        const restored = await w.api(`/api/backups/${snapshot.id}/restore`, { method: "POST" });
        expect(restored.status).toBe(200);
        const next = restored.body.epoch as string;
        expect(next).not.toBe(w.epoch);
        await w.frame(a, (frame): frame is Extract<EventFeedFrame, { type: "epoch" }> => frame.type === "epoch");
        const epochIndex = a.frames.findIndex((frame) => frame.type === "epoch");
        expect(a.frames[epochIndex]).toEqual({ type: "epoch", epoch: next });
        const cancelled = a.frames.filter(isTaskOf("k1")).at(-1)!;
        expect(cancelled.status).toMatchObject({
            state: "cancelled",
            reason: "maintenance",
            terminalRevision: w.revisions.k1,
        });
        expect(a.frames.indexOf(cancelled)).toBeLessThan(epochIndex);
        expect(a.ws.readyState).toBe(WsClient.OPEN);
        held.answer("A late summary");
        const b = await w.socket();
        expect(b.frames[0]).toEqual({ type: "hello", epoch: next, memoryTasks: [] });
        // The old epoch's retained input is gone with the registry: a start waits for the next send.
        w.epoch = next;
        const start = await w.start({ characterId: "c", chatId: "k1" });
        expect(start.status).toBe(200);
        expect(start.body).toEqual({ outcome: "pendingManual" });
        expect(a.frames.slice(epochIndex + 1).filter((frame) => frame.type === "memoryTask")).toEqual([]);
        expect(w.context.memoryTasks!.snapshot()).toEqual([]);
    });

    it("the routes: authentication, 400 for a bad body or id, 412 for a wrong or missing epoch, 404 for a gone chat, 413 over 4 KiB, `pendingManual`, `running`, `queued`, 429 `queueFull`, and a cancel's answer, every answer `no-store`", async () => {
        const w = await wiring({ limits: { maxRunning: 1, maxPendingChats: 1 } });
        const a = await w.socket();
        const body = { characterId: "c", chatId: "k1" };

        const anonymous = await fetch(`${w.base}/api/memory/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-resource-epoch": w.epoch },
            body: JSON.stringify(body),
        });
        // `checkAuth`'s refusal of a request without a token.
        expect(anonymous.status).toBe(400);
        for (const bad of [
            "not json",
            "[1]",
            JSON.stringify({ characterId: "c" }),
            JSON.stringify({ ...body, chatId: 5 }),
        ]) {
            expect((await w.start(bad)).status, bad).toBe(400);
        }
        expect((await w.cancel("c", "x".repeat(600))).status).toBe(400);
        for (const epoch of ["stale", null]) {
            const start = await w.start(body, epoch);
            expect(start.status).toBe(412);
            expect(start.body).toEqual({ error: "EpochMismatch", epoch: w.epoch });
            expect(start.headers.get("cache-control")).toBe("no-store");
            expect((await w.cancel("c", "k1", epoch)).status).toBe(412);
        }
        expect((await w.start({ characterId: "c", chatId: "nope" })).status).toBe(404);
        expect((await w.cancel("c", "nope")).status).toBe(404);
        const oversized = await w.start(JSON.stringify({ ...body, pad: "x".repeat(5000) }));
        expect(oversized.status).toBe(413);
        expect(oversized.headers.get("cache-control")).toBe("no-store");
        expect(a.frames.filter((frame) => frame.type === "memoryTask")).toEqual([]);

        // No retained input: the next send hands off; a cancel clears that.
        const manual = await w.start(body);
        expect(manual.status).toBe(200);
        expect(manual.body).toEqual({ outcome: "pendingManual" });
        expect(manual.headers.get("cache-control")).toBe("no-store");
        expect(w.context.memoryTasks!.pendingManual(ref("k1"))).toBe(true);
        expect((await w.cancel("c", "k1")).body).toEqual({ cancelled: true });
        expect(w.context.memoryTasks!.pendingManual(ref("k1"))).toBe(false);
        expect((await w.cancel("c", "k1")).body).toEqual({ cancelled: false });

        // k1 done (its input retained), k2 running, k3 queued (the running cap): k1's start finds the
        // queue full; a running task is reported; a cancel ends the running task and lets k3 start.
        w.handOff("k1");
        const { terminal: done, answered } = await w.drive(a, "k1", 0);
        w.handOff("k2");
        await w.provider.request(answered);
        w.handOff("k3");
        await w.frame(a, (frame): frame is MemoryTaskFrame => isTaskOf("k3")(frame) && frame.status.state === "queued");
        const full = await w.start(body);
        expect(full.status).toBe(429);
        expect(full.body).toEqual({ error: "Too many chats are waiting for their memory task", reason: "queueFull" });
        const running = await w.start({ characterId: "c", chatId: "k2" });
        expect(running.status).toBe(200);
        expect(running.body).toEqual({ outcome: "running", status: a.frames.filter(isTaskOf("k2")).at(-1)!.status });
        const queued = await w.start({ characterId: "c", chatId: "k3" });
        expect(queued.body).toEqual({ outcome: "queued", status: a.frames.filter(isTaskOf("k3")).at(-1)!.status });
        expect((await w.cancel("c", "k2")).body).toEqual({ cancelled: true });
        expect((await w.terminal(a, "k2")).status).toMatchObject({ state: "cancelled", reason: "cancelled" });
        await w.provider.request(answered + 1);
        expect(a.frames.filter(isTaskOf("k3")).at(-1)!.status.state).toBe("running");
        expect((await w.cancel("c", "k3")).body).toEqual({ cancelled: true });
        expect((await w.cancel("c", "k3")).body).toEqual({ cancelled: false });
        // With the queue empty, k1's retained input is queued again; its task finds the stored
        // summaries already cover that input: a plan with nothing to summarize ends `done` (0 of 0)
        // without a request or a write.
        const again = await w.start(body);
        expect(again.body).toMatchObject({ outcome: "queued", status: { state: "queued" } });
        const taskId = again.body.status.taskId as string;
        const completed = await w.frame(
            a,
            (frame): frame is MemoryTaskFrame =>
                isTaskOf("k1")(frame) && frame.status.taskId === taskId && isTerminal(frame),
        );
        expect(completed.status).toEqual({
            taskId,
            state: "done",
            done: 0,
            total: 0,
            terminalRevision: (done.status as Terminal).terminalRevision,
        });
        expect(w.provider.requests).toHaveLength(answered + 2);
        expect((await w.cancel("c", "k1")).body).toEqual({ cancelled: false });
    });

    it("production opens both routes on the runner's own service; with the runner's service `disabled` or a fake one both answer 503 `notEnabled` (no Retry-After, `no-store`) after the epoch check; a context without a characters kind has no service", async () => {
        const production = await createResourceTestClient();
        cleanups.push(() => production.close());
        expect(production.context.memoryTasks).not.toBeNull();
        // Past the admission check: the chat does not exist.
        const opened = await production.json("/api/memory/tasks", { characterId: "c", chatId: "k" });
        expect(opened.status).toBe(404);
        expect(await opened.json()).toEqual({ error: "Chat not found" });
        expect((await production.request("/api/memory/tasks/c/k", { method: "DELETE" })).status).toBe(404);

        const fake = {
            handOff() {},
            status: () => null,
            acquireSummaryWriter: async () => ({ release() {} }),
            pendingManual: () => false,
        } satisfies MemoryTaskService;
        for (const memoryTasks of ["disabled", fake] as const) {
            const closed = await createResourceTestClient({ memoryTasks });
            cleanups.push(() => closed.close());
            expect(closed.context.memoryTasks).not.toBeNull();
            const start = await closed.json("/api/memory/tasks", { characterId: "c", chatId: "k" });
            expect(start.status).toBe(503);
            expect(await start.json()).toEqual({ error: "Memory tasks are not enabled", reason: "notEnabled" });
            expect(start.headers.get("retry-after")).toBeNull();
            expect(start.headers.get("cache-control")).toBe("no-store");
            const cancel = await closed.request("/api/memory/tasks/c/k", { method: "DELETE" });
            expect(cancel.status).toBe(503);
            expect(await cancel.json()).toEqual({ error: "Memory tasks are not enabled", reason: "notEnabled" });
            expect(cancel.headers.get("retry-after")).toBeNull();
            expect(cancel.headers.get("cache-control")).toBe("no-store");
            expect(
                (await closed.json("/api/memory/tasks", { characterId: "c", chatId: "k" }, {}, "stale")).status,
            ).toBe(412);
        }

        const bare = await createResourceTestClient({
            resourceKinds: [{ name: "docs", schemaVersion: 1, normalize: (input) => input }],
            epochKind: "docs",
        });
        cleanups.push(() => bare.close());
        expect(bare.context.memoryTasks).toBeNull();
        const refused = await bare.json("/api/memory/tasks", { characterId: "c", chatId: "k" });
        expect(refused.status).toBe(503);
        expect(await refused.json()).toEqual({ error: "Memory tasks are not enabled", reason: "notEnabled" });
    });
});
