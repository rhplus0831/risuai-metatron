// @vitest-environment node
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import { coveredMessages, type MemoryEvent } from "../../../../../shared/structuredMemory.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../data/kinds.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { createResourceStore } from "../../../data/resourceStore.ts";
import { memoryRecords, writeMemory } from "../../../tests/memoryFixtures.ts";
import { reconcileEvents, reconcileMessageChanges } from "./reconcile.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function messageStore(messages: Message[]) {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({ file: ":memory:", kinds });
    onTestFinished(() => store.close());
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
    return store;
}

it.each([
    { label: "one live event body", staged: false },
    { label: "one live and one staged event body", staged: true },
])("reads $label for a one-message rewrite among 1,000 distinct events", ({ staged }) => {
    const messages: Message[] = Array.from({ length: 1000 }, (_, index) => ({
        chatId: `message-${index}`,
        role: "user",
        data: `Message ${index}`,
    }));
    const store = messageStore(messages);
    const events = memoryRecords(messages.map((_, index) => `event-${index}`)).events.map((event, index) => ({
        ...event,
        sources: [{ messageId: messages[index].chatId!, index, hash: messageSourceHash(messages[index]) }],
    }));
    writeMemory(store, "c", "k", { events });
    if (staged) {
        store.memory.rebuild.begin(
            "c",
            "k",
            {
                epoch: store.epoch(),
                mode: "rebuild",
                plan: [messages.map((message) => message.chatId!)],
            },
            {},
        );
        store.memory.rebuild.staged.write(
            "c",
            "k",
            {
                epoch: store.epoch(),
                baseRevision: store.memory.rebuild.staged.readContents("c", "k")!.revision,
            },
            { events },
        );
    }
    const liveRead = vi.spyOn(store.memory, "readRecord");
    const stagedRead = vi.spyOn(store.memory.rebuild.staged, "readRecord");
    reconcileMessageChanges(store, {
        epoch: store.epoch(),
        characterId: "c",
        id: "k",
        rewritten: ["message-500"],
        retracted: [],
    });
    const eventReads = (calls: typeof liveRead.mock.calls) => calls.filter(([, , kind]) => kind === "events");
    expect(eventReads(liveRead.mock.calls)).toHaveLength(1);
    expect(eventReads(stagedRead.mock.calls)).toHaveLength(staged ? 1 : 0);
    expect(eventReads(liveRead.mock.calls)).toEqual([["c", "k", "events", "event-500"]]);
    expect(eventReads(stagedRead.mock.calls)).toEqual(staged ? [["c", "k", "events", "event-500"]] : []);
    liveRead.mockRestore();
    stagedRead.mockRestore();

    for (const memory of staged ? [store.memory, store.memory.rebuild.staged] : [store.memory]) {
        expect(memory.readContents("c", "k")!.events.map(({ id }) => id)).toEqual(events.map(({ id }) => id));
        for (const event of events) {
            expect(memory.readRecord("c", "k", "events", event.id)!.data).toEqual({
                ...event,
                createdRevision: 1,
                ...(event.id === "event-500" ? { rerecord: true } : {}),
            });
        }
    }
});

it.each(["rewrite", "confirmed delete"] as const)(
    "handles an event citing two changed messages once during a %s",
    (change) => {
        const messages: Message[] = ["first", "second", "other"].map((chatId) => ({
            chatId,
            role: "user",
            data: chatId,
        }));
        const store = messageStore(messages);
        const [shared, unrelated] = memoryRecords(["shared", "unrelated"]).events;
        shared.sources = messages.slice(0, 2).map((message, index) => ({
            messageId: message.chatId!,
            index,
            hash: messageSourceHash(message),
        }));
        unrelated.sources = [{ messageId: "other", index: 2, hash: messageSourceHash(messages[2]) }];
        writeMemory(store, "c", "k", { events: [shared, unrelated] });
        const read = vi.spyOn(store.memory, "readRecord");
        reconcileMessageChanges(store, {
            epoch: store.epoch(),
            characterId: "c",
            id: "k",
            rewritten: change === "rewrite" ? ["first", "second"] : [],
            retracted: change === "confirmed delete" ? ["first", "second"] : [],
        });
        expect(read.mock.calls.filter(([, , kind]) => kind === "events")).toHaveLength(1);
        expect(read.mock.calls.filter(([, , kind]) => kind === "events")).toEqual([["c", "k", "events", "shared"]]);
        read.mockRestore();
        expect(store.memory.readRecord("c", "k", "events", "shared")!.data).toEqual({
            ...shared,
            createdRevision: 1,
            ...(change === "rewrite" ? { rerecord: true } : { status: "retracted" }),
        });
        expect(store.memory.readRecord("c", "k", "events", "unrelated")!.data).toEqual({
            ...unrelated,
            createdRevision: 1,
        });
    },
);

it("reconciles changed, missing, inserted and moved sources on a copy and recovers restored evidence", () => {
    const messages: Message[] = [
        { chatId: "before", role: "user", data: "Earlier" },
        { chatId: "u", role: "user", data: "Open the gate" },
        { chatId: "a", role: "char", data: "The gate opens" },
    ];
    const event: MemoryEvent = {
        ...memoryRecords(["gate"]).events[0],
        createdRevision: 1,
        sources: messages
            .slice(1)
            .map((message, i) => ({ messageId: message.chatId!, index: i + 1, hash: messageSourceHash(message) })),
    };
    const before = structuredClone(event);
    const [prefix, user, reply] = messages;
    const cases = [
        { reason: "changed", messages: [prefix, user, { ...reply, data: "The gate stays shut" }] },
        { reason: "missing", messages: [prefix, user] },
        {
            reason: "inserted",
            messages: [prefix, user, { chatId: "inserted", role: "user" as const, data: "Wait" }, reply],
        },
        { reason: "moved", messages: [prefix, reply, user] },
    ];
    for (const row of cases) {
        const input = structuredClone(row.messages);
        const [read] = reconcileEvents([event], row.messages);
        expect(read, row.reason).toEqual({ ...before, status: "stale", staleReason: row.reason });
        expect([...coveredMessages([read])], row.reason).toEqual([]);
        expect(event).toEqual(before);
        expect(row.messages).toEqual(input);
        expect(reconcileEvents([event], messages)).toEqual([before]);
    }
    for (const harmless of [
        messages.slice(1),
        [{ chatId: "extra", role: "user" as const, data: "Earlier still" }, ...messages],
        [prefix, { ...user, disabled: true }, { ...reply, generationInfo: { model: "new receipt", inputTokens: 5 } }],
    ]) {
        expect(reconcileEvents([event], harmless)).toEqual([before]);
    }
    expect(event).toEqual(before);
});
