// The memory-algorithm parity scenarios (Phase 5 slice 10), shared by the browser oracle
// (`src/ts/process/memory/memoryOracle.test.ts`, which runs the client algorithms and captures or
// verifies `algorithms.json`) and the server test (`server/src/tests/memoryAlgorithms.test.ts`, which
// runs the ports against the same fixture). This module is pure: no client or server import, only
// shared types and the fake world both sides bind their dependencies to (deterministic token counts,
// vectors, summaries, random values, and a log of every outward call).
//
// Not a test file: Vitest runs `*.test.ts` only.

import type { HypaV3Settings } from "../../../../../shared/memory.ts";
import type { OpenAIChat } from "../../../../../shared/openai.ts";

export type Answer = string | { fail: string };

export type Scenario = {
    name: string;
    algorithm: "supa" | "hyper" | "v2" | "v3" | "v3exp" | "hanurai";
    /** Settings over `BASE_SETTINGS` (the fields the algorithms read from the database). */
    settings?: Record<string, unknown>;
    /** The selected HypaV3 preset's settings over the defaults (`createHypaV3Preset`). */
    preset?: Partial<HypaV3Settings>;
    /** More presets before the selected one (the selection is by id, not position). */
    presetsBefore?: Partial<HypaV3Settings>[];
    chats: OpenAIChat[];
    room: Record<string, unknown>;
    char: { type: "character" | "group"; name: string };
    maxContextTokens: number;
    /** Default: the sum of `tokenizeChat` over the chats plus 40 (a prompt's share). */
    currentTokens?: number;
    /** The summary model's answers, in request order (the `memory` requests). */
    summaries?: Answer[];
    /** The local summarizer's answers (`distilbart`). */
    summarizer?: Answer[];
    /** The OpenAI completions answers (`instruct35`), as `{ ok, data }`. */
    completions?: { ok: boolean; data: unknown }[];
};

export const BASE_SETTINGS = {
    maxResponse: 50,
    supaModelType: "subModel",
    supaMemoryPrompt: "",
    maxSupaChunkSize: 1200,
    removePunctuationHypa: false,
    hypaMemory: false,
    hypaModel: "custom",
    hypaCustomSettings: { url: "http://embed.test/v1", key: "custom-key", model: "em" },
    voyageApiKey: "voyage-key",
    hypaAllocatedTokens: 300,
    hypaChunkSize: 400,
    hanuraiTokens: 200,
    hanuraiSplit: false,
    username: "User",
};

export const USER_NAME = "User";
export const TOO_MUCH_TOKEN = "Too many tokens for this chat.";

/** `Math.ceil(length / 4)`: the plain-text count both sides bind `tokenize` to. */
export const countTokens = (text: string): number => Math.ceil(text.length / 4);
/** The chat tokenizer: the content's count plus three. */
export const tokenizeChat = async (chat: OpenAIChat): Promise<number> => countTokens(chat.content) + 3;

const WORDS = [
    "river",
    "lantern",
    "silent",
    "orchard",
    "copper",
    "meadow",
    "whisper",
    "harbor",
    "ember",
    "willow",
    "gravel",
    "saffron",
];

/** `n` messages alternating user and assistant, with memos `m0..`, varied lengths, and a paragraph break in every fifth. */
export function makeChats(n: number, options: { paragraphs?: boolean } = {}): OpenAIChat[] {
    const chats: OpenAIChat[] = [];
    for (let i = 0; i < n; i++) {
        const words = 6 + ((i * 7) % 11);
        const parts: string[] = [];
        for (let w = 0; w < words; w++) {
            parts.push(WORDS[(i * 3 + w * 5) % WORDS.length]);
        }
        let content = `Message ${i}: ${parts.join(" ")}.`;
        if (options.paragraphs && i % 5 === 4) {
            content += `\n\nSecond paragraph of ${i}: ${parts.slice(0, 4).join(" ")}.`;
        }
        chats.push({ role: i % 2 === 0 ? "user" : "assistant", content, memo: `m${i}` });
    }
    return chats;
}

export async function defaultCurrentTokens(chats: OpenAIChat[]): Promise<number> {
    let total = 40;
    for (const chat of chats) {
        total += await tokenizeChat(chat);
    }
    return total;
}

