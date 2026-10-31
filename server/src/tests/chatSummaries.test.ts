// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatOp, ChatSummary } from "../../../shared/chats.ts";
import type { ResourceReadKindsResult, ResourceReadRefsResult } from "../../../shared/resources.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { SUMMARY_PROJECTION_VERSION } from "../data/chatStore.ts";
import { createCheckpointService } from "../data/checkpointService.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

// The server's summary reads. A `ChatSummary` is the listed fields picked from a chat's stored
// metadata: no message rows in the payload, no memory data (`hypaV2Data`, `hypaV3Data`,
// `supaMemoryData`), bookmarks, or note. `readKinds(..., { chatSummaries })` answers every summary
// with every order (exclusive with `chats`), `readRefs(..., { chatSummaryCollections })` a
// character's order with its summaries, and the routes validate the options the way they validate
// `chats` and `chatCollections` (counted toward the cap).

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;
const SUMMARY_KEYS = [
    "bindedPersona",
    "bindingReview",
    "characterId",
    "fmIndex",
    "folderId",
    "id",
    "modelPresetId",
    "name",
    "pinned",
    "promptPresetId",
    "revision",
    // The translation settings.
    "translatorPresetId",
    "autoTranslate",
    "translateBotOnly",
    "bilingualDisplay",
    "bilingualEmphasis",
    "bilingualSentences",
];

