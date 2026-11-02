// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { MAX_READ_RESPONSE_BYTES } from "../../../shared/resources.ts";
import { sealHypaV3Data } from "../../../shared/structuredMemory.ts";
import type { MemoryEvent, MemoryPage, MemoryRun, MemoryThread } from "../../../shared/structuredMemory.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { messageSourceHash, type MemoryChanges } from "../data/memoryStore.ts";
import {
    createResourceStore,
    ResourceConflictError,
    ResourceEpochError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { installSnapshot } from "./stagedRestore.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { reconcileEvents, reconcileMessageChanges } from "../prompt/memory/structured/reconcile.ts";

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;
const recordKinds = ["pages", "events", "threads", "runs"] as const;
const tables = ["memory_state", "memory_pages", "memory_events", "memory_threads", "memory_runs"];
const stores: ResourceStore[] = [];
const readers: DatabaseSync[] = [];
const dirs: string[] = [];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
    vi.restoreAllMocks();
    for (const reader of readers.splice(0)) reader.close();
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
});

function fileStore(guard?: ReturnType<typeof createGenerationLock>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-memory-store-"));
    dirs.push(dir);
    const file = path.join(dir, "resources.sqlite");
    const feed = createChangeFeed();
    const events: ChangeFeedEvent[] = [];
    feed.subscribe((event) => events.push(event));
    const store = createResourceStore({ file, kinds, feed, guard });
    stores.push(store);
    const db = new DatabaseSync(file, { readOnly: true });
    readers.push(db);
    return { store, db, file, dir, events };
}

const chat: Chat = {
    name: "K",
    note: "Keep this note",
    localLore: [],
    message: [{ chatId: "m", role: "user", data: "The gate opens." }],
};
const group = (baseRevision: string | null, ops: ChatOp[], characterId = "c", chatId = "k") => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});
function seed(store: ResourceStore, characterId = "c") {
    return store.applyChanges({
        ops: [{ kind: characters, id: characterId, baseRevision: null, data: { chaId: characterId } }],
        chats: [group(null, [{ op: "create", chat }], characterId)],
    });
}

function records(ids: string[], body = "문이 열린다 😀") {
    return {
        pages: ids.map((id): MemoryPage => ({
            id,
            type: "location",
            title: `Gate ${id}`,
            aliases: [],
            contextMode: "auto",
            sections: [{ heading: "Gate", body, provenance: [], sources: [], locked: false, updatedAt: 123 }],
            links: [],
            retrieval: { keywords: ["gate"] },
            history: [],
        })),
        events: ids.map((id): MemoryEvent => ({
            id,
            title: `Opening ${id}`,
            summary: body,
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
            // Input may carry this field, but only the store decides its stored value.
            createdRevision: 999,
        })),
        threads: ids.map((id): MemoryThread => ({ id, title: body, who: [], state: "open" })),
        runs: ids.map((id): MemoryRun => ({
            id,
            window: [],
            model: "writer",
            inputTokens: 10,
            outputTokens: 20,
            durationMs: 30,
            result: "recorded",
            input: body,
        })),
    };
}

const contents = (store: ResourceStore, characterId = "c", chatId = "k") =>
    store.memory.readContents(characterId, chatId)!;
const write = (store: ResourceStore, baseRevision: string, changes: MemoryChanges, characterId = "c", chatId = "k") =>
    store.memory.write(characterId, chatId, { epoch: store.epoch(), baseRevision }, changes);
