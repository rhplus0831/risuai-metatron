// @vitest-environment node
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import type { ChatOp, ChatRecord } from "../../../shared/chats.ts";
import type { MessageTranslation } from "../../../shared/database.ts";
import type { BatchConflict } from "../../../shared/resources.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { storedTranslation } from "../../../shared/translation/messageTranslation.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { CHAT_TABLES_SQL, MAX_CHAT_GROUP_IDS, MAX_GENERATION_HISTORY } from "../data/chatStore.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    createResourceStore,
    nextRevision,
    ResourceBatchConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;
/**
 * The kinds the store materializes: their `main` rows exist in every store from the start
 * (they take the first seqs), so the row checks below look only at the rows the tests wrote.
 */
const materialized = new Set(DEFAULT_RESOURCE_KINDS.filter((k) => k.materialize).map((k) => k.name));
const writtenRows = <T extends { kind: string }>(rows: readonly T[]) => rows.filter((r) => !materialized.has(r.kind));

const stores: ResourceStore[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function memoryStore() {
    const store = createResourceStore({ file: ":memory:", kinds });
    stores.push(store);
    return store;
}
function tempDir() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-chat-store-"));
    dirs.push(dir);
    return dir;
}
function fileStore(dir: string, name = "live.sqlite") {
    const store = createResourceStore({ file: path.join(dir, name), kinds });
    stores.push(store);
    return store;
}

const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const group = (chatId: string, baseRevision: string | null, ops: ChatOp[], characterId = "c") => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});
const order = (baseRevision: string, ids: string[], characterId = "c") => ({ characterId, baseRevision, ids });
const createCharacter = (id: string, extra: Record<string, unknown> = {}) => ({
    kind: characters,
    id,
    baseRevision: null,
    data: { chaId: id, ...extra },
});
/** The counter at the end of a token, and the same token `n` writes later. */
const counter = (token: string) => Number(token.slice(token.lastIndexOf(":") + 1));
const bumped = (token: string, n: number) => token.replace(/:\d+$/, `:${counter(token) + n}`);

function chat(store: ResourceStore, id: string, characterId = "c"): ChatRecord | null {
    const record = store.readRefs([], { chats: [{ characterId, id }] }).chats[0];
    return record.revision === null ? null : (record as ChatRecord);
}
const messageIds = (store: ResourceStore, id: string) => chat(store, id)!.data.message.map((x) => x.chatId as string);
const text = (store: ResourceStore, chatId: string, id: string) =>
    chat(store, chatId)!.data.message.find((x) => x.chatId === id)!.data;
const orderOf = (store: ResourceStore, characterId = "c") =>
    store.readRefs([], { chatCollections: [characterId] }).chatCollections[0].order;
/** Every stored state a test compares before and after a refused batch. */
const snapshotState = (store: ResourceStore) => JSON.stringify(store.readKinds([characters], { chats: true }));

function conflictsOf(fn: () => unknown): BatchConflict[] {
    let error: unknown;
    try {
        fn();
    } catch (e) {
        error = e;
    }
    expect(error).toBeInstanceOf(ResourceBatchConflictError);
    return (error as ResourceBatchConflictError).conflicts;
}
const rejects = (fn: () => unknown, message: string) => expect(fn).toThrow(new ResourceValidationError(message));

/** A character `c` with chat `k` holding messages a, b, c; returns the chat's token. */
function seed(store: ResourceStore) {
    const result = store.applyChanges({
        ops: [createCharacter("c")],
        chats: [
            group("k", null, [
                { op: "create", chat: { name: "K", message: [m("a", "A"), m("b", "B"), m("c", "C")] } as never },
            ]),
        ],
    });
    return {
        chat: result.chats[0].revision!,
        order: result.chatOrders[0].revision,
        character: result.results[0].revision!,
    };
}

describe("creating characters and chats", () => {
    it("creates a character with its initial chats and order in one batch, normalizing message ids", () => {
        const store = memoryStore();
        const before = store.writeCount();
        const result = store.applyChanges({
            ops: [createCharacter("c", { name: "C" })],
            chats: [
                group("k1", null, [
                    {
                        op: "create",
                        chat: {
                            id: "k1",
                            name: "Chat 1",
                            isStreaming: true,
                            message: [m("a", "hello"), { role: "char", data: "no id" } as never, m("a", "dup")],
                        } as never,
                    },
                    { op: "meta", set: { note: "first" } },
                ]),
                group("k0", null, [{ op: "create", chat: { name: "Chat 0" } as never, index: 0 }]),
                group("k9", null, [{ op: "create", chat: {} as never, index: 99 }]),
            ],
        });
        // Revision 1 of a new incarnation; the seq comes after the materialized rows.
        expect(result.results).toEqual([{ kind: "characters", id: "c", revision: expect.stringMatching(/:\d+:1$/) }]);
        expect(result.chats).toHaveLength(3);
        const [k1, k0, k9] = result.chats;
        expect(k1).toMatchObject({ characterId: "c", id: "k1", revision: expect.stringMatching(/:1:2$/) });
        expect(k1.messageIds).toHaveLength(3);
        expect(k1.messageIds![0]).toBe("a");
        expect(k1.messageIds![1]).toMatch(/^[0-9a-f-]{36}$/);
        expect(k1.messageIds![2]).toMatch(/^[0-9a-f-]{36}$/);
        expect(k1.checkpoints).toBeUndefined();
        expect(k0.revision).toMatch(/:2:1$/);
        expect(k9.revision).toMatch(/:3:1$/);
        // One order result, after all three creates: index 0 goes first, an index past the end goes last.
        expect(result.chatOrders).toEqual([
            { characterId: "c", revision: expect.stringMatching(/:1:4$/), ids: ["k0", "k1", "k9"] },
        ]);
        expect(store.writeCount()).toBe(before + 1 + 4);

        const read = store.readKinds([characters], { chats: true });
        expect(read.kinds.characters).toEqual([
            { id: "c", revision: result.results[0].revision, data: normalizeCharacter({ chaId: "c", name: "C" }) },
        ]);
        expect(read.chats!.map((c) => c.id)).toEqual(["k1", "k0", "k9"]);
        const stored = read.chats![0];
        expect(stored.revision).toBe(k1.revision);
        expect(stored.data).toEqual({
            id: "k1",
            name: "Chat 1",
            note: "first",
            localLore: [],
            fmIndex: -1,
            message: [
                m("a", "hello"),
                { role: "char", data: "no id", chatId: k1.messageIds![1] },
                { ...m("a", "dup"), chatId: k1.messageIds![2] },
            ],
        });
        expect(read.chats![1].data).toEqual({
            id: "k0",
            name: "Chat 0",
            note: "",
            localLore: [],
            fmIndex: -1,
            message: [],
        });
        expect(read.chatOrders).toEqual(result.chatOrders);
        // Without the flag the chat tables are not read.
        expect(store.readKinds([characters])).not.toHaveProperty("chats");
    });

    it("gives a character created with put an empty order, and refuses a chat under a missing or duplicate parent", () => {
        const store = memoryStore();
        store.put(characters, "c", { chaId: "c" }, null);
        expect(orderOf(store)).toEqual({ characterId: "c", revision: expect.stringMatching(/:1:1$/), ids: [] });
        expect(store.readRefs([], { chatCollections: ["c", "nobody"] }).chatCollections).toEqual([
            { characterId: "c", order: orderOf(store), chats: [] },
            { characterId: "nobody", order: null, chats: [] },
        ]);
        const before = store.writeCount();
        expect(
            conflictsOf(() =>
                store.applyChanges({ chats: [group("k", null, [{ op: "create", chat: {} as never }], "ghost")] }),
            ),
        ).toEqual([{ kind: "chat", characterId: "ghost", id: "k", revision: null }]);
        const created = store.applyChanges({ chats: [group("k", null, [{ op: "create", chat: {} as never }])] })
            .chats[0];
        expect(
            conflictsOf(() => store.applyChanges({ chats: [group("k", null, [{ op: "create", chat: {} as never }])] })),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: created.revision }]);
        // The same chat id under another character is a different chat.
        store.put(characters, "d", { chaId: "d" }, null);
        expect(
            store.applyChanges({ chats: [group("k", null, [{ op: "create", chat: {} as never }], "d")] }).chats[0]
                .revision,
        ).toMatch(/:2:1$/);
        // Two chat creates and the second character's put; the conflicts counted nothing.
        expect(store.writeCount()).toBe(before + 3);
        expect(chat(store, "missing")).toBeNull();
        expect(store.readRefs([], { chats: [{ characterId: "c", id: "missing" }] }).chats[0]).toEqual({
            characterId: "c",
            id: "missing",
            revision: null,
            data: null,
        });
    });
});

describe("atomicity and cascades", () => {
    it("applies resource ops, chat groups, and reorders as one unit: any conflict rolls everything back and every conflict is listed", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const before = snapshotState(store);
        const writes = store.writeCount();

        // A stale resource op: the valid chat edit and reorder are not written either.
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    ops: [
                        {
                            kind: characters,
                            id: "c",
                            baseRevision: bumped(tokens.character, 5),
                            data: { chaId: "c", name: "x" },
                        },
                    ],
                    chats: [group("k", tokens.chat, [{ op: "meta", set: { note: "n" } }])],
                    chatOrders: [order(tokens.order, ["k"])],
                }),
            ),
        ).toEqual([{ kind: "characters", id: "c", revision: tokens.character }]);
        expect(snapshotState(store)).toBe(before);
        expect(store.writeCount()).toBe(writes);

        // A stale chat delete: the valid character write is rolled back; the order and chat conflicts are all listed.
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    ops: [
                        { kind: characters, id: "c", baseRevision: tokens.character, data: { chaId: "c", name: "x" } },
                    ],
                    chats: [
                        group("k", bumped(tokens.chat, -1), [{ op: "delete" }]),
                        group("other", null, [{ op: "create", chat: {} as never }]),
                    ],
                    chatOrders: [order(bumped(tokens.order, 1), ["k"])],
                }),
            ),
        ).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: tokens.chat },
            { kind: "chatOrder", characterId: "c", revision: tokens.order },
        ]);
        expect(snapshotState(store)).toBe(before);
        expect(store.writeCount()).toBe(writes);
        expect(chat(store, "other")).toBeNull();

        // A validation failure inside the transaction (a meta value the normalizer refuses) rolls back too.
        rejects(
            () =>
                store.applyChanges({
                    ops: [
                        { kind: characters, id: "c", baseRevision: tokens.character, data: { chaId: "c", name: "x" } },
                    ],
                    chats: [
                        group("k", tokens.chat, [
                            { op: "meta", set: { note: "ok" } },
                            { op: "meta", set: { name: 5 } },
                        ]),
                    ],
                }),
            "chats[0].ops[1]: chat.name and chat.note must be strings",
        );
        expect(snapshotState(store)).toBe(before);
        expect(store.writeCount()).toBe(writes);

        // The same batch with current tokens lands, counting every applied op.
        const applied = store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: tokens.character, data: { chaId: "c", name: "x" } }],
            chats: [
                group("k", tokens.chat, [
                    { op: "meta", set: { note: "n" } },
                    { op: "remove", ids: ["a"] },
                ]),
                group("other", null, [{ op: "create", chat: {} as never }]),
            ],
            chatOrders: [order(tokens.order, ["other", "k"])],
        });
        expect(applied.results[0].revision).toBe(bumped(tokens.character, 1));
        expect(applied.chats.map((c) => [c.id, c.revision])).toEqual([
            ["k", bumped(tokens.chat, 2)],
            ["other", expect.stringMatching(/:2:1$/)],
        ]);
        // The create bumped the order once, the reorder once more.
        expect(applied.chatOrders).toEqual([
            { characterId: "c", revision: bumped(tokens.order, 2), ids: ["other", "k"] },
        ]);
        expect(store.writeCount()).toBe(writes + 1 + 3 + 1);
        expect(messageIds(store, "k")).toEqual(["b", "c"]);
    });

    it("deletes a character's chats, messages, and order with the character, through delete and through a batch", () => {
        const store = memoryStore();
        const tokens = seed(store);
        store.applyChanges({ chats: [group("k2", null, [{ op: "create", chat: { message: [m("x")] } as never }])] });
        store.put(characters, "d", { chaId: "d" }, null);
        const dChat = store.applyChanges({
            chats: [group("k", null, [{ op: "create", chat: { message: [m("y")] } as never }], "d")],
        });
        expect(store.readKinds([characters], { chats: true }).chats).toHaveLength(3);

        store.delete(characters, "c", tokens.character);
        const afterDelete = store.readKinds([characters], { chats: true });
        expect(afterDelete.chats!.map((c) => [c.characterId, c.id])).toEqual([["d", "k"]]);
        expect(afterDelete.chatOrders!.map((o) => o.characterId)).toEqual(["d"]);
        expect(orderOf(store)).toBeNull();
        expect(chat(store, "k", "d")!.data.message).toEqual([m("y")]);
        // The rows are gone from the file, not only from the reads.
        const dir = tempDir();
        const fs = fileStore(dir);
        const fsTokens = seed(fs);
        fs.applyBatch([{ kind: characters, id: "c", baseRevision: fsTokens.character, delete: true }]);
        expect(fs.readKinds([characters], { chats: true })).toEqual({
            epoch: fs.epoch(),
            kinds: { characters: [] },
            chats: [],
            chatOrders: [],
        });
        const db = new DatabaseSync(path.join(dir, "live.sqlite"));
        try {
            expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
            expect(db.prepare("SELECT COUNT(*) AS n FROM chats").get()).toEqual({ n: 0 });
            expect(db.prepare("SELECT COUNT(*) AS n FROM chatOrders").get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }

        // A stale character delete rolls its cascade back with it.
        const state = snapshotState(store);
        const dRevision = store.get(characters, "d")!.revision;
        expect(
            conflictsOf(() =>
                store.applyBatch([{ kind: characters, id: "d", baseRevision: bumped(dRevision, 1), delete: true }]),
            ),
        ).toEqual([{ kind: "characters", id: "d", revision: dRevision }]);
        expect(() => store.transaction(() => store.delete(characters, "d", bumped(dRevision, 1)))).toThrow();
        expect(snapshotState(store)).toBe(state);

        // A batch that deletes a character and also names its chats or order is malformed.
        rejects(
            () =>
                store.applyChanges({
                    ops: [{ kind: characters, id: "d", baseRevision: dRevision, delete: true }],
                    chats: [group("k", dChat.chats[0].revision, [{ op: "meta", set: { note: "x" } }], "d")],
                }),
            "the batch deletes character d and also changes its chats",
        );
        rejects(
            () =>
                store.applyChanges({
                    ops: [{ kind: characters, id: "d", baseRevision: dRevision, delete: true }],
                    chatOrders: [order(dChat.chatOrders[0].revision, ["k"], "d")],
                }),
            "the batch deletes character d and also changes its chats",
        );
        expect(snapshotState(store)).toBe(state);
    });
});