/** A deterministic 4-dimension vector per text (distinct texts give distinct, untied vectors). */
export function textVector(text: string): number[] {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b + c, 0x9e3779b1) >>> 0;
    }
    const v = [
        0.5 + (a % 1000) / 1000,
        0.5 + (b % 1000) / 1000,
        0.1 + ((a >>> 10) % 1000) / 1000,
        0.1 + ((b >>> 10) % 1000) / 1000,
    ];
    const norm = Math.hypot(...v);
    return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

const RANDOM_SEQUENCE = [0.71, 0.13, 0.58, 0.92, 0.34, 0.47, 0.05, 0.86, 0.29, 0.63];

export type Outcome = {
    result?: unknown;
    thrown?: string;
    /** The `memory` requests (their messages), in order. */
    requests: OpenAIChat[][];
    /** The local summarizer's inputs. */
    summarizer: string[];
    /** The completions bodies. */
    completions: unknown[];
    /** The embedding HTTP requests (`url`, `body`). */
    http: { url: string; body: unknown }[];
    /** The local model's runs. */
    embeds: { model: string; texts: string[] }[];
    /** The cache keys written, sorted. */
    cacheKeys: string[];
    progress: unknown[];
    alerts: string[];
};

/**
 * One scenario's fake world: what the client mocks and the server `MemoryHost` are bound to. Every
 * outward call is logged; `snapshot(result)` normalizes the outcome for the fixture.
 */
export function createWorld(scenario: Scenario) {
    const log: Omit<Outcome, "result" | "thrown" | "cacheKeys"> & { cacheKeys: Set<string> } = {
        requests: [],
        summarizer: [],
        completions: [],
        http: [],
        embeds: [],
        cacheKeys: new Set(),
        progress: [],
        alerts: [],
    };
    let summaryIndex = 0;
    let summarizerIndex = 0;
    let completionsIndex = 0;
    let randomIndex = 0;
    const cache = new Map<string, unknown>();

    const answerOf = (answers: Answer[] | undefined, index: number): Answer =>
        answers?.[index] ?? `Summary ${index + 1}: the events so far, in short.\n\nDetail ${index + 1}.`;

    const world = {
        db: { ...BASE_SETTINGS, ...(scenario.settings ?? {}) } as Record<string, unknown>,
        log,
        /** `requestChatData(..., "memory")`: the next canned summary, or a failure. */
        async request(formated: OpenAIChat[]): Promise<{ type: "success" | "fail"; result: string }> {
            log.requests.push(structuredClone(formated));
            const answer = answerOf(scenario.summaries, summaryIndex++);
            return typeof answer === "string"
                ? { type: "success", result: answer }
                : { type: "fail", result: answer.fail };
        },
        async summarizer(text: string): Promise<string> {
            log.summarizer.push(text);
            const answer = answerOf(scenario.summarizer, summarizerIndex++);
            if (typeof answer === "string") {
                return answer;
            }
            throw new Error(answer.fail);
        },
        async completions(body: unknown): Promise<{ ok: boolean; data: unknown }> {
            log.completions.push(structuredClone(body));
            const answer = scenario.completions?.[completionsIndex++];
            return answer ?? { ok: true, data: { choices: [{ text: `Instruct summary ${completionsIndex}.` }] } };
        },
        /** The embedding servers: Voyage groups (`inputs`) or the OpenAI-compatible `input`. */
        async http(url: string, body: any): Promise<{ ok: boolean; data: unknown; status: number }> {
            log.http.push({ url, body: structuredClone(body) });
            if (Array.isArray(body?.inputs)) {
                return {
                    ok: true,
                    status: 200,
                    data: {
                        data: body.inputs.map((group: string[]) => ({
                            data: group.map((t) => ({ embedding: textVector(t) })),
                        })),
                    },
                };
            }
            const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
            return { ok: true, status: 200, data: { data: inputs.map((t: string) => ({ embedding: textVector(t) })) } };
        },
        async embed(texts: string[], model: string): Promise<Float32Array[]> {
            log.embeds.push({ model, texts: [...texts] });
            return texts.map((t) => Float32Array.from(textVector(t)));
        },
        random(): number {
            return RANDOM_SEQUENCE[randomIndex++ % RANDOM_SEQUENCE.length];
        },
        progress(payload: unknown): void {
            log.progress.push(structuredClone(payload));
        },
        alert(text: string): void {
            log.alerts.push(text);
        },
        /** The vector store (the client's LocalForage, the server's cache): typed arrays kept as such. */
        cache: {
            get(key: string): unknown {
                const value = cache.get(key);
                return value === undefined ? null : structuredClone(value);
            },
            set(key: string, value: unknown): void {
                log.cacheKeys.add(key);
                cache.set(key, structuredClone(value));
            },
        },
        snapshot(result: unknown, thrown?: unknown): Outcome {
            return normalize({
                ...(thrown === undefined
                    ? { result }
                    : { thrown: thrown instanceof Error ? thrown.message : String(thrown) }),
                requests: log.requests,
                summarizer: log.summarizer,
                completions: log.completions,
                http: log.http,
                embeds: log.embeds,
                cacheKeys: [...log.cacheKeys].sort(),
                progress: log.progress,
                alerts: log.alerts,
            });
        },
    };
    return world;
}

