// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import { HIDDEN_HYDRATION_KINDS } from "../../../shared/jobs.ts";
import { MAX_FEED_PATCH_BYTES } from "../../../shared/resources.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import {
    CommittedWriteError,
    createResourceStore,
    JobTokenError,
    ResourceBatchConflictError,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";

// The publisher of the live updates: the resource store publishes one change set per committed
// outer write (`put`, `delete`, `applyChanges`, `transaction`) after the commit, with side effects
// (a character's order on create, its chats and order on delete), a record's final revision when it
// changed twice, nothing for a rolled-back write or a 409, and `replaceAll`'s new epoch after it is
// installed. The socket that carries it is in `events.test.ts`.

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
    it("delivers reentrant publications to every listener in publish order even when a listener throws", () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const feed = createChangeFeed();
        const seen: string[] = [];
        const failure = new Error("listener failed");
        feed.subscribe((event) => {
            seen.push(`a:${event.epoch}`);
            if (event.epoch === "e1") {
                feed.publish({ type: "epoch", epoch: "e2" });
                feed.publish({ type: "epoch", epoch: "e3" });
            }
        });
        feed.subscribe((event) => {
            seen.push(`throwing:${event.epoch}`);
            throw failure;
        });
        feed.subscribe((event) => {
            seen.push(`b:${event.epoch}`);
            if (event.epoch === "e1") feed.publish({ type: "epoch", epoch: "e4" });
        });

        expect(() => feed.publish({ type: "epoch", epoch: "e1" })).not.toThrow();
        expect(seen).toEqual([
            "a:e1",
            "throwing:e1",
            "b:e1",
            "a:e2",
            "throwing:e2",
            "b:e2",
            "a:e3",
            "throwing:e3",
            "b:e3",
            "a:e4",
            "throwing:e4",
            "b:e4",
        ]);
        expect(logged).toHaveBeenCalledTimes(4);
        for (const call of logged.mock.calls) expect(call).toContain(failure);
    });

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
    it("publishes an independently committed input write when the outer batch throws or rolls back", () => {
        for (const failure of ["input throw", "transaction rollback"] as const) {
            const { store, events } = setup();
            const before = store.get(ui, "main")!;
            let nestedRevision: string | null = null;
            expect(() =>
                store.applyChanges({
                    get ops() {
                        nestedRevision = store.put(modules, "main", [{ name: "nested" }], null).revision;
                        if (failure === "input throw") throw new Error("input failed");
                        return [
                            { kind: ui, id: "main", baseRevision: before.revision, data: { language: "de" } },
                            { kind: modules, id: "main", baseRevision: null, data: [] },
                        ];
                    },
                }),
            ).toThrow(failure === "input throw" ? "input failed" : ResourceBatchConflictError);

            expect(nestedRevision).not.toBeNull();
            expect(store.get(modules, "main")).toEqual({ revision: nestedRevision, data: [{ name: "nested" }] });
            expect(store.get(ui, "main")).toEqual(before);
            expect(events).toEqual([
                {
                    type: "change",
                    epoch: store.epoch(),
                    changes: { ...empty, resources: [{ kind: "modules", id: "main", revision: nestedRevision }] },
                },
            ]);
        }
    });

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
        // A by-id write carries its feed patch: the stored row after the write, from the revision before it.
        const stored = (
            store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data as {
                message: { chatId: string; data: string }[];
            }
        ).message;
        expect(stored.map((message) => [message.chatId, message.data])).toEqual([["a", "A2"]]);
        expect(events).toEqual([
            {
                type: "change",
                epoch: store.epoch(),
                changes: {
                    resources: [],
                    chats: [
                        {
                            characterId: "c",
                            id: "k",
                            revision: reordered.chats[0].revision,
                            patch: { baseRevision: k, messages: [{ after: null, message: stored[0] }], count: 1 },
                        },
                    ],
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

// A `patch` batch op publishes its change set entry with a `RecordFieldPatch` (`feedPatch`): every
// top-level field whose stored JSON value differs between the old and the new stored record
// (normalization included) and the base revision one write earlier. None (a plain ref) for a kind
// with `project`, a hidden hydration kind, a changed `__proto__`, or a patch over
// `MAX_FEED_PATCH_BYTES` (UTF-8 bytes of its JSON); nothing for a batch that rolls back.
describe("field patches in the feed", () => {
    const plain: ResourceKind = { name: "plain", schemaVersion: 1, normalize: (input) => input };
    /** A normalizer with side effects outside the patch: `temp` dropped, `count` derived. */
    const counted: ResourceKind = {
        name: "counted",
        schemaVersion: 1,
        normalize: (input) => {
            const out = { ...(input as Record<string, unknown>) };
            delete out.temp;
            out.count = Object.keys(out).filter((key) => key !== "count").length;
            return out;
        },
    };
    const masked: ResourceKind = {
        name: "masked",
        schemaVersion: 1,
        normalize: (input) => input,
        project: (data) => ({ ...(data as object), secret: "***" }),
    };
    const hidden: ResourceKind = { name: HIDDEN_HYDRATION_KINDS[0], schemaVersion: 1, normalize: (input) => input };
    /** A normalizer that stores an own `__proto__` key when asked to. */
    const proto: ResourceKind = {
        name: "proto",
        schemaVersion: 1,
        normalize: (input) => {
            const out = { ...(input as Record<string, unknown>) };
            if (out.addProto === true) {
                Object.defineProperty(out, "__proto__", {
                    value: 1,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            return out;
        },
    };
    function patchSetup() {
        const feed = createChangeFeed();
        const store = createResourceStore({
            file: ":memory:",
            kinds: createKindRegistry([plain, counted, masked, hidden, proto]),
            feed,
        });
        stores.push(store);
        const events: ChangeFeedEvent[] = [];
        feed.subscribe((event) => events.push(event));
        /** The resource entries of the one change published since the last call. */
        const published = () => {
            expect(events).toHaveLength(1);
            const [event] = events.splice(0);
            expect(event.type).toBe("change");
            return (event as Extract<ChangeFeedEvent, { type: "change" }>).changes.resources;
        };
        return { store, events, published };
    }
    const patch = (
        store: ResourceStore,
        kind: ResourceKind,
        id: string,
        fields: { set?: Record<string, unknown>; remove?: string[] },
    ) => store.applyBatch([{ kind, id, baseRevision: store.revisionOf(kind, id), patch: fields }])[0].revision!;

    it("carries exactly the fields whose stored value changed, normalization included, and the base one write earlier", () => {
        const { store, published } = patchSetup();
        const base = store.put(plain, "a", { same: 1, change: 2, drop: 3, deep: { k: [1] } }, null).revision;
        published();
        const next = patch(store, plain, "a", {
            set: { same: 1, change: 20, added: null, deep: { k: [1] } },
            remove: ["drop", "never-there"],
        });
        expect(next).toBe(base.replace(/:1$/, ":2"));
        expect(published()).toEqual([
            {
                kind: "plain",
                id: "a",
                revision: next,
                patch: { baseRevision: base, set: { change: 20, added: null }, remove: ["drop"] },
            },
        ]);
        expect(store.get(plain, "a")!.data).toEqual({ same: 1, change: 20, deep: { k: [1] }, added: null });

        // A patch that changes nothing still advances the revision: an empty patch, applied without a read.
        const unchanged = patch(store, plain, "a", { set: { change: 20 } });
        expect(published()).toEqual([
            { kind: "plain", id: "a", revision: unchanged, patch: { baseRevision: next, set: {}, remove: [] } },
        ]);

        // The normalizer's side effects are in the patch (`count`), a field it dropped is not (`temp`).
        const c = store.put(counted, "c", { x: 1 }, null).revision;
        published();
        const patched = patch(store, counted, "c", { set: { temp: "x", y: 2 } });
        expect(published()).toEqual([
            {
                kind: "counted",
                id: "c",
                revision: patched,
                patch: { baseRevision: c, set: { y: 2, count: 2 }, remove: [] },
            },
        ]);
        expect(store.get(counted, "c")!.data).toEqual({ x: 1, count: 2, y: 2 });
    });

    it("publishes a plain ref for a hidden hydration kind or a changed __proto__, without the data; a kind that projects takes no patch", () => {
        const { store, published, events } = patchSetup();
        store.put(hidden, "r", { secret: "value", n: 1 }, null);
        published();
        const next = patch(store, hidden, "r", { set: { n: 2, secret: "changed" } });
        expect(published()).toEqual([{ kind: hidden.name, id: "r", revision: next }]);
        expect(store.get(hidden, "r")!.data).toEqual({ secret: "changed", n: 2 });
        // A projecting kind's stored data never reaches a client, so a client could not patch it
        // against what it holds: the store refuses the op, and
        // nothing is published.
        const masking = store.put(masked, "r", { secret: "value", n: 1 }, null).revision;
        published();
        expect(() => patch(store, masked, "r", { set: { n: 2 } })).toThrow(
            new ResourceValidationError("ops[0]: masked takes no patch"),
        );
        expect(events).toEqual([]);
        expect(store.get(masked, "r")).toEqual({ revision: masking, data: { secret: "value", n: 1 } });
        store.put(proto, "p", { n: 1 }, null);
        published();
        const added = patch(store, proto, "p", { set: { addProto: true } });
        expect(published()).toEqual([{ kind: "proto", id: "p", revision: added }]);
        expect(Object.hasOwn(store.get(proto, "p")!.data as object, "__proto__")).toBe(true);
        // Unchanged afterwards: the own `__proto__` is kept as it was, so the patch names only `n`.
        const kept = patch(store, proto, "p", { set: { n: 2 } });
        expect(published()).toEqual([
            { kind: "proto", id: "p", revision: kept, patch: { baseRevision: added, set: { n: 2 }, remove: [] } },
        ]);
    });

    it("carries a patch up to 64 KiB of UTF-8 JSON and a plain ref above it", () => {
        const { store, published } = patchSetup();
        store.put(plain, "big", { n: 1 }, null);
        published();
        const base = store.revisionOf(plain, "big")!;
        const overhead = Buffer.byteLength(JSON.stringify({ baseRevision: base, set: { blob: "" }, remove: [] }));
        const atLimit = "a".repeat(MAX_FEED_PATCH_BYTES - overhead);
        const limit = patch(store, plain, "big", { set: { blob: atLimit } });
        expect(published()).toEqual([
            {
                kind: "plain",
                id: "big",
                revision: limit,
                patch: { baseRevision: base, set: { blob: atLimit }, remove: [] },
            },
        ]);
        const over = patch(store, plain, "big", { set: { blob: `${atLimit}b` } });
        expect(published()).toEqual([{ kind: "plain", id: "big", revision: over }]);
        // Bytes, not characters: a string shorter than the limit in characters but longer in UTF-8.
        const multibyte = "€".repeat(Math.ceil(MAX_FEED_PATCH_BYTES / 3));
        expect(multibyte.length).toBeLessThan(MAX_FEED_PATCH_BYTES);
        const wide = patch(store, plain, "big", { set: { blob: multibyte } });
        expect(published()).toEqual([{ kind: "plain", id: "big", revision: wide }]);
        expect(store.get(plain, "big")!.data).toEqual({ n: 1, blob: multibyte });
    });

    it("publishes nothing for a patch batch that rolls back: a stale chat group beside it, or a result the kind refuses", () => {
        const { store, events } = setup();
        store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [{ characterId: "c", chatId: "k", baseRevision: null, ops: [chatCreate("k")] }],
        });
        const k = store.chatRevision("c", "k")!;
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision: k, ops: [{ op: "meta", set: { name: "K2" } }] }],
        } as never);
        const before = store.get(characters, "c")!;
        events.length = 0;
        expect(() =>
            store.applyChanges({
                ops: [{ kind: characters, id: "c", baseRevision: before.revision, patch: { set: { name: "C2" } } }],
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: k,
                        ops: [{ op: "replace", chat: { id: "k", name: "K3", note: "", localLore: [], message: [] } }],
                    },
                ],
            } as never),
        ).toThrow(ResourceBatchConflictError);
        // The character normalizer refuses the result inside the transaction (`chaId` is the id).
        expect(() =>
            store.applyChanges({
                ops: [{ kind: characters, id: "c", baseRevision: before.revision, patch: { remove: ["chaId"] } }],
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: store.chatRevision("c", "k"),
                        ops: [{ op: "meta", set: { name: "K4" } }],
                    },
                ],
            } as never),
        ).toThrow(new ResourceValidationError("ops[0]: character.chaId must equal the resource id"));
        expect(events).toEqual([]);
        expect(store.get(characters, "c")).toEqual(before);
        expect(store.chatMeta("c", "k")!.data.name).toBe("K2");

        // A character patch (a send job's stamp) publishes the one field over the normalized record.
        const stamped = store.applyChanges(
            {
                ops: [
                    {
                        kind: characters,
                        id: "c",
                        baseRevision: before.revision,
                        patch: { set: { lastInteraction: 1234 } },
                    },
                ],
            },
            { epoch: store.epoch() },
        ).results[0].revision;
        expect(events).toEqual([
            {
                type: "change",
                epoch: store.epoch(),
                changes: {
                    resources: [
                        {
                            kind: "characters",
                            id: "c",
                            revision: stamped,
                            patch: { baseRevision: before.revision, set: { lastInteraction: 1234 }, remove: [] },
                        },
                    ],
                    chats: [],
                    chatOrders: [],
                },
            },
        ]);
    });
});

