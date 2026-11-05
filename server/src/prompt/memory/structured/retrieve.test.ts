// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import { createHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { OpenAIChat } from "../../../../../shared/openai.ts";
import {
    normalizeStructuredMemorySettings,
    type MemoryEvent,
    type MemoryKnowledge,
    type MemoryPage,
    type MemorySection,
    type MemoryThread,
} from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { createVectorCache } from "../../../data/vectorCache.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { createEmbeddings, HypaProcesser } from "../../embeddings.ts";
import type { MemoryHost } from "../host.ts";
import { buildMemoryCard } from "./card.ts";
import type { ReadEntry } from "./lanes.ts";
import {
    eventVectorTexts,
    readsAsPast,
    RETRIEVAL_LIMITS,
    retrieveLanes,
    shareRecordEmbeddingAllowance,
} from "./retrieve.ts";
import { readEntries, selectMemory, type MemorySelectionInput } from "./step.ts";

const event = (id: string, sources = ["old"], fields: Partial<MemoryEvent> = {}): MemoryEvent => ({
    ...memoryRecords([id], id).events[0],
    createdRevision: 1,
    // Deliberately stale stored indices: retrieval must use current message positions.
    sources: sources.map((messageId) => ({ messageId, index: 999, hash: "stored-hash" })),
    ...fields,
});
const entry = (messageId: string, text = messageId, role: ReadEntry["role"] = "char"): ReadEntry => ({
    messageId,
    role,
    text,
});
const section = (heading: string, body: string, updatedAt = 1): MemorySection => ({
    heading,
    body,
    updatedAt,
    provenance: [],
    sources: [],
    locked: false,
});
const page = (id: string, fields: Partial<MemoryPage> = {}): MemoryPage => ({
    ...memoryRecords([id], id).pages[0],
    sections: [section("currentState", `${id} state`)],
    ...fields,
});
const fact = (pageId: string, text: string, fields: Partial<MemoryKnowledge> = {}): MemoryKnowledge => ({
    pageId,
    fact: text,
    stance: "knows",
    quote: text,
    ...fields,
});
const pageSettings = () => settings({ laneTargets: { pages: 1000, events: 0, evidence: 0, threads: 0 } });
type Input = Parameters<typeof retrieveLanes>[1];
const settings = (fields: Partial<Input["settings"]> = {}) =>
    normalizeStructuredMemorySettings({
        flowEvents: 0,
        laneTargets: { pages: 0, events: 1000, evidence: 0, threads: 0 },
        ...fields,
    });
function input(fields: Partial<Input> = {}): Input {
    return {
        events: [event("memory")],
        threads: [],
        pages: [],
        entries: [entry("old"), entry("query", "Continue.", "user"), entry("reply", "All right.")],
        window: { start: 1, dropped: new Set([0]) },
        stage: [],
        settings: settings(),
        ...fields,
    };
}
const items = (result: Awaited<ReturnType<typeof retrieveLanes>>, lane: string) =>
    result.lanes.find((row) => row.lane === lane)!.items;
async function spentCard({ lanes }: Awaited<ReturnType<typeof retrieveLanes>>, maximum: number) {
    const card = await buildMemoryCard({ tokenizeChat: async () => 1 }, { maximum, lanes });
    if (card.type !== "card") throw new Error("The required lane refused");
    return card;
}

/** Real embedding service and SQLite cache; only the provider and cancellation port are scripted. */
function harness(vector: (text: string) => number[] = () => [1, 0]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "structured-read-"));
    const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite"), now: () => 1000 });
    onTestFinished(() => {
        cache.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const calls: string[][] = [];
    const control: { error?: Error; cancelled?: Error; afterFetch?: () => void } = {};
    const db = {
        hypaModel: "custom",
        hypaCustomSettings: { url: "https://embed.test/v1/", key: 'private"key&x', model: "retrieval-model" },
        voyageApiKey: "",
    } as MemoryHost["db"];
    const unexpectedWorker = async (): Promise<never> => {
        throw new Error("Unexpected local model call");
    };
    const embeddings = createEmbeddings({
        cache,
        transformers: {
            runEmbedding: unexpectedWorker,
            runSummarizer: unexpectedWorker,
            runImageCaption: unexpectedWorker,
            runTextGeneration: unexpectedWorker,
            dispose: async () => {},
        },
        fetchImpl: async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as { input: string | string[] };
            const texts = Array.isArray(body.input) ? body.input : [body.input];
            calls.push(texts);
            control.afterFetch?.();
            if (control.error) throw control.error;
            return new Response(JSON.stringify({ data: texts.map((text) => ({ embedding: vector(text) })) }));
        },
    }).forJob({ db, signal: new AbortController().signal, supaMemoryKey: "memory-secret" });
    const host: Pick<MemoryHost, "db" | "embeddings" | "fence"> = {
        db,
        embeddings,
        fence: () => {
            if (control.cancelled) throw control.cancelled;
        },
    };
    return { host, calls, control };
}

