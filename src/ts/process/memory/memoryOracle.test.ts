import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import {
    countTokens,
    createWorld,
    defaultCurrentTokens,
    type Outcome,
    type Scenario,
    scenarios,
    TOO_MUCH_TOKEN,
    tokenizeChat,
    USER_NAME,
} from "../../../../server/src/tests/fixtures/memory/scenarios.ts";

// Phase 5 slice 10: the browser oracle of the memory algorithms. The flag-off client code
// (`supaMemory.ts`, `hypav2.ts`, `hypav3.ts`, `hanuraiMemory.ts`, with `hypamemory.ts`,
// `hypamemoryv2.ts`, `contextualEmbedding.ts`, and the rate limiter as they are) runs each scenario
// of `server/src/tests/fixtures/memory/scenarios.ts` over fake dependencies (deterministic tokens,
// vectors, canned summaries and completions, a fixed random sequence, an in-memory vector store,
// `parseChatML` answering null: the prompts are plain), and the outcome (the result or the thrown
// message, the ordered summary requests, summarizer inputs, completions bodies, embedding requests,
// local model runs, cache keys written, progress payloads, alerts) must equal the recorded fixture
// `algorithms.json`. The server ports are held to the same fixture by
// `server/src/tests/memoryAlgorithms.test.ts`: the fixture is the client's behavior, never derived
// from server code.
//
// To record it again after an intended client change: `CAPTURE_MEMORY_FIXTURE=1 pnpm exec vitest run
// src/ts/process/memory/memoryOracle.test.ts`, then `pnpm format` (the fixture is checked by Prettier)
// and review the diff of `algorithms.json`.

const FIXTURE = path.resolve(import.meta.dirname, "../../../../server/src/tests/fixtures/memory/algorithms.json");
const CAPTURE = process.env.CAPTURE_MEMORY_FIXTURE === "1";

type World = ReturnType<typeof createWorld>;
let current: World;
/** Every `requestChatData` argument, for the P10 context check. */
const requestArgs: Record<string, unknown>[] = [];

vi.mock("src/ts/storage/database.svelte", () => ({ getDatabase: () => current.db }));
vi.mock("src/ts/process/request/request", () => ({
    requestChatData: (arg: { formated: unknown[] }) => {
        requestArgs.push(arg);
        return current.request(arg.formated as never);
    },
}));
vi.mock("src/ts/process/webllm", () => ({
    chatCompletion: async () => {
        throw new Error("WebLLM is not available here");
    },
    unloadEngine: async () => {},
}));
vi.mock("src/ts/stores.svelte", () => ({
    hypaV3ProgressStore: { set: (payload: unknown) => current.progress(payload) },
}));
vi.mock("src/ts/tokenizer", () => ({ tokenize: async (text: string) => countTokens(text) }));
vi.mock("src/ts/process/transformers", () => ({
    runEmbedding: (texts: string[], model: string) => current.embed(texts, model),
    runSummarizer: (text: string) => current.summarizer(text),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    globalFetch: (url: string, arg: { body: unknown }) => current.http(url, arg.body),
}));
vi.mock("src/ts/network/auxFetch", () => ({
    auxFetchJson: (_op: string, url: string, init: { body: unknown }) =>
        url.includes("/v1/completions") ? current.completions(init.body) : current.http(url, init.body),
}));
vi.mock("localforage", () => ({
    default: {
        createInstance: () => ({
            getItem: async (key: string) => current.cache.get(key),
            setItem: async (key: string, value: unknown) => current.cache.set(key, value),
        }),
    },
}));
vi.mock("src/ts/util", () => ({
    getUserName: () => USER_NAME,
    appendLastPath: (url: string, lastPath: string) => url.replace(/\/$/, "") + "/" + lastPath.replace(/^\//, ""),
}));
vi.mock("src/ts/platform", () => ({ isMobile: false }));
vi.mock("src/ts/alert", () => ({ alertError: (text: string) => current.alert(text) }));
vi.mock("src/lang", () => ({ language: { errors: { toomuchtoken: TOO_MUCH_TOKEN } } }));
vi.mock("src/ts/parser/chatML", () => ({ parseChatML: () => null }));
// `hypav3.ts` imports a type from the send pipeline with an inline `type` modifier, which keeps the
// module's side-effect import: the pipeline (and the parser's effects) must not load here.
vi.mock("src/ts/process/index.svelte", () => ({}));

type Fixture = { capturedFrom: string; cases: Record<string, Outcome> };
const fixture: Fixture | null = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture) : null;
const captured: Record<string, Outcome> = {};

/** The settings with the HypaV3 presets of the scenario (selected by id, after any `presetsBefore`). */
function settingsOf(scenario: Scenario): Record<string, unknown> {
    const before = (scenario.presetsBefore ?? []).map((settings, i) => createHypaV3Preset(`Before ${i}`, settings));
    const selected = createHypaV3Preset("Selected", scenario.preset ?? {});
    return { hypaV3Presets: [...before, selected], hypaV3PresetId: selected.id };
}

