// Shared fixtures for the tests that restore structured memory (not a test file itself).
import type { MemoryEventWrite, MemoryChanges } from "../data/memoryStore.ts";
import type { MemoryPage, MemoryRun, MemoryThread } from "../../../shared/structuredMemory.ts";
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