// An item `patch` op (`RecordItemPatch`, an array record with unique item ids such as
// `modules`) publishes what `diffItems` finds between the old and the stored list: a new item, or
// one whose `__proto__` changed, whole in `items`; another changed item's fields in `changes`; the
// id sequence in `order` when it changed. A plain ref over `MAX_FEED_PATCH_BYTES`; nothing for a
// batch the kind's normalizer refuses.
describe("item patches in the feed", () => {
    const list: ResourceKind = { name: "list", schemaVersion: 1, normalize: (input) => input };
    /** A normalizer with a side effect outside the patch: every item gets `count` = its field count. */
    const counted: ResourceKind = {
        name: "countedList",
        schemaVersion: 1,
        normalize: (input) =>
            (input as Record<string, unknown>[]).map((item) => ({
                ...item,
                count: Object.keys(item).filter((key) => key !== "count").length,
            })),
    };
    /** A normalizer that gives an item an own `__proto__` key when asked to. */
    const proto: ResourceKind = {
        name: "protoList",
        schemaVersion: 1,
        normalize: (input) =>
            (input as Record<string, unknown>[]).map((item) => {
                const out = { ...item };
                if (out.addProto === true) {
                    Object.defineProperty(out, "__proto__", {
                        value: 1,
                        enumerable: true,
                        writable: true,
                        configurable: true,
                    });
                }
                return out;
            }),
    };
    const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...extra });
    function itemSetup() {
        const feed = createChangeFeed();
        const store = createResourceStore({
            file: ":memory:",
            kinds: createKindRegistry([list, counted, proto, modules]),
            feed,
        });
        stores.push(store);
        const events: ChangeFeedEvent[] = [];
        feed.subscribe((event) => events.push(event));
        const published = () => {
            expect(events).toHaveLength(1);
            const [event] = events.splice(0);
            expect(event.type).toBe("change");
            return (event as Extract<ChangeFeedEvent, { type: "change" }>).changes.resources;
        };
        return { store, events, published };
    }
    const patch = (store: ResourceStore, kind: ResourceKind, id: string, body: unknown) =>
        store.applyBatch([{ kind, id, baseRevision: store.revisionOf(kind, id), patch: body }])[0].revision!;

    it("carries a changed item's fields, a new or __proto__-changed item whole, and the order when it changed, with the base one write earlier", () => {
        const { store, published } = itemSetup();
        const base = store.put(list, "l", [item("a", { n: 1 }), item("b"), item("c")], null).revision;
        published();
        // A field patch of one item, the same value set on another: only the changed field is carried.
        const first = patch(store, list, "l", {
            changes: [
                { id: "a", set: { n: 2, name: "a" }, remove: ["never-there"] },
                { id: "b", set: { name: "b" } },
            ],
        });
        expect(first).toBe(base.replace(/:1$/, ":2"));
        expect(published()).toEqual([
            {
                kind: "list",
                id: "l",
                revision: first,
                patch: { baseRevision: base, items: [], changes: [{ id: "a", set: { n: 2 }, remove: [] }] },
            },
        ]);
        // A whole item sent for an existing id is carried as its changed fields (the stored
        // difference, not the op's form); a new item whole; a dropped item only through the order.
        const second = patch(store, list, "l", {
            items: [{ id: "c", name: "c", replaced: true }, item("d")],
            order: ["d", "a", "c"],
        });
        expect(published()).toEqual([
            {
                kind: "list",
                id: "l",
                revision: second,
                patch: {
                    baseRevision: first,
                    items: [item("d")],
                    changes: [{ id: "c", set: { replaced: true }, remove: [] }],
                    order: ["d", "a", "c"],
                },
            },
        ]);
        // An order alone; a removal of a field; the same id sequence after a patch carries no order.
        const third = patch(store, list, "l", { order: ["a", "c", "d"] });
        expect(published()).toEqual([
            {
                kind: "list",
                id: "l",
                revision: third,
                patch: { baseRevision: second, items: [], changes: [], order: ["a", "c", "d"] },
            },
        ]);
        const fourth = patch(store, list, "l", { changes: [{ id: "c", remove: ["replaced"] }] });
        expect(published()).toEqual([
            {
                kind: "list",
                id: "l",
                revision: fourth,
                patch: { baseRevision: third, items: [], changes: [{ id: "c", set: {}, remove: ["replaced"] }] },
            },
        ]);
        // A patch that changes nothing still advances the revision: an empty patch.
        const unchanged = patch(store, list, "l", { changes: [{ id: "a", set: { n: 2 } }] });
        expect(published()).toEqual([
            { kind: "list", id: "l", revision: unchanged, patch: { baseRevision: fourth, items: [], changes: [] } },
        ]);
        // A cleared list.
        const cleared = patch(store, list, "l", { order: [] });
        expect(published()).toEqual([
            {
                kind: "list",
                id: "l",
                revision: cleared,
                patch: { baseRevision: unchanged, items: [], changes: [], order: [] },
            },
        ]);

        // The normalizer's side effects are in the patch: a new item with its `count`, a changed
        // item's `count` beside the changed field.
        const c = store.put(counted, "c", [item("a")], null).revision;
        published();
        const countedNext = patch(store, counted, "c", {
            items: [item("b")],
            changes: [{ id: "a", set: { extra: 1 } }],
            order: ["a", "b"],
        });
        expect(published()).toEqual([
            {
                kind: "countedList",
                id: "c",
                revision: countedNext,
                patch: {
                    baseRevision: c,
                    items: [{ id: "b", name: "b", count: 2 }],
                    changes: [{ id: "a", set: { extra: 1, count: 3 }, remove: [] }],
                    order: ["a", "b"],
                },
            },
        ]);

        // An item whose own `__proto__` changed goes whole (a field patch never names it); the whole
        // record still carries a patch, unlike a changed top-level `__proto__` of an object record.
        const p = store.put(proto, "p", [item("a"), item("b")], null).revision;
        published();
        const added = patch(store, proto, "p", { changes: [{ id: "a", set: { addProto: true } }] });
        const [entry] = published();
        expect(entry).toMatchObject({ kind: "protoList", id: "p", revision: added });
        const carried = (entry as { patch: { baseRevision: string; items: object[]; changes: unknown[] } }).patch;
        expect(carried.baseRevision).toBe(p);
        expect(carried.changes).toEqual([]);
        expect(carried.items).toHaveLength(1);
        expect(Object.hasOwn(carried.items[0], "__proto__")).toBe(true);
        expect(carried.items[0]).toMatchObject({ id: "a", addProto: true });
        // Unchanged afterwards: the own `__proto__` is kept, so a later change names only its field.
        const kept = patch(store, proto, "p", { changes: [{ id: "a", set: { n: 2 } }] });
        expect(published()).toEqual([
            {
                kind: "protoList",
                id: "p",
                revision: kept,
                patch: { baseRevision: added, items: [], changes: [{ id: "a", set: { n: 2 }, remove: [] }] },
            },
        ]);
    });

    it("carries an item patch up to 64 KiB and a plain ref above it, and publishes nothing for a modules patch the normalizer refuses", () => {
        const { store, published, events } = itemSetup();
        store.put(list, "big", [item("a")], null);
        published();
        const base = store.revisionOf(list, "big")!;
        const overhead = Buffer.byteLength(
            JSON.stringify({ baseRevision: base, items: [], changes: [{ id: "a", set: { blob: "" }, remove: [] }] }),
        );
        const atLimit = "a".repeat(MAX_FEED_PATCH_BYTES - overhead);
        const limit = patch(store, list, "big", { changes: [{ id: "a", set: { blob: atLimit } }] });
        expect(published()).toEqual([
            {
                kind: "list",
                id: "big",
                revision: limit,
                patch: { baseRevision: base, items: [], changes: [{ id: "a", set: { blob: atLimit }, remove: [] }] },
            },
        ]);
        const over = patch(store, list, "big", { changes: [{ id: "a", set: { blob: `${atLimit}b` } }] });
        expect(published()).toEqual([{ kind: "list", id: "big", revision: over }]);
        expect(store.get(list, "big")!.data).toEqual([{ id: "a", name: "a", blob: `${atLimit}b` }]);

        // The real `modules` kind: a patched module with a non-string name is refused inside the
        // transaction, with the other op, and nothing is published.
        const m = store.put(modules, "main", [item("a"), item("b")], null).revision;
        published();
        expect(() =>
            store.applyBatch([
                { kind: list, id: "other", baseRevision: null, data: [] },
                { kind: modules, id: "main", baseRevision: m, patch: { changes: [{ id: "a", set: { name: 1 } }] } },
            ]),
        ).toThrow(new ResourceValidationError("ops[1]: modules[0]: a module's name must be a string"));
        expect(events).toEqual([]);
        expect(store.get(modules, "main")).toEqual({ revision: m, data: [item("a"), item("b")] });
        expect(store.get(list, "other")).toBeNull();
        // The same kind, a valid patch: carried as the changed fields.
        const renamed = patch(store, modules, "main", { changes: [{ id: "b", set: { name: "B" } }] });
        expect(published()).toEqual([
            {
                kind: "modules",
                id: "main",
                revision: renamed,
                patch: { baseRevision: m, items: [], changes: [{ id: "b", set: { name: "B" }, remove: [] }] },
            },
        ]);
    });
});

