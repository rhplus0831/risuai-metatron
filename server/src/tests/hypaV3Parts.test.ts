// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../../shared/database.ts";
import { createHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import {
    mergeHypaV3SelectionWrite,
    mergeHypaV3Write,
    type SerializableHypaV3Data,
    type SerializableSummary,
} from "../../../shared/memory.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type { CachedVector, VectorCache } from "../data/vectorCache.ts";
import type { requestDataResponse } from "../llm/request.ts";
import { createEmbeddings } from "../prompt/embeddings.ts";
import type { MemoryHost, MemoryTokenizer } from "../prompt/memory/host.ts";
import {
    createHypaV3SourceValidator,
    emptyHypaV3Execution,
    executeHypaV3Plan,
    HYPAV3_LOOKAHEAD_HEADROOM,
    hypaV3SourceHash,
    type HypaV3Checkpoint,
    type HypaV3CurrentSource,
    type HypaV3EntrySource,
    type HypaV3ExecutionHooks,
    type HypaV3ExecutionResult,
    type HypaV3Plan,
    type HypaV3PlannedWindow,
    type HypaV3Prepared,
    type HypaV3PrepareOptions,
    type HypaV3Result,
    hypaMemoryV3,
    planHypaV3Summaries,
    prepareHypaV3,
    selectHypaV3,
    warmHypaV3Vectors,
} from "../prompt/memory/hypav3.ts";
import { runRegexOp } from "../scripts/worker.ts";
import {
    countTokens,
    createWorld,
    defaultCurrentTokens,
    makeChats,
    normalize,
    type Outcome,
    type Scenario,
    scenarios,
    tokenizeChat,
    TOO_MUCH_TOKEN,
    USER_NAME,
} from "./fixtures/memory/scenarios.ts";

// The HypaV3 parts (`prepareHypaV3`, `planHypaV3Summaries`, `executeHypaV3Plan`, `selectHypaV3`)
// called directly over the fixture world of `memoryAlgorithms.test.ts`, which holds `hypaMemoryV3`
// (their composition) to the browser-captured fixture. Here: the plan's summary windows are exactly
// the executor's history-summary requests (the standard main's similarity-correction request is a
// selection request), the composition of the parts gives the fixture's result, and each main's error
// position: standard executes the windows before a failed or exhausted one and reports the count
// before the failure; experimental subtracts every planned window before its batch, reports planning
// exhaustion before any request, and keeps only the consecutive successes. Beyond the fixture: a
// window with nothing to summarize, an out-of-order batch under concurrency, the prepared state and
// the execution staying unchanged by the later parts, the stored value's snapshot, and the count
// subtracted one window at a time.
//
// The options and hooks the composition never passes (the later sections, on a flat tokenizer so the
// counts read off the message counts): an execution with hooks saves each summary through a
// checkpoint whose baseline is the last committed candidate (edits saved between checkpoints and a
// task's append survive to the final selection write), skips, stops, validates the accepted prefix
// before every save (a token-only window or a committed window's trailing entry changed meanwhile
// ends it), keeps only experimental's consecutive prefix, never ends `complete` after an abort, and
// lets a hook's exception through; the source validator's rules; the selection that trims the
// uncovered history and reports the gap; the prepare without cleanup and `coverageAhead`; lookahead
// planning; and warming the summaries' vectors.

const FIXTURE = path.join(import.meta.dirname, "fixtures/memory/algorithms.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Record<string, Outcome> };

type World = ReturnType<typeof createWorld>;

/** The world's vector store as the server's cache (vectors only, as the server stores them). */
function worldCache(world: World): VectorCache {
    return {
        get: (key) => world.cache.get(key) as CachedVector | null,
        set: (key, vector) => world.cache.set(key, vector),
        generation: () => 0,
        sync: () => {},
        clear: () => {},
        close: () => {},
        stats: () => ({ bytes: 0, rows: 0 }),
    };
}

type HostOptions = {
    /** Holds each summary answer (by request index) until the test releases it. */
    hold?: (index: number) => Promise<void>;
};

function hostOf(scenario: Scenario, world: World, options: HostOptions = {}): MemoryHost {
    const before = (scenario.presetsBefore ?? []).map((settings, i) => createHypaV3Preset(`Before ${i}`, settings));
    const selected = createHypaV3Preset("Selected", scenario.preset ?? {});
    Object.assign(world.db, { hypaV3Presets: [...before, selected], hypaV3PresetId: selected.id });
    const signal = new AbortController().signal;
    const embeddings = createEmbeddings({
        cache: worldCache(world),
        transformers: {
            runEmbedding: (texts, model) => world.embed(texts, model),
            runSummarizer: async () => "",
            runImageCaption: async () => "",
            runTextGeneration: async () => "",
            dispose: async () => {},
        },
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
            const answer = await world.http(String(url), JSON.parse(String(init?.body ?? "null")));
            return new Response(JSON.stringify(answer.data), { status: answer.status });
        }) as typeof fetch,
    }).forJob({ db: world.db as never, supaMemoryKey: "memory-key", signal });
    let requests = 0;
    return {
        db: world.db as unknown as Database,
        tokenize: async (text) => countTokens(text),
        request: async (formated) => {
            const index = requests++;
            const answer = (await world.request(formated)) as requestDataResponse;
            await options.hold?.(index);
            return answer;
        },
        completions: (body) => world.completions(body),
        summarizer: (text) => world.summarizer(text),
        embeddings,
        regex: async (op) => runRegexOp(op),
        parseChatML: () => null,
        userName: () => USER_NAME,
        progress: (payload) => world.progress(payload),
        random: () => world.random(),
        redact: (text) => text,
        fence: () => {},
        signal,
    };
}

type Run = {
    world: World;
    host: MemoryHost;
    chats: OpenAIChat[];
    prepared: HypaV3Prepared;
    plan: HypaV3Plan;
    execution: HypaV3ExecutionResult;
    /** The `memory` requests made while the plan ran. */
    executeRequests: number;
};

/** Prepares, plans, and executes a scenario through the parts; the scenario must pass the settings check. */
async function runParts(scenario: Scenario, options: HostOptions = {}): Promise<Run> {
    const world = createWorld(scenario);
    const host = hostOf(scenario, world, options);
    const chats = structuredClone(scenario.chats);
    const currentTokens = scenario.currentTokens ?? (await defaultCurrentTokens(chats));
    const room = structuredClone(scenario.room) as never;
    const outcome = await prepareHypaV3(host, chats, currentTokens, scenario.maxContextTokens, room, {
        tokenizeChat,
    });
    if (!outcome.ok) {
        throw new Error(outcome.result.error);
    }
    const prepared = outcome.prepared;
    const plan = await planHypaV3Summaries(prepared);
    expect(world.log.requests).toHaveLength(0);
    const execution = await executeHypaV3Plan(host, prepared, plan);
    return { world, host, chats, prepared, plan, execution, executeRequests: world.log.requests.length };
}

/** `hypaMemoryV3` on a fresh world, as `memoryAlgorithms.test.ts` runs it. */
async function runComposed(scenario: Scenario): Promise<{ result: HypaV3Result; world: World }> {
    const world = createWorld(scenario);
    const host = hostOf(scenario, world);
    const chats = structuredClone(scenario.chats);
    const currentTokens = scenario.currentTokens ?? (await defaultCurrentTokens(chats));
    const result = await hypaMemoryV3(
        host,
        chats,
        currentTokens,
        scenario.maxContextTokens,
        structuredClone(scenario.room) as never,
        { ...scenario.char } as never,
        { tokenizeChat },
    );
    return { result, world };
}

const scenarioNamed = (name: string): Scenario => {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) {
        throw new Error(`no scenario ${name}`);
    }
    return scenario;
};

