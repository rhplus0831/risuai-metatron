// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    type ChatInvalidation,
    CommittedWriteError,
    createResourceStore,
    ResourceBatchConflictError,
    ResourceConflictError,
    type ResourceStore,
    ResourceStoreClosedError,
    ResourceValidationError,
} from "../data/resourceStore.ts";

// A chat's source generation: an in-memory value the store changes once in the commit of every
// write that deletes the chat (a group `delete`), replaces it whole (a group `replace`), or deletes
// its character (the cascade), and in no other write; `onChatInvalidated` notices follow the commit
// and the feed publication, never a rollback; `replaceAll` gives every chat a new value.

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;

const stores: ResourceStore[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
});

const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const group = (chatId: string, baseRevision: string | null, ops: ChatOp[], characterId = "c") => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});
const createCharacter = (id: string) => ({ kind: characters, id, baseRevision: null, data: { chaId: id } });
const memoryTail = { summaries: [{ text: "s1", chatMemos: ["a", "b"] }], lastSelectedSummaries: [0] };
const kBody = { name: "K", message: [m("a", "A"), m("b", "B"), m("c", "C")], hypaV3Data: memoryTail };
const create = (body: Record<string, unknown> = { name: "" }): ChatOp => ({ op: "create", chat: body }) as never;
const replace = (body: Record<string, unknown> = kBody): ChatOp => ({ op: "replace", chat: body }) as never;
const del: ChatOp = { op: "delete" };
const note = (value: string): ChatOp => ({ op: "meta", set: { note: value } });

/**
 * A store on a temp dir (with a feed unless `feed: false`) holding character `c` with chats `k`
 * (a, b, c and a memory tail), `k2`, and `k3`, and character `d` with chat `x`; every notice and
 * feed event is collected, and `log` interleaves what the tests' listeners saw.
 */
function setup(options: { feed?: boolean } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-chat-source-"));
    dirs.push(dir);
    const feed = options.feed === false ? undefined : createChangeFeed();
    const store = createResourceStore({ file: path.join(dir, "live.sqlite"), kinds, feed });
    stores.push(store);
    const events: ChangeFeedEvent[] = [];
    const log: string[] = [];
    feed?.subscribe((event) => {
        events.push(event);
        log.push(event.type === "change" ? `feed:${event.changes.chats.map((c) => c.id).join(",")}` : "feed:epoch");
    });
    const notices: ChatInvalidation[] = [];
    store.onChatInvalidated((notice) => {
        notices.push(notice);
        log.push(`notice:${notice.id}`);
    });
    store.applyChanges({
        ops: [createCharacter("c"), createCharacter("d")],
        chats: [
            group("k", null, [create(kBody)]),
            group("k2", null, [create()]),
            group("k3", null, [create()]),
            group("x", null, [create()], "d"),
        ],
    });
    // The seed's own publication is not part of any test.
    events.length = 0;
    log.length = 0;
    const rev = (id: string, characterId = "c") => store.chatRevision(characterId, id)!;
    /** A token of another chat incarnation: every op conflicts on it (a stale revision alone is allowed for by-id ops). */
    const wrongSeq = (token: string) => token.replace(/:\d+:(\d+)$/, ":999999:$1");
    const gen = (id: string, characterId = "c") => store.chatSourceGeneration(characterId, id);
    const characterRevision = (id: string) => store.get(characters, id)!.revision;
    /** The generations of every seeded chat, as `[k, k2, k3, x]`. */
    const gens = () => [gen("k"), gen("k2"), gen("k3"), gen("x", "d")];
    const write = (chatId: string, ops: ChatOp[], characterId = "c") =>
        store.applyChanges({ chats: [group(chatId, rev(chatId, characterId), ops, characterId)] }).chats[0];
    return { dir, store, feed, events, notices, log, rev, gen, gens, characterRevision, write, wrongSeq };
}

const ids = (notices: ChatInvalidation[]) => notices.map((n) => n.id);

