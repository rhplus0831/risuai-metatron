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
import { hanuraiMemory } from "../prompt/memory/hanurai.ts";
import type { MemoryHost } from "../prompt/memory/host.ts";
import { hypaMemoryV2 } from "../prompt/memory/hypav2.ts";
import { hypaMemoryV3, LOCAL_SUMMARIZATION_UNSUPPORTED } from "../prompt/memory/hypav3.ts";
import { supaMemory } from "../prompt/memory/supaMemory.ts";
import { runRegexOp } from "../scripts/worker.ts";
import {
    countTokens,
    createWorld,
    defaultCurrentTokens,
    makeChats,
    type Outcome,
    type Scenario,
    scenarios,
    TOO_MUCH_TOKEN,
    tokenizeChat,
    USER_NAME,
} from "./fixtures/memory/scenarios.ts";

// Phase 5 slice 10: the server memory ports (`server/src/prompt/memory/*`, over `embeddings.ts`)
// against the browser-captured fixture `fixtures/memory/algorithms.json`, which
// `src/ts/process/memory/memoryOracle.test.ts` records from the flag-off client code and verifies on
// every run. Each scenario runs the port on a `MemoryHost` bound to the same fake world (the token
// counts, vectors, canned answers, random sequence, and vector store the client mocks are bound to),
// and its outcome must equal the client's: the result or the thrown message, the ordered summary
// requests, summarizer inputs, completions bodies, embedding requests, local model runs, cache keys
// written, progress payloads, and alerts. A difference is a parity defect to attribute, never a
// fixture to recapture from the server. Beside the fixture: the server-only refusal of HypaV3's
// WebLLM summarization models, and the host's fence and signal reaching the algorithms.

