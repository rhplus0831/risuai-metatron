import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "./storeBackedServer";

// The chat mutation module (`chatStore.svelte.ts`) on a fresh module graph per test, against the real
// server store in memory: the mirror, the queue and its coalescing, membership and selection, the
// generation lock, conflict recovery, and the three-way `applyChatResult`. The save loop is driven by
// hand here (`take` → `store.applyChanges` → `ack`); `resourceSyncChats.test.ts` runs it for real.

vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
}));

type ChatModule = typeof import("../chatStore.svelte");
type Stores = typeof import("../../stores.svelte");

const m = (id: string | undefined, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const ids = (chat: { message: readonly { chatId?: string }[] } | undefined) =>
    chat!.message.map((message) => message.chatId);
const texts = (chat: { message: readonly { data: string }[] } | undefined) =>
    chat!.message.map((message) => message.data);

/**
 * Boots the module the way `loadData` does against `server` (a character `c` with chat `k` holding
 * messages a, b, c unless the server already has data): read, seed, assemble, select.
 */
async function boot(server?: StoreBackedServer) {
    vi.resetModules();
    server ??= await StoreBackedServer.create();
    const characters = server.kind("characters");
    if (!server.record("characters", "c")) {
        server.store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: "k",
                                name: "K",
                                note: "",
                                localLore: [],
                                fmIndex: -1,
                                message: [m("a", "A", "char"), m("b", "B"), m("c", "C", "char")],
                            } as any,
                        },
                    ],
                },
            ],
        });
    }
    const stores: Stores = await import("../../stores.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const read = server.store.readKinds([characters], { chats: true });
    stores.DBState.db = { characters: read.kinds.characters.map((record) => record.data) } as any;
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(stores.DBState.db.characters as any, read.chats!, read.chatOrders!);
    chat.initializeChats();
    const ref = { chaId: "c", chatId: "k" };
    const character = () => stores.DBState.db.characters[0] as any;
    const take = () => chat.takeChatWork(new Set());
    const apply = (work: ChatModule["takeChatWork"] extends (...args: any) => infer R ? R : never) =>
        work.groups.length + work.orders.length === 0
            ? { results: [], chats: [], chatOrders: [] }
            : server.store.applyChanges({
                  chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                      characterId,
                      chatId,
                      baseRevision,
                      ops,
                  })),
                  chatOrders: work.orders.map(({ characterId, baseRevision, ids }) => ({
                      characterId,
                      baseRevision,
                      ids,
                  })),
              });
    const ack = (work: ReturnType<typeof take>, result: ReturnType<typeof apply>) =>
        chat.ackChatWork(work, result.chats, result.chatOrders);
    /** One save cycle: take, apply on the server, acknowledge. */
    const commit = () => {
        const work = take();
        const result = apply(work);
        const refresh = ack(work, result);
        return { work, result, refresh };
    };
    /** A cycle whose request conflicts: recover as the save loop does (chat reads, then collection reads). */
    const recover = (work: ReturnType<typeof take>) => {
        let conflicts: any[] = [];
        try {
            apply(work);
        } catch (error) {
            expect(error).toBeInstanceOf(server.errors.ResourceBatchConflictError);
            conflicts = (error as { conflicts: any[] }).conflicts;
        }
        const chats = conflicts.filter((conflict) => conflict.kind === "chat");
        const orders = conflicts.filter((conflict) => conflict.kind === "chatOrder");
        const remote = server.store.readRefs([], {
            chats: chats.map((conflict) => ({ characterId: conflict.characterId, id: conflict.id })),
        }).chats;
        const result = chat.recoverChatConflicts(
            work,
            new Set(chats.map((conflict) => `${conflict.characterId}\u0000${conflict.id}`)),
            new Set(orders.map((conflict) => conflict.characterId)),
            remote as any,
        );
        for (const characterId of result.refresh) {
            chat.acceptRemoteCollection(
                server.store.readRefs([], { chatCollections: [characterId] }).chatCollections[0],
            );
        }
        return { conflicts, ...result };
    };
    const open = () => chat.unsettledChatObligations(chat.captureChatObligations());
    return { server, stores, chat, ref, character, take, apply, ack, commit, recover, open };
}

beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("mirror and queue", () => {
    it("updates the mirror synchronously from detached copies of the input and the anchor", async () => {
        const { server, chat, ref, commit } = await boot();
        const input = m("x", "X");
        const anchor = { after: "a" };
        const [id] = chat.appendMessage(ref, input, { anchor });
        input.data = "mutated after the call";
        anchor.after = "c";
        expect(id).toBe("x");
        expect(texts(chat.findChat(ref))).toEqual(["A", "X", "B", "C"]);
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([{ op: "append", messages: [m("x", "X")], anchor: { after: "a" } }]);
        expect(server.texts("c", "k")).toEqual(["A", "X", "B", "C"]);
    });

    it("coalesces unsent text writes, message replacements, metadata patches, and end appends", async () => {
        const { server, chat, ref, commit } = await boot();
        chat.setMessageText(ref, "a", "one");
        chat.setMessageText(ref, "a", "two");
        chat.replaceMessage(ref, m("b", "B2"));
        chat.setMessageText(ref, "b", "B3");
        chat.setChatMeta(ref, { note: "n1" });
        // Set then unset the same field: only the unset survives, beside the other set.
        chat.setChatMeta(ref, { name: "N" }, ["note"]);
        chat.appendMessage(ref, m("x", "X"));
        chat.appendMessage(ref, m("y", "Y"));
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "setText", id: "a", text: "two" },
            { op: "setMessage", message: m("b", "B3") },
            { op: "meta", set: { name: "N" }, unset: ["note"] },
            { op: "append", messages: [m("x", "X"), m("y", "Y")], anchor: { end: true } },
        ]);
        const saved = server.chat("c", "k")!.data as any;
        expect(saved.name).toBe("N");
        expect(saved.note).toBe("");
        expect(server.texts("c", "k")).toEqual(["two", "B3", "C", "X", "Y"]);
    });

    it("skips an equal metadata patch and refuses the forbidden fields", async () => {
        const { chat, ref, take } = await boot();
        chat.setChatMeta(ref, { name: "K", note: "", localLore: [] });
        expect(chat.hasChatWork()).toBe(false);
        expect(() => chat.setChatMeta(ref, { id: "other" })).toThrow(/cannot change id/);
        expect(() => chat.setChatMeta(ref, {}, ["message"])).toThrow(/cannot change message/);
        expect(take().groups).toEqual([]);
    });

    it("removes several messages as one op that needs the current revision", async () => {
        const { server, chat, ref, take } = await boot();
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "b", text: "remote edit" }],
            },
        ]);
        chat.removeMessages(ref, ["a", "b"]);
        const work = take();
        expect(work.groups[0].ops).toEqual([{ op: "remove", ids: ["a", "b"] }]);
        expect(() => server.store.applyChanges({ chats: work.groups as any })).toThrow(
            server.errors.ResourceBatchConflictError,
        );
        expect(server.texts("c", "k")).toEqual(["A", "remote edit", "C"]);
    });
});