const emptyContents = (revision: string) => ({ revision, pages: [], events: [], threads: [], runs: [] });
const removal = (ids: string[]) => ({ pages: ids, events: ids, threads: ids, runs: ids });
function chatSeq(db: DatabaseSync, characterId = "c", chatId = "k") {
    return (
        db.prepare("SELECT seq FROM chats WHERE characterId = ? AND id = ?").get(characterId, chatId) as { seq: number }
    ).seq;
}
function token(store: ResourceStore, db: DatabaseSync, revision: number, characterId = "c", chatId = "k") {
    return `${store.epoch()}:${chatSeq(db, characterId, chatId)}:${revision}`;
}
function memoryRows(db: DatabaseSync) {
    return Object.fromEntries(
        tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
}
function expectConflict(action: () => unknown, current: string | null) {
    let caught: unknown;
    try {
        action();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(ResourceConflictError);
    expect((caught as ResourceConflictError).current).toBe(current);
}
function editFile(file: string, sql: string) {
    const db = new DatabaseSync(file);
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
}
const dropMemoryTables = [
    ...tables,
    "memory_rebuilds",
    "memory_staged_pages",
    "memory_staged_events",
    "memory_staged_threads",
    "memory_staged_runs",
]
    .map((table) => `DROP TABLE ${table};`)
    .join("\n");

it("starts at revision zero, ignores empty writes and distinguishes missing chats", () => {
    const { store, db } = fileStore();
    seed(store);
    const zero = token(store, db, 0);
    expect(contents(store)).toEqual(emptyContents(zero));
    const writes = store.writeCount();
    for (const changes of [{}, { pages: [], events: [], threads: [], runs: [], remove: removal([]) }]) {
        expect(write(store, zero, changes)).toBe(zero);
    }
    expect(store.writeCount()).toBe(writes);
    expect(memoryRows(db)).toEqual(Object.fromEntries(tables.map((table) => [table, []])));

    for (const [characterId, chatId] of [
        ["c", "missing"],
        ["missing", "k"],
    ]) {
        expect(store.memory.readContents(characterId, chatId)).toBeNull();
        for (const kind of recordKinds) {
            expect(store.memory.readRecord(characterId, chatId, kind, "z")).toBeNull();
            expect(store.memory.readRecord("c", "k", kind, "z")).toBeNull();
        }
        expectConflict(() => write(store, zero, records(["z"]), characterId, chatId), null);
    }
    const one = write(store, zero, records(["z"]));
    expect(one).toBe(token(store, db, 1));
    const before = memoryRows(db);
    expectConflict(() => write(store, zero, {}), one);
    expect(write(store, one, {})).toBe(one);
    expect(memoryRows(db)).toEqual(before);
    expect(store.writeCount()).toBe(writes + 1);
});

it("commits all kinds with one memory revision and one snapshot write without changing the chat or feed", () => {
    const { store, db, events } = fileStore();
    seed(store);
    const beforeChat = store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats;
    const chatRevision = store.chatRevision("c", "k");
    const writes = store.writeCount();
    events.length = 0;
    const input = records(["z", "a"]);
    const first = write(store, contents(store).revision, input);
    expect(first).toBe(token(store, db, 1));
    for (const kind of recordKinds) {
        for (const record of input[kind]) {
            expect(store.memory.readRecord("c", "k", kind, record.id)).toEqual({
                revision: first,
                data: kind === "events" ? { ...record, createdRevision: 1 } : record,
            });
        }
        expect(db.prepare(`SELECT DISTINCT chatSeq FROM memory_${kind}`).all()).toEqual([{ chatSeq: chatSeq(db) }]);
    }
    expect(store.writeCount()).toBe(writes + 1);
    const second = write(store, first, records(["z", "a"], "Changed"));
    expect(second).toBe(token(store, db, 2));
    expect(db.prepare("SELECT revision FROM memory_state").all()).toEqual([{ revision: 2 }]);
    expect(store.writeCount()).toBe(writes + 2);
    expect(events).toEqual([]);
    expect(store.chatRevision("c", "k")).toBe(chatRevision);
    expect(store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats).toEqual(beforeChat);
});

it("refuses stale revisions without merging any kind or applying removals", () => {
    const { store, db, events } = fileStore();
    seed(store);
    const stale = write(store, contents(store).revision, records(["z", "a"]));
    const current = write(store, stale, { pages: records(["z"], "Winner").pages });
    const before = memoryRows(db);
    const writes = store.writeCount();
    events.length = 0;
    expectConflict(() => write(store, stale, { ...records(["z", "new"], "Loser"), remove: removal(["a"]) }), current);
    expect(memoryRows(db)).toEqual(before);
    expect(contents(store).revision).toBe(current);
    expect(store.writeCount()).toBe(writes);
    expect(events).toEqual([]);
});

it("refuses missing and stale epochs before applying memory writes", () => {
    const { store, db, events } = fileStore();
    seed(store);
    const current = write(store, contents(store).revision, records(["z", "a"]));
    const before = memoryRows(db);
    const writes = store.writeCount();
    events.length = 0;
    for (const epoch of [undefined, "00000000-0000-4000-8000-000000000000"]) {
        expect(() =>
            store.memory.write(
                "c",
                "k",
                { epoch, baseRevision: current },
                {
                    ...records(["z", "new"], "Refused"),
                    remove: removal(["a"]),
                },
            ),
        ).toThrow(ResourceEpochError);
        expect(memoryRows(db)).toEqual(before);
    }
    expect(store.writeCount()).toBe(writes);
    expect(events).toEqual([]);
});

it("rolls back all kinds and removals when a database failure interrupts a write", () => {
    const { store, db, file, events } = fileStore();
    seed(store);
    const current = write(store, contents(store).revision, records(["z", "a"]));
    const before = memoryRows(db);
    const writes = store.writeCount();
    events.length = 0;
    // Fail after removals and earlier kinds have reached SQLite, rather than during validation.
    editFile(
        file,
        `CREATE TRIGGER refuse_thread BEFORE INSERT ON memory_threads
        WHEN NEW.id = 'new' BEGIN SELECT RAISE(ABORT, 'injected memory write failure'); END;`,
    );
    const changes = { ...records(["z", "new"], "Changed"), remove: removal(["a"]) };
    expect(() => write(store, current, changes)).toThrow("injected memory write failure");
    expect(memoryRows(db)).toEqual(before);
    expect(contents(store).revision).toBe(current);
    expect(store.writeCount()).toBe(writes);
    expect(events).toEqual([]);
    editFile(file, "DROP TRIGGER refuse_thread");
    const next = write(store, current, changes);
    expect(next).toBe(token(store, db, 2));
    for (const kind of recordKinds) {
        expect(contents(store)[kind].map((row) => row.id)).toEqual(["z", "new"]);
        expect(store.memory.readRecord("c", "k", kind, "a")).toBeNull();
        expect(store.memory.readRecord("c", "k", kind, "new")?.data).toEqual(
            kind === "events" ? { ...changes.events[1], createdRevision: 2 } : changes[kind][1],
        );
    }
    expect(store.writeCount()).toBe(writes + 1);
});

it("keeps insertion order on update, owns event creation revisions and removes records by id", () => {
    const { store, db } = fileStore();
    seed(store);
    const first = write(store, contents(store).revision, records(["z", "a"]));
    const positions = recordKinds.map((kind) => db.prepare(`SELECT id, seq FROM memory_${kind} ORDER BY seq`).all());
    const changed = records(["z", "new"], "Updated");
    changed.events[0].createdRevision = -10;
    const second = write(store, first, changed);
    expect(second).toBe(token(store, db, 2));
    for (const [index, kind] of recordKinds.entries()) {
        expect(contents(store)[kind].map((row) => row.id)).toEqual(["z", "a", "new"]);
        expect(db.prepare(`SELECT id, seq FROM memory_${kind} WHERE id != 'new' ORDER BY seq`).all()).toEqual(
            positions[index],
        );
        expect(store.memory.readRecord("c", "k", kind, "z")).toEqual({
            revision: second,
            data: kind === "events" ? { ...changed.events[0], createdRevision: 1 } : changed[kind][0],
        });
    }
    expect(store.memory.readRecord("c", "k", "events", "new")?.data.createdRevision).toBe(2);
    expect(db.prepare("SELECT id, createdRevision FROM memory_events ORDER BY seq").all()).toEqual([
        { id: "z", createdRevision: 1 },
        { id: "a", createdRevision: 1 },
        { id: "new", createdRevision: 2 },
    ]);
    const third = write(store, second, { remove: removal(["z"]) });
    expect(third).toBe(token(store, db, 3));
    for (const kind of recordKinds) {
        expect(contents(store)[kind].map((row) => row.id)).toEqual(["a", "new"]);
        expect(store.memory.readRecord("c", "k", kind, "z")).toBeNull();
        expect(store.memory.readRecord("c", "k", kind, "a")?.revision).toBe(third);
    }
});

it.each(["written twice", "removed twice", "written and removed"] as const)(
    "refuses an id %s in any kind without changing the batch",
    (duplicate) => {
        const { store, db } = fileStore();
        seed(store);
        const current = write(store, contents(store).revision, records(["z"]));
        const before = memoryRows(db);
        const writes = store.writeCount();
        for (const kind of recordKinds) {
            const input = records(["z"], "Refused");
            const changes: MemoryChanges =
                duplicate === "written twice"
                    ? { ...input, [kind]: [input[kind][0], input[kind][0]] }
                    : duplicate === "removed twice"
                      ? { ...records(["new"]), remove: { [kind]: ["z", "z"] } }
                      : { ...input, remove: { [kind]: ["z"] } };
            expect(() => write(store, current, changes)).toThrow(ResourceValidationError);
            expect(memoryRows(db)).toEqual(before);
            expect(contents(store).revision).toBe(current);
        }
        expect(store.writeCount()).toBe(writes);
    },
);

it.each([
    { label: "an empty record id", kind: "pages", field: "id", value: "" },
    { label: "an invalid removal id", kind: "pages", field: "remove", value: ".." },
    { label: "a non-string title", kind: "pages", field: "title", value: 42 },
    { label: "an unknown page type", kind: "pages", field: "type", value: "unknown" },
    { label: "an unknown event status", kind: "events", field: "status", value: "unknown" },
    { label: "an unknown thread state", kind: "threads", field: "state", value: "unknown" },
    { label: "an unknown run result", kind: "runs", field: "result", value: "unknown" },
] as const)("refuses $label after valid entries without changing memory", ({ kind, field, value }) => {
    const { store, db, events } = fileStore();
    seed(store);
    const current = write(store, contents(store).revision, records(["z", "a"]));
    const before = memoryRows(db);
    const writes = store.writeCount();
    events.length = 0;
    const changes = { ...records(["z", "new"], "Refused"), remove: removal(["a"]) };
    if (field === "remove") changes.remove[kind].push(value);
    // Deliberately malformed runtime input follows a valid update in the same record list.
    else Object.assign(changes[kind][1], { [field]: value });

    expect(() => write(store, current, changes)).toThrow(ResourceValidationError);
    expect(memoryRows(db)).toEqual(before);
    expect(contents(store).revision).toBe(current);
    expect(store.writeCount()).toBe(writes);
    expect(events).toEqual([]);
});

it.each(["pages", "events"] as const)(
    "accepts exactly the stored byte budget for %s and refuses one byte more",
    (kind) => {
        const { store, db } = fileStore();
        seed(store);
        const make = (body: string) => records(["z"], body)[kind][0];
        const stored = (record: ReturnType<typeof make>) =>
            kind === "events" ? { ...record, createdRevision: 1 } : record;
        const prefix = "한😀";
        const padding = MAX_READ_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(stored(make(prefix))), "utf8");
        const body = prefix + "x".repeat(padding);
        const exact = make(body);
        expect(Buffer.byteLength(JSON.stringify(stored(exact)), "utf8")).toBe(MAX_READ_RESPONSE_BYTES);
        const current = write(store, contents(store).revision, { [kind]: [exact] });
        expect(contents(store)[kind][0].bytes).toBe(MAX_READ_RESPONSE_BYTES);
        const text = (db.prepare(`SELECT data FROM memory_${kind}`).get() as { data: string }).data;
        expect(Buffer.byteLength(text, "utf8")).toBe(MAX_READ_RESPONSE_BYTES);
        expect(JSON.parse(text)).toEqual(stored(exact));
        const over = make(body + "x");
        expect(Buffer.byteLength(JSON.stringify(stored(over)), "utf8")).toBe(MAX_READ_RESPONSE_BYTES + 1);
        const writes = store.writeCount();
        expect(() => write(store, current, { [kind]: [over] })).toThrow(ResourceValidationError);
        expect(contents(store).revision).toBe(current);
        expect(store.memory.readRecord("c", "k", kind, "z")).toEqual({ revision: current, data: stored(exact) });
        expect(store.writeCount()).toBe(writes);
    },
);

it("selects contents without body columns and reads bodies by id with the current memory token", () => {
    const { store, db } = fileStore();
    seed(store);
    const input = records(["z"], "한😀".repeat(4096));
    input.pages[0].type = "concept";
    input.events[0].status = "retracted";
    input.threads[0].state = "paused";
    input.runs[0].result = "failed";
    const first = write(store, contents(store).revision, input);
    const expectedData = { ...input, events: [{ ...input.events[0], createdRevision: 1 }] };
    const bytes = Object.fromEntries(
        recordKinds.map((kind) => {
            const text = (db.prepare(`SELECT data FROM memory_${kind}`).get() as { data: string }).data;
            expect(JSON.parse(text)).toEqual(expectedData[kind][0]);
            return [kind, Buffer.byteLength(text, "utf8")];
        }),
    );
    // Observe the actual SQLite result, so selecting data and stripping it in JS still fails.
    const selected: Record<string, unknown>[] = [];
    const all = StatementSync.prototype.all;
    const spy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (this: StatementSync, ...args) {
        const rows = Reflect.apply(all, this, args);
        selected.push(...rows);
        return rows;
    });
    const listing = contents(store);
    spy.mockRestore();
    expect(listing).toEqual({
        revision: first,
        pages: [{ id: "z", title: "Gate z", type: "concept", bytes: bytes.pages }],
        events: [{ id: "z", title: "Opening z", status: "retracted", bytes: bytes.events }],
        threads: [{ id: "z", title: input.threads[0].title, state: "paused", bytes: bytes.threads }],
        runs: [{ id: "z", result: "failed", bytes: bytes.runs }],
    });
    const listedRows = selected.filter((row) => "bytes" in row);
    expect(listedRows).toHaveLength(4);
    for (const row of listedRows) expect(row).not.toHaveProperty("data");
    const current = write(store, first, { threads: records(["another"]).threads });
    for (const kind of recordKinds) {
        expect(store.memory.readRecord("c", "k", kind, "z")).toEqual({
            revision: current,
            data: expectedData[kind][0],
        });
        expect(store.memory.readRecord("c", "k", kind, "missing")).toBeNull();
    }
});

