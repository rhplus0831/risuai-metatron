import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import { installFlatDatabase } from "../../storage/tests/installFlatDatabase";
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

// Phase 5 slice 10: the browser oracle of the memory algorithms. The client code that remains after
// the Phase 5 cutover (`hypav3.ts`, with `hypamemory.ts`, `hypamemoryv2.ts`,
// `contextualEmbedding.ts`, and the rate limiter as they are) runs each HypaV3 scenario (`v3`,
// `v3exp`) of `server/src/tests/fixtures/memory/scenarios.ts` over fake dependencies (deterministic
// tokens, vectors, canned summaries and completions, a fixed random sequence, an in-memory vector
// store, `parseChatML` answering null: the prompts are plain), and the outcome (the result or the
// thrown message, the ordered summary requests, summarizer inputs, completions bodies, embedding
// requests, local model runs, cache keys written, progress payloads, alerts) must equal the recorded
// fixture `algorithms.json`. The server ports are held to the whole fixture by
// `server/src/tests/memoryAlgorithms.test.ts`: the fixture is the client's behavior, never derived
// from server code.
//
// The fixture was recorded from the flag-off client algorithms before the cutover deleted the
// browser SupaMemory, HypaV2, and Hanurai copies; its `supa`, `hyper`, `v2`, and `hanurai` cases now
// have no client runner here, and the fixture is not recorded again from this file (a re-recording
// would lose those cases).

const FIXTURE = path.resolve(import.meta.dirname, "../../../../server/src/tests/fixtures/memory/algorithms.json");

type World = ReturnType<typeof createWorld>;
let current: World;
/** Every `requestChatData` argument, for the P10 context check. */
const requestArgs: Record<string, unknown>[] = [];

// `hypav3.ts` keeps a runtime import of `database.svelte` for its types (inline `type` modifiers);
// nothing is read from it (the settings are the records, installed by `installWorld`).
vi.mock("src/ts/storage/database.svelte", () => ({}));
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
// The fixture helper reaches `src/lang` while the test file's imports still load (`installFlatDatabase`
// imports the chat module), so the factory loads the constant itself instead of reading the import.
vi.mock("src/lang", async () => {
    const { TOO_MUCH_TOKEN } = await import("../../../../server/src/tests/fixtures/memory/scenarios.ts");
    return { language: { errors: { toomuchtoken: TOO_MUCH_TOKEN } } };
});
vi.mock("src/ts/parser/chatML", () => ({ parseChatML: () => null }));
// `hypav3.ts` imports a type from the send pipeline with an inline `type` modifier, which keeps the
// module's side-effect import: the pipeline (and the parser's effects) must not load here.
vi.mock("src/ts/process/index.svelte", () => ({}));

type Fixture = { capturedFrom: string; cases: Record<string, Outcome> };
const fixture: Fixture | null = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture) : null;
/** The scenarios whose client algorithm is still in the tab (HypaV3 and its experimental mode). */
const clientScenarios = scenarios.filter((scenario) => scenario.algorithm === "v3" || scenario.algorithm === "v3exp");

/** The settings with the HypaV3 presets of the scenario (selected by id, after any `presetsBefore`). */
function settingsOf(scenario: Scenario): Record<string, unknown> {
    const before = (scenario.presetsBefore ?? []).map((settings, i) => createHypaV3Preset(`Before ${i}`, settings));
    const selected = createHypaV3Preset("Selected", scenario.preset ?? {});
    return { hypaV3Presets: [...before, selected], hypaV3PresetId: selected.id };
}

/**
 * The world's settings installed into the records (`installFlatDatabase`), since the memory
 * algorithms read the settings through the record views (Phase 6 slice 7). They are the flat shape
 * the server ports read: the root preset fields become the one preset's.
 */
function installWorld(world: World) {
    installFlatDatabase(world.db, "oracle-preset");
}

async function runClient(scenario: Scenario): Promise<Outcome> {
    const world = createWorld(scenario);
    Object.assign(world.db, settingsOf(scenario));
    installWorld(world);
    current = world;
    vi.spyOn(Math, "random").mockImplementation(() => world.random());
    const { hypaMemoryV3 } = await import("./hypav3");
    const chats = structuredClone(scenario.chats);
    const currentTokens = scenario.currentTokens ?? (await defaultCurrentTokens(chats));
    const tokenizer = { tokenizeChat } as never;
    const room = structuredClone(scenario.room) as never;
    const char = { ...scenario.char } as never;
    try {
        const result = await hypaMemoryV3(chats, currentTokens, scenario.maxContextTokens, room, char, tokenizer);
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
        expect(fixture, "the fixture exists").not.toBeNull();
        expect(Object.keys(fixture!.cases).sort()).toEqual(scenarios.map((scenario) => scenario.name).sort());
        expect(clientScenarios.length).toBeGreaterThan(0);
    });

    for (const scenario of clientScenarios) {
        it(`${scenario.name}: the client's outcome is the fixture's`, async () => {
            const outcome = await runClient(scenario);
            expect(outcome).toEqual(fixture!.cases[scenario.name]);
        });
    }
});