describe("membership and selection", () => {
    it("cancels a create that was never sent, but keeps a delete behind a create that was", async () => {
        const { server, chat, take, commit, open } = await boot();
        chat.createChat("c", { id: "n", name: "N", message: [] } as any);
        chat.deleteChat({ chaId: "c", chatId: "n" });
        expect(take().groups).toEqual([]);
        expect(open()).toEqual([]);
        expect(server.chat("c", "n")).toBeNull();

        chat.createChat("c", { id: "p", name: "P", message: [] } as any);
        const attempt = take();
        expect(attempt.groups.map((group) => group.ops[0].op)).toEqual(["create"]);
        // The request failed before anything was known to have landed.
        chat.requeueChatWork(attempt);
        chat.deleteChat({ chaId: "c", chatId: "p" });
        const obligations = chat.captureChatObligations();
        // The create is resent alone (it may have landed), the delete waits for its answer.
        const { work } = commit();
        expect(work.groups.map((group) => group.ops.map((op) => op.op))).toEqual([["create"]]);
        expect(work.orders).toEqual([]);
        expect(server.chat("c", "p")).not.toBeNull();
        expect(chat.unsettledChatObligations(obligations)).toEqual(["c\u0000p"]);
        const second = commit();
        expect(second.work.groups.map((group) => group.ops)).toEqual([[{ op: "delete" }]]);
        expect(server.chat("c", "p")).toBeNull();
        expect(chat.unsettledChatObligations(obligations)).toEqual([]);
        expect(server.order("c")!.ids).toEqual(["k"]);
    });

    it("keeps the selection on the chat id through creates, reorders, and deletes, and remembers it for the next boot", async () => {
        const { server, chat, character, commit } = await boot();
        expect(character().chatPage).toBe(0);
        chat.createChat("c", { id: "j", name: "J", message: [] } as any, { select: true });
        expect(character().chatPage).toBe(1);
        chat.reorderChats("c", ["j", "k"]);
        expect(character().chatPage).toBe(0);
        chat.selectChat("c", "k");
        expect(character().chatPage).toBe(1);
        expect(JSON.parse(localStorage.getItem("risu-selected-chats")!)).toEqual({ c: "k" });
        commit();
        expect(server.order("c")!.ids).toEqual(["j", "k"]);

        // A new tab of the same browser starts on the remembered chat, wherever it is in the order.
        const next = await boot(server);
        expect(next.character().chats.map((entry: any) => entry.id)).toEqual(["j", "k"]);
        expect(next.character().chatPage).toBe(1);
        next.chat.deleteChat({ chaId: "c", chatId: "k" });
        expect(next.character().chatPage).toBe(0);
        expect(() => next.chat.deleteChat({ chaId: "c", chatId: "j" })).toThrow(/at least one chat/);
    });

    it("follows a remote deletion of the selected chat to the first chat, and gives a chatless character a new one", async () => {
        const { server, chat, character, take, recover, commit } = await boot();
        chat.createChat("c", { id: "j", name: "J", message: [] } as any, { select: true });
        commit();
        expect(character().chatPage).toBe(1);
        server.chatBatch([
            { characterId: "c", chatId: "j", baseRevision: server.chat("c", "j")!.revision, ops: [{ op: "delete" }] },
        ]);
        chat.setChatMeta({ chaId: "c", chatId: "j" }, { note: "edit on a chat another tab deleted" });
        recover(take());
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["k"]);
        expect(character().chatPage).toBe(0);
        expect(chat.chatDiscardsSince(0)).toEqual(["c/j"]);
        expect(chat.hasChatWork()).toBe(false);

        server.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: server.chat("c", "k")!.revision, ops: [{ op: "delete" }] },
        ]);
        chat.setChatMeta({ chaId: "c", chatId: "k" }, { note: "edit on the last chat" });
        recover(take());
        // The character has a fresh chat, and it can be saved.
        expect(character().chats).toHaveLength(1);
        const fresh = character().chats[0].id;
        expect(fresh).not.toBe("k");
        const { work } = commit();
        expect(work.groups.map((group) => [group.chatId, group.ops[0].op])).toEqual([[fresh, "create"]]);
        expect(server.order("c")!.ids).toEqual([fresh]);
    });

    it("assembles chats in the server order and repairs an order naming a missing chat or missing a chat", async () => {
        const { chat } = await boot();
        const characters = [{ chaId: "z", chats: [], chatPage: 3 }] as any[];
        const record = (id: string) => ({ characterId: "z", id, revision: "r", data: { id, message: [] } as any });
        chat.assembleChats(
            characters,
            [record("one"), record("two"), record("extra")],
            [{ characterId: "z", revision: "o", ids: ["two", "missing", "one"] }],
        );
        expect(characters[0].chats.map((entry: any) => entry.id)).toEqual(["two", "one", "extra"]);
        expect(characters[0].chatPage).toBe(0);
        expect(console.error).toHaveBeenCalledTimes(2);
    });
});