const stores: ResourceStore[] = [];
const dirs: string[] = [];
const connections: DatabaseSync[] = [];
const servers: ResourceTestClient[] = [];
beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const db of connections.splice(0)) db.close();
    for (const store of stores.splice(0)) {
        store.close();
    }
    await Promise.all(servers.splice(0).map((s) => s.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const group = (chatId: string, ops: ChatOp[], characterId = "c") => ({ characterId, chatId, baseRevision: null, ops });
const create = (chat: Record<string, unknown>): ChatOp => ({ op: "create", chat: chat as never });

/** A chat with everything a summary must leave out: messages, memory data, bookmarks, a note. */
const fullChat = (id: string, name: string) => ({
    id,
    name,
    note: `the note of ${id}`,
    localLore: [{ key: "k", content: "lore" }],
    folderId: `folder-${id}`,
    bindedPersona: `persona-${id}`,
    promptPresetId: `prompt-${id}`,
    modelPresetId: `model-${id}`,
    bindingReview: true,
    fmIndex: 2,
    hypaV2Data: { lastMainChunkID: 1, mainChunks: [{ text: "memory" }], chunks: [] },
    hypaV3Data: { summaries: [{ text: "summary", chatMemos: [] }], lastSelectedSummaries: [] },
    supaMemoryData: "supa memory text",
    bookmarks: ["a"],
    bookmarkNames: { a: "first" },
    message: [m("a", "A"), m("b", "B", "char")],
});

/** Two characters: `c` with chats `k` (everything set) and `j` (nothing optional), `d` with `kd`. */
function seedStore() {
    const store = createResourceStore({ file: ":memory:", kinds });
    stores.push(store);
    const result = store.applyChanges({
        ops: [
            { kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: characters, id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
        ],
        chats: [
            group("k", [create(fullChat("k", "K"))]),
            group("j", [create({ id: "j", name: "J", message: [m("x", "X")] })]),
            group("kd", [create({ id: "kd", name: "KD", message: [] })], "d"),
        ],
    });
    return { store, result };
}

describe("the store's summary reads", () => {
    it("publishes changed list projections with the final row's finite time, including earlier and absent times", () => {
        const feed = createChangeFeed();
        const events: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
        feed.subscribe((event) => {
            if (event.type === "change") events.push(event);
        });
        const store = createResourceStore({ file: ":memory:", kinds, feed });
        stores.push(store);
        store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c" } }],
            chats: [
                group("k", [
                    create({
                        id: "k",
                        name: "K",
                        message: [{ ...m("a"), time: 900 }, m("b"), { ...m("c"), time: 100 }, { ...m("d"), time: 200 }],
                    }),
                ]),
            ],
        });
        const cases: { ops: ChatOp[]; fields: Record<string, unknown> }[] = [
            {
                ops: [{ op: "append", anchor: { end: true }, messages: [{ ...m("e"), time: 300 }] }],
                fields: { name: "K", lastMessageAt: 300 },
            },
            { ops: [{ op: "meta", set: { name: "Renamed" } }], fields: { name: "Renamed", lastMessageAt: 300 } },
            {
                ops: [{ op: "meta", set: { folderId: "folder" } }],
                fields: { name: "Renamed", folderId: "folder", lastMessageAt: 300 },
            },
            {
                ops: [{ op: "meta", set: { pinned: true } }],
                fields: { name: "Renamed", folderId: "folder", pinned: true, lastMessageAt: 300 },
            },
            // The note is not listed, but removing the final row changes the projection in the same group.
            {
                ops: [
                    { op: "meta", set: { note: "private note" } },
                    { op: "remove", ids: ["e"] },
                ],
                fields: { name: "Renamed", folderId: "folder", pinned: true, lastMessageAt: 200 },
            },
            // The undated final row hides the older dated row; there is no backward search for a time.
            { ops: [{ op: "remove", ids: ["c", "d"] }], fields: { name: "Renamed", folderId: "folder", pinned: true } },
            {
                ops: [{ op: "setMessage", message: { ...m("b"), time: 50 } }],
                fields: { name: "Renamed", folderId: "folder", pinned: true, lastMessageAt: 50 },
            },
            {
                ops: [{ op: "append", anchor: { end: true }, messages: [{ ...m("earlier"), time: 25 }] }],
                fields: { name: "Renamed", folderId: "folder", pinned: true, lastMessageAt: 25 },
            },
        ];
        for (const { ops, fields } of cases) {
            events.length = 0;
            const result = store.applyChanges({
                chats: [{ ...group("k", ops), baseRevision: store.chatRevision("c", "k") }],
            });
            const summary = { characterId: "c", id: "k", revision: result.chats[0].revision, fmIndex: -1, ...fields };
            expect(events).toHaveLength(1);
            expect(events[0].changes.chats).toHaveLength(1);
            expect(events[0].changes.chats[0].summary, JSON.stringify(ops)).toEqual(summary);
            expect(events[0].changes.chats[0]).not.toHaveProperty("summaryBase");
            expect(store.readKinds([], { chatSummaries: true }).chatSummaries).toEqual([summary]);
            expect(store.readRefs([], { chatSummaryCollections: ["c"] }).chatSummaryCollections![0].chats).toEqual([
                summary,
            ]);
        }
    });

    it("projects pinned only for stored true, omitting false, absent, and non-boolean metadata", () => {
        const { store } = seedStore();
        const fixtures = [
            { id: "pin-true", pinned: true },
            { id: "pin-false", pinned: false },
            { id: "pin-absent" },
            { id: "pin-string", pinned: "true" },
        ];
        store.applyChanges({
            chats: fixtures.map((fields) => group(fields.id, [create({ ...fields, name: fields.id, message: [] })])),
        });

        const read = store.readKinds([characters], { chatSummaries: true });
        const collection = store.readRefs([], { chatSummaryCollections: ["c"] }).chatSummaryCollections![0];
        expect(read).not.toHaveProperty("chats");
        for (const summaries of [read.chatSummaries!, collection.chats]) {
            expect(summaries.find((entry) => entry.id === "pin-true")).toMatchObject({ pinned: true });
            for (const id of ["pin-false", "pin-absent", "pin-string"]) {
                const summary = summaries.find((entry) => entry.id === id);
                expect(summary, id).toBeDefined();
                expect(summary, id).not.toHaveProperty("pinned");
            }
        }
    });

    it("readKinds with chatSummaries answers every chat's listed fields and every order, without messages or memory data", () => {
        const { store, result } = seedStore();
        const full = store.readKinds([characters], { chats: true });
        const read = store.readKinds([characters], { chatSummaries: true });

        expect(read).not.toHaveProperty("chats");
        expect(read.kinds.characters.map((record) => record.id)).toEqual(["c", "d"]);
        expect(read.chatOrders).toEqual(full.chatOrders);
        const summaries = read.chatSummaries!;
        expect(summaries).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: result.chats[0].revision,
                name: "K",
                folderId: "folder-k",
                bindedPersona: "persona-k",
                promptPresetId: "prompt-k",
                modelPresetId: "model-k",
                bindingReview: true,
                fmIndex: 2,
            },
            { characterId: "c", id: "j", revision: result.chats[1].revision, name: "J", fmIndex: -1 },
            { characterId: "d", id: "kd", revision: result.chats[2].revision, name: "KD", fmIndex: -1 },
        ]);
        // The revisions are the chats' own, so a summary can be compared with a held revision.
        expect(summaries.map((summary) => summary.revision)).toEqual(full.chats!.map((chat) => chat.revision));
        for (const summary of summaries) {
            expect(Object.keys(summary).every((key) => SUMMARY_KEYS.includes(key))).toBe(true);
            expect(JSON.stringify(summary)).not.toMatch(/message|hypa|supa|bookmark|note|lore/);
        }
        // The optional fields are absent, not null, when the chat has none.
        expect(summaries[1]).not.toHaveProperty("folderId");
        expect(summaries[1]).not.toHaveProperty("bindedPersona");
        for (const field of ["promptPresetId", "modelPresetId", "bindingReview"]) {
            expect(summaries[1], field).not.toHaveProperty(field);
        }
    });

    it("projects the binding fields as list fields: string ids only, and bindingReview as either boolean", () => {
        const store = createResourceStore({ file: ":memory:", kinds });
        stores.push(store);
        store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [
                group("reviewed", [
                    create({
                        id: "reviewed",
                        name: "Reviewed",
                        modelPresetId: "m1",
                        promptPresetId: "p1",
                        bindedPersona: "u1",
                        bindingReview: false,
                        message: [],
                    }),
                ]),
                group("malformed", [
                    create({
                        id: "malformed",
                        name: "Malformed",
                        modelPresetId: 1,
                        promptPresetId: null,
                        bindedPersona: ["u1"],
                        bindingReview: "true",
                        message: [],
                    }),
                ]),
                group("padded", [
                    create({ id: "padded", name: "Padded", modelPresetId: " m1 ", promptPresetId: "", message: [] }),
                ]),
            ],
        });
        const summaries = store.readKinds([characters], { chatSummaries: true }).chatSummaries!;
        const byId = Object.fromEntries(summaries.map((summary) => [summary.id, summary]));
        // `false` is kept: a client preserves either boolean and the resolver blocks only on `true`.
        expect(byId.reviewed).toMatchObject({
            modelPresetId: "m1",
            promptPresetId: "p1",
            bindedPersona: "u1",
            bindingReview: false,
        });
        for (const field of ["modelPresetId", "promptPresetId", "bindedPersona", "bindingReview"]) {
            expect(byId.malformed, field).not.toHaveProperty(field);
        }
        // Stored as sent: the summary does not trim or drop a blank string; the resolver reads it as
        // unset.
        expect(byId.padded).toMatchObject({ modelPresetId: " m1 ", promptPresetId: "" });
        expect(byId.padded).not.toHaveProperty("bindedPersona");
        expect(byId.padded).not.toHaveProperty("bindingReview");
        for (const summary of summaries) {
            expect(
                Object.keys(summary).every((key) => SUMMARY_KEYS.includes(key)),
                summary.id,
            ).toBe(true);
        }
    });

    it("projects the translation settings as list fields: typed values only, false and 0 kept, nothing defaulted; a meta op moves them", () => {
        const store = createResourceStore({ file: ":memory:", kinds });
        stores.push(store);
        const full = {
            translatorPresetId: "tp",
            autoTranslate: false,
            translateBotOnly: true,
            bilingualDisplay: false,
            bilingualEmphasis: "translation",
            bilingualSentences: 0,
        };
        const seeded = store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [
                group("full", [create({ id: "full", name: "Full", ...full, message: [m("a", "A")] })]),
                group("malformed", [
                    create({
                        id: "malformed",
                        name: "Malformed",
                        translatorPresetId: 5,
                        autoTranslate: "true",
                        translateBotOnly: null,
                        bilingualDisplay: 1,
                        bilingualEmphasis: true,
                        bilingualSentences: "3",
                        message: [],
                    }),
                ]),
                // Stored as sent: a padded id, a string emphasis, and a number out of range are typed values.
                group("odd", [
                    create({
                        id: "odd",
                        name: "Odd",
                        translatorPresetId: " tp ",
                        bilingualEmphasis: "weird",
                        bilingualSentences: 99,
                        message: [],
                    }),
                ]),
            ],
        });
        const summaries = () => store.readKinds([characters], { chatSummaries: true }).chatSummaries!;
        const byId = Object.fromEntries(summaries().map((summary) => [summary.id, summary]));
        expect(byId.full).toEqual({
            characterId: "c",
            id: "full",
            revision: seeded.chats[0].revision,
            name: "Full",
            fmIndex: -1,
            ...full,
        });
        expect(byId.malformed).toEqual({
            characterId: "c",
            id: "malformed",
            revision: seeded.chats[1].revision,
            name: "Malformed",
            fmIndex: -1,
        });
        expect(byId.odd).toMatchObject({
            translatorPresetId: " tp ",
            bilingualEmphasis: "weird",
            bilingualSentences: 99,
        });
        for (const summary of summaries()) {
            expect(
                Object.keys(summary).every((key) => SUMMARY_KEYS.includes(key)),
                summary.id,
            ).toBe(true);
        }
        // The collection read projects the same fields.
        const collection = store.readRefs([], { chatSummaryCollections: ["c"] }).chatSummaryCollections![0];
        expect(collection.chats.find((chat) => chat.id === "full")).toEqual(byId.full);

        // A `meta` op sets and unsets them in the summary (the tab's panel writes this way).
        store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "full",
                    baseRevision: seeded.chats[0].revision,
                    ops: [
                        {
                            op: "meta",
                            set: { autoTranslate: true, bilingualSentences: 4 },
                            unset: ["translatorPresetId", "bilingualEmphasis"],
                        },
                    ],
                },
            ],
        });
        const after = summaries().find((summary) => summary.id === "full")!;
        expect(after).toMatchObject({ autoTranslate: true, bilingualSentences: 4, translateBotOnly: true });
        expect(after).not.toHaveProperty("translatorPresetId");
        expect(after).not.toHaveProperty("bilingualEmphasis");
    });

    it("refuses chats together with chatSummaries, and answers neither without the options", () => {
        const { store } = seedStore();
        expect(() => store.readKinds([characters], { chats: true, chatSummaries: true })).toThrow(TypeError);
        const plain = store.readKinds([characters]);
        expect(plain).not.toHaveProperty("chatSummaries");
        expect(plain).not.toHaveProperty("chatOrders");
    });

    it("readRefs with chatSummaryCollections answers a character's order with its summaries, null for a character without one, and the key only when asked", () => {
        const { store } = seedStore();
        const full = store.readRefs([], { chatCollections: ["c"] }).chatCollections[0];
        const read = store.readRefs([], { chatSummaryCollections: ["c", "nobody"] });
        expect(read.chatSummaryCollections).toEqual([
            {
                characterId: "c",
                order: full.order,
                chats: full.chats.map((chat): ChatSummary => ({
                    characterId: "c",
                    id: chat.id,
                    revision: chat.revision,
                    name: chat.data.name,
                    ...(chat.data.folderId ? { folderId: chat.data.folderId } : {}),
                    ...(chat.data.bindedPersona ? { bindedPersona: chat.data.bindedPersona } : {}),
                    ...(chat.data.promptPresetId ? { promptPresetId: chat.data.promptPresetId } : {}),
                    ...(chat.data.modelPresetId ? { modelPresetId: chat.data.modelPresetId } : {}),
                    ...(typeof chat.data.bindingReview === "boolean" ? { bindingReview: chat.data.bindingReview } : {}),
                    fmIndex: chat.data.fmIndex ?? -1,
                })),
            },
            { characterId: "nobody", order: null, chats: [] },
        ]);
        expect(JSON.stringify(read.chatSummaryCollections)).not.toMatch(/message|hypa|supa|bookmark/);
        expect(store.readRefs([], { chatCollections: ["c"] })).not.toHaveProperty("chatSummaryCollections");
        expect(store.readRefs([], { chatSummaryCollections: [] })).not.toHaveProperty("chatSummaryCollections");
    });
});

