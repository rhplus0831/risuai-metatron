// The fixture harness of the Structured Memory evaluation (not a test file itself): a real resource
// store on a temp dir with a story's chat, the real request layer and embeddings over the scripted
// upstreams (`scriptedWriter.ts`), the real token counter over injected tokenizers, and the real memory
// task service with its own writer. Only the `fetch`, clock, and worker boundaries are faked.
//
// - `rebuild` is the structured writer's driver: a clean store, one-turn windows, the real rebuild run
//   (`begin`, `rebuild`, the chain of tasks, the swap), so every window goes through the real writer,
//   admission, and commit. It differs from a live hand-off in the ways a rebuild does: `manual: true`,
//   staged tables and a swap, no receipts on messages, no pause.
// - `summarize` is the HypaV3 side: the real hand-off, repeated until the lookahead plan stops at its
//   target or the protected tail.
// - `send` is what `structuredMemoryStep` does of a send without a job: `readMemoryRecords` and
//   `selectMemory` over the whole stored chat plus one new user message, which is kept in memory and
//   never stored. Under HypaV3 it is `prepareHypaV3` and `selectHypaV3`, select only, as a job with a
//   task service reads.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { eligibleHistory } from "../../../../../../shared/contextReport.ts";
import type { Chat, Message } from "../../../../../../shared/database.ts";
import type {
    GenerationContext,
    MemoryEntrySource,
    MemoryTaskBase,
    MemoryTaskInput,
    MemoryTaskStatus,
    StructuredMemoryTaskInput,
} from "../../../../../../shared/jobs.ts";
import { LLMFormat } from "../../../../../../shared/llm.ts";
import type { OpenAIChat } from "../../../../../../shared/openai.ts";
import {
    coveredMessages,
    type MemoryEvent,
    type MemoryManifestItem,
    normalizeStructuredMemorySettings,
    rawWindow,
} from "../../../../../../shared/structuredMemory.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../data/kinds.ts";
import { messageSourceHash } from "../../../../data/memoryStore.ts";
import { createResourceStore, type ResourceStore } from "../../../../data/resourceStore.ts";
import type { MaintenanceGate } from "../../../../data/snapshots.ts";
import { createVectorCache, type VectorCache } from "../../../../data/vectorCache.ts";
import { createGenerationLock } from "../../../../jobs/generationLock.ts";
import {
    type JobScope,
    loadJobScope,
    memorySettingsFingerprint,
    memoryTokenPolicy,
    scopeChat,
} from "../../../../jobs/jobScope.ts";
import { createLlmRequests } from "../../../../llm/requests.ts";
import { createEmbeddings, HypaProcesser } from "../../../../prompt/embeddings.ts";
import type { MemoryHost, MemoryTokenizer } from "../../../../prompt/memory/host.ts";
import {
    emptyHypaV3Execution,
    getCurrentHypaV3Preset,
    type HypaV3StopReason,
    hypaV3SourceHash,
    planHypaV3Summaries,
    prepareHypaV3,
    selectHypaV3,
} from "../../../../prompt/memory/hypav3.ts";
import { createMemoryTaskHost, type MemoryTaskHostDeps } from "../../../../prompt/memory/memoryTaskHost.ts";
import {
    createMemoryTasks,
    type MemoryTaskEvent,
    type MemoryTaskLimits,
} from "../../../../prompt/memory/memoryTasks.ts";
import { applyEventRepair, applyPageEdit } from "../../../../prompt/memory/structured/edits.ts";
import type { ExcludedItem, LaneSpend } from "../../../../prompt/memory/structured/lanes.ts";
import { readRecordSet, rebuildPlan, rebuildSeed } from "../../../../prompt/memory/structured/rebuild.ts";
import {
    reconcileEvents,
    reconcileMessageChanges,
    withRetractedEvidence,
} from "../../../../prompt/memory/structured/reconcile.ts";
import { retrieveLanes } from "../../../../prompt/memory/structured/retrieve.ts";
import {
    type MemoryRecords,
    readEntries,
    readMemoryRecords,
    selectMemory,
} from "../../../../prompt/memory/structured/step.ts";
import {
    readRecordedMessages,
    readRerecordEvents,
    writerCadence,
} from "../../../../prompt/memory/structured/window.ts";
import type { Tokenizers } from "../../../../prompt/tokenizers/index.ts";
import { createTokenCounter } from "../../../../prompt/tokens.ts";
import type { TransformersService } from "../../../../prompt/transformers.ts";
import type { RegexOp, RegexOpResult } from "../../../../scripts/worker.ts";
import { UNHURRIED_CBS, UNHURRIED_HYPAV3_SEPARATOR } from "../../../unhurriedLimits.ts";
import { createScriptedChat, createScriptedEmbeddings, type ScriptedCall } from "./scriptedWriter.ts";
import { type ProbeSetup, type Story, storyMessages, turnOfMessageId } from "./story.ts";
import { resolveLabel } from "./evaluate.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");