describe("generation lock", () => {
    it("checkpoints the text on the timer, keeps the lock until the final write is acknowledged, and drops writes of an ended generation", async () => {
        const { server, chat, ref, take, apply, ack, commit } = await boot();
        chat.beginGeneration(ref, "a", "g1");
        expect(commit().work.groups[0].ops).toEqual([{ op: "begin", id: "a", generationId: "g1" }]);
        chat.setMessageText(ref, "a", "partial", { generationId: "g1" });
        expect(chat.findChat(ref)!.message[0].data).toBe("partial");
        // Mirror only until the checkpoint timer fires.
        expect(take().groups).toEqual([]);
        vi.advanceTimersByTime(3000);
        const checkpoint = commit();
        expect(checkpoint.work.groups[0].ops).toEqual([
            { op: "setText", id: "a", text: "partial", generation: { id: "g1", seq: 1 } },
        ]);
        expect(checkpoint.result.chats[0].checkpoints).toEqual(["applied"]);
        expect(server.texts("c", "k")[0]).toBe("partial");

        expect(() => chat.setMessageText(ref, "a", "manual")).toThrow(/being generated/);
        expect(() => chat.removeMessages(ref, ["a"])).toThrow(/being generated/);
        expect(() => chat.replaceChat(ref, clone(chat.findChat(ref)))).toThrow(/being generated/);
        chat.setMessageText(ref, "b", "other messages stay editable");
        chat.setMessageText(ref, "a", "final text", { generationId: "g1" });
        chat.endGeneration(ref, "a", "g1");
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        const work = take();
        expect(work.groups[0].finals).toHaveLength(1);
        const result = apply(work);
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        ack(work, result);
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        expect(server.texts("c", "k")).toEqual(["final text", "other messages stay editable", "C"]);

        // A late chunk of the ended generation changes nothing, and never becomes a manual write.
        chat.setMessageText(ref, "a", "late chunk", { generationId: "g1" });
        expect(chat.findChat(ref)!.message[0].data).toBe("final text");
        expect(take().groups).toEqual([]);
    });

    it("keeps the lock on a duplicate checkpoint and releases it when the server ignores the generation", async () => {
        const { server, chat, ref, take, apply, ack, commit } = await boot();
        chat.beginGeneration(ref, "b", "g2");
        commit();
        chat.setMessageText(ref, "b", "one", { generationId: "g2" });
        vi.advanceTimersByTime(3000);
        const first = take();
        apply(first);
        // The answer was lost: the same checkpoint is sent again.
        chat.requeueChatWork(first);
        const replay = commit();
        expect(replay.result.chats[0].checkpoints).toEqual(["duplicate"]);
        expect(replay.result.chats[0].stale).toBe(true);
        expect(chat.isMessageLocked(ref, "b")).toBe(true);

        // Another tab takes the message over on the current revision.
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "begin", id: "b", generationId: "g3" }],
            },
        ]);
        chat.setMessageText(ref, "b", "two", { generationId: "g2" });
        vi.advanceTimersByTime(3000);
        const ignored = commit();
        expect(ignored.result.chats[0].checkpoints).toEqual(["ignored"]);
        expect(chat.isMessageLocked(ref, "b")).toBe(false);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/no longer accepts/));
        chat.setMessageText(ref, "b", "three", { generationId: "g2" });
        chat.endGeneration(ref, "b", "g2");
        expect(chat.findChat(ref)!.message[1].data).toBe("two");
        expect(take().groups).toEqual([]);
        expect(server.texts("c", "k")[1]).toBe("one");
    });

    it("defers the reload of a chat a generation runs in until the generation ends", async () => {
        const { server, chat, ref, take, recover, commit } = await boot();
        chat.beginGeneration(ref, "a", "g");
        const begin = take();
        chat.ackChatWork(begin, server.store.applyChanges({ chats: begin.groups as any }).chats, []);
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        chat.setMessageText(ref, "a", "streamed so far", { generationId: "g" });
        chat.removeMessages(ref, ["b", "c"]);
        const work = take();
        const { conflicts } = recover(work);
        expect(conflicts).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: expect.any(String) }]);
        expect(chat.isChatDeferred("c\u0000k")).toBe(true);
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        expect(take().groups).toEqual([]);
        expect(chat.deferredReloads()).toEqual([]);
        // The mirror keeps the local state while the producer runs.
        expect(texts(chat.findChat(ref))).toEqual(["streamed so far"]);

        chat.endGeneration(ref, "a", "g");
        // The generated text is retained through the reload: the lock stays until it is re-sent.
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        expect(chat.deferredReloads()).toEqual([ref]);
        expect(chat.finishDeferredReload(server.chat("c", "k")! as any)).toBeNull();
        expect(chat.isChatDeferred("c\u0000k")).toBe(false);
        // The bulk removal is discarded with the reload; the final text is put back on the server copy.
        expect(texts(chat.findChat(ref))).toEqual(["streamed so far", "B", "C"]);
        expect((chat.findChat(ref) as any).note).toBe("remote");
        expect(chat.chatDiscardsSince(0)).toEqual(["c/k"]);
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        const fresh = server.chat("c", "k")!.revision;
        const recovered = commit();
        expect(recovered.work.groups[0].baseRevision).toBe(fresh);
        expect(recovered.work.groups[0].ops).toEqual([
            {
                op: "setText",
                id: "a",
                text: "streamed so far",
                generation: { id: "g", seq: expect.any(Number), final: true },
            },
        ]);
        expect(server.texts("c", "k")).toEqual(["streamed so far", "B", "C"]);
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("keeps both finals when an auto-continue's group conflicts on a stale base", async () => {
        const { server, chat, ref, take, recover, commit } = await boot();
        chat.beginGeneration(ref, "a", "g1");
        commit();
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { name: "Remote" } }],
            },
        ]);
        // A by-id write lands on the older base: the client keeps that base.
        chat.setChatMeta(ref, { note: "mine" });
        expect(commit().result.chats[0].stale).toBe(true);
        chat.setMessageText(ref, "a", "first", { generationId: "g1" });
        // g1 ends and g2 continues the same message before g1's final is sent: one group carries
        // g1's final and g2's `begin`, which the stale base refuses.
        chat.endGeneration(ref, "a", "g1");
        chat.beginGeneration(ref, "a", "g2");
        chat.setMessageText(ref, "a", "first, second", { generationId: "g2" });
        const work = take();
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["setText", "begin"]);
        const { conflicts } = recover(work);
        expect(conflicts).toHaveLength(1);
        expect(chat.isChatDeferred("c\u0000k")).toBe(true);

        chat.endGeneration(ref, "a", "g2");
        expect(chat.deferredReloads()).toEqual([ref]);
        expect(chat.finishDeferredReload(server.chat("c", "k")! as any)).toBeNull();
        expect(texts(chat.findChat(ref))[0]).toBe("first, second");
        expect((chat.findChat(ref) as any).name).toBe("Remote");
        expect((chat.findChat(ref) as any).note).toBe("mine");
        const recovered = commit();
        const tag = (op: any) => `${op.op}:${op.generation?.id ?? op.generationId}`;
        expect(recovered.work.groups[0].ops.map(tag)).toEqual(["setText:g1", "begin:g2", "setText:g2"]);
        expect(server.texts("c", "k")[0]).toBe("first, second");
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("conflict recovery", () => {
    it("sends a new chat's create without generation ops for a reply a hook removed", async () => {
        const { server, chat, take, apply, ack } = await boot();
        const ref = { chaId: "c", chatId: "n" };
        chat.createChat("c", { id: "n", name: "N", message: [m("u", "hello")] } as any);
        chat.appendMessage(ref, m("r", "", "char"));
        chat.beginGeneration(ref, "r", "g");
        chat.setMessageText(ref, "r", "partial", { generationId: "g" });
        // An output trigger with the generation's capability removed the reply before the save
        // loop ran: the create must not carry a `begin` for a message its payload does not hold.
        chat.removeMessages(ref, ["r"], { generationId: "g" });
        const work = take();
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["create"]);
        ack(work, apply(work));
        chat.endGeneration(ref, "r", "g");
        expect(chat.isMessageLocked(ref, "r")).toBe(false);
        expect(server.texts("c", "n")).toEqual(["hello"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("keeps a chat whose create the server refused: quarantined with an alert, not dropped", async () => {
        const { server, stores, chat } = await boot();
        const alert = await import("../../alert");
        stores.DBState.db.characters.push({ chaId: "z", name: "Z", chats: [], chatPage: 0 } as any);
        const ref = { chaId: "z", chatId: "n" };
        chat.createChat("z", { id: "n", name: "N", message: [m("u", "typed before the refusal")] } as any);
        const work = chat.takeChatWork(new Set(["z"]));
        expect(work.groups.map((group) => group.ops[0].op)).toEqual(["create"]);
        // The character never reached the server, so the create is refused and reads back as gone.
        expect(() => server.store.applyChanges({ chats: work.groups as any })).toThrow(
            server.errors.ResourceBatchConflictError,
        );
        const remote = server.store.readRefs([], { chats: [{ characterId: "z", id: "n" }] }).chats;
        expect(remote[0].revision).toBeNull();
        const result = chat.recoverChatConflicts(work, new Set(["z\u0000n"]), new Set(), remote as any);
        expect([...result.refresh]).toEqual(["z"]);
        expect(alert.alertError).toHaveBeenCalledTimes(1);
        expect(texts(chat.findChat(ref))).toEqual(["typed before the refusal"]);
        // Nothing more is sent for it, and a later collection refresh keeps it in the mirror.
        expect(chat.hasChatWork()).toBe(false);
        expect(chat.takeChatWork(new Set(["z"])).groups).toEqual([]);
        chat.acceptRemoteCollection({
            characterId: "z",
            order: { characterId: "z", revision: `${server.store.epoch()}:1:1`, ids: [] },
            chats: [],
        });
        expect(texts(chat.findChat(ref))).toEqual(["typed before the refusal"]);
    });

    it("recognizes a create whose acknowledgement was lost and sends the edit made meanwhile after it", async () => {
        const { server, chat, take, apply, recover, commit } = await boot();
        const ref = { chaId: "c", chatId: "n" };
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "old")] } as any);
        const sent = take();
        apply(sent);
        chat.setMessageText(ref, "x", "newer edit");
        chat.setChatMeta(ref, { note: "newer note" });
        chat.requeueChatWork(sent);
        const retry = take();
        expect(retry.groups.map((group) => group.ops.map((op) => op.op))).toEqual([["create"]]);
        const { conflicts, reloaded } = recover(retry);
        expect(conflicts).toHaveLength(1);
        expect(reloaded).toBe(false);
        const { work } = commit();
        expect(work.groups[0].baseRevision).not.toBeNull();
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["setText", "meta"]);
        expect(server.texts("c", "n")).toEqual(["newer edit"]);
        expect((server.chat("c", "n")!.data as any).note).toBe("newer note");
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("reloads a chat whose destructive op met an unseen change and reports the discard", async () => {
        const { server, chat, ref, take, recover } = await boot();
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "a", text: "remote" }],
            },
        ]);
        chat.removeMessages(ref, ["b", "c"]);
        chat.setChatMeta(ref, { note: "local note, discarded with the chat" });
        const { reloaded } = recover(take());
        expect(reloaded).toBe(true);
        expect(texts(chat.findChat(ref))).toEqual(["remote", "B", "C"]);
        expect((chat.findChat(ref) as any).note).toBe("");
        expect(chat.chatDiscardsSince(0)).toEqual(["c/k"]);
        expect(chat.hasChatWork()).toBe(false);
        expect(server.texts("c", "k")).toEqual(["remote", "B", "C"]);
    });

    it("puts a chat whose delete was refused back at its server position", async () => {
        const { server, chat, ref, character, take, recover, commit } = await boot();
        chat.createChat("c", { id: "j", name: "J", message: [] } as any);
        commit();
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "b", text: "remote edit" }],
            },
        ]);
        chat.deleteChat(ref);
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["j"]);
        recover(take());
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["k", "j"]);
        expect(server.order("c")!.ids).toEqual(["k", "j"]);
        expect(texts(chat.findChat(ref))).toEqual(["A", "remote edit", "C"]);
        expect(chat.chatDiscardsSince(0)).toEqual(["c/k"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("keeps the older order revision when a create's acknowledgement shows chats it does not know, so the next reorder conflicts instead of being refused", async () => {
        const { server, chat, character, take, apply, commit, recover } = await boot();
        server.chatBatch([
            {
                characterId: "c",
                chatId: "r",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "r", message: [] } as any }],
            },
        ]);
        chat.createChat("c", { id: "local", name: "L", message: [] } as any);
        const { refresh } = commit();
        expect(refresh).toEqual(["c"]);
        chat.reorderChats("c", ["local", "k"]);
        const reorder = take();
        expect(() => apply(reorder)).toThrow(server.errors.ResourceBatchConflictError);
        const { conflicts } = recover(reorder);
        expect(conflicts).toEqual([{ kind: "chatOrder", characterId: "c", revision: expect.any(String) }]);
        // The collection read brings the other tab's chat in; the server order stands.
        expect(character().chats.map((entry: any) => entry.id)).toEqual(server.order("c")!.ids);
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["k", "local", "r"]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("applyChatResult", () => {
    it("applies only what the hook changed, keeping edits, appends, and removals made meanwhile", async () => {
        const { server, chat, ref, commit } = await boot();
        const baseline = chat.captureChatBaseline(ref);
        chat.setMessageText(ref, "b", "B edited meanwhile");
        chat.appendMessage(ref, m("d", "D appended meanwhile"));
        chat.removeMessages(ref, ["c"]);
        const result = clone(baseline.chat);
        result.message[0].data = "A by the hook";
        // The hook also changed c, which was removed meanwhile: that change has nothing to land on.
        result.message[2].data = "C by the hook";
        result.message.push(m("e", "E by the hook"));
        chat.applyChatResult(baseline, result);
        expect(texts(chat.findChat(ref))).toEqual([
            "A by the hook",
            "B edited meanwhile",
            "E by the hook",
            "D appended meanwhile",
        ]);
        const { work } = commit();
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["setText", "append", "remove", "setMessage", "append"]);
        expect(server.texts("c", "k")).toEqual(texts(chat.findChat(ref)));
    });

    it("merges the changed fields into the current message and inserts before the first message", async () => {
        const { server, chat, ref, commit } = await boot();
        const baseline = chat.captureChatBaseline(ref);
        chat.replaceMessage(ref, { ...m("a", "A", "char"), saying: "meanwhile" });
        const result = clone(baseline.chat);
        result.message[0].data = "A changed";
        result.message.unshift(m("z", "Z first"));
        chat.applyChatResult(baseline, result);
        expect(chat.findChat(ref)!.message[1]).toEqual({ ...m("a", "A changed", "char"), saying: "meanwhile" });
        expect(ids(chat.findChat(ref))).toEqual(["z", "a", "b", "c"]);
        const { work } = commit();
        expect(work.groups[0].ops.find((op) => op.op === "append")).toMatchObject({ anchor: { start: true } });
        expect(server.texts("c", "k")).toEqual(["Z first", "A changed", "B", "C"]);
    });

    it("sets and unsets chat fields from the diff", async () => {
        const { server, chat, ref, commit } = await boot();
        const baseline = chat.captureChatBaseline(ref);
        const result = clone(baseline.chat) as any;
        result.note = "hook note";
        result.scriptstate = { $count: "1" };
        delete result.fmIndex;
        chat.applyChatResult(baseline, result);
        const mirror = chat.findChat(ref) as any;
        expect(mirror.note).toBe("hook note");
        expect(mirror.scriptstate).toEqual({ $count: "1" });
        expect(mirror).not.toHaveProperty("fmIndex");
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "meta", set: { note: "hook note", scriptstate: { $count: "1" } }, unset: ["fmIndex"] },
        ]);
        const saved = server.chat("c", "k")!.data as any;
        expect(saved.note).toBe("hook note");
        expect(saved.scriptstate).toEqual({ $count: "1" });
        expect(saved).not.toHaveProperty("fmIndex");
    });

    it("replaces the whole chat for a reorder only while nothing changed since the baseline", async () => {
        const { server, chat, ref, commit } = await boot();
        let baseline = chat.captureChatBaseline(ref);
        let result = clone(baseline.chat);
        result.message.reverse();
        chat.applyChatResult(baseline, result);
        expect(ids(chat.findChat(ref))).toEqual(["c", "b", "a"]);
        let { work } = commit();
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["replace"]);
        expect(server.texts("c", "k")).toEqual(["C", "B", "A"]);

        baseline = chat.captureChatBaseline(ref);
        chat.setChatMeta(ref, { note: "changed meanwhile" });
        result = clone(baseline.chat);
        result.message.reverse();
        result.message[0].data = "A changed by the hook";
        chat.applyChatResult(baseline, result);
        // The order change is dropped with a warning; the text change lands.
        expect(ids(chat.findChat(ref))).toEqual(["c", "b", "a"]);
        expect(chat.findChat(ref)!.message[2].data).toBe("A changed by the hook");
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/order change is dropped/));
        ({ work } = commit());
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["meta", "setMessage"]);
        expect(server.texts("c", "k")).toEqual(["C", "B", "A changed by the hook"]);
    });

    it("turns an identity-less full replacement into one removal and fresh appends", async () => {
        const { server, chat, ref, commit } = await boot();
        const baseline = chat.captureChatBaseline(ref);
        const result = clone(baseline.chat);
        result.message = [m(undefined, "L1"), m(undefined, "L2", "char")];
        chat.applyChatResult(baseline, result);
        const mirror = chat.findChat(ref)!;
        expect(texts(mirror)).toEqual(["L1", "L2"]);
        expect(ids(mirror).every((id) => typeof id === "string" && id.length > 0)).toBe(true);
        const { work } = commit();
        expect(work.groups[0].ops[0]).toEqual({ op: "remove", ids: ["a", "b", "c"] });
        expect(work.groups[0].ops.slice(1).every((op) => op.op === "append")).toBe(true);
        expect(server.texts("c", "k")).toEqual(["L1", "L2"]);
        expect(server.chat("c", "k")!.data.message.map((message) => message.chatId)).toEqual(ids(mirror));
    });

    it("reconciles a whole character's chats from a plugin: diff by id, create, delete, order, selection", async () => {
        const { server, chat, ref, character, commit } = await boot();
        chat.createChat("c", { id: "j", name: "J", message: [] } as any);
        commit();
        const incoming = clone(character().chats) as any[];
        incoming[0].note = "plugin note";
        incoming[0].message[1].data = "B by plugin";
        const fresh = { name: "P", message: [m(undefined, "P1")] };
        chat.reconcileCharacterChats("c", [fresh as any, incoming[0]], 1);
        const chats = character().chats as any[];
        expect(chats.map((entry) => entry.name)).toEqual(["P", "K"]);
        expect(character().chatPage).toBe(1);
        expect((chat.findChat(ref) as any).note).toBe("plugin note");
        expect(texts(chat.findChat(ref))).toEqual(["A", "B by plugin", "C"]);
        commit();
        expect(server.order("c")!.ids).toEqual([chats[0].id, "k"]);
        expect(server.chat("c", "j")).toBeNull();
        expect(server.texts("c", chats[0].id)).toEqual(["P1"]);
        expect((server.chat("c", "k")!.data as any).note).toBe("plugin note");
    });

    it("refuses a result that touches a locked message before changing anything", async () => {
        const { chat, ref, take, commit } = await boot();
        chat.beginGeneration(ref, "a", "g");
        commit();
        const baseline = chat.captureChatBaseline(ref);
        const result = clone(baseline.chat);
        result.message[0].data = "the hook rewrote the reply";
        result.message[1].data = "and an earlier message";
        (result as any).note = "and the note";
        expect(() => chat.applyChatResult(baseline, result)).toThrow(/being generated/);
        expect(texts(chat.findChat(ref))).toEqual(["A", "B", "C"]);
        expect((chat.findChat(ref) as any).note).toBe("");
        expect(take().groups).toEqual([]);
    });

    it("lets a generation-carrying result edit its own message (stamped) and other messages (plain) in one pass", async () => {
        const { server, chat, ref, commit } = await boot();
        chat.beginGeneration(ref, "a", "g");
        commit();
        const baseline = chat.captureChatBaseline(ref);
        const result = clone(baseline.chat);
        result.message[0].data = "changed reply";
        result.message[1].data = "changed earlier message";
        chat.applyChatResult(baseline, result, { generationId: "g" });
        expect(texts(chat.findChat(ref))).toEqual(["changed reply", "changed earlier message", "C"]);
        const { work, result: answer } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "setMessage", message: m("a", "changed reply", "char"), generation: { id: "g", seq: 1 } },
            { op: "setMessage", message: m("b", "changed earlier message") },
        ]);
        expect(answer.chats[0].checkpoints).toEqual(["applied"]);
        expect(server.texts("c", "k")).toEqual(["changed reply", "changed earlier message", "C"]);
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
    });

    it("removes the generating message and others as one op, so the removal still needs the current revision", async () => {
        const { server, chat, ref, take, apply, commit } = await boot();
        chat.beginGeneration(ref, "a", "g");
        commit();
        const baseline = chat.captureChatBaseline(ref);
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "b", text: "important remote edit" }],
            },
        ]);
        const result = clone(baseline.chat);
        result.message = [result.message[2]];
        chat.applyChatResult(baseline, result, { generationId: "g" });
        const work = take();
        expect(work.groups[0].ops).toEqual([{ op: "remove", ids: ["a", "b"] }]);
        expect(() => apply(work)).toThrow(server.errors.ResourceBatchConflictError);
        expect(server.texts("c", "k")).toEqual(["A", "important remote edit", "C"]);
    });
});