describe("writes that advance a chat's source generation", () => {
    it("a group `delete` advances the chat once and notifies once, after the commit and the feed publication", () => {
        const { store, events, notices, gen, gens, rev, write } = setup();
        const before = gens();
        let seen: { gen: number; revision: string | null; events: number } | null = null;
        store.onChatInvalidated((notice) => {
            // The listener reads the committed state and the generation the notice carries.
            seen = {
                gen: store.chatSourceGeneration("c", notice.id),
                revision: store.chatRevision("c", "k"),
                events: events.length,
            };
        });
        write("k", [del]);
        expect(notices).toEqual([{ epoch: store.epoch(), characterId: "c", id: "k", sourceGeneration: gen("k") }]);
        expect(gen("k")).not.toBe(before[0]);
        expect(seen).toEqual({ gen: gen("k"), revision: null, events: 1 });
        expect(gens().slice(1)).toEqual(before.slice(1));
        // The deleted chat has no revision but keeps its generation.
        expect(store.chatRevision("c", "k")).toBeNull();
    });

    it("a group `replace` keeping the same message ids, texts, and memory tail advances it", () => {
        const { store, notices, gen, write } = setup();
        const before = store.readChatSource("c", "k");
        write("k", [replace()]);
        const after = store.readChatSource("c", "k");
        expect(after.data!.message.map((x) => [x.chatId, x.data])).toEqual(
            before.data!.message.map((x) => [x.chatId, x.data]),
        );
        expect(after.data!.hypaV3Data).toEqual(memoryTail);
        expect(after.revision).not.toBe(before.revision);
        expect(after.sourceGeneration).not.toBe(before.sourceGeneration);
        expect(after.sourceGeneration).toBe(gen("k"));
        expect(ids(notices)).toEqual(["k"]);
        expect(notices[0].sourceGeneration).toBe(after.sourceGeneration);
    });

    it("a character delete advances every chat of that character: `delete`, a batch op, and inside `transaction`", () => {
        const { store, notices, gens, characterRevision } = setup();
        const before = gens();
        store.delete(characters, "d", characterRevision("d"));
        expect(ids(notices)).toEqual(["x"]);
        expect(gens().slice(0, 3)).toEqual(before.slice(0, 3));
        expect(notices[0]).toEqual({ epoch: store.epoch(), characterId: "d", id: "x", sourceGeneration: gens()[3] });
        store.applyChanges({ ops: [createCharacter("e")], chats: [group("y", null, [create()], "e")] });
        store.applyChanges({
            ops: [{ kind: characters, id: "e", baseRevision: characterRevision("e"), delete: true }],
        });
        expect(ids(notices)).toEqual(["x", "y"]);
        expect(store.chatSourceGeneration("e", "y")).toBe(notices[1].sourceGeneration);
        store.transaction(() => {
            store.delete(characters, "c", characterRevision("c"));
            // Not advanced before the commit.
            expect(gens().slice(0, 3)).toEqual(before.slice(0, 3));
        });
        expect(ids(notices)).toEqual(["x", "y", "k", "k2", "k3"]);
        expect(gens().slice(0, 3)).toEqual(notices.slice(2).map((n) => n.sourceGeneration));
        expect(new Set(notices.map((n) => n.sourceGeneration)).size).toBe(5);
    });

    it("a batch advances only the chat it deletes or replaces; several `replace` ops in one group advance once, separate commits separately", () => {
        const { store, notices, gen, gens, rev } = setup();
        const before = gens();
        store.applyChanges({
            chats: [
                group("k", rev("k"), [note("n1")]),
                group("k2", rev("k2"), [del]),
                group("k3", rev("k3"), [{ op: "append", messages: [m("z", "Z")], anchor: { end: true } }]),
            ],
        });
        expect(ids(notices)).toEqual(["k2"]);
        expect(gens()).toEqual([before[0], gen("k2"), before[2], before[3]]);
        store.applyChanges({ chats: [group("k", rev("k"), [replace(), replace({ name: "R", message: [] })])] });
        expect(ids(notices)).toEqual(["k2", "k"]);
        const once = gen("k");
        store.applyChanges({ chats: [group("k", rev("k"), [replace()])] });
        store.applyChanges({ chats: [group("k", rev("k"), [replace()])] });
        expect(ids(notices)).toEqual(["k2", "k", "k", "k"]);
        expect(notices.slice(1).map((n) => n.sourceGeneration)).toEqual([once, once + 1, once + 2]);
        expect(gen("k")).toBe(once + 2);
    });

    it("`meta`, `setText`, `append`, `remove`, a `create`, and a remembered group's replay advance nothing and notify nothing", () => {
        const { store, notices, gens, rev, write } = setup();
        const before = gens();
        write("k", [note("n"), { op: "setText", id: "a", text: "A2" }]);
        write("k", [
            { op: "append", messages: [m("z", "Z")], anchor: { end: true } },
            { op: "remove", ids: ["b"] },
        ]);
        store.applyChanges({ chats: [group("k4", null, [create()])] });
        expect(gens()).toEqual(before);
        expect(store.chatSourceGeneration("c", "k4")).toBe(before[1]);
        // A replayed group (its answer was lost) is answered as it was and applies nothing.
        const base = rev("k");
        const first = store.applyChanges({ chats: [{ ...group("k", base, [replace()]), groupId: "g1" }] }).chats[0];
        const advanced = gens();
        expect(ids(notices)).toEqual(["k"]);
        expect(
            store.applyChanges({ chats: [{ ...group("k", base, [replace()]), groupId: "g1", retry: true }] }).chats[0],
        ).toEqual(first);
        expect(gens()).toEqual(advanced);
        expect(ids(notices)).toEqual(["k"]);
    });
});