it.each(["chat", "character"] as const)(
    "cascades a deleted %s and refuses tokens from its old chat incarnation",
    (owner) => {
        const { store, db } = fileStore();
        const seeded = seed(store);
        store.applyChanges({ chats: [group(null, [{ op: "create", chat }], "c", "sibling")] });
        seed(store, "other");
        const zero = contents(store).revision;
        const oldSeq = chatSeq(db);
        const siblingSeq = chatSeq(db, "c", "sibling");
        const old = write(store, zero, records(["z"]));
        write(store, contents(store, "c", "sibling").revision, records(["z"]), "c", "sibling");
        const other = write(store, contents(store, "other").revision, records(["z"]), "other");
        if (owner === "chat") store.applyChanges({ chats: [group(store.chatRevision("c", "k"), [{ op: "delete" }])] });
        else store.delete(characters, "c", seeded.results[0].revision!);
        expect(store.memory.readContents("c", "k")).toBeNull();
        for (const table of tables) {
            expect(db.prepare(`SELECT * FROM ${table} WHERE chatSeq = ?`).all(oldSeq)).toEqual([]);
            expect(db.prepare(`SELECT * FROM ${table} WHERE chatSeq = ?`).all(siblingSeq)).toHaveLength(
                owner === "chat" ? 1 : 0,
            );
        }
        for (const kind of recordKinds) {
            expect(store.memory.readRecord("c", "k", kind, "z")).toBeNull();
            expect(store.memory.readRecord("other", "k", kind, "z")?.revision).toBe(other);
        }
        if (owner === "chat") store.applyChanges({ chats: [group(null, [{ op: "create", chat }])] });
        else seed(store);
        expect(chatSeq(db)).not.toBe(oldSeq);
        const freshZero = token(store, db, 0);
        expect(contents(store)).toEqual(emptyContents(freshZero));
        expectConflict(() => write(store, zero, records(["old"])), freshZero);
        const freshOne = write(store, freshZero, records(["new"]));
        // Both incarnations now have revision 1; the incarnation alone must refuse the old writer.
        expectConflict(() => write(store, old, records(["old"])), freshOne);
        for (const kind of recordKinds) expect(contents(store)[kind].map((row) => row.id)).toEqual(["new"]);
    },
);

