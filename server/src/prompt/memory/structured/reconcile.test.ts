// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import {
    coveredMessages,
    type MemoryEvent,
    type MemoryPage,
    type MemoryPageHistoryEntry,
    type MemoryThread,
} from "../../../../../shared/structuredMemory.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../data/kinds.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { createResourceStore } from "../../../data/resourceStore.ts";
import { memoryRecords, writeMemory } from "../../../tests/memoryFixtures.ts";
import { reconcileEvents, reconcileMessageChanges, retireRerecorded, withRetractedEvidence } from "./reconcile.ts";

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

it("transfers re-recorded thread ownership and ended moves so retracting the replacement reconciles them", () => {
    const store = messageStore([]);
    const [opening, old, replacement] = memoryRecords(["opening", "old", "replacement"]).events;
    old.rerecord = true;
    old.openThreads = {
        add: [
            { title: "Opened by old", who: [] },
            { title: "done", who: [] },
        ],
        close: ["closed", "overridden"],
        transitions: [
            { threadId: "done", to: "done" },
            { threadId: "cancelled", to: "cancelled" },
        ],
    };
    replacement.openThreads.transitions = [{ threadId: "overridden", to: "progress" }];
    const threads: MemoryThread[] = [
        { id: "opened", title: "Opened by old", who: [], state: "open", openedBy: "old" },
        ...(["closed", "done", "cancelled", "overridden"] as const).map((id): MemoryThread => ({
            id,
            title: id,
            who: [],
            state: id === "cancelled" ? "cancelled" : "done",
            openedBy: id === "done" ? "old" : "opening",
            closedBy: "old",
        })),
    ];
    writeMemory(store, "c", "k", { events: [opening, old], threads });
    const written: MemoryThread[] = [
        { ...threads[2], title: "Updated completion" },
        { id: "overridden", title: "overridden", who: [], state: "progress", openedBy: "opening" },
    ];

    const changes = retireRerecorded(
        store,
        { chaId: "c", chatId: "k" },
        { rerecords: "old" },
        {
            events: [replacement],
            threads: written,
        },
    );
    expect(changes).not.toBeNull();
    writeMemory(store, "c", "k", changes!);

    const saved = store.memory.readRecord("c", "k", "events", "replacement")!.data;
    expect(store.memory.readRecord("c", "k", "events", "old")!.data.status).toBe("retracted");
    expect(saved.openThreads).toEqual({
        add: [],
        close: ["closed"],
        transitions: [
            { threadId: "overridden", to: "progress" },
            { threadId: "done", to: "done" },
            { threadId: "cancelled", to: "cancelled" },
        ],
    });
    const committed = [
        { ...threads[0], openedBy: "replacement" },
        { ...threads[1], closedBy: "replacement" },
        { ...threads[2], title: "Updated completion", openedBy: "replacement", closedBy: "replacement" },
        { ...threads[3], closedBy: "replacement" },
        written[1],
    ];
    for (const thread of committed) {
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
    expect(store.memory.readRecord("c", "k", "threads", "opened")).toBeNull();
    expect(store.memory.readRecord("c", "k", "threads", "done")).toBeNull();
    for (const { closedBy, ...thread } of [committed[1], committed[3], committed[4]]) {
        expect(store.memory.readRecord("c", "k", "threads", thread.id)!.data).toEqual({ ...thread, state: "open" });
    }
});

it("leaves a retired event's non-ended transition out of its replacement and preserves that thread on retraction", () => {
    const store = messageStore([]);
    const [opening, old, replacement] = memoryRecords(["opening", "old", "replacement"]).events;
    old.rerecord = true;
    old.openThreads.transitions = [{ threadId: "promise", to: "progress" }];
    const thread: MemoryThread = {
        id: "promise",
        title: "Return",
        who: [],
        state: "progress",
        openedBy: "opening",
    };
    writeMemory(store, "c", "k", { events: [opening, old], threads: [thread] });

    const changes = retireRerecorded(
        store,
        { chaId: "c", chatId: "k" },
        { rerecords: "old" },
        {
            events: [replacement],
        },
    );
    expect(changes).not.toBeNull();
    writeMemory(store, "c", "k", changes!);
    const saved = store.memory.readRecord("c", "k", "events", "replacement")!.data;
    expect(saved.openThreads).toEqual({ add: [], close: [], transitions: [] });

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
    expect(store.memory.readRecord("c", "k", "threads", "promise")!.data).toEqual(thread);
});

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
        // Only event-500's source is older than its message, so only it reads the rewrite as changed.
        sources: [
            {
                messageId: messages[index].chatId!,
                index,
                hash: messageSourceHash(index === 500 ? { ...messages[index], data: "Before" } : messages[index]),
            },
        ],
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
    const messageRead = vi.spyOn(store, "readMessagesById");
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
    expect(messageRead.mock.calls).toEqual([["c", "k", ["message-500"]]]);
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
            hash: messageSourceHash({ ...message, data: `${message.data} before` }),
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

it("marks a rewritten source only when the message no longer hashes as its stored version read it", () => {
    const prose = "He opened the door.\n\nThe hall was dark.";
    const block = '<div class="am-illustration-projection"><img src="{{raw::한민재.__am__.chat.e6470a96}}"></div>';
    const marked = `He opened the door.\n\n${block}\n\nThe hall was dark.`;
    const original: Message = { chatId: "m", role: "char", data: prose };
    const sha = (fields: unknown[]) => createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
    const hashes = {
        v1: sha(["char", prose]),
        v2: `v2:${sha(["char", prose, null])}`,
        v3: messageSourceHash(original),
    };
    const cases = [
        { label: "v3, markup only", hash: hashes.v3, data: marked, marks: false },
        {
            label: "v3, kept, markup only",
            hash: messageSourceHash({ ...original, data: "Older" }),
            data: marked,
            marks: false,
            keep: true,
        },
        { label: "v2, markup only", hash: hashes.v2, data: marked, marks: true },
        { label: "v1, markup only", hash: hashes.v1, data: marked, marks: true },
        { label: "v3, prose edit", hash: hashes.v3, data: marked.replace("dark", "lit"), marks: true },
        { label: "v3, message gone", hash: hashes.v3, data: null, marks: true },
    ];
    for (const { label, hash, data, marks, keep } of cases) {
        const store = messageStore([data === null ? { ...original, chatId: "other" } : { ...original, data }]);
        const [cited] = memoryRecords(["cited"]).events;
        cited.sources = [{ messageId: "m", index: 0, hash }];
        if (keep) {
            cited.keptState = JSON.stringify([["m", hashes.v3, 0]]);
        }
        writeMemory(store, "c", "k", { events: [cited] });
        reconcileMessageChanges(store, {
            epoch: store.epoch(),
            characterId: "c",
            id: "k",
            rewritten: ["m"],
            retracted: [],
        });
        expect(store.memory.readRecord("c", "k", "events", "cited")!.data, label).toEqual({
            ...cited,
            createdRevision: 1,
            ...(marks ? { rerecord: true } : {}),
        });
    }
});

function tailFixture() {
    const store = messageStore([]);
    const events = memoryRecords(["standing", "tail-one", "tail-two", "already-retracted"]).events.map(
        (event, index) => ({
            ...event,
            sources: [{ messageId: event.id, index, hash: "recorded-hash" }],
        }),
    );
    events[3].status = "retracted";
    const page = memoryRecords(["place"]).pages[0];
    page.sections[0] = { ...page.sections[0], provenance: ["tail-two"], sources: events[2].sources };
    return { store, events, page };
}
const writerEntry = (
    id: string,
    heading: string | null,
    eventId = "tail-one",
    before: MemoryPageHistoryEntry["before"] = null,
    kind: MemoryPageHistoryEntry["kind"] = "change",
): MemoryPageHistoryEntry => ({ id, heading, eventId, before, kind, highlighted: false, at: 10 });
function deleteRecorded(store: ReturnType<typeof messageStore>, retracted = ["tail-one", "tail-two"]) {
    reconcileMessageChanges(store, { epoch: store.epoch(), characterId: "c", id: "k", rewritten: [], retracted });
}

it("rewinds only uninterrupted tail writer history, restoring evidence and live trust on live and staged pages", () => {
    const { store, events, page } = tailFixture();
    const before = { body: "Before the turn", provenance: ["standing"], sources: events[0].sources };
    const live = {
        ...page.sections[0],
        locked: true,
        pinned: true,
        suppressed: true,
        userCorrected: true,
        disputed: true,
        unsupported: true,
    };
    page.sections = [
        live,
        { ...live, heading: "New" },
        { ...live, heading: "Person edit" },
        { ...live, heading: "Person revert" },
        { ...live, heading: "Other writer" },
    ];
    const retained = writerEntry("prior", "Gate", "standing");
    const unrelated = writerEntry("unrelated", "Unrelated", "standing");
    const blocked = [
        writerEntry("edit-cut", "Person edit", "tail-one", before),
        { ...writerEntry("person-edit", "Person edit", "tail-two"), kind: "edit" as const },
        writerEntry("revert-cut", "Person revert", "tail-one", before),
        { ...writerEntry("person-revert", "Person revert", "tail-two"), kind: "revert" as const },
        writerEntry("other-cut", "Other writer", "tail-one", before),
        writerEntry("other-writer", "Other writer", "standing"),
    ];
    page.history = [
        retained,
        writerEntry("cut", "Gate", "tail-one", before),
        unrelated,
        writerEntry("later", "Gate", "tail-two", before),
        writerEntry("compacted", "Gate", "tail-two", before, "compact"),
        writerEntry("added", "New"),
        writerEntry("deleted", "Deleted", "tail-one", before, "delete"),
        ...blocked,
    ];
    writeMemory(store, "c", "k", { events, pages: [page] });
    store.memory.rebuild.begin(
        "c",
        "k",
        { epoch: store.epoch(), mode: "rebuild", plan: [["tail-one", "tail-two"]] },
        {},
    );
    const staged = store.memory.rebuild.staged;
    staged.write(
        "c",
        "k",
        { epoch: store.epoch(), baseRevision: staged.readContents("c", "k")!.revision },
        { events, pages: [page] },
    );
    deleteRecorded(store);
    const { disputed, unsupported, ...trust } = live;
    const expected: MemoryPage = {
        ...page,
        sections: [
            { ...trust, ...before, updatedAt: 10 },
            ...page.sections.slice(2),
            { heading: "Deleted", ...before, locked: false, updatedAt: 10 },
        ],
        history: [retained, unrelated, ...blocked],
    };
    for (const memory of [store.memory, staged]) {
        expect(memory.readRecord("c", "k", "pages", page.id)!.data).toEqual(expected);
        expect(memory.readContents("c", "k")!.events.map(({ status }) => status)).toEqual([
            "active",
            "retracted",
            "retracted",
            "retracted",
        ]);
    }
});

it("uses full contents order to flag middle deletions and rewinds only newly retracted tail events", () => {
    const { store, events, page } = tailFixture();
    // Source indices disagree with contents order; even an uncited stale event is a standing barrier.
    events[0].status = "stale";
    events[0].sources[0].index = 99;
    events[2].sources[0].index = 0;
    const ordered = [events[1], events[0], events[2], events[3]];
    page.sections = ["Middle", "Tail", "Previously retracted"].map((heading, index) => ({
        ...page.sections[0],
        heading,
        provenance: [events[index + 1].id],
        sources: events[index + 1].sources,
    }));
    page.history = [
        writerEntry("middle", "Middle"),
        writerEntry("tail", "Tail", "tail-two"),
        writerEntry("old", "Previously retracted", "already-retracted"),
    ];
    writeMemory(store, "c", "k", { events: ordered, pages: [page] });
    deleteRecorded(store, ["tail-one", "tail-two", "already-retracted"]);
    expect(store.memory.readRecord("c", "k", "pages", page.id)!.data).toEqual({
        ...page,
        sections: [
            { ...page.sections[0], unsupported: true },
            { ...page.sections[2], unsupported: true },
        ],
        history: [page.history[0], page.history[2]],
    });
});

it("trashes tail-created pages intact, rewinds the scene and clears attendance, but leaves reshaped and trashed text", () => {
    const { store, events, page } = tailFixture();
    page.history = [writerEntry("created", null, "tail-one", null, "create"), writerEntry("added", "Gate")];
    const created = {
        ...page,
        sections: [{ ...page.sections[0], userCorrected: true }],
        history: [...page.history, { ...writerEntry("person", "Gate"), kind: "edit" as const }],
    };
    const scene: MemoryPage = { ...page, id: "scene", type: "scene", contextMode: "always", participants: ["place"] };
    const reshaped: MemoryPage = { ...page, id: "reshaped", reshaped: true };
    const trash = { ...page, id: "trash", trashedAt: 5 };
    writeMemory(store, "c", "k", { events, pages: [created, scene, reshaped, trash] });
    deleteRecorded(store);
    const read = (id: string) => store.memory.readRecord("c", "k", "pages", id)!.data;
    expect(read("place")).toEqual({ ...created, trashedAt: Date.now() });
    expect(read("scene")).toEqual({ ...scene, sections: [], history: [scene.history[0]], participants: [] });
    expect(read("reshaped")).toEqual({ ...reshaped, sections: [{ ...reshaped.sections[0], unsupported: true }] });
    expect(read("trash")).toEqual(trash);
    expect(store.memory.readContents("c", "k")!.trash.map(({ id }) => id)).toEqual(["place", "trash"]);
});

it("keeps page text and history when a tail event is retracted by a repair or retired by a re-record", () => {
    for (const action of ["repair", "retire"] as const) {
        const { store, events, page } = tailFixture();
        page.history = [writerEntry("writer", "Gate", "tail-two")];
        events[2].rerecord = action === "retire";
        writeMemory(store, "c", "k", { events, pages: [page] });
        const tail = store.memory.readRecord("c", "k", "events", "tail-two")!.data;
        const changes =
            action === "repair"
                ? withRetractedEvidence(
                      store,
                      { chaId: "c", chatId: "k" },
                      { events: [{ ...tail, status: "retracted" }] },
                  )
                : retireRerecorded(
                      store,
                      { chaId: "c", chatId: "k" },
                      { rerecords: "tail-two" },
                      { events: memoryRecords(["replacement"]).events },
                  )!;
        writeMemory(store, "c", "k", changes);
        expect(store.memory.readRecord("c", "k", "pages", page.id)!.data, action).toEqual({
            ...page,
            sections: [{ ...page.sections[0], unsupported: true }],
        });
    }
});