// A generation job's write runs `committed` after the commit and before the change is
// published, and the lists it returns ride on that change as `streaming`; a job's end publishes
// its released locks without a write (`publishStreaming`).
describe("the store publishes generation locks", () => {
    const lockOf = (messageId: string, generationId: string, seq = 0) => [
        { characterId: "c", id: "k", streaming: [{ messageId, generationId, seq }] },
    ];
    const setupChat = () => {
        const context = setup();
        context.store.put(characters, "c", { chaId: "c", name: "C" }, null);
        context.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [chatCreate("k", [{ chatId: "r", data: "", role: "char" }])],
                },
            ],
        });
        context.lock.addToken("T");
        context.events.length = 0;
        return context;
    };
    const change = (event: ChangeFeedEvent | undefined) => {
        if (event?.type !== "change") throw new Error("expected a committed change");
        return event;
    };

    it("runs `committed` after the commit and before publication, and the published change carries its lists", () => {
        const { store, events } = setupChat();
        let hookSaw: { revision: string | null; published: number } | null = null;
        const applied = store.applyChanges(
            {
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: store.chatRevision("c", "k"),
                        ops: [{ op: "setText", id: "r", text: "one", generation: { id: "g1", seq: 1 } }],
                    },
                ],
            },
            {
                epoch: store.epoch(),
                jobToken: "T",
                committed: (result) => {
                    // The write is committed when the hook runs (the store's revision is the write's),
                    // and nothing was published yet.
                    hookSaw = { revision: store.chatRevision("c", "k"), published: events.length };
                    expect(result.chats[0].revision).toBe(store.chatRevision("c", "k"));
                    return lockOf("r", "g1", 1);
                },
            },
        );
        expect(hookSaw).toEqual({ revision: applied.chats[0].revision, published: 0 });
        expect(events).toHaveLength(1);
        expect(change(events[0])).toEqual({
            type: "change",
            epoch: store.epoch(),
            changes: {
                resources: [],
                chats: [expect.objectContaining({ characterId: "c", id: "k", revision: applied.chats[0].revision })],
                chatOrders: [],
            },
            streaming: lockOf("r", "g1", 1),
        });
        // A write whose hook returns no lists publishes a plain change (no `streaming` key at all).
        events.length = 0;
        store.applyChanges(
            {
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: store.chatRevision("c", "k"),
                        ops: [{ op: "setText", id: "r", text: "two", generation: { id: "g1", seq: 2, final: true } }],
                    },
                ],
            },
            { epoch: store.epoch(), jobToken: "T", committed: () => [] },
        );
        expect(Object.keys(change(events[0]))).toEqual(["type", "epoch", "changes"]);
    });

    it("runs `committed` without a feed attached (the job's bookkeeping does not depend on one)", () => {
        const lock = createGenerationLock();
        const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
        stores.push(store);
        store.put(characters, "c", { chaId: "c", name: "C" }, null);
        lock.addToken("T");
        const committed = vi.fn(() => lockOf("r", "g1"));
        store.applyChanges(
            { chats: [{ characterId: "c", chatId: "k", baseRevision: null, ops: [chatCreate("k")] }] },
            { epoch: store.epoch(), jobToken: "T", committed },
        );
        expect(committed).toHaveBeenCalledTimes(1);
        expect(store.chatRevision("c", "k")).not.toBeNull();
    });

    it("a `committed` that throws: the change is still published without lists, the write stands, and `CommittedWriteError` carries the cause", () => {
        const { store, events } = setupChat();
        const base = store.chatRevision("c", "k")!;
        const failure = new Error("bookkeeping failed");
        expect(() =>
            store.applyChanges(
                {
                    chats: [
                        {
                            characterId: "c",
                            chatId: "k",
                            baseRevision: base,
                            ops: [{ op: "setText", id: "r", text: "one" }],
                        },
                    ],
                },
                {
                    epoch: store.epoch(),
                    jobToken: "T",
                    committed: () => {
                        throw failure;
                    },
                },
            ),
        ).toThrow(CommittedWriteError);
        const revision = store.chatRevision("c", "k")!;
        expect(revision).not.toBe(base);
        expect(events).toHaveLength(1);
        expect(change(events[0]).changes.chats).toEqual([expect.objectContaining({ id: "k", revision })]);
        expect(change(events[0])).not.toHaveProperty("streaming");
        // The marker never fails to construct, whatever was thrown: the cause is kept untouched.
        for (const cause of [failure, Object.create(null), "text", undefined]) {
            let caught: unknown;
            try {
                store.applyChanges(
                    {
                        chats: [
                            {
                                characterId: "c",
                                chatId: "k",
                                baseRevision: store.chatRevision("c", "k"),
                                ops: [{ op: "meta", set: { note: String(Math.random()) } }],
                            },
                        ],
                    } as never,
                    {
                        epoch: store.epoch(),
                        jobToken: "T",
                        committed: () => {
                            throw cause;
                        },
                    },
                );
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(CommittedWriteError);
            expect((caught as CommittedWriteError).cause).toBe(cause);
            expect((caught as CommittedWriteError).message).toBe("The write committed, but its follow-up failed");
        }
        // A conflict (a stale whole-chat replace) throws before the hook: nothing published, the hook never ran.
        events.length = 0;
        const committed = vi.fn(() => lockOf("r", "g1"));
        expect(() =>
            store.applyChanges(
                {
                    chats: [
                        {
                            characterId: "c",
                            chatId: "k",
                            baseRevision: base,
                            ops: [
                                { op: "replace", chat: { id: "k", name: "x", note: "", localLore: [], message: [] } },
                            ],
                        },
                    ],
                } as never,
                { epoch: store.epoch(), jobToken: "T", committed },
            ),
        ).toThrow(ResourceBatchConflictError);
        expect(committed).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });

    it("`publishStreaming` publishes a change with no refs, nothing for an empty list, and folds into an open transaction (gone with its rollback)", () => {
        const { store, events } = setupChat();
        store.publishStreaming([]);
        expect(events).toEqual([]);
        store.publishStreaming([{ characterId: "c", id: "k", streaming: [] }]);
        expect(events).toEqual([
            {
                type: "change",
                epoch: store.epoch(),
                changes: empty,
                streaming: [{ characterId: "c", id: "k", streaming: [] }],
            },
        ]);
        events.length = 0;
        // Inside a transaction: one frame, the write's refs with the lists; the last list of a chat wins.
        store.transaction(() => {
            store.publishStreaming(lockOf("r", "g1"));
            store.put(ui, "main", { language: "de" }, store.get(ui, "main")!.revision);
            store.publishStreaming(lockOf("r", "g2"));
            expect(events).toEqual([]);
        });
        expect(events).toHaveLength(1);
        expect(change(events[0]).changes.resources).toEqual([expect.objectContaining({ kind: "ui", id: "main" })]);
        expect(change(events[0]).streaming).toEqual(lockOf("r", "g2"));
        events.length = 0;
        expect(() =>
            store.transaction(() => {
                store.publishStreaming(lockOf("r", "g3"));
                throw new Error("rolled back");
            }),
        ).toThrow("rolled back");
        expect(events).toEqual([]);
    });
});
