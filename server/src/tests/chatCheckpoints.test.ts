// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_CHAT_FIELDS } from "../../../shared/chatCheckpoints.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { COUNT_USER_TURNS_SQL } from "../data/chatStore.ts";
import { createCheckpointService } from "../data/checkpointService.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    createResourceStore,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { memoryKinds, memoryRecords, writeMemory } from "./memoryFixtures.ts";

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;
const stores: ResourceStore[] = [];
const readers: DatabaseSync[] = [];
const dirs: string[] = [];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
    for (const reader of readers.splice(0)) reader.close();
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
});

function fileStore() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-chat-checkpoints-"));
    dirs.push(dir);
    const file = path.join(dir, "resources.sqlite");
    const feed = createChangeFeed();
    const events: ChangeFeedEvent[] = [];
    feed.subscribe((event) => events.push(event));
    const store = createResourceStore({ file, kinds, feed });
    stores.push(store);
    const db = new DatabaseSync(file, { readOnly: true });
    readers.push(db);
    return { store, db, file, events };
}

const m = (id: string, data = id, role: Message["role"] = "user"): Message => ({ role, data, chatId: id });
const group = (baseRevision: string | null, ops: ChatOp[], characterId = "c", chatId = "k") => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});
function seed(
    store: ResourceStore,
    chat: Chat = { name: "K", note: "note", localLore: [], message: [] },
    characterId = "c",
) {
    return store.applyChanges({
        ops: [{ kind: characters, id: characterId, baseRevision: null, data: { chaId: characterId } }],
        chats: [group(null, [{ op: "create", chat }], characterId)],
    });
}
function edit(store: ResourceStore, ops: ChatOp[]) {
    return store.applyChanges({ chats: [group(store.chatRevision("c", "k"), ops)] });
}
const save = (store: ResourceStore, name = "Checkpoint", kind: "manual" | "auto" | "safety" = "manual") => {
    const saved = store.checkpoints.save("c", "k", name, kind);
    expect(saved).not.toBeNull();
    return saved!;
};
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Choose boundaries independently of the page cutter; all test ranges below are explicit. */
function messageIds(anchor: boolean, count: number) {
    const ids: string[] = [];
    for (let i = 0; ids.length < count; i++) {
        const id = `message-${i}`;
        if ((createHash("sha256").update(id, "utf8").digest()[0] % 16 === 0) === anchor) ids.push(id);
    }
    return ids;
}
function rowTexts(db: DatabaseSync, characterId = "c") {
    return (
        db
            .prepare(
                "SELECT m.data FROM messages m JOIN chats c ON c.seq = m.chatSeq " +
                    "WHERE c.characterId = ? AND c.id = 'k' ORDER BY m.position",
            )
            .all(characterId) as { data: string }[]
    ).map((row) => row.data);
}
function checkpoint(db: DatabaseSync, id: string) {
    const row = db.prepare("SELECT seq, pages, fields FROM chatCheckpoints WHERE id = ?").get(id) as {
        seq: number;
        pages: string;
        fields: string;
    };
    return {
        seq: row.seq,
        pages: JSON.parse(row.pages) as string[],
        fields: JSON.parse(row.fields) as Record<string, string>,
    };
}
function pages(db: DatabaseSync): Record<string, string> {
    return Object.fromEntries(
        (
            db.prepare("SELECT hash, text FROM checkpointPages ORDER BY hash").all() as { hash: string; text: string }[]
        ).map((row) => [row.hash, row.text]),
    );
}
function loadCheckpoint(store: ResourceStore, id: string) {
    return createCheckpointService({ store, busy: () => false, memoryTasks: null }).load({
        epoch: store.epoch(),
        body: { characterId: "c", chatId: "k", id, chatBaseRevision: store.chatRevision("c", "k") },
    });
}
function memoryTexts(db: DatabaseSync) {
    return Object.fromEntries(
        memoryKinds.map((kind) => [
            kind,
            (db.prepare(`SELECT data FROM memory_${kind} ORDER BY seq`).all() as { data: string }[]).map(
                ({ data }) => data,
            ),
        ]),
    );
}
function expectMessagePages(db: DatabaseSync, id: string, groups: string[][]) {
    const texts = groups.map((rows) => "[" + rows.join(",") + "]");
    const hashes = texts.map(sha256);
    expect(checkpoint(db, id).pages).toEqual(hashes);
    const stored = pages(db);
    for (let i = 0; i < hashes.length; i++) {
        expect(Buffer.from(stored[hashes[i]], "utf8")).toEqual(Buffer.from(texts[i], "utf8"));
    }
    return hashes;
}