export type FixtureAlgorithm = "structuredMemory" | "hypaV3";

export const CHARACTER_ID = "c";
export const CHAT_ID = "k";
/** The id the in-memory probe message carries; no stored message has it. */
export const PROBE_MESSAGE_ID = "probe";

const PROXY_KEY = "sk-proxy-SENTINEL-1111";
const MEMORY_KEY = "memory-SENTINEL-3333";
const TERMINAL = new Set<MemoryTaskStatus["state"]>(["done", "failed", "cancelled", "skipped"]);

/**
 * The HypaV3 preset both algorithms read: ratio mode, a fifth of the context for memory, no random
 * lane (the recent and similar shares sum to one, so `host.random` decides nothing), the standard
 * implementation, and the defaults otherwise. The structured writer records every turn.
 */
export const PINNED_PRESET = {
    budgetMode: "ratio",
    memoryTokensRatio: 0.2,
    extraSummarizationRatio: 0,
    lookaheadHeadroomRatio: 0.15,
    maxChatsPerSummary: 6,
    recentMemoryRatio: 0.5,
    similarMemoryRatio: 0.5,
    queryChatCount: 3,
    useExperimentalImpl: false,
    doNotSummarizeUserMessage: false,
    enableSimilarityCorrection: false,
    preserveOrphanedMemory: false,
    structured: { cadence: "everyTurn" },
} as const;

/** The stop reasons of a lookahead plan that mean the stored summaries are enough. */
const PLAN_SETTLED = new Set<HypaV3StopReason>(["notNeeded", "targetReached", "tailReached", "nextWindowOvershoots"]);

export type FixtureOptions = {
    story: Story;
    algorithm: FixtureAlgorithm;
    /** Where the temp dir goes (default `os.tmpdir()`). */
    dir?: string;
    /** The server tokenizers (default the stub). */
    tokenizers?: Tokenizers;
    /** The main profile's tokenizer family, which the writer and the selection count with. */
    tokenizerFamily?: string;
    /** The injected clock; every scripted call moves it by one. */
    clock?: { now: number };
    limits?: Partial<MemoryTaskLimits>;
    maxContext?: number;
    maxResponse?: number;
};

/** Characters per token by family, near English prose; the main profile counts with `claude`. */
const STUB_CHARS_PER_TOKEN: Record<string, number> = { claude: 4, cl100k_base: 4, o200k_base: 4 };

/** Deterministic tokenizers for a gate: a fixed number of characters per token by family. */
export function createStubTokenizers(): Tokenizers {
    const encode = async (family: string, text: string) => {
        const per = STUB_CHARS_PER_TOKEN[family];
        if (per === undefined) {
            throw new Error(`Unexpected tokenizer: ${family}`);
        }
        return new Array<number>(Math.ceil(text.length / per)).fill(1);
    };
    return {
        load: async () => {},
        encode,
        count: async (family, text) => (await encode(family, text)).length,
        dispose: async () => {},
    } as Tokenizers;
}

/** A send's selection as the evaluation reads it. */
export type SendResult = {
    query: string;
    algorithm: FixtureAlgorithm;
    items: MemoryManifestItem[];
    excluded: ExcludedItem[];
    lanes: LaneSpend[];
    /** The memory card's text: the stable and volatile parts under structured memory, the summary card under HypaV3. */
    cardText: string;
    /** The history the prompt keeps raw, after the card. */
    rawTexts: string[];
    gapTokens: number;
    lanesStage: string;
    /** Whether the events lane opened, and why its items were selected (structured memory only, with diagnostics). */
    eventsOpen?: boolean;
    eventReasons?: string[];
    /**
     * `tokenizeChat` calls are the selection's own, and `tokenizeMs` the time at least one of them was in
     * flight (the card counts its lines concurrently, so overlapping calls count once); the HypaV3 side
     * reports none.
     */
    timings: { readMs: number; selectMs: number; tokenizeCalls: number; tokenizeMs: number };
    cacheGets: number;
};