// Each field comes from freshly read metadata; identity, revision, activity, and memory stay out.
function projectionText(meta: Record<string, unknown>) {
    return JSON.stringify({
        name: meta.name,
        fmIndex: meta.fmIndex,
        folderId: meta.folderId,
        bindedPersona: meta.bindedPersona,
        promptPresetId: meta.promptPresetId,
        modelPresetId: meta.modelPresetId,
        bindingReview: meta.bindingReview,
        pinned: meta.pinned,
        translatorPresetId: meta.translatorPresetId,
        autoTranslate: meta.autoTranslate,
        translateBotOnly: meta.translateBotOnly,
        bilingualDisplay: meta.bilingualDisplay,
        bilingualEmphasis: meta.bilingualEmphasis,
        bilingualSentences: meta.bilingualSentences,
    });
}
const projectedChat = (id = "k") => ({
    ...fullChat(id, id.toUpperCase()),
    pinned: true,
    translatorPresetId: "translation",
    autoTranslate: false,
    translateBotOnly: true,
    bilingualDisplay: false,
    bilingualEmphasis: "translation",
    bilingualSentences: 0,
});

function summaryFile(feed?: ReturnType<typeof createChangeFeed>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-chat-summaries-"));
    dirs.push(dir);
    const file = path.join(dir, "resources.sqlite");
    const open = () => {
        const store = createResourceStore({ file, kinds, feed });
        stores.push(store);
        return store;
    };
    const store = open();
    const db = new DatabaseSync(file);
    connections.push(db);
    return { dir, file, store, db, open };
}