// Explicit story-state expectations, independent of CHECKPOINT_CHAT_FIELDS.
const captured = {
    note: "The gate is open.",
    localLore: [
        {
            key: "gate",
            secondkey: "",
            insertorder: 1,
            comment: "Gate",
            content: "Open",
            mode: "normal",
            alwaysActive: true,
            selective: false,
        },
    ],
    loreOverrides: [
        {
            entry: {
                id: "owner-gate",
                key: "gate",
                secondkey: "",
                insertorder: 5,
                comment: "Owner gate",
                content: "Closed in this chat",
                mode: "normal",
                alwaysActive: false,
                selective: false,
            },
            off: false,
        },
    ],
    scriptstate: { chapter: 3, ready: true, weather: "rain" },
    supaMemoryData: "An older summary",
    hypaV2Data: {
        lastMainChunkID: 1,
        mainChunks: [{ id: 1, text: "V2 summary", chatMemos: ["past"], lastChatMemo: "past" }],
        chunks: [{ mainChunkID: 1, text: "V2 chunk" }],
    },
    hypaV3Data: { summaries: [{ text: "V3 summary", chatMemos: ["past"], isImportant: true }] },
    lastMemory: "past",
    fmIndex: 2,
    bookmarks: ["past"],
    bookmarkNames: { past: "The gate" },
    toolCalls: {
        call: {
            call: { id: "call", name: "weather", arg: { city: "Seoul" } },
            response: [{ type: "text", text: "rain" }],
        },
    },
    suggestMessages: ["Enter", "Wait"],
    sdData: "gate.png",
} satisfies Partial<Chat>;
const kept = {
    id: "k",
    name: "Original name",
    pinned: true,
    folderId: "folder-old",
    lastDate: 123,
    bindedPersona: "persona-old",
    promptPresetId: "prompt-old",
    modelPresetId: "model-old",
    bindingReview: true,
    togglePresetId: "toggles-old",
    translatorPresetId: "translator-old",
    autoTranslate: true,
    translateBotOnly: true,
    bilingualDisplay: true,
    bilingualEmphasis: "original",
    bilingualSentences: 2,
    memoryTrimAck: 3,
    loreBudgetWarnOff: true,
    structuredMemoryLanguage: "language-old",
    structuredMemoryHighlight: "none",
    modules: ["module-old"],
} satisfies Partial<Chat>;
const storyVariables = { bonus: "5", toggle: "story", Toggle_upper: "story too" };
function fullChat(): Required<Chat> {
    return {
        ...captured,
        ...kept,
        GLGlobalVariables: { ...storyVariables, toggle_voice: "old", toggle_: "old empty suffix" },
        message: [
            {
                name: "User 한글",
                data: 'A comma, a quote " and a newline\n😀',
                role: "user",
                chatId: "past",
                time: 17,
                disabled: false,
            },
            {
                chatId: "reply",
                role: "char",
                data: "Reply",
                generationInfo: { model: "model", outputTokens: 5 },
                isComment: true,
            },
        ],
        isStreaming: true,
        activeStreamingDisplayOptimizationMode: "balanced",
    };
}

