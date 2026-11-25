// Shared fixtures for the tests that restore structured memory (not a test file itself).
import { messageSourceHash, type MemoryEventWrite, type MemoryChanges } from "../data/memoryStore.ts";
import type { MemoryPage, MemoryRun, MemoryThread } from "../../../shared/structuredMemory.ts";
import type { ContextReport } from "../../../shared/contextReport.ts";
import type { Message } from "../../../shared/database.ts";
import { memoryAnchorState } from "../../../shared/structuredMemory.ts";
import type { ResourceStore } from "../data/resourceStore.ts";

export const memoryKinds = ["pages", "events", "threads", "runs"] as const;
export const memoryTables = ["memory_state", "memory_pages", "memory_events", "memory_threads", "memory_runs"];

/** The same ids in different tables are independent records. */
export function memoryRecords(ids: string[], title = "Saved 한글 😀") {
    return {
        pages: ids.map((id): MemoryPage => ({
            id,
            type: "location",
            title,
            aliases: [],
            contextMode: "auto",
            sections: [{ heading: "Gate", body: title, provenance: [], sources: [], locked: false, updatedAt: 123 }],
            links: [],
            retrieval: { keywords: ["gate"] },
            history: [],
        })),
        events: ids.map((id): MemoryEventWrite => ({
            id,
            title,
            summary: title,
            status: "active",
            participants: [],
            storyTime: { text: "Morning" },
            keyLines: [],
            stateChanges: [],
            knowledge: [],
            relationshipShifts: [],
            openThreads: { add: [], close: [], transitions: [] },
            sources: [],
            writerRun: id,
        })),
        threads: ids.map((id): MemoryThread => ({ id, title, who: [], state: "open" })),
        runs: ids.map((id): MemoryRun => ({
            id,
            window: [],
            model: "writer",
            inputTokens: 10,
            outputTokens: 20,
            durationMs: 30,
            result: "recorded",
            input: title,
        })),
    };
}

export function writeMemory(store: ResourceStore, characterId: string, chatId: string, changes: MemoryChanges) {
    return store.memory.write(
        characterId,
        chatId,
        { epoch: store.epoch(), baseRevision: store.memory.readContents(characterId, chatId)!.revision },
        changes,
    );
}

/** A re-recorded early event, two invalid sources, and a person's kept event, in storage order. */
export function projectionHistory() {
    const message = [
        { chatId: "early", role: "user" as const, data: "Arrived" },
        { chatId: "pin", role: "char" as const, data: "A promise" },
        { chatId: "late", role: "user" as const, data: "Departed" },
        { chatId: "changed", role: "char" as const, data: "Revised answer" },
        { chatId: "kept", role: "char" as const, data: "Revised but accepted" },
    ];
    const source = (id: string, original?: string) => {
        const index = message.findIndex((m) => m.chatId === id);
        const m = message[index] ?? { chatId: id, role: "char" as const, data: "Removed answer" };
        return {
            messageId: id,
            index: index < 0 ? 99 : id === "early" ? 50 : index + 10,
            hash: messageSourceHash({ ...m, data: original ?? m.data }),
        };
    };
    const make = (id: string, overrides: Partial<MemoryEventWrite> = {}): MemoryEventWrite => ({
        ...memoryRecords([id], `Summary ${id}`).events[0],
        sources: [source(id)],
        ...overrides,
    });
    const kept = make("kept", { sources: [source("kept", "Original answer")] });
    kept.keptState = memoryAnchorState(kept.sources, message, messageSourceHash);
    const events = [
        make("late", { grade: 6 }),
        make("pin", { pinned: true, grade: 0, sources: [source("pin"), source("late")] }),
        make("changed", { sources: [source("changed", "Original answer")] }),
        make("gone"),
        kept,
        make("retracted", { status: "retracted", sources: [source("early")] }),
        make("stale", { status: "stale", sources: [source("early")] }),
        make("early", { grade: 5 }),
    ];
    const manifest = (id: string, lane: "flow" | "events"): ContextReport => ({
        v: 1,
        maxContext: 1000,
        maxResponse: 100,
        input: 100,
        adjustment: 0,
        attributionExact: true,
        tokenScope: "test",
        historyDigest: "history",
        sections: [],
        history: { total: 5, kept: 5, totalUser: 2, keptUser: 2, droppedTokens: 0 },
        lore: { budgetUsed: 0, budget: 0, rejectedCount: 0, rejectedTokens: 0, active: 0 },
        memory: {
            kind: "structuredMemory",
            tokens: 10,
            coverage: "covered",
            items: [{ id, lane, kind: "event", reason: "Selected", tokens: 10, verified: true }],
        },
    });
    const messages: Message[] = message.map((m, index) => ({
        ...m,
        ...(index === 0 || index === 2
            ? { generationInfo: { context: manifest(index === 0 ? "late" : "early", index === 0 ? "events" : "flow") } }
            : {}),
    }));
    const expected = {
        summaries: [
            { text: "Summary early", chatMemos: ["early"], isImportant: false },
            { text: "Summary pin", chatMemos: ["pin", "late"], isImportant: true },
            { text: "Summary late", chatMemos: ["late"], isImportant: true },
            { text: "Summary kept", chatMemos: ["kept"], isImportant: false },
        ],
        metrics: {
            lastImportantSummaries: [],
            lastRecentSummaries: [0],
            lastSimilarSummaries: [],
            lastRandomSummaries: [],
        },
    };
    return { messages, events, expected };
}