const FIXTURE = path.join(import.meta.dirname, "fixtures/memory/algorithms.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { capturedFrom: string; cases: Record<string, Outcome> };

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

function hostOf(
    scenario: Scenario,
    world: World,
    options: { signal?: AbortSignal; fence?: () => void; parseChatML?: MemoryHost["parseChatML"] } = {},
): MemoryHost {
    const before = (scenario.presetsBefore ?? []).map((settings, i) => createHypaV3Preset(`Before ${i}`, settings));
    const selected = createHypaV3Preset("Selected", scenario.preset ?? {});
    Object.assign(world.db, { hypaV3Presets: [...before, selected], hypaV3PresetId: selected.id });
    const signal = options.signal ?? new AbortController().signal;
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
    return {
        db: world.db as unknown as Database,
        tokenize: async (text) => countTokens(text),
        // The runner's `request` checks the run after the answer (`setup.check()`): the fence here.
        request: async (formated) => {
            const answer = (await world.request(formated)) as requestDataResponse;
            options.fence?.();
            return answer;
        },
        completions: (body) => world.completions(body),
        summarizer: (text) => world.summarizer(text),
        embeddings,
        regex: async (op) => runRegexOp(op),
        parseChatML: options.parseChatML ?? (() => null),
        userName: () => USER_NAME,
        progress: (payload) => world.progress(payload),
        random: () => world.random(),
        redact: (text) => text,
        fence: options.fence ?? (() => {}),
        signal,
    };
}

async function runServer(scenario: Scenario, options: Parameters<typeof hostOf>[2] = {}): Promise<Outcome> {
    const world = createWorld(scenario);
    const host = hostOf(scenario, world, options);
    const chats = structuredClone(scenario.chats);
    const currentTokens = scenario.currentTokens ?? (await defaultCurrentTokens(chats));
    const tokenizer = { tokenizeChat };
    const room = structuredClone(scenario.room) as never;
    const char = { ...scenario.char } as never;
    try {
        let result: unknown;
        switch (scenario.algorithm) {
            case "supa":
            case "hyper":
                result = await supaMemory(
                    host,
                    chats,
                    currentTokens,
                    scenario.maxContextTokens,
                    room,
                    char,
                    tokenizer,
                    {
                        asHyper: scenario.algorithm === "hyper",
                    },
                );
                break;
            case "v2":
                result = await hypaMemoryV2(
                    host,
                    chats,
                    currentTokens,
                    scenario.maxContextTokens,
                    room,
                    char,
                    tokenizer,
                );
                break;
            case "v3":
            case "v3exp":
                result = await hypaMemoryV3(
                    host,
                    chats,
                    currentTokens,
                    scenario.maxContextTokens,
                    room,
                    char,
                    tokenizer,
                );
                break;
            case "hanurai": {
                const answer = await hanuraiMemory(host, chats, {
                    currentTokens,
                    maxContextTokens: scenario.maxContextTokens,
                    tokenizer,
                    tooMuchToken: TOO_MUCH_TOKEN,
                });
                // The client alerts and returns false where the port returns the alert's text.
                if ("alert" in answer) {
                    world.alert(answer.alert);
                    result = false;
                } else {
                    result = answer;
                }
                break;
            }
        }
        return world.snapshot(result);
    } catch (error) {
        return world.snapshot(undefined, error);
    }
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("the server ports against the browser fixture", () => {
    it("covers every scenario the fixture holds", () => {
        expect(Object.keys(fixture.cases).sort()).toEqual(scenarios.map((scenario) => scenario.name).sort());
        expect(fixture.capturedFrom).toMatch(/client algorithms/);
    });

    for (const scenario of scenarios) {
        it(`${scenario.name}: the port's outcome is the browser's`, async () => {
            expect(await runServer(scenario)).toEqual(fixture.cases[scenario.name]);
        });
    }

    it("exercises what the fixture is meant to pin (not every scenario ends the same way)", () => {
        const cases = fixture.cases;
        const requests = (name: string) => cases[name].requests.length;
        // Summaries were requested, written, and persisted.
        expect(requests("supa-cold-overflow")).toBeGreaterThan(0);
        expect(typeof (cases["supa-cold-overflow"].result as { memory?: unknown }).memory).toBe("string");
        expect(requests("hyper-cold-overflow")).toBeGreaterThan(0);
        expect(requests("v2-cold-overflow")).toBeGreaterThan(0);
        expect(requests("v3-cold-overflow")).toBeGreaterThan(1);
        expect(requests("v3exp-cold-overflow")).toBeGreaterThan(1);
        expect(cases["v3exp-cold-overflow"].progress.length).toBeGreaterThan(0);
        // The provider paths: completions, the local summarizer, embeddings over HTTP and the local model.
        expect(cases["supa-instruct-completions"].completions).toHaveLength(1);
        expect(cases["supa-distilbart"].summarizer).toHaveLength(1);
        expect(cases["hyper-existing-data"].http.length).toBeGreaterThan(0);
        expect(cases["hanurai-plain"].embeds.length).toBeGreaterThan(0);
        expect(cases["v3-voyage-similar-full"].cacheKeys.some((key) => key.includes("|voyageContext3"))).toBe(true);
        expect(cases["v3exp-existing-voyage-groups"].cacheKeys.some((key) => key.includes("|ctx:"))).toBe(true);
        // The error paths, with and without a returned memory.
        const v3Partial = cases["v3-partial-then-failure"].result as {
            error?: string;
            memory?: { summaries: unknown[] };
        };
        expect(v3Partial.error).toMatch(/Summarization failed/);
        expect(v3Partial.memory?.summaries).toHaveLength(1);
        expect((cases["v2-repeated-failure"].result as { error?: string; memory?: unknown }).memory).toBeUndefined();
        expect((cases["supa-summary-fails"].result as { error?: string }).error).toMatch(/^SupaMemory: HTTP: /);
        expect((cases["supa-distilbart-fails"].result as { error?: string }).error).toMatch(
            /^SupaMemory: Summarizer: /,
        );
        expect(cases["hanurai-exhaustion"].result).toBe(false);
        expect(cases["hanurai-exhaustion"].alerts).toEqual([expect.stringContaining(TOO_MUCH_TOKEN)]);
        // The preset is selected by id: the second preset's six chats per summary gave one summary.
        expect(requests("v3-preset-by-id")).toBe(1);
    });
});

describe("what the server adds to the algorithms", () => {
    const overflow: Scenario = {
        name: "v3-mlc",
        algorithm: "v3",
        preset: { summarizationModel: "Qwen3-0.6B-q4f16_1-MLC", maxChatsPerSummary: 4, queryChatCount: 3 },
        chats: makeChats(18),
        room: {},
        char: { type: "character", name: "Mira" },
        maxContextTokens: 400,
    };

    it("refuses HypaV3's WebLLM summarization models where a summary is needed, keeping the memory, and serves a send that needs none", async () => {
        const refused = await runServer(overflow);
        expect((refused.result as { error: string }).error).toContain(LOCAL_SUMMARIZATION_UNSUPPORTED);
        expect((refused.result as { memory: { summaries: unknown[] } }).memory.summaries).toEqual([]);
        expect(refused.requests).toEqual([]);
        const fits = await runServer({ ...overflow, maxContextTokens: 5000 });
        expect((fits.result as { error?: string }).error).toBeUndefined();
        expect((fits.result as { chats: OpenAIChat[] }).chats[0].memo).toBe("supaMemory");
    });

    it("lets the host's fence end the algorithm instead of turning the abort into a returned error", async () => {
        // The job ends while the second summary is answered: the port's catch fences before it would
        // return `Summarization failed` with the first summary as memory, so the abort propagates.
        const controller = new AbortController();
        let requests = 0;
        const outcome = await runServer(
            { ...scenarios.find((scenario) => scenario.name === "v3-cold-overflow")!, name: "v3-aborted" },
            {
                signal: controller.signal,
                fence: () => {
                    if (++requests === 2) {
                        controller.abort(new Error("the job ended"));
                    }
                    if (controller.signal.aborted) {
                        throw controller.signal.reason;
                    }
                },
            },
        );
        expect(outcome.thrown).toBe("the job ended");
        expect(outcome.result).toBeUndefined();
        expect(outcome.requests).toHaveLength(2);
        // Without the abort, the same failure point is the algorithm's error with the memory so far.
        const failed = await runServer({
            ...scenarios.find((scenario) => scenario.name === "v3-cold-overflow")!,
            name: "v3-second-fails",
            summaries: ["First summary.", { fail: "down" }],
        });
        expect((failed.result as { error: string }).error).toMatch(/Summarization failed/);
        expect((failed.result as { memory: { summaries: unknown[] } }).memory.summaries).toHaveLength(1);
    });

    it("gives the ChatML parser the summary prompt with the slot filled", async () => {
        const seen: string[] = [];
        const outcome = await runServer(
            {
                ...scenarios.find((scenario) => scenario.name === "supa-cold-overflow")!,
                name: "supa-chatml",
                settings: {
                    supaMemoryPrompt: "<|im_start|>system\nSummarize.<|im_end|>\n<|im_start|>user\n{{slot}}<|im_end|>",
                },
            },
            {
                parseChatML: (text) => {
                    seen.push(text);
                    return [
                        { role: "system", content: "Summarize." },
                        { role: "user", content: "parsed" },
                    ];
                },
            },
        );
        expect(seen).toHaveLength(1);
        // The slot holds the stringlized chat: each message under its speaker's name.
        expect(seen[0]).toMatch(
            /^<\|im_start\|>system\nSummarize\.<\|im_end\|>\n<\|im_start\|>user\nUser: Message 0: /,
        );
        expect(seen[0]).toContain("\n\nMira: Message 1: ");
        expect(seen[0]).not.toContain("{{slot}}");
        expect(outcome.requests).toEqual([
            [
                { role: "system", content: "Summarize." },
                { role: "user", content: "parsed" },
            ],
        ]);
    });
});