/** The task events a driver saw, and what the chain came to. */
export type RebuildOutcome = { windows: number; tasks: number; events: MemoryTaskEvent[] };
export type SummarizeOutcome = { handOffs: number; stopReason: HypaV3StopReason; events: MemoryTaskEvent[] };

export type Fixture = ReturnType<typeof createFixture>;

/**
 * A fixture over `options.story`: a fresh store with the chat, every service the writer and a send
 * need, and the scripted upstreams. `dispose` closes it all and removes the temp dir.
 */
export function createFixture(options: FixtureOptions) {
    const { story, algorithm } = options;
    const maxContext = options.maxContext ?? 16384;
    const maxResponse = options.maxResponse ?? 400;
    const clock = options.clock ?? { now: 1_000_000 };
    const tokenizers = options.tokenizers ?? createStubTokenizers();
    const family = options.tokenizerFamily ?? "claude";
    const dir = mkdtempSync(path.join(options.dir ?? os.tmpdir(), "risu-memory-eval-"));

    // --- the store, seeded as a server would hold it ---
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
    replace("personas", (personas: Record<string, unknown>[]) => [{ ...personas[0], name: story.names.persona }]);
    replace("presets", (presets: Record<string, unknown>[]) => [{ ...presets[0], maxResponse }]);
    replace("modelProfiles", (profiles: Record<string, unknown>[]) => [
        {
            ...profiles[0],
            modelId: "reverse_proxy",
            forceReplaceUrl: "https://mock.test/v1/chat/completions",
            customProxyRequestModel: "scripted-model",
            customAPIFormat: LLMFormat.OpenAICompatible,
            credentialId: "proxy",
            customTokenizer: family,
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
    replace("memoryTranslateMedia", (section: Record<string, unknown>) => ({
        ...section,
        hypaV3: algorithm === "hypaV3",
        hypav2: false,
        hanuraiEnable: false,
        hypaModel: "ada",
    }));
    replace("hypaV3Presets", (data: { items: { settings: Record<string, unknown> }[] }) => ({
        ...data,
        items: [{ ...data.items[0], settings: { ...data.items[0].settings, ...PINNED_PRESET } }],
    }));
    replace("ui", (data: Record<string, unknown>) => ({ ...data, memoryAlgorithmType: algorithm }));
    store.put(
        kind("characters"),
        CHARACTER_ID,
        {
            chaId: CHARACTER_ID,
            type: "character",
            name: story.names.character,
            firstMessage: story.names.greeting,
            desc: "",
            globalLore: [],
            supaMemory: true,
        },
        null,
    );
    store.applyChanges({
        chats: [
            {
                characterId: CHARACTER_ID,
                chatId: CHAT_ID,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: CHAT_ID,
                            name: story.language,
                            fmIndex: -1,
                            message: storyMessages(story),
                            modelPresetId,
                            promptPresetId: presetId,
                            bindedPersona: personaId,
                        } as unknown as Chat,
                    },
                ],
            },
        ],
    });

    // --- the services ---
    const chat = createScriptedChat({ story, clock });
    const embeddings = createScriptedEmbeddings();
    const tokens = createTokenCounter({ tokenizers });
    const registry = createLlmRequests({
        store,
        kinds,
        tokens,
        vertexTokens: { get: async () => "vertex-token", clear() {} } as never,
        claudeObserver: { register() {}, reset() {}, dispose() {} } as never,
        parentCallback: () => null,
        fetchImpl: chat.fetchImpl,
    });
    const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite"), now: () => clock.now });
    let cacheGets = 0;
    // The real cache, counted: every read goes through it.
    const countedCache: VectorCache = { ...cache, get: (key) => (cacheGets++, cache.get(key)) };
    const hostDeps: MemoryTaskHostDeps = {
        llm: { runInJob: (spec) => registry.runInJob(spec) },
        embeddings: createEmbeddings({
            cache: countedCache,
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
    const gate: MaintenanceGate = {
        active: false,
        assertOpen() {},
        enter() {
            return () => {};
        },
    };
    const service = createMemoryTasks({
        store,
        kinds,
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
    // The server's wiring: a chat write reaches the records, and a deleted chat ends its task.
    store.onChatInvalidated((notice) => service.invalidate(notice));
    store.onMessagesChanged((notice) => reconcileMessageChanges(store, notice));

    const nextEvent = (test: (event: MemoryTaskEvent) => boolean) =>
        new Promise<MemoryTaskEvent>((resolve) => waiters.push({ test, resolve }));
    const nextTerminal = () => nextEvent((event) => TERMINAL.has(event.status.state));

    const chatRef = { chaId: CHARACTER_ID, chatId: CHAT_ID };
    const context = (): GenerationContext => ({
        characterId: CHARACTER_ID,
        chatId: CHAT_ID,
        presetId,
        modelPresetId,
        personaId,
        mode: "normal",
        input: "",
        chatRevision: store.chatRevision(CHARACTER_ID, CHAT_ID) ?? "",
    });
    const jobScope = () => loadJobScope(store, kinds, context());
    const taskBase = (scope: JobScope): MemoryTaskBase => ({
        chatRef,
        epoch: store.epoch(),
        admittedRevision: scope.chatRevision,
        sourceGeneration: scope.chatSourceGeneration ?? 0,
        speakerId: null,
        binding: {
            presetId: scope.promptPreset.id,
            modelPresetId: scope.modelPreset.id,
            personaId: scope.effectivePersona.id,
        },
        effective: { presetId: scope.promptPreset.id, modelPresetId: scope.modelPreset.id, fromChain: false },
        maxContext,
        maxResponse,
        tokenPolicy: memoryTokenPolicy(scope, 0),
        settingsFingerprint: memorySettingsFingerprint(scope),
    });
    const hostOf = (scope: JobScope) =>
        createMemoryTaskHost({
            scope,
            input: taskBase(scope),
            deps: hostDeps,
            signal: new AbortController().signal,
            fence: () => {},
        });

    /**
     * The prompt history of `messages`: the greeting, then one entry per eligible message, each with the
     * source a HypaV3 task validates its windows against (the kind, the message id, and the text's hash).
     */
    const historyOf = (messages: readonly Message[]) => {
        const ms = eligibleHistory(messages).messages;
        const chats: OpenAIChat[] = [
            { role: "assistant", content: story.names.greeting },
            ...ms.map((message): OpenAIChat => ({
                role: message.role === "user" ? "user" : "assistant",
                content: message.data,
                memo: message.chatId,
            })),
        ];
        const sources: MemoryEntrySource[] = [
            { kind: "greeting", fmIndex: -1, textHash: hypaV3SourceHash(story.names.greeting) },
            ...ms.map((message): MemoryEntrySource => ({
                kind: "message",
                id: message.chatId,
                textHash: hypaV3SourceHash(message.data),
            })),
        ];
        return { chats, sources, ms };
    };

    // The stored history's count, once per chat revision: a send tokenizes its dropped entries itself.
    let historyCount: { revision: string | null; tokens: number } | null = null;
    const storedHistoryTokens = async (tokenizer: MemoryTokenizer, chats: readonly OpenAIChat[]) => {
        const revision = store.chatRevision(CHARACTER_ID, CHAT_ID);
        if (!historyCount || historyCount.revision !== revision) {
            let sum = 0;
            for (const entry of chats) {
                sum += await tokenizer.tokenizeChat(entry);
            }
            historyCount = { revision, tokens: sum };
        }
        return historyCount.tokens;
    };

    const fixture = {
        story,
        algorithm,
        dir,
        store,
        kinds,
        service,
        clock,
        chatRef,
        tokenizers,
        maxContext,
        maxResponse,
        /** Every request the chat upstream answered. */
        calls: chat.calls as readonly ScriptedCall[],
        scripted: chat.counts,
        embeddings: embeddings.counts,
        cacheGets: () => cacheGets,
        events,
        jobScope,
        hostOf,

        /** The chat's records as a send reads them. */
        records: (): MemoryRecords => readMemoryRecords(store, CHARACTER_ID, CHAT_ID),

        /** The chat's messages as stored. */
        messages: (): Message[] => (store.readChatSource(CHARACTER_ID, CHAT_ID).data as Chat).message,

        /**
         * Records the whole chat through the real rebuild: one window per turn, chained tasks, the swap.
         * Rejects when the run ends any other way than `rebuilt`.
         */
        async rebuild(): Promise<RebuildOutcome> {
            if (algorithm !== "structuredMemory") {
                throw new Error("Only a structured memory fixture rebuilds");
            }
            const scope = jobScope();
            const records = readRecordSet(store.memory, CHARACTER_ID, CHAT_ID);
            if (!records) {
                throw new Error("The chat has no memory tables");
            }
            const messages = scopeChat(scope)?.message ?? [];
            const plan = rebuildPlan({
                messages,
                events: records.events,
                mode: "rebuild",
                turns: 1,
                screening: writerCadence(scope.db).screening,
            });
            if (plan.length === 0) {
                throw new Error("The chat has no turn to record");
            }
            store.memory.rebuild.begin(
                CHARACTER_ID,
                CHAT_ID,
                { epoch: store.epoch(), mode: "rebuild", plan },
                rebuildSeed("rebuild", records),
            );
            const input: StructuredMemoryTaskInput = {
                ...taskBase(scope),
                kind: "structuredMemory",
                confirmedBefore: plan.at(-1)!.at(-1)!,
                rebuild: true,
            };
            const from = events.length;
            const ended = new Promise<MemoryTaskEvent>((resolve, reject) => {
                waiters.push({
                    test: ({ status }) => {
                        if (!TERMINAL.has(status.state)) {
                            return false;
                        }
                        if (status.state === "done" && status.reason === "rebuildContinues") {
                            return false;
                        }
                        if (status.state === "done" && status.reason === "rebuilt") {
                            return true;
                        }
                        reject(new Error(`The rebuild ended ${status.state}: ${JSON.stringify(status)}`));
                        return true;
                    },
                    resolve,
                });
            });
            const answer = service.rebuild(input);
            if (answer.outcome !== "queued") {
                throw new Error(`The rebuild was refused: ${answer.reason}`);
            }
            await ended;
            await service.drain();
            const seen = events.slice(from);
            return {
                windows: plan.length,
                tasks: seen.filter(({ status }) => TERMINAL.has(status.state)).length,
                events: seen,
            };
        },

        /**
         * Summarizes the chat through HypaV3's real hand-off until the lookahead plan asks for nothing,
         * which is a success when it stopped at its target or the protected tail. Rejects on a failed or
         * skipped task, or on a plan that cannot go on.
         */
        async summarize(): Promise<SummarizeOutcome> {
            if (algorithm !== "hypaV3") {
                throw new Error("Only a HypaV3 fixture summarizes");
            }
            const from = events.length;
            for (let handOffs = 0; ; handOffs++) {
                const scope = jobScope();
                const { host, tokenizer } = hostOf(scope);
                const { chats, sources } = historyOf(scopeChat(scope)?.message ?? []);
                const currentTokens = (await storedHistoryTokens(tokenizer, chats)) + maxResponse;
                const prepared = await prepareHypaV3(
                    host,
                    chats,
                    currentTokens,
                    maxContext,
                    structuredClone(scopeChat(scope)) as Chat,
                    tokenizer,
                    { cleanup: false, responseCorrection: false },
                );
                if (!prepared.ok) {
                    throw new Error(prepared.result.error ?? "HypaV3 preparation failed");
                }
                const plan = await planHypaV3Summaries(prepared.prepared, { lookahead: true });
                if (plan.llmCalls === 0) {
                    if (!PLAN_SETTLED.has(plan.stopReason)) {
                        throw new Error(`The HypaV3 plan stopped: ${plan.stopReason} ${plan.error ?? ""}`);
                    }
                    return { handOffs, stopReason: plan.stopReason, events: events.slice(from) };
                }
                if (handOffs >= 50) {
                    throw new Error("HypaV3 still plans summaries after 50 hand-offs");
                }
                const input: MemoryTaskInput = {
                    ...taskBase(scope),
                    history: chats,
                    sources,
                    historyStart: 0,
                    currentTokens,
                };
                const terminal = nextTerminal();
                service.handOff(input);
                const { status } = await terminal;
                if (status.state !== "done") {
                    throw new Error(`The HypaV3 task ended ${status.state}: ${JSON.stringify(status)}`);
                }
                await service.drain();
            }
        },

        /** Applies a probe's setup to the records or the chat: a retraction, a message edit, a page hidden. */
        applySetup(setup: ProbeSetup): void {
            const epoch = store.epoch();
            const contents = () => store.memory.readContents(CHARACTER_ID, CHAT_ID)!;
            if (setup.kind === "editMessage") {
                store.applyChanges({
                    chats: [
                        {
                            characterId: CHARACTER_ID,
                            chatId: CHAT_ID,
                            baseRevision: store.chatRevision(CHARACTER_ID, CHAT_ID)!,
                            ops: [{ op: "setText", id: setup.messageId, text: setup.text }],
                        },
                    ],
                });
                return;
            }
            const resolved = resolveLabel(setup.label, fixture.records());
            if (setup.kind === "retract") {
                const stored = store.memory.readRecord(CHARACTER_ID, CHAT_ID, "events", resolved.id);
                if (!stored) {
                    throw new Error(`No event ${resolved.id} to retract`);
                }
                const edited = applyEventRepair(
                    stored.data,
                    { kind: "event", eventId: resolved.id, repair: "retract" },
                    fixture.messages(),
                    messageSourceHash,
                );
                if (edited) {
                    store.memory.write(
                        CHARACTER_ID,
                        CHAT_ID,
                        { epoch, baseRevision: contents().revision },
                        withRetractedEvidence(store, chatRef, { events: [edited] }),
                    );
                }
                return;
            }
            const stored = store.memory.readRecord(CHARACTER_ID, CHAT_ID, "pages", resolved.id);
            if (!stored) {
                throw new Error(`No page ${resolved.id} to hide`);
            }
            const edited = applyPageEdit(
                stored.data,
                { kind: "page", pageId: resolved.id, contextMode: "never" },
                { now: clock.now, newId: randomUUID },
            );
            if (edited) {
                store.memory.write(
                    CHARACTER_ID,
                    CHAT_ID,
                    { epoch, baseRevision: contents().revision },
                    { pages: [edited] },
                );
            }
        },

        /**
         * A send over the stored chat plus `query` as a new user message. `diagnostics` runs retrieval a
         * second time to log whether the events lane opened and why; off for a timing.
         */
        async send(query: string, sendOptions: { diagnostics?: boolean } = {}): Promise<SendResult> {
            const scope = jobScope();
            const { host, tokenizer } = hostOf(scope);
            const stored = scopeChat(scope)!;
            const probe: Message = { chatId: PROBE_MESSAGE_ID, role: "user", data: query };
            const messages = [...stored.message, probe];
            const { chats, ms } = historyOf(messages);
            const currentTokens =
                (await storedHistoryTokens(tokenizer, chats.slice(0, -1))) +
                (await tokenizer.tokenizeChat(chats.at(-1)!)) +
                maxResponse;
            const { settings } = getCurrentHypaV3Preset(host);
            const getsBefore = cacheGets;
            if (algorithm === "hypaV3") {
                const started = performance.now();
                const prepared = await prepareHypaV3(
                    host,
                    chats,
                    currentTokens,
                    maxContext,
                    structuredClone(stored),
                    tokenizer,
                    {
                        responseCorrection: false,
                        deferStored: true,
                    },
                );
                if (!prepared.ok) {
                    throw new Error(prepared.result.error ?? "HypaV3 preparation failed");
                }
                const selection = await selectHypaV3(host, prepared.prepared, emptyHypaV3Execution(prepared.prepared), {
                    trimUncovered: { tooMuchToken: "too much" },
                });
                if (selection.error) {
                    throw new Error(selection.error);
                }
                const card = selection.chats.filter(({ memo }) => memo === "supaMemory");
                return {
                    query,
                    algorithm,
                    items: [],
                    excluded: [],
                    lanes: [],
                    cardText: card.map(({ content }) => content).join("\n\n"),
                    rawTexts: selection.chats.filter(({ memo }) => memo !== "supaMemory").map(({ content }) => content),
                    gapTokens: selection.trim?.gap.tokens ?? 0,
                    lanesStage: "",
                    timings: { readMs: 0, selectMs: performance.now() - started, tokenizeCalls: 0, tokenizeMs: 0 },
                    cacheGets: cacheGets - getsBefore,
                };
            }
            const entries = readEntries(chats, ms);
            // The job's tokenizer as it is, with each call counted and the time any call is in flight added
            // up once, since the card counts its lines concurrently.
            let tokenizeCalls = 0;
            let tokenizeMs = 0;
            let inFlight = 0;
            let busySince = 0;
            const counted: MemoryTokenizer = {
                tokenizeChat: async (entry) => {
                    tokenizeCalls++;
                    if (inFlight++ === 0) {
                        busySince = performance.now();
                    }
                    try {
                        return await tokenizer.tokenizeChat(entry);
                    } finally {
                        if (--inFlight === 0) {
                            tokenizeMs += performance.now() - busySince;
                        }
                    }
                },
            };
            const readStart = performance.now();
            const records = readMemoryRecords(store, CHARACTER_ID, CHAT_ID);
            const readMs = performance.now() - readStart;
            const selectStart = performance.now();
            const selected = await selectMemory(
                {
                    host,
                    settings,
                    tokenizer: counted,
                    chats,
                    historyStart: 0,
                    entries,
                    messages,
                    currentTokens,
                    maxContextTokens: maxContext,
                    continueMessageId: undefined,
                    tooMuchToken: "too much",
                },
                records,
            );
            const selectMs = performance.now() - selectStart;
            if (selected.type !== "selected") {
                throw new Error(`The send did not select: ${selected.error}`);
            }
            const result: SendResult = {
                query,
                algorithm,
                items: selected.items,
                excluded: selected.excluded,
                lanes: selected.lanes,
                cardText: [
                    ...selected.chats.filter(({ memo }) => memo === "supaMemory"),
                    ...(selected.volatile ? [selected.volatile] : []),
                ]
                    .map(({ content }) => content)
                    .join("\n\n"),
                rawTexts: selected.protectedEntries.map(({ content }) => content),
                gapTokens: selected.gapTokens,
                lanesStage: selected.lanesStage,
                timings: { readMs, selectMs, tokenizeCalls, tokenizeMs },
                cacheGets: cacheGets - getsBefore,
            };
            if (sendOptions.diagnostics) {
                const structured = normalizeStructuredMemorySettings(settings.structured);
                const reconciled = reconcileEvents(records.events, messages);
                const retrieved = await retrieveLanes(host, {
                    events: reconciled,
                    threads: records.threads,
                    pages: records.pages,
                    entries,
                    window: rawWindow(entries, {
                        windowTurns: structured.windowTurns,
                        covered: coveredMessages(reconciled),
                    }),
                    stage: records.stage,
                    settings: structured,
                });
                result.eventsOpen = retrieved.eventsOpen;
                result.eventReasons = [
                    ...new Set(
                        retrieved.lanes.find(({ lane }) => lane === "events")?.items.map(({ reason }) => reason) ?? [],
                    ),
                ];
            }
            return result;
        },

        /** The writer task's two planning reads, timed: not part of a send. */
        timePlanningReads(): { rerecordMs: number; recordedMs: number } {
            const a = performance.now();
            readRerecordEvents(store, CHARACTER_ID, CHAT_ID);
            const b = performance.now();
            readRecordedMessages(store, CHARACTER_ID, CHAT_ID);
            const c = performance.now();
            return { rerecordMs: b - a, recordedMs: c - b };
        },

        /** The texts a send's events lane embeds: every eligible event's summary and key lines. */
        eventTexts(): string[] {
            const texts = new Set<string>();
            for (const event of fixture.records().events as MemoryEvent[]) {
                for (const text of [event.summary, ...event.keyLines.map(({ text }) => text)]) {
                    if (text.trim() !== "") {
                        texts.add(text.trim());
                    }
                }
            }
            return [...texts];
        },

        /** A fresh processor over the fixture's embeddings, for a cache or `addText` timing. */
        processor(): HypaProcesser {
            const scope = jobScope();
            const { host } = hostOf(scope);
            return new HypaProcesser(host.embeddings, host.db.hypaModel);
        },

        /** One checkpoint save through the real transaction, timed; `name` keeps the saves apart. */
        checkpointSave(name: string): number {
            const started = performance.now();
            store.applyChanges(
                {},
                { inTransaction: { before: (tx) => void tx.save(CHARACTER_ID, CHAT_ID, name, "auto") } },
            );
            return performance.now() - started;
        },

        async dispose(): Promise<void> {
            service.beginShutdown();
            await service.drain();
            await registry.dispose();
            cache.close();
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
    return fixture;
}

/**
 * Runs `work` with `HypaProcesser.prototype.addText` timed, and answers the milliseconds it spent. The
 * method still runs as it is; only its duration is added up, which is how a send's nested embedding
 * work is shown as "of which".
 */
export async function timeAddText<T>(work: () => Promise<T>): Promise<{ result: T; addTextMs: number }> {
    const original = HypaProcesser.prototype.addText;
    let addTextMs = 0;
    HypaProcesser.prototype.addText = async function (this: HypaProcesser, texts: string[]) {
        const started = performance.now();
        try {
            return await original.call(this, texts);
        } finally {
            addTextMs += performance.now() - started;
        }
    };
    try {
        return { result: await work(), addTextMs };
    } finally {
        HypaProcesser.prototype.addText = original;
    }
}

/**
 * Runs `work` with a `setImmediate` tick running beside it, and answers the longest gap between two
 * ticks, in milliseconds: how long the thread was held without reaching the macrotask queue during the
 * work. A chain of promises that never leaves the microtask queue shows as one gap as long as itself.
 */
export async function longestStall<T>(work: () => Promise<T>): Promise<{ result: T; stallMs: number }> {
    let running = true;
    let last = performance.now();
    let longest = 0;
    const ticked = new Promise<void>((resolve) => {
        const tick = () => {
            const now = performance.now();
            longest = Math.max(longest, now - last);
            last = now;
            if (running) {
                setImmediate(tick);
            } else {
                resolve();
            }
        };
        setImmediate(tick);
    });
    try {
        const result = await work();
        // The tick after the work closes the last gap, which is the whole work when it never yielded.
        running = false;
        await ticked;
        return { result, stallMs: longest };
    } finally {
        running = false;
    }
}

/** The chat file the app imports (`risuChat`, version 2); the app gives the chat a new id on import. */
export function storyChatFile(story: Story): Record<string, unknown> {
    return {
        type: "risuChat",
        ver: 2,
        data: {
            id: `eval-${story.language}-${story.turns.length}`,
            name: `Structured memory evaluation (${story.language}, ${story.turns.length} turns)`,
            message: storyMessages(story),
            note: "",
            localLore: [],
            fmIndex: -1,
        },
        folders: [],
    };
}

/** The export's probes with the rubric a person grades by. */
export function storyProbesFile(story: Story): Record<string, unknown> {
    return {
        language: story.language,
        turns: story.turns.length,
        seed: story.seed,
        character: story.names.character,
        persona: story.names.persona,
        greeting: story.names.greeting,
        finalStage: story.finalStage,
        rubric: [
            "Import the chat into a character named as above, with the greeting as its first message, once per algorithm, each from the same baseline.",
            "Let each algorithm build its own memory with the real model: wait for the writer or the summaries to settle before the first probe.",
            "Send each probe from a fresh branch of the imported chat, never one after another in one branch.",
            "needed: the reply states the record's facts (who, what, where); a denial or an unrelated answer fails.",
            "mustNotLeak: the reply does not state the retracted or edited event, or the hidden page's facts; a reply that says it does not know passes.",
            "knowledge: the reply has the on-stage character act without the secret; stating the fact as something they know fails.",
            "comparison: both events are stated; one of two fails.",
            "unanswerable: the reply says it does not know or asks; a confident invented answer fails.",
            "Record the model, the embedding model, and the token use of each arm beside the grades.",
        ],
        probes: story.probes.map((probe) => ({
            ...probe,
            ...(probe.setup ? { setup: { ...probe.setup, target: setupTarget(story, probe.setup) } } : {}),
        })),
    };
}

/**
 * What a probe's setup means in terms a person finds in the app: the turn, its event's title, and the
 * reply's message id for an event, or the page's title for a page.
 */
function setupTarget(story: Story, setup: ProbeSetup): Record<string, string | number> {
    if (setup.kind === "never") {
        return { page: setup.label.slice("page:".length) };
    }
    const turn =
        setup.kind === "retract"
            ? Number(setup.label.slice("event:".length))
            : (turnOfMessageId(setup.messageId) ?? NaN);
    const entry = story.turns[turn - 1];
    if (!entry) {
        throw new Error(`A setup names no turn of the story: ${JSON.stringify(setup)}`);
    }
    return { turn, eventTitle: entry.analysis.title, messageId: entry.charId };
}