describe("rolled-back writes", () => {
    it("a batch rolled back by a conflict or a refused merge after a `replace` or a cascade neither advances nor notifies", () => {
        const { store, notices, events, gens, rev, characterRevision, wrongSeq } = setup();
        const before = gens();
        const stale = wrongSeq(rev("k2"));
        expect(() =>
            store.applyChanges({ chats: [group("k", rev("k"), [replace()]), group("k2", stale, [note("n")])] }),
        ).toThrow(ResourceBatchConflictError);
        expect(() =>
            store.applyChanges({
                ops: [{ kind: characters, id: "d", baseRevision: characterRevision("d"), delete: true }],
                chats: [group("k2", stale, [note("n")])],
            }),
        ).toThrow(ResourceBatchConflictError);
        expect(() =>
            store.applyChanges({
                ops: [{ kind: characters, id: "d", baseRevision: characterRevision("d"), delete: true }],
                chats: [group("k", rev("k"), [{ op: "meta", set: { name: 5 } }])],
            }),
        ).toThrow(ResourceValidationError);
        expect(store.get(characters, "d")).not.toBeNull();
        expect(gens()).toEqual(before);
        expect(notices).toEqual([]);
        expect(events).toEqual([]);
    });

    it("a `transaction` body: an escaping throw or a caught conflict after a cascade rolls back and advances nothing; a caught ordinary exception still commits once", () => {
        const { store, notices, gens, characterRevision } = setup();
        const before = gens();
        expect(() =>
            store.transaction(() => {
                store.delete(characters, "d", characterRevision("d"));
                throw new Error("body failed");
            }),
        ).toThrow("body failed");
        let caught: unknown;
        expect(() =>
            store.transaction(() => {
                store.delete(characters, "d", characterRevision("d"));
                try {
                    store.put(characters, "c", { chaId: "c" }, characterRevision("c").replace(/:\d+$/, ":99"));
                } catch (error) {
                    caught = error;
                }
            }),
        ).toThrow(ResourceConflictError);
        expect(caught).toBeInstanceOf(ResourceConflictError);
        expect(store.get(characters, "d")).not.toBeNull();
        expect(gens()).toEqual(before);
        expect(notices).toEqual([]);
        store.transaction(() => {
            try {
                throw new Error("unrelated");
            } catch {
                // Not a conflict: the transaction still commits.
            }
            store.delete(characters, "d", characterRevision("d"));
        });
        expect(store.get(characters, "d")).toBeNull();
        expect(ids(notices)).toEqual(["x"]);
        expect(gens()).toEqual([before[0], before[1], before[2], notices[0].sourceGeneration]);
    });
});