describe("revision rules", () => {
    it("applies by-id ops on a stale revision when the target exists, and needs the current one for delete, replace, and multi-id remove", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const stale = tokens.chat;
        // Another tab moves the chat on.
        let current = store.applyChanges({ chats: [group("k", stale, [{ op: "meta", set: { note: "tab 2" } }])] })
            .chats[0].revision!;
        expect(current).toBe(bumped(stale, 1));

        const tolerant = store.applyChanges({
            chats: [
                group("k", stale, [
                    { op: "meta", set: { name: "renamed" }, unset: ["note"] },
                    { op: "append", messages: [m("d", "D")], anchor: { end: true } },
                    { op: "setMessage", message: m("a", "A2", "char") },
                    { op: "setText", id: "b", text: "B2" },
                    { op: "remove", ids: ["c"] },
                ]),
            ],
        }).chats[0];
        expect(tolerant.revision).toBe(bumped(current, 5));
        current = tolerant.revision!;
        const record = chat(store, "k")!;
        expect(record.data).toMatchObject({ name: "renamed", note: "" });
        expect(record.data.message).toEqual([m("a", "A2", "char"), m("b", "B2"), m("d", "D")]);

        const writes = store.writeCount();
        const state = snapshotState(store);
        for (const ops of [
            [{ op: "delete" }],
            [{ op: "replace", chat: { message: [] } }],
            [{ op: "remove", ids: ["a", "b"] }],
            // A group mixing a tolerant op with a destructive one is judged as a whole.
            [
                { op: "meta", set: { note: "x" } },
                { op: "remove", ids: ["a", "b"] },
            ],
        ] as ChatOp[][]) {
            expect(
                conflictsOf(() => store.applyChanges({ chats: [group("k", stale, ops)] })),
                JSON.stringify(ops),
            ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: current }]);
        }
        // A begin of a gone message and an append after a gone anchor conflict even on a stale
        // revision, and roll back the group's earlier op with them.
        for (const ops of [
            [{ op: "begin", id: "c", generationId: "g" }],
            [{ op: "append", messages: [m("e")], anchor: { after: "c" } }],
            [
                { op: "meta", set: { note: "applied first" } },
                { op: "append", messages: [m("e")], anchor: { after: "c" } },
            ],
        ] as ChatOp[][]) {
            expect(
                conflictsOf(() => store.applyChanges({ chats: [group("k", stale, ops)] })),
                JSON.stringify(ops),
            ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: current }]);
        }
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // A setText or setMessage of a gone message changes nothing and is reported `missing`;
        // alone, it moves nothing.
        for (const ops of [
            [{ op: "setText", id: "c", text: "gone" }],
            [{ op: "setMessage", message: m("c") }],
        ] as ChatOp[][]) {
            expect(store.applyChanges({ chats: [group("k", stale, ops)] }).chats[0], JSON.stringify(ops)).toEqual({
                characterId: "c",
                id: "k",
                revision: current,
                stale: true,
                targets: ["missing"],
            });
        }
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // With another op in the group, that one commits.
        const partly = store.applyChanges({
            chats: [
                group("k", stale, [
                    { op: "meta", set: { note: "applied first" } },
                    { op: "setText", id: "c", text: "gone" },
                ]),
            ],
        }).chats[0];
        expect(partly).toEqual({
            characterId: "c",
            id: "k",
            revision: bumped(current, 1),
            stale: true,
            targets: ["missing"],
        });
        current = partly.revision!;
        expect(chat(store, "k")!.data).toMatchObject({ note: "applied first" });
        expect(messageIds(store, "k")).toEqual(["a", "b", "d"]);

        // With the current revision the destructive ops land.
        current = store.applyChanges({ chats: [group("k", current, [{ op: "remove", ids: ["a", "b"] }])] }).chats[0]
            .revision!;
        expect(messageIds(store, "k")).toEqual(["d"]);
        const replaced = store.applyChanges({
            chats: [
                group("k", current, [
                    { op: "replace", chat: { name: "R", message: [m("z", "Z"), m("z", "Z2")] } as never },
                ]),
            ],
        }).chats[0];
        expect(replaced.messageIds![0]).toBe("z");
        expect(replaced.messageIds![1]).toMatch(/^[0-9a-f-]{36}$/);
        expect(chat(store, "k")!.data).toEqual({
            id: "k",
            name: "R",
            note: "",
            localLore: [],
            fmIndex: -1,
            message: [m("z", "Z"), { ...m("z", "Z2"), chatId: replaced.messageIds![1] }],
        });
        const deleted = store.applyChanges({ chats: [group("k", replaced.revision!, [{ op: "delete" }])] });
        expect(deleted.chats).toEqual([{ characterId: "c", id: "k", revision: null }]);
        expect(deleted.chatOrders).toEqual([{ characterId: "c", revision: expect.any(String), ids: [] }]);
        expect(chat(store, "k")).toBeNull();
    });

    it("rejects tokens of another incarnation or epoch, even for stale-tolerant ops", () => {
        const store = memoryStore();
        const tokens = seed(store);
        store.applyChanges({ chats: [group("k", tokens.chat, [{ op: "delete" }])] });
        const recreated = store.applyChanges({
            chats: [group("k", null, [{ op: "create", chat: { message: [m("a")] } as never }])],
        }).chats[0].revision!;
        expect(recreated).toMatch(/:2:1$/);
        expect(tokens.chat).toMatch(/:1:1$/);
        const otherEpoch = recreated.replace(/^[0-9a-f-]{36}/, "00000000-0000-4000-8000-000000000000");
        for (const token of [tokens.chat, otherEpoch, "garbage", "", `${recreated}:1`]) {
            expect(
                conflictsOf(() =>
                    store.applyChanges({ chats: [group("k", token, [{ op: "setText", id: "a", text: "x" }])] }),
                ),
                token,
            ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: recreated }]);
        }
        expect(
            conflictsOf(() =>
                store.applyChanges({ chats: [group("gone", tokens.chat, [{ op: "setText", id: "a", text: "x" }])] }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "gone", revision: null }]);
        const orderToken = orderOf(store)!.revision;
        for (const token of [orderToken.replace(/^[0-9a-f-]{36}/, "00000000-0000-4000-8000-000000000000"), "x"]) {
            expect(
                conflictsOf(() => store.applyChanges({ chatOrders: [order(token, ["k"])] })),
                token,
            ).toEqual([{ kind: "chatOrder", characterId: "c", revision: orderToken }]);
        }
        expect(conflictsOf(() => store.applyChanges({ chatOrders: [order(orderToken, [], "nobody")] }))).toEqual([
            { kind: "chatOrder", characterId: "nobody", revision: null },
        ]);
    });

    it("checks a reorder against the pre-batch order revision and the post-batch membership, and reports committed revisions", () => {
        const store = memoryStore();
        const tokens = seed(store);
        // Create + reorder in one batch: the reorder names the pre-batch order and the new membership.
        const first = store.applyChanges({
            chats: [group("k2", null, [{ op: "create", chat: {} as never }])],
            chatOrders: [order(tokens.order, ["k2", "k"])],
        });
        expect(first.chatOrders).toEqual([{ characterId: "c", revision: bumped(tokens.order, 2), ids: ["k2", "k"] }]);
        const committed = first.chatOrders[0].revision;

        // A stale reorder with a tentative create: the conflict names the committed revision, and the
        // create is rolled back.
        const state = snapshotState(store);
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [group("k3", null, [{ op: "create", chat: {} as never }])],
                    chatOrders: [order(tokens.order, ["k3", "k2", "k"])],
                }),
            ),
        ).toEqual([{ kind: "chatOrder", characterId: "c", revision: committed }]);
        expect(snapshotState(store)).toBe(state);
        expect(chat(store, "k3")).toBeNull();

        // A stale delete with its dependent reorder is a 409 naming the chat, not a permutation error.
        const kRevision = chat(store, "k")!.revision;
        store.applyChanges({ chats: [group("k", kRevision, [{ op: "meta", set: { note: "moved on" } }])] });
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [group("k", kRevision, [{ op: "delete" }])],
                    chatOrders: [order(committed, ["k2"])],
                }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: bumped(kRevision, 1) }]);
        // The same with a stale resource op instead.
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    ops: [createCharacter("c")],
                    chatOrders: [order(committed, [])],
                }),
            ),
        ).toEqual([{ kind: "characters", id: "c", revision: tokens.character }]);
        // Without any conflict, a list that is not a permutation is a client error.
        for (const ids of [[], ["k"], ["k", "k2", "k3"], ["k", "k3"]]) {
            rejects(
                () => store.applyChanges({ chatOrders: [order(committed, ids)] }),
                "chatOrders for c: ids must be a permutation of the character's chats",
            );
        }
        expect(orderOf(store)).toEqual({ characterId: "c", revision: committed, ids: ["k2", "k"] });
        // A reorder alone advances the order once; two batches from the same base conflict on the second.
        const reordered = store.applyChanges({ chatOrders: [order(committed, ["k", "k2"])] });
        expect(reordered.chatOrders).toEqual([{ characterId: "c", revision: bumped(committed, 1), ids: ["k", "k2"] }]);
        expect(reordered.chats).toEqual([]);
        expect(conflictsOf(() => store.applyChanges({ chatOrders: [order(committed, ["k2", "k"])] }))).toEqual([
            { kind: "chatOrder", characterId: "c", revision: bumped(committed, 1) },
        ]);
    });
});

describe("patchMessage", () => {
    const patch = (id: string, fields: { set?: Record<string, unknown>; unset?: string[] }): ChatOp =>
        ({ op: "patchMessage", id, ...fields }) as ChatOp;
    const row = (store: ResourceStore, id: string) => chat(store, "k")!.data.message.find((x) => x.chatId === id)!;
    const tr = (source: string, text = "translated"): MessageTranslation => ({
        text,
        sourceHash: translationSourceHash(source),
        targetLanguage: "ko",
        translatedAt: 1,
    });

    it("two writers on one message: a patch on an older revision keeps the other tab's text and fields, while setMessage still replaces the whole row", () => {
        const store = memoryStore();
        const base = seed(store).chat;
        // Tab 1 edits the text; tab 2, still on the base, toggles Disable.
        const texted = store.applyChanges({ chats: [group("k", base, [{ op: "setText", id: "b", text: "B2" }])] })
            .chats[0].revision!;
        const disabled = store.applyChanges({ chats: [group("k", base, [patch("b", { set: { disabled: true } })])] })
            .chats[0];
        expect(disabled).toEqual({ characterId: "c", id: "k", revision: bumped(texted, 1), stale: true });
        expect(row(store, "b")).toEqual({ ...m("b", "B2"), disabled: true });
        // Tab 1, also behind now, patches another field: both tabs' fields stay.
        store.applyChanges({ chats: [group("k", base, [patch("b", { set: { saying: "s", name: "n" } })])] });
        expect(row(store, "b")).toEqual({ ...m("b", "B2"), disabled: true, saying: "s", name: "n" });
        // An unset removes only the named field; a set of role or data takes the message shape.
        store.applyChanges({
            chats: [group("k", base, [patch("b", { unset: ["disabled", "missing"], set: { role: "char" } })])],
        });
        expect(row(store, "b")).toEqual({ ...m("b", "B2", "char"), saying: "s", name: "n" });
        expect(messageIds(store, "k")).toEqual(["a", "b", "c"]);
        // The whole-row op on the same older base reverts what it has not seen (the documented trade-off).
        store.applyChanges({ chats: [group("k", base, [{ op: "setMessage", message: m("b", "B3") }])] });
        expect(row(store, "b")).toEqual(m("b", "B3"));

        // A patch whose target is gone changes nothing and is reported `missing`; the group's earlier
        // op commits.
        const current = chat(store, "k")!.revision!;
        store.applyChanges({ chats: [group("k", current, [{ op: "remove", ids: ["c"] }])] });
        const after = chat(store, "k")!.revision!;
        const gone = store.applyChanges({
            chats: [
                group("k", base, [
                    { op: "meta", merge: { scriptstate: { $x: "1" } } },
                    patch("c", { set: { disabled: true } }),
                ]),
            ],
        }).chats[0];
        expect(gone).toEqual({
            characterId: "c",
            id: "k",
            revision: bumped(after, 1),
            stale: true,
            targets: ["missing"],
        });
        expect((chat(store, "k")!.data as { scriptstate?: unknown }).scriptstate).toEqual({ $x: "1" });
        expect(messageIds(store, "k")).toEqual(["a", "b"]);
    });

    it("never changes a stored translation, closes an open generation fence, and applies whatever the stored row's key order", () => {
        const store = memoryStore();
        const base = seed(store).chat;
        const translation = tr("B");
        let revision = store.applyChanges({
            chats: [group("k", base, [{ op: "setTranslation", id: "b", translation }])],
        }).chats[0].revision!;
        // A translation in `set` or `unset` is ignored: the stored one stays, whatever the patch carries.
        store.applyChanges({
            chats: [group("k", revision, [patch("b", { set: { translation: tr("B", "other"), disabled: true } })])],
        });
        expect(row(store, "b")).toEqual({ ...m("b", "B"), translation, disabled: true });
        store.applyChanges({
            chats: [group("k", revision, [patch("b", { unset: ["translation", "disabled"], set: { name: "n" } })])],
        });
        expect(row(store, "b")).toEqual({ ...m("b", "B"), translation, name: "n" });
        // A patch of the text leaves the translation to go stale by hash, as setText does.
        store.applyChanges({ chats: [group("k", revision, [patch("b", { set: { data: "B!" } })])] });
        expect(row(store, "b")).toEqual({ ...m("b", "B!"), translation, name: "n" });
        expect(storedTranslation(row(store, "b"))).toBeNull();

        // An open generation on `a`: the patch is a manual write, so the fence closes and the
        // generation's later checkpoint is ignored, while the patched field and the streamed text stay.
        revision = chat(store, "k")!.revision!;
        revision = store.applyChanges({
            chats: [
                group("k", revision, [
                    { op: "begin", id: "a", generationId: "g1" },
                    { op: "setText", id: "a", text: "partial", generation: { id: "g1", seq: 1 } },
                ]),
            ],
        }).chats[0].revision!;
        const patched = store.applyChanges({ chats: [group("k", revision, [patch("a", { set: { disabled: true } })])] })
            .chats[0];
        expect(patched).toEqual({ characterId: "c", id: "k", revision: bumped(revision, 1) });
        const late = store.applyChanges({
            chats: [
                group("k", patched.revision!, [
                    { op: "setText", id: "a", text: "late chunk", generation: { id: "g1", seq: 2, final: true } },
                ]),
            ],
        }).chats[0];
        expect(late.checkpoints).toEqual(["ignored"]);
        expect(row(store, "a")).toEqual({ ...m("a", "partial"), disabled: true });
        // A new generation on the current revision takes the message over again after the patch.
        const next = store.applyChanges({
            chats: [
                group("k", late.revision!, [
                    { op: "begin", id: "a", generationId: "g2" },
                    { op: "setText", id: "a", text: "two", generation: { id: "g2", seq: 1 } },
                ]),
            ],
        }).chats[0];
        expect(next.checkpoints).toEqual(["applied"]);
        expect(row(store, "a")).toEqual({ ...m("a", "two"), disabled: true });
    });

    it("is refused as generating on a message a job owns, unless it carries the owner's token, and applies to the chat's other messages", () => {
        const lock = createGenerationLock();
        const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
        stores.push(store);
        const base = seed(store).chat;
        const token = "token-1";
        lock.addToken(token);
        lock.acquire({ characterId: "c", chatId: "k", messageId: "b" }, { jobId: "J1", generationId: "g1", token });
        const state = snapshotState(store);
        const writes = store.writeCount();
        expect(
            conflictsOf(() =>
                store.applyChanges({ chats: [group("k", base, [patch("b", { set: { disabled: true } })])] }),
            ),
        ).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: base, reason: "generating", messageIds: ["b"] },
        ]);
        // Generating is answered before a stale-revision conflict and with nothing written. The entry
        // names only the targeted messages a job owns, not the free ones.
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [group("k", base, [{ op: "remove", ids: ["a", "c"] }, patch("b", { unset: ["name"] })])],
                }),
            ),
        ).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: base, reason: "generating", messageIds: ["b"] },
        ]);
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // Another message of the chat is open to a patch.
        const other = store.applyChanges({ chats: [group("k", base, [patch("a", { set: { disabled: true } })])] })
            .chats[0];
        expect(other.revision).toBe(bumped(base, 1));
        expect(row(store, "a")).toEqual({ ...m("a", "A"), disabled: true });
        // The owner's in-process write passes with its token.
        const own = store.applyChanges(
            { chats: [group("k", other.revision!, [patch("b", { set: { saying: "owner" } })])] },
            { epoch: store.epoch(), jobToken: token },
        ).chats[0];
        expect(own.revision).toBe(bumped(base, 2));
        expect(row(store, "b")).toEqual({ ...m("b", "B"), saying: "owner" });
    });

    it("publishes a field-only patch as the stored row from the actual base, and a patch that changes nothing as a count-only patch", () => {
        const feed = createChangeFeed();
        const store = createResourceStore({ file: ":memory:", kinds, feed });
        stores.push(store);
        const events: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
        feed.subscribe((event) => {
            if (event.type === "change") events.push(event);
        });
        const base = seed(store).chat;
        const storedBase = store.applyChanges({ chats: [group("k", base, [{ op: "setText", id: "b", text: "B2" }])] })
            .chats[0].revision!;
        const patched = store.applyChanges({
            chats: [group("k", base, [patch("b", { set: { disabled: true }, unset: ["name"] })])],
        }).chats[0];
        expect(events.at(-1)!.changes.chats).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: patched.revision,
                patch: {
                    baseRevision: storedBase,
                    count: 3,
                    messages: [{ after: "a", message: { ...m("b", "B2"), disabled: true } }],
                },
            },
        ]);
        // The same value again: the revision moves (an applied op), the row is not republished.
        const same = store.applyChanges({ chats: [group("k", base, [patch("b", { set: { disabled: true } })])] })
            .chats[0];
        expect(same.revision).toBe(bumped(patched.revision!, 1));
        expect(events.at(-1)!.changes.chats).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: same.revision,
                patch: { baseRevision: patched.revision, count: 3 },
            },
        ]);
    });
});