describe("unload checkpoint (pagehide)", () => {
    const LIMIT = 60 * 1024;
    const bodyBytes = (body: string) => new TextEncoder().encode(body).length;

    it("carries the whole current text of each begun generation, whole or not at all within the budget, and skips a chat with a request in flight", async () => {
        const { server, chat, ref, take, apply, ack, commit } = await boot();
        const refJ = { chaId: "c", chatId: "j" };
        chat.createChat("c", { id: "j", name: "J", note: "", localLore: [], message: [m("x", "X", "char")] } as any);
        chat.beginGeneration(ref, "a", "gk");
        commit();
        chat.beginGeneration(refJ, "x", "gj");
        chat.setMessageText(ref, "a", "k so far", { generationId: "gk" });
        chat.setMessageText(refJ, "x", "j so far", { generationId: "gj" });

        // j's begin is queued but not acknowledged: the server does not know its generation yet.
        const first = chat.unloadCheckpoint(LIMIT)!;
        expect(first.work.groups.map((group) => group.chatId)).toEqual(["k"]);
        expect(first.work.groups[0].ops).toEqual([
            { op: "setText", id: "a", text: "k so far", generation: { id: "gk", seq: 1 } },
        ]);
        expect(first.work.groups[0].seq).toBe(0);
        expect(JSON.parse(first.body)).toEqual({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: server.chat("c", "k")!.revision,
                    ops: first.work.groups[0].ops,
                },
            ],
        });
        // Nothing was sent: the sequence still advanced so a later checkpoint supersedes this one.
        commit();
        chat.setMessageText(ref, "a", "k later", { generationId: "gk" });
        vi.advanceTimersByTime(3000);
        expect(commit().work.groups.find((group) => group.chatId === "k")!.ops).toEqual([
            { op: "setText", id: "a", text: "k later", generation: { id: "gk", seq: 2 } },
        ]);

        // Both begun: a budget that fits one group leaves the other out whole (never a suffix).
        const both = chat.unloadCheckpoint(LIMIT)!;
        expect(both.work.groups.map((group) => group.chatId)).toEqual(["k", "j"]);
        const onlyK = chat.unloadCheckpoint(bodyBytes(both.body) - 1)!;
        expect(onlyK.work.groups.map((group) => group.chatId)).toEqual(["k"]);
        expect(bodyBytes(onlyK.body)).toBeLessThanOrEqual(bodyBytes(both.body) - 1);
        // k's sequence advanced twice (both bodies), j's once (left out of the second).
        expect(both.work.groups.map((group) => (group.ops[0] as any).generation.seq)).toEqual([3, 2]);
        expect((onlyK.work.groups[0].ops[0] as any).generation.seq).toBe(4);
        expect(chat.unloadCheckpoint(10)).toBeNull();

        // A chat whose request is in flight is skipped (that request carries its latest checkpoint).
        chat.setMessageText(ref, "a", "k newer", { generationId: "gk" });
        chat.setMessageText(refJ, "x", "j newer", { generationId: "gj" });
        vi.advanceTimersByTime(3000);
        const inflight = take();
        expect(inflight.groups.map((group) => group.chatId)).toEqual(["k", "j"]);
        expect(chat.unloadCheckpoint(LIMIT)).toBeNull();
        ack(inflight, apply(inflight));
        expect(chat.unloadCheckpoint(LIMIT)!.work.groups.map((group) => group.chatId)).toEqual(["k", "j"]);
    });

    it("settles a surviving page's answer like an acknowledgement, so the tab's next current-revision op does not conflict with its own write", async () => {
        const { server, chat, ref, take, apply, ack, commit } = await boot();
        chat.beginGeneration(ref, "a", "g");
        commit();
        chat.setMessageText(ref, "a", "streamed", { generationId: "g" });
        const checkpoint = chat.unloadCheckpoint(LIMIT)!;
        chat.trackUnloadCheckpoint(checkpoint.work);

        // Queued work of that chat waits for the answer; other chats are not held.
        chat.setChatMeta(ref, { note: "edited while the answer is out" });
        expect(chat.hasChatWork()).toBe(false);
        expect(take().groups).toEqual([]);
        const answer = server.store.applyChanges(JSON.parse(checkpoint.body));
        expect(answer.chats[0].checkpoints).toEqual(["applied"]);
        expect(server.texts("c", "k")[0]).toBe("streamed");
        chat.settleUnloadCheckpoint(checkpoint.work, answer.chats);
        expect(chat.hasChatWork()).toBe(true);

        // The note goes out on the revision the unload write produced: not stale.
        const note = commit();
        expect(note.work.groups[0].ops).toEqual([
            { op: "meta", set: { note: "edited while the answer is out" }, unset: [] },
        ]);
        expect(note.result.chats[0].stale).toBeUndefined();
        chat.endGeneration(ref, "a", "g");
        expect(commit().result.chats[0].stale).toBeUndefined();
        expect(chat.isMessageLocked(ref, "a")).toBe(false);

        // Continue: a new generation on the message needs the current revision, which this tab has.
        chat.beginGeneration(ref, "a", "g2");
        const begin = take();
        expect(begin.groups[0].baseRevision).toBe(server.chat("c", "k")!.revision);
        ack(begin, apply(begin));
        chat.setMessageText(ref, "a", "streamed, continued", { generationId: "g2" });
        chat.endGeneration(ref, "a", "g2");
        commit();
        expect(server.texts("c", "k")[0]).toBe("streamed, continued");
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
    });

    it("keeps the base when the answer is lost or stale, and stops a generation the server ignores", async () => {
        const { server, chat, ref, take, apply, commit, recover } = await boot();
        chat.beginGeneration(ref, "a", "g");
        commit();
        chat.setMessageText(ref, "a", "streamed", { generationId: "g" });

        // Lost answer (the request failed, or the page did not survive to see it): the chat's work
        // resumes on the old base. Had the write landed anyway, the next current-revision op
        // conflicts and reloads the chat, which is the documented protection of unseen writes.
        const lost = chat.unloadCheckpoint(LIMIT)!;
        chat.trackUnloadCheckpoint(lost.work);
        server.store.applyChanges(JSON.parse(lost.body));
        chat.settleUnloadCheckpoint(lost.work, null);
        chat.setChatMeta(ref, { note: "after the lost answer" });
        const note = commit();
        expect(note.result.chats[0].stale).toBe(true);
        chat.endGeneration(ref, "a", "g");
        commit();
        chat.beginGeneration(ref, "a", "g2");
        const { conflicts } = recover(take());
        expect(conflicts).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: expect.any(String) }]);
        // A generation runs in the chat: its reload waits for the end of the generation.
        expect(chat.isChatDeferred("c\u0000k")).toBe(true);
        chat.endGeneration(ref, "a", "g2");
        // The refused op was g2's `begin`: after the reload it is retried together with the final.
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        expect(chat.deferredReloads()).toEqual([ref]);
        const remote = server.store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
        expect(chat.finishDeferredReload(remote as any)).toBeNull();
        expect((chat.findChat(ref) as any).note).toBe("after the lost answer");
        expect(texts(chat.findChat(ref))[0]).toBe("streamed");
        const recovered = commit();
        expect(recovered.work.groups[0].ops.map((op) => op.op)).toEqual(["begin", "setText"]);
        expect(recovered.result.chats[0].stale).toBeUndefined();
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        expect(chat.hasChatWork()).toBe(false);

        // Stale answer (another tab wrote meanwhile): the base stays older, as for any acknowledgement.
        chat.beginGeneration(ref, "a", "g3");
        commit();
        chat.setMessageText(ref, "a", "third", { generationId: "g3" });
        const before = server.chat("c", "k")!.revision;
        server.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: before, ops: [{ op: "setText", id: "b", text: "remote" }] },
        ]);
        const stale = chat.unloadCheckpoint(LIMIT)!;
        chat.trackUnloadCheckpoint(stale.work);
        const staleAnswer = server.store.applyChanges(JSON.parse(stale.body));
        expect(staleAnswer.chats[0].stale).toBe(true);
        chat.settleUnloadCheckpoint(stale.work, staleAnswer.chats);
        chat.setChatMeta(ref, { note: "still on the old base" });
        expect(commit().result.chats[0].stale).toBe(true);

        // Ignored (another tab took the message over): the generation stops saving.
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "begin", id: "a", generationId: "other-tab" }],
            },
        ]);
        chat.setMessageText(ref, "a", "fourth", { generationId: "g3" });
        const ignored = chat.unloadCheckpoint(LIMIT)!;
        chat.trackUnloadCheckpoint(ignored.work);
        const ignoredAnswer = server.store.applyChanges(JSON.parse(ignored.body));
        expect(ignoredAnswer.chats[0].checkpoints).toEqual(["ignored"]);
        chat.settleUnloadCheckpoint(ignored.work, ignoredAnswer.chats);
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/no longer accepts/));
        chat.setMessageText(ref, "a", "late", { generationId: "g3" });
        expect(chat.findChat(ref)!.message[0].data).toBe("fourth");
        expect(server.texts("c", "k")[0]).toBe("third");

        // Idle after the stale answers: the chat is read back and re-based without a discard or a
        // notice, so the next revision-bound op applies instead of conflicting.
        expect(chat.idleChatRefreshes()).toEqual([ref]);
        const discardsBefore = chat.chatDiscardsSince(0).length;
        const refreshed = server.store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
        expect(chat.finishIdleChatRefresh(refreshed as any)).toBe(true);
        expect(texts(chat.findChat(ref))).toEqual(["third", "remote", "C"]);
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.chatDiscardsSince(0)).toHaveLength(discardsBefore);
        chat.removeMessages(ref, ["b", "c"]);
        const bulk = commit();
        expect(bulk.result.chats[0].stale).toBeUndefined();
        expect(server.texts("c", "k")).toEqual(["third"]);
    });
});

