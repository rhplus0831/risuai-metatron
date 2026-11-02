// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import {
    ADOPTED_WRITER_RUN,
    coveredMessages,
    reconcileMemoryEvents,
    sealHypaV3Data,
    STRUCTURED_MEMORY_LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import { adoptedEvents } from "./adopt.ts";
import { confirmedWindows, recordedMessages } from "./window.ts";

const message = (chatId: string, role: Message["role"], data = chatId): Message => ({ chatId, role, data });
const hashOf = ({ role, data }: Message) => JSON.stringify([role, data]);
function adopt(data: unknown, messages: Message[] = []) {
    let id = 0;
    return adoptedEvents({ data, messages, hashOf, newId: () => `adopted-${++id}` });
}

it("preserves whole summary text and stored order while deriving bounded first-sentence titles and pins", () => {
    const long = `  At 3.5 miles, we stopped. ${"More detail. ".repeat(100)}\n`;
    const limit = STRUCTURED_MEMORY_LIMITS.eventTitleChars;
    const rows = [
        { text: long, title: "At 3.5 miles, we stopped.", isImportant: true },
        { text: `${"L".repeat(limit + 12)}. Next sentence.`, title: "L".repeat(limit), isImportant: false },
        { text: "First line\nSecond line.", title: "First line" },
        { text: "出発。到着", title: "出発。" },
        { text: "出発！到着", title: "出発！" },
        { text: "出発？到着", title: "出発？" },
    ];
    const data = {
        summaries: [
            { text: " \n\t", chatMemos: ["m0"] },
            ...rows.map(({ title, ...entry }) => ({ ...entry, chatMemos: ["m0"], tags: ["old-tag"] })),
            { text: "", chatMemos: ["m0"] },
        ],
    };
    const before = structuredClone(data);
    expect(adopt(data, [message("m0", "char", "Stored reply")])).toEqual(
        rows.map(({ text, title, isImportant }, index) => ({
            id: `adopted-${index + 1}`,
            title,
            summary: text,
            participants: [],
            storyTime: { text: "" },
            keyLines: [],
            stateChanges: [],
            knowledge: [],
            relationshipShifts: [],
            openThreads: { add: [], close: [], transitions: [] },
            sources: [{ messageId: "m0", hash: '["char","Stored reply"]', index: 0 }],
            status: "active",
            writerRun: ADOPTED_WRITER_RUN,
            ...(isImportant === true ? { pinned: true } : {}),
        })),
    );
    expect(data).toEqual(before);
});

it("drops the null greeting memo and anchors each cited id once in current message order so it reconciles whole", () => {
    const messages = [message("m0", "user", "Stored question"), message("m1", "char", "Stored answer")];
    const events = adopt({ summaries: [{ text: "The answer.", chatMemos: [null, "m1", "m0", "m1", "m0"] }] }, messages);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
        status: "active",
        sources: [
            { messageId: "m0", hash: '["user","Stored question"]', index: 0 },
            { messageId: "m1", hash: '["char","Stored answer"]', index: 1 },
        ],
    });
    expect(events[0]).not.toHaveProperty("staleReason");
    expect(reconcileMemoryEvents(events, messages, hashOf)).toEqual(events);
});

it("stores missing and sourceless summaries stale while recording their citations and leaving only later writer turns", async () => {
    const messages = Array.from({ length: 7 }, (_, index) => message(`m${index}`, index % 2 === 0 ? "user" : "char"));
    const events = adopt(
        {
            summaries: [
                { text: "Whole event.", chatMemos: ["m0", "m1"] },
                { text: "A message is gone.", chatMemos: ["gone", "m3", "m2", "gone"] },
                { text: "No stored source.", chatMemos: [null, ""] },
            ],
        },
        messages,
    ).map((event) => ({ ...event, createdRevision: 1 }));
    expect(events.map(({ status, staleReason, sources }) => ({ status, staleReason, sources }))).toEqual([
        {
            status: "active",
            staleReason: undefined,
            sources: [
                { messageId: "m0", hash: '["user","m0"]', index: 0 },
                { messageId: "m1", hash: '["char","m1"]', index: 1 },
            ],
        },
        {
            status: "stale",
            staleReason: "missing",
            sources: [
                { messageId: "m2", hash: '["user","m2"]', index: 2 },
                { messageId: "m3", hash: '["char","m3"]', index: 3 },
                { messageId: "gone", hash: null, index: null },
            ],
        },
        { status: "stale", staleReason: "missing", sources: [] },
    ]);
    expect(reconcileMemoryEvents(events, messages, hashOf)).toEqual(events);
    expect([...coveredMessages(events)]).toEqual(["m0", "m1"]);
    expect([...recordedMessages(events)]).toEqual(["m0", "m1", "m2", "m3", "gone"]);
    const windows = await confirmedWindows({
        messages,
        confirmedBefore: "m6",
        recorded: recordedMessages(events),
        cadence: { cadence: "everyTurn", cadenceTurns: 1, cadenceTokens: 100, cadenceRatio: 0.1 },
        maxContext: 1000,
        tokenizer: {
            tokenizeChat: async () => {
                throw new Error("Turn cadence needs no tokenizer");
            },
        },
        limit: 10,
    });
    expect(windows?.map(({ messages }) => messages.map(({ chatId }) => chatId))).toEqual([["m4", "m5"]]);
});

it("never adopts sealed HypaV3 projections even when they contain summary text", () => {
    const data = sealHypaV3Data({ summaries: [{ text: "Projected event.", chatMemos: ["m0"], isImportant: true }] });
    expect(adopt(data, [message("m0", "char")])).toEqual([]);
});