describe("message positions", () => {
    it("inserts at the start, after a message, and at the end, keeps several inserted messages in order, and agrees with an array model", () => {
        const store = memoryStore();
        let revision = seed(store).chat;
        const apply = (ops: ChatOp[]) => {
            revision = store.applyChanges({ chats: [group("k", revision, ops)] }).chats[0].revision!;
        };
        apply([
            { op: "append", messages: [m("s1"), m("s2")], anchor: { start: true } },
            { op: "append", messages: [m("a1"), m("a2")], anchor: { after: "a" } },
            { op: "append", messages: [m("e1"), m("e2")], anchor: { end: true } },
        ]);
        expect(messageIds(store, "k")).toEqual(["s1", "s2", "a", "a1", "a2", "b", "c", "e1", "e2"]);
        apply([{ op: "remove", ids: ["a1", "b"] }]);
        // Gaps left by removals do not disturb later inserts around them.
        apply([
            { op: "append", messages: [m("x")], anchor: { after: "a" } },
            { op: "append", messages: [m("y")], anchor: { after: "a2" } },
        ]);
        expect(messageIds(store, "k")).toEqual(["s1", "s2", "a", "x", "a2", "y", "c", "e1", "e2"]);
        // An empty chat takes start and end inserts alike.
        const empty = store.applyChanges({ chats: [group("e", null, [{ op: "create", chat: {} as never }])] }).chats[0]
            .revision!;
        store.applyChanges({
            chats: [
                group("e", empty, [
                    { op: "append", messages: [m("q")], anchor: { end: true } },
                    { op: "append", messages: [m("p")], anchor: { start: true } },
                ]),
            ],
        });
        expect(messageIds(store, "e")).toEqual(["p", "q"]);

        // Deterministic pseudo-random inserts and removes against an array model.
        const model = messageIds(store, "k");
        let seed32 = 34857;
        const rand = (n: number) => {
            seed32 = (Math.imul(seed32, 1664525) + 1013904223) >>> 0;
            return seed32 % n;
        };
        for (let i = 0; i < 300; i++) {
            let op: ChatOp;
            if (model.length > 0 && rand(4) === 0) {
                const index = rand(model.length);
                op = { op: "remove", ids: [model[index]] };
                model.splice(index, 1);
            } else {
                const index = rand(model.length + 1);
                const id = `r${i}`;
                op = {
                    op: "append",
                    messages: [m(id)],
                    anchor:
                        index === 0
                            ? { start: true }
                            : index === model.length
                              ? { end: true }
                              : { after: model[index - 1] },
                };
                model.splice(index, 0, id);
            }
            apply([op]);
            expect(messageIds(store, "k")).toEqual(model);
        }
    });

    it("refuses an append without pre-assigned unique ids, before any write", () => {
        const store = memoryStore();
        const revision = seed(store).chat;
        rejects(
            () =>
                store.applyChanges({
                    chats: [
                        group("k", revision, [
                            { op: "append", messages: [{ role: "user", data: "x" } as never], anchor: { end: true } },
                        ]),
                    ],
                }),
            "chats[0].ops[0]: message.chatId must be a valid id",
        );
        rejects(
            () =>
                store.applyChanges({
                    chats: [
                        group("k", revision, [{ op: "append", messages: [m("n"), m("n")], anchor: { end: true } }]),
                    ],
                }),
            "chats[0].ops[0]: append.messages has duplicate ids",
        );
        expect(chat(store, "k")!.revision).toBe(revision);
    });
});

describe("idempotent replay", () => {
    it("replays an immutable batch: appends and single removes are no-ops, edits are idempotent, and destructive ops conflict", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const appendBatch = {
            chats: [
                group("k", tokens.chat, [
                    { op: "append", messages: [m("d", "D"), m("e", "E")], anchor: { after: "b" } },
                ] as ChatOp[]),
            ],
        };
        const first = store.applyChanges(appendBatch).chats[0].revision!;
        expect(first).toBe(bumped(tokens.chat, 1));
        const writes = store.writeCount();
        const state = snapshotState(store);
        // The exact replay: identical messages already there, nothing changes, nothing is counted.
        expect(store.applyChanges(appendBatch).chats[0].revision).toBe(first);
        expect(store.writeCount()).toBe(writes);
        expect(snapshotState(store)).toBe(state);
        // Partly landed: the missing one is inserted at the anchor, the present one is skipped.
        const partial = store.applyChanges({
            chats: [
                group("k", tokens.chat, [
                    { op: "append", messages: [m("d", "D"), m("f", "F")], anchor: { after: "b" } },
                ]),
            ],
        }).chats[0].revision!;
        expect(partial).toBe(bumped(first, 1));
        expect(messageIds(store, "k")).toEqual(["a", "b", "f", "d", "e", "c"]);
        // Different content under an existing id is a conflict.
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [
                        group("k", tokens.chat, [
                            { op: "append", messages: [m("d", "changed")], anchor: { end: true } },
                        ]),
                    ],
                }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: partial }]);

        // A single missing remove is a no-op; the same remove of several ids conflicts.
        const removeBatch = { chats: [group("k", tokens.chat, [{ op: "remove", ids: ["f"] }] as ChatOp[])] };
        const removed = store.applyChanges(removeBatch).chats[0].revision!;
        expect(removed).toBe(bumped(partial, 1));
        expect(store.applyChanges(removeBatch).chats[0].revision).toBe(removed);
        expect(store.writeCount()).toBe(writes + 2);
        expect(
            conflictsOf(() =>
                store.applyChanges({ chats: [group("k", removed, [{ op: "remove", ids: ["f", "e"] }])] }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: removed }]);

        // Edits replay to the same content.
        const editBatch = {
            chats: [
                group("k", tokens.chat, [
                    { op: "meta", set: { note: "n" }, unset: ["name"] },
                    { op: "setText", id: "a", text: "A2" },
                    { op: "setMessage", message: m("b", "B2") },
                ] as ChatOp[]),
            ],
        };
        const edited = store.applyChanges(editBatch).chats[0].revision!;
        const content = JSON.stringify(chat(store, "k")!.data);
        expect(store.applyChanges(editBatch).chats[0].revision).toBe(bumped(edited, 3));
        expect(JSON.stringify(chat(store, "k")!.data)).toBe(content);

        // Create, delete, replace, and reorder replays conflict, so the client reads back and compares.
        const createBatch = {
            chats: [group("n", null, [{ op: "create", chat: { message: [m("x")] } as never }] as ChatOp[])],
        };
        const created = store.applyChanges(createBatch);
        expect(conflictsOf(() => store.applyChanges(createBatch))).toEqual([
            { kind: "chat", characterId: "c", id: "n", revision: created.chats[0].revision },
        ]);
        const orderBatch = { chatOrders: [order(created.chatOrders[0].revision, ["n", "k"])] };
        const reordered = store.applyChanges(orderBatch);
        expect(conflictsOf(() => store.applyChanges(orderBatch))).toEqual([
            { kind: "chatOrder", characterId: "c", revision: reordered.chatOrders[0].revision },
        ]);
        const replaceBatch = {
            chats: [
                group("n", created.chats[0].revision, [
                    { op: "replace", chat: { message: [m("x")] } as never },
                ] as ChatOp[]),
            ],
        };
        const replaced = store.applyChanges(replaceBatch).chats[0].revision;
        expect(conflictsOf(() => store.applyChanges(replaceBatch))).toEqual([
            { kind: "chat", characterId: "c", id: "n", revision: replaced },
        ]);
        const deleteBatch = { chats: [group("n", replaced, [{ op: "delete" }] as ChatOp[])] };
        store.applyChanges(deleteBatch);
        expect(conflictsOf(() => store.applyChanges(deleteBatch))).toEqual([
            { kind: "chat", characterId: "c", id: "n", revision: null },
        ]);
    });
});