/** JSON-normalized (typed arrays as arrays, `undefined` dropped): what the fixture stores. */
export function normalize<T>(value: T): T {
    return JSON.parse(
        JSON.stringify(value, (_key, item: unknown) =>
            ArrayBuffer.isView(item) ? Array.from(item as Float32Array) : item,
        ),
    ) as T;
}

// ---------------------------------------------------------------------------------------------
// The scenarios

const character = { type: "character" as const, name: "Mira" };
const group = { type: "group" as const, name: "Group" };

const hypaData = (entries: { id: string; supa: string; hypa: string[] }[]) =>
    "hypa:\n" + JSON.stringify(entries, null, 2);

const v3Summaries = (chats: OpenAIChat[]) => ({
    summaries: [
        {
            text: "Old summary one: the river crossing.\n\nThey camped by the lantern.",
            chatMemos: ["m0", "m1"],
            isImportant: false,
            tags: [],
        },
        { text: "Old summary two: an important vow.", chatMemos: ["m2", "m3"], isImportant: true, tags: ["vow"] },
        {
            text: "Old summary three: copper coins traded.\n\nThe harbor was silent.",
            chatMemos: ["m4", "m5"],
            isImportant: false,
            tags: [],
        },
        { text: "Old summary four: a whisper in the orchard.", chatMemos: ["m6", "m7"], isImportant: false, tags: [] },
        {
            text: "Orphaned summary: a chat that is gone.",
            chatMemos: ["gone-1", "gone-2"],
            isImportant: false,
            tags: [],
        },
        {
            text: "Old summary six: ember and willow.\n\nGravel underfoot.",
            chatMemos: ["m8", "m9"],
            isImportant: false,
            tags: [],
        },
    ],
    metrics: {
        lastImportantSummaries: [1],
        lastRecentSummaries: [3],
        lastSimilarSummaries: [0],
        lastRandomSummaries: [],
    },
    ...(chats.length ? {} : {}),
});

