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
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    createResourceStore,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";

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
        expect(record.fields).toEqual(
            Object.fromEntries(
                Object.entries(expectedFields).map(([key, value]) => [key, sha256(JSON.stringify(value))]),
            ),
        );
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
            modules: ["module-new"],
        } satisfies Partial<Chat>;
        edit(store, [
            {
                op: "meta",
                unset: Object.keys(captured).filter((key) => !["note", "localLore", "fmIndex", "sdData"].includes(key)),
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