describe("generation fence", () => {
    const begin = (id: string, generationId: string): ChatOp => ({ op: "begin", id, generationId });
    const checkpoint = (id: string, generationId: string, seq: number, text: string, final = false): ChatOp => ({
        op: "setText",
        id,
        text,
        generation: { id: generationId, seq, final },
    });

    it("admits increasing checkpoints of the current open generation only, closes on final, and never counts an ignored one", () => {
        const store = memoryStore();
        const tokens = seed(store);
        // The reply row is appended and its generation begun in one group, on a stale revision.
        store.applyChanges({ chats: [group("k", tokens.chat, [{ op: "meta", set: { note: "other tab" } }])] });
        const started = store.applyChanges({
            chats: [
                group("k", tokens.chat, [
                    { op: "append", messages: [m("r", "", "char")], anchor: { end: true } },
                    begin("r", "g1"),
                    checkpoint("r", "g1", 1, "one"),
                ]),
            ],
        }).chats[0];
        expect(started.checkpoints).toEqual(["applied"]);
        expect(started.revision).toBe(bumped(tokens.chat, 4));
        let revision = started.revision!;
        const writes = store.writeCount();

        const mixed = store.applyChanges({
            chats: [
                group("k", tokens.chat, [
                    checkpoint("r", "g1", 1, "late duplicate"),
                    checkpoint("r", "g0", 99, "other generation"),
                    checkpoint("r", "g1", 3, "three"),
                    checkpoint("r", "g1", 2, "two arrives late"),
                    {
                        op: "setMessage",
                        message: m("r", "five", "char"),
                        generation: { id: "g1", seq: 5, final: true },
                    },
                    checkpoint("r", "g1", 6, "after final"),
                    checkpoint("r", "g1", 7, "after final too", true),
                ]),
            ],
        }).chats[0];
        // A replay of the current generation (seq not higher) is a duplicate: the generation still
        // owns the message. Another generation's write, or one after the final, is ignored.
        expect(mixed.checkpoints).toEqual([
            "duplicate",
            "ignored",
            "applied",
            "duplicate",
            "applied",
            "ignored",
            "ignored",
        ]);
        expect(mixed.revision).toBe(bumped(revision, 2));
        expect(store.writeCount()).toBe(writes + 2);
        expect(text(store, "k", "r")).toBe("five");
        revision = mixed.revision!;
        // Nothing but ignored checkpoints: no revision change, no write counted.
        const state = snapshotState(store);
        const ignored = store.applyChanges({
            chats: [group("k", revision, [checkpoint("r", "g1", 8, "x"), begin("r", "g1")])],
        }).chats[0];
        expect(ignored).toEqual({ characterId: "c", id: "k", revision, checkpoints: ["ignored"] });
        expect(store.writeCount()).toBe(writes + 2);
        expect(snapshotState(store)).toBe(state);
        // A checkpoint for a message without a fence is ignored too.
        expect(
            store.applyChanges({ chats: [group("k", revision, [checkpoint("a", "g1", 1, "x")])] }).chats[0].checkpoints,
        ).toEqual(["ignored"]);
    });

    it("lets a manual write close an open fence, a new generation take over on the current revision, and replays of known generations change nothing", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const original = tokens.chat;
        const firstBatch = { chats: [group("k", original, [begin("a", "g1"), checkpoint("a", "g1", 1, "partial")])] };
        let revision = store.applyChanges(firstBatch).chats[0].revision!;
        // Manual edits close the fence: the generation's later checkpoints are ignored.
        revision = store.applyChanges({ chats: [group("k", revision, [{ op: "setText", id: "a", text: "manual" }])] })
            .chats[0].revision!;
        let r = store.applyChanges({ chats: [group("k", revision, [checkpoint("a", "g1", 2, "late chunk")])] })
            .chats[0];
        expect(r.checkpoints).toEqual(["ignored"]);
        expect(text(store, "k", "a")).toBe("manual");
        // The replayed original batch does not reopen it: the begin is a known generation, and its
        // checkpoint (seq not higher than the closed fence's) is a duplicate. The group named an
        // older revision, so the result says so.
        r = store.applyChanges(firstBatch).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision, checkpoints: ["duplicate"], stale: true });
        expect(text(store, "k", "a")).toBe("manual");

        // A new generation on an existing message needs the current revision (continue); at a stale one it conflicts.
        const state = snapshotState(store);
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [group("k", original, [begin("a", "g2"), checkpoint("a", "g2", 1, "x")])],
                }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision }]);
        expect(snapshotState(store)).toBe(state);
        // Current is judged before the group's own earlier ops advance the chat.
        r = store.applyChanges({
            chats: [
                group("k", revision, [
                    { op: "meta", set: { note: "n" } },
                    begin("a", "g2"),
                    checkpoint("a", "g2", 1, "two"),
                ]),
            ],
        }).chats[0];
        expect(r.checkpoints).toEqual(["applied"]);
        revision = r.revision!;
        // A takeover from an open generation (a tab that died mid-stream) works on the current revision.
        r = store.applyChanges({ chats: [group("k", revision, [begin("a", "g3"), checkpoint("a", "g3", 1, "three")])] })
            .chats[0];
        expect(r.checkpoints).toEqual(["applied"]);
        revision = r.revision!;
        // The displaced generation is remembered: its begin and checkpoints are ignored at any revision.
        const writes = store.writeCount();
        r = store.applyChanges({
            chats: [
                group("k", original, [
                    begin("a", "g2"),
                    checkpoint("a", "g2", 50, "obsolete"),
                    begin("a", "g1"),
                    checkpoint("a", "g1", 9, "older"),
                ]),
            ],
        }).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision, checkpoints: ["ignored", "ignored"], stale: true });
        expect(store.writeCount()).toBe(writes);
        expect(text(store, "k", "a")).toBe("three");
        // A manual setMessage closes the fence as well.
        revision = store.applyChanges({
            chats: [group("k", revision, [{ op: "setMessage", message: m("a", "full") }])],
        }).chats[0].revision!;
        expect(
            store.applyChanges({ chats: [group("k", original, [checkpoint("a", "g3", 2, "late")])] }).chats[0]
                .checkpoints,
        ).toEqual(["ignored"]);
        expect(text(store, "k", "a")).toBe("full");
    });

    it("remembers at most eight earlier generations; a forgotten one cannot reopen from a stale replay", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const original = tokens.chat;
        const firstBatch = { chats: [group("k", original, [begin("a", "g0"), checkpoint("a", "g0", 1, "OLD G0")])] };
        store.applyChanges(firstBatch);
        let revision = store.applyChanges({
            chats: [group("k", original, [checkpoint("a", "g0", 10, "FINAL 0", true)])],
        }).chats[0].revision!;
        for (let i = 1; i <= MAX_GENERATION_HISTORY + 1; i++) {
            revision = store.applyChanges({
                chats: [group("k", revision, [begin("a", `g${i}`), checkpoint("a", `g${i}`, 10, `FINAL ${i}`, true)])],
            }).chats[0].revision!;
        }
        // g1 is still remembered: a replay is a no-op. g0 is evicted: its stale replay conflicts.
        expect(
            store.applyChanges({ chats: [group("k", original, [begin("a", "g1"), checkpoint("a", "g1", 20, "x")])] })
                .chats[0].checkpoints,
        ).toEqual(["ignored"]);
        expect(conflictsOf(() => store.applyChanges(firstBatch))).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision },
        ]);
        expect(text(store, "k", "a")).toBe(`FINAL ${MAX_GENERATION_HISTORY + 1}`);
    });

    it("keeps the fences of messages surviving a replace, closed, and only lets a message inserted by the same group begin on a stale revision", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const original = tokens.chat;
        const firstBatch = { chats: [group("k", original, [begin("a", "g"), checkpoint("a", "g", 1, "OLD PARTIAL")])] };
        let revision = store.applyChanges(firstBatch).chats[0].revision!;
        revision = store.applyChanges({ chats: [group("k", revision, [checkpoint("a", "g", 10, "FINAL", true)])] })
            .chats[0].revision!;
        // A whole-chat replacement that keeps the message ids (a survivor reorder).
        const data = chat(store, "k")!.data;
        const replaced = store.applyChanges({
            chats: [
                group("k", revision, [
                    {
                        op: "replace",
                        chat: { ...data, message: [...data.message].reverse().concat(m("n", "", "char")) } as never,
                    },
                    begin("n", "gn"),
                    checkpoint("n", "gn", 1, "new"),
                ]),
            ],
        }).chats[0];
        expect(replaced.checkpoints).toEqual(["applied"]);
        revision = replaced.revision!;
        expect(messageIds(store, "k")).toEqual(["c", "b", "a", "n"]);
        // The replayed original batch is still recognized: its checkpoint is a duplicate of the
        // closed generation's, applied on an older revision.
        let r = store.applyChanges(firstBatch).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision, checkpoints: ["duplicate"], stale: true });
        expect(text(store, "k", "a")).toBe("FINAL");
        // The replace closed the new message's open fence too: its late chunk is ignored.
        r = store.applyChanges({
            chats: [group("k", revision, [{ op: "replace", chat: chat(store, "k")!.data as never }])],
        }).chats[0];
        revision = r.revision!;
        expect(
            store.applyChanges({ chats: [group("k", revision, [checkpoint("n", "gn", 2, "late")])] }).chats[0]
                .checkpoints,
        ).toEqual(["ignored"]);

        // Same-group insertion: a stale append + begin on the new message is fine, a stale begin on an
        // existing message is not, and re-appending an existing message does not make it "inserted".
        const state = snapshotState(store);
        r = store.applyChanges({
            chats: [
                group("k", original, [
                    { op: "append", messages: [m("f", "", "char")], anchor: { end: true } },
                    begin("f", "gf"),
                    checkpoint("f", "gf", 1, "fresh"),
                ]),
            ],
        }).chats[0];
        expect(r.checkpoints).toEqual(["applied"]);
        revision = r.revision!;
        const writes = store.writeCount();
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [
                        group("k", original, [
                            { op: "append", messages: [m("f", "", "char")], anchor: { end: true } },
                            begin("f", "gf2"),
                        ]),
                    ],
                }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision }]);
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [
                        group("k", original, [
                            { op: "append", messages: [m("h", "", "char")], anchor: { end: true } },
                            begin("a", "ga"),
                        ]),
                    ],
                }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision }]);
        expect(store.writeCount()).toBe(writes);
        expect(snapshotState(store)).not.toBe(state);
        expect(chat(store, "k")!.revision).toBe(revision);
        // Create + begin + checkpoint with a null base.
        const created = store.applyChanges({
            chats: [
                group("k2", null, [
                    { op: "create", chat: { message: [m("x", "", "char")] } as never },
                    begin("x", "gx"),
                    checkpoint("x", "gx", 1, "created"),
                ]),
            ],
        }).chats[0];
        expect(created.checkpoints).toEqual(["applied"]);
        expect(created.revision).toMatch(/:2:3$/);
    });
});