export const scenarios: Scenario[] = [
    // SupaMemory
    { name: "supa-fits", algorithm: "supa", chats: makeChats(6), room: {}, char: character, maxContextTokens: 5000 },
    {
        name: "supa-cold-overflow",
        algorithm: "supa",
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
    },
    {
        name: "supa-existing-data",
        algorithm: "supa",
        chats: makeChats(16),
        room: { supaMemoryData: "m3\nAn earlier summary of the first messages." },
        char: character,
        maxContextTokens: 380,
    },
    {
        name: "supa-existing-fits-after-drop",
        algorithm: "supa",
        chats: makeChats(12),
        room: { supaMemoryData: "m6\nAn earlier summary, kept as the card." },
        char: character,
        maxContextTokens: 330,
    },
    {
        name: "supa-id-not-found",
        algorithm: "supa",
        chats: makeChats(8),
        room: { supaMemoryData: "zz\nA summary whose message is gone." },
        char: character,
        maxContextTokens: 200,
    },
    {
        name: "supa-hypa-data-loaded-as-supa",
        algorithm: "supa",
        chats: makeChats(8),
        room: { supaMemoryData: hypaData([{ id: "m2", supa: "s", hypa: ["h"] }]) },
        char: character,
        maxContextTokens: 200,
    },
    {
        name: "supa-summary-fails",
        algorithm: "supa",
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
        summaries: [{ fail: "the summary model is down" }],
    },
    {
        name: "supa-group-and-punctuation",
        algorithm: "supa",
        settings: { removePunctuationHypa: true, supaMemoryPrompt: "Summarize: {{slot}}" },
        chats: makeChats(16),
        room: { supaMemoryData: "m2\nAn earlier summary, with punctuation: yes, it has (some)." },
        char: group,
        maxContextTokens: 420,
    },
    {
        name: "supa-instruct-completions",
        algorithm: "supa",
        settings: { supaModelType: "instruct35" },
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
    },
    {
        name: "supa-instruct-http-error",
        algorithm: "supa",
        settings: { supaModelType: "curie" },
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
        completions: [{ ok: false, data: { error: { message: "quota exceeded" } } }],
    },
    {
        name: "supa-instruct-empty-choice",
        algorithm: "supa",
        settings: { supaModelType: "instruct35" },
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
        completions: [{ ok: true, data: { choices: [{ text: "   " }] } }],
    },
    {
        name: "supa-distilbart",
        algorithm: "supa",
        settings: { supaModelType: "distilbart" },
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
        summarizer: ["A local summary of the opening.", "A local summary of the middle."],
    },
    {
        name: "supa-distilbart-fails",
        algorithm: "supa",
        settings: { supaModelType: "distilbart" },
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
        summarizer: [{ fail: "the model file is missing" }],
    },
    {
        name: "supa-not-enough-tokens",
        algorithm: "supa",
        settings: { maxSupaChunkSize: 60 },
        chats: makeChats(10),
        room: {},
        char: character,
        maxContextTokens: 150,
        summaries: Array.from({ length: 12 }, (_, i) => `Too long summary ${i}: ${"word ".repeat(40)}`),
    },
    // HypaMemory (SupaMemory with `asHyper`)
    {
        name: "hyper-cold-overflow",
        algorithm: "hyper",
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 420,
    },
    {
        name: "hyper-existing-data",
        algorithm: "hyper",
        chats: makeChats(18),
        room: {
            supaMemoryData: hypaData([
                {
                    id: "m4",
                    supa: "The supa summary so far.",
                    hypa: [
                        "chunk about the river",
                        "chunk about the lantern",
                        "chunk about the river",
                        "x",
                        "The supa summary so far.",
                    ],
                },
            ]),
        },
        char: character,
        maxContextTokens: 500,
    },
    {
        name: "hyper-existing-fits",
        algorithm: "hyper",
        settings: { hypaModel: "MiniLM" },
        chats: makeChats(12),
        room: {
            supaMemoryData: hypaData([
                { id: "m6", supa: "Kept supa.", hypa: ["ember chunk", "willow chunk", "gravel chunk"] },
            ]),
        },
        char: character,
        maxContextTokens: 360,
    },
    {
        name: "hyper-plain-data-ignored",
        algorithm: "hyper",
        chats: makeChats(16),
        room: { supaMemoryData: "m3\nA plain supa summary under hypa." },
        char: character,
        maxContextTokens: 420,
    },
    {
        name: "hyper-id-not-found",
        algorithm: "hyper",
        chats: makeChats(8),
        room: { supaMemoryData: hypaData([{ id: "zz", supa: "s", hypa: ["h"] }]) },
        char: character,
        maxContextTokens: 200,
    },
    {
        name: "hyper-not-an-array",
        algorithm: "hyper",
        chats: makeChats(8),
        room: { supaMemoryData: 'hypa:\n{"id":"m1"}' },
        char: character,
        maxContextTokens: 200,
    },
    // HypaMemory V2
    { name: "v2-fits", algorithm: "v2", chats: makeChats(6), room: {}, char: character, maxContextTokens: 5000 },
    {
        name: "v2-cold-overflow",
        algorithm: "v2",
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 560,
    },
    {
        name: "v2-existing-with-orphan",
        algorithm: "v2",
        chats: makeChats(16),
        room: {
            hypaV2Data: {
                lastMainChunkID: 2,
                mainChunks: [
                    { id: 1, text: "Old main one.\n\nIts second part.", chatMemos: ["m0", "m1"], lastChatMemo: "m1" },
                    { id: 2, text: "Orphan main.", chatMemos: ["gone"], lastChatMemo: "gone" },
                ],
                chunks: [
                    { mainChunkID: 1, text: "Old main one." },
                    { mainChunkID: 1, text: "Its second part." },
                    { mainChunkID: 2, text: "Orphan main." },
                ],
            },
        },
        char: character,
        maxContextTokens: 560,
    },
    {
        name: "v2-repeated-failure",
        algorithm: "v2",
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 560,
        summaries: [{ fail: "down 1" }, { fail: "down 2" }, { fail: "down 3" }],
    },
    {
        name: "v2-one-failure-then-success",
        algorithm: "v2",
        chats: makeChats(16),
        room: {},
        char: character,
        maxContextTokens: 560,
        summaries: [{ fail: "down once" }, "Recovered summary.\n\nIts chunk."],
    },
    {
        name: "v2-message-over-chunk",
        algorithm: "v2",
        settings: { hypaChunkSize: 10 },
        chats: makeChats(10),
        room: {},
        char: character,
        maxContextTokens: 300,
    },
    // HypaMemory V3, the standard implementation
    {
        name: "v3-fits-empty",
        algorithm: "v3",
        chats: makeChats(6),
        room: {},
        char: character,
        maxContextTokens: 5000,
    },
    {
        name: "v3-cold-overflow",
        algorithm: "v3",
        preset: {
            maxChatsPerSummary: 4,
            queryChatCount: 3,
            recentMemoryRatio: 0.3,
            similarMemoryRatio: 0.4,
            memoryTokensRatio: 0.3,
        },
        chats: makeChats(18, { paragraphs: true }),
        room: {},
        char: character,
        maxContextTokens: 400,
    },
    {
        name: "v3-existing-then-summarize",
        algorithm: "v3",
        preset: {
            maxChatsPerSummary: 4,
            queryChatCount: 3,
            recentMemoryRatio: 0.3,
            similarMemoryRatio: 0.4,
            memoryTokensRatio: 0.4,
        },
        chats: makeChats(14, { paragraphs: true }),
        room: { hypaV3Data: v3Summaries([]) },
        char: character,
        maxContextTokens: 130,
    },
    {
        name: "v3-existing-selection",
        algorithm: "v3",
        preset: {
            maxChatsPerSummary: 4,
            queryChatCount: 3,
            recentMemoryRatio: 0.3,
            similarMemoryRatio: 0.4,
            memoryTokensRatio: 0.4,
        },
        chats: makeChats(14, { paragraphs: true }),
        room: { hypaV3Data: v3Summaries([]) },
        char: character,
        maxContextTokens: 560,
    },
    {
        name: "v3-preserve-orphans-recent-only",
        algorithm: "v3",
        preset: {
            preserveOrphanedMemory: true,
            recentMemoryRatio: 1,
            similarMemoryRatio: 0,
            memoryTokensRatio: 0.4,
            queryChatCount: 2,
        },
        chats: makeChats(14),
        room: { hypaV3Data: v3Summaries([]) },
        char: character,
        maxContextTokens: 560,
    },
    {
        name: "v3-partial-then-failure",
        algorithm: "v3",
        preset: { maxChatsPerSummary: 3, queryChatCount: 3 },
        chats: makeChats(18),
        room: {},
        char: character,
        maxContextTokens: 400,
        summaries: ["First summary landed.", { fail: "the summary model is down" }],
    },
    {
        name: "v3-similarity-correction",
        algorithm: "v3",
        preset: {
            enableSimilarityCorrection: true,
            recentMemoryRatio: 0.2,
            similarMemoryRatio: 0.8,
            memoryTokensRatio: 0.4,
            queryChatCount: 3,
        },
        chats: makeChats(14, { paragraphs: true }),
        room: { hypaV3Data: v3Summaries([]) },
        char: character,
        maxContextTokens: 560,
        summaries: ["A query summary of the recent chats."],
    },
    {
        name: "v3-voyage-similar-full",
        algorithm: "v3",
        settings: { hypaModel: "voyageContext3" },
        preset: {
            recentMemoryRatio: 0,
            similarMemoryRatio: 1,
            memoryTokensRatio: 0.4,
            queryChatCount: 3,
            summaryChunkSeparator: "\\n\\n",
        },
        chats: makeChats(14),
        room: { hypaV3Data: v3Summaries([]) },
        char: character,
        maxContextTokens: 560,
    },
    {
        name: "v3-ratio-error",
        algorithm: "v3",
        preset: { recentMemoryRatio: 0.7, similarMemoryRatio: 0.7 },
        chats: makeChats(8),
        room: {},
        char: character,
        maxContextTokens: 200,
    },
    {
        name: "v3-cannot-summarize-further",
        algorithm: "v3",
        preset: { queryChatCount: 8 },
        chats: makeChats(8),
        room: {},
        char: character,
        maxContextTokens: 150,
    },
    {
        name: "v3-preset-by-id",
        algorithm: "v3",
        presetsBefore: [{ maxChatsPerSummary: 2, queryChatCount: 2 }],
        preset: { maxChatsPerSummary: 6, queryChatCount: 3, recentMemoryRatio: 0.5, similarMemoryRatio: 0.5 },
        chats: makeChats(18),
        room: {},
        char: character,
        maxContextTokens: 400,
    },
    {
        name: "v3-user-messages-kept",
        algorithm: "v3",
        preset: { doNotSummarizeUserMessage: true, maxChatsPerSummary: 4, queryChatCount: 3 },
        chats: [{ role: "system", content: "", memo: "NewChat" }, ...makeChats(16)],
        room: {},
        char: character,
        maxContextTokens: 360,
    },
    // HypaMemory V3, the experimental implementation
    {
        name: "v3exp-cold-overflow",
        algorithm: "v3exp",
        preset: {
            useExperimentalImpl: true,
            maxChatsPerSummary: 4,
            queryChatCount: 3,
            recentMemoryRatio: 0.3,
            similarMemoryRatio: 0.4,
            memoryTokensRatio: 0.3,
            summarizationRequestsPerMinute: 1000,
            summarizationMaxConcurrent: 1,
            embeddingRequestsPerMinute: 1000,
            embeddingMaxConcurrent: 1,
        },
        chats: makeChats(18, { paragraphs: true }),
        room: {},
        char: character,
        maxContextTokens: 400,
    },
    {
        name: "v3exp-existing-voyage-groups",
        algorithm: "v3exp",
        settings: { hypaModel: "voyageContext3" },
        preset: {
            useExperimentalImpl: true,
            maxChatsPerSummary: 4,
            queryChatCount: 3,
            recentMemoryRatio: 0.2,
            similarMemoryRatio: 0.6,
            memoryTokensRatio: 0.4,
            summarizationRequestsPerMinute: 1000,
            summarizationMaxConcurrent: 1,
            embeddingRequestsPerMinute: 1000,
            embeddingMaxConcurrent: 1,
        },
        chats: makeChats(14, { paragraphs: true }),
        room: { hypaV3Data: v3Summaries([]) },
        char: character,
        maxContextTokens: 560,
    },
    {
        name: "v3exp-batch-partial-failure",
        algorithm: "v3exp",
        preset: {
            useExperimentalImpl: true,
            maxChatsPerSummary: 3,
            queryChatCount: 3,
            summarizationRequestsPerMinute: 1000,
            summarizationMaxConcurrent: 1,
            embeddingRequestsPerMinute: 1000,
            embeddingMaxConcurrent: 1,
        },
        chats: makeChats(18),
        room: {},
        char: character,
        maxContextTokens: 400,
        summaries: ["Batch summary one.", { fail: "the summary model is down" }, "Batch summary three."],
    },
    // Hanurai
    {
        name: "hanurai-plain",
        algorithm: "hanurai",
        settings: { hypaModel: "MiniLM" },
        chats: makeChats(12),
        room: {},
        char: character,
        maxContextTokens: 520,
    },
    {
        name: "hanurai-split-paragraphs",
        algorithm: "hanurai",
        settings: { hanuraiSplit: true },
        chats: makeChats(12, { paragraphs: true }),
        room: {},
        char: character,
        maxContextTokens: 520,
    },
    {
        name: "hanurai-exhaustion",
        algorithm: "hanurai",
        settings: { hanuraiTokens: 400 },
        chats: makeChats(6),
        room: {},
        char: character,
        maxContextTokens: 120,
    },
];