describe("streaming message identity", () => {
    it("locks the generating message in its own chat only, not its copy in a branched chat that kept the message ids", async () => {
        const { chat, ref } = await boot();
        const source = chat.findChat(ref)!;
        const branch = chat.createChat("c", { ...clone(source), id: "branch", name: "Branch" } as any, { index: 0 });
        expect(ids(branch)).toEqual(ids(source));
        const refBranch = { chaId: "c", chatId: branch.id! };
        chat.beginGeneration(ref, "a", "g");
        chat.setStreamingState({ ...ref, messageId: "a", mode: "off" });
        expect(chat.isStreamingMessage(ref, "a")).toBe(true);
        expect(chat.isStreamingMessage(refBranch, "a")).toBe(false);
        expect(chat.isStreamingMessage({ chaId: "other", chatId: "k" }, "a")).toBe(false);
        expect(chat.isStreamingMessage(ref, "b")).toBe(false);
        expect(chat.isStreamingMessage(null, "a")).toBe(false);
        expect(chat.isStreamingMessage(ref, undefined)).toBe(false);
        // The copy's message is editable while the source's is locked.
        chat.setMessageText(refBranch, "a", "edited in the branch");
        expect(() => chat.setMessageText(ref, "a", "edited in the source")).toThrow(/being generated/);
        chat.setStreamingState(null);
        expect(chat.isStreamingMessage(ref, "a")).toBe(false);
    });
});