describe("revision counters", () => {
    it("nextRevision refuses to pass the safe-integer limit", () => {
        expect(nextRevision(0, 1)).toBe(1);
        expect(nextRevision(5, 0)).toBe(5);
        expect(nextRevision(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
        rejects(() => nextRevision(Number.MAX_SAFE_INTEGER, 1), "Revision counter exhausted");
        rejects(() => nextRevision(Number.MAX_SAFE_INTEGER - 1, 2), "Revision counter exhausted");
    });

    it("refuses a write that would overflow a restored chat, order, or resource counter, rolling back, and keeps reading", async () => {
        const dir = tempDir();
        const store = fileStore(dir);
        const tokens = seed(store);
        store.applyChanges({ chats: [group("k2", null, [{ op: "create", chat: {} as never }])] });
        await store.backupTo(path.join(dir, "snapshot.sqlite"));
        const limit = String(Number.MAX_SAFE_INTEGER);
        const db = new DatabaseSync(path.join(dir, "snapshot.sqlite"));
        db.exec(
            `UPDATE chats SET revision = ${limit} WHERE id = 'k'; UPDATE chatOrders SET revision = ${limit}; UPDATE resources SET revision = ${limit};`,
        );
        db.close();
        store.replaceAll(store.readSnapshot(path.join(dir, "snapshot.sqlite")));
        const state = snapshotState(store);
        const writes = store.writeCount();
        const k = chat(store, "k")!.revision;
        const k2 = chat(store, "k2")!.revision;
        const orderToken = orderOf(store)!.revision;
        const character = store.get(characters, "c")!.revision;
        expect(counter(k)).toBe(Number.MAX_SAFE_INTEGER);
        expect(counter(orderToken)).toBe(Number.MAX_SAFE_INTEGER);
        expect(counter(character)).toBe(Number.MAX_SAFE_INTEGER);
        expect(tokens.chat).not.toBe(k);

        const exhausted = "Revision counter exhausted";
        // The chat counter, alone and beside an otherwise valid op (an error while a group applies
        // names the group and op, so the client quarantines that chat only).
        rejects(
            () => store.applyChanges({ chats: [group("k", k, [{ op: "meta", set: { note: "edit" } }])] }),
            `chats[0].ops[0]: ${exhausted}`,
        );
        rejects(
            () =>
                store.applyChanges({
                    chats: [
                        group("k2", k2, [{ op: "meta", set: { note: "fine" } }]),
                        group("k", k, [{ op: "setText", id: "a", text: "x" }]),
                    ],
                }),
            `chats[1].ops[0]: ${exhausted}`,
        );
        // A group of ignored checkpoints alone does not touch the counter.
        expect(
            store.applyChanges({
                chats: [group("k", k, [{ op: "setText", id: "a", text: "x", generation: { id: "g", seq: 1 } }])],
            }).chats[0].revision,
        ).toBe(k);
        // The order counter: a chat create, a chat delete, and a reorder all bump it (the first two
        // fail inside a group's op, the reorder outside any group).
        rejects(
            () => store.applyChanges({ chats: [group("k3", null, [{ op: "create", chat: {} as never }])] }),
            `chats[0].ops[0]: ${exhausted}`,
        );
        rejects(
            () => store.applyChanges({ chats: [group("k2", k2, [{ op: "delete" }])] }),
            `chats[0].ops[0]: ${exhausted}`,
        );
        rejects(() => store.applyChanges({ chatOrders: [order(orderToken, ["k2", "k"])] }), exhausted);
        // The resource counter, through put and through a batch.
        rejects(() => store.put(characters, "c", { chaId: "c", name: "x" }, character), exhausted);
        rejects(
            () =>
                store.applyBatch([
                    { kind: characters, id: "c", baseRevision: character, data: { chaId: "c", name: "x" } },
                ]),
            exhausted,
        );
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // Everything still reads, including through a reopen.
        store.close();
        const reopened = fileStore(dir);
        expect(reopened.readKinds([characters], { chats: true }).chats!.map((c) => c.id)).toEqual(["k", "k2"]);
        // A counter below the limit still moves: the new chat's own counter starts at 0.
        expect(
            reopened.applyChanges({ chats: [group("k2", k2, [{ op: "meta", set: { note: "ok" } }])] }).chats[0]
                .revision,
        ).toBe(bumped(k2, 1));
    });
});

describe("snapshots", () => {
    /** A live store with a character, two chats (one fenced), and a second character; returns a snapshot path. */
    async function snapshotOf(dir: string, store: ResourceStore, name = "snapshot.sqlite") {
        const file = path.join(dir, name);
        await store.backupTo(file);
        return file;
    }
    function tamper(
        file: string,
        sql: string,
        name = `${path.basename(file, ".sqlite")}-${Math.random().toString(36).slice(2)}.sqlite`,
    ) {
        const copy = path.join(path.dirname(file), name);
        copyFileSync(file, copy);
        // Crafting may break the messages -> chats reference on purpose.
        const db = new DatabaseSync(copy, { enableForeignKeyConstraints: false });
        try {
            db.exec(sql);
        } finally {
            db.close();
        }
        return copy;
    }
    function populate(store: ResourceStore) {
        const tokens = seed(store);
        store.applyChanges({
            chats: [
                group("k", tokens.chat, [
                    { op: "begin", id: "b", generationId: "g1" },
                    { op: "setText", id: "b", text: "one", generation: { id: "g1", seq: 1 } },
                ]),
                group("k2", null, [{ op: "create", chat: { name: "Two", message: [m("x", "X")] } as never, index: 0 }]),
            ],
        });
        // A second, closed generation with history on `a`, and a fenced message in the other chat.
        const k = chat(store, "k")!.revision;
        store.applyChanges({
            chats: [
                group("k", k, [
                    { op: "begin", id: "a", generationId: "ga1" },
                    { op: "setText", id: "a", text: "a1", generation: { id: "ga1", seq: 1, final: true } },
                    { op: "begin", id: "a", generationId: "ga2" },
                    { op: "setText", id: "a", text: "a2", generation: { id: "ga2", seq: 2 } },
                ]),
            ],
        });
        store.put(characters, "d", { chaId: "d" }, null);
        return tokens;
    }

    it("reads back every chat table, validated and with positions compacted, and restores it under a new epoch with fences intact", async () => {
        const dir = tempDir();
        const store = fileStore(dir);
        populate(store);
        const file = await snapshotOf(dir, store);
        const validated = store.readSnapshot(file);
        expect(writtenRows(validated.rows).map((r) => `${r.kind}/${r.id}`)).toEqual(["characters/c", "characters/d"]);
        expect(validated.chats.map((c) => [c.seq, c.characterId, c.id, c.revision, c.schemaVersion])).toEqual([
            // k: the create, then two fence ops, then four more (`populate`).
            [1, "c", "k", 7, 1],
            [2, "c", "k2", 1, 1],
        ]);
        expect(JSON.parse(validated.chats[0].meta)).toEqual({
            name: "K",
            id: "k",
            note: "",
            localLore: [],
            fmIndex: -1,
        });
        expect(validated.messages).toEqual([
            {
                chatSeq: 1,
                id: "a",
                position: 0,
                data: JSON.stringify(m("a", "a2")),
                generationId: "ga2",
                generationSeq: 2,
                generationFinal: 0,
                generationHistory: '["ga1"]',
            },
            {
                chatSeq: 1,
                id: "b",
                position: 1,
                data: JSON.stringify(m("b", "one")),
                generationId: "g1",
                generationSeq: 1,
                generationFinal: 0,
                generationHistory: null,
            },
            {
                chatSeq: 1,
                id: "c",
                position: 2,
                data: JSON.stringify(m("c", "C")),
                generationId: null,
                generationSeq: null,
                generationFinal: null,
                generationHistory: null,
            },
            {
                chatSeq: 2,
                id: "x",
                position: 0,
                data: JSON.stringify(m("x", "X")),
                generationId: null,
                generationSeq: null,
                generationFinal: null,
                generationHistory: null,
            },
        ]);
        expect(validated.chatOrders).toEqual([
            { characterId: "c", revision: 3, ids: '["k2","k"]' },
            { characterId: "d", revision: 1, ids: "[]" },
        ]);

        // Change the live data, then restore: the snapshot's chats come back, the tokens carry the new epoch.
        const c = store.get(characters, "c")!.revision;
        store.delete(characters, "c", c);
        store.applyChanges({ chats: [group("n", null, [{ op: "create", chat: {} as never }], "d")] });
        const oldEpoch = store.epoch();
        const oldToken = chat(store, "n", "d")!.revision;
        const writes = store.writeCount();
        const epoch = store.replaceAll(validated);
        expect(epoch).not.toBe(oldEpoch);
        expect(store.writeCount()).toBe(writes + 1);
        const read = store.readKinds([characters], { chats: true });
        expect(
            read.chats!.map((x) => [x.characterId, x.id, x.data.message.map((y) => `${y.chatId}:${y.data}`)]),
        ).toEqual([
            ["c", "k", ["a:a2", "b:one", "c:C"]],
            ["c", "k2", ["x:X"]],
        ]);
        expect(read.chatOrders!.map((o) => [o.characterId, o.ids])).toEqual([
            ["c", ["k2", "k"]],
            ["d", []],
        ]);
        for (const token of [...read.chats!.map((x) => x.revision), ...read.chatOrders!.map((o) => o.revision)]) {
            expect(token.startsWith(`${epoch}:`)).toBe(true);
        }
        expect(chat(store, "n", "d")).toBeNull();
        // Old tokens are stale (the epoch differs), so is a create based on the old state.
        expect(
            conflictsOf(() =>
                store.applyChanges({ chats: [group("n", oldToken, [{ op: "meta", set: { note: "x" } }], "d")] }),
            ),
        ).toEqual([{ kind: "chat", characterId: "d", id: "n", revision: null }]);
        // The fences survived: open ones admit their next checkpoint, closed ones and history ignore.
        const k = chat(store, "k")!.revision;
        const r = store.applyChanges({
            chats: [
                group("k", k, [
                    { op: "setText", id: "b", text: "two", generation: { id: "g1", seq: 2 } },
                    { op: "setText", id: "a", text: "late", generation: { id: "ga1", seq: 9 } },
                    { op: "setText", id: "a", text: "a3", generation: { id: "ga2", seq: 3 } },
                    { op: "begin", id: "a", generationId: "ga1" },
                ]),
            ],
        }).chats[0];
        expect(r.checkpoints).toEqual(["applied", "ignored", "applied"]);
        expect(text(store, "k", "a")).toBe("a3");
        // Inserting after the restore keeps the order (positions were remapped with the chat seq).
        store.applyChanges({
            chats: [
                group("k", r.revision!, [
                    { op: "append", messages: [m("s")], anchor: { start: true } },
                    { op: "append", messages: [m("e")], anchor: { end: true } },
                ]),
            ],
        });
        expect(messageIds(store, "k")).toEqual(["s", "a", "b", "c", "e"]);
        expect(
            store.readSnapshot(await snapshotOf(dir, store, "after.sqlite")).messages.map((x) => x.position),
        ).toEqual([0, 1, 2, 3, 4, 0]);

        // A failing restore (a duplicate message id) rolls back every table, the epoch, and the write count.
        const state = snapshotState(store);
        const count = store.writeCount();
        expect(() =>
            store.replaceAll({ ...validated, messages: [...validated.messages, validated.messages[0]] }),
        ).toThrow("UNIQUE constraint failed");
        expect(store.epoch()).toBe(epoch);
        expect(store.writeCount()).toBe(count);
        expect(snapshotState(store)).toBe(state);
    });

    it("compacts crafted positions so inserts stay correct, and refuses a crafted order seq", async () => {
        const dir = tempDir();
        const store = fileStore(dir);
        populate(store);
        const file = await snapshotOf(dir, store);
        // Negative and huge positions, in the stored order, come back as 0..n-1.
        const crafted = tamper(
            file,
            "UPDATE messages SET position = position * 4000000000000000 - 5 WHERE chatSeq = 1",
        );
        const validated = store.readSnapshot(crafted);
        expect(validated.messages.map((x) => [x.id, x.position])).toEqual([
            ["a", 0],
            ["b", 1],
            ["c", 2],
            ["x", 0],
        ]);
        store.replaceAll(validated);
        expect(messageIds(store, "k")).toEqual(["a", "b", "c"]);
        const k = chat(store, "k")!.revision;
        store.applyChanges({
            chats: [
                group("k", k, [
                    { op: "append", messages: [m("s")], anchor: { start: true } },
                    { op: "append", messages: [m("e")], anchor: { end: true } },
                ]),
            ],
        });
        expect(messageIds(store, "k")).toEqual(["s", "a", "b", "c", "e"]);
        const again = await snapshotOf(dir, store, "again.sqlite");
        expect(store.readSnapshot(again).messages.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 0]);
        // A position at the limit is compacted too, so the next append cannot overflow.
        const atLimit = tamper(file, `UPDATE messages SET position = ${Number.MAX_SAFE_INTEGER} WHERE id = 'c'`);
        store.replaceAll(store.readSnapshot(atLimit));
        const k2 = chat(store, "k")!.revision;
        store.applyChanges({ chats: [group("k", k2, [{ op: "append", messages: [m("e")], anchor: { end: true } }])] });
        expect(messageIds(store, "k")).toEqual(["a", "b", "c", "e"]);
        const afterLimit = await snapshotOf(dir, store, "limit.sqlite");
        expect(store.readSnapshot(afterLimit).messages.map((x) => x.position)).toEqual([0, 1, 2, 3, 0]);

        // Order rows need a positive, unique seq (a non-integer seq needs a constraint-free table; see
        // the malformed-rows test).
        for (const seq of ["-1", "0"]) {
            rejects(
                () => store.readSnapshot(tamper(file, `UPDATE chatOrders SET seq = ${seq} WHERE characterId = 'c'`)),
                "chat order row 1: invalid seq or revision",
            );
        }
        rejects(
            () => store.readSnapshot(tamper(file, "UPDATE chatOrders SET revision = 0 WHERE characterId = 'd'")),
            "chat order row 2: invalid seq or revision",
        );
    });

    it("refuses malformed, orphaned, or misordered chat rows before anything is installed", async () => {
        const dir = tempDir();
        const store = fileStore(dir);
        populate(store);
        const file = await snapshotOf(dir, store);
        const limit = Number.MAX_SAFE_INTEGER + 2;
        const cases: [string, string, string][] = [
            [
                "chat of unknown character",
                "UPDATE chats SET characterId = 'ghost' WHERE id = 'k2'",
                "chat row 2: no such character",
            ],
            [
                "chat zero revision",
                "UPDATE chats SET revision = 0 WHERE id = 'k'",
                "chat row 1: invalid seq or revision",
            ],
            [
                // `node:sqlite` cannot read an integer past the safe range at all, so the row query fails.
                "chat unsafe revision",
                `UPDATE chats SET revision = ${limit} WHERE id = 'k'`,
                "Not a resource database",
            ],
            ["chat seq zero", "UPDATE chats SET seq = 0 WHERE id = 'k2'", "chat row 1: invalid seq or revision"],
            ["chat invalid id", "UPDATE chats SET id = '..' WHERE id = 'k2'", "chat row 2: invalid id"],
            [
                "chat schema version",
                "UPDATE chats SET schemaVersion = 2 WHERE id = 'k2'",
                "chat row 2: unsupported schema version",
            ],
            ["chat meta not JSON", "UPDATE chats SET meta = '{' WHERE id = 'k2'", "chat row 2: meta is not JSON"],
            [
                "chat meta id mismatch",
                `UPDATE chats SET meta = '{"id":"other"}' WHERE id = 'k2'`,
                "chat row 2: chat.id must equal the chat id",
            ],
            [
                "chat meta bad name",
                `UPDATE chats SET meta = '{"name":1}' WHERE id = 'k2'`,
                "chat row 2: chat.name and chat.note must be strings",
            ],
            [
                "message of unknown chat",
                "UPDATE messages SET chatSeq = 9 WHERE id = 'x'",
                "message row 4: no such chat",
            ],
            ["message invalid id", "UPDATE messages SET id = '' WHERE id = 'x'", "message row 4: invalid id"],
            [
                "message duplicate position",
                "UPDATE messages SET position = 0 WHERE id = 'b'",
                "message row 2: invalid or duplicate position",
            ],
            [
                "message chatId mismatch",
                `UPDATE messages SET data = '{"role":"user","data":"X","chatId":"y"}' WHERE id = 'x'`,
                "message row 4: message.chatId must equal the row id",
            ],
            ["message not JSON", "UPDATE messages SET data = 'nope' WHERE id = 'x'", "message row 4: data is not JSON"],
            [
                "message bad role",
                `UPDATE messages SET data = '{"role":"system","data":"X","chatId":"x"}' WHERE id = 'x'`,
                "message row 4: message.role must be user or char",
            ],
            [
                "fence without seq",
                "UPDATE messages SET generationSeq = NULL WHERE id = 'b'",
                "message row 2: invalid generation",
            ],
            [
                "fence bad final",
                "UPDATE messages SET generationFinal = 2 WHERE id = 'b'",
                "message row 2: invalid generation",
            ],
            [
                "fence empty id",
                "UPDATE messages SET generationId = '' WHERE id = 'b'",
                "message row 2: invalid generation",
            ],
            [
                "unfenced with seq",
                "UPDATE messages SET generationSeq = 1 WHERE id = 'c'",
                "message row 3: invalid generation",
            ],
            [
                "unfenced with history",
                `UPDATE messages SET generationHistory = '["g"]' WHERE id = 'c'`,
                "message row 3: invalid generation",
            ],
            [
                "history not JSON",
                "UPDATE messages SET generationHistory = '{' WHERE id = 'a'",
                "message row 1: invalid generation",
            ],
            [
                "history empty",
                "UPDATE messages SET generationHistory = '[]' WHERE id = 'a'",
                "message row 1: invalid generation",
            ],
            [
                "history holds current",
                `UPDATE messages SET generationHistory = '["ga2"]' WHERE id = 'a'`,
                "message row 1: invalid generation",
            ],
            [
                "history duplicate",
                `UPDATE messages SET generationHistory = '["g","g"]' WHERE id = 'a'`,
                "message row 1: invalid generation",
            ],
            [
                "history over cap",
                `UPDATE messages SET generationHistory = '${JSON.stringify(Array.from({ length: MAX_GENERATION_HISTORY + 1 }, (_, i) => `h${i}`))}' WHERE id = 'a'`,
                "message row 1: invalid generation",
            ],
            [
                "order of unknown character",
                "UPDATE chatOrders SET characterId = 'ghost' WHERE characterId = 'd'",
                "chat order row 2: no such character or a duplicate order",
            ],
            [
                "order ids not JSON",
                "UPDATE chatOrders SET ids = '[' WHERE characterId = 'c'",
                "chat order row 1: ids is not JSON",
            ],
            [
                "order misses a chat",
                `UPDATE chatOrders SET ids = '["k"]' WHERE characterId = 'c'`,
                "chat order row 1: ids must list exactly the character's chats",
            ],
            [
                "order names an unknown chat",
                `UPDATE chatOrders SET ids = '["k","k2","zz"]' WHERE characterId = 'c'`,
                "chat order row 1: ids must list exactly the character's chats",
            ],
            [
                "order repeats a chat",
                `UPDATE chatOrders SET ids = '["k","k"]' WHERE characterId = 'c'`,
                "chat order row 1: ids must list exactly the character's chats",
            ],
            ["order missing", "DELETE FROM chatOrders WHERE characterId = 'd'", "character d has no chat order"],
            [
                "order not an array",
                "UPDATE chatOrders SET ids = '{}' WHERE characterId = 'd'",
                "chat order row 2: ids must list exactly the character's chats",
            ],
        ];
        for (const [label, sql, message] of cases) {
            rejects(() => store.readSnapshot(tamper(file, sql)), message);
        }
        // Duplicate chat keys and order seqs need tables without their constraints.
        const loose = tamper(
            file,
            `CREATE TABLE chats2 AS SELECT * FROM chats; DROP TABLE chats;
             CREATE TABLE chats (seq INTEGER, characterId TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, meta TEXT NOT NULL);
             INSERT INTO chats SELECT * FROM chats2; DROP TABLE chats2;
             INSERT INTO chats VALUES (3, 'c', 'k', 1, 1, '{}');`,
        );
        rejects(() => store.readSnapshot(loose), "chat row 3: duplicate chat");
        // A non-integer position needs a table without STRICT.
        const looseMessages = tamper(
            file,
            `CREATE TABLE m2 AS SELECT * FROM messages; DROP TABLE messages;
             CREATE TABLE messages (chatSeq INTEGER NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
                 generationId TEXT, generationSeq INTEGER, generationFinal INTEGER, generationHistory TEXT);
             INSERT INTO messages SELECT * FROM m2; DROP TABLE m2;
             UPDATE messages SET position = 1.5 WHERE id = 'x';`,
        );
        rejects(() => store.readSnapshot(looseMessages), "message row 4: invalid or duplicate position");
        const looseOrders = tamper(
            file,
            `CREATE TABLE o2 AS SELECT * FROM chatOrders; DROP TABLE chatOrders;
             CREATE TABLE chatOrders (seq INTEGER, characterId TEXT NOT NULL, revision INTEGER NOT NULL, ids TEXT NOT NULL);
             INSERT INTO chatOrders SELECT * FROM o2; DROP TABLE o2;
             UPDATE chatOrders SET seq = 1;`,
        );
        rejects(() => store.readSnapshot(looseOrders), "chat order row 2: invalid seq or revision");
        for (const seq of ["1.5", "'x'", "NULL"]) {
            const crafted = tamper(
                looseOrders,
                `UPDATE chatOrders SET seq = ${seq} WHERE characterId = 'd'; UPDATE chatOrders SET seq = 2 WHERE characterId = 'c'`,
            );
            // The `d` row sorts first with a NULL or text seq and last with 1.5; either way it is refused.
            expect(() => store.readSnapshot(crafted), seq).toThrow(/chat order row [12]: invalid seq or revision/);
        }
        // The live data was never touched.
        expect(messageIds(store, "k")).toEqual(["a", "b", "c"]);
        expect(CHAT_TABLES_SQL).toContain("CREATE TABLE chatOrders");
    });
});

describe("per-chat toggle metadata", () => {
    it("accepts GLGlobalVariables meta.merge on an older revision and keeps both writers' entries", () => {
        const store = memoryStore();
        const base = seed(store).chat;
        const first = store.applyChanges({
            chats: [group("k", base, [{ op: "meta", merge: { GLGlobalVariables: { toggle_flag: "0" } } }])],
        });
        const second = store.applyChanges({
            chats: [group("k", base, [{ op: "meta", merge: { GLGlobalVariables: { toggle_title: "second tab" } } }])],
        });
        expect(second.chats[0].revision).not.toBe(first.chats[0].revision);
        expect(chat(store, "k")!.data.GLGlobalVariables).toEqual({ toggle_flag: "0", toggle_title: "second tab" });
        store.applyChanges({
            chats: [group("k", base, [{ op: "meta", merge: { GLGlobalVariables: { toggle_flag: "1" } } }])],
        });
        expect(chat(store, "k")!.data.GLGlobalVariables).toEqual({ toggle_flag: "1", toggle_title: "second tab" });
    });

    it("a whole-map set still replaces GLGlobalVariables instead of merging its entries", () => {
        const store = memoryStore();
        const base = seed(store).chat;
        store.applyChanges({
            chats: [
                group("k", base, [{ op: "meta", set: { GLGlobalVariables: { toggle_old: "old", toggle_flag: "1" } } }]),
            ],
        });
        store.applyChanges({
            chats: [group("k", base, [{ op: "meta", set: { GLGlobalVariables: { toggle_flag: "0" } } }])],
        });
        expect(chat(store, "k")!.data.GLGlobalVariables).toEqual({ toggle_flag: "0" });
    });
});

describe("meta merge", () => {
    const record = (id: string, text = id) => ({
        call: { id, name: "t", arg: {} },
        response: [{ type: "text", text }],
    });
    const merge = (entries: Record<string, unknown>): ChatOp => ({ op: "meta", merge: { toolCalls: entries } });
    const toolCalls = (store: ResourceStore) =>
        (chat(store, "k")!.data as { toolCalls?: Record<string, unknown> }).toolCalls;
    const current = (store: ResourceStore) => chat(store, "k")!.revision!;

    it("adds entries to the stored map: two writers on the same base keep each other's, the later same-id entry wins, prototype names are plain ids, and a set or unset of the field replaces it", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const first = store.applyChanges({ chats: [group("k", tokens.chat, [merge({ a: record("a") })])] });
        expect(toolCalls(store)).toEqual({ a: record("a") });
        // The second writer still holds the base the first wrote on: a by-id op, it applies.
        const second = store.applyChanges({ chats: [group("k", tokens.chat, [merge({ b: record("b") })])] });
        expect(toolCalls(store)).toEqual({ a: record("a"), b: record("b") });
        expect(second.chats[0].revision).not.toBe(first.chats[0].revision);
        const protoNamed = JSON.parse(
            `{"__proto__": ${JSON.stringify(record("__proto__"))}, "constructor": ${JSON.stringify(record("constructor"))}}`,
        ) as Record<string, unknown>;
        store.applyChanges({
            chats: [group("k", current(store), [merge(protoNamed), merge({ a: record("a", "again") })])],
        });
        const stored = toolCalls(store)!;
        expect(Object.keys(stored).sort()).toEqual(["__proto__", "a", "b", "constructor"]);
        expect(stored.a).toEqual(record("a", "again"));
        expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
        // A set replaces the whole map; an unset removes it; a merge onto a missing map creates it.
        store.applyChanges({
            chats: [group("k", current(store), [{ op: "meta", set: { toolCalls: { z: record("z") } } }])],
        });
        expect(toolCalls(store)).toEqual({ z: record("z") });
        store.applyChanges({ chats: [group("k", current(store), [{ op: "meta", unset: ["toolCalls"] }])] });
        expect(toolCalls(store)).toBeUndefined();
        store.applyChanges({ chats: [group("k", current(store), [merge({ n: record("n") })])] });
        expect(toolCalls(store)).toEqual({ n: record("n") });
        // The map survives a reopen of the same rows (the stored JSON holds the own entries).
        expect(JSON.parse(JSON.stringify(toolCalls(store)))).toEqual({ n: record("n") });
    });

    it("refuses a malformed entry wherever the chat is written (a merge, a set, a create, a replace) and rolls the batch back", () => {
        const store = memoryStore();
        const tokens = seed(store);
        store.applyChanges({ chats: [group("k", tokens.chat, [merge({ a: record("a") })])] });
        const before = snapshotState(store);
        const writes = store.writeCount();
        const bad = { call: { id: "x", name: "t" }, response: [{ type: "text" }] };
        const entries = "chat.toolCalls entries must be { call: { id, name, arg }, response: [tool content] }";
        rejects(
            () =>
                store.applyChanges({
                    chats: [
                        group("k", current(store), [{ op: "setText", id: "a", text: "changed" }, merge({ x: bad })]),
                    ],
                }),
            `chats[0].ops[1]: ${entries}`,
        );
        rejects(
            () =>
                store.applyChanges({
                    chats: [group("k", current(store), [{ op: "meta", set: { toolCalls: { x: bad } } }])],
                }),
            `chats[0].ops[0]: ${entries}`,
        );
        rejects(
            () =>
                store.applyChanges({
                    chats: [
                        group("n", null, [
                            { op: "create", chat: { name: "N", message: [], toolCalls: { x: bad } } as never },
                        ]),
                    ],
                }),
            `chats[0].ops[0]: ${entries}`,
        );
        rejects(
            () =>
                store.applyChanges({
                    chats: [
                        group("k", current(store), [
                            {
                                op: "replace",
                                chat: { id: "k", name: "K", message: [], toolCalls: { y: record("not-y") } } as never,
                            },
                        ]),
                    ],
                }),
            `chats[0].ops[0]: ${entries}`,
        );
        rejects(
            () => store.applyChanges({ chats: [group("k", current(store), [merge({ a: 5 })])] }),
            `chats[0].ops[0]: ${entries}`,
        );
        expect(snapshotState(store)).toBe(before);
        expect(store.writeCount()).toBe(writes);
        expect(text(store, "k", "a")).toBe("A");
    });
});