it("adds memory tables when opening a store file from before structured memory", () => {
    const { store, db, file } = fileStore();
    seed(store);
    const before = store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats;
    const epoch = store.epoch();
    store.close();
    editFile(file, dropMemoryTables);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'").all()).toEqual(
        [],
    );
    const reopened = createResourceStore({ file, kinds });
    stores.push(reopened);
    expect(reopened.epoch()).toBe(epoch);
    expect(reopened.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats).toEqual(before);
    expect(contents(reopened)).toEqual(emptyContents(token(reopened, db, 0)));
    expect(write(reopened, contents(reopened).revision, records(["z"]))).toBe(token(reopened, db, 1));
    for (const kind of recordKinds) expect(contents(reopened)[kind].map((row) => row.id)).toEqual(["z"]);
});

it.each(["with memory tables", "without memory tables"])(
    "restores the memory a snapshot %s holds and refuses old tokens",
    async (layout) => {
        const kept = layout === "with memory tables";
        const { store, db, dir } = fileStore();
        seed(store);
        const old = write(store, contents(store).revision, records(["z"]));
        const saved = contents(store);
        const oldEpoch = store.epoch();
        const beforeChat = store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data;
        const snapshot = path.join(dir, "snapshot.sqlite");
        await store.backupTo(snapshot);
        if (!kept) editFile(snapshot, dropMemoryTables);
        write(store, old, records(["live-only"]));
        store.applyChanges({
            chats: [group(store.chatRevision("c", "k"), [{ op: "meta", set: { note: "After snapshot" } }])],
        });
        const restoredEpoch = await installSnapshot(store, snapshot, kinds);
        expect(restoredEpoch).not.toBe(oldEpoch);
        expect(store.epoch()).toBe(restoredEpoch);
        expect(store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data).toEqual(beforeChat);
        expect(contents(store)).toEqual(
            kept ? { ...saved, revision: token(store, db, 1) } : emptyContents(token(store, db, 0)),
        );
        if (!kept) expect(memoryRows(db)).toEqual(Object.fromEntries(tables.map((table) => [table, []])));
        expect(() => store.memory.write("c", "k", { epoch: oldEpoch, baseRevision: old }, records(["old"]))).toThrow(
            ResourceEpochError,
        );
        expectConflict(() => write(store, old, records(["old"])), contents(store).revision);
        expect(write(store, contents(store).revision, records(["fresh"]))).toBe(token(store, db, kept ? 2 : 1));
    },
);