describe("bounded memory embeddings", () => {
    function selection(host: MemorySelectionInput["host"], messages: Message[]): MemorySelectionInput {
        const chats: OpenAIChat[] = messages.map(({ chatId, role, data }) => ({
            role: role === "char" ? "assistant" : "user",
            content: data,
            memo: chatId,
        }));
        return {
            host: { ...host, db: { ...host.db, maxResponse: 0 } },
            settings: createHypaV3Preset("Retrieval", {
                budgetMode: "tokens",
                memoryBudgetTokens: 10000,
                structured: settings({
                    windowTurns: 1,
                    laneTargets: { pages: 1000, events: 1000, evidence: 0, threads: 0 },
                }),
            }).settings,
            tokenizer: { tokenizeChat: async ({ content }) => content.length },
            chats,
            historyStart: 0,
            entries: readEntries(chats, messages),
            messages,
            currentTokens: chats.reduce((sum, { content }) => sum + content.length, 0),
            maxContextTokens: 100000,
            continueMessageId: undefined,
            tooMuchToken: "TOO_MUCH_TOKEN",
        };
    }

    it("shares one job's bounded record embeddings across repeated selections of a cold 1,000-event chat", async () => {
        const h = harness();
        const messages: Message[] = Array.from({ length: 1000 }, (_, index) => ({
            chatId: `old-${index}`,
            role: "char",
            data: `Original passage ${index}`,
        }));
        const events = messages.map((message, index) =>
            event(`event-${index}`, [], {
                summary: `Summary ${index}`,
                keyLines: [
                    { speaker: "Ada", text: `Quote ${index}` },
                    { speaker: "Ada", text: `Summary ${index}` },
                ],
                sources: [{ messageId: message.chatId!, index, hash: messageSourceHash(message) }],
            }),
        );
        const pages = [page("Archive"), page("Harbor")];
        const recordTexts = new Set([
            ...events.flatMap((_, index) => [`Summary ${index}`, `Quote ${index}`]),
            "Archive: currentState\nArchive state",
            "Harbor: currentState\nHarbor state",
        ]);
        const queries = ["Continue the journey.", "Ready to depart.", "Open the gate."];
        messages.push(
            ...queries.map((data, index): Message => ({
                chatId: `recent-${index}`,
                role: index === 1 ? "char" : "user",
                data,
            })),
        );
        const job = {};
        shareRecordEmbeddingAllowance(h.host.embeddings, job);
        const request = selection(h.host, messages);
        const records = { events, pages, threads: [], stage: [] };
        const first = await selectMemory(request, records);
        expect(first.type).toBe("selected");
        if (first.type !== "selected") throw new Error(JSON.stringify(first));
        const submitted = h.calls.flat();
        const foreground = submitted.filter((text) => recordTexts.has(text));
        expect(foreground.length).toBeGreaterThan(0);
        expect(foreground.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.recordTexts);
        expect(new Set(foreground).size).toBe(foreground.length);
        expect(submitted.filter((text) => !recordTexts.has(text))).toEqual(queries);
        expect(first.deferredRecordTexts).toBe(recordTexts.size - foreground.length);
        expect(first.lanesStage).not.toBe("similarityFailed");

        // Another selection round gets a fresh environment but belongs to the same send job.
        const nextHost = { ...request.host, embeddings: { ...request.host.embeddings } };
        shareRecordEmbeddingAllowance(nextHost.embeddings, job);
        const beforeRepeat = h.calls.length;
        const second = await selectMemory({ ...request, host: nextHost }, records);
        expect(second.type).toBe("selected");
        if (second.type !== "selected") throw new Error(JSON.stringify(second));
        expect(
            h.calls
                .slice(beforeRepeat)
                .flat()
                .filter((text) => queries.includes(text)),
        ).toEqual([]);
        const allForeground = h.calls.flat().filter((text) => recordTexts.has(text));
        expect(allForeground.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.recordTexts);
        expect(new Set(allForeground).size).toBe(allForeground.length);
        expect(second.deferredRecordTexts).toBe(recordTexts.size - allForeground.length);
    });

    it("scores cached old events and pages beyond the foreground record allowance", async () => {
        const query = "Continue.";
        const h = harness((text) => {
            if (text === query || text === "The hidden signal" || text === "Page 0: Clue\nOld beacon") return [1, 0];
            if (text === "Summary 1") return [0.8, 0.6];
            return [0, 1];
        });
        const events = Array.from({ length: 101 }, (_, index) =>
            event(`event-${index}`, [`old-${index}`], {
                summary: `Summary ${index}`,
                keyLines: index === 0 ? [{ speaker: "Ada", text: "The hidden signal" }] : [],
            }),
        );
        const pages = Array.from({ length: 101 }, (_, index) =>
            page(`page-${index}`, {
                title: `Page ${index}`,
                sections: [section("Clue", index === 0 ? "Old beacon" : `Noise ${index}`, index)],
            }),
        );
        await new HypaProcesser(h.host.embeddings, h.host.db.hypaModel).addText([
            ...events.map((_, index) => `Summary ${index}`),
            "The hidden signal",
            ...pages.map((_, index) => `Page ${index}: Clue\n${index === 0 ? "Old beacon" : `Noise ${index}`}`),
        ]);
        h.calls.length = 0;
        const result = await retrieveLanes(
            h.host,
            input({
                events,
                pages,
                entries: [...events.map((_, index) => entry(`old-${index}`)), entry("query", query, "user")],
                window: { start: events.length, dropped: new Set() },
                settings: settings({ laneTargets: { pages: 1000, events: 1000, evidence: 0, threads: 0 } }),
            }),
        );
        expect(result.similarity).toBe("used");
        expect(result.deferredRecordTexts).toBe(0);
        expect(items(result, "events").map(({ id }) => id)).toEqual(["event-0", "event-1"]);
        expect(items(result, "pages").map(({ id }) => id)).toEqual(["page-0"]);
        expect(h.calls).toEqual([[query]]);
    });

    it("embeds nothing when the smallest memory frame fills the budget", async () => {
        const h = harness();
        const messages: Message[] = [
            { chatId: "old", role: "char", data: "The vault holds a key." },
            { chatId: "query", role: "user", data: "Remember the key?" },
        ];
        const request = selection(h.host, messages);
        request.settings.memoryBudgetTokens = 2;
        request.settings.structured.laneTargets.evidence = 1000;
        // The stable header and optional part each cost one token, leaving no room for a record.
        request.tokenizer = { tokenizeChat: async () => 1 };
        request.currentTokens = messages.length;
        const result = await selectMemory(request, {
            events: [
                event("memory", [], {
                    sources: [{ messageId: "old", index: 0, hash: messageSourceHash(messages[0]) }],
                }),
            ],
            pages: [page("Archive")],
            threads: [],
            stage: [],
        });
        expect(result).toMatchObject({ type: "selected", budget: { maximum: 2 }, items: [] });
        expect(h.calls).toEqual([]);
    });

    it("caches queries separately from identical and namespace-like document texts", async () => {
        const query = "Continue.";
        let warmingDocuments = true;
        const h = harness((text) => (!warmingDocuments || text === "A hidden signal" ? [1, 0] : [0, 1]));
        const documents = [query, `structured-query-v1:${query}`, "A hidden signal"];
        await new HypaProcesser(h.host.embeddings, h.host.db.hypaModel).addText(documents);
        warmingDocuments = false;
        h.calls.length = 0;
        const request = input({
            events: documents.map((summary, index) => event(`event-${index}`, ["old"], { summary })),
            entries: [entry("old"), entry("query", query, "user")],
        });
        const first = await retrieveLanes(h.host, request);
        expect(items(first, "events").map(({ id }) => id)).toEqual(["event-2"]);
        expect(h.calls).toEqual([[query]]);
        const second = await retrieveLanes(h.host, request);
        expect(items(second, "events")).toEqual(items(first, "events"));
        expect(h.calls).toEqual([[query]]);
    });
});

