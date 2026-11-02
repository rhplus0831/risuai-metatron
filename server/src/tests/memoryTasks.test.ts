// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, character, Message } from "../../../shared/database.ts";
import type { EventFeedFrame } from "../../../shared/events.ts";
import type {
    GenerationContext,
    StructuredMemoryTaskInput,
    MemoryChatRef,
    MemoryEntrySource,
    MemoryTaskInput,
    MemoryTaskService,
} from "../../../shared/jobs.ts";
import { LLMFormat } from "../../../shared/llm.ts";
import type { SerializableHypaV3Data } from "../../../shared/memory.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import {
    MEMORY_SECTION_BUDGETS,
    type MemoryEventDraft,
    type MemoryPage,
    normalizeStructuredMemorySettings,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../shared/structuredMemory.ts";
import { MAX_READ_RESPONSE_BYTES } from "../../../shared/resources.ts";
import { defaultPrompts } from "../prompt/memory/structured/prompts.ts";
import { revertChange } from "../prompt/memory/structured/pages.ts";
import { readRecordSet, rebuildSeed } from "../prompt/memory/structured/rebuild.ts";
import { readMemoryRecords } from "../prompt/memory/structured/step.ts";
import { reconcileMessageChanges } from "../prompt/memory/structured/reconcile.ts";
import { retrieveLanes } from "../prompt/memory/structured/retrieve.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ChatInvalidation } from "../data/resourceStore.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { createCheckpointService } from "../data/checkpointService.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import { messageSourceHash, type MemoryEventWrite } from "../data/memoryStore.ts";
import { createVectorCache } from "../data/vectorCache.ts";
import {
    type JobScope,
    loadJobScope,
    memorySettingsFingerprint,
    memoryTokenPolicy,
    scopeChat,
} from "../jobs/jobScope.ts";
import { createLlmRequests } from "../llm/requests.ts";
import { createEmbeddings, HypaProcesser } from "../prompt/embeddings.ts";
import { emptyHypaV3Execution, hypaV3SourceHash, prepareHypaV3, selectHypaV3 } from "../prompt/memory/hypav3.ts";
import { createMemoryTaskHost, type MemoryTaskHostDeps } from "../prompt/memory/memoryTaskHost.ts";
import {
    createMemoryTasks,
    MEMORY_TASK_LIMITS,
    type MemoryTaskEvent,
    type MemoryTaskLimits,
    type StructuredMemoryWriter,
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
import { stageSnapshot } from "./stagedRestore.ts";
import { memoryRecords, writeMemory } from "./memoryFixtures.ts";
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
    // The seeded preset is in token mode; these sizes are ratios.
    budgetMode: "ratio",
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
    rawBody: string;
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
            rawBody: String(init.body),
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
    const lock = createGenerationLock();
    const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds, guard: lock });
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
        lock,
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
    structuredWriter?: StructuredMemoryWriter;
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
        structuredWriter: options.structuredWriter,
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

    it("plans with the response budget reserved: a count due only with `maxResponse` kept is summarized", async () => {
        const t = harness();
        // 700 + the full budget 200 = 900 is over the lookahead's 850; without `maxResponse` (100)
        // it would be 800, and nothing would be due.
        handOff(t, "k1", { entries: 2, currentTokens: 700 });
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
        const staged = await stageSnapshot(file, t.kinds);
        const before = t.events.length;
        t.store.replaceAll(staged.file, staged.report);
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
        const staged = await stageSnapshot(file, t.kinds);
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
                t.store.replaceAll(staged.file, staged.report);
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
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    // The tokenizers load their vocabularies from `server/assets/token`.
    mkdirSync(path.join(rootDir, "server"));
    symlinkSync(path.join(REPO_ROOT, "server/assets"), path.join(rootDir, "server/assets"), "dir");
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

describe("checkpoint loads and memory tasks", () => {
    it("a checkpoint load cancels the context's running task with writerLease and drops its retained manual input", async () => {
        const w = await wiring();
        const service = w.context.memoryTasks!;
        const saved = await w.api(
            "/api/chat-checkpoints/save",
            jsonInit({ characterId: "c", chatId: "k1", name: "Fork" }),
        );
        expect(saved.status).toBe(200);
        const terminal = deferred<MemoryTaskEvent>();
        const unsubscribe = service.onStatus((event) => {
            if (event.chatRef.chatId === "k1" && TERMINAL.has(event.status.state)) terminal.resolve(event);
        });
        cleanups.push(unsubscribe);
        w.handOff("k1", { entries: 2 });
        const held = await w.provider.request(0);
        const loaded = await w.api(
            "/api/chat-checkpoints/load",
            jsonInit({
                characterId: "c",
                chatId: "k1",
                id: saved.body.checkpoint.id,
                chatBaseRevision: w.revisions.k1,
            }),
        );
        expect(loaded.status).toBe(200);
        expect(loaded.headers.get("cache-control")).toBe("no-store");
        expect((await terminal.promise).status).toMatchObject({ state: "cancelled", reason: "writerLease", done: 0 });
        const restored = await w.chat("k1");
        expect(restored.revision).toBe(loaded.body.chatRevision);
        held.answer("Late summary must not survive");
        // Wait for the cancelled work to finish, without racing the service's drain deadline.
        while (service.aliveCount() > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await w.chat("k1")).toEqual(restored);
        expect(restored.data!.hypaV3Data).toBeUndefined();
        const manual = await w.start({ characterId: "c", chatId: "k1" });
        expect(manual.status).toBe(200);
        expect(manual.body).toMatchObject({ outcome: "pendingManual" });
        expect(w.provider.requests).toHaveLength(1);
    });

    it("failed checkpoint loads leave the source generation unchanged and release the memory writer for a later hand-off", async () => {
        for (const failure of ["stale", "afterLoad"] as const) {
            const t = harness({ ignoreAbort: true });
            const saved = t.store.checkpoints.save("c", "k1", "Fork", "manual")!;
            const base = t.revision("k1")!;
            if (failure === "stale") t.write("k1", [{ op: "meta", set: { note: "newer revision" } }]);
            const generation = t.store.chatSourceGeneration("c", "k1");
            const notices: ChatInvalidation[] = [];
            t.store.onChatInvalidated((notice) => notices.push(notice));
            const before = { chat: t.chat("k1"), revision: t.revision("k1"), writes: t.store.writeCount() };
            handOff(t, "k1", { entries: 2 });
            const held = await t.provider.request(0);
            const service = createCheckpointService({
                store: t.store,
                busy: () => false,
                memoryTasks: t.service,
                afterLoad:
                    failure === "afterLoad"
                        ? () => {
                              throw new Error("after load failed");
                          }
                        : undefined,
            });
            const load = () =>
                service.load({
                    epoch: t.store.epoch(),
                    body: { characterId: "c", chatId: "k1", id: saved.id, chatBaseRevision: base },
                });
            if (failure === "stale") {
                expect(load().status).toBe(409);
                expect(t.service.status(ref("k1"))).toMatchObject({ state: "running" });
                t.service.cancel(ref("k1"));
            } else {
                expect(load).toThrow("after load failed");
                expect(t.service.status(ref("k1"))).toMatchObject({ state: "cancelled", reason: "writerLease" });
            }
            held.answer("Late failed-load summary");
            while (t.service.aliveCount() > 0) await new Promise<void>((resolve) => setImmediate(resolve));
            expect({ chat: t.chat("k1"), revision: t.revision("k1"), writes: t.store.writeCount() }).toEqual(before);
            expect(t.store.chatSourceGeneration("c", "k1")).toBe(generation);
            expect(notices).toEqual([]);
            expect(t.store.checkpoints.list("c", "k1")).toEqual([saved]);
            const finished = t.nextTerminal("k1");
            handOff(t, "k1", { entries: 2 });
            (await t.provider.request(1)).answer("Fresh hand-off summary");
            expect((await finished).status).toMatchObject({ state: "done", done: 1 });
            expect(t.summaries("k1")).toEqual(["Fresh hand-off summary"]);
            expect(t.store.chatSourceGeneration("c", "k1")).toBe(generation);
            expect(notices).toEqual([]);
        }
    });
});

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
        expect(a.frames[0]).toEqual({
            type: "hello",
            epoch: w.epoch,
            streaming: [],
            memoryTasks: [],
            digest: expect.stringMatching(/^[0-9a-f]{32}$/),
        });

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
        expect(b.frames[0]).toEqual({
            type: "hello",
            epoch: next,
            streaming: [],
            memoryTasks: [],
            digest: expect.stringMatching(/^[0-9a-f]{32}$/),
        });
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
            record: () => ({ outcome: "refused", reason: "shuttingDown" }),
            rebuild: () => ({ outcome: "refused", reason: "shuttingDown" }),
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

describe("structured memory tasks", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    afterEach(() => vi.useRealTimers());

    type WriterCall = Parameters<StructuredMemoryWriter>[0];
    const structuredHarness = (options: HarnessOptions = {}) => {
        const t = harness({
            ...options,
            memorySection: { hypaV3: false, ...options.memorySection },
            hypaSettings: { structured: { cadence: "everyTurn" }, ...options.hypaSettings },
        });
        t.replace("ui", (data) => ({ ...data, memoryAlgorithmType: "structuredMemory" }));
        return t;
    };
    const writerInput = (t: Harness, confirmedBefore = "m7"): StructuredMemoryTaskInput => {
        const { history, sources, historyStart, currentTokens, kind, ...base } = t.input("k1");
        return { ...base, kind: "structuredMemory", confirmedBefore };
    };
    const event = (
        id: string,
        sources: MemoryEventWrite["sources"],
        status: MemoryEventWrite["status"] = "active",
    ): MemoryEventWrite => ({
        id,
        title: id,
        summary: `Recorded ${id}`,
        status,
        sources,
        participants: [],
        storyTime: { text: "" },
        keyLines: [],
        stateChanges: [],
        knowledge: [],
        relationshipShifts: [],
        openThreads: { add: [], close: [], transitions: [] },
        writerRun: id,
    });
    const contents = (t: Harness) => t.store.memory.readContents("c", "k1")!;
    const record = (t: Harness, call: WriterCall) => {
        const id = call.window.sources.at(-1)!.messageId;
        const committed = call.commit(contents(t).revision, { events: [event(id, call.window.sources)] });
        expect(committed.outcome).toBe("committed");
        return { outcome: "recorded" as const };
    };
    const ids = (call: WriterCall) => call.window.messages.map((message) => message.chatId);
    const arriveOrEnd = (arrival: ReturnType<typeof deferred<WriterCall>>, terminal: Promise<MemoryTaskEvent>) =>
        Promise.race([
            arrival.promise,
            terminal.then(({ status }) => {
                throw new Error(`Writer did not run: ${JSON.stringify(status)}`);
            }),
        ]);

    const analysis = (overrides: Partial<MemoryEventDraft> = {}): MemoryEventDraft => ({
        title: "The promise",
        summary: "Cara promises to return.",
        participants: [],
        storyTime: { text: "" },
        keyLines: [],
        stateChanges: [],
        knowledge: [],
        relationshipShifts: [],
        openThreads: { add: [], close: [], transitions: [] },
        ...overrides,
    });
    const runRecord = (t: Harness, index = -1) =>
        t.store.memory.readRecord("c", "k1", "runs", contents(t).runs.at(index)!.id)!.data;
    const eventRecord = (t: Harness, index = -1) =>
        t.store.memory.readRecord("c", "k1", "events", contents(t).events.at(index)!.id)!.data;
    const beginAnalysis = async (t: Harness, input = writerInput(t, "m3"), manual = false) => {
        const index = t.provider.requests.length;
        const terminal = t.nextTerminal("k1");
        if (manual) expect(t.service.start(ref("k1")).outcome).toBe("queued");
        else t.service.handOff(input);
        const request = await Promise.race([
            t.provider.request(index),
            terminal.then(({ status }) => {
                throw new Error(`Analysis did not run: ${JSON.stringify(status)}`);
            }),
        ]);
        return { request, terminal };
    };
    const answerAnalysis = async (t: Harness, answer: MemoryEventDraft = analysis(), input = writerInput(t, "m3")) => {
        const { request, terminal } = await beginAnalysis(t, input);
        request.answer(JSON.stringify(answer));
        const ended = await terminal;
        await t.service.drain();
        return ended.status;
    };

    const pageRecords = (t: Harness) =>
        contents(t).pages.map(({ id }) => t.store.memory.readRecord("c", "k1", "pages", id)!.data);
    const nextPatch = (t: Harness, index: number, terminal: Promise<MemoryTaskEvent>) =>
        Promise.race([
            t.provider.request(index),
            terminal.then(({ status }) => {
                throw new Error(`Patch did not run: ${JSON.stringify(status)}`);
            }),
        ]);
    const finishRecording = async (t: Harness, terminal: Promise<MemoryTaskEvent>) => {
        const ended = await Promise.race([
            terminal,
            t.provider.request(t.provider.requests.length).then(() => {
                throw new Error("Unexpected extra model call");
            }),
        ]);
        await t.service.drain();
        expect(ended.status).toMatchObject({ state: "done", done: 1, total: 1 });
    };
    const recordOnly = async (t: Harness, answer: object, input = writerInput(t, "m3")) => {
        const { request, terminal } = await beginAnalysis(t, input);
        request.answer(JSON.stringify(answer));
        await finishRecording(t, terminal);
    };

    const beginPagePatch = async (t: Harness, pages: MemoryPage[], draft = analysis()) => {
        writeMemory(t.store, "c", "k1", { pages });
        const { request, terminal } = await beginAnalysis(t);
        const analysisAnswer = JSON.stringify({
            ...draft,
            pageCandidates: pages.map(({ id }) => ({ targetId: id, reason: "New facts", confidence: 1 })),
        });
        request.answer(analysisAnswer);
        const patchRequest = await nextPatch(t, request.index + 1, terminal);
        return { request, terminal, patchRequest, analysisAnswer };
    };

    const beginStagedRun = (
        t: Harness,
        mode: "rebuild" | "backfill" = "rebuild",
        plan = [
            ["m1", "m2"],
            ["m3", "m4"],
            ["m5", "m6"],
        ],
    ) => {
        const live = readRecordSet(t.store.memory, "c", "k1")!;
        t.store.memory.rebuild.begin("c", "k1", { epoch: t.store.epoch(), mode, plan }, rebuildSeed(mode, live));
        return { ...writerInput(t), rebuild: true as const };
    };

    const customFrames = {
        fineTuning: true,
        cadence: "everyTurn",
        instructions: "PRESET INSTRUCTIONS for {{user}}",
        analysisPrompt:
            "<|im_start|>user<|im_sep|>CUSTOM ANALYSIS {{user}}\n{{slot::scene}}\n{{slot::messages}}<|im_end|>",
        patchPrompt: "<|im_start|>user<|im_sep|>CUSTOM PATCH {{user}}\n{{slot::cast}}\n{{slot::previous}}<|im_end|>",
    };

    it("replaces both frames only in fine-tuning, validates both modes alike, and keeps compaction instructions", async () => {
        for (const fineTuning of [false, true]) {
            const t = structuredHarness({ hypaSettings: { structured: { ...customFrames, fineTuning } } });
            const [page, editable] = memoryRecords(["harbor", "inn"], "Harbor").pages;
            page.sections[0].locked = true;
            page.history = [
                {
                    id: "undo",
                    kind: "revert",
                    heading: "Gate",
                    highlighted: false,
                    at: 1,
                    before: { body: "Rejected claim", provenance: [], sources: [] },
                },
            ];
            const { request, terminal, patchRequest } = await beginPagePatch(
                t,
                [page, editable],
                analysis({
                    keyLines: [{ speaker: "Cara", text: "Not in the window" }],
                }),
            );
            const analysisText = t.provider.asked(request);
            const patchText = t.provider.asked(patchRequest);
            for (const [req, text, marker] of [
                [request, analysisText, "CUSTOM ANALYSIS Uma"],
                [patchRequest, patchText, "CUSTOM PATCH Uma"],
            ] as const) {
                if (fineTuning) {
                    expect(req.body.messages).toHaveLength(1);
                    expect(req.body.messages[0].role).toBe("user");
                    expect(text).toContain(marker);
                    expect(text).not.toContain("PRESET INSTRUCTIONS");
                    expect(text).not.toContain("You keep the");
                } else {
                    expect(text).toContain("You keep the");
                    expect(text).toContain("PRESET INSTRUCTIONS for Uma");
                    expect(text).not.toContain("CUSTOM");
                }
            }
            expect(analysisText).toContain("User line 1 of the story.");
            expect(patchText).toContain('"takenBack":[{"heading":"Gate","text":"Rejected claim"}]');
            patchRequest.answer(
                JSON.stringify({
                    patches: [
                        { pageId: page.id, heading: page.sections[0].heading, op: "upsert", body: "Overwrite lock" },
                        {
                            pageId: editable.id,
                            heading: "New facts",
                            op: "upsert",
                            body: "x".repeat(MEMORY_SECTION_BUDGETS.location + 100),
                        },
                    ],
                }),
            );
            const compact = await nextPatch(t, patchRequest.index + 1, terminal);
            expect(t.provider.asked(compact)).toContain("Make one section of a page shorter");
            expect(t.provider.asked(compact)).toContain("PRESET INSTRUCTIONS for Uma");
            compact.answer(JSON.stringify({ body: "Shortened facts" }));
            await finishRecording(t, terminal);
            const run = runRecord(t);
            expect(Boolean(run.customPrompt)).toBe(fineTuning);
            expect(Boolean(run.receipt!.customPrompt)).toBe(fineTuning);
            expect(run.receipt!.unverified).toContainEqual(expect.objectContaining({ text: "Not in the window" }));
            expect(run.receipt!.warnings).toContainEqual(expect.objectContaining({ kind: "lockedSection" }));
            expect(pageRecords(t).find(({ id }) => id === editable.id)!.sections).toContainEqual(
                expect.objectContaining({ heading: "New facts", body: "Shortened facts" }),
            );
            expect(t.chat("k1")!.message.find(({ chatId }) => chatId === "m2")!.generationInfo!.memory).toMatchObject({
                state: "recorded",
                ...(fineTuning ? { customPrompt: true } : {}),
            });
        }
    });

    it("fails invalid custom frames before their call and names missing slots on failed receipts", async () => {
        const cases = [
            { call: "analysis", prompt: " ", error: "blank" },
            { call: "analysis", prompt: "ordinary text", error: "ChatML" },
            { call: "analysis", prompt: "<|im_start|>user<|im_sep|>{{slot::scene}}<|im_end|>", error: "messages" },
            {
                call: "analysis",
                prompt: "<|im_start|>user<|im_sep|>{{slot::messages}}{{#if 0}}{{slot::scene}}{{/if}}<|im_end|>",
                error: "scene",
            },
            { call: "patch", prompt: " ", error: "blank" },
            { call: "patch", prompt: "ordinary text", error: "ChatML" },
            { call: "patch", prompt: "<|im_start|>user<|im_sep|>{{slot::previous}}<|im_end|>", error: "cast" },
            {
                call: "patch",
                prompt: "<|im_start|>user<|im_sep|>{{slot::cast}}{{#if 0}}{{slot::previous}}{{/if}}<|im_end|>",
                error: "previous",
            },
        ];
        for (const row of cases) {
            const t = structuredHarness({
                hypaSettings: { structured: { ...customFrames, [`${row.call}Prompt`]: row.prompt } },
            });
            let terminal: Promise<MemoryTaskEvent>;
            if (row.call === "patch") {
                const first = await beginAnalysis(t);
                terminal = first.terminal;
                first.request.answer(
                    JSON.stringify({
                        ...analysis(),
                        pageCandidates: [
                            {
                                create: { type: "location", title: "Harbor", aliases: [] },
                                reason: "Arrival",
                                confidence: 1,
                            },
                        ],
                    }),
                );
            } else {
                terminal = t.nextTerminal("k1");
                t.service.handOff(writerInput(t, "m3"));
            }
            const ended = await Promise.race([
                terminal,
                t.provider.request(row.call === "analysis" ? 0 : 1).then(() => {
                    throw new Error(`Invalid ${row.call} frame reached provider`);
                }),
            ]);
            expect(ended.status.state).toBe("failed");
            await t.service.drain();
            expect(t.provider.requests).toHaveLength(row.call === "analysis" ? 0 : 1);
            const run = runRecord(t);
            expect(run).toMatchObject({
                customPrompt: true,
                result: "failed",
                receipt: {
                    customPrompt: true,
                    state: "failed",
                    reason: "customPromptInvalid",
                    error: expect.stringContaining(row.error),
                },
            });
            expect(t.chat("k1")!.message.find(({ chatId }) => chatId === "m2")!.generationInfo!.memory).toEqual(
                run.receipt,
            );
            expect(contents(t).events).toEqual([]);
        }
    });

    it("keeps bounded redacted provider errors on custom failed receipts", async () => {
        const t = structuredHarness({ hypaSettings: { structured: customFrames } });
        const { request, terminal } = await beginAnalysis(t);
        request.fail(`Missing title: ${MEMORY_KEY} ${PROXY_KEY} ${"detail ".repeat(LIMITS.runErrorChars)}`);
        expect((await terminal).status.state).toBe("failed");
        await t.service.drain();
        const run = runRecord(t);
        expect(run.receipt).toMatchObject({
            state: "failed",
            customPrompt: true,
            reason: "requestFailed",
            error: expect.stringContaining("Missing title"),
        });
        expect(run.receipt!.error!.length).toBeLessThanOrEqual(LIMITS.runErrorChars);
        expect(run.receipt!.error).not.toContain(MEMORY_KEY);
        expect(run.receipt!.error).not.toContain(PROXY_KEY);
        expect(run.receipt!.error).toBe(run.error);
    });

    it("does not replay a plain failed input in custom mode even with the same fingerprint", async () => {
        const t = structuredHarness();
        const first = await beginAnalysis(t);
        first.request.fail("Temporary failure");
        await first.terminal;
        await t.service.drain();
        t.replace("hypaV3Presets", (data) => ({
            ...data,
            items: data.items.map((item: any) => ({
                ...item,
                settings: { ...item.settings, structured: customFrames },
            })),
        }));
        const input = writerInput(t, "m3");
        writeMemory(t.store, "c", "k1", {
            runs: [{ ...runRecord(t), settingsFingerprint: input.settingsFingerprint }],
        });
        const retry = await beginAnalysis(t, input);
        expect(t.provider.asked(retry.request)).toContain("CUSTOM ANALYSIS Uma");
        expect(retry.request.rawBody).not.toBe(first.request.rawBody);
        retry.request.answer(JSON.stringify(analysis()));
        await finishRecording(t, retry.terminal);
        expect(runRecord(t).customPrompt).toBe(true);
    });

    it("refuses an oversized custom patch input before making its model call", async () => {
        const t = structuredHarness({
            hypaSettings: {
                structured: {
                    ...customFrames,
                    patchPrompt: customFrames.patchPrompt.replace(
                        "CUSTOM PATCH",
                        "{{slot::cast}}".repeat(Math.ceil(MAX_READ_RESPONSE_BYTES / 2000)),
                    ),
                },
            },
        });
        const page = memoryRecords(["large"], "x".repeat(2100)).pages[0];
        page.title = "Harbor";
        writeMemory(t.store, "c", "k1", { pages: [page] });
        const { request, terminal } = await beginAnalysis(t);
        request.answer(
            JSON.stringify({
                ...analysis(),
                pageCandidates: [
                    {
                        targetId: page.id,
                        reason: "Arrival",
                        confidence: 1,
                    },
                ],
            }),
        );
        const ended = await Promise.race([
            terminal,
            t.provider.request(1).then(() => {
                throw new Error("Oversized patch reached provider");
            }),
        ]);
        expect(ended.status.state).toBe("failed");
        await t.service.drain();
        expect(t.provider.requests).toHaveLength(1);
        expect(runRecord(t)).toMatchObject({
            customPrompt: true,
            result: "failed",
            receipt: { state: "failed", customPrompt: true, reason: "inputTooLarge" },
        });
        expect(contents(t).events).toEqual([]);
    });

    it("uses the chat highlight override before the preset and suppresses rule highlights in rebuilds and backfills", async () => {
        for (const row of [
            { preset: "all", override: undefined, mode: undefined, highlighted: true },
            { preset: "all", override: "none", mode: undefined, highlighted: false },
            { preset: "none", override: "all", mode: undefined, highlighted: true },
            { preset: "all", override: "all", mode: "rebuild", highlighted: false },
            { preset: "all", override: "all", mode: "backfill", highlighted: false },
        ] as const) {
            const t = structuredHarness({
                hypaSettings: { structured: { cadence: "everyTurn", highlightMode: row.preset } },
            });
            if (row.override)
                t.store.applyChanges({
                    chats: [
                        {
                            characterId: "c",
                            chatId: "k1",
                            baseRevision: t.store.chatRevision("c", "k1"),
                            ops: [{ op: "meta", set: { structuredMemoryHighlight: row.override } }],
                        },
                    ],
                });
            const input = row.mode ? beginStagedRun(t, row.mode, [["m1", "m2"]]) : writerInput(t, "m3");
            await recordOnly(
                t,
                { ...analysis(), scene: { place: "Harbor", time: "Dawn", state: "Arriving", participants: [] } },
                input,
            );
            const entries = pageRecords(t).flatMap(({ history }) => history);
            expect(entries.length).toBeGreaterThan(0);
            expect(
                entries.map(({ highlighted }) => highlighted),
                JSON.stringify(row),
            ).toEqual(entries.map(() => row.highlighted));
            expect(
                runRecord(t)
                    .receipt!.pages.flatMap(({ sections }) => sections)
                    .every(({ highlighted }) => !!highlighted === row.highlighted),
            ).toBe(true);
        }
    });

    it("compacts a replacement of a personal correction and highlights it even when highlights are off", async () => {
        const t = structuredHarness({
            hypaSettings: { structured: { cadence: "everyTurn", highlightMode: "none", highlightKinds: [] } },
        });
        const page = memoryRecords(["corrected"], "My correction").pages[0];
        page.sections[0].userCorrected = true;
        const { terminal, patchRequest } = await beginPagePatch(t, [page]);
        expect(t.provider.asked(patchRequest)).toContain('"userCorrected":true');
        expect(t.provider.asked(patchRequest)).toContain("change it only when the event contradicts them");
        const body = "x".repeat(MEMORY_SECTION_BUDGETS.location + 1);
        patchRequest.answer(
            JSON.stringify({
                patches: [
                    { pageId: page.id, heading: "Gate", op: "upsert", body, conflict: "contradiction", confidence: 1 },
                ],
            }),
        );
        const compact = await nextPatch(t, patchRequest.index + 1, terminal);
        compact.answer(JSON.stringify({ body: "New concise fact" }));
        await finishRecording(t, terminal);
        const saved = pageRecords(t).find(({ id }) => id === page.id)!;
        expect(saved.sections[0].body).toBe("New concise fact");
        expect(saved.sections[0].userCorrected).toBeUndefined();
        expect(saved.history.map(({ kind, highlighted }) => ({ kind, highlighted }))).toEqual([
            { kind: "contradiction", highlighted: true },
            { kind: "compact", highlighted: false },
        ]);
        expect(saved.history[0].before).toMatchObject({ body: "My correction", userCorrected: true });
        expect(runRecord(t).receipt!.pages.find(({ pageId }) => pageId === page.id)!.sections[0].highlighted).toBe(
            "contradiction",
        );
    });

    it.each([false, true])(
        "rebuilds analysis after a scene revert and keeps it reverted with fine-tuning %s",
        async (fineTuning) => {
            const frames = defaultPrompts();
            const t = structuredHarness({
                hypaSettings: {
                    structured: {
                        cadence: "everyTurn",
                        fineTuning,
                        analysisPrompt: frames.analysis.frame,
                        patchPrompt: frames.patch.frame,
                    },
                },
            });
            t.write("k1", [
                {
                    op: "append",
                    anchor: { end: true },
                    messages: [m("m8", "Fourth reply", "char"), m("m9", "Confirm fourth reply", "user")],
                },
            ]);
            await recordOnly(t, {
                ...analysis(),
                scene: { place: "Harbor", time: "Dawn", state: "Waiting", participants: [] },
            });
            const scene = pageRecords(t).find(({ type }) => type === "scene")!;
            const failed = await beginAnalysis(t, writerInput(t, "m5"));
            expect(t.provider.asked(failed.request)).toContain("place: Harbor");
            failed.request.fail("Temporary failure");
            expect((await failed.terminal).status.state).toBe("failed");
            await t.service.drain();
            const undone = revertChange(scene, scene.history.find(({ heading }) => heading === "place")!.id, {
                now: t.clock.now,
                newId: () => "scene-revert",
            })!;
            writeMemory(t.store, "c", "k1", { pages: [undone.page] });
            expect(
                pageRecords(t)
                    .find(({ id }) => id === scene.id)!
                    .sections.some(({ heading }) => heading === "place"),
            ).toBe(false);
            const retry = await beginAnalysis(t, writerInput(t, "m5"));
            expect(retry.request.rawBody).not.toBe(failed.request.rawBody);
            expect(t.provider.asked(retry.request)).toContain("taken back from place: Harbor");
            retry.request.answer(
                JSON.stringify({
                    ...analysis(),
                    scene: { place: "Harbor", time: "Dawn", state: "Waiting", participants: [] },
                }),
            );
            await finishRecording(t, retry.terminal);
            const kept = pageRecords(t).find(({ id }) => id === scene.id)!;
            expect(kept.sections.some(({ heading }) => heading === "place")).toBe(false);
            expect(kept.history).toEqual(undone.page.history);
            expect(runRecord(t).receipt!.warnings).toContainEqual(
                expect.objectContaining({ kind: "revertedScene", pageId: scene.id, heading: "place" }),
            );
            await recordOnly(
                t,
                { ...analysis(), scene: { place: "Inn", time: "Dawn", state: "Waiting", participants: [] } },
                writerInput(t, "m7"),
            );
            expect(
                pageRecords(t)
                    .find(({ id }) => id === scene.id)!
                    .sections.find(({ heading }) => heading === "place")!.body,
            ).toBe("Inn");
            await recordOnly(
                t,
                { ...analysis(), scene: { place: "Harbor", time: "Dawn", state: "Waiting", participants: [] } },
                writerInput(t, "m9"),
            );
            expect(
                pageRecords(t)
                    .find(({ id }) => id === scene.id)!
                    .sections.find(({ heading }) => heading === "place")!.body,
            ).toBe("Harbor");
            expect(runRecord(t).receipt!.warnings.some(({ kind }) => kind === "revertedScene")).toBe(false);
        },
    );

    it("leaves a screened repair marked automatically and records it on a person's explicit start", async () => {
        const t = structuredHarness({
            hypaSettings: { structured: { cadence: "everyTurn", screening: { refusal: ["cannot help"], format: [] } } },
        });
        t.store.onMessagesChanged((notice) => reconcileMessageChanges(t.store, notice));
        const sources = t
            .chat("k1")!
            .message.slice(0, 2)
            .map((message, index) => ({ messageId: message.chatId!, index, hash: messageSourceHash(message) }));
        writeMemory(t.store, "c", "k1", { events: [event("old", sources)] });
        t.write("k1", [{ op: "setText", id: "m2", text: "I CANNOT HELP with that" }]);
        const marked = eventRecord(t);
        expect(marked.rerecord).toBe(true);
        const automatic = t.nextTerminal("k1");
        t.service.handOff(writerInput(t, "m3"));
        await Promise.race([
            automatic,
            t.provider.request(0).then(() => {
                throw new Error("Automatic writer read the screened repair");
            }),
        ]);
        await t.service.drain();
        expect(t.provider.requests).toEqual([]);
        expect(eventRecord(t)).toEqual(marked);
        const manual = t.nextTerminal("k1");
        expect(t.service.record(writerInput(t, "m3"), { through: "m2" }).outcome).toBe("queued");
        const request = await nextPatch(t, 0, manual);
        expect(t.provider.asked(request)).toContain("I CANNOT HELP with that");
        request.answer(JSON.stringify(analysis()));
        await finishRecording(t, manual);
        expect(eventRecord(t).sources.map(({ messageId }) => messageId)).toEqual(["m1", "m2"]);
        expect(t.store.memory.readRecord("c", "k1", "events", "old")!.data.status).toBe("retracted");
    });

    it("rechecks screening after the plan when each rebuild or backfill window reaches the writer", async () => {
        for (const mode of ["rebuild", "backfill"] as const) {
            const t = structuredHarness({
                hypaSettings: {
                    structured: { cadence: "everyTurn", screening: { refusal: ["cannot help"], format: [] } },
                },
            });
            const old = event("already-recorded", [
                { messageId: "m4", index: 3, hash: messageSourceHash(t.chat("k1")!.message[3]) },
            ]);
            writeMemory(t.store, "c", "k1", { events: [old] });
            const original = eventRecord(t);
            const input = beginStagedRun(t, mode, [
                ["m1", "m2"],
                ["m3", "m4"],
            ]);
            const terminal = t.nextTerminal("k1");
            expect(t.service.rebuild(input).outcome).toBe("queued");
            const first = await nextPatch(t, 0, terminal);
            t.write("k1", [{ op: "setText", id: "m4", text: "I CANNOT HELP with that" }]);
            first.answer(JSON.stringify(analysis({ summary: "First event" })));
            const second = await nextPatch(t, 1, terminal);
            expect(t.provider.asked(second)).toContain("[m:m3]");
            expect(t.provider.asked(second)).not.toContain("[m:m4]");
            expect(t.provider.asked(second)).not.toContain("I CANNOT HELP with that");
            second.answer(JSON.stringify(analysis({ summary: "Another event" })));
            expect((await terminal).status).toMatchObject({ state: "done", done: 2, total: 2, reason: "rebuilt" });
            await t.service.drain();
            expect(eventRecord(t).sources.map(({ messageId }) => messageId)).toEqual(["m3"]);
            expect(t.store.memory.readRecord("c", "k1", "events", "already-recorded")!.data).toEqual(original);
        }
    });

    it("chains a rebuild with whole-run progress and resumes failed staging after a service restart without recording finished windows again", async () => {
        const t = structuredHarness({ limits: { maxWriterWindows: 1, taskDeadlineMs: 100 } });
        writeMemory(t.store, "c", "k1", { ...memoryRecords(["live"]), adoptionDeclined: true });
        const before = contents(t);
        const chatBefore = t.store.readChatSource("c", "k1");
        const input = beginStagedRun(t);
        const failed = t.nextEvent(({ status }) => status.state === "failed");
        expect(t.service.rebuild(input).outcome).toBe("queued");
        const first = await nextPatch(t, 0, failed);
        t.clock.now += 50;
        first.answer(JSON.stringify(analysis({ summary: "First window" })));
        (await nextPatch(t, 1, failed)).fail("Writer unavailable");
        expect((await failed).status).toMatchObject({ state: "failed", done: 1, total: 3 });
        expect(
            t.events.some(
                ({ status }) =>
                    status.state === "done" &&
                    status.reason === "rebuildContinues" &&
                    status.done === 1 &&
                    status.total === 3,
            ),
        ).toBe(true);
        expect(contents(t)).toEqual(before);
        expect(t.store.readChatSource("c", "k1")).toEqual(chatBefore);
        expect(t.store.memory.rebuild.status("c", "k1")).toMatchObject({ done: 1, total: 3, resumable: true });
        t.service.beginShutdown();
        await t.service.drain();
        const restarted = createMemoryTasks({
            store: t.store,
            kinds: t.kinds,
            gate: t.gate,
            hostDeps: t.hostDeps,
            now: () => t.clock.now,
            limits: { maxWriterWindows: 1 },
        });
        cleanups.push(async () => {
            restarted.beginShutdown();
            t.provider.abortAll();
            await restarted.drain();
        });
        const finished = deferred<MemoryTaskEvent>();
        restarted.onStatus((entry) => {
            if (entry.status.state === "done" && entry.status.reason === "rebuilt") finished.resolve(entry);
        });
        expect(restarted.rebuild({ ...writerInput(t), rebuild: true }).outcome).toBe("queued");
        const second = await nextPatch(t, 2, finished.promise);
        expect(t.provider.asked(second)).toContain("[m:m3]");
        expect(t.provider.asked(second)).not.toContain("[m:m1]");
        second.answer(JSON.stringify(analysis({ summary: "Second window" })));
        (await nextPatch(t, 3, finished.promise)).answer(JSON.stringify(analysis({ summary: "Third window" })));
        expect((await finished.promise).status).toMatchObject({ state: "done", reason: "rebuilt", done: 3, total: 3 });
        await restarted.drain();
        expect(
            contents(t).events.map(({ id }) => t.store.memory.readRecord("c", "k1", "events", id)!.data.summary),
        ).toEqual(["Saved 한글 😀", "First window", "Second window", "Third window"]);
        const swapped = contents(t).revision;
        expect(Number(swapped.split(":").at(-1))).toBe(Number(before.revision.split(":").at(-1)) + 1);
        expect(contents(t).adoptionDeclined).toBe(true);
        expect(t.store.memory.rebuild.status("c", "k1")).toBeNull();
        expect(t.store.readChatSource("c", "k1")).toEqual(chatBefore);
        expect(t.provider.requests).toHaveLength(4);
    });

    it("backfills historically without merging events, moving threads or patching live pages, preserving flags gained during the run", async () => {
        const t = structuredHarness();
        const records = memoryRecords(["place"]);
        records.pages[0].contextMode = "always";
        const scene = {
            ...memoryRecords(["scene"]).pages[0],
            type: "scene" as const,
            contextMode: "always" as const,
            participants: [],
        };
        const later = event("later", [
            { messageId: "m6", index: 5, hash: messageSourceHash(t.chat("k1")!.message[5]) },
        ]);
        later.summary = analysis().summary;
        writeMemory(t.store, "c", "k1", {
            pages: [...records.pages, scene],
            events: [later],
            threads: records.threads,
        });
        const input = beginStagedRun(t, "backfill", [["m1"], ["m3", "m4"]]);
        const terminal = t.nextTerminal("k1");
        t.service.rebuild(input);
        const draft = {
            ...analysis({
                openThreads: { add: [{ title: "Historical thread", who: [] }], close: ["place"], transitions: [] },
            }),
            scene: { place: "Old scene", time: "Yesterday", state: "Past", participants: [] },
            pageCandidates: [{ targetId: "place", reason: "Old fact", confidence: 1 }],
        };
        const first = await nextPatch(t, 0, terminal);
        first.answer(JSON.stringify(draft));
        const second = await nextPatch(t, 1, terminal);
        expect(t.provider.asked(second)).toContain("[m:m3]");
        const changed = { ...records.pages[0], contextMode: "never" as const, grade: 9, gradeByUser: true };
        writeMemory(t.store, "c", "k1", { pages: [changed] });
        second.answer(
            JSON.stringify({
                ...draft,
                pageCandidates: [
                    ...draft.pageCandidates,
                    {
                        create: { type: "location", title: "Archive", aliases: [] },
                        reason: "Historical place",
                        confidence: 1,
                    },
                ],
            }),
        );
        const patch = await nextPatch(t, 2, terminal);
        expect(t.provider.asked(patch)).toContain("Archive");
        patch.answer(JSON.stringify({ patches: [] }));
        expect((await terminal).status).toMatchObject({ state: "done", done: 2, total: 2, reason: "rebuilt" });
        await t.service.drain();
        expect(t.provider.requests).toHaveLength(3);
        expect(
            pageRecords(t)
                .filter(({ id }) => id !== "place" && id !== "scene")
                .map(({ title }) => title),
        ).toEqual(["Archive"]);
        expect(t.store.memory.readRecord("c", "k1", "pages", "place")?.data).toEqual(changed);
        expect(t.store.memory.readRecord("c", "k1", "pages", "scene")?.data).toEqual(scene);
        expect(t.store.memory.readRecord("c", "k1", "threads", "place")?.data).toEqual(records.threads[0]);
        expect(contents(t).threads).toHaveLength(1);
        expect(contents(t).events).toHaveLength(3);
        expect(eventRecord(t, 1).sources.map(({ messageId }) => messageId)).toEqual(["m1"]);
        expect(eventRecord(t, 2).sources.map(({ messageId }) => messageId)).toEqual(["m3", "m4"]);
        expect(eventRecord(t, 1).openThreads).toEqual({ add: [], close: [], transitions: [] });
        expect(eventRecord(t, 2).openThreads).toEqual({ add: [], close: [], transitions: [] });
    });

    it("holds rebuild starts and resumes, stops a run that becomes held during analysis, and permits abandon", async () => {
        const t = structuredHarness();
        const input = beginStagedRun(t, "rebuild", [["m1", "m2"]]);
        const terminal = t.nextTerminal("k1");
        t.service.rebuild(input);
        const request = await nextPatch(t, 0, terminal);
        t.write("k1", [
            {
                op: "meta",
                set: { hypaV3Data: { summaries: [{ text: "Held summary", chatMemos: ["m1"], isImportant: false }] } },
            },
        ]);
        const held = contents(t);
        request.answer(JSON.stringify(analysis()));
        expect((await terminal).status.state).toBe("skipped");
        await t.service.drain();
        expect(contents(t)).toEqual(held);
        expect(t.store.memory.rebuild.staged.readContents("c", "k1")!.events).toEqual([]);
        expect(t.store.memory.rebuild.status("c", "k1")).toMatchObject({ done: 0 });
        for (let attempt = 0; attempt < 2; attempt++) {
            const stopped = t.nextTerminal("k1");
            t.service.rebuild({ ...writerInput(t), rebuild: true });
            expect((await stopped).status).toMatchObject({ state: "skipped" });
            await t.service.drain();
        }
        expect(t.provider.requests).toHaveLength(1);
        expect(t.store.memory.rebuild.abandon("c", "k1", t.store.epoch())).toBe(true);
        expect(contents(t)).toEqual(held);
    });

    it("rechecks the adoption hold at the swap after the last staged commit", async () => {
        const t = structuredHarness({
            structuredWriter: async (call) => {
                const staged = t.store.memory.rebuild.staged;
                const result = call.commit(staged.readContents("c", "k1")!.revision, {
                    events: [event("staged", call.window.sources)],
                    runs: memoryRecords(["recorded"]).runs,
                });
                expect(result.outcome).toBe("committed");
                t.write("k1", [
                    {
                        op: "meta",
                        set: {
                            hypaV3Data: {
                                summaries: [{ text: "Hold before swap", chatMemos: ["m1"], isImportant: false }],
                            },
                        },
                    },
                ]);
                return { outcome: "recorded" };
            },
        });
        const before = contents(t);
        const input = beginStagedRun(t, "rebuild", [["m1", "m2"]]);
        const terminal = t.nextTerminal("k1");
        t.service.rebuild(input);
        expect((await terminal).status).toMatchObject({
            state: "skipped",
            reason: "awaitingAdoption",
            done: 1,
            total: 1,
        });
        expect(contents(t)).toEqual(before);
        expect(t.store.memory.rebuild.status("c", "k1")).toMatchObject({ done: 1, reason: "awaitingAdoption" });
    });

    it("refuses live writer commits and skips automatic work while a stopped rebuild holds the chat", async () => {
        const t = structuredHarness();
        const { request, terminal } = await beginAnalysis(t);
        const input = beginStagedRun(t);
        const before = contents(t);
        request.answer(JSON.stringify(analysis()));
        expect((await terminal).status.state).toBe("skipped");
        await t.service.drain();
        expect(contents(t)).toEqual(before);
        const automatic = t.nextTerminal("k1");
        t.service.handOff(writerInput(t));
        expect((await automatic).status).toMatchObject({ state: "skipped" });
        expect(t.provider.requests).toHaveLength(1);
        t.replace("ui", (data) => ({ ...data, memoryAlgorithmType: "hypaV3" }));
        const switched = t.nextTerminal("k1");
        t.service.rebuild({ ...input, ...writerInput(t), rebuild: true });
        expect((await switched).status).toMatchObject({ state: "skipped", reason: "notStructuredMemory" });
        expect(t.store.memory.rebuild.status("c", "k1")).toMatchObject({ done: 0, total: 3 });
    });

    it("retries a staged commit from fresh records and carries a live event retracted while the patch was in flight", async () => {
        const t = structuredHarness();
        const page = { ...memoryRecords(["place"]).pages[0], contextMode: "always" as const };
        const sources = t
            .chat("k1")!
            .message.slice(0, 2)
            .map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) }));
        writeMemory(t.store, "c", "k1", { pages: [page], events: [event("live", sources)] });
        const input = beginStagedRun(t, "rebuild", [["m1", "m2"]]);
        const terminal = t.nextTerminal("k1");
        t.service.rebuild(input);
        (await nextPatch(t, 0, terminal)).answer(
            JSON.stringify({
                ...analysis(),
                pageCandidates: [{ targetId: "place", reason: "New facts", confidence: 1 }],
            }),
        );
        const patch = await nextPatch(t, 1, terminal);
        const staged = t.store.memory.rebuild.staged;
        const corrected = {
            ...page,
            sections: [
                { ...page.sections[0], body: "Corrected while patch was in flight", locked: true, userCorrected: true },
            ],
        };
        staged.write(
            "c",
            "k1",
            { epoch: t.store.epoch(), baseRevision: staged.readContents("c", "k1")!.revision },
            { pages: [corrected] },
        );
        const retired = { ...eventRecord(t), status: "retracted" as const };
        writeMemory(t.store, "c", "k1", { events: [retired] });
        patch.answer(
            JSON.stringify({ patches: [{ pageId: "place", heading: "Gate", op: "upsert", body: "Outdated patch" }] }),
        );
        expect((await terminal).status).toMatchObject({ state: "done", reason: "rebuilt", done: 1, total: 1 });
        await t.service.drain();
        expect(t.store.memory.readRecord("c", "k1", "pages", "place")?.data).toEqual(corrected);
        expect(t.store.memory.readRecord("c", "k1", "events", "live")?.data).toEqual(retired);
        expect(contents(t).events).toHaveLength(2);
        expect(t.provider.requests).toHaveLength(2);
    });

    it("holds automatic and manual recording on stored summaries despite a failed run, then records the oldest turn after decline", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const t = structuredHarness();
        const captured = writerInput(t, "m3");
        const summaries = { summaries: [{ text: "Old HypaV3 memory", chatMemos: ["m1", "m2"], isImportant: false }] };
        t.write("k1", [{ op: "meta", set: { hypaV3Data: summaries } }]);
        writeMemory(t.store, "c", "k1", { runs: [{ ...memoryRecords(["failed"]).runs[0], result: "failed" }] });
        const held = contents(t);
        const writes = t.store.writeCount();
        for (const manual of [false, true]) {
            const terminal = t.nextTerminal("k1");
            if (manual) expect(t.service.record(captured, { through: "m2" }).outcome).toBe("queued");
            else t.service.handOff(captured);
            const ended = await Promise.race([
                terminal,
                t.provider.request(0).then(() => {
                    throw new Error("Held recording called the provider");
                }),
            ]);
            expect(ended.status.done).toBe(0);
            await t.service.drain();
            expect(contents(t)).toEqual(held);
            expect(t.store.writeCount()).toBe(writes);
        }
        writeMemory(t.store, "c", "k1", { adoptionDeclined: true });
        await recordOnly(t, analysis(), writerInput(t, "m3"));
        expect(eventRecord(t).sources.map(({ messageId }) => messageId)).toEqual(["m1", "m2"]);
        expect(t.chat("k1")?.hypaV3Data).toEqual(summaries);
    });

    it("records when blank or malformed summaries would adopt no events", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const t = structuredHarness();
        t.write("k1", [
            {
                op: "meta",
                set: {
                    hypaV3Data: { summaries: [null, {}, { text: 42 }, { text: " \n\t", chatMemos: ["m1", "m2"] }] },
                },
            },
        ]);
        await recordOnly(t, analysis());
        expect(eventRecord(t).sources.map(({ messageId }) => messageId)).toEqual(["m1", "m2"]);
    });

    it("refuses a recording commit when real summaries arrive during analysis", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const t = structuredHarness({ invalidations: false });
        const { request, terminal } = await beginAnalysis(t);
        t.write("k1", [
            {
                op: "meta",
                set: {
                    hypaV3Data: {
                        summaries: [{ text: "Arrived from another tab", chatMemos: ["m1"], isImportant: false }],
                    },
                },
            },
        ]);
        const held = contents(t);
        request.answer(JSON.stringify(analysis()));
        await terminal;
        await t.service.drain();
        expect(contents(t)).toEqual(held);
        expect(t.chat("k1")?.message[2].generationInfo?.memory).toBeUndefined();
    });

    it("automatically re-records an edited confirmed event at hand-off and retires it only with the replacement", async () => {
        const arrival = deferred<WriterCall>();
        const release = deferred<{ outcome: "recorded" }>();
        const t = structuredHarness({
            structuredWriter: async (call) => {
                arrival.resolve(call);
                return release.promise;
            },
        });
        t.store.onMessagesChanged((notice) => reconcileMessageChanges(t.store, notice));
        const sources = t
            .chat("k1")!
            .message.slice(0, 2)
            .map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) }));
        const page = memoryRecords(["facts"], "Section A before the rewrite").pages[0];
        page.sections[0].heading = "A";
        page.sections[0].provenance = ["old"];
        page.sections[0].sources = sources;
        page.sections.push({ ...page.sections[0], heading: "B", body: "Section B stays unchanged" });
        writeMemory(t.store, "c", "k1", { events: [event("old", sources)], pages: [page] });
        const old = eventRecord(t);
        t.write("k1", [{ op: "setText", id: "m2", text: "Edited reply" }]);
        expect(eventRecord(t)).toEqual({ ...old, rerecord: true });
        const terminal = t.nextTerminal("k1");
        t.service.handOff(writerInput(t, "m3"));
        try {
            const call = await arriveOrEnd(arrival, terminal);
            expect(ids(call)).toEqual(["m1", "m2"]);
            expect(call.window.rerecords).toBe("old");
            expect(call.window.messages[1].data).toBe("Edited reply");
            expect(eventRecord(t)).toEqual({ ...old, rerecord: true });
            expect(pageRecords(t)).toEqual([page]);
            const updatedPage: MemoryPage = {
                ...page,
                sections: [
                    {
                        ...page.sections[0],
                        body: "The writer's new body for A",
                        provenance: ["old", "new"],
                        sources: call.window.sources,
                    },
                    page.sections[1],
                ],
            };
            expect(
                call.commit(contents(t).revision, {
                    events: [event("new", call.window.sources)],
                    pages: [updatedPage],
                }).outcome,
            ).toBe("committed");
            expect(t.store.memory.readRecord("c", "k1", "events", "old")!.data).toEqual({
                ...old,
                status: "retracted",
            });
            expect(contents(t).events.map(({ id, status }) => ({ id, status }))).toEqual([
                { id: "old", status: "retracted" },
                { id: "new", status: "active" },
            ]);
            expect(pageRecords(t)).toStrictEqual([
                {
                    ...updatedPage,
                    sections: [updatedPage.sections[0], { ...page.sections[1], unsupported: true }],
                },
            ]);
        } finally {
            release.resolve({ outcome: "recorded" });
        }
        expect((await terminal).status).toMatchObject({ state: "done", done: 1, total: 1 });
    });

    it("spends no automatic writer call on manual cadence, restored text, or missing sources, and keeps their marks", async () => {
        for (const condition of ["manual", "restored", "missing"] as const) {
            const calls: WriterCall[] = [];
            const t = structuredHarness({
                hypaSettings: { structured: { cadence: condition === "manual" ? "manual" : "everyTurn" } },
                limits: { maxWriterWindows: 1 },
                structuredWriter: async (call) => {
                    calls.push(call);
                    return record(t, call);
                },
            });
            t.store.onMessagesChanged((notice) => reconcileMessageChanges(t.store, notice));
            const messages = t.chat("k1")!.message;
            const sources = messages
                .slice(0, 2)
                .map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) }));
            writeMemory(t.store, "c", "k1", { events: [event("old", sources)] });
            t.write("k1", [{ op: "setText", id: "m2", text: "Edited reply" }]);
            if (condition === "restored") t.write("k1", [{ op: "setText", id: "m2", text: messages[1].data }]);
            if (condition === "missing") t.write("k1", [{ op: "remove", ids: ["m1"] }]);
            const before = eventRecord(t);
            expect(before.rerecord).toBe(true);
            const terminal = t.nextTerminal("k1");
            t.service.handOff(writerInput(t, "m3"));
            expect((await terminal).status, condition).toMatchObject({ state: "done", done: 0, total: 0 });
            await t.service.drain();
            expect(calls, condition).toEqual([]);
            expect(eventRecord(t), condition).toEqual(before);
            if (condition === "manual") {
                const pressed = t.nextTerminal("k1");
                expect(t.service.record(writerInput(t, "m3"), { through: "m2" }).outcome).toBe("queued");
                expect((await pressed).status).toMatchObject({ state: "done", done: 1, total: 1 });
                expect(calls.map(({ window }) => window.rerecords)).toEqual(["old"]);
            }
        }
    });

    it("refuses a re-record's final commit when its old event was retracted, unmarked, or removed", async () => {
        for (const change of ["retracted", "unmarked", "removed"] as const) {
            const arrival = deferred<WriterCall>();
            const release = deferred<{ outcome: "skipped"; reason: string }>();
            const t = structuredHarness({
                structuredWriter: async (call) => {
                    arrival.resolve(call);
                    return release.promise;
                },
            });
            const sources = t
                .chat("k1")!
                .message.slice(0, 2)
                .map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) }));
            writeMemory(t.store, "c", "k1", { events: [{ ...event("old", sources), rerecord: true }] });
            const terminal = t.nextTerminal("k1");
            expect(t.service.record(writerInput(t, "m3"), { through: "m2" }).outcome).toBe("queued");
            try {
                const call = await arriveOrEnd(arrival, terminal);
                expect(call.window.rerecords).toBe("old");
                const { rerecord, ...old } = eventRecord(t);
                writeMemory(
                    t.store,
                    "c",
                    "k1",
                    change === "removed"
                        ? { remove: { events: ["old"] } }
                        : {
                              events: [
                                  {
                                      ...old,
                                      ...(change === "retracted"
                                          ? { status: "retracted" as const, rerecord: true }
                                          : {}),
                                  },
                              ],
                          },
                );
                const before = contents(t);
                // Use the current revision: a generic revision conflict must not hide the lost intent.
                expect(
                    call.commit(before.revision, { events: [event("second", call.window.sources)] }),
                    change,
                ).toMatchObject({ outcome: "refused" });
                expect(contents(t), change).toEqual(before);
                expect(t.store.memory.readRecord("c", "k1", "events", "second")).toBeNull();
            } finally {
                release.resolve({ outcome: "skipped", reason: "finished" });
            }
            await terminal;
        }
    });

    it("compacts each overflowing section in the recording commit and warms only its final body", async () => {
        const t = structuredHarness();
        const page = memoryRecords(["harbor"], "Harbor").pages[0];
        page.sections.push({ ...page.sections[0], heading: "Untouched", body: "Keep these exact words" });
        const writes = vi.spyOn(t.store.memory, "write");
        cleanups.push(() => {
            writes.mockRestore();
        });
        const draft = analysis({ summary: "e".repeat(LIMITS.eventSummaryChars) });
        const { terminal, patchRequest, analysisAnswer } = await beginPagePatch(t, [page], draft);
        const targets = [
            {
                heading: "Gate",
                body: "g".repeat(MEMORY_SECTION_BUDGETS.location + 200),
                shorter: "g".repeat(MEMORY_SECTION_BUDGETS.location + 1),
            },
            {
                heading: "Hearth",
                body: "h".repeat(MEMORY_SECTION_BUDGETS.location + 100),
                shorter: "The hearth is lit.",
            },
        ];
        const patchAnswer = JSON.stringify({
            patches: targets.map(({ heading, body }) => ({ pageId: page.id, heading, op: "upsert", body })),
        });
        t.clock.now += 20;
        patchRequest.answer(patchAnswer);
        const answers = [analysisAnswer, patchAnswer];
        for (const [i, target] of targets.entries()) {
            const compactRequest = await nextPatch(t, patchRequest.index + 1 + i, terminal);
            expect(compactRequest.body.messages.filter((message: OpenAIChat) => message.role === "user")).toEqual([
                {
                    role: "user",
                    content: `Page:\n${JSON.stringify({ type: "location", title: "Harbor", heading: target.heading })}\n\nSection:\n${target.body}`,
                },
            ]);
            expect(contents(t).events).toEqual([]);
            expect(runRecord(t).result).toBe("pending");
            expect(pageRecords(t)).toEqual([page]);
            t.clock.now += 30;
            const answer = JSON.stringify({ body: target.shorter });
            answers.push(answer);
            compactRequest.answer(answer);
        }
        await finishRecording(t, terminal);
        expect(t.provider.requests).toHaveLength(4);
        const saved = t.store.memory.readRecord("c", "k1", "pages", page.id)!.data;
        const run = runRecord(t);
        const recorded = eventRecord(t);
        expect(recorded).toMatchObject({ ...draft, writerRun: run.id });
        expect(contents(t).runs).toHaveLength(1);
        const inputTokens = t.provider.requests.reduce(
            (sum, request) =>
                sum +
                request.body.messages.reduce(
                    (count: number, message: OpenAIChat) => count + message.content.length + CHAT_ADDITIONAL,
                    0,
                ),
            0,
        );
        const outputTokens = answers.reduce((sum, answer) => sum + answer.length, 0);
        expect(run).toMatchObject({
            result: "recorded",
            eventId: recorded.id,
            durationMs: 80,
            inputTokens,
            outputTokens,
            receipt: { state: "recorded", inputTokens, outputTokens },
        });
        expect(saved.sections.find(({ heading }) => heading === "Untouched")).toEqual(page.sections[1]);
        const hash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
        for (const target of targets) {
            expect(saved.sections.find(({ heading }) => heading === target.heading)).toMatchObject({
                body: target.shorter,
                provenance: [recorded.id],
                sources: run.window,
            });
            const history = saved.history.filter(
                ({ heading, kind }) => heading === target.heading && kind === "compact",
            );
            expect(history).toEqual([
                expect.objectContaining({
                    heading: target.heading,
                    kind: "compact",
                    eventId: recorded.id,
                    before: { body: target.body, provenance: [recorded.id], sources: run.window },
                }),
            ]);
            expect(run.receipt!.pages.find(({ pageId }) => pageId === page.id)!.sections).toContainEqual({
                heading: target.heading,
                beforeHash: hash(target.body),
                afterHash: hash(target.shorter),
                historyId: history[0].id,
            });
        }
        expect(run.receipt!.warnings).toEqual(
            targets.map(({ heading, body, shorter }) => ({
                kind: "compacted",
                pageId: page.id,
                heading,
                detail: `Harbor: ${heading} (${body.length} → ${shorter.length})`,
            })),
        );
        expect(t.chat("k1")!.message.find(({ chatId }) => chatId === "m2")!.generationInfo!.memory).toEqual(
            run.receipt,
        );
        // Seeding and opening the pending run precede the one write of all recording results.
        expect(writes).toHaveBeenCalledTimes(3);
        expect(writes.mock.calls[2][3]).toMatchObject({
            events: [expect.objectContaining({ id: recorded.id, summary: draft.summary, writerRun: run.id })],
            runs: [run],
            pages: expect.arrayContaining([saved]),
        });
        expect(t.embeddings.bodies.flatMap(({ input }) => input)).toEqual([
            draft.summary,
            ...targets.map(({ heading, shorter }) => `Harbor: ${heading}\n${shorter}`),
        ]);
    });

    it("makes no compaction call for locked, disputed, identical, or untouched sections, or a correction a disputed join keeps", async () => {
        const t = structuredHarness();
        const body = "x".repeat(MEMORY_SECTION_BUDGETS.location + 1);
        const pages = memoryRecords(["locked", "corrected", "disputed", "identical", "untouched"]).pages;
        for (const page of pages) page.title = page.id;
        pages[0].sections[0] = { ...pages[0].sections[0], locked: true, body };
        pages[1].sections[0].userCorrected = true;
        pages[3].sections[0].body = body;
        pages[4].sections[0].body = body;
        const { terminal, patchRequest } = await beginPagePatch(t, pages);
        patchRequest.answer(
            JSON.stringify({
                patches: pages.map(({ id }) => ({
                    pageId: id,
                    heading: id === "untouched" ? "Hearth" : "Gate",
                    op: "upsert",
                    body: id === "untouched" ? "Lit" : body,
                    ...(id === "disputed" || id === "corrected" ? { conflict: "contradiction", confidence: 0 } : {}),
                })),
            }),
        );
        await finishRecording(t, terminal);
        expect(t.provider.requests).toHaveLength(2);
        const saved = pageRecords(t);
        expect(saved.find(({ id }) => id === "locked")).toEqual(pages[0]);
        expect(saved.find(({ id }) => id === "corrected")!.sections[0]).toMatchObject({
            body: `${pages[1].sections[0].body}\n[disputed] ${body}`,
            userCorrected: true,
        });
        expect(saved.find(({ id }) => id === "disputed")!.sections[0]).toMatchObject({
            body: `${pages[2].sections[0].body}\n[disputed] ${body}`,
            disputed: true,
        });
        expect(saved.find(({ id }) => id === "identical")!.sections[0].body).toBe(body);
        expect(saved.find(({ id }) => id === "untouched")!.sections[0]).toEqual(pages[4].sections[0]);
        expect(saved.flatMap(({ history }) => history).filter(({ kind }) => kind === "compact")).toEqual([]);
        expect(runRecord(t).receipt!.warnings.filter(({ kind }) => kind.startsWith("compaction"))).toEqual([
            { kind: "compactionSkipped", pageId: "corrected", heading: "Gate", detail: "corrected: Gate" },
            { kind: "compactionSkipped", pageId: "disputed", heading: "Gate", detail: "disputed: Gate" },
        ]);
        expect(contents(t).events).toHaveLength(1);
    });

    it("records the event and gives every target one call despite failed, unusable, or non-smaller compactions", async () => {
        const t = structuredHarness();
        const page = memoryRecords(["harbor"], "Harbor").pages[0];
        const headings = ["Provider failure", "Unusable answer", "Not smaller", "Success"];
        page.sections = headings.map((heading) => ({ ...page.sections[0], heading, body: "Old" }));
        const body = "x".repeat(MEMORY_SECTION_BUDGETS.location + 1);
        const { terminal, patchRequest } = await beginPagePatch(t, [page]);
        patchRequest.answer(
            JSON.stringify({ patches: headings.map((heading) => ({ pageId: page.id, heading, op: "upsert", body })) }),
        );
        for (const [i, heading] of headings.entries()) {
            const request = await nextPatch(t, patchRequest.index + 1 + i, terminal);
            expect(request.body.messages.find((message: OpenAIChat) => message.role === "user").content).toContain(
                JSON.stringify({ type: "location", title: "Harbor", heading }),
            );
            if (i === 0) request.fail("Compaction provider failed");
            else request.answer(JSON.stringify(i === 1 ? { wrong: "No body" } : { body: i === 2 ? body : "Short" }));
        }
        await finishRecording(t, terminal);
        expect(t.provider.requests).toHaveLength(6);
        expect(eventRecord(t).summary).toBe(analysis().summary);
        const saved = t.store.memory.readRecord("c", "k1", "pages", page.id)!.data;
        expect(saved.sections.map(({ body }) => body)).toEqual([body, body, body, "Short"]);
        expect(saved.history.filter(({ kind }) => kind === "compact").map(({ heading }) => heading)).toEqual([
            "Success",
        ]);
        expect(runRecord(t)).toMatchObject({
            result: "recorded",
            receipt: {
                state: "recorded",
                warnings: [
                    {
                        kind: "compactionFailed",
                        pageId: page.id,
                        heading: headings[0],
                        detail: `Harbor: ${headings[0]}`,
                    },
                    {
                        kind: "compactionFailed",
                        pageId: page.id,
                        heading: headings[1],
                        detail: `Harbor: ${headings[1]}`,
                    },
                    {
                        kind: "compactionNotSmaller",
                        pageId: page.id,
                        heading: headings[2],
                        detail: `Harbor: ${headings[2]}`,
                    },
                    {
                        kind: "compacted",
                        pageId: page.id,
                        heading: headings[3],
                        detail: `Harbor: Success (${body.length} → 5)`,
                    },
                ],
            },
        });
    });

    it("drops a completed compaction when a concurrent lock makes the fresh patch group refuse", async () => {
        const t = structuredHarness();
        const page = memoryRecords(["harbor"], "Harbor").pages[0];
        page.sections.push({ ...page.sections[0], heading: "Hearth", body: "Unlit" });
        const { terminal, patchRequest } = await beginPagePatch(t, [page]);
        patchRequest.answer(
            JSON.stringify({
                patches: [
                    {
                        pageId: page.id,
                        heading: "Gate",
                        op: "upsert",
                        body: "x".repeat(MEMORY_SECTION_BUDGETS.location + 1),
                    },
                    { pageId: page.id, heading: "Hearth", op: "upsert", body: "Lit" },
                ],
            }),
        );
        const request = await nextPatch(t, patchRequest.index + 1, terminal);
        page.sections[1].locked = true;
        writeMemory(t.store, "c", "k1", { pages: [page] });
        request.answer('{"body":"Short"}');
        await finishRecording(t, terminal);
        expect(t.provider.requests).toHaveLength(3);
        expect(t.store.memory.readRecord("c", "k1", "pages", page.id)!.data).toEqual(page);
        expect(runRecord(t).receipt!.warnings).toEqual([
            { kind: "pageRefused", pageId: page.id, heading: "Gate", detail: "Harbor: Gate" },
            { kind: "lockedSection", pageId: page.id, heading: "Hearth", detail: "Harbor: Hearth" },
            { kind: "compactionStale", pageId: page.id, heading: "Gate", detail: "Harbor: Gate" },
        ]);
        expect(runRecord(t).receipt!.pages.find(({ pageId }) => pageId === page.id)).toBeUndefined();
        expect(contents(t).events).toHaveLength(1);
        expect(t.embeddings.bodies.flatMap(({ input }) => input)).toEqual([analysis().summary]);
    });

    it("ends the run without recording when the compaction request ends its memory host", async () => {
        const t = structuredHarness();
        const runInJob = t.hostDeps.llm.runInJob;
        let calls = 0;
        t.hostDeps.llm.runInJob = async (spec) => {
            const response = await runInJob(spec);
            if (++calls === 3) spec.endJob("Compaction host stopped");
            return response;
        };
        const page = memoryRecords(["harbor"], "Harbor").pages[0];
        const { terminal, patchRequest } = await beginPagePatch(t, [page]);
        patchRequest.answer(
            JSON.stringify({
                patches: [
                    {
                        pageId: page.id,
                        heading: "Gate",
                        op: "upsert",
                        body: "x".repeat(MEMORY_SECTION_BUDGETS.location + 1),
                    },
                ],
            }),
        );
        const request = await nextPatch(t, patchRequest.index + 1, terminal);
        request.answer('{"body":"Short"}');
        expect((await terminal).status).toMatchObject({ state: "failed", error: "Compaction host stopped" });
        await t.service.drain();
        expect(t.provider.requests).toHaveLength(3);
        expect(contents(t).events).toEqual([]);
        expect(pageRecords(t)).toEqual([page]);
        expect(runRecord(t)).toMatchObject({
            result: "failed",
            error: "Compaction host stopped",
            receipt: { state: "failed", reason: "hostFailure" },
        });
        expect(t.embeddings.bodies).toEqual([]);
    });

    it("retries a marked repair only on a press and atomically replaces it without repeat merging or lost user marks", async () => {
        const t = structuredHarness({ limits: { maxWriterWindows: 1 } });
        await recordOnly(t, analysis());
        const old = { ...eventRecord(t), pinned: true, suppressed: true, userCorrected: true, rerecord: true };
        writeMemory(t.store, "c", "k1", { events: [old] });
        // An insertion makes the event stale while its original source hashes still match:
        // without the repair guard, the identical summary would merge as a repeat.
        t.write("k1", [{ op: "append", anchor: { after: "m1" }, messages: [m("inserted", "Wait", "user")] }]);
        // The automatic pass sees no ordinary work before m3; a repair must remain for a press.
        const autoEnd = t.nextTerminal("k1");
        t.service.handOff(writerInput(t, "m3"));
        expect((await autoEnd).status).toMatchObject({ state: "done", done: 0, total: 0 });
        await t.service.drain();
        expect(t.provider.requests).toHaveLength(1);
        const readOld = () => t.store.memory.readRecord("c", "k1", "events", old.id)!.data;
        expect(readOld()).toEqual(old);
        // A memory revision may expose neither half of the replacement on its own.
        const observer = new DatabaseSync(path.join(t.dir, "resources.sqlite"));
        cleanups.push(() => observer.close());
        observer.exec(`CREATE TRIGGER complete_repair BEFORE UPDATE ON memory_state
            WHEN (EXISTS (SELECT 1 FROM memory_events WHERE id = '${old.id}' AND status = 'retracted'))
                != (EXISTS (SELECT 1 FROM memory_events WHERE chatSeq = NEW.chatSeq AND id != '${old.id}'))
            BEGIN SELECT RAISE(ABORT, 'partial repair write'); END`);
        for (const fail of [true, false]) {
            const terminal = t.nextTerminal("k1");
            const index = t.provider.requests.length;
            expect(t.service.record(writerInput(t), { through: "m6" }).outcome).toBe("queued");
            const request = await nextPatch(t, index, terminal);
            expect(runRecord(t).window.map((s) => s.messageId)).toEqual(["m1", "m2"]);
            expect(readOld()).toEqual(old);
            if (fail) request.fail("Temporary provider failure");
            else request.answer(JSON.stringify(analysis())); // identical summary must still create a replacement
            expect((await terminal).status.state).toBe(fail ? "failed" : "done");
            await t.service.drain();
            if (fail) {
                expect(contents(t).events).toHaveLength(1);
                expect(readOld()).toEqual(old);
            }
        }
        expect(contents(t).events).toHaveLength(2);
        const { rerecord, ...retired } = old;
        expect(readOld()).toEqual({ ...retired, status: "retracted" });
        const replacement = contents(t).events.find(({ id }) => id !== old.id)!;
        const saved = t.store.memory.readRecord("c", "k1", "events", replacement.id)!.data;
        expect(saved).toMatchObject({
            status: "active",
            summary: old.summary,
            pinned: true,
            suppressed: true,
            userCorrected: true,
        });
        expect(saved).not.toHaveProperty("repeatCount");
        expect(saved).not.toHaveProperty("rerecord");
        const current = t.chat("k1")!.message;
        expect(saved.sources).toEqual(
            [0, 2].map((index) => ({
                messageId: current[index].chatId,
                index,
                hash: messageSourceHash(current[index]),
            })),
        );
        // A replacement and the retraction must be visible together at the transaction boundary.
        expect(runRecord(t)).toMatchObject({ result: "recorded", eventId: replacement.id });
    });

    it("commits admitted page candidates and surviving patch groups across a revision conflict", async () => {
        const t = structuredHarness({ owner: { globalLore: [{ comment: "Harbor", key: "Port, Quay" }] } });
        t.write("k1", [{ op: "setText", id: "m2", text: "Watcher reaches Harbor. The gate opens." }]);
        const cara: MemoryPage = {
            ...memoryRecords(["cara"], "Cara").pages[0],
            type: "character",
            aliases: ["Watcher"],
            sections: [
                {
                    heading: "identity",
                    body: "Original identity",
                    locked: false,
                    provenance: [],
                    sources: [],
                    updatedAt: 1,
                },
                {
                    heading: "knowledge",
                    body: "User locked fact",
                    locked: true,
                    provenance: [],
                    sources: [],
                    updatedAt: 1,
                },
            ],
        };
        const scene: MemoryPage = {
            ...memoryRecords(["scene"], "Scene").pages[0],
            type: "scene",
            contextMode: "always",
            participants: ["cara"],
            sections: [],
        };
        const always = { ...memoryRecords(["always"], "Law").pages[0], contextMode: "always" as const };
        writeMemory(t.store, "c", "k1", {
            pages: [
                cara,
                scene,
                always,
                ...memoryRecords(
                    Array.from({ length: 40 }, (_, i) => `stranger-${i}`),
                    "Unrelated",
                ).pages,
            ],
        });
        const { request, terminal } = await beginAnalysis(t);
        const cast = request.body.messages.find((m: OpenAIChat) => m.role === "user").content.split("\n\nScene:")[0];
        expect(cast).toContain('"id":"cara"');
        expect(cast).toContain('"id":"always"');
        expect(cast).not.toContain('"id":"scene"');
        expect(cast).not.toContain("stranger-");
        const candidate = (title: string, type: MemoryPage["type"], confidence: number, aliases: string[] = []) => ({
            create: { title, type, aliases },
            confidence,
            reason: "A lasting subject",
        });
        const candidates = [
            candidate("Harbor", "location", LIMITS.createConfidence),
            candidate("Myth", "concept", LIMITS.createConfidence - 0.01),
            candidate("Watcher", "character", 0, ["Unapproved alias"]),
            candidate("Cara", "character", 0),
            candidate("Another scene", "scene", 1),
            { targetId: "scene", reason: "Move it", confidence: 1 },
        ];
        request.answer(
            JSON.stringify({
                ...analysis({
                    participants: ["Harbor", "Watcher", "Ghost"],
                    stateChanges: [
                        {
                            pageId: "Harbor",
                            section: "Gate",
                            before: "closed",
                            after: "open",
                            quote: "The gate opens.",
                        },
                    ],
                    knowledge: [
                        {
                            pageId: "Watcher",
                            fact: "Harbor opened",
                            stance: "knows",
                            knowers: ["Harbor", "Ghost"],
                            quote: "The gate opens.",
                        },
                        { pageId: "Harbor", fact: "Fabricated fact", stance: "knows", quote: "A quote never spoken" },
                        { pageId: "Ghost", fact: "Unknown subject", stance: "knows", quote: "The gate opens." },
                    ],
                    relationshipShifts: [{ from: "Watcher", to: "Harbor", direction: "arrives", note: "Visit" }],
                    openThreads: {
                        add: [{ title: "Return to Harbor", who: ["Watcher", "Ghost"] }],
                        close: [],
                        transitions: [],
                    },
                }),
                pageCandidates: candidates,
            }),
        );
        const patchRequest = await nextPatch(t, request.index + 1, terminal);
        const patchText = patchRequest.body.messages.find((m: OpenAIChat) => m.role === "user").content as string;
        const patchRows = patchText
            .split("\n\nEvent:\n")[0]
            .slice("Pages:\n".length)
            .split("\n")
            .map((line) => JSON.parse(line));
        const harborId = patchRows.find((row) => row.title === "Harbor").id as string;
        expect(patchRows.map((row) => row.id)).toEqual([harborId, "cara"]);
        const admitted = JSON.parse(patchText.split("\n\nEvent:\n")[1]);
        expect(admitted.participants).toEqual([harborId, "cara"]);
        expect(admitted.stateChanges).toEqual([
            { pageId: harborId, section: "Gate", before: "closed", after: "open", quote: "The gate opens." },
        ]);
        expect(admitted.knowledge).toEqual([
            { pageId: "cara", fact: "Harbor opened", stance: "knows", knowers: [harborId], quote: "The gate opens." },
        ]);
        expect(patchText).not.toContain("Fabricated fact");
        expect(patchText).not.toContain("A quote never spoken");
        const concurrent = { id: "concurrent", title: "User's pending question", who: [], state: "open" as const };
        writeMemory(t.store, "c", "k1", { threads: [concurrent] });
        patchRequest.answer(
            JSON.stringify({
                patches: [
                    { pageId: harborId, heading: "Gate", op: "upsert", body: "The gate is open." },
                    { pageId: "cara", heading: "identity", op: "upsert", body: "Must roll back" },
                    { pageId: "cara", heading: "knowledge", op: "upsert", body: "Must not overwrite" },
                ],
            }),
        );
        await finishRecording(t, terminal);
        expect(t.provider.requests).toHaveLength(2);
        const saved = eventRecord(t);
        expect(saved).toMatchObject({
            participants: [harborId, "cara"],
            stateChanges: admitted.stateChanges,
            knowledge: admitted.knowledge,
            relationshipShifts: [{ from: "cara", to: harborId, direction: "arrives", note: "Visit" }],
            openThreads: { add: [{ title: "Return to Harbor", who: ["cara"] }] },
        });
        expect(saved).not.toHaveProperty("speakerId");
        const harbor = t.store.memory.readRecord("c", "k1", "pages", harborId)!.data;
        expect(harbor).toMatchObject({
            title: "Harbor",
            aliases: ["Port", "Quay"],
            sections: [
                { heading: "Gate", body: "The gate is open.", provenance: [saved.id], sources: runRecord(t).window },
            ],
        });
        expect(harbor.history).toEqual([
            expect.objectContaining({ heading: null, before: null, kind: "create", eventId: saved.id }),
            expect.objectContaining({ heading: "Gate", before: null, kind: "create", eventId: saved.id }),
        ]);
        expect(t.store.memory.readRecord("c", "k1", "pages", "cara")!.data).toMatchObject({
            aliases: ["Watcher"],
            sections: cara.sections,
            history: [],
            links: [harborId],
        });
        expect(pageRecords(t).filter(({ title }) => ["Myth", "Another scene"].includes(title))).toEqual([]);
        expect(t.store.memory.readRecord("c", "k1", "threads", "concurrent")!.data).toEqual(concurrent);
        expect(runRecord(t).receipt).toMatchObject({
            state: "recorded",
            refused: [
                { candidate: candidates[1], refusal: "lowConfidence" },
                { candidate: candidates[4], refusal: "sceneOwned" },
                { candidate: candidates[5], refusal: "sceneOwned" },
            ],
            unverified: [
                { kind: "knowledge", text: "A quote never spoken", reason: "quoteNotFound" },
                { kind: "knowledge", text: "The gate opens.", reason: "unknownPage" },
            ],
        });
        expect(runRecord(t).receipt!.warnings).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "unknownPage", pageId: "Ghost" }),
                expect.objectContaining({ kind: "pageRefused", pageId: "cara", heading: "identity" }),
                expect.objectContaining({ kind: "lockedSection", pageId: "cara", heading: "knowledge" }),
            ]),
        );
        expect(t.embeddings.bodies.flatMap(({ input }) => input)).toEqual([
            "Cara promises to return.",
            "Harbor: Gate\nThe gate is open.",
        ]);
    });

    it("records refused candidates and repeated events without calling the patch model or creating entities", async () => {
        const t = structuredHarness();
        const low = {
            create: { title: "Rumor", type: "concept", aliases: [] },
            reason: "Uncertain",
            confidence: LIMITS.createConfidence - 0.01,
        };
        await recordOnly(t, {
            ...analysis(),
            pageCandidates: [
                low,
                { create: { title: "Scene", type: "scene", aliases: [] }, reason: "Scene", confidence: 1 },
            ],
        });
        expect(t.provider.requests).toHaveLength(1);
        expect(pageRecords(t)).toEqual([
            expect.objectContaining({
                type: "scene",
                sections: [],
                history: [expect.objectContaining({ heading: null, kind: "create" })],
            }),
        ]);
        expect(runRecord(t).receipt!.refused).toEqual([
            { candidate: low, refusal: "lowConfidence" },
            expect.objectContaining({ refusal: "sceneOwned" }),
        ]);
        const before = pageRecords(t);
        const id = eventRecord(t).id;
        const strong = { ...low, confidence: LIMITS.createConfidence };
        await recordOnly(t, { ...analysis(), pageCandidates: [strong] }, writerInput(t, "m5"));
        expect(t.provider.requests).toHaveLength(2);
        expect(contents(t).events.map(({ id }) => id)).toEqual([id]);
        expect(eventRecord(t)).toMatchObject({ id, repeatCount: 1 });
        expect(pageRecords(t)).toEqual(before);
        expect(runRecord(t).receipt!.refused).toEqual([{ candidate: strong, refusal: "repeatedEvent" }]);
    });

    it.each(["provider failure", "empty answer", "unusable JSON"] as const)(
        "keeps the window open after a patch %s and pauses after consecutive failures",
        async (failure) => {
            const t = structuredHarness();
            const answer = {
                ...analysis(),
                pageCandidates: [
                    {
                        create: { title: "Harbor", type: "location", aliases: [] },
                        confidence: LIMITS.createConfidence,
                        reason: "Arrived",
                    },
                ],
            };
            let firstInput: string | undefined;
            let firstBody: unknown;
            for (let attempt = 0; attempt < LIMITS.consecutiveFailures; attempt++) {
                const { request, terminal } = await beginAnalysis(t);
                if (attempt === 0) {
                    firstInput = runRecord(t).input;
                    firstBody = request.body;
                }
                expect(runRecord(t).input).toBe(firstInput);
                expect(request.body).toEqual(firstBody);
                request.answer(JSON.stringify(answer));
                const patchRequest = await nextPatch(t, request.index + 1, terminal);
                if (failure === "provider failure") patchRequest.fail("Patch provider failed");
                else patchRequest.answer(failure === "empty answer" ? " " : '{"wrong": []}');
                expect((await terminal).status).toMatchObject({ state: "failed", done: 0 });
                await t.service.drain();
                expect(runRecord(t)).toMatchObject({
                    result: "failed",
                    receipt: { state: "failed", reason: "patchFailed" },
                });
                expect(contents(t).events).toEqual([]);
                expect(contents(t).pages).toEqual([]);
                if (attempt === 0)
                    writeMemory(t.store, "c", "k1", {
                        threads: [{ id: "new-context", title: "Must not enter the replay", state: "open", who: [] }],
                    });
            }
            const terminal = t.nextTerminal("k1");
            t.service.handOff(writerInput(t, "m3"));
            const ended = await Promise.race([
                terminal,
                t.provider.request(t.provider.requests.length).then(() => {
                    throw new Error("Paused writer made a call");
                }),
            ]);
            expect(ended.status).toMatchObject({ state: "skipped", reason: "writerPaused" });
            expect(contents(t).runs).toHaveLength(LIMITS.consecutiveFailures);
            expect(t.provider.requests).toHaveLength(2 * LIMITS.consecutiveFailures);
        },
    );

    it.each(["group", "solo", "multi-speaker group"] as const)(
        "assigns the speaking member's page only in a %s chat",
        async (kind) => {
            const t = structuredHarness({
                owner:
                    kind !== "solo"
                        ? {
                              type: "group",
                              characters: ["member", "other-member"],
                              characterTalks: [1, 1],
                              characterActive: [true, true],
                          }
                        : {},
                hypaSettings: {
                    structured: { cadence: "everyK", cadenceTurns: kind === "multi-speaker group" ? 2 : 1 },
                },
            });
            t.store.put(
                t.kinds.get("characters")!,
                "member",
                { chaId: "member", type: "character", name: "Mira", nickname: "Captain", globalLore: [] },
                null,
            );
            t.store.put(
                t.kinds.get("characters")!,
                "other-member",
                { chaId: "other-member", type: "character", name: "Nora", globalLore: [] },
                null,
            );
            t.write("k1", [
                { op: "patchMessage", id: "m2", set: { saying: "member" } },
                { op: "patchMessage", id: "m4", set: { saying: "other-member" } },
            ]);
            await recordOnly(t, analysis(), writerInput(t, kind === "multi-speaker group" ? "m5" : "m3"));
            const members = pageRecords(t).filter(({ type }) => type === "character");
            if (kind === "group") {
                expect(members).toEqual([
                    expect.objectContaining({
                        title: "Mira",
                        aliases: ["Captain"],
                        sections: [],
                        history: [
                            expect.objectContaining({ heading: null, kind: "create", eventId: eventRecord(t).id }),
                        ],
                    }),
                ]);
                expect(eventRecord(t).speakerId).toBe(members[0].id);
            } else {
                expect(members).toEqual([]);
                expect(eventRecord(t)).not.toHaveProperty("speakerId");
            }
            expect(t.provider.requests).toHaveLength(1);
        },
    );

    it("rewrites one scene without patches, preserves blank and locked fields, and carries attendance into retrieval", async () => {
        const t = structuredHarness();
        writeMemory(t.store, "c", "k1", { pages: memoryRecords(["cara", "mira"]).pages });
        await recordOnly(t, {
            ...analysis(),
            scene: { place: "Inn", time: "Dawn", state: "Waiting", participants: ["cara"] },
        });
        const first = pageRecords(t).find(({ type }) => type === "scene")!;
        expect(first.sections.map(({ heading, body }) => ({ heading, body }))).toEqual([
            { heading: "place", body: "Inn" },
            { heading: "time", body: "Dawn" },
            { heading: "state", body: "Waiting" },
        ]);
        writeMemory(t.store, "c", "k1", {
            pages: [
                {
                    ...first,
                    sections: first.sections.map((section) => ({ ...section, locked: section.heading === "place" })),
                },
            ],
        });
        await recordOnly(
            t,
            {
                ...analysis({
                    summary: "Mira arrives at the inn.",
                    openThreads: {
                        add: [{ title: "Ask Mira about the gate", who: ["mira"] }],
                        close: [],
                        transitions: [],
                    },
                }),
                scene: { place: "Harbor", time: " ", state: "Mira arrives", participants: ["mira"] },
            },
            writerInput(t, "m5"),
        );
        const scenes = pageRecords(t).filter(({ type }) => type === "scene");
        expect(scenes).toHaveLength(1);
        expect(scenes[0]).toMatchObject({
            id: first.id,
            participants: ["mira"],
            sections: [
                { ...first.sections[0], locked: true },
                first.sections[1],
                expect.objectContaining({
                    heading: "state",
                    body: "Mira arrives",
                    provenance: [eventRecord(t, 0).id, eventRecord(t).id],
                }),
            ],
        });
        expect(scenes[0].history.at(-1)).toMatchObject({
            heading: "state",
            kind: "change",
            eventId: eventRecord(t).id,
            before: { body: "Waiting", provenance: [eventRecord(t, 0).id], sources: first.sections[2].sources },
        });
        expect(runRecord(t).receipt!.warnings).toEqual([
            expect.objectContaining({ kind: "lockedSection", pageId: first.id, heading: "place" }),
        ]);
        expect(t.provider.requests).toHaveLength(2);
        expect(t.embeddings.bodies.flatMap(({ input }) => input)).toEqual([
            "Cara promises to return.",
            "Mira arrives at the inn.",
        ]);
        const records = readMemoryRecords(t.store, "c", "k1");
        expect(records.stage).toEqual(["mira"]);
        const scope = t.jobScope("k1");
        const { host } = createMemoryTaskHost({
            scope,
            input: writerInput(t),
            deps: t.hostDeps,
            signal: new AbortController().signal,
            fence: () => {},
        });
        const selected = await retrieveLanes(host, {
            ...records,
            entries: [],
            window: { start: 0, dropped: new Set() },
            settings: normalizeStructuredMemorySettings({
                flowEvents: 0,
                laneTargets: { events: 0, pages: 0, evidence: 0, threads: 100 },
            }),
        });
        expect(selected.lanes.find(({ lane }) => lane === "threads")!.items).toEqual([
            expect.objectContaining({ id: records.threads[0].id, reason: "onStage" }),
        ]);
    });

    it("does not warm changed page sections when the pages lane is disabled", async () => {
        const t = structuredHarness({
            hypaSettings: { structured: { cadence: "everyTurn", laneTargets: { pages: 0 } } },
        });
        writeMemory(t.store, "c", "k1", { pages: memoryRecords(["harbor"], "Harbor").pages });
        const { request, terminal } = await beginAnalysis(t);
        request.answer(
            JSON.stringify({
                ...analysis(),
                pageCandidates: [{ targetId: "harbor", reason: "Gate opens", confidence: 1 }],
            }),
        );
        const patchRequest = await nextPatch(t, request.index + 1, terminal);
        patchRequest.answer(
            JSON.stringify({ patches: [{ pageId: "harbor", heading: "Gate", op: "upsert", body: "Open" }] }),
        );
        await finishRecording(t, terminal);
        expect(t.store.memory.readRecord("c", "k1", "pages", "harbor")!.data.sections[0].body).toBe("Open");
        expect(t.embeddings.bodies.flatMap(({ input }) => input)).toEqual(["Cara promises to return."]);
    });

    it("patches recorded and failed receipts onto every assistant in a window without changing its evidence or other generation info", async () => {
        for (const outcome of ["recorded", "failed"] as const) {
            const t = structuredHarness({ hypaSettings: { structured: { cadence: "everyK", cadenceTurns: 2 } } });
            const before = t.chat("k1")!.message;
            const hashes = before.map(messageSourceHash);
            const { request, terminal } = await beginAnalysis(t, writerInput(t, "m5"));
            // An edit during inference must survive the receipt's by-id patch.
            for (const id of ["m2", "m4"]) {
                t.write("k1", [
                    {
                        op: "patchMessage",
                        id,
                        set: {
                            generationInfo: { model: `reply-${id}`, inputTokens: 123, outputTokens: 45 },
                            time: 987,
                        },
                    },
                ]);
            }
            if (outcome === "recorded") request.answer(JSON.stringify(analysis()));
            else request.fail("Provider unavailable");
            const status = (await terminal).status;
            await t.service.drain();
            expect(status.state).toBe(outcome === "recorded" ? "done" : "failed");
            const stored = t.chat("k1")!.message;
            expect(stored.map(messageSourceHash)).toEqual(hashes);
            const receipt = runRecord(t).receipt!;
            expect(receipt).toMatchObject(
                outcome === "recorded"
                    ? { state: "recorded", eventId: eventRecord(t).id }
                    : { state: "failed", reason: "requestFailed" },
            );
            for (const id of ["m2", "m4"]) {
                expect(stored.find((message) => message.chatId === id)).toMatchObject({
                    time: 987,
                    generationInfo: { model: `reply-${id}`, inputTokens: 123, outputTokens: 45, memory: receipt },
                });
            }
            expect(stored.filter((message) => !["m2", "m4"].includes(message.chatId!))).toEqual(
                before.filter((message) => !["m2", "m4"].includes(message.chatId!)),
            );
            expect(contents(t).events).toHaveLength(outcome === "recorded" ? 1 : 0);
            expect(status).toMatchObject({
                terminalRevision: t.revision("k1"),
                lastCommittedRevision: t.revision("k1"),
            });
        }
    });

    it("refuses the whole window when a generation owns any of its messages before analysis commits", async () => {
        for (const messageId of ["m1", "m2"]) {
            const t = structuredHarness();
            const { request, terminal } = await beginAnalysis(t);
            const before = t.chat("k1");
            t.lock.addToken("generation-token");
            t.lock.acquire(
                { characterId: "c", chatId: "k1", messageId },
                {
                    jobId: "generation",
                    generationId: "g",
                    token: "generation-token",
                },
            );
            request.answer(JSON.stringify(analysis()));
            expect((await terminal).status).toMatchObject({ state: "skipped", reason: "windowChanged", done: 0 });
            await t.service.drain();
            expect(contents(t).events).toEqual([]);
            expect(runRecord(t).result).toBe("pending");
            expect(t.chat("k1")).toEqual(before);
        }
    });

    it("records through the pressed newest reply and resumes past a pause in oldest-window order", async () => {
        for (const through of ["m6", undefined]) {
            const t = structuredHarness({ hypaSettings: { structured: { cadence: "manual" } } });
            if (through) t.write("k1", [{ op: "remove", ids: ["m7"] }]);
            writeMemory(t.store, "c", "k1", {
                runs: Array.from({ length: 5 }, (_, index) => ({
                    id: `failure-${index}`,
                    window: [],
                    model: "writer",
                    inputTokens: 0,
                    outputTokens: 0,
                    durationMs: 0,
                    result: "failed" as const,
                })),
            });
            const terminal = t.nextTerminal("k1");
            // This stale captured ceiling cannot confirm any turn by itself.
            expect(t.service.record(writerInput(t, "m1"), through ? { through } : {}).outcome).toBe("queued");
            for (const [index, assistant] of ["m2", "m4", "m6"].entries()) {
                const request = await Promise.race([
                    t.provider.request(index),
                    terminal.then(({ status }) => {
                        throw new Error(`Recording stopped: ${JSON.stringify(status)}`);
                    }),
                ]);
                expect(contents(t).events).toHaveLength(index);
                expect(runRecord(t).window.map((source) => source.messageId)).toEqual([`m${index * 2 + 1}`, assistant]);
                request.answer(JSON.stringify(analysis({ summary: `Turn ${index + 1}` })));
            }
            expect((await terminal).status).toMatchObject({ state: "done", done: 3, total: 3 });
            await t.service.drain();
            expect(
                contents(t).events.map(
                    (entry) => t.store.memory.readRecord("c", "k1", "events", entry.id)!.data.summary,
                ),
            ).toEqual(["Turn 1", "Turn 2", "Turn 3"]);
            expect(
                t
                    .chat("k1")!
                    .message.filter((message) => message.role === "char")
                    .map((message) => message.generationInfo?.memory?.state),
            ).toEqual(["recorded", "recorded", "recorded"]);
        }
    });

    it("keeps a queued message confirmation across a send hand-off until a later press clears it", async () => {
        for (const clear of [false, true]) {
            const t = structuredHarness();
            t.write("k1", [{ op: "remove", ids: ["m7"] }]);
            const input = writerInput(t, "m3");
            const running = await beginAnalysis(t, input);
            const queued = t.service.record(input, { through: "m6" });
            if (queued.outcome !== "queued") throw new Error(`Recording refused: ${queued.reason}`);
            t.service.handOff(input);
            if (clear) expect(t.service.record(input).outcome).toBe("queued");
            const terminal = t.nextEvent(
                ({ status }) => status.taskId === queued.status.taskId && TERMINAL.has(status.state),
            );

            running.request.answer(JSON.stringify(analysis()));
            expect((await running.terminal).status.state).toBe("done");
            for (let index = 1; ; index++) {
                const request = await Promise.race([t.provider.request(index), terminal.then(() => null)]);
                if (!request) break;
                request.answer(
                    JSON.stringify(
                        analysis({
                            summary: index === 1 ? "Rain floods the harbor." : "The villagers rebuild the bridge.",
                        }),
                    ),
                );
            }
            expect((await terminal).status).toMatchObject({ state: "done", done: clear ? 1 : 2 });
            await t.service.drain();
            const windows = contents(t).events.map(({ id }) =>
                t.store.memory.readRecord("c", "k1", "events", id)!.data.sources.map((source) => source.messageId),
            );
            expect(windows).toEqual(
                clear
                    ? [
                          ["m1", "m2"],
                          ["m3", "m4"],
                      ]
                    : [
                          ["m1", "m2"],
                          ["m3", "m4"],
                          ["m5", "m6"],
                      ],
            );
        }
    });

    it("uses the memory slot at temperature zero without preset schema or extraction and snapshots before answering", async () => {
        const configurePreset = (t: Harness) =>
            t.replace("presets", (presets) =>
                presets.map((preset: object) => ({
                    ...preset,
                    temperature: 70,
                    jsonSchemaEnabled: true,
                    jsonSchema: "interface Answer {\n  answer: string\n}",
                    extractJson: "answer",
                })),
            );
        const t = structuredHarness({ memoryModelId: "reverse_proxy" });
        configurePreset(t);
        t.replace("modelProfiles", (profiles) =>
            profiles.map((profile: { id: string }) => ({
                ...profile,
                customProxyRequestModel: profile.id === "memory" ? "memory-model" : "main-model",
            })),
        );
        const input = writerInput(t, "m3");
        const { request, terminal } = await beginAnalysis(t, input);
        expect(request.body).toMatchObject({ model: "memory-model", temperature: 0 });
        expect(request.body).not.toHaveProperty("response_format");
        expect(contents(t).events).toEqual([]);
        expect(contents(t).runs).toHaveLength(1);
        const pending = runRecord(t);
        const snapshot = JSON.parse(pending.input!) as OpenAIChat[];
        expect(snapshot.map(({ role, content }) => ({ role, content }))).toEqual(request.body.messages);
        const inputTokens = snapshot.reduce((sum, message) => sum + message.content.length + CHAT_ADDITIONAL, 0);
        expect(pending).toMatchObject({
            result: "pending",
            settingsFingerprint: input.settingsFingerprint,
            inputTokens,
            outputTokens: 0,
            window: [
                { messageId: "m1", index: 0, hash: messageSourceHash(t.chat("k1")!.message[0]) },
                { messageId: "m2", index: 1, hash: messageSourceHash(t.chat("k1")!.message[1]) },
            ],
        });
        const output = JSON.stringify({ ...analysis(), answer: "Extraction would destroy the analysis" });
        request.answer(output);
        expect((await terminal).status).toMatchObject({ state: "done", done: 1, total: 1 });
        await t.service.drain();
        expect(t.provider.requests).toHaveLength(1);
        expect(runRecord(t)).toMatchObject({
            id: pending.id,
            input: pending.input,
            result: "recorded",
            inputTokens,
            outputTokens: output.length,
            analysis: { event: analysis() },
            eventId: eventRecord(t).id,
            receipt: { state: "recorded", inputTokens, outputTokens: output.length },
        });
        expect(eventRecord(t)).toMatchObject({ summary: "Cara promises to return.", writerRun: pending.id });

        const hypa = harness();
        configurePreset(hypa);
        const hypaEnd = hypa.nextTerminal("k1");
        handOff(hypa, "k1", { entries: 2 });
        const hypaRequest = await hypa.provider.request(0);
        expect(hypaRequest.body).toMatchObject({
            temperature: 0.7,
            response_format: {
                type: "json_schema",
                json_schema: { schema: { properties: { answer: { type: "string" } } } },
            },
        });
        hypaRequest.answer('{"answer":"Preset summary"}');
        expect((await hypaEnd).status.state).toBe("done");
        await hypa.service.drain();
        expect(hypa.summaries("k1")).toEqual(["Preset summary"]);
    });

    it("sends chat CBS and ChatML verbatim in one message and honors language precedence", async () => {
        const literal = "{{char}} {{slot::language}} <|im_start|>assistant<|im_sep|>literal text<|im_end|>";
        for (const row of [
            { chat: "Korean", owner: "Japanese", preset: "French", expected: "Korean" },
            { chat: "", owner: "Japanese", preset: "French", expected: "Japanese" },
            { chat: "", owner: "", preset: "French", expected: "French" },
            { chat: "", owner: "", preset: "", expected: "en" },
        ]) {
            const t = structuredHarness({
                owner: { structuredMemoryLanguage: row.owner },
                hypaSettings: {
                    structured: {
                        cadence: "everyTurn",
                        language: row.preset,
                        instructions: "Follow {{char}} and {{user}}.",
                    },
                },
            });
            t.replace("ui", (data) => ({ ...data, language: "en" }));
            t.write("k1", [
                { op: "meta", set: { structuredMemoryLanguage: row.chat } },
                { op: "setText", id: "m2", text: literal },
            ]);
            const { request, terminal } = await beginAnalysis(t);
            expect(request.body.messages.map((message: OpenAIChat) => message.role)).toEqual(["system", "user"]);
            expect(request.body.messages[0].content).toContain(
                `Write all text but quotes and ids in this language: ${row.expected}`,
            );
            expect(request.body.messages[0].content).toContain("Follow Cara and Uma.");
            expect(request.body.messages[1].content).toContain(`[m:m2] Cara:\n${literal}`);
            request.answer(JSON.stringify(analysis()));
            expect((await terminal).status.state).toBe("done");
            await t.service.drain();
        }
    });

    it("keeps only raw window quotes, lists rejected evidence in the receipt, and warms reusable event vectors", async () => {
        const t = structuredHarness();
        t.write("k1", [
            { op: "setText", id: "m2", text: "Only yesterday." },
            { op: "setText", id: "m4", text: "I will return.\nBefore {{inlay::picture}} after." },
        ]);
        writeMemory(t.store, "c", "k1", {
            events: [
                event(
                    "earlier",
                    t
                        .chat("k1")!
                        .message.slice(0, 2)
                        .map((message, index) => ({
                            messageId: message.chatId!,
                            index,
                            hash: messageSourceHash(message),
                        })),
                ),
            ],
            pages: memoryRecords(["cara"]).pages,
        });
        const quotes = ["I will return.", "I shall return.", "Only yesterday."];
        const keyLines = quotes.map((text) => ({ speaker: "Cara", text }));
        keyLines.push({ speaker: "Cara", text: "Before [Image] after." });
        const stateChanges = quotes.map((quote) => ({
            pageId: "cara",
            section: "goals",
            before: "unsure",
            after: "return",
            quote,
        }));
        const knowledge = quotes.map((quote) => ({
            pageId: "cara",
            fact: "A return is promised",
            stance: "knows" as const,
            quote,
        }));
        const { request, terminal } = await beginAnalysis(t, writerInput(t, "m5"));
        expect(t.provider.asked(request)).toContain("Only yesterday.");
        expect(t.provider.asked(request)).toContain("Before [Image] after.");
        request.answer(
            JSON.stringify(analysis({ summary: "  A return is promised.  ", keyLines, stateChanges, knowledge })),
        );
        expect((await terminal).status).toMatchObject({ state: "done", done: 1, total: 1 });
        await t.service.drain();
        const saved = eventRecord(t);
        expect(saved).toMatchObject({
            keyLines: [keyLines[0]],
            stateChanges: [stateChanges[0]],
            knowledge: [knowledge[0]],
        });
        expect(saved).not.toHaveProperty("grade");
        expect(runRecord(t).receipt?.unverified).toEqual([
            { kind: "keyLine", text: "I shall return.", reason: "quoteNotFound" },
            { kind: "keyLine", text: "Only yesterday.", reason: "quoteNotFound" },
            { kind: "keyLine", text: "Before [Image] after.", reason: "quoteNotFound" },
            { kind: "stateChange", text: "I shall return.", reason: "quoteNotFound" },
            { kind: "stateChange", text: "Only yesterday.", reason: "quoteNotFound" },
            { kind: "knowledge", text: "I shall return.", reason: "quoteNotFound" },
            { kind: "knowledge", text: "Only yesterday.", reason: "quoteNotFound" },
        ]);
        expect(t.embeddings.bodies).toEqual([{ input: ["A return is promised.", "I will return."] }]);
        const env = t.hostDeps.embeddings.forJob({
            db: t.jobScope("k1").db,
            supaMemoryKey: MEMORY_KEY,
            signal: new AbortController().signal,
        });
        const reader = new HypaProcesser(env, "ada");
        await reader.addText([saved.summary.trim(), ...saved.keyLines.map(({ text }) => text.trim())]);
        expect(reader.vectors.map(({ content }) => content)).toEqual(["A return is promised.", "I will return."]);
        expect(t.embeddings.bodies).toHaveLength(1);
    });

    it("merges repeats into only the last stored event and closes the repeated window", async () => {
        const t = structuredHarness();
        t.write("k1", [
            {
                op: "append",
                anchor: { end: true },
                messages: [m("m8", "Fourth reply", "char"), m("m9", "Confirm fourth reply", "user")],
            },
        ]);
        const input = writerInput(t, "m9");
        const { request, terminal } = await beginAnalysis(t, input);
        request.answer(JSON.stringify(analysis()));
        (await t.provider.request(1)).answer(
            JSON.stringify(analysis({ title: "Elsewhere", summary: "The ship sinks beneath a storm." })),
        );
        (await t.provider.request(2)).answer(JSON.stringify(analysis()));
        const fourth = await t.provider.request(3);
        expect(contents(t).events).toHaveLength(3);
        const first = eventRecord(t, 0);
        const last = eventRecord(t);
        writeMemory(t.store, "c", "k1", { events: [{ ...last, pinned: true }] });
        fourth.answer(
            JSON.stringify(
                analysis({ title: "Different proposed title", axes: { persistence: 3, change: 3, reach: 3 } }),
            ),
        );
        expect((await terminal).status).toMatchObject({ state: "done", done: 4, total: 4 });
        await t.service.drain();
        expect(contents(t).events).toHaveLength(3);
        expect(eventRecord(t, 0)).toEqual(first);
        expect(eventRecord(t)).toEqual({
            ...last,
            pinned: true,
            repeatCount: 1,
            sources: [
                ...last.sources,
                ...t
                    .chat("k1")!
                    .message.slice(6, 8)
                    .map((message, index) => ({
                        messageId: message.chatId!,
                        index: index + 6,
                        hash: messageSourceHash(message),
                    })),
            ],
        });
        expect(runRecord(t)).toMatchObject({ result: "recorded", eventId: last.id });
        const empty = t.nextTerminal("k1");
        t.service.handOff(input);
        expect((await empty).status).toMatchObject({ state: "done", done: 0, total: 0 });
        await t.service.drain();
        expect(t.provider.requests).toHaveLength(4);
    });

    it("closes threads only by a known non-ended id and stores new threads and final transitions", async () => {
        const t = structuredHarness();
        writeMemory(t.store, "c", "k1", {
            threads: [
                { id: "open", title: "Open promise", who: [], state: "open" },
                { id: "title-target", title: "Title only", who: [], state: "open" },
                { id: "done", title: "Done promise", who: [], state: "done", closedBy: "old" },
                { id: "cancelled", title: "Cancelled promise", who: [], state: "cancelled", closedBy: "old" },
                { id: "moving", title: "Moving promise", who: [], state: "partial" },
            ],
        });
        expect(
            await answerAnalysis(
                t,
                analysis({
                    openThreads: {
                        add: [{ title: "New promise", who: [] }],
                        close: ["open", "Title only", "missing", "done", "cancelled"],
                        transitions: [
                            { threadId: "moving", to: "progress" },
                            { threadId: "moving", to: "paused" },
                            { threadId: "done", to: "open" },
                        ],
                    },
                }),
            ),
        ).toMatchObject({ state: "done", done: 1 });
        const saved = eventRecord(t);
        const threads = contents(t).threads.map(({ id }) => t.store.memory.readRecord("c", "k1", "threads", id)!.data);
        expect(threads).toHaveLength(6);
        expect(threads).toEqual(
            expect.arrayContaining([
                { id: "open", title: "Open promise", who: [], state: "done", closedBy: saved.id },
                { id: "title-target", title: "Title only", who: [], state: "open" },
                { id: "done", title: "Done promise", who: [], state: "done", closedBy: "old" },
                { id: "cancelled", title: "Cancelled promise", who: [], state: "cancelled", closedBy: "old" },
                { id: "moving", title: "Moving promise", who: [], state: "paused" },
                { id: expect.any(String), title: "New promise", who: [], state: "open", openedBy: saved.id },
            ]),
        );
        expect(saved.openThreads).toEqual({
            add: [{ title: "New promise", who: [] }],
            close: ["open"],
            transitions: [{ threadId: "moving", to: "paused" }],
        });
        expect(runRecord(t).receipt?.warnings).toEqual([
            { kind: "unknownThread", detail: "Title only" },
            { kind: "unknownThread", detail: "missing" },
            { kind: "endedThread", detail: "done" },
            { kind: "endedThread", detail: "cancelled" },
            { kind: "endedThread", detail: "done" },
        ]);
    });

    it("replays a failed snapshot byte for byte despite thread changes and rebuilds when settings change", async () => {
        const t = structuredHarness();
        writeMemory(t.store, "c", "k1", {
            threads: [{ id: "promise", title: "Original promise", who: [], state: "open" }],
        });
        const first = await beginAnalysis(t);
        first.request.fail("Provider rejected the analysis");
        expect((await first.terminal).status.state).toBe("failed");
        await t.service.drain();
        const failed = runRecord(t);
        expect(failed).toMatchObject({ result: "failed", receipt: { state: "failed", reason: "requestFailed" } });
        expect(contents(t).events).toEqual([]);
        writeMemory(t.store, "c", "k1", {
            threads: [{ id: "promise", title: "Changed promise", who: [], state: "progress" }],
        });
        const retry = await beginAnalysis(t);
        expect(retry.request.rawBody).toBe(first.request.rawBody);
        expect(runRecord(t)).toMatchObject({
            input: failed.input,
            window: failed.window,
            inputTokens: failed.inputTokens,
        });
        retry.request.fail("Still unavailable");
        expect((await retry.terminal).status.state).toBe("failed");
        await t.service.drain();
        t.replace("hypaV3Presets", (data) => ({
            ...data,
            items: data.items.map((item: any) => ({
                ...item,
                settings: {
                    ...item.settings,
                    structured: { ...item.settings.structured, instructions: "Record the newly configured details." },
                },
            })),
        }));
        const changed = await beginAnalysis(t);
        expect(changed.request.rawBody).not.toBe(first.request.rawBody);
        expect(t.provider.asked(changed.request)).toContain("Changed promise");
        expect(t.provider.asked(changed.request)).toContain("Record the newly configured details.");
        expect(runRecord(t).settingsFingerprint).not.toBe(failed.settingsFingerprint);
        expect(runRecord(t).window).toEqual(failed.window);
        changed.request.answer(JSON.stringify(analysis()));
        expect((await changed.terminal).status).toMatchObject({ state: "done", done: 1, total: 1 });
        await t.service.drain();
        expect(contents(t).runs.map(({ result }) => result)).toEqual(["failed", "failed", "recorded"]);
        expect(contents(t).events).toHaveLength(1);
    });

    it("pauses after five failures, permits a manual recording, and resets the failure count on success", async () => {
        const t = structuredHarness({ limits: { maxWriterWindows: 1 } });
        for (let attempt = 0; attempt < 5; attempt++) {
            const { request, terminal } = await beginAnalysis(t);
            request.fail("Unavailable");
            expect((await terminal).status.state).toBe("failed");
            await t.service.drain();
            expect(contents(t).runs).toHaveLength(attempt + 1);
        }
        const before = contents(t);
        const paused = t.nextTerminal("k1");
        t.service.handOff(writerInput(t, "m3"));
        const pauseResult = await Promise.race([
            paused,
            t.provider.request(5).then(() => {
                throw new Error("Paused writer made a model request");
            }),
        ]);
        expect(pauseResult.status).toMatchObject({ state: "skipped", reason: "writerPaused", done: 0 });
        await t.service.drain();
        expect(t.provider.requests).toHaveLength(5);
        expect(contents(t)).toEqual(before);
        const manual = await beginAnalysis(t, writerInput(t, "m3"), true);
        manual.request.answer(JSON.stringify(analysis()));
        expect((await manual.terminal).status).toMatchObject({ state: "done", done: 1 });
        await t.service.drain();
        expect(runRecord(t).result).toBe("recorded");
        // Four new failures must still run: the five before the recording no longer count.
        for (let attempt = 0; attempt < 4; attempt++) {
            const { request, terminal } = await beginAnalysis(t, writerInput(t, "m5"));
            request.fail("Unavailable again");
            expect((await terminal).status.state).toBe("failed");
            await t.service.drain();
        }
        expect(
            await answerAnalysis(t, analysis({ summary: "A new voyage begins." }), writerInput(t, "m5")),
        ).toMatchObject({ state: "done", done: 1 });
        expect(t.provider.requests).toHaveLength(11);
    });

    it("closes abandoned pending runs as interrupted without counting them as failures", async () => {
        const t = structuredHarness();
        for (let attempt = 0; attempt < 4; attempt++) {
            const { request, terminal } = await beginAnalysis(t);
            request.fail("Unavailable");
            await terminal;
            await t.service.drain();
        }
        const cancelled = await beginAnalysis(t);
        const pending = runRecord(t);
        expect(pending.result).toBe("pending");
        expect(t.service.cancel(ref("k1"))).toBe(true);
        expect((await cancelled.terminal).status.state).toBe("cancelled");
        await t.service.drain();
        expect(runRecord(t).result).toBe("pending");
        const resumed = await beginAnalysis(t);
        expect(t.store.memory.readRecord("c", "k1", "runs", pending.id)!.data).toMatchObject({
            result: "skipped",
            reason: "interrupted",
            input: pending.input,
        });
        expect(resumed.request.rawBody).toBe(cancelled.request.rawBody);
        resumed.request.fail("Fifth actual failure");
        expect((await resumed.terminal).status.state).toBe("failed");
        await t.service.drain();
        const paused = t.nextTerminal("k1");
        t.service.handOff(writerInput(t, "m3"));
        expect(
            (
                await Promise.race([
                    paused,
                    t.provider.request(6).then(() => {
                        throw new Error("Interrupted run reset the failure count");
                    }),
                ])
            ).status,
        ).toMatchObject({ state: "skipped", reason: "writerPaused" });
        expect(t.provider.requests).toHaveLength(6);
        expect(contents(t).events).toEqual([]);
    });

    it("discards analysis arriving after cancellation or the task deadline", async () => {
        for (const stop of ["cancel", "deadline"] as const) {
            const t = structuredHarness({ ignoreAbort: true, limits: { taskDeadlineMs: 60_000 } });
            const { request, terminal } = await beginAnalysis(t);
            if (stop === "cancel") expect(t.service.cancel(ref("k1"))).toBe(true);
            else t.clock.now += 60_000;
            request.answer(JSON.stringify(analysis()));
            expect((await terminal).status).toMatchObject({
                state: stop === "cancel" ? "cancelled" : "failed",
                reason: stop === "cancel" ? "cancelled" : "deadline",
                done: 0,
            });
            await t.service.drain();
            expect(contents(t).events).toEqual([]);
            expect(runRecord(t).result).toBe("pending");
            expect(t.embeddings.bodies).toEqual([]);
        }
    });

    it("fails invalid required output with its field name and keeps the failed run without an event", async () => {
        const t = structuredHarness();
        const { request, terminal } = await beginAnalysis(t);
        const output = JSON.stringify({ ...analysis(), summary: 42 });
        request.answer(output);
        expect((await terminal).status).toMatchObject({
            state: "failed",
            error: expect.stringContaining('"summary"'),
            done: 0,
        });
        await t.service.drain();
        expect(runRecord(t)).toMatchObject({
            result: "failed",
            error: expect.stringContaining('"summary"'),
            outputTokens: output.length,
            receipt: { state: "failed", reason: "invalidField" },
        });
        expect(contents(t).events).toEqual([]);
        expect(t.embeddings.bodies).toEqual([]);
    });

    it("keeps a recorded event and finishes done with warmingFailed when embeddings fail", async () => {
        const t = structuredHarness({ embeddingFail: true });
        expect(await answerAnalysis(t)).toMatchObject({
            state: "done",
            reason: "warmingFailed",
            done: 1,
            total: 1,
            error: expect.any(String),
        });
        expect(contents(t).events).toHaveLength(1);
        expect(eventRecord(t).summary).toBe("Cara promises to return.");
        expect(runRecord(t)).toMatchObject({
            result: "recorded",
            eventId: eventRecord(t).id,
            receipt: { state: "recorded" },
        });
        expect(t.embeddings.bodies).toEqual([{ input: ["Cara promises to return."] }]);
    });

    it("records uncovered windows in order, resumes after a service restart, and keeps chat revisions in statuses", async () => {
        const seen: (string | undefined)[][] = [];
        const writer: StructuredMemoryWriter = async (call) => {
            seen.push(ids(call));
            return record(t, call);
        };
        const t = structuredHarness({ structuredWriter: writer, limits: { maxWriterWindows: 1 } });
        const chatRevision = t.revision("k1");
        // Every status covers its cited message, including a retracted user and a stale assistant.
        t.store.memory.write(
            "c",
            "k1",
            { epoch: t.store.epoch(), baseRevision: contents(t).revision },
            {
                events: [
                    event("active", [{ messageId: "m1", index: 0, hash: messageSourceHash(t.chat("k1")!.message[0]) }]),
                    event(
                        "retracted",
                        [{ messageId: "m3", index: 2, hash: messageSourceHash(t.chat("k1")!.message[2]) }],
                        "retracted",
                    ),
                    event(
                        "stale",
                        [{ messageId: "m2", index: 1, hash: messageSourceHash(t.chat("k1")!.message[1]) }],
                        "stale",
                    ),
                ],
            },
        );
        const input = writerInput(t);
        const first = t.nextTerminal("k1");
        t.service.handOff(input);
        expect((await first).status).toMatchObject({
            kind: "structuredMemory",
            state: "done",
            done: 1,
            total: 1,
            reason: "windowsLeft",
            terminalRevision: chatRevision,
        });
        expect(seen).toEqual([["m4"]]);
        expect(t.service.status(ref("k1"))).toEqual((await first).status);
        expect(t.states("k1")).toContain("queued");
        expect(t.states("k1")).toContain("running");
        expect(t.events.every(({ status }) => status.kind === "structuredMemory")).toBe(true);
        expect((await first).status).not.toHaveProperty("lastCommittedRevision");
        expect(t.store.memory.readRecord("c", "k1", "events", "m4")?.data).toMatchObject({
            summary: "Recorded m4",
            sources: [{ messageId: "m4" }],
        });
        expect(t.revision("k1")).toBe(chatRevision);
        expect(contents(t).revision).not.toBe(chatRevision);
        t.service.beginShutdown();
        await t.service.drain();

        const restarted = createMemoryTasks({
            store: t.store,
            kinds: t.kinds,
            gate: t.gate,
            hostDeps: t.hostDeps,
            now: () => t.clock.now,
            structuredWriter: writer,
        });
        cleanups.push(async () => {
            restarted.beginShutdown();
            await restarted.drain();
        });
        const terminal = () =>
            new Promise<MemoryTaskEvent>((resolve) => {
                const off = restarted.onStatus((entry) => {
                    if (TERMINAL.has(entry.status.state)) {
                        off();
                        resolve(entry);
                    }
                });
            });
        const second = terminal();
        restarted.handOff(input);
        expect((await second).status).toMatchObject({
            state: "done",
            done: 1,
            total: 1,
            terminalRevision: chatRevision,
        });
        expect((await second).status).not.toHaveProperty("reason");
        expect(seen).toEqual([["m4"], ["m5", "m6"]]);
        const empty = terminal();
        restarted.handOff(input);
        expect((await empty).status).toMatchObject({ state: "done", done: 0, total: 0 });
        expect(seen).toHaveLength(2);
    });

    it("stops at the first skipped or failed window and retries it without letting a later user extend the automatic ceiling", async () => {
        for (const outcome of ["skipped", "failed"] as const) {
            const seen: (string | undefined)[][] = [];
            let fail = true;
            const t = structuredHarness({
                structuredWriter: async (call) => {
                    seen.push(ids(call));
                    if (fail && call.window.sources.at(-1)!.messageId === "m4") {
                        return outcome === "skipped"
                            ? { outcome, reason: "writerDeclined" }
                            : { outcome, error: `Writer rejected ${PROXY_KEY}` };
                    }
                    return record(t, call);
                },
            });
            const input = writerInput(t);
            // An output trigger's user message arrives after the reply and after input capture.
            t.write("k1", [
                {
                    op: "append",
                    anchor: { end: true },
                    messages: [m("m8", "Unconfirmed reply", "char"), m("m9", "Trigger user", "user")],
                },
            ]);
            const stopped = t.nextTerminal("k1");
            t.service.handOff(input);
            const status = (await stopped).status;
            expect(status).toMatchObject({ state: outcome, done: 1, total: 3 });
            if (outcome === "skipped") expect(status).toHaveProperty("reason", "writerDeclined");
            else {
                expect(status).toHaveProperty("error", expect.stringContaining("Writer rejected"));
                expect(JSON.stringify(status)).not.toContain(PROXY_KEY);
            }
            expect(seen).toEqual([
                ["m1", "m2"],
                ["m3", "m4"],
            ]);
            expect(contents(t).events.map(({ id }) => id)).toEqual(["m2"]);
            fail = false;
            const retried = t.nextTerminal("k1");
            t.service.handOff(input);
            expect((await retried).status).toMatchObject({ state: "done", done: 2, total: 2 });
            expect(seen.slice(2)).toEqual([
                ["m3", "m4"],
                ["m5", "m6"],
            ]);
            expect(contents(t).events.map(({ id }) => id)).toEqual(["m2", "m4", "m6"]);
        }
    });

    it("manual starts close partial windows and use the newly confirmed stored chat on each start", async () => {
        for (const row of [
            {
                cadence: "everyK",
                ceiling: "m5",
                remove: ["m6", "m7"],
                nextReply: "m6",
                nextUser: "m7",
                expected: [
                    ["m1", "m2", "m3", "m4"],
                    ["m5", "m6"],
                ],
            },
            {
                cadence: "manual",
                ceiling: "m3",
                remove: ["m4", "m5", "m6", "m7"],
                nextReply: "m4",
                nextUser: "m5",
                expected: [
                    ["m1", "m2"],
                    ["m3", "m4"],
                ],
            },
        ]) {
            const seen: (string | undefined)[][] = [];
            const t = structuredHarness({
                hypaSettings: { structured: { cadence: row.cadence, cadenceTurns: 3 } },
                structuredWriter: async (call) => {
                    seen.push(ids(call));
                    return record(t, call);
                },
            });
            t.write("k1", [{ op: "remove", ids: row.remove }]);
            const input = writerInput(t, row.ceiling);
            const automatic = t.nextTerminal("k1");
            t.service.handOff(input);
            expect((await automatic).status).toMatchObject({ state: "done", done: 0, total: 0 });
            const first = t.nextTerminal("k1");
            expect(t.service.start(ref("k1")).outcome).toBe("queued");
            expect((await first).status).toMatchObject({ state: "done", done: 1, total: 1 });
            t.write("k1", [
                {
                    op: "append",
                    anchor: { end: true },
                    messages: [m(row.nextReply, "Next reply", "char"), m(row.nextUser, "Next real user", "user")],
                },
            ]);
            const second = t.nextTerminal("k1");
            expect(t.service.start(ref("k1")).outcome).toBe("queued");
            expect((await second).status).toMatchObject({ state: "done", done: 1, total: 1 });
            expect(seen, row.cadence).toEqual(row.expected);
        }
    });

    it("reports structured skip reasons and keeps HypaV3 statuses without a kind key", async () => {
        const rows: { reason: string; options?: HarnessOptions; hypa?: boolean; deselect?: boolean }[] = [
            { reason: "pluginModel", options: { memoryModelId: "pluginmodel:::prov" } },
            { reason: "requestTrigger", options: { owner: { triggerscript: [REQUEST_TRIGGER] } } },
            { reason: "localSummarization", options: { hypaSettings: { summarizationModel: "localModel" } } },
            { reason: "notStructuredMemory", deselect: true },
            { reason: "notHypaV3", hypa: true, options: { memorySection: { hypaV3: true } } },
        ];
        for (const row of rows) {
            const t = structuredHarness(row.options);
            const input = row.hypa ? t.input("k1") : writerInput(t);
            if (row.deselect) t.replace("ui", (data) => ({ ...data, memoryAlgorithmType: "hypaV3" }));
            const ended = t.nextTerminal("k1");
            t.service.handOff(input);
            const terminal = await Promise.race([
                ended,
                t.provider.request(0).then(() => {
                    throw new Error("Skipped tasks must not request summaries");
                }),
            ]);
            expect(terminal.status, row.reason).toMatchObject({
                state: "skipped",
                reason: row.reason,
                done: 0,
                total: 0,
            });
            for (const { status } of t.events) {
                if (row.hypa) expect(status).not.toHaveProperty("kind");
                else expect(status).toHaveProperty("kind", "structuredMemory");
            }
            expect(t.service.status(ref("k1"))).toEqual((await ended).status);
            expect(contents(t).events).toEqual([]);
        }
    });

    it("refuses a commit when evidence loses confirmation, changes, disappears, or its revisions conflict", async () => {
        const rows: { name: string; reason: string; change(t: Harness): void }[] = [
            {
                name: "edited text",
                reason: "windowChanged",
                change: (t) => {
                    t.write("k1", [{ op: "setText", id: "m2", text: "Edited" }]);
                },
            },
            {
                name: "removed message",
                reason: "windowChanged",
                change: (t) => {
                    t.write("k1", [{ op: "remove", ids: ["m2"] }]);
                },
            },
            {
                name: "disabled evidence",
                reason: "windowChanged",
                change: (t) => {
                    t.write("k1", [{ op: "patchMessage", id: "m2", set: { disabled: true } }]);
                },
            },
            {
                name: "reset history",
                reason: "windowChanged",
                change: (t) => {
                    t.write("k1", [{ op: "patchMessage", id: "m3", set: { disabled: "allBefore" } }]);
                },
            },
            {
                name: "moved beyond the ceiling",
                reason: "windowChanged",
                change: (t) => {
                    const message = t.chat("k1")!.message[1];
                    t.write("k1", [
                        { op: "remove", ids: ["m2"] },
                        { op: "append", anchor: { end: true }, messages: [message] },
                    ]);
                },
            },
            {
                name: "removed ceiling",
                reason: "windowChanged",
                change: (t) => {
                    t.write("k1", [{ op: "remove", ids: ["m7"] }]);
                },
            },
            {
                name: "new memory revision",
                reason: "revisionConflict",
                change: (t) => {
                    t.store.memory.write(
                        "c",
                        "k1",
                        { epoch: t.store.epoch(), baseRevision: contents(t).revision },
                        { events: [event("other", [])] },
                    );
                },
            },
            {
                name: "new source generation",
                reason: "staleInput",
                change: (t) => {
                    t.write("k1", [{ op: "replace", chat: t.chat("k1")! }]);
                },
            },
            {
                name: "disabled confirming users",
                reason: "windowChanged",
                change: (t) => {
                    t.write(
                        "k1",
                        ["m3", "m5", "m7"].map((id) => ({ op: "patchMessage" as const, id, set: { disabled: true } })),
                    );
                },
            },
        ];
        for (const row of rows) {
            const arrival = deferred<WriterCall>();
            const release = deferred<{ outcome: "skipped"; reason: string }>();
            const t = structuredHarness({
                invalidations: false,
                structuredWriter: async (call) => {
                    arrival.resolve(call);
                    return await release.promise;
                },
            });
            const ended = t.nextTerminal("k1");
            t.service.handOff(writerInput(t));
            try {
                const call = await arriveOrEnd(arrival, ended);
                const revision = contents(t).revision;
                row.change(t);
                const before = contents(t);
                expect(call.commit(revision, { events: [event("late", call.window.sources)] }), row.name).toEqual({
                    outcome: "refused",
                    reason: row.reason,
                });
                expect(contents(t), row.name).toEqual(before);
            } finally {
                release.resolve({ outcome: "skipped", reason: "finished" });
            }
            await ended;
        }
    });

    it("a writer lease or cancel closes the commit fence before a late writer returns", async () => {
        for (const stop of ["lease", "cancel"] as const) {
            const arrival = deferred<WriterCall>();
            const release = deferred();
            const settled = deferred();
            const attempts: unknown[] = [];
            const t = structuredHarness({
                structuredWriter: async (call) => {
                    arrival.resolve(call);
                    await release.promise;
                    try {
                        attempts.push(
                            call.commit(contents(t).revision, {
                                events: [event("late", call.window.sources)],
                                runs: [
                                    {
                                        id: "late-run",
                                        window: call.window.sources,
                                        model: "writer",
                                        inputTokens: 1,
                                        outputTokens: 1,
                                        durationMs: 0,
                                        result: "recorded",
                                        receipt: {
                                            state: "recorded",
                                            eventId: "late",
                                            pages: [],
                                            refused: [],
                                            unverified: [],
                                            warnings: [],
                                        },
                                    },
                                ],
                            }),
                        );
                    } catch (error) {
                        attempts.push(error);
                    } finally {
                        settled.resolve();
                    }
                    return { outcome: "recorded" };
                },
            });
            const ended = t.nextTerminal("k1");
            t.service.handOff(writerInput(t));
            await arriveOrEnd(arrival, ended);
            const lease = stop === "lease" ? t.service.acquireSummaryWriter(ref("k1"), "new-send") : null;
            if (stop === "cancel") expect(t.service.cancel(ref("k1"))).toBe(true);
            const status = (await ended).status;
            expect(status).toMatchObject({ kind: "structuredMemory", state: "cancelled", done: 0 });
            const before = contents(t);
            const chatBefore = t.chat("k1");
            release.resolve();
            await settled.promise;
            (await lease)?.release();
            expect(t.chat("k1")).toEqual(chatBefore);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]).toBeInstanceOf(Error);
            expect(contents(t)).toEqual(before);
            expect(t.service.status(ref("k1"))).toEqual(status);
        }
    });
});