it("hashes only role and data with SHA-256 and preserves the boundary between fields", () => {
    const message: Message = {
        role: "user",
        data: "The gate opens.",
        generationInfo: { model: "first", outputTokens: 1 },
    };
    const hash = messageSourceHash(message);
    expect(hash).toBe(
        createHash("sha256")
            .update(JSON.stringify([message.role, message.data]), "utf8")
            .digest("hex"),
    );
    expect(messageSourceHash({ ...message, generationInfo: { model: "second", outputTokens: 99 } } as Message)).toBe(
        hash,
    );
    expect(messageSourceHash({ ...message, role: "char" })).not.toBe(hash);
    expect(messageSourceHash({ ...message, data: "The gate closes." })).not.toBe(hash);
    // The two raw concatenations are identical; the helper must retain the field boundary.
    const left = { role: "user", data: "text" } as const;
    const right = { role: "use", data: "rtext" } as unknown as Pick<Message, "role" | "data">;
    expect(left.role + left.data).toBe(right.role + right.data);
    expect(messageSourceHash(left)).not.toBe(messageSourceHash(right));
});

it("validates the final scene set atomically while allowing rewrites and replacement", () => {
    const { store, db, events } = fileStore();
    seed(store);
    const scene = (id: string): MemoryPage => ({ ...records([id]).pages[0], type: "scene", participants: [] });
    for (const alreadyStored of [false, true]) {
        if (alreadyStored) write(store, contents(store).revision, { pages: [scene("scene")] });
        const revision = contents(store).revision;
        const before = memoryRows(db);
        const writes = store.writeCount();
        events.length = 0;
        const changes = {
            ...records(["unrelated"]),
            pages: alreadyStored ? [scene("second")] : [scene("scene"), scene("second")],
        };
        expect(() => write(store, revision, changes)).toThrow(ResourceValidationError);
        expect(memoryRows(db)).toEqual(before);
        expect(contents(store).revision).toBe(revision);
        expect(store.writeCount()).toBe(writes);
        expect(events).toEqual([]);
    }
    const rewritten = { ...scene("scene"), title: "Current scene" };
    write(store, contents(store).revision, { pages: [rewritten] });
    expect(store.memory.readRecord("c", "k", "pages", "scene")!.data).toEqual(rewritten);
    write(store, contents(store).revision, { remove: { pages: ["scene"] }, pages: [scene("replacement")] });
    expect(contents(store).pages.map(({ id }) => id)).toEqual(["replacement"]);
    seed(store, "other");
    write(store, contents(store, "other").revision, { pages: [scene("other-scene")] }, "other");
    expect(contents(store, "other").pages.map(({ id }) => id)).toEqual(["other-scene"]);
});

it("refuses losing or retyping an existing scene without partially writing the batch", () => {
    const { store, db, events } = fileStore();
    seed(store);
    // A chat may acquire ordinary memory before the writer creates its scene.
    write(store, contents(store).revision, records(["ordinary"]));
    const scene: MemoryPage = {
        ...records(["scene"]).pages[0],
        type: "scene",
        contextMode: "always",
        participants: [],
    };
    const revision = write(store, contents(store).revision, { pages: [scene] });
    const before = memoryRows(db);
    const writes = store.writeCount();
    events.length = 0;
    for (const changes of [
        { ...records(["unrelated"]), remove: { pages: ["scene"] } },
        { ...records(["unrelated"]), pages: [{ ...scene, type: "location" as const }] },
    ]) {
        expect(() => write(store, revision, changes)).toThrow(ResourceValidationError);
        expect(memoryRows(db)).toEqual(before);
        expect(contents(store).revision).toBe(revision);
        expect(store.writeCount()).toBe(writes);
        expect(events).toEqual([]);
    }
    write(store, revision, { remove: { pages: ["scene"] }, pages: [{ ...scene, id: "replacement" }] });
    expect(contents(store).pages.map(({ id, type }) => ({ id, type }))).toEqual([
        { id: "ordinary", type: "location" },
        { id: "replacement", type: "scene" },
    ]);
});

it("delivers message changes only after commit, isolates failed reactions, and leaves a job's unasked deletion missing", () => {
    const guard = createGenerationLock();
    const { store, db } = fileStore(guard);
    seed(store);
    const original = {
        ...records(["cited"]).events[0],
        sources: [{ messageId: "m", index: 0, hash: messageSourceHash(chat.message[0]) }],
    };
    write(store, contents(store).revision, { events: [original] });
    const saved = store.memory.readRecord("c", "k", "events", "cited")!.data;
    const notices: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    store.onMessagesChanged(() => {
        throw new Error("Memory reaction failed");
    });
    store.onMessagesChanged((notice) => {
        // A separate connection sees the committed message when the notice arrives.
        expect((db.prepare("SELECT data FROM messages WHERE id = 'm'").get() as { data: string }).data).toContain(
            "Edited",
        );
        notices.push(notice);
        reconcileMessageChanges(store, notice);
    });
    const edit = { chats: [group(store.chatRevision("c", "k"), [{ op: "setText", id: "m", text: "Edited" }])] };
    expect(() =>
        store.applyChanges(edit, {
            inTransaction: {
                after: () => {
                    throw new Error("Rollback");
                },
            },
        }),
    ).toThrow("Rollback");
    expect(notices).toEqual([]);
    expect(store.memory.readRecord("c", "k", "events", "cited")!.data).toEqual(saved);
    expect(() => store.applyChanges(edit)).not.toThrow();
    expect(notices).toEqual([{ epoch: store.epoch(), characterId: "c", id: "k", rewritten: ["m"], retracted: [] }]);
    expect(error).toHaveBeenCalled();
    expect(store.memory.readRecord("c", "k", "events", "cited")!.data).toEqual({ ...saved, rerecord: true });
    guard.addToken("job");
    const before = contents(store);
    store.applyChanges(
        { chats: [group(store.chatRevision("c", "k"), [{ op: "remove", ids: ["m"] }])] },
        { jobToken: "job" },
    );
    expect((store.readChatSource("c", "k").data as Chat).message).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(contents(store)).toEqual(before);
    expect(reconcileEvents([store.memory.readRecord("c", "k", "events", "cited")!.data], [])[0]).toMatchObject({
        status: "stale",
        staleReason: "missing",
    });
});

