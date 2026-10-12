// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatOp, ChatSummary } from "../../../shared/chats.ts";
import type { ResourceReadKindsResult, ResourceReadRefsResult } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

// Phase 6 slice 9a (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`,
// "Validation"): the server's summary reads. A `ChatSummary` is the listed fields picked from a
// chat's stored metadata: no message rows in the payload, no memory data (`hypaV2Data`,
// `hypaV3Data`, `supaMemoryData`), bookmarks, or note. `readKinds(..., { chatSummaries })` answers
// every summary with every order (exclusive with `chats`), `readRefs(..., { chatSummaryCollections })`
// a character's order with its summaries, and the routes validate the options the way they
// validate `chats` and `chatCollections` (counted toward the cap).

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
    "promptPresetId",
    "revision",
    // The translation settings (`docs/plan/translation.md` slice 2.1).
    "translatorPresetId",
    "autoTranslate",
    "translateBotOnly",
    "bilingualDisplay",
    "bilingualEmphasis",
    "bilingualSentences",
];

const stores: ResourceStore[] = [];
const servers: ResourceTestClient[] = [];
beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    await Promise.all(servers.splice(0).map((s) => s.close()));
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

    it("projects the binding fields (docs/plan/chat-binding.md) as list fields: string ids only, and bindingReview as either boolean", () => {
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
        // Stored as sent (D2): the summary does not trim or drop a blank string; the resolver reads it as unset.
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

    it("projects the translation settings (docs/plan/translation.md slice 2.1) as list fields: typed values only, false and 0 kept, nothing defaulted; a meta op moves them", () => {
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
