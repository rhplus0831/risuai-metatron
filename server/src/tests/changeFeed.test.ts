// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    createResourceStore,
    JobTokenError,
    ResourceBatchConflictError,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";

// The publisher of the live updates (Phase 6 slice 2): the resource store publishes one change set
// per committed outer write (`put`, `delete`, `applyChanges`, `transaction`) after the commit, with
// side effects (a character's order on create, its chats and order on delete), a record's final
// revision when it changed twice, nothing for a rolled-back write or a 409, and `replaceAll`'s new
// epoch after it is installed. The socket that carries it is in `events.test.ts`.

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;
const modules = kinds.get("modules")!;
const plugins = kinds.get("plugins")!;
const ui = kinds.get("ui")!;

const stores: ResourceStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    vi.restoreAllMocks();
});

function setup() {
    const feed = createChangeFeed();
    const lock = createGenerationLock();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock, feed });
    stores.push(store);
    const events: ChangeFeedEvent[] = [];
    feed.subscribe((event) => events.push(event));
    return { feed, lock, store, events };
}

const chatCreate = (id: string, messages: { chatId: string; data: string; role: "user" | "char" }[] = []): ChatOp =>
    ({ op: "create", chat: { id, name: id, note: "", localLore: [], message: messages } }) as never;
const empty = { resources: [], chats: [], chatOrders: [] };

describe("the change feed", () => {
    it("delivers to every listener, removes one on unsubscribe, and keeps going when a listener throws", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const feed = createChangeFeed();
        const seen: string[] = [];
        feed.subscribe(() => {
            throw new Error("listener failed");
        });
        const off = feed.subscribe((event) => seen.push(`a:${event.epoch}`));
        feed.subscribe((event) => seen.push(`b:${event.epoch}`));
        feed.publish({ type: "epoch", epoch: "e1" });
        off();
        feed.publish({ type: "epoch", epoch: "e2" });
        expect(seen).toEqual(["a:e1", "b:e1", "b:e2"]);
        expect(console.error).toHaveBeenCalledTimes(2);
    });
});

