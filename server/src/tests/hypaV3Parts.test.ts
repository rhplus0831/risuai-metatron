// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../../shared/database.ts";
import { createHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type { CachedVector, VectorCache } from "../data/vectorCache.ts";
import type { requestDataResponse } from "../llm/request.ts";
import { createEmbeddings } from "../prompt/embeddings.ts";
import type { MemoryHost, MemoryTokenizer } from "../prompt/memory/host.ts";
import {
    executeHypaV3Plan,
    type HypaV3ExecutionResult,
    type HypaV3Plan,
    type HypaV3Prepared,
    type HypaV3Result,
    hypaMemoryV3,
    planHypaV3Summaries,
    prepareHypaV3,
    selectHypaV3,
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