describe("selectMemory evidence from trimmed history", () => {
    const answer = "The bronze key code is 4712.";
    const question = "What is the bronze key code?";
    const longAnswer = `${answer}\n\n`.padEnd(1800, "x");
    const tail: Message[] = [
        { chatId: "recent-user", role: "user", data: "Continue." },
        { chatId: "recent-reply", role: "char", data: "Ready." },
        { chatId: "question", role: "user", data: question },
    ];
    const records = { events: [], threads: [], pages: [], stage: [] };
    const scene = page("scene", { type: "scene", sections: [section("currentState", "At the vault.")] });

    function selectionInput(messages: Message[], fields: Partial<MemorySelectionInput> = {}): MemorySelectionInput {
        const { host } = harness();
        const chats: OpenAIChat[] = messages.map(({ chatId, role, data }) => ({
            role: role === "char" ? "assistant" : "user",
            content: data,
            memo: chatId,
        }));
        return {
            host: { ...host, db: { ...host.db, maxResponse: 0 } },
            settings: createHypaV3Preset("Evidence", {
                budgetMode: "tokens",
                memoryBudgetTokens: 1000,
                structured: settings({
                    windowTurns: 1,
                    laneTargets: { pages: 0, events: 0, evidence: 1000, threads: 0 },
                }),
            }).settings,
            tokenizer: { tokenizeChat: async ({ content }) => content.length },
            chats,
            historyStart: 0,
            entries: readEntries(chats, messages),
            messages,
            currentTokens: chats.reduce((sum, { content }) => sum + content.length, 0),
            maxContextTokens: 2000,
            continueMessageId: undefined,
            tooMuchToken: "TOO_MUCH_TOKEN",
            ...fields,
        };
    }

    it("excerpts an unrecorded answer trimmed by raw history pressure and counts every removed entry in the gap", async () => {
        const request = selectionInput([
            { chatId: "answer", role: "char", data: longAnswer },
            { chatId: "older-reply", role: "char", data: "x".repeat(1900) },
            ...tail,
        ]);
        expect(request.currentTokens).toBeGreaterThan(request.maxContextTokens);

        const result = await selectMemory(request, records);
        expect(result.type).toBe("selected");
        if (result.type !== "selected") throw new Error(JSON.stringify(result));
        expect(result.items.filter(({ lane }) => lane === "evidence")).toEqual([
            expect.objectContaining({ id: "answer" }),
        ]);
        expect(result.chats.filter(({ memo }) => memo !== "supaMemory")).toEqual(request.chats.slice(2));
        expect(result.chats.find(({ memo }) => memo === "supaMemory")?.content).toContain(
            `[m:answer] character: "${answer}"`,
        );
        // The excerpt's card also displaces the 1900-character reply. Both raw entries count as a gap.
        expect(result.gapTokens).toBe(longAnswer.length + 1900);
        expect(result.coverage).toBe("gap");
    });

    it("excerpts an unrecorded answer only when a required scene page displaces otherwise fitting raw history", async () => {
        const request = selectionInput([{ chatId: "answer", role: "char", data: longAnswer }, ...tail]);
        expect(request.currentTokens).toBeLessThan(request.maxContextTokens);

        const withoutPage = await selectMemory(request, records);
        expect(withoutPage).toMatchObject({
            type: "selected",
            chats: request.chats,
            items: [],
            gapTokens: 0,
            coverage: "covered",
        });

        const result = await selectMemory(request, { ...records, pages: [scene] });
        expect(result.type).toBe("selected");
        if (result.type !== "selected") throw new Error(JSON.stringify(result));
        expect(result.chats.filter(({ memo }) => memo !== "supaMemory")).toEqual(request.chats.slice(1));
        expect(result.items).toContainEqual(expect.objectContaining({ id: "scene", lane: "required" }));
        expect(result.items.filter(({ lane }) => lane === "evidence")).toEqual([
            expect.objectContaining({ id: "answer" }),
        ]);
        expect(result.chats.find(({ memo }) => memo === "supaMemory")?.content).toContain(
            `[m:answer] character: "${answer}"`,
        );
        expect(result.gapTokens).toBe(longAnswer.length);
        expect(result.coverage).toBe("gap");
    });

    it("does not excerpt an older answer that stays raw after an earlier entry is trimmed", async () => {
        const request = selectionInput([
            { chatId: "unrelated", role: "char", data: "x".repeat(2500) },
            { chatId: "answer", role: "char", data: answer },
            ...tail,
        ]);

        const result = await selectMemory(request, records);
        expect(result.type).toBe("selected");
        if (result.type !== "selected") throw new Error(JSON.stringify(result));
        expect(result.chats).toEqual(request.chats.slice(1));
        expect(result.items.filter(({ lane }) => lane === "evidence")).toEqual([]);
        expect(result.gapTokens).toBe(2500);
        expect(result.coverage).toBe("gap");
    });

    it.each(["raw window", "pinned continue target"] as const)(
        "keeps an answer in the %s raw and unexcerpted under pressure",
        async (protection) => {
            const protectedAnswer: Message = {
                chatId: "protected-answer",
                role: "char",
                data: `${answer}\n\n`.padEnd(1850, "x"),
            };
            const older: Message[] = [
                { chatId: "old-key", role: "char", data: "The bronze key is on the desk.\n\n".padEnd(1800, "x") },
                { chatId: "older-reply", role: "char", data: "Earlier." },
            ];
            // Tight context exercises protection during card growth; more room would allow a duplicate excerpt.
            for (const maxContextTokens of [2000, 2400]) {
                const request = selectionInput(
                    protection === "raw window"
                        ? [...older, tail[0], protectedAnswer, tail[2]]
                        : [protectedAnswer, ...older, ...tail],
                    {
                        maxContextTokens,
                        continueMessageId: protection === "pinned continue target" ? "protected-answer" : undefined,
                    },
                );
                expect(request.currentTokens).toBeGreaterThan(request.maxContextTokens);

                const result = await selectMemory(request, records);
                expect(result.type).toBe("selected");
                if (result.type !== "selected") throw new Error(JSON.stringify(result));
                expect(result.chats.map(({ memo }) => memo)).toContain("protected-answer");
                expect(result.chats.find(({ memo }) => memo === "protected-answer")?.content).toBe(
                    protectedAnswer.data,
                );
                expect(result.chats.some(({ memo }) => memo === "old-key")).toBe(false);
                expect(result.items.some(({ lane, id }) => lane === "evidence" && id === "protected-answer")).toBe(
                    false,
                );
                expect(result.coverage).toBe("gap");
            }
        },
    );

    it("keeps the first card when an excerpt would overflow an otherwise fitting send", async () => {
        const messages: Message[] = [
            { chatId: "answer", role: "char", data: longAnswer },
            tail[0],
            { ...tail[1], data: "x".repeat(1700) },
            tail[2],
        ];
        const withScene = { ...records, pages: [scene] };
        const request = selectionInput(messages);
        const evidenceOff = structuredClone(request.settings);
        evidenceOff.structured!.laneTargets.evidence = 0;
        const first = await selectMemory({ ...request, settings: evidenceOff }, withScene);
        expect(first.type).toBe("selected");
        if (first.type !== "selected") throw new Error(JSON.stringify(first));
        expect(first.items).toEqual([expect.objectContaining({ id: "scene", lane: "required" })]);

        // With more room in the protected tail, this same answer fits in the evidence lane.
        const room = await selectMemory(
            selectionInput(
                messages.map((message) =>
                    message.chatId === "recent-reply" ? { ...message, data: "x".repeat(1500) } : message,
                ),
            ),
            withScene,
        );
        expect(room.type).toBe("selected");
        if (room.type !== "selected") throw new Error(JSON.stringify(room));
        expect(room.items).toContainEqual(expect.objectContaining({ id: "answer", lane: "evidence" }));
        expect(room.chats.find(({ memo }) => memo === "supaMemory")?.content).toContain(
            `[m:answer] character: "${answer}"`,
        );

        const result = await selectMemory(request, withScene);
        expect(result.type).toBe("selected");
        if (result.type !== "selected") throw new Error(JSON.stringify(result));
        expect(result.items).toEqual(first.items);
        expect(result.chats).toEqual(first.chats);
        expect(result.currentTokens).toBeLessThanOrEqual(request.maxContextTokens);
        expect(result.gapTokens).toBe(longAnswer.length);
        expect(result.coverage).toBe("gap");
    });
});

