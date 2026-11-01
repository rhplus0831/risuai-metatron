// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
    normalizeStructuredMemorySettings,
    type MemoryEvent,
    type MemoryThread,
} from "../../../../../shared/structuredMemory.ts";
import { createVectorCache } from "../../../data/vectorCache.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { createEmbeddings, HypaProcesser } from "../../embeddings.ts";
import type { MemoryHost } from "../host.ts";
import { buildMemoryCard } from "./card.ts";
import type { ReadEntry } from "./lanes.ts";
import { eventVectorTexts, readsAsPast, RETRIEVAL_LIMITS, retrieveLanes } from "./retrieve.ts";

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
        entries: [entry("old"), entry("query", "Continue.", "user"), entry("reply", "All right.")],
        window: { start: 1, dropped: new Set([0]) },
        stage: [],
        settings: settings(),
        ...fields,
    };
}
const items = (result: Awaited<ReturnType<typeof retrieveLanes>>, lane: string) =>
    result.lanes.find((row) => row.lane === lane)!.items;

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

describe("structured memory retrieval", () => {
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
        const card = await buildMemoryCard({ tokenizeChat: async () => 1 }, { maximum: 100, lanes: result.lanes });
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
            const card = await buildMemoryCard({ tokenizeChat: async () => 1 }, { maximum: 1000, lanes: result.lanes });
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
        const card = await buildMemoryCard({ tokenizeChat: async () => 1 }, { maximum: 100, lanes: result.lanes });
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