describe("meta mergeUnset and scriptstate merge", () => {
    const record = (id: string, text = id) => ({
        call: { id, name: "t", arg: {} },
        response: [{ type: "text", text }],
    });
    const meta = (store: ResourceStore) => chat(store, "k")!.data as unknown as Record<string, unknown>;
    const current = (store: ResourceStore) => chat(store, "k")!.revision!;

    it("keeps both writers' scriptstate keys, removes one key and keeps the rest on an older revision, adds an id named in both halves, and leaves a non-map field alone for removals", () => {
        const store = memoryStore();
        const base = seed(store).chat;
        // Two writers on the same base, each with its own variable: both keys are stored.
        store.applyChanges({ chats: [group("k", base, [{ op: "meta", merge: { scriptstate: { $a: "1" } } }])] });
        const second = store.applyChanges({
            chats: [group("k", base, [{ op: "meta", merge: { scriptstate: { $b: "2" } } }])],
        }).chats[0];
        expect(second).toMatchObject({ revision: bumped(base, 2), stale: true });
        expect(meta(store).scriptstate).toEqual({ $a: "1", $b: "2" });
        // A removal from the older base: only the named key goes.
        const removed = store.applyChanges({
            chats: [group("k", base, [{ op: "meta", mergeUnset: { scriptstate: ["$a"] } }])],
        }).chats[0];
        expect(removed).toMatchObject({ revision: bumped(base, 3), stale: true });
        expect(meta(store).scriptstate).toEqual({ $b: "2" });
        // Removals go first: an id in both halves ends up added; a missing id is nothing to remove.
        store.applyChanges({
            chats: [
                group("k", base, [
                    {
                        op: "meta",
                        mergeUnset: { scriptstate: ["$b", "$never"] },
                        merge: { scriptstate: { $b: "3", $c: "4" } },
                    },
                ]),
            ],
        });
        expect(meta(store).scriptstate).toEqual({ $b: "3", $c: "4" });
        // Removing the last key leaves an empty map, not an absent field.
        store.applyChanges({
            chats: [group("k", base, [{ op: "meta", mergeUnset: { scriptstate: ["$b", "$c"] } }])],
        });
        expect(meta(store).scriptstate).toEqual({});
        // Removals alone from an absent field leave it absent; from a field that is not a map leave
        // it as it is; entries onto such a field replace it with the map of the entries.
        expect(meta(store)).not.toHaveProperty("GLGlobalVariables");
        store.applyChanges({
            chats: [group("k", base, [{ op: "meta", mergeUnset: { GLGlobalVariables: ["x"] } }])],
        });
        expect(meta(store)).not.toHaveProperty("GLGlobalVariables");
        store.applyChanges({
            chats: [group("k", current(store), [{ op: "meta", set: { GLGlobalVariables: "text" } }])],
        });
        store.applyChanges({
            chats: [group("k", base, [{ op: "meta", mergeUnset: { GLGlobalVariables: ["x"] } }])],
        });
        expect(meta(store).GLGlobalVariables).toBe("text");
        store.applyChanges({
            chats: [
                group("k", base, [
                    { op: "meta", mergeUnset: { GLGlobalVariables: ["x"] }, merge: { GLGlobalVariables: { y: "1" } } },
                ]),
            ],
        });
        expect(meta(store).GLGlobalVariables).toEqual({ y: "1" });
        // The other fields of the chat are untouched throughout.
        expect(meta(store)).toMatchObject({ id: "k", name: "K", note: "", localLore: [], fmIndex: -1 });
        expect(messageIds(store, "k")).toEqual(["a", "b", "c"]);
    });

    it("removes a toolCalls entry, a prototype-named id included, and revalidates what stays; a refused batch leaves the map", () => {
        const store = memoryStore();
        const base = seed(store).chat;
        const protoNamed = JSON.parse(
            `{"__proto__": ${JSON.stringify(record("__proto__"))}, "constructor": ${JSON.stringify(record("constructor"))}}`,
        ) as Record<string, unknown>;
        store.applyChanges({
            chats: [group("k", base, [{ op: "meta", merge: { toolCalls: { a: record("a"), ...protoNamed } } }])],
        });
        expect(Object.keys(meta(store).toolCalls as object).sort()).toEqual(["__proto__", "a", "constructor"]);
        store.applyChanges({
            chats: [group("k", base, [{ op: "meta", mergeUnset: { toolCalls: ["__proto__", "a"] } }])],
        });
        const stored = meta(store).toolCalls as Record<string, unknown>;
        expect(Object.keys(stored)).toEqual(["constructor"]);
        expect(stored.constructor).toEqual(record("constructor"));
        expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
        // The remaining map is validated as a whole: a malformed entry added beside a removal is refused
        // and the batch rolled back, the removal included.
        const state = snapshotState(store);
        const writes = store.writeCount();
        rejects(
            () =>
                store.applyChanges({
                    chats: [
                        group("k", base, [
                            {
                                op: "meta",
                                mergeUnset: { toolCalls: ["constructor"] },
                                merge: {
                                    toolCalls: { x: { call: { id: "x", name: "t" }, response: [{ type: "text" }] } },
                                },
                            },
                        ]),
                    ],
                }),
            "chats[0].ops[0]: chat.toolCalls entries must be { call: { id, name, arg }, response: [tool content] }",
        );
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
    });

    it("publishes a removal-only meta op with the whole metadata in the feed patch", () => {
        const feed = createChangeFeed();
        const store = createResourceStore({ file: ":memory:", kinds, feed });
        stores.push(store);
        const events: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
        feed.subscribe((event) => {
            if (event.type === "change") events.push(event);
        });
        const base = seed(store).chat;
        const storedBase = store.applyChanges({
            chats: [group("k", base, [{ op: "meta", merge: { scriptstate: { $a: "1", $b: "2" } } }])],
        }).chats[0].revision!;
        const removed = store.applyChanges({
            chats: [group("k", base, [{ op: "meta", mergeUnset: { scriptstate: ["$a"] } }])],
        }).chats[0];
        expect(events.at(-1)!.changes.chats).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: removed.revision,
                patch: {
                    baseRevision: storedBase,
                    count: 3,
                    meta: { id: "k", name: "K", note: "", localLore: [], fmIndex: -1, scriptstate: { $b: "2" } },
                },
            },
        ]);
    });
});