function storedProjection(db: DatabaseSync, id = "k") {
    return db
        .prepare("SELECT s.revision, s.text FROM chatSummaries s JOIN chats c ON c.seq = s.chatSeq WHERE c.id = ?")
        .get(id);
}
function expectStoredProjection(db: DatabaseSync, id = "k") {
    const chat = db.prepare("SELECT revision, meta FROM chats WHERE id = ?").get(id) as {
        revision: number;
        meta: string;
    };
    expect(storedProjection(db, id)).toEqual({ revision: chat.revision, text: projectionText(JSON.parse(chat.meta)) });
}
function seedProjection(store: ResourceStore, ids = ["k"]) {
    store.put(characters, "c", { chaId: "c", name: "C" }, null);
    store.applyChanges({ chats: ids.map((id) => group(id, [create(projectedChat(id))])) });
}
function editProjection(store: ResourceStore, ops: ChatOp[]) {
    return store.applyChanges({ chats: [{ ...group("k", ops), baseRevision: store.chatRevision("c", "k") }] });
}
function olderWriter(db: DatabaseSync, id = "k") {
    db.prepare(
        "UPDATE chats SET revision = revision + 1, meta = json_set(meta, '$.name', 'Older writer', '$.folderId', 'moved') WHERE id = ?",
    ).run(id);
}