describe("commit boundaries inside one publishing scope", () => {
    it("a write nested in a batch's input evaluation commits on its own: its advance and notice survive the outer throw or rollback, and two commits advance twice", () => {
        const { store, notices, events, gen, gens, rev, characterRevision, wrongSeq } = setup();
        const before = gens();
        expect(() =>
            store.applyChanges({
                get chats() {
                    store.applyChanges({ chats: [group("k", rev("k"), [replace()])] });
                    throw new Error("input failed");
                },
            }),
        ).toThrow("input failed");
        // The nested commit advanced, notified, and published its ref; the enclosing scope added nothing.
        expect(gen("k")).toBe(notices[0].sourceGeneration);
        expect(ids(notices)).toEqual(["k"]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: "change",
            changes: { resources: [], chats: [{ characterId: "c", id: "k", revision: rev("k") }], chatOrders: [] },
        });
        expect(() =>
            store.applyChanges({
                get chats() {
                    store.delete(characters, "d", characterRevision("d"));
                    return [group("k", wrongSeq(rev("k")), [replace()])];
                },
            }),
        ).toThrow(ResourceBatchConflictError);
        expect(store.get(characters, "d")).toBeNull();
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({
            type: "change",
            changes: { resources: [{ kind: "characters", id: "d", revision: null }] },
        });
        expect(ids(notices)).toEqual(["k", "x"]);
        expect(gens()).toEqual([notices[0].sourceGeneration, before[1], before[2], notices[1].sourceGeneration]);
        store.applyChanges({
            get chats() {
                store.applyChanges({ chats: [group("k", rev("k"), [replace()])] });
                return [group("k", rev("k"), [replace()])];
            },
        });
        expect(ids(notices)).toEqual(["k", "x", "k", "k"]);
        const issued = notices.map((n) => n.sourceGeneration);
        expect(issued).toEqual([...issued].sort((a, b) => a - b));
        expect(new Set(issued).size).toBe(4);
        expect(gen("k")).toBe(issued[3]);
        expect(gens().slice(1)).toEqual([before[1], before[2], issued[1]]);
        expect(events).toHaveLength(3);
    });

    it("`committed` already reads the new generation; a throwing hook keeps the advance and notifies once (`CommittedWriteError`)", () => {
        const { store, notices, gen, rev } = setup();
        const before = gen("k");
        let hookSaw: { gen: number; notices: number } | null = null;
        store.applyChanges(
            { chats: [group("k", rev("k"), [del])] },
            {
                committed: () => {
                    hookSaw = { gen: store.chatSourceGeneration("c", "k"), notices: notices.length };
                    return [];
                },
            },
        );
        expect(hookSaw).toEqual({ gen: before + 1, notices: 0 });
        expect(ids(notices)).toEqual(["k"]);
        const k2 = gen("k2");
        expect(() =>
            store.applyChanges(
                { chats: [group("k2", rev("k2"), [del])] },
                {
                    committed: () => {
                        throw new Error("hook failed");
                    },
                },
            ),
        ).toThrow(CommittedWriteError);
        expect(store.chatRevision("c", "k2")).toBeNull();
        expect(gen("k2")).not.toBe(k2);
        expect(gen("k2")).toBe(notices[1].sourceGeneration);
        expect(ids(notices)).toEqual(["k", "k2"]);
    });
});

describe("notice delivery", () => {
    it("waits for the outer publication: a feed listener's own write is published after every listener saw the outer one, then the notices arrive in commit order", () => {
        const { store, feed, notices, log, rev, write } = setup();
        let wrote = false;
        feed!.subscribe((event) => {
            if (event.type !== "change") return;
            log.push(`feed-2:${event.changes.chats.map((c) => c.id).join(",")}`);
            if (!wrote) {
                wrote = true;
                write("k2", [replace({ name: "R", message: [] })]);
            }
        });
        feed!.subscribe((event) => {
            if (event.type === "change") log.push(`feed-3:${event.changes.chats.map((c) => c.id).join(",")}`);
        });
        store.applyChanges({ chats: [group("k", rev("k"), [del])] });
        expect(log).toEqual([
            "feed:k",
            "feed-2:k",
            "feed-3:k",
            "feed:k2",
            "feed-2:k2",
            "feed-3:k2",
            "notice:k",
            "notice:k2",
        ]);
        expect(notices.map((n) => n.sourceGeneration)).toEqual([
            notices[0].sourceGeneration,
            notices[0].sourceGeneration + 1,
        ]);
    });

    it("a listener's own write queues its notices behind the ones being delivered; a throwing listener is logged and the others run; unsubscribe is idempotent", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { store, log, rev, write } = setup();
        let wrote = false;
        store.onChatInvalidated(() => {
            throw new Error("listener failed");
        });
        store.onChatInvalidated((notice) => {
            log.push(`A:${notice.id}`);
            if (!wrote) {
                wrote = true;
                write("k2", [del]);
            }
        });
        const off = store.onChatInvalidated((notice) => log.push(`B:${notice.id}`));
        write("k", [del]);
        expect(log).toEqual(["feed:k", "notice:k", "A:k", "feed:k2", "B:k", "notice:k2", "A:k2", "B:k2"]);
        expect(console.error).toHaveBeenCalledTimes(2);
        off();
        off();
        log.length = 0;
        store.applyChanges({ chats: [group("k3", rev("k3"), [del])] });
        expect(log).toEqual(["feed:k3", "notice:k3", "A:k3"]);
    });

    it("works without a feed, and a chat recreated under its ids reads the advanced value: values never repeat", () => {
        const { store, notices, gen, gens, write } = setup({ feed: false });
        const base = gen("k");
        expect(gens()).toEqual([base, base, base, base]);
        write("k", [del]);
        const first = gen("k");
        expect(first).not.toBe(base);
        store.applyChanges({ chats: [group("k", null, [create(kBody)])] });
        // Not back to the value it had before the delete.
        expect(gen("k")).toBe(first);
        expect(store.readChatSource("c", "k").revision).not.toBeNull();
        write("k", [del]);
        store.applyChanges({ chats: [group("k", null, [create()])] });
        write("k", [replace({ name: "R", message: [] })]);
        const issued = notices.map((n) => n.sourceGeneration);
        expect(ids(notices)).toEqual(["k", "k", "k"]);
        expect(new Set([base, ...issued]).size).toBe(4);
        expect(issued).toEqual([...issued].sort((a, b) => a - b));
        expect(gen("k")).toBe(issued[2]);
        expect(gens().slice(1)).toEqual([base, base, base]);
    });
});