describe("message translations", () => {
    const tr = (text: string, source: string, extra: Partial<MessageTranslation> = {}): MessageTranslation => ({
        text,
        sourceHash: translationSourceHash(source),
        targetLanguage: "ko",
        translatedAt: 1,
        ...extra,
    });
    const setTr = (id: string, translation: MessageTranslation | null): ChatOp => ({
        op: "setTranslation",
        id,
        translation,
    });
    const message = (store: ResourceStore, chatId: string, id: string) =>
        chat(store, chatId)!.data.message.find((x) => x.chatId === id)! as unknown as Record<string, unknown>;

    it("applies a translation of the stored text, ignores a stale one unchanged, clears with null, moves the revision only for a change, reports the outcomes in op order, and applies on an older revision", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const T = tr("ㄱ", "A");
        let r = store.applyChanges({ chats: [group("k", tokens.chat, [setTr("a", T)])] }).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision: bumped(tokens.chat, 1), translations: ["applied"] });
        expect(message(store, "k", "a")).toEqual({ role: "user", data: "A", chatId: "a", translation: T });
        expect(storedTranslation(message(store, "k", "a") as never)).toBe("ㄱ");
        let revision = r.revision!;

        // A translation of a text the message does not hold: ignored, nothing written.
        const state = snapshotState(store);
        const writes = store.writeCount();
        r = store.applyChanges({ chats: [group("k", revision, [setTr("a", tr("x", "not A"))])] }).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision, translations: ["ignored"] });
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // The identical translation again (a replay): applied, nothing moves.
        r = store.applyChanges({ chats: [group("k", revision, [setTr("a", T)])] }).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision, translations: ["applied"] });
        expect(store.writeCount()).toBe(writes);
        // A different translation of the same text (an edit by hand) replaces it.
        const T2 = tr("ㄱ (edited)", "A", { presetId: "p", edited: true });
        r = store.applyChanges({ chats: [group("k", revision, [setTr("a", T2)])] }).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision: bumped(revision, 1), translations: ["applied"] });
        expect(message(store, "k", "a").translation).toEqual(T2);
        revision = r.revision!;

        // null clears whatever the text is; clearing an absent one is applied without a move.
        r = store.applyChanges({ chats: [group("k", revision, [setTr("a", null)])] }).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision: bumped(revision, 1), translations: ["applied"] });
        expect(message(store, "k", "a")).toEqual({ role: "user", data: "A", chatId: "a" });
        revision = r.revision!;
        r = store.applyChanges({ chats: [group("k", revision, [setTr("a", null)])] }).chats[0];
        expect(r).toEqual({ characterId: "c", id: "k", revision, translations: ["applied"] });

        // One outcome per setTranslation, in op order; the hash is checked against the text as the
        // group's earlier ops left it; the group named an older revision, so the result says so.
        r = store.applyChanges({
            chats: [
                group("k", tokens.chat, [
                    { op: "setText", id: "b", text: "B2" },
                    setTr("b", tr("ㄴ", "B")),
                    setTr("b", tr("ㄴ2", "B2")),
                    setTr("c", null),
                ]),
            ],
        }).chats[0];
        expect(r).toEqual({
            characterId: "c",
            id: "k",
            revision: bumped(revision, 2),
            translations: ["ignored", "applied", "applied"],
            stale: true,
        });
        expect(message(store, "k", "b")).toEqual({
            role: "user",
            data: "B2",
            chatId: "b",
            translation: tr("ㄴ2", "B2"),
        });
        revision = r.revision!;

        // A missing message: its translation is `ignored` and its target `missing`; the group's meta
        // op commits.
        const gone = store.applyChanges({
            chats: [group("k", revision, [{ op: "meta", set: { note: "n" } }, setTr("zz", null)])],
        }).chats[0];
        expect(gone).toEqual({
            characterId: "c",
            id: "k",
            revision: bumped(revision, 1),
            translations: ["ignored"],
            targets: ["missing"],
        });
        expect(chat(store, "k")!.data).toMatchObject({ note: "n" });
    });

    it("setMessage never changes a stored translation or its absence, setText leaves it to go stale by hash, a generation's checkpoints keep it, setTranslation leaves the fence open, and replace writes what it carries", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const T = tr("ㄱ", "A");
        let revision = store.applyChanges({ chats: [group("k", tokens.chat, [setTr("a", T)])] }).chats[0].revision!;

        // A whole-message write without the key, with an older translation, and with a newer one: T stays.
        const carried = [
            { ...m("a", "A"), name: "no key" },
            { ...m("a", "A"), name: "older", translation: tr("old", "A", { translatedAt: 0 }) },
            { ...m("a", "A"), name: "newer", translation: tr("new", "A", { translatedAt: 99 }) },
        ];
        for (const sent of carried) {
            revision = store.applyChanges({
                chats: [group("k", revision, [{ op: "setMessage", message: sent as never }])],
            }).chats[0].revision!;
            expect(message(store, "k", "a"), sent.name).toEqual({ ...m("a", "A"), name: sent.name, translation: T });
        }
        // A stored absence is kept too: a setMessage cannot introduce a translation.
        revision = store.applyChanges({
            chats: [
                group("k", revision, [
                    { op: "setMessage", message: { ...m("b", "B"), translation: tr("ㄴ", "B") } as never },
                ]),
            ],
        }).chats[0].revision!;
        expect(message(store, "k", "b")).toEqual(m("b", "B"));

        // A text edit keeps the field; the translation is stale by hash until the text is back.
        revision = store.applyChanges({ chats: [group("k", revision, [{ op: "setText", id: "a", text: "A2" }])] })
            .chats[0].revision!;
        expect(message(store, "k", "a").translation).toEqual(T);
        expect(storedTranslation(message(store, "k", "a") as never)).toBeNull();
        revision = store.applyChanges({ chats: [group("k", revision, [{ op: "setText", id: "a", text: "A" }])] })
            .chats[0].revision!;
        expect(storedTranslation(message(store, "k", "a") as never)).toBe("ㄱ");

        // A generation's checkpoint writes (the runner's whole-message writes) keep it as well, and a
        // setTranslation in between is not a manual write: the fence stays open for the next checkpoint.
        let r = store.applyChanges({
            chats: [
                group("k", revision, [
                    { op: "begin", id: "a", generationId: "g1" },
                    { op: "setMessage", message: m("a", "gen 1", "char") as never, generation: { id: "g1", seq: 1 } },
                ]),
            ],
        }).chats[0];
        expect(r.checkpoints).toEqual(["applied"]);
        expect(message(store, "k", "a")).toEqual({ ...m("a", "gen 1", "char"), translation: T });
        revision = r.revision!;
        const G = tr("생성 1", "gen 1");
        r = store.applyChanges({ chats: [group("k", revision, [setTr("a", G)])] }).chats[0];
        expect(r.translations).toEqual(["applied"]);
        revision = r.revision!;
        r = store.applyChanges({
            chats: [
                group("k", revision, [
                    { op: "setText", id: "a", text: "gen 2", generation: { id: "g1", seq: 2 } },
                    {
                        op: "setMessage",
                        message: m("a", "gen 3", "char") as never,
                        generation: { id: "g1", seq: 3, final: true },
                    },
                ]),
            ],
        }).chats[0];
        expect(r.checkpoints).toEqual(["applied", "applied"]);
        expect(message(store, "k", "a")).toEqual({ ...m("a", "gen 3", "char"), translation: G });
        revision = r.revision!;

        // A whole-chat write is the other writer of the field: it stores what it carries, or nothing.
        const R = tr("ㄱ (replaced)", "A");
        revision = store.applyChanges({
            chats: [
                group("k", revision, [
                    {
                        op: "replace",
                        chat: {
                            id: "k",
                            name: "K",
                            message: [{ ...m("a", "A"), translation: R }, m("b", "B")],
                        } as never,
                    },
                ]),
            ],
        }).chats[0].revision!;
        expect(message(store, "k", "a")).toEqual({ ...m("a", "A"), translation: R });
        store.applyChanges({
            chats: [
                group("k", revision, [
                    { op: "replace", chat: { id: "k", name: "K", message: [m("a", "A")] } as never },
                ]),
            ],
        });
        expect(message(store, "k", "a")).toEqual(m("a", "A"));
    });

    it("refuses a malformed setTranslation before any write, and drops (never refuses) a message translation that is not a MessageTranslation on create, append, and replace", () => {
        const store = memoryStore();
        const tokens = seed(store);
        const T = tr("ㄱ", "A");
        const before = snapshotState(store);
        const writes = store.writeCount();
        const shape = "setTranslation must be { id, translation: MessageTranslation | null }";
        const malformed: unknown[] = [
            undefined,
            "legacy",
            { text: "x" },
            { ...T, sourceHash: "" },
            { ...T, translatedAt: Number.POSITIVE_INFINITY },
            { ...T, targetLanguage: 1 },
        ];
        for (const translation of malformed) {
            rejects(
                () =>
                    store.applyChanges({
                        chats: [
                            group("k", tokens.chat, [
                                { op: "setText", id: "a", text: "changed" },
                                { op: "setTranslation", id: "a", translation } as never,
                            ]),
                        ],
                    }),
                `chats[0].ops[1]: ${shape}`,
            );
        }
        rejects(
            () =>
                store.applyChanges({
                    chats: [group("k", tokens.chat, [{ op: "setTranslation", id: "", translation: T } as never])],
                }),
            `chats[0].ops[0]: ${shape}`,
        );
        expect(snapshotState(store)).toBe(before);
        expect(store.writeCount()).toBe(writes);

        // An imported chat keeps its messages: the unsupported translations are dropped, a valid one
        // (fresh or stale) is kept as sent.
        const stale = tr("ㄴ", "B before the edit");
        const created = store.applyChanges({
            ops: [createCharacter("d")],
            chats: [
                group(
                    "n",
                    null,
                    [
                        {
                            op: "create",
                            chat: {
                                name: "N",
                                message: [
                                    { ...m("a", "A"), translation: "legacy string" },
                                    { ...m("b", "B"), translation: stale },
                                    { ...m("c", "C"), translation: null },
                                    { ...m("d", "D"), translation: { text: "no hash" } },
                                ],
                            } as never,
                        },
                    ],
                    "d",
                ),
            ],
        }).chats[0];
        const stored = (id: string) =>
            store
                .readRefs([], { chats: [{ characterId: "d", id: "n" }] })
                .chats[0].data!.message.find((x) => x.chatId === id);
        expect(stored("a")).toEqual(m("a", "A"));
        expect(stored("b")).toEqual({ ...m("b", "B"), translation: stale });
        expect(stored("c")).toEqual(m("c", "C"));
        expect(stored("d")).toEqual(m("d", "D"));
        let revision = created.revision!;
        revision = store.applyChanges({
            chats: [
                group(
                    "n",
                    revision,
                    [
                        {
                            op: "append",
                            messages: [
                                { ...m("e", "E"), translation: 5 },
                                { ...m("f", "F"), translation: tr("ㅍ", "F") },
                            ] as never,
                            anchor: { end: true },
                        },
                    ],
                    "d",
                ),
            ],
        }).chats[0].revision!;
        expect(stored("e")).toEqual(m("e", "E"));
        expect(stored("f")).toEqual({ ...m("f", "F"), translation: tr("ㅍ", "F") });
        store.applyChanges({
            chats: [
                group(
                    "n",
                    revision,
                    [
                        {
                            op: "replace",
                            chat: {
                                id: "n",
                                name: "N",
                                message: [{ ...m("a", "A"), translation: ["not", "one"] }],
                            } as never,
                        },
                    ],
                    "d",
                ),
            ],
        });
        expect(stored("a")).toEqual(m("a", "A"));
    });
});

describe("missing targets", () => {
    const tr = (source: string, text = "translated"): MessageTranslation => ({
        text,
        sourceHash: translationSourceHash(source),
        targetLanguage: "ko",
        translatedAt: 1,
    });
    const patch = (id: string, set: Record<string, unknown>): ChatOp => ({ op: "patchMessage", id, set }) as ChatOp;
    /** A feed-backed store with `k` (a, b, c), a generation `gb` open on `b`, and `c` removed on the current revision. */
    function setup() {
        const feed = createChangeFeed();
        const store = createResourceStore({ file: ":memory:", kinds, feed });
        stores.push(store);
        const events: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
        feed.subscribe((event) => {
            if (event.type === "change") events.push(event);
        });
        const base = seed(store).chat;
        const begun = store.applyChanges({ chats: [group("k", base, [{ op: "begin", id: "b", generationId: "gb" }])] })
            .chats[0].revision!;
        const current = store.applyChanges({ chats: [group("k", begun, [{ op: "remove", ids: ["c"] }])] }).chats[0]
            .revision!;
        return { store, events, base, current };
    }

    it("reports a gone message per op in op order, aligned with the checkpoint and translation outcomes, and commits the group's other ops", () => {
        const { store, events, base, current } = setup();
        const result = store.applyChanges({
            chats: [
                group("k", base, [
                    { op: "setText", id: "c", text: "gone", generation: { id: "gc", seq: 1 } },
                    { op: "append", messages: [m("d", "D")], anchor: { end: true } },
                    { op: "setText", id: "b", text: "B2", generation: { id: "gb", seq: 1 } },
                    patch("c", { disabled: true }),
                    { op: "setTranslation", id: "c", translation: null },
                    { op: "setTranslation", id: "b", translation: tr("B2") },
                    { op: "setMessage", message: m("c", "C2") },
                    { op: "setText", id: "a", text: "A2" },
                ]),
            ],
        }).chats[0];
        expect(result).toEqual({
            characterId: "c",
            id: "k",
            revision: bumped(current, 4),
            stale: true,
            checkpoints: ["ignored", "applied"],
            translations: ["ignored", "applied"],
            targets: ["missing", "applied", "missing", "missing", "applied", "missing", "applied"],
        });
        expect(chat(store, "k")!.data.message).toEqual([
            m("a", "A2"),
            { ...m("b", "B2"), translation: tr("B2") },
            m("d", "D"),
        ]);
        // The feed patch carries the rows the group changed, from the actual base; nothing of `c`.
        expect(events.at(-1)!.changes.chats).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: result.revision,
                patch: {
                    baseRevision: current,
                    count: 3,
                    messages: [
                        { after: null, message: m("a", "A2") },
                        { after: "a", message: { ...m("b", "B2"), translation: tr("B2") } },
                        { after: "b", message: m("d", "D") },
                    ],
                },
            },
        ]);
    });

    it("moves nothing for a group whose every target is gone: the revision and the write count stay, and the feed carries no patch, on an older and on the current revision", () => {
        const { store, events, base, current } = setup();
        const state = snapshotState(store);
        const writes = store.writeCount();
        const ops: ChatOp[] = [
            { op: "setText", id: "c", text: "gone" },
            patch("c", { disabled: true }),
            { op: "setTranslation", id: "c", translation: null },
            { op: "setMessage", message: m("c", "C2") },
        ];
        expect(store.applyChanges({ chats: [group("k", base, ops)] }).chats[0]).toEqual({
            characterId: "c",
            id: "k",
            revision: current,
            stale: true,
            translations: ["ignored"],
            targets: ["missing", "missing", "missing", "missing"],
        });
        expect(store.applyChanges({ chats: [group("k", current, ops)] }).chats[0]).toEqual({
            characterId: "c",
            id: "k",
            revision: current,
            translations: ["ignored"],
            targets: ["missing", "missing", "missing", "missing"],
        });
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // Published at the unchanged revision without a patch (as a replayed append is): a client
        // holding that revision ignores it.
        expect(events.at(-1)!.changes.chats).toEqual([{ characterId: "c", id: "k", revision: current }]);
    });

    it("still rolls the whole group back for an append after a gone anchor, a multi-id remove with a gone id, and a begin of a gone message", () => {
        const { store, base, current } = setup();
        const state = snapshotState(store);
        const writes = store.writeCount();
        for (const ops of [
            [
                { op: "setText", id: "c", text: "gone" },
                { op: "append", messages: [m("d", "D")], anchor: { after: "c" } },
            ],
            [
                { op: "setText", id: "a", text: "A2" },
                { op: "remove", ids: ["a", "c"] },
            ],
            [
                { op: "setText", id: "a", text: "A2" },
                { op: "begin", id: "c", generationId: "gc" },
            ],
        ] as ChatOp[][]) {
            for (const revision of [base, current]) {
                expect(
                    conflictsOf(() => store.applyChanges({ chats: [group("k", revision, ops)] })),
                    JSON.stringify(ops),
                ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: current }]);
            }
        }
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
    });
});