/** Count executions, including statements prepared before the measured read. */
function watchMetadataReads() {
    const reads: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        const selected = /^\s*SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(sql)?.[1];
        const selectsMetadata = selected
            ?.split(",")
            .some((column) => /^\s*(?:\w+\.)?(?:meta|\*)(?:\s+(?:AS\s+)?\w+)?\s*$/i.test(column));
        if (selectsMetadata && /\b(?:FROM|JOIN)\s+chats\b/i.test(sql)) {
            const { all, get, iterate } = statement;
            statement.all = function (...args) {
                reads.push(sql);
                return Reflect.apply(all, this, args);
            };
            statement.get = function (...args) {
                reads.push(sql);
                return Reflect.apply(get, this, args);
            };
            statement.iterate = function (...args) {
                reads.push(sql);
                return Reflect.apply(iterate, this, args);
            };
        }
        return statement;
    });
    return reads;
}

describe("stored summary projections", () => {
    it.each(["create", "meta group", "replace", "checkpoint load", "message op", "staged backup"])(
        "stores all fourteen fields and the chat revision after %s",
        async (write) => {
            const { store, db, dir } = summaryFile();
            seedProjection(store);
            if (write === "meta group") {
                editProjection(store, [
                    { op: "meta", set: { name: "Renamed", bindingReview: false, bilingualSentences: 2 } },
                    { op: "meta", set: { folderId: "moved", autoTranslate: true } },
                ]);
            } else if (write === "replace") {
                editProjection(store, [
                    { op: "replace", chat: { ...projectedChat(), name: "Replacement", fmIndex: 8 } as never },
                ]);
            } else if (write === "checkpoint load") {
                const saved = store.checkpoints.save("c", "k", "Saved", "manual")!;
                editProjection(store, [{ op: "meta", set: { fmIndex: 8, name: "Current name" } }]);
                const service = createCheckpointService({ store, busy: () => false, memoryTasks: null });
                expect(
                    service.load({
                        epoch: store.epoch(),
                        body: {
                            characterId: "c",
                            chatId: "k",
                            id: saved.id,
                            chatBaseRevision: store.chatRevision("c", "k"),
                        },
                    }).status,
                ).toBe(200);
                const meta = JSON.parse(
                    (db.prepare("SELECT meta FROM chats WHERE id = 'k'").get() as { meta: string }).meta,
                );
                expect(meta).toMatchObject({ name: "Current name", fmIndex: 2 });
            } else if (write === "message op") {
                editProjection(store, [
                    { op: "append", anchor: { end: true }, messages: [{ ...m("new"), time: 123 }] },
                ]);
            } else if (write === "staged backup") {
                // Upstream staging puts resources first, then applies separate chat batches.
                store.put(characters, "d", { chaId: "d", name: "D" }, null);
                store.applyChanges({ chats: [group("j", [create(projectedChat("j"))], "d")] });
                editProjection(store, [{ op: "meta", set: { name: "Imported", fmIndex: 9 } }]);
                const copy = path.join(dir, "staged.sqlite");
                await store.backupTo(copy);
                const copied = new DatabaseSync(copy);
                connections.push(copied);
                expectStoredProjection(copied, "k");
                expectStoredProjection(copied, "j");
            }
            expectStoredProjection(db);
        },
    );

    it("reads every summary boundary without selecting or parsing large metadata", () => {
        const reads = watchMetadataReads();
        const { store } = seedStore();
        store.applyChanges({
            chats: [
                {
                    ...group("k", [{ op: "meta", set: { supaMemoryData: "x".repeat(100 * 1024) } }]),
                    baseRevision: store.chatRevision("c", "k"),
                },
                {
                    ...group("j", [{ op: "meta", set: { supaMemoryData: "x".repeat(100 * 1024) } }]),
                    baseRevision: store.chatRevision("c", "j"),
                },
                {
                    ...group("kd", [{ op: "meta", set: { supaMemoryData: "x".repeat(100 * 1024) } }], "d"),
                    baseRevision: store.chatRevision("d", "kd"),
                },
            ],
        });
        const parse = JSON.parse;
        const largeParses: number[] = [];
        vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (typeof text === "string" && text.length > 50 * 1024) largeParses.push(text.length);
            return parse(text, reviver);
        });
        const boundaries = [
            () => store.readKinds([], { chatSummaries: true }).chatSummaries!,
            () => store.readKinds([], { chatSummaries: true, skipChatCollections: new Set(["d"]) }).chatSummaries!,
            () => store.readRefs([], { chatSummaryCollections: ["c"] }).chatSummaryCollections![0].chats,
            () => [store.chatSummary("c", "k")!],
        ];
        for (const [index, read] of boundaries.entries()) {
            reads.length = 0;
            largeParses.length = 0;
            const result = read();
            expect(result.map(({ id, name }) => [id, name])).toEqual(
                [
                    [
                        ["k", "K"],
                        ["j", "J"],
                        ["kd", "KD"],
                    ],
                    [
                        ["k", "K"],
                        ["j", "J"],
                    ],
                    [
                        ["k", "K"],
                        ["j", "J"],
                    ],
                    [["k", "K"]],
                ][index],
            );
            expect(reads).toEqual([]);
            expect(largeParses).toEqual([]);
        }
    });

    it.each(["stale", "missing"])("repairs a %s projection on read and uses the stored text next time", (state) => {
        const reads = watchMetadataReads();
        const { store, db } = summaryFile();
        seedProjection(store);
        olderWriter(db);
        if (state === "missing") db.exec("DELETE FROM chatSummaries");
        const current = store.chatRevision("c", "k");
        expect(store.chatSummary("c", "k")).toMatchObject({
            name: "Older writer",
            folderId: "moved",
            revision: current,
        });
        expectStoredProjection(db);
        reads.length = 0;
        expect(store.chatSummary("c", "k")).toMatchObject({
            name: "Older writer",
            folderId: "moved",
            revision: current,
        });
        expect(reads).toEqual([]);
    });

    it("keeps a stale projection behind message writes and publishes the current metadata", () => {
        const feed = createChangeFeed();
        const events: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
        feed.subscribe((event) => {
            if (event.type === "change") events.push(event);
        });
        const { store, db } = summaryFile(feed);
        seedProjection(store);
        olderWriter(db);
        events.length = 0;
        const applied = editProjection(store, [
            { op: "append", anchor: { end: true }, messages: [{ ...m("new"), time: 123 }] },
        ]);
        expect(events).toHaveLength(1);
        expect(events[0].changes.chats[0].summary).toMatchObject({
            name: "Older writer",
            folderId: "moved",
            revision: applied.chats[0].revision,
            lastMessageAt: 123,
        });
        expect(events[0].changes.chats[0]).not.toHaveProperty("summaryBase");
        expect(
            db
                .prepare(
                    "SELECT s.revision < c.revision AS stale FROM chatSummaries s JOIN chats c ON c.seq = s.chatSeq",
                )
                .get(),
        ).toEqual({ stale: 1 });
        expect(store.chatSummary("c", "k")).toMatchObject({ name: "Older writer", lastMessageAt: 123 });
        expectStoredProjection(db);
    });

    it("rebuilds every missing row at open, preserves fresh rows on reopen, and rebuilds a different projection version", () => {
        const { store, db, open } = summaryFile();
        seedProjection(store, ["k", "j"]);
        store.close();
        db.exec("DROP TABLE chatSummaries");
        const rebuilt = open();
        for (const id of ["k", "j"]) expectStoredProjection(db, id);
        rebuilt.close();
        const tampered = JSON.stringify({ name: "Kept at the same revision", fmIndex: -1 });
        db.prepare("UPDATE chatSummaries SET text = ?").run(tampered);
        const reopened = open();
        expect(db.prepare("SELECT text FROM chatSummaries").all()).toEqual([{ text: tampered }, { text: tampered }]);
        reopened.close();
        db.prepare("UPDATE meta SET value = ? WHERE key = 'summaryProjectionVersion'").run(
            String(SUMMARY_PROJECTION_VERSION + 1),
        );
        open();
        for (const id of ["k", "j"]) expectStoredProjection(db, id);
        expect(db.prepare("SELECT value FROM meta WHERE key = 'summaryProjectionVersion'").get()).toEqual({
            value: String(SUMMARY_PROJECTION_VERSION),
        });
    });

    it("rolls back a failed rebuild, closes its connection, and opens after the named chat is repaired", () => {
        const { store, db, open } = summaryFile();
        seedProjection(store, ["k", "j"]);
        store.close();
        const saved = (db.prepare("SELECT meta FROM chats WHERE id = 'j'").get() as { meta: string }).meta;
        db.exec("DROP TABLE chatSummaries; UPDATE chats SET meta = 'invalid json' WHERE id = 'j'");
        const oldVersion = String(SUMMARY_PROJECTION_VERSION + 1);
        db.prepare("UPDATE meta SET value = ? WHERE key = 'summaryProjectionVersion'").run(oldVersion);
        // Reopening a SQLite file alone does not prove that the failed opener released its handle.
        const close = vi.spyOn(DatabaseSync.prototype, "close");
        expect(open).toThrow(/c\/j/);
        expect(close).toHaveBeenCalledTimes(1);
        close.mockRestore();
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chatSummaries'").all()).toEqual([]);
        expect(db.prepare("SELECT value FROM meta WHERE key = 'summaryProjectionVersion'").get()).toEqual({
            value: oldVersion,
        });
        db.prepare("UPDATE chats SET meta = ? WHERE id = 'j'").run(saved);
        open();
        for (const id of ["k", "j"]) expectStoredProjection(db, id);
    });

    it.each(["chat", "character"])("removes the projection with its %s", (deleted) => {
        const { store, db } = summaryFile();
        seedProjection(store, ["k", "j"]);
        const seqs = db.prepare("SELECT seq FROM chats ORDER BY seq").all() as { seq: number }[];
        if (deleted === "chat") editProjection(store, [{ op: "delete" }]);
        else
            store.applyChanges({
                ops: [{ kind: characters, id: "c", baseRevision: store.revisionOf(characters, "c"), delete: true }],
            });
        expect(db.prepare("SELECT chatSeq FROM chatSummaries ORDER BY chatSeq").all()).toEqual(
            deleted === "chat" ? [{ chatSeq: seqs[1].seq }] : [],
        );
    });
});