describe("`replaceAll` and `readChatSource`", () => {
    it("`replaceAll` gives every chat one new value past every issued one with no notice, visible to an epoch listener; a failed restore changes nothing", async () => {
        const { dir, store, feed, notices, gen, gens, write } = setup();
        const file = path.join(dir, "snapshot.sqlite");
        await store.backupTo(file);
        const validated = store.readSnapshot(file);
        write("k", [del]);
        const issued = [...gens()];
        const epochSaw: number[][] = [];
        feed!.subscribe((event) => {
            if (event.type === "epoch") epochSaw.push(gens());
        });
        const oldEpoch = store.epoch();
        store.replaceAll(validated);
        expect(store.epoch()).not.toBe(oldEpoch);
        const reset = gen("k");
        expect(gens()).toEqual([reset, reset, reset, reset]);
        expect(Math.max(...issued)).toBeLessThan(reset);
        expect(epochSaw).toEqual([[reset, reset, reset, reset]]);
        expect(ids(notices)).toEqual(["k"]);
        expect(store.readChatSource("c", "k").revision).not.toBeNull();
        // A failing restore (a duplicate message id) rolls back and leaves the registry as it is.
        expect(() =>
            store.replaceAll({ ...validated, messages: [...validated.messages, validated.messages[0]] }),
        ).toThrow("UNIQUE constraint failed");
        expect(gens()).toEqual([reset, reset, reset, reset]);
        expect(ids(notices)).toEqual(["k"]);
        // Values keep moving past the reset.
        write("k2", [del]);
        expect(gen("k2")).toBeGreaterThan(reset);
        expect(notices[1]).toEqual({ epoch: store.epoch(), characterId: "c", id: "k2", sourceGeneration: gen("k2") });
    });

    it("a feed listener that restores: the outer notice keeps its captured epoch and generation and arrives after the epoch event", async () => {
        const { dir, store, feed, notices, log, gen, gens, rev } = setup();
        const file = path.join(dir, "snapshot.sqlite");
        await store.backupTo(file);
        const validated = store.readSnapshot(file);
        const oldEpoch = store.epoch();
        let restored = false;
        feed!.subscribe((event) => {
            if (event.type === "change" && !restored) {
                restored = true;
                store.replaceAll(validated);
            }
        });
        store.applyChanges({ chats: [group("k", rev("k"), [del])] });
        expect(log).toEqual(["feed:k", "feed:epoch", "notice:k"]);
        expect(notices).toEqual([
            { epoch: oldEpoch, characterId: "c", id: "k", sourceGeneration: notices[0].sourceGeneration },
        ]);
        const reset = gen("k");
        expect(reset).toBeGreaterThan(notices[0].sourceGeneration);
        expect(gens()).toEqual([reset, reset, reset, reset]);
    });

    it("`readChatSource` returns the chat with its generation (a missing chat with null revision and data); a closed store refuses", () => {
        const { store, gen, rev, write } = setup();
        write("k", [del]);
        store.applyChanges({ chats: [group("k", null, [create(kBody)])] });
        const read = store.readChatSource("c", "k");
        expect(read.revision).toBe(rev("k"));
        expect(read.data!.message.map((x) => x.chatId)).toEqual(["a", "b", "c"]);
        expect(read.sourceGeneration).toBe(gen("k"));
        expect(store.readChatSource("c", "nope")).toEqual({
            characterId: "c",
            id: "nope",
            revision: null,
            data: null,
            sourceGeneration: gen("k2"),
        });
        store.close();
        expect(() => store.chatSourceGeneration("c", "k")).toThrow(ResourceStoreClosedError);
        expect(() => store.readChatSource("c", "k")).toThrow(ResourceStoreClosedError);
        expect(() => store.onChatInvalidated(() => {})).toThrow(ResourceStoreClosedError);
    });
});