it("drops sealed fields from creates, replacements and stale metadata writes while saving their other changes", () => {
    const { store, db } = fileStore();
    seed(store);
    const ui = kinds.get("ui")!;
    store.put(ui, "main", { memoryAlgorithmType: "structuredMemory" }, store.get(ui, "main")!.revision);
    write(store, contents(store).revision, { events: records(["event"]).events });
    const hypaV3Data = sealHypaV3Data({ summaries: [{ text: "Projected", chatMemos: ["m"], isImportant: false }] });
    const stale = store.chatRevision("c", "k");
    store.applyChanges({ chats: [group(stale, [{ op: "meta", set: { name: "Newer title" } }])] });
    store.applyChanges({ chats: [group(stale, [{ op: "meta", set: { hypaV3Data, note: "Stale tab note" } }])] });
    expect(store.readChatSource("c", "k").data).toMatchObject({ name: "Newer title", note: "Stale tab note" });
    expect(store.readChatSource("c", "k").data).not.toHaveProperty("hypaV3Data");
    store.applyChanges({
        chats: [
            group(store.chatRevision("c", "k"), [
                { op: "replace", chat: { ...chat, hypaV3Data, note: "Replacement" } },
            ]),
        ],
    });
    expect(store.readChatSource("c", "k").data).toMatchObject({ note: "Replacement", message: chat.message });
    expect(store.readChatSource("c", "k").data).not.toHaveProperty("hypaV3Data");
    store.applyChanges({
        chats: [group(null, [{ op: "create", chat: { ...chat, hypaV3Data, note: "Copy" } }], "c", "copy")],
    });
    expect(store.readChatSource("c", "copy").data).toMatchObject({ note: "Copy", message: chat.message });
    expect(store.readChatSource("c", "copy").data).not.toHaveProperty("hypaV3Data");
    const checkpoint = store.checkpoints.save("c", "k", "Clean capture", "manual")!;
    const fields = JSON.parse(
        (db.prepare("SELECT fields FROM chatCheckpoints WHERE id = ?").get(checkpoint.id) as { fields: string }).fields,
    );
    expect(fields).toHaveProperty("note");
    expect(fields).not.toHaveProperty("hypaV3Data");
    const real = { summaries: [{ text: "Real HypaV3", chatMemos: [], isImportant: true }] };
    store.applyChanges({ chats: [group(null, [{ op: "create", chat: { ...chat, hypaV3Data: real } }], "c", "real")] });
    expect(store.readChatSource("c", "real").data!.hypaV3Data).toEqual(real);
});

it("does not read memory tables for resource reads under another algorithm", () => {
    const { store } = fileStore();
    seed(store);
    write(store, contents(store).revision, { events: records(["event"]).events });
    const ui = kinds.get("ui")!;
    store.put(ui, "main", { memoryAlgorithmType: "hypaV3" }, store.get(ui, "main")!.revision);
    const accessed: string[] = [];
    for (const method of ["get", "all", "iterate"] as const) {
        const original = StatementSync.prototype[method];
        vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
            this: StatementSync,
            ...args: unknown[]
        ) {
            if (/\bmemory_/.test(this.sourceSQL)) accessed.push(this.sourceSQL);
            return Reflect.apply(original, this, args);
        });
    }
    const options = { memoryProjection: true, chats: [{ characterId: "c", id: "k" }], chatCollections: ["c"] };
    expect(store.readRefs([], options).chats[0].data).not.toHaveProperty("hypaV3Data");
    expect(store.readKinds([characters], { chats: true, memoryProjection: true }).chats![0].data).not.toHaveProperty(
        "hypaV3Data",
    );
    expect(store.readRefsWithinBudget([], options, 100_000).chats[0].data).not.toHaveProperty("hypaV3Data");
    expect(accessed).toEqual([]);
});

it("charges event bytes to budgeted chat and collection reads", () => {
    const { store } = fileStore();
    seed(store);
    seed(store, "d");
    const ui = kinds.get("ui")!;
    store.put(ui, "main", { memoryAlgorithmType: "structuredMemory" }, store.get(ui, "main")!.revision);
    const large = records(["large"], "Short summary").events[0];
    large.keyLines = [{ speaker: "Character", text: "x".repeat(16_000) }];
    write(store, contents(store, "d").revision, { events: [large] }, "d");
    for (const options of [
        {
            chats: [
                { characterId: "c", id: "k" },
                { characterId: "d", id: "k" },
            ],
        },
        { chatCollections: ["c", "d"] },
    ]) {
        const stored = store.readRefsWithinBudget([], options, 8_000);
        expect(stored).not.toHaveProperty("unanswered");
        const projected = store.readRefsWithinBudget([], { ...options, memoryProjection: true }, 8_000);
        if (options.chats) {
            expect(projected.chats.map(({ characterId }) => characterId)).toEqual(["c"]);
            expect(projected.unanswered?.chats).toEqual([{ characterId: "d", id: "k" }]);
        } else {
            expect(projected.chatCollections.map(({ characterId }) => characterId)).toEqual(["c"]);
            expect(projected.unanswered?.chatCollections).toEqual(["d"]);
        }
    }
});