describe("new characters", () => {
    it("normalizeNewCharacter gives a new character's chats and messages ids (a default chat when it has none) without queuing anything; adoptCharacter queues the creates once", async () => {
        const { server, stores, chat } = await boot();
        stores.DBState.db.characters.push(
            {
                chaId: "n",
                name: "N",
                chats: [
                    {
                        message: [m(undefined, "hello"), m("dup", "one", "char"), m("dup", "two")],
                        note: "",
                        name: "Chat 1",
                        localLore: [],
                    },
                    { id: "same", message: [], note: "", name: "Second", localLore: [] },
                    { id: "same", message: [], note: "", name: "Third", localLore: [] },
                ],
            } as any,
            { chaId: "e", name: "E", chats: [] } as any,
        );
        chat.normalizeNewCharacter("n");
        chat.normalizeNewCharacter("e");
        const n = stores.DBState.db.characters[1] as any;
        const e = stores.DBState.db.characters[2] as any;
        expect(n.chats.map((entry: any) => typeof entry.id)).toEqual(["string", "string", "string"]);
        expect(new Set(n.chats.map((entry: any) => entry.id)).size).toBe(3);
        expect(n.chats[1].id).toBe("same");
        expect(n.chats[0].message.map((message: any) => typeof message.chatId)).toEqual(["string", "string", "string"]);
        expect(new Set(n.chats[0].message.map((message: any) => message.chatId)).size).toBe(3);
        expect(n.chats[0].message[1].chatId).toBe("dup");
        expect(n.chatPage).toBe(0);
        expect(e.chats).toEqual([
            { id: expect.any(String), message: [], note: "", name: "Chat 1", localLore: [], fmIndex: -1 },
        ]);
        expect(e.chatPage).toBe(0);
        stores.selectedCharID.set(0);
        expect(chat.currentChatRef()).toEqual({ chaId: "c", chatId: "k" });
        stores.selectedCharID.set(2);
        expect(chat.currentChatRef()).toEqual({ chaId: "e", chatId: e.chats[0].id });
        // Nothing is queued: the creates travel with the character's own create in the save loop.
        expect(chat.hasChatWork()).toBe(false);
        expect(chat.takeChatWork(new Set(["n", "e"])).groups).toEqual([]);

        chat.adoptCharacter("n");
        chat.adoptCharacter("n");
        chat.adoptCharacter("e");
        const characters = server.kind("characters");
        server.store.applyChanges({
            ops: [
                { kind: characters, id: "n", baseRevision: null, data: { chaId: "n", name: "N" } },
                { kind: characters, id: "e", baseRevision: null, data: { chaId: "e", name: "E" } },
            ],
        });
        const work = chat.takeChatWork(new Set(["n", "e"]));
        expect(work.groups.map((group) => [group.characterId, group.ops.map((op) => op.op)])).toEqual([
            ["e", ["create"]],
            ["n", ["create"]],
            ["n", ["create"]],
            ["n", ["create"]],
        ]);
        const result = server.store.applyChanges({
            chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                characterId,
                chatId,
                baseRevision,
                ops,
            })),
        });
        chat.ackChatWork(work, result.chats, result.chatOrders);
        expect(server.order("n")!.ids).toEqual(n.chats.map((entry: any) => entry.id));
        expect(server.texts("n", n.chats[0].id)).toEqual(["hello", "one", "two"]);
        expect(server.order("e")!.ids).toEqual([e.chats[0].id]);
        expect(chat.hasChatWork()).toBe(false);
        // A second adoption of a character the server knows queues nothing.
        chat.adoptCharacter("n");
        expect(chat.takeChatWork(new Set()).groups).toEqual([]);
    });
});