const EXPERIMENTAL_PRESET = {
    useExperimentalImpl: true,
    summarizationRequestsPerMinute: 1000,
    summarizationMaxConcurrent: 1,
    embeddingRequestsPerMinute: 1000,
    embeddingMaxConcurrent: 1,
};

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("the parts over the fixture scenarios", () => {
    const v3Scenarios = scenarios.filter((scenario) => scenario.algorithm === "v3" || scenario.algorithm === "v3exp");
    const succeeded = v3Scenarios.filter((scenario) => {
        const outcome = fixture.cases[scenario.name];
        return outcome.thrown === undefined && (outcome.result as { error?: string }).error === undefined;
    });

    it("covers the successful V3 scenarios and the two partial failures", () => {
        expect(succeeded.length).toBeGreaterThanOrEqual(10);
        expect(v3Scenarios.map((scenario) => scenario.name)).toEqual(
            expect.arrayContaining(["v3-partial-then-failure", "v3exp-batch-partial-failure"]),
        );
    });

    for (const scenario of succeeded) {
        it(`${scenario.name}: the plan's summary windows are the executor's requests, and the parts give the browser's result`, async () => {
            const { world, host, prepared, plan, execution, executeRequests } = await runParts(scenario);
            expect(plan.error).toBeUndefined();
            expect(plan.windows.filter((window) => window.needsLlm)).toHaveLength(plan.llmCalls);
            expect(executeRequests).toBe(plan.llmCalls);
            expect(execution.endReason).toBe("complete");
            expect(execution.accepted).toBe(plan.windows.length);
            expect(execution.completed).toHaveLength(plan.windows.length);
            expect(execution.currentTokens).toBe(plan.predictedTokens);

            const result = await selectHypaV3(host, prepared, execution);
            // The standard main's similarity correction summarizes the recent chats as one more query.
            const correctionRequests = scenario.name === "v3-similarity-correction" ? 1 : 0;
            expect(world.log.requests).toHaveLength(plan.llmCalls + correctionRequests);
            expect(normalize(result)).toEqual(fixture.cases[scenario.name].result);
        });
    }

    it("v3-partial-then-failure: the standard executor requests the windows up to the failed one and reports the count before it", async () => {
        const scenario = scenarioNamed("v3-partial-then-failure");
        const { prepared, plan, execution, executeRequests } = await runParts(scenario);
        // Two windows planned, the second's summary fails: nothing is planned past it, so the executed
        // prefix is the first window and the requests end with the failed one.
        expect(plan.windows.map((window) => [window.scanStart, window.scanEnd])).toEqual([
            [0, 3],
            [3, 6],
        ]);
        expect(plan.llmCalls).toBe(2);
        expect(executeRequests).toBe(2);
        expect(execution.endReason).toBe("providerFailed");
        if (execution.endReason !== "providerFailed") throw new Error("unreachable");
        expect(execution.failedWindow).toBe(1);
        expect(execution.error).toBe("[HypaV3] Summarization failed: Error: the summary model is down");
        expect(execution.accepted).toBe(1);
        expect(execution.completed.map((executed) => executed.window)).toEqual([plan.windows[0]]);
        expect(execution.cursor).toBe(plan.windows[0].scanEnd);
        expect(execution.data.summaries.map((summary) => summary.text)).toEqual(["First summary landed."]);
        // The failed window's tokens are not subtracted: the count the main returned.
        expect(execution.currentTokens).toBe(prepared.ledger.current - plan.windows[0].removedTokens);
        expect(execution.currentTokens).toBe(472);
        expect(execution.currentTokens).not.toBe(plan.predictedTokens);

        const { result, world } = await runComposed(scenario);
        expect(result.currentTokens).toBe(472);
        expect(result.error).toBe(execution.error);
        expect(result.memory?.summaries).toHaveLength(1);
        expect(world.log.requests).toHaveLength(2);
    });

    it("v3exp-batch-partial-failure: the experimental executor keeps the successes before the failed window, the batch ends there, and the count is the plan's", async () => {
        const scenario = scenarioNamed("v3exp-batch-partial-failure");
        const { plan, execution, executeRequests } = await runParts(scenario);
        // Two windows planned (the scenario's third answer is never needed); one task at a time, so
        // the batch requests both and the failure is the second.
        expect(plan.windows.map((window) => [window.scanStart, window.scanEnd])).toEqual([
            [0, 3],
            [3, 6],
        ]);
        expect(plan.llmCalls).toBe(2);
        expect(executeRequests).toBe(2);
        expect(execution.endReason).toBe("providerFailed");
        if (execution.endReason !== "providerFailed") throw new Error("unreachable");
        expect(execution.failedWindow).toBe(1);
        expect(execution.accepted).toBe(1);
        expect(execution.completed.map((executed) => executed.window)).toEqual([plan.windows[0]]);
        expect(execution.data.summaries.map((summary) => summary.text)).toEqual(["Batch summary one."]);
        // Every planned window was subtracted before the batch ran: the main returned the plan's count.
        expect(plan.predictedTokens).toBe(389);
        expect(execution.currentTokens).not.toBe(plan.predictedTokens);

        const { result, world } = await runComposed(scenario);
        expect(result.currentTokens).toBe(389);
        expect(result.error).toBe(execution.error);
        expect(result.memory?.summaries).toHaveLength(1);
        expect(world.log.requests).toHaveLength(2);
    });
});