it("checks ordered projection revisions without messages and skips memory tables under another algorithm", () => {
    const { store, db } = fileStore();
    seed(store);
    const ui = kinds.get("ui")!;
    store.put(ui, "main", { memoryAlgorithmType: "structuredMemory" }, store.get(ui, "main")!.revision);
    store.applyChanges({
        chats: [
            group(null, [{ op: "create", chat }], "c", "empty"),
            group(
                null,
                [
                    {
                        op: "create",
                        chat: {
                            ...chat,
                            hypaV3Data: { summaries: [{ text: "Real", chatMemos: [], isImportant: false }] },
                        },
                    },
                ],
                "c",
                "owned",
            ),
        ],
    });
    const retracted = { ...records(["event"]).events[0], status: "retracted" as const };
    write(store, contents(store).revision, { events: [retracted] });
    write(store, contents(store, "c", "owned").revision, { events: [retracted] }, "c", "owned");
    const expected = token(store, db, 1);
    const refs = ["owned", "k", "empty", "missing", "k"].map((chatId) => ({ characterId: "c", chatId }));
    const accessed: string[] = [];
    for (const method of ["get", "all", "iterate"] as const) {
        const original = StatementSync.prototype[method];
        vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
            this: StatementSync,
            ...args: unknown[]
        ) {
            accessed.push(this.sourceSQL);
            return Reflect.apply(original, this, args);
        });
    }
    expect(store.memory.readProjectionRevisions(refs)).toEqual([null, expected, null, null, expected]);
    expect(accessed.filter((sql) => /\bmessages\b/.test(sql))).toEqual([]);
    store.put(ui, "main", { memoryAlgorithmType: "hypaV3" }, store.get(ui, "main")!.revision);
    accessed.length = 0;
    expect(store.memory.readProjectionRevisions(refs)).toEqual(refs.map(() => null));
    expect(accessed.filter((sql) => /\b(?:memory_\w+|messages)\b/.test(sql))).toEqual([]);
});

it("persists a one-way decline at revision one and repeats without a write", () => {
    const { store, db } = fileStore();
    seed(store);
    const beforeChat = store.readChatSource("c", "k");
    const writes = store.writeCount();
    expect(db.prepare("SELECT * FROM memory_state").all()).toEqual([]);
    const declined = write(store, contents(store).revision, { adoptionDeclined: true });
    expect(declined).toBe(token(store, db, 1));
    expect(contents(store)).toEqual({ ...emptyContents(declined), adoptionDeclined: true });
    expect(db.prepare("SELECT revision, adoptionDeclined FROM memory_state").all()).toEqual([
        { revision: 1, adoptionDeclined: 1 },
    ]);
    expect(store.writeCount()).toBe(writes + 1);
    expect(write(store, declined, { adoptionDeclined: true })).toBe(declined);
    expect(store.writeCount()).toBe(writes + 1);
    const recorded = write(store, declined, records(["after-decline"]));
    expect(recorded).toBe(token(store, db, 2));
    expect(contents(store).adoptionDeclined).toBe(true);
    write(store, recorded, { remove: removal(["after-decline"]) });
    expect(contents(store)).toEqual({ ...emptyContents(token(store, db, 3)), adoptionDeclined: true });
    expect(store.readChatSource("c", "k")).toEqual(beforeChat);
});

it("opens the two-column memory state in place without changing existing reads or writes and opens again safely", () => {
    const { store, db, file } = fileStore();
    seed(store);
    seed(store, "empty");
    write(store, contents(store).revision, records(["kept"]));
    const beforeChat = store.readChatSource("c", "k");
    const beforeMemory = contents(store);
    const beforeRecord = store.memory.readRecord("c", "k", "events", "kept");
    const epoch = store.epoch();
    store.close();
    editFile(
        file,
        `
        ALTER TABLE memory_state RENAME TO previous_memory_state;
        CREATE TABLE memory_state (
            chatSeq INTEGER PRIMARY KEY REFERENCES chats (seq) ON DELETE CASCADE,
            revision INTEGER NOT NULL
        ) STRICT;
        INSERT INTO memory_state SELECT chatSeq, revision FROM previous_memory_state;
        DROP TABLE previous_memory_state;
    `,
    );
    expect(
        db
            .prepare("PRAGMA table_info(memory_state)")
            .all()
            .map((column) => column.name),
    ).toEqual(["chatSeq", "revision"]);
    for (let start = 0; start < 2; start++) {
        const reopened = createResourceStore({ file, kinds });
        stores.push(reopened);
        expect(reopened.epoch()).toBe(epoch);
        expect(reopened.readChatSource("c", "k")).toEqual(beforeChat);
        expect(contents(reopened)).toEqual(beforeMemory);
        expect(reopened.memory.readRecord("c", "k", "events", "kept")).toEqual(beforeRecord);
        expect(contents(reopened, "empty").adoptionDeclined).toBeUndefined();
        expect(db.prepare("SELECT revision, adoptionDeclined FROM memory_state").all()).toEqual([
            { revision: 1, adoptionDeclined: 0 },
        ]);
        if (start === 1) {
            expect(write(reopened, beforeMemory.revision, records(["new"]))).toBe(token(reopened, db, 2));
            expect(reopened.memory.readRecord("c", "k", "events", "kept")?.data).toEqual(beforeRecord?.data);
            expect(contents(reopened).adoptionDeclined).toBeUndefined();
            expect(write(reopened, contents(reopened, "empty").revision, records(["first"]), "empty")).toBe(
                token(reopened, db, 1, "empty"),
            );
        }
        reopened.close();
    }
});