describe("map merges (slice 11b)", () => {
    const record = (id: string) => ({ call: { id, name: "tool", arg: {} }, response: [{ type: "text", text: id }] });
    const stored = (server: Awaited<ReturnType<typeof boot>>["server"]) =>
        (server.chat("c", "k")!.data as { toolCalls?: Record<string, unknown> }).toolCalls;

    it("mergeChatMeta adds entries to the mirror and sends a `merge` the server applies onto the stored map, so another writer's entries are kept", async () => {
        const { server, chat, ref, commit } = await boot();
        // Nothing to merge: no work; a field that is not a map is refused.
        chat.mergeChatMeta(ref, "toolCalls", {});
        expect(chat.hasChatWork()).toBe(false);
        expect(() => chat.mergeChatMeta(ref, "note", { x: 1 })).toThrow(/cannot merge note/);
        chat.mergeChatMeta(ref, "toolCalls", { a: record("a") });
        chat.mergeChatMeta(ref, "toolCalls", { b: record("b") });
        chat.setChatMeta(ref, { note: "n" });
        expect(chat.findChat(ref)!.toolCalls).toEqual({ a: record("a"), b: record("b") });
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "meta", set: { note: "n" }, unset: [], merge: { toolCalls: { a: record("a"), b: record("b") } } },
        ]);
        expect(stored(server)).toEqual({ a: record("a"), b: record("b") });
        // Another device adds `x` meanwhile; this tab's base is older: the merge keeps `x`.
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "meta", merge: { toolCalls: { x: record("x") } } }],
            },
        ]);
        chat.mergeChatMeta(ref, "toolCalls", { c: record("c") });
        commit();
        expect(stored(server)).toEqual({ a: record("a"), b: record("b"), x: record("x"), c: record("c") });
        // The entries are detached copies of the input.
        const input = { d: record("d") };
        chat.mergeChatMeta(ref, "toolCalls", input);
        input.d.response[0].text = "mutated after the call";
        // A lone merge op carries only its entries (set and unset appear once it coalesces).
        expect(commit().work.groups[0].ops).toEqual([{ op: "meta", merge: { toolCalls: { d: record("d") } } }]);
        expect(chat.findChat(ref)!.toolCalls!.d).toEqual(record("d"));
    });

    it("coalesces a merge with the meta ops around it: a later set or unset of the field replaces the entries, a merge after a set or unset goes into the set value", async () => {
        const { server, chat, ref, commit } = await boot();
        chat.mergeChatMeta(ref, "toolCalls", { d: record("d") });
        chat.setChatMeta(ref, { toolCalls: { e: record("e") } });
        chat.mergeChatMeta(ref, "toolCalls", { f: record("f") });
        expect(commit().work.groups[0].ops).toEqual([
            { op: "meta", set: { toolCalls: { e: record("e"), f: record("f") } }, unset: [] },
        ]);
        expect(stored(server)).toEqual({ e: record("e"), f: record("f") });
        chat.setChatMeta(ref, {}, ["toolCalls"]);
        chat.mergeChatMeta(ref, "toolCalls", { g: record("g") });
        expect(commit().work.groups[0].ops).toEqual([
            { op: "meta", set: { toolCalls: { g: record("g") } }, unset: [] },
        ]);
        expect(stored(server)).toEqual({ g: record("g") });
        chat.mergeChatMeta(ref, "toolCalls", { h: record("h") });
        chat.setChatMeta(ref, {}, ["toolCalls"]);
        expect(commit().work.groups[0].ops).toEqual([{ op: "meta", set: {}, unset: ["toolCalls"] }]);
        expect(stored(server)).toBeUndefined();
        expect(chat.findChat(ref)!.toolCalls).toBeUndefined();
        // Two merges of the same id: the later entry wins, as on the server.
        chat.mergeChatMeta(ref, "toolCalls", { i: record("i") });
        chat.mergeChatMeta(ref, "toolCalls", { i: { ...record("i"), response: [{ type: "text", text: "newer" }] } });
        expect(commit().work.groups[0].ops).toEqual([
            {
                op: "meta",
                set: {},
                unset: [],
                merge: { toolCalls: { i: { ...record("i"), response: [{ type: "text", text: "newer" }] } } },
            },
        ]);
        expect(stored(server)).toEqual({ i: { ...record("i"), response: [{ type: "text", text: "newer" }] } });
    });
});