describe("the routes", () => {
    async function seededServer() {
        const s = await createResourceTestClient();
        servers.push(s);
        const r = await s.json("/api/resources/batch", {
            ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c" } }],
            chats: [
                group("k", [create(fullChat("k", "K"))]),
                group("j", [create({ id: "j", name: "J", message: [] })]),
            ],
        });
        expect(r.status).toBe(200);
        return s;
    }

    it("GET /api/resources with chatSummaries=1 answers the summaries and the orders, never the chats; another value or both options are refused", async () => {
        const s = await seededServer();
        const full = (await (
            await s.request("/api/resources?kinds=characters&chats=1")
        ).json()) as ResourceReadKindsResult;
        const res = await s.request("/api/resources?kinds=characters&chatSummaries=1");
        expect(res.status).toBe(200);
        const body = (await res.json()) as ResourceReadKindsResult;
        expect(body).not.toHaveProperty("chats");
        expect(body.chatOrders).toEqual(full.chatOrders);
        expect(body.chatSummaries).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: full.chats![0].revision,
                name: "K",
                folderId: "folder-k",
                bindedPersona: "persona-k",
                promptPresetId: "prompt-k",
                modelPresetId: "model-k",
                bindingReview: true,
                fmIndex: 2,
            },
            { characterId: "c", id: "j", revision: full.chats![1].revision, name: "J", fmIndex: -1 },
        ]);
        expect(JSON.stringify(body.chatSummaries)).not.toMatch(/message|hypa|supa|bookmark|note/);

        for (const value of ["0", "true", ""]) {
            const bad = await s.request(`/api/resources?kinds=characters&chatSummaries=${value}`);
            expect(bad.status, value).toBe(400);
            expect(await bad.json(), value).toEqual({ error: "chatSummaries query parameter must be 1" });
        }
        const both = await s.request("/api/resources?kinds=characters&chats=1&chatSummaries=1");
        expect(both.status).toBe(400);
        expect(await both.json()).toEqual({ error: "chats and chatSummaries cannot be combined" });
    });

    it("POST /api/resources/read with chatSummaryCollections answers the collections' summaries, validates them like chatCollections, and counts them toward the cap", async () => {
        const s = await seededServer();
        const full = (await (
            await s.json("/api/resources/read", { chatCollections: ["c"] })
        ).json()) as ResourceReadRefsResult;
        expect(full).not.toHaveProperty("chatSummaryCollections");
        const res = await s.json("/api/resources/read", { chatSummaryCollections: ["c", "nobody"] });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ResourceReadRefsResult;
        expect(body).toEqual({
            epoch: s.epoch,
            items: [],
            chats: [],
            chatCollections: [],
            chatSummaryCollections: [
                {
                    characterId: "c",
                    order: full.chatCollections![0].order,
                    chats: [
                        {
                            characterId: "c",
                            id: "k",
                            revision: full.chatCollections![0].chats[0].revision,
                            name: "K",
                            folderId: "folder-k",
                            bindedPersona: "persona-k",
                            promptPresetId: "prompt-k",
                            modelPresetId: "model-k",
                            bindingReview: true,
                            fmIndex: 2,
                        },
                        {
                            characterId: "c",
                            id: "j",
                            revision: full.chatCollections![0].chats[1].revision,
                            name: "J",
                            fmIndex: -1,
                        },
                    ],
                },
                { characterId: "nobody", order: null, chats: [] },
            ],
        });

        for (const [label, ref, error] of [
            [
                "not an array",
                { chatSummaryCollections: "c" },
                "chatSummaryCollections must be an array of character ids",
            ],
            ["not an id", { chatSummaryCollections: [1] }, "chatSummaryCollections must be character ids"],
            ["invalid id", { chatSummaryCollections: [".."] }, "chatSummaryCollections must be character ids"],
            ["nothing named", { chatSummaryCollections: [] }, "Body must name 1 to 5000 entries"],
            [
                "too many across lists",
                {
                    chatCollections: Array.from({ length: 2500 }, () => "c"),
                    chatSummaryCollections: Array.from({ length: 2501 }, () => "c"),
                },
                "Body must name 1 to 5000 entries",
            ],
        ] as [string, unknown, string][]) {
            const bad = await s.json("/api/resources/read", ref);
            expect(bad.status, label).toBe(400);
            expect(await bad.json(), label).toEqual({ error });
        }
        // Exactly the cap, across the lists, is accepted.
        const atCap = await s.json("/api/resources/read", {
            chatCollections: Array.from({ length: 2500 }, () => "c"),
            chatSummaryCollections: Array.from({ length: 2500 }, () => "c"),
        });
        expect(atCap.status).toBe(200);
    });
});