describe("structured memory retrieval", () => {
    it("keeps scene attendance and every required section stable while filtering character sections in related pages", async () => {
        const h = harness((text) => (text.includes(": ") ? [0, 1] : [1, 0]));
        const result = await retrieveLanes(
            h.host,
            input({
                events: [],
                stage: ["Ada", "Archive"],
                settings: pageSettings(),
                pages: [
                    page("scene", { type: "scene", participants: ["Ada", "Archive"], sections: [] }),
                    page("Charter", {
                        type: "character",
                        contextMode: "always",
                        sections: [
                            section("identity", "The complete charter"),
                            section("currentState", "Still binding"),
                            { ...section("identity", "Suppressed charter"), suppressed: true },
                        ],
                    }),
                    page("Ada", {
                        type: "character",
                        sections: [
                            section("identity", "Never offered biography"),
                            section("currentState", "Waiting at the gate"),
                            section("relationships", "Trusts Ben"),
                            { ...section("currentState", "Suppressed state"), suppressed: true },
                        ],
                    }),
                    page("Archive", {
                        sections: [section("History", "Every old volume"), section("Access", "Open at dawn")],
                    }),
                ],
            }),
        );
        expect(items(result, "required").map(({ id }) => id)).toEqual(["scene", "Charter"]);
        expect(items(result, "required")[0].line).toBe("[m:scene] scene | present: Ada, Archive");
        const card = await spentCard(result, 10000);
        expect(card.stable).toContain("identity: The complete charter | currentState: Still binding");
        expect(card.stable).toContain("[m:scene]");
        expect(card.volatile).toContain("[m:Ada] Ada | currentState: Waiting at the gate | relationships: Trusts Ben");
        expect(card.volatile).toContain("History: Every old volume | Access: Open at dawn");
        expect(card.volatile).not.toMatch(/\[m:scene\]|\[m:Charter\]/);
        expect(card.stable + card.volatile).not.toMatch(/Never offered biography|Suppressed state|Suppressed charter/);
    });

    it("ranks participant, recent name or alias, one-hop and independent semantic page matches in that order", async () => {
        const h = harness((text) =>
            text === "Continue." || text.includes("semantic beacon")
                ? [1, 0]
                : text.includes("weak beacon")
                  ? [3, 4]
                  : [0, 1],
        );
        const result = await retrieveLanes(
            h.host,
            input({
                events: [],
                stage: ["Ada"],
                settings: pageSettings(),
                entries: [
                    entry("old", "Expired"),
                    ...Array.from({ length: 8 }, (_, i) =>
                        entry(
                            `recent-${i}`,
                            i === 0
                                ? "BLUE BIRD visits the OldTower and Charter. {{// Ghost }} {{comment: Phantom}}"
                                : "Continue.",
                            "user",
                        ),
                    ),
                ],
                window: { start: 1, dropped: new Set([0]) },
                pages: [
                    page("Semantic", { sections: [section("Clue", "semantic beacon", 999)], links: ["SemanticChild"] }),
                    page("OldTower", { sections: [section("State", "weak beacon", 10)] }),
                    page("Bird", { aliases: ["Blue Bird"], sections: [section("State", "semantic beacon", 10)] }),
                    page("Recent", {
                        aliases: ["blue bird"],
                        sections: [section("History", "old section", 1), section("State", "plain", 11)],
                    }),
                    page("Ada", { links: ["Bridge"] }),
                    page("Bridge", { links: ["SecondHop"] }),
                    page("SecondHop"),
                    page("SemanticChild"),
                    page("Expired"),
                    page("Ghost"),
                    page("Phantom"),
                    page("Charter", { contextMode: "always", links: ["Annex"] }),
                    page("Annex"),
                ],
            }),
        );
        expect(items(result, "pages").map(({ id, reason }) => [id, reason])).toEqual([
            ["Ada", "onStage"],
            ["Recent", "named"],
            ["Bird", "named"],
            ["OldTower", "named"],
            ["Annex", "linked"],
            ["Bridge", "linked"],
            ["Semantic", "similarity"],
        ]);
        expect(items(result, "required").map(({ id }) => id)).toEqual(["Charter"]);
        expect(h.calls.flat()).toContain("Semantic: Clue\nsemantic beacon");
        expect(result.excluded).toEqual(
            expect.arrayContaining(
                ["SecondHop", "SemanticChild", "Expired", "Ghost", "Phantom"].map((id) => ({
                    id,
                    kind: "page",
                    lane: "pages",
                    reason: "not-relevant",
                })),
            ),
        );
    });

    it("turns off the pages lane at target zero without embedding its sections or query", async () => {
        const h = harness();
        const result = await retrieveLanes(
            h.host,
            input({
                events: [],
                stage: ["Ada"],
                pages: [page("scene", { type: "scene", participants: ["Ada"] }), page("Ada")],
                settings: settings({ laneTargets: { pages: 0, events: 0, evidence: 0, threads: 0 } }),
            }),
        );
        expect(items(result, "pages")).toEqual([]);
        expect(h.calls).toEqual([]);
        expect(items(result, "required").map(({ id }) => id)).toEqual(["scene"]);
    });

    it("keeps participant, name and link page matches when the embedding provider fails", async () => {
        const h = harness();
        h.control.error = new Error("Embedding unavailable");
        const result = await retrieveLanes(
            h.host,
            input({
                events: [],
                stage: ["Ada"],
                settings: pageSettings(),
                entries: [entry("query", "Visit Ben", "user")],
                window: { start: 0, dropped: new Set() },
                pages: [page("Ada", { links: ["Bridge"] }), page("Ben"), page("Bridge"), page("Unrelated")],
            }),
        );
        expect(result.similarity).toBe("failed");
        expect(items(result, "pages").map(({ id, reason }) => [id, reason])).toEqual([
            ["Ada", "onStage"],
            ["Ben", "named"],
            ["Bridge", "linked"],
        ]);
        const card = await spentCard(result, 10000);
        expect(card.volatile).toContain("[m:Bridge]");
        expect(card.volatile).not.toContain("[m:Unrelated]");
    });

    it("shows on-stage knowledge once per fact with its stance and private holders from active unsuppressed events", async () => {
        const h = harness((text) => (text.includes(": ") ? [0, 1] : [1, 0]));
        const result = await retrieveLanes(
            h.host,
            input({
                stage: ["Ada", "Ben"],
                settings: pageSettings(),
                pages: [page("Ada", { type: "character" }), page("Ben", { type: "character" }), page("Offstage")],
                events: [
                    event("old", ["old"], { knowledge: [fact("Ada", "The gate opens", { stance: "believes" })] }),
                    event("new", ["query"], {
                        knowledge: [
                            fact("Ada", " The  gate\nopens "),
                            fact("Ada", "The key is copper", { stance: "believes", knowers: ["Ben"] }),
                            fact("Ben", "Rain is coming"),
                            fact("Offstage", "Unseen common fact"),
                        ],
                    }),
                    event("stale", ["old"], { status: "stale", knowledge: [fact("Ada", "Stale claim")] }),
                    event("retracted", ["old"], { status: "retracted", knowledge: [fact("Ada", "Retracted claim")] }),
                    event("suppressed", ["old"], { suppressed: true, knowledge: [fact("Ada", "Suppressed claim")] }),
                ],
            }),
        );
        const ada = items(result, "pages").find(({ id }) => id === "Ada")!.line;
        expect(ada).toContain('knows: "The gate opens"');
        expect(ada.match(/The gate opens/g)).toHaveLength(1);
        expect(ada).toContain('believes: "The key is copper" (private to Ada, also known to Ben)');
        expect(ada).not.toContain("Rain is coming");
        const text = items(result, "pages")
            .map(({ line }) => line)
            .join("\n");
        expect(text).toContain('knows: "Rain is coming"');
        expect(text).not.toMatch(/Stale claim|Retracted claim|Suppressed claim|Unseen common fact/);
    });

    it("unions knowers across whitespace-equivalent facts and never denies a fact with a public record", async () => {
        const h = harness((text) => (text.includes(": ") ? [0, 1] : [1, 0]));
        const result = await retrieveLanes(
            h.host,
            input({
                stage: ["Ada", "Ben"],
                settings: pageSettings(),
                pages: [page("Ada", { type: "character" }), page("Ben", { type: "character" }), page("Cara")],
                events: [
                    event("first", ["old"], {
                        knowledge: [
                            fact("Ben", "Hidden door", { knowers: [] }),
                            fact("Ben", "Shared route", { knowers: [] }),
                            fact("Ben", "Public news", { knowers: [] }),
                            fact("Ben", "Still secret", { knowers: [] }),
                        ],
                    }),
                    event("later", ["query"], {
                        knowledge: [
                            fact("Ada", " Hidden\n door ", { knowers: [] }),
                            fact("Cara", "Shared   route", { knowers: ["Ada"] }),
                            fact("Cara", "Public news"),
                        ],
                    }),
                ],
            }),
        );
        const ada = items(result, "pages").find(({ id }) => id === "Ada")!.line;
        expect(ada).toContain('knows: "Hidden door" (private to Ada, also known to Ben)');
        expect(ada.split("does not know: ")[1]).toBe('"Still secret"');
        const ben = items(result, "pages").find(({ id }) => id === "Ben")!.line;
        expect(ben).toContain('"Hidden door" (private to Ben, also known to Ada)');
        expect(ben).not.toContain("does not know:");
    });

    it("caps unknown secrets with on-stage holders ahead of newer off-stage holders", async () => {
        const h = harness((text) => (text.includes(": ") ? [0, 1] : [1, 0]));
        const result = await retrieveLanes(
            h.host,
            input({
                stage: ["Ada", "Ben"],
                settings: pageSettings(),
                pages: [page("Ada", { type: "character" }), page("Ben", { type: "character" }), page("Remote")],
                events: [
                    event("onstage", ["old"], { knowledge: [fact("Ben", "Old stage secret", { knowers: [] })] }),
                    event("remote", ["query"], {
                        knowledge: Array.from({ length: RETRIEVAL_LIMITS.unawarePerCharacter + 2 }, (_, i) =>
                            fact("Remote", `Remote secret ${i}`, { knowers: [] }),
                        ),
                    }),
                ],
            }),
        );
        const ada = items(result, "pages").find(({ id }) => id === "Ada")!.line;
        const denied = ada.split("does not know: ")[1].split("; ");
        expect(denied).toHaveLength(RETRIEVAL_LIMITS.unawarePerCharacter);
        expect(denied[0]).toBe('"Old stage secret"');
        expect(denied.slice(1)).toEqual(expect.arrayContaining(['"Remote secret 7"', '"Remote secret 6"']));
        expect(items(result, "pages").some(({ id }) => id === "Remote")).toBe(false);
    });

    it("hides never pages from items, attendance, private labels, sole-holder secrets and link traversal", async () => {
        const h = harness((text) => (text === "Veiled" ? [1, 0] : [0, 1]));
        for (const hideScene of [false, true]) {
            const result = await retrieveLanes(
                h.host,
                input({
                    stage: ["Ada", "Veiled"],
                    settings: pageSettings(),
                    entries: [entry("query", "Veiled", "user")],
                    window: { start: 0, dropped: new Set() },
                    pages: [
                        page("scene", {
                            type: "scene",
                            participants: ["Ada", "Veiled"],
                            contextMode: hideScene ? "never" : "auto",
                            sections: [],
                        }),
                        page("Ada", { type: "character", links: ["Veiled"] }),
                        page("Veiled", { contextMode: "never", links: ["BehindVeil"] }),
                        page("BehindVeil"),
                    ],
                    events: [
                        event("knowledge", ["query"], {
                            knowledge: [
                                fact("Ada", "Shared secret", { knowers: ["Veiled"] }),
                                fact("Veiled", "Only hidden holder", { knowers: [] }),
                            ],
                        }),
                    ],
                }),
            );
            const card = await spentCard(result, 10000);
            const text = card.stable + card.volatile;
            expect(text).toContain('knows: "Shared secret" (private to Ada)');
            expect(text).not.toMatch(/Veiled|BehindVeil|Only hidden holder/);
            if (hideScene) expect(text).not.toContain("[m:scene]");
            else expect(text).toContain("present: Ada");
            expect(result.excluded).toContainEqual({ id: "Veiled", kind: "page", lane: "pages", reason: "never" });
            if (hideScene)
                expect(result.excluded).toContainEqual({
                    id: "scene",
                    kind: "page",
                    lane: "required",
                    reason: "never",
                });
            expect(h.calls.flat().join("\n")).not.toContain("Veiled: currentState");
        }
    });

    it("opens events for user recollections in several languages or high similarity, retaining a relevance floor", async () => {
        const h = harness((text) => (text === "weak" ? [20, 99] : [1, 0]));
        // Cosine 5/13 is below the opening threshold but above the relevance floor.
        const moderate = event("moderate", ["old"], { summary: "below-open" });
        const g = harness((text) => (text === "below-open" ? [5, 12] : text === "weak" ? [20, 99] : [1, 0]));
        const cases = [
            { text: "Remember our promise?", past: true, open: true },
            { text: "Why did you leave?", past: true, open: true },
            { text: "약속 기억나?", past: true, open: true },
            { text: "왜 떠났어?", past: true, open: true },
            { text: "約束を覚えている？", past: true, open: true },
            { text: "なぜ帰ったの？", past: true, open: true },
            { text: "记得约定吗？", past: true, open: true },
            { text: "为什么离开？", past: true, open: true },
            { text: "為什麼離開？", past: true, open: true },
            { text: "Pass the salt.", past: false, open: false },
            { text: "Remember our promise?", role: "char" as const, past: true, open: false },
        ];
        for (const row of cases) {
            expect(readsAsPast([row.text]), row.text).toBe(row.past);
            const result = await retrieveLanes(
                g.host,
                input({
                    events: [moderate, event("weak")],
                    entries: [entry("old"), entry("query", row.text, row.role ?? "user")],
                }),
            );
            expect(result.eventsOpen, `${row.role ?? "user"}: ${row.text}`).toBe(row.open);
            expect(
                items(result, "events").map(({ id }) => id),
                row.text,
            ).toEqual(row.open ? ["moderate"] : []);
        }
        const high = await retrieveLanes(h.host, input({ events: [event("high"), event("weak")] }));
        expect(high.eventsOpen).toBe(true);
        expect(items(high, "events").map(({ id }) => id)).toEqual(["high"]);
        const oldCue = await retrieveLanes(
            g.host,
            input({
                events: [moderate],
                entries: [
                    entry("old"),
                    entry("cue", "Remember?", "user"),
                    ...Array.from({ length: RETRIEVAL_LIMITS.queryMessages }, (_, i) =>
                        entry(`new-${i}`, "Continue.", "user"),
                    ),
                ],
            }),
        );
        expect(oldCue.eventsOpen).toBe(false);
        const disabled = await retrieveLanes(
            h.host,
            input({ settings: settings({ laneTargets: { pages: 0, events: 0, evidence: 0, threads: 0 } }) }),
        );
        expect(disabled.eventsOpen).toBe(false);
        expect(disabled.similarity).toBe("off");
        expect(items(disabled, "events")).toEqual([]);
    });

    it("reuses writer-warmed summary and key-line vectors and ranks on cosine rather than magnitude", async () => {
        const vectors: Record<string, number[]> = {
            "Aligned quote": [0.01, 0],
            "Large weak vector": [100, 1000],
            "Unrelated summary": [0, 2],
        };
        const h = harness((text) => vectors[text] ?? [1, 0]);
        const aligned = event("aligned", ["old"], {
            summary: " Unrelated summary \n",
            keyLines: [
                { speaker: "A", text: " Aligned quote " },
                { speaker: "B", text: "Aligned quote" },
                { speaker: "", text: " \n" },
            ],
        });
        const weak = event("weak", ["old"], { summary: " Large weak vector " });
        expect(eventVectorTexts(aligned)).toEqual(["Unrelated summary", "Aligned quote"]);
        // This is the writer's warming seam, using explicit expected texts, not retrieval's text builder.
        await new HypaProcesser(h.host.embeddings, h.host.db.hypaModel).addText([
            "Unrelated summary",
            "Aligned quote",
            "Large weak vector",
        ]);
        h.calls.length = 0;
        const result = await retrieveLanes(
            h.host,
            input({ events: [weak, aligned], entries: [entry("old"), entry("query", "Continue.", "user")] }),
        );
        expect(result.similarity).toBe("used");
        expect(result.eventsOpen).toBe(true);
        expect(items(result, "events").map(({ id }) => id)).toEqual(["aligned"]);
        expect(items(result, "events")[0].score).toBeCloseTo(0.8);
        expect(h.calls).toEqual([["Continue."]]);
    });

    it("omits inactive and fully raw events and orders flow by chat position without counting blank replies", async () => {
        const h = harness();
        const entries = [
            entry("old"),
            entry("middle"),
            entry("blank", " \n"),
            entry("new-user", "Remember?", "user"),
            entry("new-reply"),
        ];
        const events = [
            event("new", ["new-reply"]),
            event("middle", ["middle"]),
            event("old"),
            event("retracted", ["old"], { status: "retracted" }),
            event("stale", ["old"], { status: "stale" }),
            event("suppressed", ["old"], { suppressed: true }),
        ];
        const result = await retrieveLanes(
            h.host,
            input({
                events,
                entries,
                window: { start: 3, dropped: new Set([0, 1]) },
                settings: settings({ flowEvents: 2 }),
            }),
        );
        expect(items(result, "events").map(({ id }) => id)).toEqual(["middle", "old"]);
        expect(result.excluded).toEqual(
            expect.arrayContaining([
                { id: "new", kind: "event", lane: "events", reason: "not-relevant" },
                { id: "stale", kind: "event", lane: "events", reason: "stale" },
                { id: "suppressed", kind: "event", lane: "events", reason: "never" },
            ]),
        );
        expect(items(result, "flow").map(({ id }) => id)).toEqual(["new", "middle"]);
        const card = await spentCard(result, 100);
        expect(card.stable).not.toMatch(/retracted|stale|suppressed/);
        expect(card.volatile).not.toMatch(/retracted|stale|suppressed|\[m:new\]/);
        expect(items(result, "flow").map(({ line }) => line)).toEqual([
            "[m:flow:new] 1 turn ago: new",
            "[m:flow:middle] 2 turns ago: middle",
        ]);
    });

    it("takes bounded source excerpts before lexical evidence and still finds evidence with events closed", async () => {
        const h = harness((text) => (["event summary", "beacon", "beacon raw"].includes(text) ? [1, 0] : [5, 12]));
        const longExcerpt = `beacon ${"x".repeat(450)}`;
        const entries = [
            entry("source0", "No match"),
            entry("source1", `Preface\n\n${longExcerpt}\n\nAfterword`),
            entry("source2", "beacon source two"),
            ...Array.from({ length: 8 }, (_, i) =>
                entry(`lexical${i}`, `Preface ${i}\n\nbeacon lexical ${i}\n\nAfterword ${i}`),
            ),
            entry("uncovered", "beacon uncovered"),
            entry("raw-source", "beacon raw", "user"),
            entry("query", "beacon", "user"),
        ];
        const remembered = event("remembered", ["source0", "source1", "source2", "raw-source"], {
            summary: "event summary",
        });
        for (const open of [true, false]) {
            h.calls.length = 0;
            const result = await retrieveLanes(
                h.host,
                input({
                    events: [{ ...remembered, summary: open ? "event summary" : "quiet summary" }],
                    entries,
                    window: { start: 12, dropped: new Set(Array.from({ length: 11 }, (_, i) => i)) },
                    settings: settings({
                        laneTargets: { pages: 0, events: 1000, evidence: 1000, threads: 0 },
                    }),
                }),
            );
            expect(result.eventsOpen).toBe(open);
            const evidence = items(result, "evidence");
            if (open) {
                expect(evidence.slice(0, 2).map(({ id, requires, reason }) => ({ id, requires, reason }))).toEqual([
                    { id: "source2", requires: "events:remembered", reason: "eventSource" },
                    { id: "source1", requires: "events:remembered", reason: "eventSource" },
                ]);
                expect(evidence[1].line).toBe(
                    `[m:source1] character: "${longExcerpt.slice(0, RETRIEVAL_LIMITS.excerptChars)}"`,
                );
                expect(evidence.filter(({ reason }) => reason === "eventSource")).toHaveLength(
                    RETRIEVAL_LIMITS.excerptsPerEvent,
                );
            }
            expect(evidence.find(({ id }) => id === "lexical7")?.reason).toBe("matchedMessage");
            expect(evidence.some(({ id }) => ["uncovered", "raw-source", "query"].includes(id))).toBe(false);
            const documents = h.calls
                .flat()
                .filter((text) => !["beacon", "beacon raw", "event summary", "quiet summary"].includes(text));
            expect(documents.length).toBeGreaterThan(0);
            expect(
                documents.every(
                    (text) =>
                        text.length <= RETRIEVAL_LIMITS.excerptChars &&
                        !text.includes("Preface") &&
                        !text.includes("Afterword"),
                ),
            ).toBe(true);
            const card = await spentCard(result, 1000);
            const admitted = card.items.filter(({ lane }) => lane === "evidence");
            expect(admitted).toHaveLength(RETRIEVAL_LIMITS.evidenceItems);
            if (open) expect(admitted.slice(0, 2).map(({ id }) => id)).toEqual(["source2", "source1"]);
        }
    });

    it("lists unfinished unassigned and on-stage threads while omitting ended or off-stage threads", async () => {
        const h = harness();
        const threads: MemoryThread[] = [
            { id: "unassigned", title: "Find the key", who: [], state: "open" },
            { id: "paused", title: "Wait", who: ["alice"], state: "paused" },
            { id: "progress", title: "Search", who: ["alice"], state: "progress" },
            { id: "partial", title: "Half done", who: ["alice"], state: "partial" },
            { id: "absent", title: "Elsewhere", who: ["bob"], state: "open" },
            { id: "done", title: "Finished", who: ["alice"], state: "done" },
            { id: "cancelled", title: "Abandoned", who: [], state: "cancelled" },
        ];
        for (const target of [1000, 0]) {
            const result = await retrieveLanes(
                h.host,
                input({
                    events: [],
                    threads,
                    stage: ["alice"],
                    settings: settings({ laneTargets: { pages: 0, events: 0, evidence: 0, threads: target } }),
                }),
            );
            expect(
                items(result, "threads")
                    .map(({ id }) => id)
                    .sort(),
            ).toEqual(target ? ["partial", "paused", "progress", "unassigned"] : []);
        }
    });

    it("caps ranked event and thread candidates before token counting and marks the cut candidates as budget", async () => {
        const h = harness();
        const events = Array.from({ length: RETRIEVAL_LIMITS.eventCandidates + 2 }, (_, i) =>
            event(`event${i}`, [`source${i}`]),
        );
        const threads: MemoryThread[] = Array.from({ length: RETRIEVAL_LIMITS.threadCandidates + 2 }, (_, i) => ({
            id: `thread${i}`,
            title: `Thread ${i}`,
            who: [],
            state: "open",
        }));
        const result = await retrieveLanes(
            h.host,
            input({
                events,
                threads,
                entries: [...events.map((_, i) => entry(`source${i}`)), entry("query", "Continue.", "user")],
                window: { start: events.length, dropped: new Set() },
                settings: settings({ laneTargets: { pages: 0, events: 1000, evidence: 0, threads: 1000 } }),
            }),
        );
        expect(items(result, "events").map(({ id }) => id)).toEqual(
            events
                .slice(2)
                .toReversed()
                .map(({ id }) => id),
        );
        expect(items(result, "threads").map(({ id }) => id)).toEqual(
            threads
                .slice(2)
                .toReversed()
                .map(({ id }) => id),
        );
        expect(result.excluded).toHaveLength(4);
        expect(result.excluded).toEqual(
            expect.arrayContaining([
                ...["event0", "event1"].map((id) => ({ id, kind: "event", lane: "events", reason: "budget" })),
                ...["thread0", "thread1"].map((id) => ({ id, kind: "thread", lane: "threads", reason: "budget" })),
            ]),
        );
        const counted: string[] = [];
        await buildMemoryCard(
            {
                tokenizeChat: async ({ content }) => {
                    if (content.startsWith("[m:")) counted.push(content);
                    return 1;
                },
            },
            { maximum: 10000, lanes: result.lanes },
        );
        expect(counted).toHaveLength(RETRIEVAL_LIMITS.eventCandidates + RETRIEVAL_LIMITS.threadCandidates);
        expect(counted.join("\n")).not.toMatch(/\[m:(?:event|thread)[01]\]/);
    });

    it("returns a redacted failed similarity result when the embedding provider fails", async () => {
        const h = harness();
        const key = h.host.db.hypaCustomSettings.key;
        h.control.error = new Error(`Provider rejected ${key} ${encodeURIComponent(key)} memory-secret`);
        const result = await retrieveLanes(h.host, input({ settings: settings({ flowEvents: 1 }) }));
        expect(result.similarity).toBe("failed");
        expect(result.failure).toContain("Provider rejected");
        expect(result.failure).toContain("[redacted]");
        expect(result.failure).not.toContain(key);
        expect(result.failure).not.toContain(encodeURIComponent(key));
        expect(result.failure).not.toContain("memory-secret");
        const card = await spentCard(result, 100);
        expect(card.stable).toContain("[m:flow:memory]");
    });

    it("propagates cancellation from the host fence after embedding success or failure", async () => {
        for (const fails of [false, true]) {
            const h = harness();
            const cancellation = new Error("Job cancelled");
            if (fails) h.control.error = new Error("Provider unavailable");
            h.control.afterFetch = () => {
                h.control.cancelled = cancellation;
            };
            await expect(retrieveLanes(h.host, input())).rejects.toBe(cancellation);
        }
    });
});