describe("chat checkpoints", () => {
    it("loads every memory kind in storage order with exact row text and restores pre-load memory from safety", () => {
        const { store, db, file } = fileStore();
        seed(store, { name: "K", note: "note", localLore: [], message: [m("saved")] });
        const records = memoryRecords(["z", "a"], 'Saved 한글 😀 "quoted"\nline');
        writeMemory(store, "c", "k", records);
        // Legal stored JSON whose whitespace and escapes would be lost by reserialization.
        const expected = Object.fromEntries(
            memoryKinds.map((kind) => [
                kind,
                records[kind].map((record) =>
                    ` \n${JSON.stringify(kind === "events" ? { ...record, createdRevision: 1 } : record, null, 2)}\t`.replaceAll(
                        "한",
                        "\\uD55C",
                    ),
                ),
            ]),
        );
        const writer = new DatabaseSync(file);
        try {
            for (const kind of memoryKinds) {
                const update = writer.prepare(`UPDATE memory_${kind} SET data = ? WHERE id = ?`);
                records[kind].forEach((record, index) => update.run(expected[kind][index], record.id));
            }
        } finally {
            writer.close();
        }
        const saved = save(store);
        writeMemory(store, "c", "k", {
            ...memoryRecords(["z", "later"], "Before loading"),
            remove: { pages: ["a"], events: ["a"], threads: ["a"], runs: ["a"] },
        });
        edit(store, [{ op: "setText", id: "saved", text: "Before loading" }]);
        const before = memoryTexts(db);
        const oldRevision = store.memory.readContents("c", "k")!.revision;
        const loaded = loadCheckpoint(store, saved.id);
        expect(loaded.status).toBe(200);
        if (loaded.status !== 200) throw new Error("load refused");
        expect(memoryTexts(db)).toEqual(expected);
        const contents = store.memory.readContents("c", "k")!;
        expect(contents.revision).not.toBe(oldRevision);
        for (const kind of memoryKinds) {
            expect(contents[kind].map(({ id }) => id)).toEqual(["z", "a"]);
            expect(store.memory.readRecord("c", "k", kind, "later")).toBeNull();
            for (const record of records[kind]) {
                expect(store.memory.readRecord("c", "k", kind, record.id)).toEqual({
                    revision: contents.revision,
                    data: kind === "events" ? { ...record, createdRevision: 1 } : record,
                });
            }
        }
        expect(() =>
            store.memory.write("c", "k", { epoch: store.epoch(), baseRevision: oldRevision }, memoryRecords(["stale"])),
        ).toThrow(ResourceConflictError);
        expect(memoryTexts(db)).toEqual(expected);
        expect(loadCheckpoint(store, loaded.body.safety.id).status).toBe(200);
        expect(memoryTexts(db)).toEqual(before);
        expect(store.memory.readContents("c", "k")!.revision).not.toBe(contents.revision);
    });

    it("loading an empty memory checkpoint clears all kinds and advances even an empty chat's memory revision", () => {
        const { store, db } = fileStore();
        seed(store);
        const empty = save(store);
        for (const changes of [{}, memoryRecords(["later"])]) {
            writeMemory(store, "c", "k", changes);
            const oldRevision = store.memory.readContents("c", "k")!.revision;
            expect(loadCheckpoint(store, empty.id).status).toBe(200);
            expect(memoryTexts(db)).toEqual({ pages: [], events: [], threads: [], runs: [] });
            expect(store.memory.readContents("c", "k")).toEqual({
                revision: expect.any(String),
                pages: [],
                trash: [],
                events: [],
                threads: [],
                runs: [],
            });
            expect(store.memory.readContents("c", "k")!.revision).not.toBe(oldRevision);
            expect(() =>
                store.memory.write(
                    "c",
                    "k",
                    { epoch: store.epoch(), baseRevision: oldRevision },
                    memoryRecords(["stale"]),
                ),
            ).toThrow(ResourceConflictError);
        }
    });

    it.each(["delete", "prune"] as const)(
        "%s frees only unshared memory chunks and manifests after incremental saves",
        (action) => {
            const { store, db } = fileStore();
            const [anchor] = messageIds(true, 1);
            const [tail, appended] = messageIds(false, 2);
            seed(store, { name: "K", note: "note", localLore: [], message: [m(anchor), m(tail)] });
            const records = memoryRecords([anchor]);
            records.pages.push(...memoryRecords([tail]).pages);
            writeMemory(store, "c", "k", records);
            const first = save(store, "First", "auto");
            const firstPages = pages(db);
            const manifestHash = checkpoint(db, first.id).fields.structuredMemoryRecords;
            const manifest = JSON.parse(firstPages[manifestHash]) as Record<(typeof memoryKinds)[number], string[]>;
            expect(manifest).toEqual({
                pages: [expect.any(String), expect.any(String)],
                events: [expect.any(String)],
                threads: [expect.any(String)],
                runs: [expect.any(String)],
            });
            for (const kind of memoryKinds) {
                expect(manifest[kind].map((hash) => JSON.parse(firstPages[hash]))).toEqual(
                    records[kind].map((record) => [
                        JSON.stringify(kind === "events" ? { ...record, createdRevision: 1 } : record),
                    ]),
                );
            }
            const messages = rowTexts(db);
            const messageHashes = expectMessagePages(db, first.id, [[messages[0]], [messages[1]]]);
            const unchanged = save(store, "Unchanged");
            expect(pages(db)).toEqual(firstPages);
            expect(checkpoint(db, unchanged.id).fields.structuredMemoryRecords).toBe(manifestHash);

            const added = memoryRecords([appended]).pages[0];
            writeMemory(store, "c", "k", { pages: [added] });
            const next = save(store, "Appended");
            const allPages = pages(db);
            const nextManifestHash = checkpoint(db, next.id).fields.structuredMemoryRecords;
            const nextManifest = JSON.parse(allPages[nextManifestHash]) as typeof manifest;
            expect(nextManifest).toEqual({
                ...manifest,
                pages: [manifest.pages[0], expect.any(String)],
            });
            expect(JSON.parse(allPages[nextManifest.pages[1]])).toEqual([
                JSON.stringify(records.pages[1]),
                JSON.stringify(added),
            ]);
            expect(Object.keys(allPages).sort()).toEqual(
                [...Object.keys(firstPages), nextManifest.pages[1], nextManifestHash].sort(),
            );
            for (const [hash, text] of Object.entries(firstPages)) expect(allPages[hash]).toBe(text);
            expect(expectMessagePages(db, next.id, [[messages[0]], [messages[1]]])).toEqual(messageHashes);

            store.checkpoints.delete("c", "k", unchanged.id, unchanged.revision);
            expect(pages(db)).toEqual(allPages);
            const removed =
                action === "delete"
                    ? store.checkpoints.delete("c", "k", first.id, first.revision)
                    : store.checkpoints.prune("c", "k", "auto", 0);
            expect(removed).toEqual({ deleted: action === "delete" ? true : 1, pagesRemoved: 2 });
            expect(pages(db)).toEqual(
                Object.fromEntries(
                    Object.entries(allPages).filter(([hash]) => hash !== manifest.pages[1] && hash !== manifestHash),
                ),
            );
            expect(store.checkpoints.list("c", "k")).toEqual([next]);
            expect(loadCheckpoint(store, next.id).status).toBe(200);
            expect(store.memory.readContents("c", "k")!.pages.map(({ id }) => id)).toEqual([anchor, tail, appended]);
        },
    );

    it("saves counts, ordered previews and page hashes while parsing at most two message rows", () => {
        const { store, db } = fileStore();
        const [anchor] = messageIds(true, 1);
        const [tail, insertedUser, insertedReply] = messageIds(false, 3);
        seed(store, {
            name: "K",
            note: "note",
            localLore: captured.localLore,
            scriptstate: { chapter: 3, ready: true },
            hypaV3Data: captured.hypaV3Data,
            message: [],
        });
        const capture = (
            messageCount: number,
            userTurns: number,
            messages: { role: Message["role"]; text: string }[],
            groups: string[][],
        ) => {
            const texts = new Set(rowTexts(db));
            const { meta } = db.prepare("SELECT meta FROM chats WHERE characterId = 'c' AND id = 'k'").get() as {
                meta: string;
            };
            const parse = vi.spyOn(JSON, "parse");
            let saved;
            try {
                saved = save(store);
                expect(parse.mock.calls.filter(([text]) => texts.has(text)).length).toBeLessThanOrEqual(2);
                expect(parse.mock.calls.filter(([text]) => text === meta)).toHaveLength(1);
            } finally {
                parse.mockRestore();
            }
            const preview = { messages, summaries: 1, loreEntries: 1, variables: 2 };
            expect(saved).toMatchObject({ messageCount, userTurns, preview });
            expect(store.checkpoints.list("c", "k")![0]).toEqual(saved);
            expectMessagePages(db, saved.id, groups);
        };
        capture(0, 0, [], []);

        edit(store, [{ op: "append", anchor: { end: true }, messages: [m(anchor, "Older reply", "char")] }]);
        capture(1, 0, [{ role: "char", text: "Older reply" }], [rowTexts(db)]);

        edit(store, [
            { op: "append", anchor: { end: true }, messages: [m(tail, "Latest question")] },
            {
                op: "append",
                anchor: { start: true },
                messages: [m(insertedUser, "Inserted question"), m(insertedReply, "Inserted reply", "char")],
            },
        ]);
        const rows = rowTexts(db);
        capture(
            4,
            2,
            [
                { role: "char", text: "Older reply" },
                { role: "user", text: "Latest question" },
            ],
            [rows.slice(0, 3), rows.slice(3)],
        );
    });

    it.each(["prune", "delete"] as const)(
        "%s removes only its freed message and field pages and leaves unrelated orphans for reopening",
        (action) => {
            const { store, db, file } = fileStore();
            const [anchor] = messageIds(true, 1);
            const [privateId] = messageIds(false, 1);
            const shared = m(anchor, "Shared reply", "char");
            seed(store, { name: "K", note: "Private note", localLore: [], message: [shared, m(privateId)] });
            const target = save(store, "Target", "auto");
            const rows = rowTexts(db);
            const [sharedMessage, privateMessage] = expectMessagePages(db, target.id, [[rows[0]], [rows[1]]]);
            const privateField = sha256(JSON.stringify("Private note"));
            expect(checkpoint(db, target.id).fields).toMatchObject({ note: privateField, localLore: sha256("[]") });

            seed(store, { name: "Other", note: "Surviving note", localLore: [], message: [shared] }, "other");
            const survivor = store.checkpoints.save("other", "k", "Survivor", "manual")!;
            expect(checkpoint(db, survivor.id)).toMatchObject({
                pages: [sharedMessage],
                fields: { localLore: sha256("[]") },
            });

            seed(store, { name: "Orphan", note: "Orphan note", localLore: [], message: [] }, "orphan");
            store.checkpoints.save("orphan", "k", "Orphan", "manual");
            store.applyChanges({
                chats: [group(store.chatRevision("orphan", "k"), [{ op: "delete" }], "orphan")],
            });
            const orphanHash = sha256(JSON.stringify("Orphan note"));
            expect(pages(db)[orphanHash]).toBe(JSON.stringify("Orphan note"));
            expect(db.prepare("SELECT hash FROM checkpointPageRefs WHERE hash = ?").all(orphanHash)).toEqual([]);
            const before = pages(db);

            const result =
                action === "prune"
                    ? store.checkpoints.prune("c", "k", "auto", 0)
                    : store.checkpoints.delete("c", "k", target.id, target.revision);
            expect(result).toEqual({ deleted: action === "prune" ? 1 : true, pagesRemoved: 2 });
            expect(store.checkpoints.list("c", "k")).toEqual([]);
            expect(store.checkpoints.list("other", "k")).toEqual([survivor]);
            const remaining = Object.fromEntries(
                Object.entries(before).filter(([hash]) => hash !== privateMessage && hash !== privateField),
            );
            expect(pages(db)).toEqual(remaining);

            store.close();
            const reopened = createResourceStore({ file, kinds });
            stores.push(reopened);
            expect(reopened.checkpoints.list("other", "k")).toEqual([survivor]);
            expect(pages(db)).toEqual(
                Object.fromEntries(Object.entries(remaining).filter(([hash]) => hash !== orphanHash)),
            );
        },
    );

    it("creates a missing role index on open and counts user turns through message changes", () => {
        const { store, db, file } = fileStore();
        seed(store, {
            name: "K",
            note: "note",
            localLore: [],
            message: [m("u1"), m("reply", "Reply", "char"), m("reply-extra", "Extra reply", "char")],
        });
        store.close();
        const writer = new DatabaseSync(file);
        try {
            writer.exec("DROP INDEX IF EXISTS messages_role");
        } finally {
            writer.close();
        }
        const index = () =>
            db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'messages_role'").get();
        expect(index()).toBeUndefined();
        const reopened = createResourceStore({ file, kinds });
        stores.push(reopened);
        expect(index()).toEqual({
            sql: expect.stringMatching(/ON messages\s*\(chatSeq,\s*json_extract\(data,\s*'\$\.role'\)\)/),
        });
        const { seq } = db.prepare("SELECT seq FROM chats WHERE characterId = 'c' AND id = 'k'").get() as {
            seq: number;
        };
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${COUNT_USER_TURNS_SQL}`).all(seq) as { detail: string }[];
        expect(plan.map(({ detail }) => detail).join("\n")).toContain("messages_role");
        expect(reopened.countUserTurns("c", "k")).toBe(1);
        edit(reopened, [
            { op: "append", anchor: { end: true }, messages: [m("u2"), m("reply2", "Another reply", "char")] },
        ]);
        expect(reopened.countUserTurns("c", "k")).toBe(2);
        edit(reopened, [{ op: "setText", id: "u2", text: "Edited question" }]);
        expect(reopened.countUserTurns("c", "k")).toBe(2);
        edit(reopened, [{ op: "remove", ids: ["u1", "reply2"] }]);
        expect(reopened.countUserTurns("c", "k")).toBe(1);
        expect(reopened.countUserTurns("c", "missing")).toBeNull();
    });

    it("loads saved lore overrides and removes current overrides when the checkpoint had none", () => {
        const { store } = fileStore();
        seed(store);
        const absent = save(store, "Without overrides");
        edit(store, [{ op: "meta", set: { loreOverrides: captured.loreOverrides } }]);
        const saved = save(store, "With overrides");
        edit(store, [{ op: "meta", set: { loreOverrides: [] } }]);
        const service = createCheckpointService({ store, busy: () => false, memoryTasks: null });
        const load = (id: string) =>
            service.load({
                epoch: store.epoch(),
                body: { characterId: "c", chatId: "k", id, chatBaseRevision: store.chatRevision("c", "k") },
            });
        const read = () => store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data;
        expect(load(saved.id).status).toBe(200);
        expect(read()).toHaveProperty("loreOverrides", captured.loreOverrides);
        expect(load(absent.id).status).toBe(200);
        expect(read()).not.toHaveProperty("loreOverrides");
    });

    it("classifies every chat metadata field and captures exactly story state and stored message bytes", () => {
        const { store, db, events } = fileStore();
        const fixture = fullChat();
        const metadataKeys = Object.keys(fixture).filter(
            (key) => !["message", "isStreaming", "activeStreamingDisplayOptimizationMode"].includes(key),
        );
        expect(Object.keys(CHECKPOINT_CHAT_FIELDS).sort()).toEqual(metadataKeys.sort());
        expect(CHECKPOINT_CHAT_FIELDS).toEqual({
            ...Object.fromEntries(Object.keys(captured).map((key) => [key, "capture"])),
            ...Object.fromEntries(Object.keys(kept).map((key) => [key, "keep"])),
            GLGlobalVariables: "split",
        });
        seed(store, fixture);
        const rows = rowTexts(db);
        expect(rows.map((row) => JSON.parse(row))).toEqual(fixture.message);
        const before = store.writeCount();
        events.length = 0;
        const saved = save(store);
        expect(store.writeCount()).toBeGreaterThan(before);
        expect(events).toEqual([]);
        const record = checkpoint(db, saved.id);
        const content = pages(db);
        const expectedFields = { ...captured, GLGlobalVariables: storyVariables };
        const { structuredMemoryRecords: memoryManifest, ...capturedFields } = record.fields;
        expect(capturedFields).toEqual(
            Object.fromEntries(
                Object.entries(expectedFields).map(([key, value]) => [key, sha256(JSON.stringify(value))]),
            ),
        );
        expect(JSON.parse(content[memoryManifest])).toEqual({ pages: [], events: [], threads: [], runs: [] });
        for (const [key, value] of Object.entries(expectedFields)) {
            expect(content[record.fields[key]]).toBe(JSON.stringify(value));
        }
        // The page boundaries vary with the ids; removing only page brackets must recover the rows verbatim.
        expect(record.pages.map((hash) => content[hash].slice(1, -1)).join(",")).toBe(rows.join(","));
        for (const [hash, text] of Object.entries(content)) expect(hash).toBe(sha256(text));
        const refs = db
            .prepare("SELECT hash FROM checkpointPageRefs WHERE checkpointSeq = ? ORDER BY hash")
            .all(record.seq) as { hash: string }[];
        expect(refs.map((row) => row.hash)).toEqual(
            [...new Set([...record.pages, ...Object.values(record.fields)])].sort(),
        );
        expect(saved).toMatchObject({ messageCount: 2, userTurns: 1 });
    });

    it("reuses every unchanged page and adds only the appended tail page", () => {
        const { store, db } = fileStore();
        const [anchor] = messageIds(true, 1);
        const [first, tail, appended] = messageIds(false, 3);
        seed(store, { name: "K", note: "note", localLore: [], message: [m(first), m(anchor), m(tail)] });
        const beforeRows = rowTexts(db);
        const firstSave = save(store);
        const beforeHashes = expectMessagePages(db, firstSave.id, [beforeRows.slice(0, 2), beforeRows.slice(2)]);
        const beforePages = pages(db);
        const unchanged = save(store);
        expect(checkpoint(db, unchanged.id)).toMatchObject({
            pages: beforeHashes,
            fields: checkpoint(db, firstSave.id).fields,
        });
        expect(pages(db)).toEqual(beforePages);

        edit(store, [{ op: "append", messages: [m(appended)], anchor: { end: true } }]);
        const afterRows = rowTexts(db);
        const next = save(store);
        const afterHashes = expectMessagePages(db, next.id, [afterRows.slice(0, 2), afterRows.slice(2)]);
        expect(afterHashes[0]).toBe(beforeHashes[0]);
        expect(afterHashes[1]).not.toBe(beforeHashes[1]);
        expect(pages(db)).toEqual({ ...beforePages, [afterHashes[1]]: "[" + afterRows.slice(2).join(",") + "]" });
    });

    it("changes only the middle page through the next surviving id anchor", () => {
        const { store, db } = fileStore();
        const [a, b, c] = messageIds(true, 3);
        const [first, middle, last] = messageIds(false, 3);
        seed(store, {
            name: "K",
            note: "note",
            localLore: [],
            message: [first, a, middle, b, last, c].map((id) => m(id)),
        });
        const beforeRows = rowTexts(db);
        const old = save(store);
        const oldHashes = expectMessagePages(db, old.id, [
            beforeRows.slice(0, 2),
            beforeRows.slice(2, 4),
            beforeRows.slice(4),
        ]);
        const oldPages = pages(db);
        edit(store, [{ op: "setText", id: middle, text: "A different middle message 한글" }]);
        const rows = rowTexts(db);
        const next = save(store);
        const hashes = expectMessagePages(db, next.id, [rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)]);
        expect(hashes[0]).toBe(oldHashes[0]);
        expect(hashes[1]).not.toBe(oldHashes[1]);
        expect(hashes[2]).toBe(oldHashes[2]);
        expect(pages(db)).toEqual({ ...oldPages, [hashes[1]]: "[" + rows.slice(2, 4).join(",") + "]" });
    });

    it("shifts 64-message capped pages after an insertion until an id anchor survives", () => {
        const { store, db } = fileStore();
        const plain = messageIds(false, 133);
        const [anchor, endAnchor] = messageIds(true, 2);
        const ids = [...plain.slice(0, 130), anchor, plain[130], endAnchor];
        seed(store, { name: "K", note: "note", localLore: [], message: ids.map((id) => m(id)) });
        const beforeRows = rowTexts(db);
        const old = save(store);
        const oldHashes = expectMessagePages(db, old.id, [
            beforeRows.slice(0, 64),
            beforeRows.slice(64, 128),
            beforeRows.slice(128, 131),
            beforeRows.slice(131),
        ]);
        const oldPages = pages(db);
        edit(store, [{ op: "append", messages: [m(plain[132])], anchor: { after: plain[10] } }]);
        const rows = rowTexts(db);
        const next = save(store);
        const hashes = expectMessagePages(db, next.id, [
            rows.slice(0, 64),
            rows.slice(64, 128),
            rows.slice(128, 132),
            rows.slice(132),
        ]);
        for (let i = 0; i < 3; i++) expect(hashes[i]).not.toBe(oldHashes[i]);
        expect(hashes[3]).toBe(oldHashes[3]);
        expect(Object.keys(pages(db)).sort()).toEqual([...Object.keys(oldPages), ...hashes.slice(0, 3)].sort());
    });

    it("cuts a message page when stored UTF-8 row text reaches one MiB", () => {
        const { store, db } = fileStore();
        const ids = messageIds(false, 3);
        seed(store, {
            name: "K",
            note: "note",
            localLore: [],
            message: [m(ids[0], "한".repeat(180_000)), m(ids[1], "글".repeat(180_000)), m(ids[2])],
        });
        const rows = rowTexts(db);
        expect(Buffer.byteLength(rows[0], "utf8")).toBeLessThan(1024 * 1024);
        expect(Buffer.byteLength(rows[0] + rows[1], "utf8")).toBeGreaterThanOrEqual(1024 * 1024);
        expect(rows.join("").length).toBeLessThan(1024 * 1024);
        expectMessagePages(db, save(store).id, [rows.slice(0, 2), rows.slice(2)]);
    });

    it("keeps a shared field page until its last checkpoint is deleted", () => {
        const { store, db } = fileStore();
        seed(store);
        const first = save(store);
        const second = save(store);
        const noteHash = sha256(JSON.stringify("note"));
        expect(checkpoint(db, first.id).fields.note).toBe(noteHash);
        expect(checkpoint(db, second.id).fields.note).toBe(noteHash);
        const originalPages = pages(db);
        store.checkpoints.delete("c", "k", first.id, first.revision);
        expect(pages(db)).toEqual(originalPages);
        expect(db.prepare("SELECT checkpointSeq FROM checkpointPageRefs WHERE hash = ?").all(noteHash)).toEqual([
            { checkpointSeq: checkpoint(db, second.id).seq },
        ]);
        store.checkpoints.delete("c", "k", second.id, second.revision);
        expect(store.checkpoints.list("c", "k")).toEqual([]);
        expect(db.prepare("SELECT * FROM checkpointPageRefs").all()).toEqual([]);
        expect(pages(db)).toEqual({});
    });

    it.each(["chat", "character"] as const)(
        "cascades a deleted %s to checkpoints, refs and policy, then sweeps orphan pages",
        (owner) => {
            const { store, db, file } = fileStore();
            const seeded = seed(store);
            const saved = save(store);
            const record = checkpoint(db, saved.id);
            store.checkpoints.writePolicy("c", "k", { autoEvery: 2, autoKeep: 3, lastAutoTurns: 4 });
            expect(store.checkpoints.readPolicy("c", "k")).toEqual({ autoEvery: 2, autoKeep: 3, lastAutoTurns: 4 });
            expect(db.prepare("SELECT * FROM chatCheckpointPolicy").all()).toHaveLength(1);
            seed(store, { name: "Other", note: "other note", localLore: [], message: [m("other-message")] }, "other");
            const other = store.checkpoints.save("other", "k", "Other checkpoint", "manual")!;
            store.checkpoints.writePolicy("other", "k", { autoEvery: 1, autoKeep: 1 });
            const otherRecord = checkpoint(db, other.id);
            const survivingHashes = new Set([...otherRecord.pages, ...Object.values(otherRecord.fields)]);
            const beforePages = pages(db);

            if (owner === "chat") edit(store, [{ op: "delete" }]);
            else store.delete(characters, "c", seeded.results[0].revision!);
            expect(store.checkpoints.list("c", "k")).toBeNull();
            expect(store.checkpoints.readPolicy("c", "k")).toBeNull();
            expect(db.prepare("SELECT id FROM chatCheckpoints").all()).toEqual([{ id: other.id }]);
            expect(db.prepare("SELECT * FROM checkpointPageRefs WHERE checkpointSeq = ?").all(record.seq)).toEqual([]);
            expect(db.prepare("SELECT * FROM chatCheckpointPolicy").all()).toHaveLength(1);
            expect(pages(db)).toEqual(beforePages);

            if (owner === "chat") store.checkpoints.sweep();
            else {
                store.close();
                const reopened = createResourceStore({ file, kinds });
                stores.push(reopened);
                expect(reopened.checkpoints.list("other", "k")).toEqual([other]);
            }
            expect(pages(db)).toEqual(
                Object.fromEntries(Object.entries(beforePages).filter(([hash]) => survivingHashes.has(hash))),
            );
            expect(pages(db)).not.toHaveProperty(record.fields.note);
        },
    );

    it("renames and deletes only at the current checkpoint revision and truncates names to 200 UTF-16 units", () => {
        const { store, db } = fileStore();
        seed(store);
        const longName = "😀".repeat(150);
        expect(longName).toHaveLength(300);
        const saved = save(store, longName);
        expect(saved.name).toBe("😀".repeat(100));
        const renamed = store.checkpoints.rename("c", "k", saved.id, saved.revision, "한".repeat(300))!;
        expect(renamed.name).toBe("한".repeat(200));
        expect(renamed.revision).not.toBe(saved.revision);
        const beforePages = pages(db);
        const beforeWrites = store.writeCount();
        expect(() => store.checkpoints.rename("c", "k", saved.id, saved.revision, "Stale")).toThrow(
            ResourceConflictError,
        );
        expect(() => store.checkpoints.delete("c", "k", saved.id, saved.revision)).toThrow(ResourceConflictError);
        expect(store.checkpoints.list("c", "k")).toEqual([renamed]);
        expect(pages(db)).toEqual(beforePages);
        expect(store.writeCount()).toBe(beforeWrites);
        expect(store.checkpoints.delete("c", "k", saved.id, renamed.revision)).not.toBeNull();
        expect(store.checkpoints.rename("c", "k", saved.id, renamed.revision, "Gone")).toBeNull();
        expect(store.checkpoints.delete("c", "k", saved.id, renamed.revision)).toBeNull();
        expect(store.checkpoints.compose("c", "k", saved.id)).toBeNull();
        expect(store.checkpoints.save("c", "missing", "Gone", "manual")).toBeNull();
        expect(store.checkpoints.compose("missing", "k", saved.id)).toBeNull();
    });

    it("allows 100 manual checkpoints per chat and refuses the next without pruning", () => {
        const { store, db } = fileStore();
        seed(store);
        save(store, "Auto", "auto");
        save(store, "Safety", "safety");
        const manual = Array.from({ length: 100 }, (_, i) => save(store, `Manual ${i}`));
        const beforePages = pages(db);
        const beforeWrites = store.writeCount();
        expect(() => store.checkpoints.save("c", "k", "101st", "manual")).toThrow(ResourceValidationError);
        expect(store.checkpoints.list("c", "k")!.filter((item) => item.kind === "manual")).toEqual(manual.toReversed());
        expect(store.checkpoints.list("c", "k")).toHaveLength(102);
        expect(pages(db)).toEqual(beforePages);
        expect(store.writeCount()).toBe(beforeWrites);
        store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "other",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { name: "Other", note: "", localLore: [], message: [] } }],
                },
            ],
        });
        expect(store.checkpoints.save("c", "other", "Own allowance", "manual")).not.toBeNull();
    });

    it("lists newest first and prunes only the requested kind, sweeping its unshared pages", () => {
        const { store, db } = fileStore();
        seed(store);
        const manual = save(store, "Manual");
        const autos = [];
        for (let i = 0; i < 4; i++) {
            edit(store, [{ op: "meta", set: { note: `Auto note ${i}` } }]);
            autos.push(save(store, `Auto ${i}`, "auto"));
        }
        const safety = save(store, "Safety", "safety");
        // Every save has the same controlled timestamp; insertion order must still decide newest.
        expect(store.checkpoints.list("c", "k")).toEqual([safety, ...autos.toReversed(), manual]);
        store.checkpoints.prune("c", "k", "auto", 2);
        expect(store.checkpoints.list("c", "k")).toEqual([safety, autos[3], autos[2], manual]);
        expect(pages(db)).not.toHaveProperty(sha256(JSON.stringify("Auto note 0")));
        expect(pages(db)).not.toHaveProperty(sha256(JSON.stringify("Auto note 1")));
        expect(pages(db)[sha256(JSON.stringify("Auto note 2"))]).toBe(JSON.stringify("Auto note 2"));
        expect(
            db.prepare("SELECT DISTINCT checkpointSeq FROM checkpointPageRefs ORDER BY checkpointSeq").all(),
        ).toEqual([manual, autos[2], autos[3], safety].map((item) => ({ checkpointSeq: checkpoint(db, item.id).seq })));
    });

    it("composes saved story state with current bindings and toggles and removes absent captured fields", () => {
        const { store } = fileStore();
        const original: Chat = fullChat();
        delete original.sdData;
        seed(store, original);
        const saved = save(store);
        const currentKept = {
            name: "Current name",
            pinned: false,
            folderId: "folder-new",
            lastDate: 456,
            bindedPersona: "persona-new",
            promptPresetId: "prompt-new",
            modelPresetId: "model-new",
            bindingReview: false,
            togglePresetId: "toggles-new",
            translatorPresetId: "translator-new",
            autoTranslate: false,
            translateBotOnly: false,
            bilingualDisplay: false,
            bilingualEmphasis: "translation",
            bilingualSentences: 4,
            memoryTrimAck: 9,
            structuredMemoryLanguage: "language-new",
            structuredMemoryHighlight: "all",
            modules: ["module-new"],
        } satisfies Partial<Chat>;
        edit(store, [
            {
                op: "meta",
                // A kept field removed since the save stays removed.
                unset: [
                    ...Object.keys(captured).filter((key) => !["note", "localLore", "fmIndex", "sdData"].includes(key)),
                    "loreBudgetWarnOff",
                ],
                set: {
                    ...currentKept,
                    note: "Changed",
                    localLore: [],
                    fmIndex: 7,
                    sdData: "new-image.png",
                    GLGlobalVariables: {
                        bonus: "999",
                        newStory: "discard",
                        toggle_voice: "new",
                        toggle_added: "keep",
                        toggle_: "new empty suffix",
                    },
                },
            },
            { op: "setText", id: "past", text: "Changed message" },
            { op: "append", messages: [m("new-message")], anchor: { end: true } },
        ]);
        const current = store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
        const beforeWrites = store.writeCount();
        const composed = store.checkpoints.compose("c", "k", saved.id)!;
        const expectedCaptured: Partial<Chat> = { ...captured };
        delete expectedCaptured.sdData;
        expect(composed).toEqual({
            ...expectedCaptured,
            ...currentKept,
            id: "k",
            message: original.message,
            GLGlobalVariables: {
                ...storyVariables,
                toggle_voice: "new",
                toggle_added: "keep",
                toggle_: "new empty suffix",
            },
        });
        expect(Object.hasOwn(composed, "sdData")).toBe(false);
        expect(store.writeCount()).toBe(beforeWrites);
        expect(store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0]).toEqual(current);
    });

    it("stores bounded auto policies and removes the policy when disabled", () => {
        const { store } = fileStore();
        seed(store);
        expect(store.checkpoints.readPolicy("c", "k")).toBeNull();
        store.checkpoints.writePolicy("c", "k", { autoEvery: 1, autoKeep: 1 });
        expect(store.checkpoints.readPolicy("c", "k")).toEqual({ autoEvery: 1, autoKeep: 1, lastAutoTurns: null });
        store.checkpoints.writePolicy("c", "k", { autoEvery: 100, autoKeep: 20, lastAutoTurns: 7 });
        const expected = { autoEvery: 100, autoKeep: 20, lastAutoTurns: 7 };
        expect(store.checkpoints.readPolicy("c", "k")).toEqual(expected);
        for (const invalid of [
            { autoEvery: 0, autoKeep: 1 },
            { autoEvery: 101, autoKeep: 1 },
            { autoEvery: 1, autoKeep: 0 },
            { autoEvery: 1, autoKeep: 21 },
        ]) {
            expect(() => store.checkpoints.writePolicy("c", "k", invalid)).toThrow(ResourceValidationError);
            expect(store.checkpoints.readPolicy("c", "k")).toEqual(expected);
        }
        store.checkpoints.writePolicy("c", "k", null);
        expect(store.checkpoints.readPolicy("c", "k")).toBeNull();
    });
});

describe("legacy candidate fields in named checkpoints", () => {
    it("loads a checkpoint page with malformed candidates without losing the reply or its valid baseline", () => {
        const { store, file } = fileStore();
        seed(store, { name: "K", note: "", localLore: [], message: [m("r", "Saved reply", "char")] });
        const saved = save(store);
        const writer = new DatabaseSync(file);
        try {
            const legacy = JSON.stringify([
                {
                    ...m("r", "Saved reply", "char"),
                    candidates: [{ id: "only", data: "orphan" }],
                    selected: 3,
                    scriptstateCheckpoint: { before: null },
                },
            ]);
            const hash = sha256(legacy);
            writer.prepare("INSERT INTO checkpointPages (hash, text) VALUES (?, ?)").run(hash, legacy);
            writer.prepare("UPDATE chatCheckpoints SET pages = ? WHERE id = ?").run(JSON.stringify([hash]), saved.id);
            writer
                .prepare(
                    "DELETE FROM checkpointPageRefs WHERE checkpointSeq = (SELECT seq FROM chatCheckpoints WHERE id = ?)",
                )
                .run(saved.id);
            writer
                .prepare(
                    "INSERT INTO checkpointPageRefs (checkpointSeq, hash) SELECT seq, ? FROM chatCheckpoints WHERE id = ?",
                )
                .run(hash, saved.id);
        } finally {
            writer.close();
        }
        edit(store, [{ op: "setText", id: "r", text: "Changed" }]);
        expect(loadCheckpoint(store, saved.id).status).toBe(200);
        const loaded = store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
        expect(loaded.data?.message).toEqual([
            { ...m("r", "Saved reply", "char"), scriptstateCheckpoint: { before: null } },
        ]);
    });
});