describe("GEN-03: the modal's contextual summary vectors", () => {
    const shared = "Shared paragraph.";
    const cases = [
        {
            name: "keeps identical paragraphs in different contexts separate, cold and warm",
            groups: [
                [shared, "Context B."],
                [shared, "Context A."],
            ],
            vectors: [
                [
                    [0, 1],
                    [0, 1],
                ],
                [
                    [1, 0],
                    [0, 1],
                ],
            ],
        },
        {
            name: "uses the last stored vector for both repeated positions in one summary, cold and warm",
            groups: [
                [shared, shared],
                ["Other paragraph.", "Another paragraph."],
            ],
            vectors: [
                [
                    [1, 0],
                    [0, 1],
                ],
                [
                    [0.6, 0.8],
                    [0.6, 0.8],
                ],
            ],
        },
    ];

    for (const { name, groups, vectors } of cases) {
        it(name, async () => {
            const texts = groups.map((group) => group.join("\n\n"));
            const scenario: Scenario = {
                name,
                algorithm: "v3",
                settings: { hypaModel: "voyageContext3" },
                preset: {
                    useExperimentalImpl: false,
                    preserveOrphanedMemory: true,
                    recentMemoryRatio: 0,
                    similarMemoryRatio: 1,
                    memoryTokensRatio: 0.1,
                    queryChatCount: 1,
                    summaryChunkSeparator: "\\n\\n",
                },
                chats: [{ role: "user", content: "Query", memo: "current" }],
                room: {
                    hypaV3Data: {
                        summaries: texts.map((text) => ({ text, chatMemos: [], isImportant: false, tags: [] })),
                    },
                },
                char: { type: "character", name: "Mira" },
                maxContextTokens: 1000,
            };
            const world = createWorld(scenario);
            const http = vi.spyOn(world, "http").mockImplementation(async (_url, body) => ({
                ok: true,
                status: 200,
                data: {
                    data: body.inputs.map((group: string[]) => ({
                        data: group.map((_text, position) => ({
                            embedding:
                                body.input_type === "query"
                                    ? [1, 0]
                                    : vectors[texts.indexOf(group.join("\n\n"))][position],
                        })),
                    })),
                },
            }));
            Object.assign(world.db, settingsOf(scenario));
            installWorld(world);
            current = world;
            const { hypaMemoryV3 } = await import("./hypav3");

            for (const cacheState of ["cold", "warm"]) {
                http.mockClear();
                // Fresh input and processor each time; the same fake LocalForage survives.
                const result = await hypaMemoryV3(
                    structuredClone(scenario.chats),
                    100,
                    scenario.maxContextTokens,
                    structuredClone(scenario.room) as never,
                    scenario.char as never,
                    { tokenizeChat: async ({ content }) => content.length } as never,
                );
                expect(result.error).toBeUndefined();
                // Query [1,0] favors A. Repeated positions share the last [0,1] vector,
                // so both lose to A's [0.6,0.8]. The length budget fits exactly one summary.
                expect.soft(result.memory?.metrics?.lastSimilarSummaries, cacheState).toEqual([1]);
                expect.soft(result.chats[0].content, cacheState).toContain(texts[1]);
                expect.soft(result.chats[0].content, cacheState).not.toContain(texts[0]);
                const documents = http.mock.calls.filter(([, body]) => body.input_type === "document");
                expect(documents, cacheState).toHaveLength(cacheState === "cold" ? 1 : 0);
                if (cacheState === "cold") {
                    expect(documents[0][1].inputs).toEqual(groups);
                }
            }
            expect(world.log.requests).toEqual([]);
        });
    }
});

describe("P10: the summary requests carry the send's or the action's context", () => {
    const byName = (name: string) => scenarios.find((scenario) => scenario.name === name)!;
    const context = {
        chatRef: { chaId: "c-1", chatId: "k-1" },
        pluginContext: { presetId: "p-1", modelPresetId: "m-1", personaId: "u-1" },
    } as never;

    async function runV3(scenario: Scenario, ctx?: unknown) {
        const world = createWorld(scenario);
        Object.assign(world.db, settingsOf(scenario));
        installWorld(world);
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
                    pluginContext: { presetId: "p-1", modelPresetId: "m-1", personaId: "u-1" },
                });
            }
        });
    }

    it("sends neither key without a context (the modal's callers before P10, and `summarize` on its own); a chat alone gets its context captured", async () => {
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
        expect("pluginContext" in requestArgs[0]).toBe(false);
        // A context with the chat alone: `summarize` captures the chat's plugin context once
        // (`docs/plan/chat-binding.md`, slice 4) and the request carries it. The chat is not held
        // here, so its display ids are the tab's.
        const { tabSelectionIds } = await import("src/ts/storage/settingsViews.svelte");
        await summarize([{ role: "user", content: "x" }], true, { chatRef: { chaId: "c", chatId: "k" } } as never);
        expect(requestArgs[1]).toMatchObject({
            chatRef: { chaId: "c", chatId: "k" },
            pluginContext: { chatRef: { chaId: "c", chatId: "k" }, ...tabSelectionIds() },
        });
    });
});