describe("beyond the fixture", () => {
    // Ten messages, three per summary, a four-message tail: after two windows the tail is left and the
    // prompt is still over the context, so the plan ends with the "cannot summarize further" error.
    const exhaustion: Scenario = {
        name: "v3-exhausted-after-windows",
        algorithm: "v3",
        preset: { maxChatsPerSummary: 3, queryChatCount: 4, memoryTokensRatio: 0.1 },
        chats: makeChats(10),
        room: {},
        char: { type: "character", name: "Mira" },
        maxContextTokens: 80,
    };

    it("standard reports planning exhaustion after summarizing the windows before it; experimental before any request", async () => {
        const standard = await runParts(exhaustion);
        expect(standard.plan.stopReason).toBe("cannotSummarizeFurther");
        expect(standard.plan.error).toMatch(/^\[HypaV3\] Cannot summarize further: /);
        expect(standard.plan.windows).toHaveLength(2);
        expect(standard.plan.llmCalls).toBe(2);
        expect(standard.executeRequests).toBe(2);
        expect(standard.execution.endReason).toBe("complete");
        expect(standard.execution.accepted).toBe(2);

        const composedStandard = await runComposed(exhaustion);
        expect(composedStandard.result.error).toBe(standard.plan.error);
        expect(composedStandard.result.currentTokens).toBe(standard.plan.predictedTokens);
        expect(composedStandard.result.memory?.summaries).toHaveLength(2);
        expect(composedStandard.result.chats).toEqual(exhaustion.chats);
        expect(composedStandard.world.log.requests).toHaveLength(2);

        const experimentalScenario: Scenario = {
            ...exhaustion,
            name: "v3exp-exhausted-after-windows",
            algorithm: "v3exp",
            preset: { ...exhaustion.preset, ...EXPERIMENTAL_PRESET },
        };
        const experimental = await runParts(experimentalScenario);
        expect(experimental.plan.stopReason).toBe("cannotSummarizeFurther");
        expect(experimental.plan.windows).toHaveLength(2);

        const composedExperimental = await runComposed(experimentalScenario);
        expect(composedExperimental.result.error).toBe(experimental.plan.error);
        expect(composedExperimental.result.currentTokens).toBe(experimental.plan.predictedTokens);
        expect(composedExperimental.result.memory?.summaries).toHaveLength(0);
        expect(composedExperimental.result.chats).toEqual(exhaustion.chats);
        expect(composedExperimental.world.log.requests).toHaveLength(0);
    });

    it("standard: a window with nothing to summarize makes no request, moves the cursor, and keeps every scanned id", async () => {
        // The first window scans a blank greeting without a memo and three user messages, which
        // `doNotSummarizeUserMessage` keeps out of the summary: nothing to request for it.
        const scenario: Scenario = {
            name: "v3-token-only-window",
            algorithm: "v3",
            preset: { doNotSummarizeUserMessage: true, maxChatsPerSummary: 4, queryChatCount: 3 },
            chats: [
                { role: "system", content: "" },
                ...[0, 1, 2].map((i) => ({
                    role: "user" as const,
                    content: `Opening ${i}: river lantern.`,
                    memo: `u${i}`,
                })),
                ...makeChats(12),
            ],
            room: {},
            char: { type: "character", name: "Mira" },
            maxContextTokens: 220,
        };
        const { world, host, prepared, plan, execution, executeRequests } = await runParts(scenario);
        expect(plan.error).toBeUndefined();
        expect(plan.windows.length).toBeGreaterThanOrEqual(2);
        const [first, ...rest] = plan.windows;
        expect(first.needsLlm).toBe(false);
        expect(first.included).toEqual([]);
        expect(first.includedMemos).toEqual([]);
        expect(first.scannedIds).toEqual([undefined, "u0", "u1", "u2"]);
        expect(first.scanEnd).toBe(4);
        expect(first.removedTokens).toBe(3 + 3 * (await tokenizeChat(scenario.chats[1])));
        expect(rest.every((window) => window.needsLlm)).toBe(true);
        expect(plan.llmCalls).toBe(rest.length);
        expect(executeRequests).toBe(rest.length);

        expect(execution.endReason).toBe("complete");
        expect(execution.accepted).toBe(plan.windows.length);
        expect(execution.completed[0].summary).toBeUndefined();
        expect(execution.data.summaries).toHaveLength(rest.length);
        expect(execution.data.summaries[0].chatMemos).toEqual(new Set(rest[0].includedMemos));
        expect(execution.cursor).toBe(plan.windows.at(-1)!.scanEnd);
        expect(execution.currentTokens).toBe(
            prepared.ledger.current - first.removedTokens - rest.reduce((sum, window) => sum + window.removedTokens, 0),
        );

        const result = await selectHypaV3(host, prepared, execution);
        expect(result.error).toBeUndefined();
        expect(result.chats[0].memo).toBe("supaMemory");
        expect(result.chats.slice(1)).toEqual(scenario.chats.slice(execution.cursor));
        expect(world.log.requests).toHaveLength(rest.length);
    });

    it("experimental: a last window with nothing to summarize is accepted without a request and moves the cursor past it", async () => {
        // The experimental scan grows a window until it has `maxChatsPerSummary` messages to summarize or
        // reaches the protected tail: two user messages before the tail make a window without a request.
        const scenario: Scenario = {
            name: "v3exp-token-only-tail-window",
            algorithm: "v3exp",
            preset: {
                ...EXPERIMENTAL_PRESET,
                doNotSummarizeUserMessage: true,
                maxChatsPerSummary: 2,
                queryChatCount: 3,
            },
            chats: [
                ...makeChats(4),
                ...[0, 1].map((i) => ({ role: "user" as const, content: `Aside ${i}: copper meadow.`, memo: `x${i}` })),
                ...makeChats(3).map((chat, i) => ({ ...chat, memo: `t${i}` })),
            ],
            room: {},
            char: { type: "character", name: "Mira" },
            maxContextTokens: 80,
        };
        const { world, host, prepared, plan, execution, executeRequests } = await runParts(scenario);
        expect(plan.error).toBeUndefined();
        expect(plan.windows.map((window) => [window.scanStart, window.scanEnd, window.needsLlm])).toEqual([
            [0, 4, true],
            [4, 6, false],
        ]);
        expect(plan.windows[0].includedMemos).toEqual(["m1", "m3"]);
        expect(plan.windows[1].scannedIds).toEqual(["x0", "x1"]);
        expect(plan.llmCalls).toBe(1);
        expect(executeRequests).toBe(1);
        expect(execution.endReason).toBe("complete");
        expect(execution.accepted).toBe(2);
        expect(execution.completed.map((executed) => executed.summary?.text)).toEqual([
            "Summary 1: the events so far, in short.\n\nDetail 1.",
            undefined,
        ]);
        expect(execution.cursor).toBe(6);
        expect(execution.currentTokens).toBe(plan.predictedTokens);

        const result = await selectHypaV3(host, prepared, execution);
        expect(result.error).toBeUndefined();
        expect(result.chats.slice(1)).toEqual(scenario.chats.slice(6));
        expect(world.log.requests).toHaveLength(1);
    });

    it("experimental: a success answered before an earlier window's failure is listed but not accepted", async () => {
        // A smaller context plans three windows, summarized at once; the answers arrive third, first,
        // then the failing second.
        const scenario: Scenario = {
            ...scenarioNamed("v3exp-batch-partial-failure"),
            name: "v3exp-out-of-order-batch",
            preset: { ...scenarioNamed("v3exp-batch-partial-failure").preset, summarizationMaxConcurrent: 3 },
            maxContextTokens: 320,
            summaries: ["Batch summary one.", { fail: "the summary model is down" }, "Batch summary three."],
        };
        const releases = new Map<number, () => void>();
        let started: () => void = () => {};
        const allStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        const hold = (index: number) =>
            new Promise<void>((resolve) => {
                releases.set(index, resolve);
                if (releases.size === 3) {
                    started();
                }
            });
        const world = createWorld(scenario);
        const host = hostOf(scenario, world, { hold });
        const chats = structuredClone(scenario.chats);
        const outcome = await prepareHypaV3(
            host,
            chats,
            await defaultCurrentTokens(chats),
            scenario.maxContextTokens,
            {} as never,
            {
                tokenizeChat,
            },
        );
        if (!outcome.ok) throw new Error(outcome.result.error);
        const plan = await planHypaV3Summaries(outcome.prepared);
        expect(plan.llmCalls).toBe(3);

        const running = executeHypaV3Plan(host, outcome.prepared, plan);
        await allStarted;
        expect(world.log.requests).toHaveLength(3);
        for (const index of [2, 0, 1]) {
            releases.get(index)!();
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const execution = await running;

        expect(execution.endReason).toBe("providerFailed");
        if (execution.endReason !== "providerFailed") throw new Error("unreachable");
        expect(execution.failedWindow).toBe(1);
        expect(execution.error).toBe("[HypaV3] Summarization failed: Error: the summary model is down");
        expect(execution.completed.map((executed) => executed.summary?.text)).toEqual([
            "Batch summary one.",
            "Batch summary three.",
        ]);
        expect(execution.completed.map((executed) => executed.window)).toEqual([plan.windows[0], plan.windows[2]]);
        expect(execution.accepted).toBe(1);
        expect(execution.cursor).toBe(plan.windows[0].scanEnd);
        expect(execution.data.summaries.map((summary) => summary.text)).toEqual(["Batch summary one."]);
        // The closing progress notice follows the batch.
        expect(world.log.progress.at(-1)).toEqual({ open: false, miniMsg: "", msg: "", subMsg: "" });
    });

    it("the later parts leave the prepared state and the execution unchanged, and selecting twice gives the same result", async () => {
        const scenario: Scenario = {
            ...scenarioNamed("v3-existing-then-summarize"),
            name: "v3-select-twice",
            // No random share: the second selection draws nothing from the random source.
            preset: {
                ...scenarioNamed("v3-existing-then-summarize").preset,
                recentMemoryRatio: 0.5,
                similarMemoryRatio: 0.5,
            },
        };
        const world = createWorld(scenario);
        const host = hostOf(scenario, world);
        const chats = structuredClone(scenario.chats);
        const room = structuredClone(scenario.room) as never;
        const outcome = await prepareHypaV3(
            host,
            chats,
            await defaultCurrentTokens(chats),
            scenario.maxContextTokens,
            room,
            {
                tokenizeChat,
            },
        );
        if (!outcome.ok) throw new Error(outcome.result.error);
        const prepared = outcome.prepared;
        const before = structuredClone({
            chats: prepared.chats,
            data: prepared.data,
            startIdx: prepared.startIdx,
            ledger: prepared.ledger,
            snapshot: prepared.snapshot,
            settings: prepared.settings,
        });
        const storedMetrics = structuredClone(prepared.data.metrics);
        expect(storedMetrics).toBeDefined();

        const plan = await planHypaV3Summaries(prepared);
        expect(plan.llmCalls).toBeGreaterThan(0);
        const execution = await executeHypaV3Plan(host, prepared, plan);
        expect(execution.endReason).toBe("complete");
        expect(execution.data.summaries.length).toBe(prepared.data.summaries.length + plan.llmCalls);
        const executionBefore = structuredClone({
            completed: execution.completed,
            accepted: execution.accepted,
            tokenDelta: execution.tokenDelta,
            currentTokens: execution.currentTokens,
            cursor: execution.cursor,
            data: execution.data,
        });

        const first = await selectHypaV3(host, prepared, execution);
        const second = await selectHypaV3(host, prepared, execution);
        expect(first.error).toBeUndefined();
        expect(first.memory?.metrics).toBeDefined();
        expect(first.memory?.metrics).not.toEqual(storedMetrics);
        expect(normalize(second)).toEqual(normalize(first));

        expect(prepared.chats).toEqual(before.chats);
        expect(prepared.data).toEqual(before.data);
        expect(prepared.data.metrics).toEqual(storedMetrics);
        expect(prepared.startIdx).toBe(before.startIdx);
        expect(prepared.ledger).toEqual(before.ledger);
        expect(prepared.snapshot).toEqual(before.snapshot);
        expect(prepared.settings).toEqual(before.settings);
        expect({
            completed: execution.completed,
            accepted: execution.accepted,
            tokenDelta: execution.tokenDelta,
            currentTokens: execution.currentTokens,
            cursor: execution.cursor,
            data: execution.data,
        }).toEqual(executionBefore);
        expect(execution.data.metrics).toEqual(storedMetrics);
    });

    it("the snapshot is the stored value as read, before the orphan cleanup; a stored null stays null", async () => {
        const base = scenarioNamed("v3-existing-selection");
        const stored = structuredClone(base.room.hypaV3Data) as { summaries: unknown[] };
        expect(stored.summaries).toHaveLength(6);
        const world = createWorld(base);
        const host = hostOf(base, world);
        const chats = structuredClone(base.chats);
        const prepare = (room: unknown) =>
            prepareHypaV3(host, chats, 100, base.maxContextTokens, room as never, { tokenizeChat });

        const room = structuredClone(base.room);
        const withOrphan = await prepare(room);
        if (!withOrphan.ok) throw new Error(withOrphan.result.error);
        expect(withOrphan.prepared.snapshot).toEqual(stored);
        expect(withOrphan.prepared.snapshot).not.toBe(room.hypaV3Data);
        expect(withOrphan.prepared.data.summaries).toHaveLength(5);
        expect(withOrphan.prepared.data.summaries.map((summary) => summary.text)).not.toContain(
            "Orphaned summary: a chat that is gone.",
        );

        const withNull = await prepare({ hypaV3Data: null });
        if (!withNull.ok) throw new Error(withNull.result.error);
        expect(withNull.prepared.snapshot).toBeNull();
        expect(withNull.prepared.data).toEqual({ summaries: [] });

        const withoutData = await prepare({});
        if (!withoutData.ok) throw new Error(withoutData.result.error);
        expect(withoutData.prepared.snapshot).toBeUndefined();
    });

    it("the count after the windows is subtracted one window at a time, as the mains did", async () => {
        // Two one-message windows of 0.1 and 0.2 tokens from 1000.25: (1000.25 − 0.1) − 0.2 is not
        // 1000.25 − (0.1 + 0.2) in floating point.
        const fractional: MemoryTokenizer = {
            tokenizeChat: async (chat) => ({ a: 0.1, b: 0.2 })[chat.memo ?? ""] ?? 0,
        };
        const scenario: Scenario = {
            name: "v3-fractional-counts",
            algorithm: "v3",
            preset: { maxChatsPerSummary: 1, queryChatCount: 1, memoryTokensRatio: 0 },
            chats: ["a", "b", "c", "d"].map((memo) => ({ role: "user" as const, content: `Message ${memo}.`, memo })),
            room: {},
            char: { type: "character", name: "Mira" },
            maxContextTokens: 1000,
            currentTokens: 1050.25,
        };
        const world = createWorld(scenario);
        const host = hostOf(scenario, world);
        const outcome = await prepareHypaV3(
            host,
            structuredClone(scenario.chats),
            1050.25,
            1000,
            {} as never,
            fractional,
        );
        if (!outcome.ok) throw new Error(outcome.result.error);
        const prepared = outcome.prepared;
        expect(prepared.ledger.current).toBe(1000.25);
        const plan = await planHypaV3Summaries(prepared);
        expect(plan.stopReason).toBe("targetReached");
        expect(plan.windows.map((window) => window.removedTokens)).toEqual([0.1, 0.2]);
        const sequential = 1000.25 - 0.1 - 0.2;
        const summed = 1000.25 - (0.1 + 0.2);
        expect(sequential).not.toBe(summed);
        expect(plan.predictedTokens).toBe(sequential);

        const execution = await executeHypaV3Plan(host, prepared, plan);
        expect(execution.endReason).toBe("complete");
        expect(execution.tokenDelta).toBe(0.1 + 0.2);
        expect(execution.currentTokens).toBe(sequential);
        expect(execution.currentTokens).not.toBe(prepared.ledger.current - execution.tokenDelta);
    });
});

// ---------------------------------------------------------------------------------------------
// The options and hooks

const TOKENS = 10;
/** Every entry costs the same: the counts below read off the message counts. */
const flat: MemoryTokenizer = { tokenizeChat: async () => TOKENS };
const EMPTY_CARD = "<Past Events Summary>\n\n</Past Events Summary>";
const CONTEXT = 100;
/** The standard preset of these cases: two messages per window, a two-message tail, recent selection only. */
const HOOKED_PRESET = {
    maxChatsPerSummary: 2,
    queryChatCount: 2,
    recentMemoryRatio: 1,
    similarMemoryRatio: 0,
    memoryTokensRatio: 0.4,
};
const stored = (memos: string[], text: string): SerializableSummary => ({
    text,
    chatMemos: memos,
    isImportant: false,
    tags: [],
});

type Setup = {
    world: World;
    host: MemoryHost;
    controller: AbortController;
    chats: OpenAIChat[];
    prepared: HypaV3Prepared;
    plan: HypaV3Plan;
};

/**
 * A scenario prepared and planned on the flat tokenizer, with a host whose `fence` throws once its
 * signal is aborted (the job's fence) and whose summary answers `hold` can delay.
 */
async function setUp(
    scenario: Scenario,
    options: { hold?: (index: number) => Promise<void>; prepare?: HypaV3PrepareOptions; lookahead?: boolean } = {},
): Promise<Setup> {
    const world = createWorld(scenario);
    const controller = new AbortController();
    const host: MemoryHost = {
        ...hostOf(scenario, world, { hold: options.hold }),
        signal: controller.signal,
        fence: () => {
            if (controller.signal.aborted) {
                throw new Error("aborted by the job");
            }
        },
    };
    const chats = structuredClone(scenario.chats);
    const outcome = await prepareHypaV3(
        host,
        chats,
        scenario.currentTokens!,
        scenario.maxContextTokens,
        structuredClone(scenario.room) as never,
        flat,
        options.prepare,
    );
    if (!outcome.ok) throw new Error(outcome.result.error);
    const plan = await planHypaV3Summaries(outcome.prepared, { lookahead: options.lookahead });
    expect(plan.error).toBeUndefined();
    return { world, host, controller, chats, prepared: outcome.prepared, plan };
}

/** A stored memory value and the checkpoint hook that writes to it through the checkpoint's merge. */
function fakeStore(initial: SerializableHypaV3Data | null | undefined) {
    const store = {
        value: structuredClone(initial) as SerializableHypaV3Data | null | undefined,
        commits: 0,
        checkpoints: [] as HypaV3Checkpoint[],
    };
    const checkpoint = (write: HypaV3Checkpoint): "committed" | "skipped" => {
        store.checkpoints.push(write);
        const merged = write.merge(store.value);
        if (!merged) {
            return "skipped";
        }
        store.value = structuredClone(merged);
        store.commits++;
        return "committed";
    };
    return { store, checkpoint };
}

/** The chat as stored, for a validator: one message per history entry, in order. */
type StoredMessage = { chatId: string | undefined; data: string; disabled?: boolean | "allBefore" };
const messagesOf = (chats: OpenAIChat[]): StoredMessage[] =>
    chats.map((chat) => ({ chatId: chat.memo, data: chat.content }));
const messageSources = (messages: StoredMessage[]): HypaV3EntrySource[] =>
    messages.map((message) => ({ kind: "message", id: message.chatId, textHash: hypaV3SourceHash(message.data) }));
const currentOf = (messages: StoredMessage[], greeting?: string, fmIndex: number | undefined = -1) => ({
    messages,
    fmIndex,
    greeting,
});

/** A summarizing scenario on the flat tokenizer: `n` messages, `currentTokens` incoming. */
const flatScenario = (name: string, currentTokens: number, extra: Partial<Scenario> = {}): Scenario => ({
    name,
    algorithm: "v3",
    preset: HOOKED_PRESET,
    chats: makeChats(14),
    room: {},
    char: { type: "character", name: "Mira" },
    maxContextTokens: CONTEXT,
    currentTokens,
    ...extra,
});

const EXPERIMENTAL_HOOKED = { ...HOOKED_PRESET, ...EXPERIMENTAL_PRESET };
/** A budget of 30 so that 160 incoming (160 − 50 + 30 = 140) plans exactly two windows. */
const EXPERIMENTAL_TWO_WINDOWS = { ...EXPERIMENTAL_HOOKED, memoryTokensRatio: 0.3 };

/** A deferred per summary request: `release(index)` lets that answer through. */
function holds(expected: number) {
    const releases = new Map<number, () => void>();
    let started: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    const hold = (index: number) =>
        new Promise<void>((resolve) => {
            releases.set(index, resolve);
            if (releases.size === expected) {
                started();
            }
        });
    const release = async (index: number) => {
        releases.get(index)!();
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return { hold, allStarted, release };
}

describe("execution with hooks: checkpoints", () => {
    // Three stored summaries over m0..m5 (60 tokens of prefix), 220 incoming: 220 − 50 − 60 + 40 = 150,
    // so three windows (m6..m11) reach the 100 target.
    const withStored = (name: string, currentTokens = 220) =>
        flatScenario(name, currentTokens, {
            room: {
                hypaV3Data: {
                    summaries: [stored(["m0", "m1"], "A"), stored(["m2", "m3"], "B"), stored(["m4", "m5"], "C")],
                },
            },
        });

    it("saves each summary onto the stored value through a baseline that is the last committed candidate, so edits saved between checkpoints and the selection survive the final write", async () => {
        const scenario = withStored("v3-three-checkpoints");
        const { world, host, prepared, plan } = await setUp(scenario);
        expect(plan.windows.map((window) => window.needsLlm)).toEqual([true, true, true]);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        let edited = false;
        const execution = await executeHypaV3Plan(host, prepared, plan, {
            checkpoint: (write) => {
                const outcome = checkpoint(write);
                if (store.commits === 1 && !edited) {
                    // Saved between the first and the second checkpoint: a text edit, a middle deletion,
                    // a category, and the modal's settings.
                    edited = true;
                    const value = store.value!;
                    value.summaries[0].text = "A edited";
                    value.summaries.splice(1, 1);
                    value.summaries[1].categoryId = "cat";
                    value.categories = [{ id: "cat", name: "Cat" }];
                    value.modalSettings = { displayMode: "Recent" } as never;
                }
                return outcome;
            },
        });
        expect(execution.endReason).toBe("complete");
        expect(store.commits).toBe(3);
        expect(world.log.requests).toHaveLength(3);
        const [first, second, third] = store.checkpoints;
        expect(first.baseline).toEqual(prepared.snapshot);
        expect(second.baseline).toEqual(first.candidate);
        expect(third.baseline).toEqual(second.candidate);
        expect(execution.baseline).toEqual(third.candidate);
        // The baseline is the algorithm's own data, never the merged value: it still says "A".
        expect(execution.baseline!.summaries.map((summary) => summary.text)).toEqual([
            "A",
            "B",
            "C",
            ...plan.windows.map((_, i) => `Summary ${i + 1}: the events so far, in short.\n\nDetail ${i + 1}.`),
        ]);
        expect(store.value!.summaries.map((summary) => summary.text)).toEqual([
            "A edited",
            "C",
            ...execution.data.summaries.slice(3).map((summary) => summary.text),
        ]);
        expect(store.value!.summaries[1].categoryId).toBe("cat");
        expect(store.value!.categories).toEqual([{ id: "cat", name: "Cat" }]);
        expect(store.value!.modalSettings).toEqual({ displayMode: "Recent" });
        // Adopting the merged value as the baseline would hit the fast path and write the unedited text.
        const adopted = mergeHypaV3Write(store.value!, third.candidate, store.value!, false)!;
        expect(adopted.summaries[0].text).toBe("A");

        // The final selection write: recent selection of the three new summaries, mapped by identity.
        const selection = await selectHypaV3(host, prepared, execution);
        expect(selection.error).toBeUndefined();
        expect(selection.memory!.metrics!.lastRecentSummaries).toEqual([5, 4, 3]);
        const written = mergeHypaV3SelectionWrite(execution.baseline, selection.memory!, store.value, {
            selectionMade: true,
        })!;
        expect(written.summaries.map((summary) => summary.text)).toEqual(store.value!.summaries.map((s) => s.text));
        expect(written.summaries[0].text).toBe("A edited");
        expect(written.summaries[1].categoryId).toBe("cat");
        expect(written.modalSettings).toEqual({ displayMode: "Recent" });
        expect(written.metrics!.lastRecentSummaries).toEqual([4, 3, 2]);
    });

    it("normalizes the candidate's metrics to the summaries left after the orphan cleanup, so the fast path keeps each metric on its summary", async () => {
        // Stored [A, O (orphan), B] with important [2] (B), recent [1] (O), similar [0] (A); 190 incoming:
        // 190 − 50 − 40 + 40 = 140, two windows.
        const scenario = flatScenario("v3-cleanup-append-metrics", 190, {
            room: {
                hypaV3Data: {
                    summaries: [stored(["m0", "m1"], "A"), stored(["gone-1"], "O"), stored(["m2", "m3"], "B")],
                    metrics: {
                        lastImportantSummaries: [2],
                        lastRecentSummaries: [1],
                        lastSimilarSummaries: [0],
                        lastRandomSummaries: [],
                    },
                },
            },
        });
        const { host, prepared, plan } = await setUp(scenario);
        expect(prepared.data.summaries.map((summary) => summary.text)).toEqual(["A", "B"]);
        expect(plan.windows).toHaveLength(2);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        const execution = await executeHypaV3Plan(host, prepared, plan, { checkpoint });
        expect(execution.endReason).toBe("complete");
        const [first] = store.checkpoints;
        expect(first.candidate.summaries.map((summary) => summary.text)).toEqual(["A", "B", expect.any(String)]);
        expect(first.candidate.metrics).toEqual({
            lastImportantSummaries: [1],
            lastRecentSummaries: [],
            lastSimilarSummaries: [0],
            lastRandomSummaries: [],
        });
        // Unchanged since the read: the candidate is written as it is, with the moved metrics.
        expect(first.merge(prepared.snapshot)).toBe(first.candidate);
        expect(store.value!.metrics).toEqual(first.candidate.metrics);
        // The prepared and execution state keep the metrics as read.
        expect(prepared.data.metrics!.lastImportantSummaries).toEqual([2]);
        expect(execution.data.metrics!.lastImportantSummaries).toEqual([2]);
    });

    it("a refused checkpoint ends with writeSkipped: the window is not accepted and no later request is made", async () => {
        // 190 incoming, no summaries: 190 − 50 + 40 = 180, four windows.
        const { world, host, prepared, plan } = await setUp(flatScenario("v3-write-skipped", 190));
        expect(plan.windows).toHaveLength(4);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        const progress: [number, number][] = [];
        const execution = await executeHypaV3Plan(host, prepared, plan, {
            checkpoint: (write) => (store.commits === 1 ? "skipped" : checkpoint(write)),
            progress: (done, total) => progress.push([done, total]),
        });
        expect(execution.endReason).toBe("writeSkipped");
        if (execution.endReason !== "writeSkipped") throw new Error("unreachable");
        expect(execution.window).toBe(1);
        expect(execution.accepted).toBe(1);
        expect(execution.completed.map((executed) => executed.window)).toEqual([plan.windows[0]]);
        expect(execution.cursor).toBe(plan.windows[0].scanEnd);
        expect(execution.data.summaries).toHaveLength(1);
        expect(execution.baseline).toEqual(store.checkpoints[0].candidate);
        expect(store.commits).toBe(1);
        expect(world.log.requests).toHaveLength(2);
        expect(progress).toEqual([
            [0, 4],
            [1, 4],
        ]);
    });

    const stopCases = [
        { label: "standard", algorithm: "v3", preset: HOOKED_PRESET, sequential: false },
        { label: "experimental (sequential)", algorithm: "v3exp", preset: EXPERIMENTAL_HOOKED, sequential: true },
    ] as const;
    for (const { label, algorithm, preset, sequential } of stopCases) {
        it(`${label}: shouldStop after window 2 of 4 leaves two saved summaries and the cursor after window 2`, async () => {
            const scenario = flatScenario(`${algorithm}-stop-after-two`, 190, { algorithm, preset });
            const { world, host, prepared, plan } = await setUp(scenario);
            expect(plan.windows).toHaveLength(4);
            expect(plan.llmCalls).toBe(4);
            const { store, checkpoint } = fakeStore(prepared.snapshot);
            const execution = await executeHypaV3Plan(host, prepared, plan, {
                checkpoint,
                shouldStop: () => store.commits >= 2,
                sequential,
            });
            expect(execution.endReason).toBe("stopped");
            expect(execution.accepted).toBe(2);
            expect(execution.cursor).toBe(plan.windows[1].scanEnd);
            expect(execution.data.summaries).toHaveLength(2);
            expect(store.commits).toBe(2);
            expect(store.value!.summaries).toHaveLength(2);
            expect(world.log.requests).toHaveLength(2);
            if (prepared.implementation === "experimental") {
                expect(world.log.progress.at(-1)).toEqual({ open: false, miniMsg: "", msg: "", subMsg: "" });
            }
        });
    }
});

describe("execution with hooks: source validation", () => {
    /** The validator over the scenario's chats as the stored messages, which the test can change. */
    const validatorOf = (chats: OpenAIChat[]) => {
        const messages = messagesOf(chats);
        return { messages, validate: createHypaV3SourceValidator(messageSources(messages), () => currentOf(messages)) };
    };

    it("revalidates an accepted token-only window before a later checkpoint: a message edited after its acceptance ends with sourceInvalid and nothing saved", async () => {
        // One message per window, user messages left out of the summaries: window 1 (m0, a user message)
        // needs no request, window 2 (m1) does. 150 incoming: 150 − 50 + 40 = 140, four windows.
        const scenario = flatScenario("v3-token-only-then-edit", 150, {
            preset: { ...HOOKED_PRESET, maxChatsPerSummary: 1, doNotSummarizeUserMessage: true },
            chats: makeChats(8),
        });
        const { messages, validate } = validatorOf(scenario.chats);
        const { world, host, prepared, plan } = await setUp(scenario, {
            // While window 2's summary request waits, the message of window 1 gets other text.
            hold: async () => {
                messages[0].data = "Message 0, rewritten after the window passed.";
            },
        });
        expect(plan.windows.map((window) => window.needsLlm)).toEqual([false, true, false, true]);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        const execution = await executeHypaV3Plan(host, prepared, plan, { checkpoint, validate });
        expect(execution.endReason).toBe("sourceInvalid");
        if (execution.endReason !== "sourceInvalid") throw new Error("unreachable");
        expect(execution.window).toBe(0);
        expect(execution.accepted).toBe(0);
        expect(execution.completed).toEqual([]);
        expect(execution.cursor).toBe(prepared.startIdx);
        expect(execution.data.summaries).toEqual([]);
        expect(store.checkpoints).toHaveLength(0);
        expect(store.value).toEqual(prepared.snapshot);
        expect(world.log.requests).toHaveLength(1);
    });

    it("a committed window's trailing excluded entry changed before the next checkpoint ends with sourceInvalid: the stored summary stays, the execution rewinds", async () => {
        // Window 1 scans m0 and a blank m1 and summarizes m0 alone; m1 gets text while window 2 waits.
        const chats = makeChats(14);
        chats[1].content = "";
        const scenario = flatScenario("v3-trailing-blank-edited", 190, { chats });
        const { messages, validate } = validatorOf(scenario.chats);
        const { world, host, prepared, plan } = await setUp(scenario, {
            hold: async (index) => {
                if (index === 1) {
                    messages[1].data = "Message 1, no longer blank.";
                }
            },
        });
        expect(plan.windows[0].includedMemos).toEqual(["m0"]);
        expect(plan.windows[0].scannedIds).toEqual(["m0", "m1"]);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        const execution = await executeHypaV3Plan(host, prepared, plan, { checkpoint, validate });
        expect(execution.endReason).toBe("sourceInvalid");
        if (execution.endReason !== "sourceInvalid") throw new Error("unreachable");
        expect(execution.window).toBe(0);
        expect(store.commits).toBe(1);
        expect(store.value!.summaries.map((summary) => summary.chatMemos)).toEqual([["m0"]]);
        expect(execution.baseline).toEqual(store.checkpoints[0].candidate);
        expect(execution.accepted).toBe(0);
        expect(execution.cursor).toBe(0);
        expect(execution.data.summaries).toEqual([]);
        expect(world.log.requests).toHaveLength(2);
    });

    it("experimental: a later window answered first is never saved when an earlier window's message was deleted", async () => {
        // Two windows requested together (160 incoming: 160 − 50 + 30 = 140); m1 is deleted while both
        // wait, window 2 answers first.
        const scenario = flatScenario("v3exp-deleted-under-concurrency", 160, {
            algorithm: "v3exp",
            preset: { ...EXPERIMENTAL_TWO_WINDOWS, summarizationMaxConcurrent: 2 },
        });
        const { messages, validate } = validatorOf(scenario.chats);
        const { hold, allStarted, release } = holds(2);
        const { world, host, prepared, plan } = await setUp(scenario, { hold });
        expect(plan.windows.map((window) => window.scannedIds)).toEqual([
            ["m0", "m1"],
            ["m2", "m3"],
        ]);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        const running = executeHypaV3Plan(host, prepared, plan, { checkpoint, validate });
        await allStarted;
        messages.splice(1, 1);
        await release(1);
        await release(0);
        const execution = await running;
        expect(execution.endReason).toBe("sourceInvalid");
        if (execution.endReason !== "sourceInvalid") throw new Error("unreachable");
        expect(execution.window).toBe(0);
        expect(execution.accepted).toBe(0);
        expect(execution.data.summaries).toEqual([]);
        expect(store.checkpoints).toHaveLength(0);
        expect(world.log.requests).toHaveLength(2);
        expect(world.log.progress.at(-1)).toEqual({ open: false, miniMsg: "", msg: "", subMsg: "" });
    });

    describe("the validator", () => {
        const greeting = "Hello there, traveler.";
        /** The greeting, then six messages; a window scanning `[start, end)` of them. */
        const history = () => {
            const chats: OpenAIChat[] = [{ role: "assistant", content: greeting }, ...makeChats(6)];
            const messages = messagesOf(chats.slice(1));
            const sources: HypaV3EntrySource[] = [
                { kind: "greeting", fmIndex: -1, textHash: hypaV3SourceHash(greeting) },
                ...messageSources(messages),
            ];
            const current: HypaV3CurrentSource = currentOf(messages, greeting);
            const windowOf = (scanStart: number, scanEnd: number, over = chats): HypaV3PlannedWindow => ({
                scanStart,
                scanEnd,
                scannedIds: over.slice(scanStart, scanEnd).map((chat) => chat.memo),
                included: [],
                includedMemos: [],
                removedTokens: 0,
                needsLlm: true,
            });
            return { chats, messages, sources, current, windowOf };
        };

        it("accepts an unchanged window with the greeting and rejects a changed greeting, index, or edited message", () => {
            const { messages, sources, current, windowOf } = history();
            const validate = createHypaV3SourceValidator(sources, () => current);
            expect(validate(windowOf(0, 3))).toBe(true);
            expect(validate(windowOf(3, 5))).toBe(true);
            expect(createHypaV3SourceValidator(sources, () => ({ ...current, greeting: "Hi." }))(windowOf(0, 3))).toBe(
                false,
            );
            expect(createHypaV3SourceValidator(sources, () => ({ ...current, fmIndex: 0 }))(windowOf(0, 3))).toBe(
                false,
            );
            // A window after the greeting does not read it; one anchored on the greeting needs it.
            expect(createHypaV3SourceValidator(sources, () => ({ ...current, fmIndex: 0 }))(windowOf(3, 5))).toBe(true);
            const noGreeting = createHypaV3SourceValidator(sources, () => ({ ...current, greeting: undefined }));
            expect(noGreeting(windowOf(3, 5))).toBe(true);
            expect(noGreeting(windowOf(1, 3))).toBe(false);
            // An edit inside the window fails, outside it does not; a blank message's edit counts too.
            const edited = messages.map((message) => ({ ...message }));
            edited[3].data = "Message 2, rewritten.";
            const validateEdited = createHypaV3SourceValidator(sources, () => currentOf(edited, greeting));
            expect(validateEdited(windowOf(3, 5))).toBe(false);
            expect(validateEdited(windowOf(0, 3))).toBe(true);
            // The chat is gone.
            expect(createHypaV3SourceValidator(sources, () => null)(windowOf(0, 3))).toBe(false);
        });

        it("rejects a message inserted, deleted, re-enabled, or duplicated in or right before the window, not one before its anchor", () => {
            const { messages, sources, current, windowOf } = history();
            // Inserted between m2 and m3: inside the window scanning them, right before the window
            // starting at m3, and of no concern to the windows before it.
            const inserted = [...messages.slice(0, 3), { chatId: "x", data: "inserted" }, ...messages.slice(3)];
            const withInsertion = createHypaV3SourceValidator(sources, () => currentOf(inserted, greeting));
            expect(withInsertion(windowOf(3, 5))).toBe(false);
            expect(withInsertion(windowOf(4, 6))).toBe(false);
            expect(withInsertion(windowOf(0, 3))).toBe(true);
            expect(withInsertion(windowOf(5, 7))).toBe(true);
            const deleted = messages.filter((message) => message.chatId !== "m3");
            expect(createHypaV3SourceValidator(sources, () => currentOf(deleted, greeting))(windowOf(3, 5))).toBe(
                false,
            );
            // A message disabled at the capture was not an entry; enabling it inserts one.
            const disabled = [
                ...messages.slice(0, 3),
                { chatId: "d", data: "hidden", disabled: true },
                ...messages.slice(3),
            ];
            expect(createHypaV3SourceValidator(sources, () => currentOf(disabled, greeting))(windowOf(3, 5))).toBe(
                true,
            );
            disabled[3].disabled = false;
            expect(createHypaV3SourceValidator(sources, () => currentOf(disabled, greeting))(windowOf(3, 5))).toBe(
                false,
            );
            const duplicated = [...messages, { ...messages[2] }];
            expect(createHypaV3SourceValidator(sources, () => currentOf(duplicated, greeting))(windowOf(3, 5))).toBe(
                false,
            );
            // A deletion before the anchor leaves the window's interval as it was.
            const earlier = messages.filter((message) => message.chatId !== "m0");
            expect(createHypaV3SourceValidator(sources, () => currentOf(earlier, greeting))(windowOf(3, 5))).toBe(true);
            expect(current.messages).toHaveLength(6);
        });

        it("follows a history reset: the entries after the last `allBefore` start the history, without the greeting", () => {
            const { messages, windowOf } = history();
            const reset: StoredMessage[] = [
                ...messages.slice(0, 2),
                { chatId: "r", data: "reset", disabled: "allBefore" },
                ...messages.slice(2),
            ];
            // Captured after the reset: the history is m2..m5, no greeting.
            const chats = makeChats(6).slice(2);
            const sources = messageSources(messagesOf(chats));
            const validate = createHypaV3SourceValidator(sources, () => currentOf(reset, greeting));
            expect(validate(windowOf(0, 2, chats))).toBe(true);
            // The reset undone: the greeting and two messages come before the window's first entry.
            reset[2].disabled = undefined;
            expect(validate(windowOf(0, 2, chats))).toBe(false);
        });

        it("rejects sources misaligned with the window, a message without an id, and keeps example entries by their memo", () => {
            const { sources, current, windowOf } = history();
            const validate = createHypaV3SourceValidator(sources, () => current);
            expect(validate({ ...windowOf(0, 3), scannedIds: [undefined, "m0"] })).toBe(false);
            expect(validate({ ...windowOf(0, 3), scannedIds: ["m0", "m0", "m1"] })).toBe(false);
            expect(validate(windowOf(5, 8))).toBe(false);
            expect(createHypaV3SourceValidator(sources.slice(0, 2), () => current)(windowOf(0, 3))).toBe(false);
            // An example and the new-chat marker before the history: entries without a stored message.
            const prelude: OpenAIChat[] = [
                { role: "user", name: "example_user", content: "An example." },
                { role: "system", content: "[Start a new chat]", memo: "NewChat" },
            ];
            const chats = [...prelude, ...makeChats(4)];
            const messages = messagesOf(chats.slice(2));
            const preludeSources: HypaV3EntrySource[] = [
                { kind: "other", memo: undefined },
                { kind: "other", memo: "NewChat" },
                ...messageSources(messages),
            ];
            const withPrelude = createHypaV3SourceValidator(preludeSources, () => currentOf(messages));
            expect(withPrelude(windowOf(0, 4, chats))).toBe(true);
            expect(withPrelude({ ...windowOf(0, 4, chats), scannedIds: [undefined, undefined, "m0", "m1"] })).toBe(
                false,
            );
            const noId = createHypaV3SourceValidator(
                [...preludeSources.slice(0, 2), { kind: "message", id: undefined, textHash: hypaV3SourceHash("x") }],
                () => currentOf([{ chatId: undefined, data: "x" }]),
            );
            expect(noId({ ...windowOf(0, 3, chats), scannedIds: [undefined, "NewChat", undefined] })).toBe(false);
        });

        it("hashes the stored text by its UTF-16 code units, so lone surrogates differ", () => {
            expect(hypaV3SourceHash("\ud800")).not.toBe(hypaV3SourceHash("\ud801"));
            expect(hypaV3SourceHash("same")).toBe(hypaV3SourceHash("same"));
        });
    });
});

describe("execution with hooks: experimental concurrency, aborts, and hook exceptions", () => {
    it("experimental: out-of-order answers save only the consecutive prefix before a failure", async () => {
        // Three windows requested together (170 incoming: 170 − 50 + 40 = 160); the answers arrive
        // third, first, then the failing second.
        const scenario = flatScenario("v3exp-prefix-under-failure", 170, {
            algorithm: "v3exp",
            preset: { ...EXPERIMENTAL_HOOKED, summarizationMaxConcurrent: 3 },
            summaries: ["Batch summary one.", { fail: "the summary model is down" }, "Batch summary three."],
        });
        const { hold, allStarted, release } = holds(3);
        const { world, host, prepared, plan } = await setUp(scenario, { hold });
        expect(plan.llmCalls).toBe(3);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        const running = executeHypaV3Plan(host, prepared, plan, { checkpoint });
        await allStarted;
        expect(store.commits).toBe(0);
        await release(2);
        expect(store.commits).toBe(0);
        await release(0);
        expect(store.commits).toBe(1);
        await release(1);
        const execution = await running;
        expect(execution.endReason).toBe("providerFailed");
        if (execution.endReason !== "providerFailed") throw new Error("unreachable");
        expect(execution.failedWindow).toBe(1);
        expect(execution.accepted).toBe(1);
        expect(execution.completed.map((executed) => executed.summary?.text)).toEqual(["Batch summary one."]);
        expect(store.value!.summaries.map((summary) => summary.text)).toEqual(["Batch summary one."]);
        expect(store.checkpoints).toHaveLength(1);
        expect(world.log.requests).toHaveLength(3);
        expect(world.log.progress.at(-1)).toEqual({ open: false, miniMsg: "", msg: "", subMsg: "" });
    });

    it("experimental: a plan without summary requests runs without the rate limiter and emits no queue notice", async () => {
        // Only user messages, left out of the summaries: one window that moves the cursor. The limiter
        // settings would be refused if one were constructed.
        const scenario = flatScenario("v3exp-token-only-plan", 160, {
            algorithm: "v3exp",
            preset: {
                ...EXPERIMENTAL_HOOKED,
                doNotSummarizeUserMessage: true,
                summarizationRequestsPerMinute: 1,
                summarizationMaxConcurrent: 2,
            },
            chats: makeChats(8).map((chat) => ({ ...chat, role: "user" as const })),
        });
        const { world, host, prepared, plan } = await setUp(scenario);
        expect(plan.windows.map((window) => window.needsLlm)).toEqual([false]);
        const progress: [number, number][] = [];
        const execution = await executeHypaV3Plan(host, prepared, plan, {
            checkpoint: () => "committed",
            progress: (done, total) => progress.push([done, total]),
        });
        expect(execution.endReason).toBe("complete");
        expect(execution.accepted).toBe(1);
        expect(execution.cursor).toBe(plan.windows[0].scanEnd);
        expect(world.log.progress).toEqual([]);
        expect(world.log.requests).toEqual([]);
        expect(progress).toEqual([]);
    });

    it("standard: an abort raised from a hook is thrown, never returned as complete, and the saved summaries stay", async () => {
        // One message per window, user messages left out: window 1 (an assistant message) is summarized,
        // window 2 (a user message) only moves the cursor; the progress hook aborts after the first save.
        const chats = makeChats(8).map((chat, i) => ({
            ...chat,
            role: i % 2 === 0 ? ("assistant" as const) : ("user" as const),
        }));
        const scenario = flatScenario("v3-abort-from-progress", 150, {
            preset: { ...HOOKED_PRESET, maxChatsPerSummary: 1, doNotSummarizeUserMessage: true },
            chats,
        });
        const { world, host, controller, prepared, plan } = await setUp(scenario);
        expect(plan.windows.map((window) => window.needsLlm)).toEqual([true, false, true, false]);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        await expect(
            executeHypaV3Plan(host, prepared, plan, {
                checkpoint,
                progress: (done) => {
                    if (done === 1) {
                        controller.abort();
                    }
                },
            }),
        ).rejects.toThrow("aborted by the job");
        expect(store.commits).toBe(1);
        expect(world.log.requests).toHaveLength(1);

        // An already-aborted execution makes no request.
        const again = await setUp(scenario);
        again.controller.abort();
        await expect(executeHypaV3Plan(again.host, again.prepared, again.plan, { checkpoint })).rejects.toThrow(
            "aborted by the job",
        );
        expect(again.world.log.requests).toHaveLength(0);

        // An abort from the last window's save, with no window left to start: thrown all the same.
        const lastIsSummary = await setUp({
            ...scenario,
            name: "v3-abort-from-last-progress",
            chats: chats.map((chat, i) => ({
                ...chat,
                role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
            })),
        });
        expect(lastIsSummary.plan.windows.map((window) => window.needsLlm)).toEqual([false, true, false, true]);
        const last = fakeStore(lastIsSummary.prepared.snapshot);
        await expect(
            executeHypaV3Plan(lastIsSummary.host, lastIsSummary.prepared, lastIsSummary.plan, {
                checkpoint: last.checkpoint,
                progress: (done) => {
                    if (done === 2) {
                        lastIsSummary.controller.abort();
                    }
                },
            }),
        ).rejects.toThrow("aborted by the job");
        expect(last.store.commits).toBe(2);
        expect(lastIsSummary.world.log.requests).toHaveLength(2);
    });

    it("experimental: a shouldStop hook that throws inside a queued request propagates its own exception and leaves the notice closed", async () => {
        // Two windows requested together (160 incoming). The hook is read before the requests are
        // submitted, then at the start of each queued request: the third reading (window 2's start) throws.
        const scenario = flatScenario("v3exp-stop-hook-throws", 160, {
            algorithm: "v3exp",
            preset: { ...EXPERIMENTAL_TWO_WINDOWS, summarizationMaxConcurrent: 2 },
        });
        const { world, host, prepared, plan } = await setUp(scenario);
        expect(plan.llmCalls).toBe(2);
        const { store, checkpoint } = fakeStore(prepared.snapshot);
        let readings = 0;
        await expect(
            executeHypaV3Plan(host, prepared, plan, {
                checkpoint,
                shouldStop: () => {
                    readings++;
                    if (readings === 3) {
                        throw new Error("stop hook broke");
                    }
                    return false;
                },
            }),
        ).rejects.toThrow("stop hook broke");
        expect(store.commits).toBe(1);
        expect(world.log.requests).toHaveLength(1);
        expect(world.log.progress.at(-1)).toEqual({ open: false, miniMsg: "", msg: "", subMsg: "" });
    });
});

describe("selection with trimUncovered", () => {
    const trimUncovered = { tooMuchToken: TOO_MUCH_TOKEN };
    /** The cost of a multimodal entry on top of its text. */
    const withImages: MemoryTokenizer = {
        tokenizeChat: async (chat) => TOKENS + (chat.multimodals?.length ?? 0) * 25,
    };
    const selectOnly = async (scenario: Scenario, tokenizer: MemoryTokenizer = flat) => {
        const world = createWorld(scenario);
        const host = hostOf(scenario, world);
        const chats = structuredClone(scenario.chats);
        const outcome = await prepareHypaV3(
            host,
            chats,
            scenario.currentTokens!,
            scenario.maxContextTokens,
            structuredClone(scenario.room) as never,
            tokenizer,
        );
        if (!outcome.ok) throw new Error(outcome.result.error);
        const prepared = outcome.prepared;
        const selection = await selectHypaV3(host, prepared, emptyHypaV3Execution(prepared), { trimUncovered });
        return { world, host, prepared, selection };
    };

    it("standard: drops the uncovered history oldest first, keeps the last queryChatCount entries, and reports the dropped entries' tokens as the gap", async () => {
        // Eight messages, the second with an image (35 tokens). 200 incoming: 200 − 50 = 150, over the
        // context with the empty card, so the full budget (20) is reserved: 170. Settled against the
        // empty card: 160; m0..m3 go (10 + 35 + 10 + 10) until 95 fits.
        const chats = makeChats(8);
        chats[1].multimodals = [{ type: "image", base64: "" }];
        const scenario = flatScenario("v3-trim-standard", 200, {
            preset: { ...HOOKED_PRESET, memoryTokensRatio: 0.2 },
            chats,
        });
        const { selection, prepared } = await selectOnly(scenario, withImages);
        expect(prepared.ledger.reservation).toEqual({ kind: "fullBudget", tokens: 20 });
        expect(selection.error).toBeUndefined();
        expect(selection.currentTokens).toBe(95);
        expect(selection.chats.map((chat) => chat.memo)).toEqual(["supaMemory", "m4", "m5", "m6", "m7"]);
        expect(selection.chats[0].content).toBe(EMPTY_CARD);
        expect(selection.trim).toEqual({
            gap: { tokens: 65, messages: 4, memos: ["m0", "m1", "m2", "m3"] },
            protected: { count: 2, memos: ["m6", "m7"] },
        });
        // Not the excess over the context (160 − 100 = 60).
        expect(selection.trim!.gap.tokens).not.toBe(160 - CONTEXT);
        expect(selection.memory).toEqual({ summaries: [] });
    });

    it("returns the too-many-tokens error with the pre-selection memory when the protected entries do not fit", async () => {
        // A short history: three messages, all protected, nothing to drop (170 settled to 160).
        const short = await selectOnly(
            flatScenario("v3-trim-short-history", 200, {
                preset: { ...HOOKED_PRESET, memoryTokensRatio: 0.2, queryChatCount: 3 },
                chats: makeChats(3),
            }),
        );
        expect(short.selection.error).toBe(`${TOO_MUCH_TOKEN}\n\nRequired Tokens: 160`);
        expect(short.selection.chats).toEqual(short.prepared.chats);
        expect(short.selection.memory).toEqual({ summaries: [] });
        expect(short.selection.trim).toBeUndefined();
        // A large fixed prompt: every droppable entry goes (960 − 60 = 900) and the rest still does not fit.
        const large = await selectOnly(
            flatScenario("v3-trim-large-prompt", 1000, {
                preset: { ...HOOKED_PRESET, memoryTokensRatio: 0.2 },
                chats: makeChats(8),
            }),
        );
        expect(large.selection.error).toBe(`${TOO_MUCH_TOKEN}\n\nRequired Tokens: 900`);
    });

    it("standard: with a zero memory ratio the empty card is still the settled cost", async () => {
        // 200 incoming: 150 with an empty card over the context, the full budget is 0; settled: 160,
        // six drops reach exactly 100.
        const { selection, prepared } = await selectOnly(
            flatScenario("v3-trim-zero-ratio", 200, {
                preset: { ...HOOKED_PRESET, memoryTokensRatio: 0 },
                chats: makeChats(8),
            }),
        );
        expect(prepared.ledger.reservation).toEqual({ kind: "fullBudget", tokens: 0 });
        expect(selection.error).toBeUndefined();
        expect(selection.currentTokens).toBe(100);
        expect(selection.chats.map((chat) => chat.memo)).toEqual(["supaMemory", "m6", "m7"]);
        expect(selection.trim!.gap).toEqual({ tokens: 60, messages: 6, memos: ["m0", "m1", "m2", "m3", "m4", "m5"] });
    });

    it("experimental: no card without summaries, an empty card when none of the summaries is selected", async () => {
        // No summaries: the full budget (20) is released and no card is added; 150 drops m0..m4.
        const none = await selectOnly(
            flatScenario("v3exp-trim-no-summaries", 200, {
                algorithm: "v3exp",
                preset: { ...EXPERIMENTAL_HOOKED, memoryTokensRatio: 0.2 },
                chats: makeChats(8),
            }),
        );
        expect(none.prepared.ledger.reservation).toEqual({ kind: "fullBudget", tokens: 20 });
        expect(none.selection.error).toBeUndefined();
        expect(none.selection.chats.map((chat) => chat.memo)).toEqual(["m5", "m6", "m7"]);
        expect(none.selection.currentTokens).toBe(100);
        expect(none.selection.trim!.gap).toEqual({ tokens: 50, messages: 5, memos: ["m0", "m1", "m2", "m3", "m4"] });
        expect(none.selection.memory!.metrics).toBeUndefined();

        // One stored summary (m0, m1) and a budget of 10 that leaves nothing for a summary: the empty
        // card is the memory. 200 − 50 − 20 + 10 = 140; released and settled: 140; m2..m5 go.
        const unselected = await selectOnly(
            flatScenario("v3exp-trim-empty-card", 200, {
                algorithm: "v3exp",
                preset: { ...EXPERIMENTAL_HOOKED, memoryTokensRatio: 0.1 },
                chats: makeChats(8),
                room: { hypaV3Data: { summaries: [stored(["m0", "m1"], "A")] } },
            }),
        );
        expect(unselected.selection.error).toBeUndefined();
        expect(unselected.selection.chats.map((chat) => chat.memo)).toEqual(["supaMemory", "m6", "m7"]);
        expect(unselected.selection.chats[0].content).toBe(EMPTY_CARD);
        expect(unselected.selection.currentTokens).toBe(100);
        expect(unselected.selection.trim).toEqual({
            gap: { tokens: 40, messages: 4, memos: ["m2", "m3", "m4", "m5"] },
            protected: { count: 2, memos: ["m6", "m7"] },
        });
        expect(unselected.selection.memory!.metrics).toEqual({
            lastImportantSummaries: [],
            lastRecentSummaries: [],
            lastSimilarSummaries: [],
            lastRandomSummaries: [],
        });
    });

    it("standard: the similarity correction's query is returned and a selection given it makes no correction request", async () => {
        const scenario = scenarioNamed("v3-similarity-correction");
        const { world, host, prepared, execution, executeRequests } = await runParts(scenario);
        const first = await selectHypaV3(host, prepared, execution, {});
        expect(first.error).toBeUndefined();
        expect(world.log.requests).toHaveLength(executeRequests + 1);
        expect(typeof first.correction).toBe("string");
        const { correction, ...rest } = first;
        expect(normalize(rest)).toEqual(fixture.cases[scenario.name].result);

        const second = await selectHypaV3(host, prepared, execution, { correction });
        expect(world.log.requests).toHaveLength(executeRequests + 1);
        expect(normalize(second)).toEqual(normalize(first));
    });
});

describe("prepare options and lookahead planning", () => {
    it("cleanup: false keeps a summary whose messages are absent from a stale input and sets coverageAhead", async () => {
        const room = { hypaV3Data: { summaries: [stored(["m0", "m1"], "A")] } };
        const scenario = flatScenario("v3-stale-input", 100, { chats: makeChats(6).slice(2), room });
        const kept = await setUp(scenario, { prepare: { cleanup: false } });
        expect(kept.prepared.data.summaries.map((summary) => summary.text)).toEqual(["A"]);
        expect(kept.prepared.coverageAhead).toBe(true);
        expect(kept.prepared.startIdx).toBe(0);
        const cleaned = await setUp(scenario, { prepare: {} });
        expect(cleaned.prepared.data.summaries).toEqual([]);
        expect(cleaned.prepared.coverageAhead).toBe(false);
        // Coverage inside the input: not ahead, the cursor after the covered message.
        const covered = await setUp(flatScenario("v3-covered-input", 100, { chats: makeChats(6), room }), {
            prepare: { cleanup: false },
        });
        expect(covered.prepared.coverageAhead).toBe(false);
        expect(covered.prepared.startIdx).toBe(2);
    });

    it("coverageAhead is read off the history entries: an example without a memo never stands for the greeting", async () => {
        // A summary that ends at the greeting (serialized null) and an input whose greeting is gone.
        const room = { hypaV3Data: { summaries: [{ ...stored([], "G"), chatMemos: [null] as never }] } };
        const chats: OpenAIChat[] = [{ role: "user", name: "example_user", content: "An example." }, ...makeChats(4)];
        const scenario = flatScenario("v3-greeting-gone", 100, { chats, room });
        const ahead = await setUp(scenario, { prepare: { cleanup: false } });
        expect(ahead.prepared.coverageAhead).toBe(true);
        expect(ahead.prepared.startIdx).toBe(0);
        // The no-option composition keeps the legacy memo lookup, where the example matches.
        const legacy = await setUp({ ...scenario, preset: { ...HOOKED_PRESET, preserveOrphanedMemory: true } });
        expect(legacy.prepared.coverageAhead).toBe(true);
        expect(legacy.prepared.startIdx).toBe(1);
    });

    it("lookahead plans windows below the context from the full memory budget, with the headroom's trigger and a clamped target", async () => {
        // Twenty messages, a context of 1000, a budget of 200: 710 incoming is 660 with the empty card
        // (670 held), which a plain plan leaves alone; the lookahead count 860 is over 850.
        const base = flatScenario("v3-lookahead", 710, {
            preset: { ...HOOKED_PRESET, memoryTokensRatio: 0.2, extraSummarizationRatio: 0.1 },
            chats: makeChats(20),
            maxContextTokens: 1000,
        });
        expect(HYPAV3_LOOKAHEAD_HEADROOM).toBe(0.15);
        const { prepared, plan } = await setUp(base, { lookahead: true });
        expect(prepared.ledger.current).toBe(670);
        expect((await planHypaV3Summaries(prepared)).stopReason).toBe("notNeeded");
        // Target 750: five windows (860 → 760), the sixth would overshoot.
        expect(plan.stopReason).toBe("nextWindowOvershoots");
        expect(plan.windows).toHaveLength(5);
        expect(plan.predictedTokens).toBe(760);
        expect(plan.windows.every((window) => window.needsLlm)).toBe(true);

        // Exactly at the trigger: nothing to do.
        const atTrigger = await setUp(
            { ...base, name: "v3-lookahead-at-trigger", currentTokens: 700 },
            { lookahead: true },
        );
        expect(atTrigger.plan.stopReason).toBe("notNeeded");

        // A large extra ratio clamps the target at 0: the plan runs to the protected tail without an error.
        const clamped = await setUp(
            { ...base, name: "v3-lookahead-clamped", preset: { ...base.preset, extraSummarizationRatio: 0.9 } },
            { lookahead: true },
        );
        expect(clamped.plan.stopReason).toBe("tailReached");
        expect(clamped.plan.windows).toHaveLength(9);
        expect(clamped.plan.predictedTokens).toBe(680);

        // Over the context with only the tail left: a normal stop with lookahead, the error without.
        const over = { ...base, name: "v3-lookahead-over", currentTokens: 1300 };
        const overLookahead = await setUp(over, { lookahead: true });
        expect(overLookahead.prepared.ledger.reservation.kind).toBe("fullBudget");
        expect(overLookahead.plan.stopReason).toBe("tailReached");
        expect(overLookahead.plan.windows).toHaveLength(9);
        expect(overLookahead.plan.predictedTokens).toBeGreaterThan(1000);
        const plain = await planHypaV3Summaries(overLookahead.prepared);
        expect(plain.stopReason).toBe("cannotSummarizeFurther");
        expect(plain.error).toMatch(/^\[HypaV3\] Cannot summarize further/);
    });
});

describe("warming the summaries' vectors", () => {
    const chunkTexts = (prepared: HypaV3Prepared) =>
        prepared.data.summaries.flatMap((summary) =>
            summary.text
                .split("\n\n")
                .map((chunk) => chunk.trim())
                .filter((chunk) => chunk.length > 0),
        );
    const mentionsChunk = (requests: { body: unknown }[], chunks: string[]) =>
        requests.some((request) => {
            const body = JSON.stringify(request.body);
            return chunks.some((chunk) => body.includes(JSON.stringify(chunk).slice(1, -1)));
        });

    for (const name of ["v3-existing-selection", "v3-voyage-similar-full", "v3exp-existing-voyage-groups"]) {
        it(`${name}: a selection after warming with the same settings embeds no summary document`, async () => {
            const scenario = scenarioNamed(name);
            const world = createWorld(scenario);
            const host = hostOf(scenario, world);
            const chats = structuredClone(scenario.chats);
            const outcome = await prepareHypaV3(
                host,
                chats,
                await defaultCurrentTokens(chats),
                scenario.maxContextTokens,
                structuredClone(scenario.room) as never,
                { tokenizeChat },
            );
            if (!outcome.ok) throw new Error(outcome.result.error);
            const prepared = outcome.prepared;
            const chunks = chunkTexts(prepared);
            expect(chunks.length).toBeGreaterThan(1);

            await warmHypaV3Vectors(host, prepared.data.summaries);
            const warmed = world.log.http.length;
            expect(warmed).toBeGreaterThan(0);
            expect(mentionsChunk(world.log.http, chunks)).toBe(true);

            const selection = await selectHypaV3(host, prepared, emptyHypaV3Execution(prepared));
            expect(selection.error).toBeUndefined();
            expect(selection.memory!.metrics!.lastSimilarSummaries.length).toBeGreaterThan(0);
            const afterWarming = world.log.http.slice(warmed);
            expect(afterWarming.length).toBeGreaterThan(0);
            expect(mentionsChunk(afterWarming, chunks)).toBe(false);

            // The same selection on a cold cache embeds the documents.
            const cold = createWorld(scenario);
            const coldHost = hostOf(scenario, cold);
            const coldSelection = await selectHypaV3(coldHost, prepared, emptyHypaV3Execution(prepared));
            expect(coldSelection.error).toBeUndefined();
            expect(mentionsChunk(cold.log.http, chunks)).toBe(true);
        });
    }

    it("does nothing when the preset selects no similar summaries", async () => {
        const scenario = {
            ...scenarioNamed("v3-existing-selection"),
            preset: { similarMemoryRatio: 0, recentMemoryRatio: 1 },
        };
        const world = createWorld(scenario);
        const host = hostOf(scenario, world);
        const outcome = await prepareHypaV3(
            host,
            structuredClone(scenario.chats),
            100,
            560,
            structuredClone(scenario.room) as never,
            { tokenizeChat },
        );
        if (!outcome.ok) throw new Error(outcome.result.error);
        await warmHypaV3Vectors(host, outcome.prepared.data.summaries);
        expect(world.log.http).toEqual([]);
    });
});