describe("group idempotency ids", () => {
    const tr = (source: string, text = "translated"): MessageTranslation => ({
        text,
        sourceHash: translationSourceHash(source),
        targetLanguage: "ko",
        translatedAt: 1,
    });
    /** A group as the tab sends it: with its id, and `retry` for a resend after a lost answer. */
    const identified = (
        chatId: string,
        baseRevision: string | null,
        ops: ChatOp[],
        groupId: string,
        retry = false,
    ) => ({
        ...group(chatId, baseRevision, ops),
        groupId,
        ...(retry ? { retry: true as const } : {}),
    });
    const note = (value: string): ChatOp => ({ op: "meta", set: { note: value }, unset: [] }) as ChatOp;
    /** A feed-backed store with `k` (a, b, c). */
    function setup() {
        const feed = createChangeFeed();
        const store = createResourceStore({ file: ":memory:", kinds, feed });
        stores.push(store);
        const events: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
        feed.subscribe((event) => {
            if (event.type === "change") events.push(event);
        });
        return { store, events, base: seed(store).chat };
    }
    /** The remembered ids of the live file (its `chatGroups` rows), oldest first. */
    function rememberedIds(file: string): { chatSeq: number; groupId: string; revision: number }[] {
        const db = new DatabaseSync(file);
        try {
            return db.prepare("SELECT chatSeq, groupId, revision FROM chatGroups ORDER BY seq").all() as never;
        } finally {
            db.close();
        }
    }

    it("answers a replayed id with the earlier result and changes nothing: another writer's later edit stays, the revision and write count stay, and the feed carries nothing new", () => {
        const { store, events, base } = setup();
        const ops: ChatOp[] = [
            { op: "append", messages: [m("d", "D")], anchor: { end: true } },
            { op: "setText", id: "a", text: "mine" },
        ];
        const first = store.applyChanges({ chats: [identified("k", base, ops, "g1")] }).chats[0];
        expect(first).toEqual({ characterId: "c", id: "k", revision: bumped(base, 2) });
        // Another writer (a server job: no id) edits `a` after it.
        const theirs = store.applyChanges({
            chats: [group("k", first.revision!, [{ op: "setText", id: "a", text: "theirs" }])],
        }).chats[0].revision!;
        const state = snapshotState(store);
        const writes = store.writeCount();
        const published = events.length;
        // The resend after a lost answer, and a replay that is not in doubt: both answered as before.
        for (const retry of [true, false]) {
            expect(store.applyChanges({ chats: [identified("k", base, ops, "g1", retry)] }).chats[0]).toEqual(first);
        }
        expect(text(store, "k", "a")).toBe("theirs");
        expect(messageIds(store, "k")).toEqual(["a", "b", "c", "d"]);
        expect(chat(store, "k")!.revision).toBe(theirs);
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // Nothing is published: the feed already carried this group's ref when it applied.
        expect(events).toHaveLength(published);
        // The same ops under a fresh id are a new group: applied on the stale base, over the other writer.
        const fresh = store.applyChanges({ chats: [identified("k", base, ops, "g1-fresh")] }).chats[0];
        expect(fresh).toEqual({ characterId: "c", id: "k", revision: bumped(theirs, 1), stale: true });
        expect(text(store, "k", "a")).toBe("mine");
    });

    it("remembers stale, every checkpoint, the translation outcomes, and the missing targets, answering each checkpoint duplicate", () => {
        const { store, base } = setup();
        // Another writer removes `c` and opens a generation on `b` (a `begin` needs the current revision).
        const removed = store.applyChanges({ chats: [group("k", base, [{ op: "remove", ids: ["c"] }])] }).chats[0]
            .revision!;
        const current = store.applyChanges({
            chats: [group("k", removed, [{ op: "begin", id: "b", generationId: "g" }])],
        }).chats[0].revision!;
        const ops: ChatOp[] = [
            { op: "setText", id: "b", text: "one", generation: { id: "g", seq: 1 } },
            { op: "setTranslation", id: "a", translation: tr("A") },
            { op: "setTranslation", id: "b", translation: tr("not the stored text") },
            { op: "setText", id: "c", text: "gone" },
        ];
        const first = store.applyChanges({ chats: [identified("k", base, ops, "g2")] }).chats[0];
        expect(first.stale).toBe(true);
        expect(first.checkpoints).toEqual(["applied"]);
        expect(first.translations).toEqual(["applied", "ignored"]);
        expect(first.targets).toEqual(["applied", "applied", "applied", "missing"]);
        // The generation closes meanwhile; the replay is answered as the write it was.
        store.applyChanges({
            chats: [
                group("k", first.revision!, [
                    { op: "setText", id: "b", text: "final", generation: { id: "g", seq: 2, final: true } },
                ]),
            ],
        });
        const state = snapshotState(store);
        expect(store.applyChanges({ chats: [identified("k", base, ops, "g2", true)] }).chats[0]).toEqual({
            ...first,
            checkpoints: ["duplicate"],
        });
        expect(snapshotState(store)).toBe(state);
        expect(text(store, "k", "b")).toBe("final");
        expect(current).not.toBe(first.revision);
    });

    it("answers a replayed create with its message ids, also when the server renamed missing or duplicate ids, and creates no second chat", () => {
        const { store } = setup();
        const kept: ChatOp[] = [{ op: "create", chat: { name: "Two", message: [m("x", "X"), m("y", "Y")] } as never }];
        const renaming: ChatOp[] = [
            {
                op: "create",
                chat: {
                    name: "Three",
                    message: [m("x", "X"), m("x", "duplicate id"), { role: "user", data: "no id" }],
                },
            } as never,
        ];
        const two = store.applyChanges({ chats: [identified("k2", null, kept, "c1")] }).chats[0];
        expect(two.messageIds).toEqual(["x", "y"]);
        const three = store.applyChanges({ chats: [identified("k3", null, renaming, "c2")] }).chats[0];
        expect(three.messageIds).toHaveLength(3);
        expect(three.messageIds![0]).toBe("x");
        expect(three.messageIds![1]).not.toBe("x");
        expect(messageIds(store, "k3")).toEqual(three.messageIds);
        const state = snapshotState(store);
        const writes = store.writeCount();
        expect(store.applyChanges({ chats: [identified("k2", null, kept, "c1", true)] }).chats[0]).toEqual(two);
        expect(store.applyChanges({ chats: [identified("k3", null, renaming, "c2", true)] }).chats[0]).toEqual(three);
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        expect(orderOf(store)!.ids).toEqual(["k", "k2", "k3"]);
        // The create under a fresh id is what it always was: a conflict with the existing chat.
        expect(conflictsOf(() => store.applyChanges({ chats: [identified("k2", null, kept, "c1-fresh")] }))).toEqual([
            { kind: "chat", characterId: "c", id: "k2", revision: two.revision },
        ]);
    });

    it("remembers a group that changed nothing, so its resend does not apply once another writer recreated its target", () => {
        const { store, base } = setup();
        const current = store.applyChanges({ chats: [group("k", base, [{ op: "remove", ids: ["c"] }])] }).chats[0]
            .revision!;
        const ops: ChatOp[] = [{ op: "setText", id: "c", text: "mine" }];
        const first = store.applyChanges({ chats: [identified("k", current, ops, "g3")] }).chats[0];
        expect(first).toEqual({ characterId: "c", id: "k", revision: current, targets: ["missing"] });
        // Another writer puts `c` back.
        store.applyChanges({
            chats: [group("k", current, [{ op: "append", messages: [m("c", "theirs")], anchor: { end: true } }])],
        });
        expect(store.applyChanges({ chats: [identified("k", current, ops, "g3", true)] }).chats[0]).toEqual(first);
        expect(text(store, "k", "c")).toBe("theirs");
    });

    it("remembers nothing of a batch another group's conflict rolled back", () => {
        const { store, base } = setup();
        const ops: ChatOp[] = [{ op: "setText", id: "a", text: "mine" }];
        const state = snapshotState(store);
        expect(
            conflictsOf(() =>
                store.applyChanges({
                    chats: [identified("k", base, ops, "g4"), group("missing", base, [{ op: "delete" }])],
                }),
            ),
        ).toEqual([{ kind: "chat", characterId: "c", id: "missing", revision: null }]);
        expect(snapshotState(store)).toBe(state);
        // Not remembered: the resend applies as a first attempt.
        expect(store.applyChanges({ chats: [identified("k", base, ops, "g4", true)] }).chats[0]).toEqual({
            characterId: "c",
            id: "k",
            revision: bumped(base, 1),
        });
        expect(text(store, "k", "a")).toBe("mine");
    });

    it("answers a remembered id before the generation lock and the anchor check", () => {
        const lock = createGenerationLock();
        const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
        stores.push(store);
        const base = seed(store).chat;
        const ops: ChatOp[] = [
            { op: "append", messages: [m("d", "D")], anchor: { after: "b" } },
            { op: "setText", id: "a", text: "mine" },
        ];
        const first = store.applyChanges({ chats: [identified("k", base, ops, "g5")] }).chats[0];
        // A job takes `a`, and another writer removes the anchor `b`.
        lock.addToken("t");
        lock.acquire({ characterId: "c", chatId: "k", messageId: "a" }, { jobId: "J", generationId: "g", token: "t" });
        const current = store.applyChanges({ chats: [group("k", first.revision!, [{ op: "remove", ids: ["b"] }])] })
            .chats[0].revision!;
        const state = snapshotState(store);
        expect(store.applyChanges({ chats: [identified("k", base, ops, "g5", true)] }).chats[0]).toEqual(first);
        expect(snapshotState(store)).toBe(state);
        // The same ops as a new group meet the lock first (and the gone anchor after it).
        expect(conflictsOf(() => store.applyChanges({ chats: [identified("k", base, ops, "g5-fresh")] }))).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: current, reason: "generating", messageIds: ["a"] },
        ]);
    });

    it("remembers the newest 100 ids of a chat: an evicted retry conflicts as expired, a remembered one is answered, and a retry on a newer base or a fresh id applies", () => {
        const dir = tempDir();
        const store = fileStore(dir);
        const base = seed(store).chat;
        const revisions: string[] = [];
        let revision = base;
        for (let index = 1; index <= MAX_CHAT_GROUP_IDS + 1; index += 1) {
            revision = store.applyChanges({ chats: [identified("k", revision, [note(`n${index}`)], `g${index}`)] })
                .chats[0].revision!;
            revisions.push(revision);
        }
        const remembered = rememberedIds(path.join(dir, "live.sqlite"));
        expect(remembered).toHaveLength(MAX_CHAT_GROUP_IDS);
        expect(remembered[0]).toEqual({ chatSeq: 1, groupId: "g2", revision: counter(revisions[1]) });
        expect(remembered.at(-1)!.groupId).toBe(`g${MAX_CHAT_GROUP_IDS + 1}`);
        const current = revisions.at(-1)!;
        const state = snapshotState(store);
        // Evicted: its retry may have landed (it did), so it is refused as expired, not applied again.
        expect(
            conflictsOf(() => store.applyChanges({ chats: [identified("k", base, [note("n1")], "g1", true)] })),
        ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: current, reason: "expired" }]);
        // An unknown retry whose base is not newer than the oldest remembered group's revision: the same.
        for (const stale of [base, revisions[0], revisions[1]]) {
            expect(
                conflictsOf(() =>
                    store.applyChanges({ chats: [identified("k", stale, [note("x")], "unknown", true)] }),
                ),
            ).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: current, reason: "expired" }]);
        }
        // Still remembered: answered as it was.
        expect(
            store.applyChanges({ chats: [identified("k", revisions[0], [note("n2")], "g2", true)] }).chats[0],
        ).toEqual({ characterId: "c", id: "k", revision: revisions[1] });
        expect(snapshotState(store)).toBe(state);
        expect(chat(store, "k")!.data.note).toBe(`n${MAX_CHAT_GROUP_IDS + 1}`);
        // A retry on a base newer than the oldest remembered group would still be remembered had it
        // landed: it applies (stale). A group without `retry` is never refused as expired.
        expect(
            store.applyChanges({ chats: [identified("k", revisions[2], [note("newer base")], "unknown-newer", true)] })
                .chats[0],
        ).toEqual({ characterId: "c", id: "k", revision: bumped(current, 1), stale: true });
        expect(store.applyChanges({ chats: [identified("k", base, [note("n1 again")], "g1")] }).chats[0]).toEqual({
            characterId: "c",
            id: "k",
            revision: bumped(current, 2),
            stale: true,
        });
        expect(chat(store, "k")!.data.note).toBe("n1 again");
        expect(rememberedIds(path.join(dir, "live.sqlite"))).toHaveLength(MAX_CHAT_GROUP_IDS);
    });

    it("creates the table in a database from before it, keeps the ids across a reopen, drops them with the chat and on a restore, and restores snapshots with and without it", async () => {
        const dir = tempDir();
        const file = path.join(dir, "live.sqlite");
        const ops: ChatOp[] = [{ op: "setText", id: "a", text: "mine" }];
        let store = createResourceStore({ file, kinds });
        const base = seed(store).chat;
        store.close();
        // A database created before the `chatGroups` table existed: none.
        const db = new DatabaseSync(file);
        db.exec("DROP TABLE chatGroups");
        db.close();
        store = createResourceStore({ file, kinds });
        const first = store.applyChanges({ chats: [identified("k", base, ops, "g6")] }).chats[0];
        expect(first.revision).toBe(bumped(base, 1));
        expect(store.applyChanges({ chats: [identified("k", base, ops, "g6", true)] }).chats[0]).toEqual(first);
        store.close();
        expect(rememberedIds(file).map((row) => row.groupId)).toEqual(["g6"]);
        // Reopened: still remembered.
        store = createResourceStore({ file, kinds });
        expect(store.applyChanges({ chats: [identified("k", base, ops, "g6", true)] }).chats[0]).toEqual(first);
        expect(text(store, "k", "a")).toBe("mine");
        // A physical backup carries the table; a restore from it starts without ids (the chats are
        // deleted, which cascades), and old tokens are refused by the new epoch anyway.
        const snapshot = path.join(dir, "snapshot.sqlite");
        await store.backupTo(snapshot);
        expect(rememberedIds(snapshot).map((row) => row.groupId)).toEqual(["g6"]);
        store.applyChanges({ chats: [identified("k", first.revision!, [note("after the backup")], "g7")] });
        store.replaceAll(store.readSnapshot(snapshot));
        store.close();
        expect(rememberedIds(file)).toEqual([]);
        store = createResourceStore({ file, kinds });
        expect(chat(store, "k")!.data.note).toBe("");
        // A snapshot from before the table restores as well.
        const older = path.join(dir, "older.sqlite");
        copyFileSync(snapshot, older);
        const olderDb = new DatabaseSync(older, { enableForeignKeyConstraints: false });
        olderDb.exec("DROP TABLE chatGroups");
        olderDb.close();
        const restoredBase = chat(store, "k")!.revision;
        store.applyChanges({ chats: [identified("k", restoredBase, [note("before the older restore")], "g8")] });
        store.replaceAll(store.readSnapshot(older));
        expect(chat(store, "k")!.data.note).toBe("");
        // Deleting the chat drops its ids with it (another incarnation under the id remembers none):
        // the old group's base names the old incarnation, so it conflicts instead of applying.
        const k = chat(store, "k")!.revision;
        store.applyChanges({ chats: [identified("k", k, ops, "g9")] });
        store.close();
        expect(rememberedIds(file).map((row) => row.groupId)).toEqual(["g9"]);
        store = createResourceStore({ file, kinds });
        const deleted = chat(store, "k")!.revision;
        store.applyChanges({ chats: [identified("k", deleted, [{ op: "delete" }], "g10")] });
        store.close();
        expect(rememberedIds(file)).toEqual([]);
        store = createResourceStore({ file, kinds });
        stores.push(store);
        const recreated = store.applyChanges({
            chats: [group("k", null, [{ op: "create", chat: { name: "K again", message: [m("a", "A")] } as never }])],
        }).chats[0];
        expect(conflictsOf(() => store.applyChanges({ chats: [identified("k", deleted, ops, "g9", true)] }))).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: recreated.revision },
        ]);
        expect(text(store, "k", "a")).toBe("A");
    });

    it("refuses a malformed groupId or retry before anything is written, naming the group", () => {
        const { store, base } = setup();
        const state = snapshotState(store);
        const writes = store.writeCount();
        const length = `groupId must be a string of 1 to 128 characters`;
        for (const [extra, message] of [
            [{ groupId: "" }, length],
            [{ groupId: "x".repeat(129) }, length],
            [{ groupId: 5 }, length],
            [{ groupId: null }, length],
            [{ retry: true }, "retry must be true and needs a groupId"],
            [{ groupId: "g", retry: false }, "retry must be true and needs a groupId"],
            [{ groupId: "g", retry: 1 }, "retry must be true and needs a groupId"],
        ] as [Record<string, unknown>, string][]) {
            rejects(
                () =>
                    store.applyChanges({
                        chats: [
                            group("k2", null, [{ op: "create", chat: {} as never }]),
                            { ...group("k", base, [note("x")]), ...extra } as never,
                        ],
                    }),
                `chats[1]: ${message}`,
            );
        }
        expect(snapshotState(store)).toBe(state);
        expect(store.writeCount()).toBe(writes);
        // The longest accepted id.
        expect(
            store.applyChanges({ chats: [identified("k", base, [note("x")], "x".repeat(128))] }).chats[0].revision,
        ).toBe(bumped(base, 1));
    });
});
