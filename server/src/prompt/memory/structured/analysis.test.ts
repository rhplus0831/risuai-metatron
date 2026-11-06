// @vitest-environment node
import { describe, expect, it, onTestFinished } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import type { MemoryThread } from "../../../../../shared/structuredMemory.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../data/kinds.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { createResourceStore } from "../../../data/resourceStore.ts";
import { memoryRecords, writeMemory } from "../../../tests/memoryFixtures.ts";
import { admitAnalysis, parseAnalysis } from "./analysis.ts";
import { withRetractedEvidence } from "./reconcile.ts";

const draft = (overrides: Record<string, unknown> = {}) => ({
    title: "The promise",
    summary: "Cara promises to return.",
    participants: [],
    keyLines: [],
    stateChanges: [],
    knowledge: [],
    relationshipShifts: [],
    openThreads: { add: [], close: [], transitions: [] },
    ...overrides,
});

describe("analysis admission", () => {
    it("replaces a repeated event's earlier thread moves so retracting it undoes the admitted moves", () => {
        const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
        const store = createResourceStore({ file: ":memory:", kinds });
        onTestFinished(() => store.close());
        const messages: Message[] = ["first", "repeat"].map((chatId) => ({
            chatId,
            role: "char",
            data: "Cara promises to return.",
        }));
        store.applyChanges({
            ops: [{ kind: kinds.get("characters")!, id: "c", baseRevision: null, data: { chaId: "c" } }],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { name: "K", note: "", localLore: [], message: messages } }],
                },
            ],
        });
        const [opening, repeated] = memoryRecords(["opening", "repeated"], "Cara promises to return.").events;
        repeated.sources = [{ messageId: "first", index: 0, hash: messageSourceHash(messages[0]) }];
        repeated.openThreads = {
            add: [],
            close: ["cancel"],
            transitions: [
                { threadId: "close", to: "progress" },
                { threadId: "advance", to: "paused" },
                { threadId: "unmoved", to: "partial" },
            ],
        };
        const threads: MemoryThread[] = [
            { id: "close", title: "Close", who: [], state: "progress", openedBy: "opening" },
            // A user reopened this thread after the event's earlier close.
            { id: "cancel", title: "Cancel", who: [], state: "open", openedBy: "opening" },
            { id: "advance", title: "Advance", who: [], state: "paused", openedBy: "opening" },
            { id: "unmoved", title: "Unmoved", who: [], state: "partial", openedBy: "opening" },
        ];
        writeMemory(store, "c", "k", { events: [opening, repeated], threads });
        const lastEvent = store.memory.readRecord("c", "k", "events", "repeated")!.data;
        const window = {
            messages: [messages[1]],
            sources: [{ messageId: "repeat", index: 1, hash: messageSourceHash(messages[1]) }],
        };
        const admitted = admitAnalysis({
            draft: {
                ...lastEvent,
                openThreads: {
                    add: [],
                    close: ["close"],
                    transitions: [
                        { threadId: "cancel", to: "cancelled" },
                        { threadId: "advance", to: "progress" },
                    ],
                },
            },
            warnings: [],
            window,
            runId: "repeat-run",
            pages: new Set(),
            threads: new Map(threads.map((thread) => [thread.id, thread])),
            lastEvent,
            messages,
            newId: () => "new-event",
        });
        expect(admitted.repeated).toBe(true);
        expect(admitted.event).toMatchObject({
            id: "repeated",
            repeatCount: 1,
            sources: [...lastEvent.sources, ...window.sources],
        });
        writeMemory(store, "c", "k", { events: [admitted.event], threads: admitted.threads });
        const saved = store.memory.readRecord("c", "k", "events", "repeated")!.data;
        for (const thread of [
            { ...threads[0], state: "done", closedBy: "repeated" },
            { ...threads[1], state: "cancelled", closedBy: "repeated" },
            { ...threads[2], state: "progress" },
            threads[3],
        ]) {
            expect(store.memory.readRecord("c", "k", "threads", thread.id)!.data).toEqual(thread);
        }

        writeMemory(
            store,
            "c",
            "k",
            withRetractedEvidence(
                store,
                { chaId: "c", chatId: "k" },
                {
                    events: [{ ...saved, status: "retracted" }],
                },
            ),
        );
        for (const thread of threads) {
            expect(store.memory.readRecord("c", "k", "threads", thread.id)!.data).toEqual({ ...thread, state: "open" });
        }
        expect(saved.openThreads).toEqual({
            add: [],
            close: ["close"],
            transitions: [
                { threadId: "unmoved", to: "partial" },
                { threadId: "cancel", to: "cancelled" },
                { threadId: "advance", to: "progress" },
            ],
        });
    });

    it("bounds strings and lists, reports discarded elements, and rounds and clamps axes", () => {
        const lines = Array.from({ length: 6 }, (_, i) => ({ speaker: "Cara", text: `Line ${i}` }));
        const threads = Array.from({ length: 9 }, (_, i) => ({ title: `Promise ${i}`, who: [] }));
        const parsed = parseAnalysis(
            `<Thoughts>{not JSON}</Thoughts>\n\`\`\`json\n${JSON.stringify({
                event: draft({
                    title: `${"t".repeat(119)}😀tail`,
                    summary: "s".repeat(801),
                    keyLines: [null, ...lines],
                    openThreads: { add: threads, close: [], transitions: [] },
                    axes: { persistence: -2, change: 1.6, reach: 20 },
                    grade: 99,
                    id: "model-owned-id",
                }),
                pageCandidates: [{ create: { type: "character", title: "Ignored" } }],
            })}\n\`\`\``,
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(parsed.error);
        expect(parsed.analysis.event).toMatchObject({
            title: "t".repeat(119),
            summary: "s".repeat(800),
            keyLines: lines.slice(0, 5),
            openThreads: { add: threads.slice(0, 8), close: [], transitions: [] },
            axes: { persistence: 0, change: 2, reach: 3 },
        });
        expect(parsed.analysis.event).not.toHaveProperty("grade");
        expect(parsed.analysis.event).not.toHaveProperty("id");
        expect(parsed.analysis.pageCandidates).toEqual([]);
        expect(parsed.warnings).toEqual([
            { kind: "malformed", detail: "keyLines: 1" },
            { kind: "capped", detail: "keyLines: 1" },
            { kind: "capped", detail: "openThreads.add: 1" },
            { kind: "malformed", detail: "pageCandidates: 1" },
        ]);
    });

    it("names the parser's reason when the answer is not JSON", () => {
        expect(parseAnalysis('{"title": "The "promise""}')).toEqual({
            ok: false,
            reason: "invalidJson",
            error: expect.stringMatching(/^The model's answer is not valid JSON: \S/),
        });
    });

    it("rejects missing or mistyped required fields with the offending field name", () => {
        for (const field of [
            "title",
            "summary",
            "participants",
            "keyLines",
            "stateChanges",
            "knowledge",
            "relationshipShifts",
            "openThreads",
        ]) {
            for (const invalid of [undefined, 42]) {
                expect(parseAnalysis(JSON.stringify(draft({ [field]: invalid }))), field).toEqual({
                    ok: false,
                    reason: "invalidField",
                    error: expect.stringContaining(`"${field}"`),
                });
            }
        }
        for (const field of ["add", "close", "transitions"]) {
            expect(
                parseAnalysis(
                    JSON.stringify(draft({ openThreads: { add: [], close: [], transitions: [], [field]: null } })),
                ),
            ).toEqual({
                ok: false,
                reason: "invalidField",
                error: expect.stringContaining(`"openThreads.${field}"`),
            });
        }
    });

    it("stores summed event and knowledge grades and leaves missing or incomplete axes ungraded", () => {
        for (const [axes, grade] of [
            [{ persistence: 1, change: 2, reach: 3 }, 6],
            [undefined, undefined],
            [{ persistence: 3, change: 3 }, undefined],
        ] as const) {
            const parsed = parseAnalysis(
                JSON.stringify(
                    draft({
                        axes,
                        grade: 9,
                        knowledge: [
                            {
                                pageId: "cara",
                                fact: "She will return",
                                stance: "knows",
                                quote: "I will return.",
                                axes,
                                grade: 9,
                            },
                        ],
                    }),
                ),
            );
            if (!parsed.ok) throw new Error(parsed.error);
            const admitted = admitAnalysis({
                draft: parsed.analysis.event,
                warnings: parsed.warnings,
                window: {
                    messages: [{ chatId: "m1", role: "char", data: "I will return." }],
                    sources: [{ messageId: "m1", hash: "raw-message-hash", index: 0 }],
                },
                runId: "run",
                pages: new Set(["cara"]),
                threads: new Map(),
                lastEvent: null,
                messages: [],
                newId: () => "event",
            });
            expect(admitted.event.knowledge).toHaveLength(1);
            for (const record of [admitted.event, admitted.event.knowledge[0]]) {
                if (grade === undefined) {
                    expect(record).not.toHaveProperty("axes");
                    expect(record).not.toHaveProperty("grade");
                } else {
                    expect(record).toMatchObject({ axes, grade: 6 });
                }
            }
        }
    });
});