it.each(["required", "pages"] as const)(
    "filters relationship lines by the send's cast in the %s lane",
    async (lane) => {
        const h = harness();
        const ada = page("Ada", {
            type: "character",
            contextMode: lane === "required" ? "always" : "auto",
            sections: [
                section(
                    "relationships",
                    [
                        "* CAPTAIN  VALE: trusted",
                        "- Cara: friendly",
                        "- Dara: wary",
                        "- Eve: loyal",
                        "- Rowan: distant",
                        "- Rowan and Cara: rivals",
                        "- Ada: self",
                        "- A stranger: owes a favor",
                    ].join("\n"),
                ),
            ],
        });
        const result = await retrieveLanes(
            h.host,
            input({
                events: [],
                settings:
                    lane === "required"
                        ? settings({ laneTargets: { pages: 0, events: 0, evidence: 0, threads: 0 } })
                        : pageSettings(),
                entries: [entry("query", "Cara is here", "user")],
                stage: ["Ada", "Ben"],
                pages: [
                    ada,
                    page("Ben", { aliases: ["Captain\tVale"] }),
                    page("Cara", { links: ["Dara"] }),
                    page("Dara"),
                    page("Eve", { contextMode: "always" }),
                    page("Rowan"),
                ],
            }),
        );
        const line = items(result, lane).find(({ id }) => id === "Ada")!.line;
        expect(line).toContain("* CAPTAIN VALE: trusted");
        expect(line).toContain("- Cara: friendly");
        expect(line).toContain("- Dara: wary");
        expect(line).toContain("- Eve: loyal");
        expect(line).toContain("- Rowan and Cara: rivals");
        expect(line).toContain("- A stranger: owes a favor");
        expect(line).not.toContain("- Rowan: distant");
        expect(line).not.toContain("- Ada: self");
        expect(ada.sections[0].body).toContain("- Rowan: distant");
    },
);