const stagedTables = ["memory_rebuilds", ...recordKinds.map((kind) => `memory_staged_${kind}`)];
function beginRebuild(store: ResourceStore) {
    store.memory.rebuild.begin("c", "k", { epoch: store.epoch(), mode: "rebuild", plan: [["m"], ["next"]] }, {});
    const staged = store.memory.rebuild.staged;
    staged.write(
        "c",
        "k",
        { epoch: store.epoch(), baseRevision: staged.readContents("c", "k")!.revision, advance: true },
        records(["staged"]),
    );
}

it("persists staged progress across reopen and swaps all live records once, rolling back a failed swap", () => {
    const { store, db, file, events } = fileStore();
    seed(store);
    const revision = write(store, contents(store).revision, { ...records(["live"]), adoptionDeclined: true });
    const live = memoryRows(db);
    const chatBefore = store.readChatSource("c", "k");
    events.length = 0;
    beginRebuild(store);
    store.memory.rebuild.noteStop("c", "k", { epoch: store.epoch(), reason: "cancelled", error: "Stopped by person" });
    const stagedBefore = store.memory.rebuild.staged.readContents("c", "k");
    expect(memoryRows(db)).toEqual(live);
    expect(events).toEqual([]);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = createResourceStore({ file, kinds });
    stores.push(reopened);
    expect(reopened.memory.rebuild.status("c", "k")).toEqual({
        mode: "rebuild",
        done: 1,
        total: 2,
        resumable: true,
        reason: "cancelled",
        error: "Stopped by person",
    });
    expect(reopened.memory.rebuild.plan("c", "k")).toEqual([["m"], ["next"]]);
    expect(reopened.memory.rebuild.staged.readContents("c", "k")).toEqual(stagedBefore);
    const { runs: _runs, ...replacement } = records(["staged"]);
    const changes = { ...replacement, remove: { pages: ["live"], events: ["live"], threads: ["live"] } };
    editFile(
        file,
        "CREATE TRIGGER refuse_swap BEFORE INSERT ON memory_threads BEGIN SELECT RAISE(ABORT, 'swap blocked'); END;",
    );
    expect(() =>
        reopened.memory.rebuild.swap("c", "k", { epoch: reopened.epoch(), baseRevision: revision }, changes),
    ).toThrow("swap blocked");
    expect(memoryRows(db)).toEqual(live);
    expect(reopened.memory.rebuild.staged.readContents("c", "k")).toEqual(stagedBefore);
    editFile(file, "DROP TRIGGER refuse_swap;");
    const swapped = reopened.memory.rebuild.swap(
        "c",
        "k",
        { epoch: reopened.epoch(), baseRevision: revision },
        changes,
    );
    expect(swapped).toBe(token(reopened, db, 2));
    expect(contents(reopened).adoptionDeclined).toBe(true);
    for (const kind of ["pages", "events", "threads"] as const)
        expect(contents(reopened)[kind].map(({ id }) => id)).toEqual(["staged"]);
    expect(contents(reopened).runs.map(({ id }) => id)).toEqual(["live", "staged"]);
    expect(reopened.memory.readRecord("c", "k", "events", "staged")?.data.createdRevision).toBe(2);
    expect(reopened.readChatSource("c", "k")).toEqual(chatBefore);
    expect(reopened.memory.rebuild.status("c", "k")).toBeNull();
    for (const table of stagedTables) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(() =>
        reopened.memory.rebuild.swap("c", "k", { epoch: reopened.epoch(), baseRevision: swapped }, changes),
    ).toThrow(ResourceConflictError);
    expect(contents(reopened).revision).toBe(swapped);
});

it("keeps a replaced run nonresumable after reopen and removes staging on abandon or chat deletion", () => {
    const { store, file, db } = fileStore();
    seed(store);
    write(store, contents(store).revision, records(["live"]));
    beginRebuild(store);
    store.applyChanges({ chats: [group(store.chatRevision("c", "k"), [{ op: "replace", chat }])] });
    const live = memoryRows(db);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = createResourceStore({ file, kinds });
    stores.push(reopened);
    expect(reopened.memory.rebuild.status("c", "k")).toMatchObject({ resumable: false, done: 1, total: 2 });
    expect(reopened.memory.rebuild.abandon("c", "k", reopened.epoch())).toBe(true);
    expect(memoryRows(db)).toEqual(live);
    for (const table of stagedTables) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    beginRebuild(reopened);
    reopened.applyChanges({ chats: [group(reopened.chatRevision("c", "k"), [{ op: "delete" }])] });
    expect(reopened.memory.rebuild.status("c", "k")).toBeNull();
    for (const table of stagedTables) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
});

it("restores only live memory from mid-run snapshots and snapshots predating the staging tables", async () => {
    const { store, dir, db } = fileStore();
    seed(store);
    write(store, contents(store).revision, records(["live"]));
    beginRebuild(store);
    const saved = contents(store);
    const snapshot = path.join(dir, "mid-run.sqlite");
    await store.backupTo(snapshot);
    for (const legacy of [false, true]) {
        if (legacy) editFile(snapshot, stagedTables.map((table) => `DROP TABLE ${table};`).join("\n"));
        await installSnapshot(store, snapshot, kinds);
        expect(contents(store)).toEqual({ ...saved, revision: token(store, db, 1) });
        expect(store.memory.readRecord("c", "k", "events", "live")?.data.summary).toBe("문이 열린다 😀");
        expect(store.memory.rebuild.status("c", "k")).toBeNull();
        for (const table of stagedTables) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
});