async function runClient(scenario: Scenario): Promise<Outcome> {
    const world = createWorld(scenario);
    Object.assign(world.db, settingsOf(scenario));
    current = world;
    vi.spyOn(Math, "random").mockImplementation(() => world.random());
    const { supaMemory } = await import("./supaMemory");
    const { hypaMemoryV2 } = await import("./hypav2");
    const { hypaMemoryV3 } = await import("./hypav3");
    const { hanuraiMemory } = await import("./hanuraiMemory");
    const chats = structuredClone(scenario.chats);
    const currentTokens = scenario.currentTokens ?? (await defaultCurrentTokens(chats));
    const tokenizer = { tokenizeChat } as never;
    const room = structuredClone(scenario.room) as never;
    const char = { ...scenario.char } as never;
    try {
        let result: unknown;
        switch (scenario.algorithm) {
            case "supa":
            case "hyper":
                result = await supaMemory(chats, currentTokens, scenario.maxContextTokens, room, char, tokenizer, {
                    asHyper: scenario.algorithm === "hyper",
                });
                break;
            case "v2":
                result = await hypaMemoryV2(chats, currentTokens, scenario.maxContextTokens, room, char, tokenizer);
                break;
            case "v3":
            case "v3exp":
                result = await hypaMemoryV3(chats, currentTokens, scenario.maxContextTokens, room, char, tokenizer);
                break;
            case "hanurai":
                result = await hanuraiMemory(chats, {
                    currentTokens,
                    maxContextTokens: scenario.maxContextTokens,
                    tokenizer,
                });
                break;
        }
        return world.snapshot(result);
    } catch (error) {
        return world.snapshot(undefined, error);
    }
}

beforeEach(() => {
    requestArgs.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("the browser memory algorithms against the recorded fixture", () => {
    it("names every scenario once", () => {
        expect(new Set(scenarios.map((scenario) => scenario.name)).size).toBe(scenarios.length);
        if (!CAPTURE) {
            expect(fixture, "the fixture exists (capture it with CAPTURE_MEMORY_FIXTURE=1)").not.toBeNull();
            expect(Object.keys(fixture!.cases).sort()).toEqual(scenarios.map((scenario) => scenario.name).sort());
        }
    });

    for (const scenario of scenarios) {
        it(`${scenario.name}: the client's outcome is the fixture's`, async () => {
            const outcome = await runClient(scenario);
            captured[scenario.name] = outcome;
            if (CAPTURE) {
                return;
            }
            expect(outcome).toEqual(fixture!.cases[scenario.name]);
        });
    }

    it("writes the fixture when capturing", () => {
        if (!CAPTURE) {
            return;
        }
        expect(Object.keys(captured)).toHaveLength(scenarios.length);
        const ordered: Record<string, Outcome> = {};
        for (const scenario of scenarios) {
            ordered[scenario.name] = captured[scenario.name];
        }
        writeFileSync(
            FIXTURE,
            JSON.stringify(
                {
                    capturedFrom:
                        "the flag-off client algorithms (src/ts/process/memory) as committed at 3f5416d5, run by memoryOracle.test.ts with CAPTURE_MEMORY_FIXTURE=1 on 2026-10-03",
                    cases: ordered,
                },
                null,
                2,
            ) + "\n",
        );
    });
});

describe("P10: the summary requests carry the send's or the action's context", () => {
    const byName = (name: string) => scenarios.find((scenario) => scenario.name === name)!;
    const context = {
        chatRef: { chaId: "c-1", chatId: "k-1" },
        pluginContext: { presetId: "p-1", personaId: "u-1" },
    } as never;

    async function runV3(scenario: Scenario, ctx?: unknown) {
        const world = createWorld(scenario);
        Object.assign(world.db, settingsOf(scenario));
        current = world;
        vi.spyOn(Math, "random").mockImplementation(() => world.random());
        const { hypaMemoryV3 } = await import("./hypav3");
        const chats = structuredClone(scenario.chats);
        return await hypaMemoryV3(
            chats,
            scenario.currentTokens ?? (await defaultCurrentTokens(chats)),
            scenario.maxContextTokens,
            structuredClone(scenario.room) as never,
            { ...scenario.char } as never,
            { tokenizeChat } as never,
            ctx as never,
        );
    }

    for (const [label, name] of [
        ["the standard implementation's summaries", "v3-cold-overflow"],
        ["the similarity-correction summary", "v3-similarity-correction"],
        ["the experimental batch", "v3exp-cold-overflow"],
    ] as const) {
        it(`passes chatRef and pluginContext to ${label}, with the memory mode and the fixed request flags`, async () => {
            await runV3(byName(name), context);
            expect(requestArgs.length).toBeGreaterThan(0);
            for (const arg of requestArgs) {
                expect(arg).toMatchObject({
                    bias: {},
                    useStreaming: false,
                    noMultiGen: true,
                    chatRef: { chaId: "c-1", chatId: "k-1" },
                    pluginContext: { presetId: "p-1", personaId: "u-1" },
                });
            }
        });
    }

    it("sends neither key without a context (the modal's callers before P10, and `summarize` on its own)", async () => {
        await runV3(byName("v3-cold-overflow"));
        expect(requestArgs.length).toBeGreaterThan(0);
        for (const arg of requestArgs) {
            expect("chatRef" in arg).toBe(false);
            expect("pluginContext" in arg).toBe(false);
        }
        requestArgs.length = 0;
        const { summarize } = await import("./hypav3");
        await summarize([{ role: "user", content: "x" }], false, { chatRef: null });
        expect("chatRef" in requestArgs[0]).toBe(false);
        await summarize([{ role: "user", content: "x" }], true, { chatRef: { chaId: "c", chatId: "k" } } as never);
        expect(requestArgs[1]).toMatchObject({ chatRef: { chaId: "c", chatId: "k" } });
        expect("pluginContext" in requestArgs[1]).toBe(false);
    });
});