it("keeps unknown relationship names, matches names at word edges only, and never matches a never page", async () => {
    const h = harness();
    const result = await retrieveLanes(
        h.host,
        input({
            events: [],
            settings: pageSettings(),
            stage: ["Ada", "Veiled"],
            pages: [
                page("Ada", {
                    type: "character",
                    sections: [
                        section(
                            "relationships",
                            [
                                "- A stranger: helpful",
                                "- Hidden name: trusted",
                                "- Rowan: distant",
                                "- Someone: even-tempered",
                                "- 카라는 적",
                            ].join("\n"),
                        ),
                    ],
                }),
                page("Veiled", { aliases: ["Hidden name"], contextMode: "never", links: ["Rowan"] }),
                page("Rowan"),
                page("Eve"),
                page("카라"),
            ],
        }),
    );
    const line = items(result, "pages").find(({ id }) => id === "Ada")!.line;
    expect(line).toContain("- A stranger: helpful");
    expect(line).toContain("- Hidden name: trusted");
    expect(line).toContain("- Someone: even-tempered");
    expect(line).not.toContain("- Rowan: distant");
    expect(line).not.toContain("- 카라는 적");
});

it("sends a single relationship line whole even when it names an off-cast page", async () => {
    const h = harness();
    const result = await retrieveLanes(
        h.host,
        input({
            events: [],
            settings: pageSettings(),
            stage: ["Ada"],
            pages: [
                page("Ada", { type: "character", sections: [section("relationships", "- Rowan: distant")] }),
                page("Rowan"),
            ],
        }),
    );
    expect(items(result, "pages").find(({ id }) => id === "Ada")!.line).toContain("relationships: - Rowan: distant");
});

it("omits a character page when filtering leaves no relationship lines or other content", async () => {
    const h = harness();
    const result = await retrieveLanes(
        h.host,
        input({
            events: [],
            settings: pageSettings(),
            stage: ["Ada"],
            pages: [
                page("Ada", {
                    type: "character",
                    sections: [section("relationships", "- Rowan: distant\n* Rowan: wary")],
                }),
                page("Rowan"),
            ],
        }),
    );
    expect(items(result, "pages").some(({ id }) => id === "Ada")).toBe(false);
    expect(result.excluded).toContainEqual({ id: "Ada", kind: "page", lane: "pages", reason: "not-relevant" });
});