describe("the store publishes committed changes", () => {
    it("publishes a put's create and update with their revisions, after the commit (a listener reads and writes the committed state)", () => {
        const { feed, store, events } = setup();
        const observed: (string | null)[] = [];
        let wrote = false;
        feed.subscribe((event) => {
            observed.push(store.get(modules, "main")?.revision ?? null);
            if (!wrote) {
                // Outside the write's transaction and scope: a listener's own write commits and publishes.
                wrote = true;
                store.put(ui, "main", { language: "de" }, store.get(ui, "main")!.revision);
            }
        });
        const created = store.put(modules, "main", [{ name: "a" }], null).revision;
        expect(events[0]).toEqual({
            type: "change",
            epoch: store.epoch(),
            changes: { ...empty, resources: [{ kind: "modules", id: "main", revision: created }] },
        });
        expect(observed[0]).toBe(created);
        // The listener's write published after the first event.
        expect(events[1]).toMatchObject({ changes: { resources: [{ kind: "ui", id: "main" }] } });
        const updated = store.put(modules, "main", [{ name: "b" }], created).revision;
        expect(events.at(-1)).toEqual({
            type: "change",
            epoch: store.epoch(),
            changes: { ...empty, resources: [{ kind: "modules", id: "main", revision: updated }] },
        });
    });

    it("publishes nothing for a put or delete that conflicts", () => {
        const { store, events } = setup();
        const first = store.put(modules, "main", [], null).revision;
        store.put(modules, "main", [{ name: "x" }], first);
        events.length = 0;
        expect(() => store.put(modules, "main", [], first)).toThrow(ResourceConflictError);
        expect(() => store.put(modules, "main", [], null)).toThrow(ResourceConflictError);
        expect(() => store.delete(characters, "missing", first)).toThrow(ResourceConflictError);
        expect(() => store.put(modules, "other", [], null)).toThrow(ResourceValidationError);
        expect(events).toEqual([]);
    });

    it("publishes a character's create with its new chat order, and its delete with every chat and the order", () => {
        const { store, events } = setup();
        const created = store.put(characters, "c", { chaId: "c", name: "C" }, null).revision;
        const order = store.readRefs([], { chatCollections: ["c"] }).chatCollections[0].order!;
        expect(events.at(-1)).toEqual({
            type: "change",
            epoch: store.epoch(),
            changes: {
                resources: [{ kind: "characters", id: "c", revision: created }],
                chats: [],
                chatOrders: [{ characterId: "c", revision: order.revision }],
            },
        });
        store.applyChanges({
            chats: [
                { characterId: "c", chatId: "k", baseRevision: null, ops: [chatCreate("k")] },
                { characterId: "c", chatId: "j", baseRevision: null, ops: [chatCreate("j")] },
            ],
        });
        events.length = 0;
        store.delete(characters, "c", created);
        expect(events).toHaveLength(1);
        const changes = (events[0] as Extract<ChangeFeedEvent, { type: "change" }>).changes;
        expect(changes.resources).toEqual([{ kind: "characters", id: "c", revision: null }]);
        expect(changes.chats).toEqual(
            expect.arrayContaining([
                { characterId: "c", id: "k", revision: null },
                { characterId: "c", id: "j", revision: null },
            ]),
        );
        expect(changes.chats).toHaveLength(2);
        expect(changes.chatOrders).toEqual([{ characterId: "c", revision: null }]);
    });

    it("publishes a batch's resources, chat groups, and final order revisions; a batch deleting a character cascades", () => {
        const { store, events } = setup();
        const applied = store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [chatCreate("k", [{ chatId: "a", data: "A", role: "user" }])],
                },
                { characterId: "c", chatId: "j", baseRevision: null, ops: [chatCreate("j")] },
            ],
        });
        const order = store.readRefs([], { chatCollections: ["c"] }).chatCollections[0].order!;
        expect(events).toEqual([
            {
                type: "change",
                epoch: store.epoch(),
                changes: {
                    resources: [{ kind: "characters", id: "c", revision: applied.results[0].revision }],
                    chats: applied.chats.map((chat) => ({
                        characterId: "c",
                        id: chat.id,
                        revision: chat.revision,
                    })),
                    // The order the character's create made, then the creates: one entry, the final revision.
                    chatOrders: [{ characterId: "c", revision: order.revision }],
                },
            },
        ]);
        events.length = 0;
        const k = store.chatRevision("c", "k")!;
        const reordered = store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision: k, ops: [{ op: "setText", id: "a", text: "A2" }] }],
            chatOrders: [{ characterId: "c", baseRevision: order.revision, ids: ["j", "k"] }],
        });
        expect(events).toEqual([
            {
                type: "change",
                epoch: store.epoch(),
                changes: {
                    resources: [],
                    chats: [{ characterId: "c", id: "k", revision: reordered.chats[0].revision }],
                    chatOrders: [{ characterId: "c", revision: reordered.chatOrders[0].revision }],
                },
            },
        ]);
        events.length = 0;
        const character = store.get(characters, "c")!.revision;
        store.applyChanges({ ops: [{ kind: characters, id: "c", baseRevision: character, delete: true }] });
        const changes = (events[0] as Extract<ChangeFeedEvent, { type: "change" }>).changes;
        expect(changes.resources).toEqual([{ kind: "characters", id: "c", revision: null }]);
        expect(changes.chats).toEqual(
            expect.arrayContaining([
                { characterId: "c", id: "k", revision: null },
                { characterId: "c", id: "j", revision: null },
            ]),
        );
        expect(changes.chatOrders).toEqual([{ characterId: "c", revision: null }]);
    });

    it("publishes nothing for a batch with an applied op and a stale one (409), a stale chat group, or an invalid batch", () => {
        const { store, events } = setup();
        const stale = store.put(modules, "main", [], null).revision;
        store.put(modules, "main", [{ name: "newer" }], stale);
        store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [{ characterId: "c", chatId: "k", baseRevision: null, ops: [chatCreate("k")] }],
        });
        const k = store.chatRevision("c", "k")!;
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision: k, ops: [{ op: "meta", set: { name: "K2" } }] }],
        } as never);
        events.length = 0;
        expect(() =>
            store.applyChanges({
                ops: [
                    { kind: ui, id: "main", baseRevision: store.get(ui, "main")!.revision, data: { language: "fr" } },
                    { kind: modules, id: "main", baseRevision: stale, data: [] },
                ],
            }),
        ).toThrow(ResourceBatchConflictError);
        expect(() =>
            store.applyChanges({
                ops: [{ kind: plugins, id: "main", baseRevision: null, data: [] }],
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: k,
                        ops: [{ op: "replace", chat: { id: "k", name: "x", note: "", localLore: [], message: [] } }],
                    },
                ],
            } as never),
        ).toThrow(ResourceBatchConflictError);
        expect(() => store.applyChanges({ ops: [{ kind: characters, id: "", baseRevision: null, data: [] }] })).toThrow(
            ResourceValidationError,
        );
        expect(events).toEqual([]);
        expect(store.get(plugins, "main")).toBeNull();
    });

    it("publishes a job's in-process write with a live token, and nothing for an expired token or another epoch", () => {
        const { lock, store, events } = setup();
        store.put(characters, "c", { chaId: "c", name: "C" }, null);
        events.length = 0;
        lock.addToken("T");
        const applied = store.applyChanges(
            { chats: [{ characterId: "c", chatId: "k", baseRevision: null, ops: [chatCreate("k")] }] },
            { epoch: store.epoch(), jobToken: "T" },
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            changes: { chats: [{ characterId: "c", id: "k", revision: applied.chats[0].revision }] },
        });
        lock.endJob("T");
        events.length = 0;
        expect(() =>
            store.applyChanges(
                { chats: [{ characterId: "c", chatId: "j", baseRevision: null, ops: [chatCreate("j")] }] },
                { epoch: store.epoch(), jobToken: "T" },
            ),
        ).toThrow(JobTokenError);
        expect(() =>
            store.applyChanges(
                { chats: [{ characterId: "c", chatId: "j", baseRevision: null, ops: [chatCreate("j")] }] },
                { epoch: "another" },
            ),
        ).toThrow();
        expect(events).toEqual([]);
    });

    it("publishes a transaction once after its commit with each record's final revision", () => {
        const { store, events } = setup();
        let insideCount = -1;
        const result = store.transaction(() => {
            const a = store.put(modules, "main", [{ name: "1" }], null).revision;
            store.put(modules, "main", [{ name: "2" }], a);
            store.put(characters, "c", { chaId: "c", name: "C" }, null);
            insideCount = events.length;
            return "ok";
        });
        expect(result).toBe("ok");
        expect(insideCount).toBe(0);
        expect(events).toHaveLength(1);
        const order = store.readRefs([], { chatCollections: ["c"] }).chatCollections[0].order!;
        expect(events[0]).toEqual({
            type: "change",
            epoch: store.epoch(),
            changes: {
                resources: [
                    { kind: "modules", id: "main", revision: store.get(modules, "main")!.revision },
                    { kind: "characters", id: "c", revision: store.get(characters, "c")!.revision },
                ],
                chats: [],
                chatOrders: [{ characterId: "c", revision: order.revision }],
            },
        });
    });

    it("publishes nothing for a transaction that rolls back: a thrown body, or an inner success then a caught conflict", () => {
        const { store, events } = setup();
        const base = store.put(modules, "main", [], null).revision;
        store.put(modules, "main", [{ name: "newer" }], base);
        events.length = 0;
        expect(() =>
            store.transaction(() => {
                store.put(plugins, "main", [], null);
                throw new Error("body failed");
            }),
        ).toThrow("body failed");
        expect(() =>
            store.transaction(() => {
                store.put(plugins, "main", [], null);
                try {
                    store.put(modules, "main", [], base);
                } catch {
                    // Caught: the transaction still fails with the conflict and rolls back.
                }
                return "swallowed";
            }),
        ).toThrow(ResourceConflictError);
        expect(store.get(plugins, "main")).toBeNull();
        expect(events).toEqual([]);
        // The store publishes again afterwards (the scope was cleared).
        store.put(plugins, "main", [], null);
        expect(events).toHaveLength(1);
    });

    it("keeps a committed write when a listener throws", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { feed, store, events } = setup();
        feed.subscribe(() => {
            throw new Error("listener failed");
        });
        const saved = store.put(modules, "main", [{ name: "kept" }], null);
        expect(store.get(modules, "main")).toEqual({ revision: saved.revision, data: [{ name: "kept" }] });
        expect(events).toHaveLength(1);
    });

    it("publishes `replaceAll`'s new epoch after it is installed, and later changes carry it", () => {
        const { feed, store, events } = setup();
        const before = store.epoch();
        const installed: string[] = [];
        feed.subscribe((event) => {
            if (event.type === "epoch") {
                installed.push(store.epoch());
            }
        });
        const next = store.replaceAll({ rows: [], chats: [], messages: [], chatOrders: [] } as never);
        expect(next).not.toBe(before);
        expect(events.filter((event) => event.type === "epoch")).toEqual([{ type: "epoch", epoch: next }]);
        expect(installed).toEqual([next]);
        events.length = 0;
        store.put(modules, "main", [], null);
        expect(events[0]).toMatchObject({ type: "change", epoch: next });
    });

    it("lists every record's, chat's, and order's current revision without data", () => {
        const { store } = setup();
        const p = store.put(modules, "main", [], null).revision;
        const applied = store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [{ characterId: "c", chatId: "k", baseRevision: null, ops: [chatCreate("k")] }],
        });
        const listing = store.listRevisions();
        expect(listing.epoch).toBe(store.epoch());
        expect(listing.resources).toEqual(
            expect.arrayContaining([
                { kind: "modules", id: "main", revision: p },
                { kind: "characters", id: "c", revision: applied.results[0].revision },
            ]),
        );
        expect(listing.resources.every((entry) => Object.keys(entry).sort().join() === "id,kind,revision")).toBe(true);
        expect(listing.chats).toEqual([{ characterId: "c", id: "k", revision: applied.chats[0].revision }]);
        expect(listing.chatOrders).toEqual([
            {
                characterId: "c",
                revision: store.readRefs([], { chatCollections: ["c"] }).chatCollections[0].order!.revision,
            },
        ]);
    });
});
