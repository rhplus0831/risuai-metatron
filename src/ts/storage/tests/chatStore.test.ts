import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageTranslation } from "../../../../shared/database.ts";
import { translationSourceHash } from "../../../../shared/translation/hash.ts";
import { storedTranslation } from "../../../../shared/translation/messageTranslation.ts";
import { StoreBackedServer } from "./storeBackedServer";

// The chat mutation module (`chatStore.svelte.ts`) on a fresh module graph per test, against the real
// server store in memory: the mirror, the queue and its coalescing, membership and selection, the
// generation lock, conflict recovery, and the three-way `applyChatResult`. The save loop is driven by
// hand here (`take` → `store.applyChanges` → `ack`); `resourceSyncChats.test.ts` runs it for real.

/** The server of the running test, for the chat module's own reads (a load of a chat held as its summary). */
const { serverHolder } = vi.hoisted(() => ({ serverHolder: { current: null as any } }));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => serverHolder.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
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
    serverHolder.current = server;
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
    const chat: ChatModule = await import("../chatStore.svelte");
    const records = await import("../records.svelte");
    const characterStore = await import("../characterStore.svelte");
    const selection = await import("../selection.svelte");
    const read = server.store.readKinds([characters], { chats: true });
    // The characters are records since Phase 6 slice 5: installed as `loadData` installs them, so the
    // selection (by id) sees them.
    records.initializeRecords(
        records.takeRecordFields({ characters: read.kinds.characters.map((record) => record.data) }),
    );
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(characterStore.characterList() as any, read.chats!, read.chatOrders!);
    chat.initializeChats();
    const ref = { chaId: "c", chatId: "k" };
    const character = () => characterStore.characterList()[0] as any;
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
    return {
        server,
        chat,
        records,
        characterStore,
        selection,
        ref,
        character,
        take,
        apply,
        ack,
        commit,
        recover,
        open,
    };
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
        // A field the server does not default (an unset `note` is written as its default since Phase 6
        // slice 5b, so it is no unset any more).
        chat.setChatMeta(ref, { scriptstate: { $a: "1" } });
        // Set then unset the same field: only the unset survives, beside the other set.
        chat.setChatMeta(ref, { name: "N" }, ["scriptstate"]);
        chat.appendMessage(ref, m("x", "X"));
        chat.appendMessage(ref, m("y", "Y"));
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "setText", id: "a", text: "two" },
            { op: "setMessage", message: m("b", "B3") },
            { op: "meta", set: { name: "N" }, unset: ["scriptstate"] },
            { op: "append", messages: [m("x", "X"), m("y", "Y")], anchor: { end: true } },
        ]);
        const saved = server.chat("c", "k")!.data as any;
        expect(saved.name).toBe("N");
        expect(saved).not.toHaveProperty("scriptstate");
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
        // Phase 6 slice 9a: the chats are held in the module; nothing is written onto the characters.
        expect(chat.chatList("z").map((entry) => entry.id)).toEqual(["two", "one", "extra"]);
        expect(chat.selectedChatIndex("z")).toBe(0);
        expect(characters[0]).toEqual({ chaId: "z", chats: [], chatPage: 3 });
        expect(console.error).toHaveBeenCalledTimes(2);
    });
});

describe("generation lock", () => {
    it("refuses edits, removals, and a chat replacement touching a message a server job locks, keeps the other messages editable, and keeps the lock until the job ends", async () => {
        const { server, chat, ref, take, commit } = await boot();
        chat.applyServerGeneration(ref, { jobId: "J", messageId: "a", generationId: "g1", text: "partial", seq: 0 });
        expect(chat.findChat(ref)!.message[0].data).toBe("partial");
        // The streamed text is mirror only: nothing is queued for it.
        expect(take().groups).toEqual([]);

        expect(() => chat.setMessageText(ref, "a", "manual")).toThrow(/being generated/);
        expect(() => chat.removeMessages(ref, ["a"])).toThrow(/being generated/);
        expect(() => chat.replaceChat(ref, clone(chat.findChat(ref)))).toThrow(/being generated/);
        chat.setMessageText(ref, "b", "other messages stay editable");
        commit();
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        chat.endServerJob("J");
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        expect(server.texts("c", "k")).toEqual(["A", "other messages stay editable", "C"]);

        // A late chunk of the ended job changes nothing, and never becomes a manual write.
        expect(
            chat.applyServerGeneration(ref, {
                jobId: "J",
                messageId: "a",
                generationId: "g1",
                text: "late chunk",
                seq: 1,
            }),
        ).toBe(false);
        expect(chat.findChat(ref)!.message[0].data).toBe("partial");
        expect(take().groups).toEqual([]);
    });

    it("defers the reload of a chat a server job streams into until the job ends", async () => {
        const { server, chat, ref, take, recover } = await boot();
        chat.applyServerGeneration(ref, {
            jobId: "J",
            messageId: "a",
            generationId: "g",
            text: "streamed so far",
            seq: 0,
        });
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        chat.removeMessages(ref, ["b", "c"]);
        const work = take();
        const { conflicts } = recover(work);
        expect(conflicts).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: expect.any(String) }]);
        expect(chat.isChatDeferred("c\u0000k")).toBe(true);
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        expect(take().groups).toEqual([]);
        expect(chat.deferredReloads()).toEqual([]);
        // The mirror keeps the local state while the job streams.
        expect(texts(chat.findChat(ref))).toEqual(["streamed so far"]);

        chat.endServerJob("J");
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        expect(chat.deferredReloads()).toEqual([ref]);
        expect(chat.finishDeferredReload(server.chat("c", "k")! as any)).toBeNull();
        expect(chat.isChatDeferred("c\u0000k")).toBe(false);
        // The bulk removal is discarded with the reload; the server's copy replaces the chat.
        expect(texts(chat.findChat(ref))).toEqual(["A", "B", "C"]);
        expect((chat.findChat(ref) as any).note).toBe("remote");
        expect(chat.chatDiscardsSince(0)).toEqual(["c/k"]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("conflict recovery", () => {
    it("keeps a chat whose create the server refused: quarantined with an alert, not dropped", async () => {
        const { server, chat, records } = await boot();
        const alert = await import("../../alert");
        // The list changes only through its operations (Phase 6 slice 5); the raw insertion the
        // character module makes, without its normalization.
        records.insertCharacterRecord({ chaId: "z", name: "Z", chats: [], chatPage: 0 });
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
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["j"]);
        recover(take());
        // The recovered list brings `k` back as its summary (Phase 6 slice 9b): listed at its server
        // position, in the facade (the loaded chats) only once it is loaded.
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["k", "j"]);
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["j"]);
        expect(server.order("c")!.ids).toEqual(["k", "j"]);
        expect(chat.findChat(ref)).toBeUndefined();
        await chat.ensureChatLoaded(ref);
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["k", "j"]);
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
        // The collection read brings the other tab's chat in (as its summary, Phase 6 slice 9b); the
        // server order stands.
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(server.order("c")!.ids);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["k", "local", "r"]);
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["k", "local"]);
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

    it("sets and unsets chat fields from the diff, and gives an omitted fmIndex its default", async () => {
        const { server, chat, ref, commit } = await boot();
        // A field the result can unset: `fmIndex` is a chat default since Phase 6 slice 5b (below).
        chat.setChatMeta(ref, { hypaV3Data: { summaries: [] } });
        commit();
        const baseline = chat.captureChatBaseline(ref);
        const result = clone(baseline.chat) as any;
        result.note = "hook note";
        result.scriptstate = { $count: "1" };
        delete result.hypaV3Data;
        // An omitted `fmIndex` gets its default (the character's `firstMsgIndex`, -1), the value it had,
        // so it is not unset and nothing is sent for it.
        delete result.fmIndex;
        chat.applyChatResult(baseline, result);
        const mirror = chat.findChat(ref) as any;
        expect(mirror.note).toBe("hook note");
        expect(mirror.scriptstate).toEqual({ $count: "1" });
        expect(mirror).not.toHaveProperty("hypaV3Data");
        expect(mirror.fmIndex).toBe(-1);
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "meta", set: { note: "hook note", scriptstate: { $count: "1" } }, unset: ["hypaV3Data"] },
        ]);
        const saved = server.chat("c", "k")!.data as any;
        expect(saved.note).toBe("hook note");
        expect(saved.scriptstate).toEqual({ $count: "1" });
        expect(saved).not.toHaveProperty("hypaV3Data");
        expect(saved.fmIndex).toBe(-1);
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
        const { chat, ref, take } = await boot();
        // The job's accepted snapshot holds the stored text so far.
        chat.applyServerGeneration(ref, { jobId: "J", messageId: "a", generationId: "g", text: "A", seq: 0 });
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
});

describe("unload work (pagehide)", () => {
    const LIMIT = 60 * 1024;

    it("settles a surviving page's answer like an acknowledgement, so the tab's next current-revision op does not conflict with its own write", async () => {
        const { server, chat, ref, take, apply, ack, commit } = await boot();
        chat.setMessageText(ref, "a", "unload write");
        const [request] = chat.unloadPendingChatWork(LIMIT);
        chat.trackUnloadWork(request.work);

        // Queued work of that chat waits for the answer; other chats are not held.
        chat.setChatMeta(ref, { note: "edited while the answer is out" });
        expect(chat.hasChatWork()).toBe(false);
        expect(take().groups).toEqual([]);
        const answer = server.store.applyChanges(JSON.parse(request.body));
        expect(server.texts("c", "k")[0]).toBe("unload write");
        chat.settleUnloadWork(request.work, answer.chats);
        expect(chat.hasChatWork()).toBe(true);

        // The note goes out on the revision the unload write produced: not stale.
        const note = commit();
        expect(note.work.groups[0].ops).toEqual([
            { op: "meta", set: { note: "edited while the answer is out" }, unset: [] },
        ]);
        expect(note.result.chats[0].stale).toBeUndefined();

        // A current-revision op (a bulk removal) goes out on the revision this tab holds.
        chat.removeMessages(ref, ["b", "c"]);
        const bulk = take();
        expect(bulk.groups[0].baseRevision).toBe(server.chat("c", "k")!.revision);
        ack(bulk, apply(bulk));
        expect(server.texts("c", "k")).toEqual(["unload write"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("keeps the base when the answer is lost or stale", async () => {
        const { server, chat, ref, take, commit, recover } = await boot();
        chat.setMessageText(ref, "a", "unload write");

        // Lost answer (the request failed, or the page did not survive to see it): the chat's work
        // resumes on the old base. Had the write landed anyway, the next current-revision op
        // conflicts and reloads the chat, which is the documented protection of unseen writes.
        const [lost] = chat.unloadPendingChatWork(LIMIT);
        chat.trackUnloadWork(lost.work);
        server.store.applyChanges(JSON.parse(lost.body));
        chat.settleUnloadWork(lost.work, null);
        chat.setChatMeta(ref, { note: "after the lost answer" });
        const note = commit();
        expect(note.result.chats[0].stale).toBe(true);
        chat.removeMessages(ref, ["b", "c"]);
        const { conflicts, reloaded } = recover(take());
        expect(conflicts).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: expect.any(String) }]);
        expect(reloaded).toBe(true);
        expect(chat.chatDiscardsSince(0)).toEqual(["c/k"]);
        expect(texts(chat.findChat(ref))).toEqual(["unload write", "B", "C"]);
        expect((chat.findChat(ref) as any).note).toBe("after the lost answer");
        expect(chat.hasChatWork()).toBe(false);

        // Stale answer (another tab wrote meanwhile): the base stays older, as for any acknowledgement.
        chat.setMessageText(ref, "a", "third");
        const before = server.chat("c", "k")!.revision;
        server.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: before, ops: [{ op: "setText", id: "b", text: "remote" }] },
        ]);
        const [stale] = chat.unloadPendingChatWork(LIMIT);
        chat.trackUnloadWork(stale.work);
        const staleAnswer = server.store.applyChanges(JSON.parse(stale.body));
        expect(staleAnswer.chats[0].stale).toBe(true);
        chat.settleUnloadWork(stale.work, staleAnswer.chats);
        chat.setChatMeta(ref, { note: "still on the old base" });
        expect(commit().result.chats[0].stale).toBe(true);

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

    it("takes only a by-id prefix, leaves a chat's request out whole when it does not fit the remaining budget, and skips a chat with a request in flight", async () => {
        const { server, chat, ref, take, apply, ack, commit } = await boot();
        const refJ = { chaId: "c", chatId: "j" };
        const bytes = (body: string) => new TextEncoder().encode(body).length;
        chat.createChat("c", { id: "j", name: "J", note: "", localLore: [], message: [m("x", "X")] } as any);
        commit();
        const long = "long ".repeat(400);
        chat.setMessageText(ref, "a", long);
        // A bulk removal needs the current revision: it and everything after it stay queued.
        chat.removeMessages(ref, ["b", "c"]);
        chat.setChatMeta(ref, { note: "after the removal" });
        chat.setChatMeta(refJ, { note: "small" });

        const both = chat.unloadPendingChatWork(LIMIT);
        expect(both.map((request) => request.work.groups[0].chatId)).toEqual(["k", "j"]);
        const [requestK, requestJ] = both;
        expect(requestK.work.groups[0].ops).toEqual([{ op: "setText", id: "a", text: long }]);
        // Part of the chat's queue: settling it settles nothing (sequence 0).
        expect(requestK.work.groups[0].seq).toBe(0);

        // A budget one byte short of k's request: k is left out whole (never a part of its ops), and
        // the next chat that fits still goes.
        const onlyJ = chat.unloadPendingChatWork(bytes(requestK.body) - 1);
        expect(onlyJ.map((request) => request.work.groups[0].chatId)).toEqual(["j"]);
        expect(onlyJ[0].body).toBe(requestJ.body);
        expect(chat.unloadPendingChatWork(bytes(requestJ.body) - 1)).toEqual([]);

        // Sent: only the prefix leaves k's queue; the rest goes after the answer.
        chat.trackUnloadWork(requestK.work);
        const workJ = take();
        expect(workJ.groups.map((group) => group.chatId)).toEqual(["j"]);
        ack(workJ, apply(workJ));
        const answer = server.store.applyChanges(JSON.parse(requestK.body));
        chat.settleUnloadWork(requestK.work, answer.chats);
        const rest = take();
        expect(rest.groups.map((group) => group.chatId)).toEqual(["k"]);
        expect(rest.groups[0].ops.map((op) => op.op)).toEqual(["remove", "meta"]);
        ack(rest, apply(rest));
        expect(server.texts("c", "k")).toEqual([long]);

        // A chat with a request in flight is skipped until its answer.
        chat.setChatMeta(ref, { note: "k again" });
        chat.setChatMeta(refJ, { note: "j again" });
        const inflight = take();
        chat.setChatMeta(ref, { note: "k behind the request" });
        chat.setChatMeta(refJ, { note: "j behind the request" });
        expect(chat.unloadPendingChatWork(LIMIT)).toEqual([]);
        ack(inflight, apply(inflight));
        expect(chat.unloadPendingChatWork(LIMIT).map((request) => request.work.groups[0].chatId)).toEqual(["k", "j"]);
    });
});

describe("streaming message identity", () => {
    it("locks the generating message in its own chat only, not its copy in a branched chat that kept the message ids", async () => {
        const { chat, ref } = await boot();
        const source = chat.findChat(ref)!;
        const branch = chat.createChat("c", { ...clone(source), id: "branch", name: "Branch" } as any, { index: 0 });
        expect(ids(branch)).toEqual(ids(source));
        const refBranch = { chaId: "c", chatId: branch.id! };
        chat.applyServerGeneration(ref, { jobId: "J", messageId: "a", generationId: "g", text: "A", seq: 0 });
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

    it("renames the streaming message when the server renames it in a whole-chat write of its chat, and leaves another character's chat with the same ids alone", async () => {
        const { chat, ref, take, apply, ack } = await boot();
        /** Sends a replace of `k` and acknowledges it with the server renaming its messages to `renamed`. */
        const replaceRenaming = (renamed: string[]) => {
            chat.replaceChat(ref, clone(chat.findChat(ref)) as any);
            const work = take();
            const result = apply(work);
            result.chats[0] = { ...result.chats[0], messageIds: renamed };
            ack(work, result);
        };
        chat.setStreamingState({ chaId: "other", chatId: "k", messageId: "b", mode: "balanced" });
        replaceRenaming(["a", "b2", "c"]);
        expect(ids(chat.findChat(ref))).toEqual(["a", "b2", "c"]);
        expect({ ...chat.streamingState }).toEqual({ chaId: "other", chatId: "k", messageId: "b", mode: "balanced" });

        chat.setStreamingState({ ...ref, messageId: "b2", mode: "strong" });
        replaceRenaming(["a", "b3", "c"]);
        expect(ids(chat.findChat(ref))).toEqual(["a", "b3", "c"]);
        expect({ ...chat.streamingState }).toEqual({ ...ref, messageId: "b3", mode: "strong" });
        expect(chat.isStreamingMessage(ref, "b3")).toBe(true);
    });
});

describe("new characters", () => {
    it("normalizeNewCharacter gives a new character's chats and messages ids (a default chat when it has none) without queuing anything; adoptCharacter queues the creates once", async () => {
        const { server, chat, records, characterStore, selection } = await boot();
        // The list changes only through its operations (Phase 6 slice 5): the raw insertion
        // `addCharacter` makes, here without the normalization this case calls by hand. Since Phase 6
        // slice 9a the record holds no chats: they are installed in the chat module first
        // (`installCharacterChats`, as `addCharacter` does).
        for (const character of [
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
            },
            { chaId: "e", name: "E", chats: [] },
        ]) {
            chat.installCharacterChats(
                character.chaId,
                character.chats as any,
                character as { firstMsgIndex?: unknown },
            );
            records.insertCharacterRecord(character);
        }
        chat.normalizeNewCharacter("n");
        chat.normalizeNewCharacter("e");
        const n = characterStore.characterList()[1] as any;
        const e = characterStore.characterList()[2] as any;
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
        selection.selectCharacterAt(0);
        expect(chat.currentChatRef()).toEqual({ chaId: "c", chatId: "k" });
        selection.selectCharacterAt(2);
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

describe("message translations (translation slice 1.1)", () => {
    const tr = (text: string, source: string, extra: Partial<MessageTranslation> = {}): MessageTranslation => ({
        text,
        sourceHash: translationSourceHash(source),
        targetLanguage: "ko",
        translatedAt: 1,
        ...extra,
    });
    const stored = (server: Awaited<ReturnType<typeof boot>>["server"], chatId: string, id: string) =>
        server.chat("c", chatId)!.data.message.find((message) => message.chatId === id) as unknown as Record<
            string,
            unknown
        >;
    const message = (chat: ChatModule, ref: { chaId: string; chatId: string }, id: string) =>
        chat.findChat(ref)!.message.find((message) => message.chatId === id) as unknown as Record<string, unknown>;

    it("setMessageTranslation takes a translation of the current text from a detached copy, refuses a stale, malformed, or locked one without changing anything, never coalesces, and the op lands through the batch and the unload request", async () => {
        const { server, chat, ref, take, commit } = await boot();
        const T = tr("ㄱ", "A");
        // Refused: a translation of another text (false, nothing queued), a malformed one, a missing
        // message, and a message a server job generates.
        expect(chat.setMessageTranslation(ref, "a", tr("x", "not A"))).toBe(false);
        expect(() => chat.setMessageTranslation(ref, "a", { text: "x" } as never)).toThrow(/Not a message translation/);
        expect(() => chat.setMessageTranslation(ref, "zz", T)).toThrow(/No message zz/);
        chat.applyServerGeneration(ref, { jobId: "J", messageId: "b", generationId: "g", text: "partial", seq: 0 });
        expect(() => chat.setMessageTranslation(ref, "b", tr("x", "partial"))).toThrow(/being generated/);
        // Nothing was queued; the job's end only asks for the usual idle re-read of its chat.
        expect(take().groups).toEqual([]);
        chat.endServerJob("J");
        expect(chat.idleChatRefreshes()).toEqual([ref]);
        const afterJob = server.store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
        expect(chat.finishIdleChatRefresh(afterJob as any)).toBe(true);
        expect(chat.hasChatWork()).toBe(false);
        expect(message(chat, ref, "a")).not.toHaveProperty("translation");
        expect(message(chat, ref, "b")).not.toHaveProperty("translation");

        // Taken: from a detached copy; a clear and a set behind it stay separate ops.
        const input = clone(T);
        expect(chat.setMessageTranslation(ref, "a", input)).toBe(true);
        input.text = "mutated after the call";
        expect(message(chat, ref, "a")).toEqual({ ...m("a", "A", "char"), translation: T });
        expect(storedTranslation(message(chat, ref, "a") as never)).toBe("ㄱ");
        expect(chat.setMessageTranslation(ref, "a", null)).toBe(true);
        expect(message(chat, ref, "a")).not.toHaveProperty("translation");
        expect(chat.setMessageTranslation(ref, "a", T)).toBe(true);
        const first = commit();
        expect(first.work.groups[0].ops).toEqual([
            { op: "setTranslation", id: "a", translation: T },
            { op: "setTranslation", id: "a", translation: null },
            { op: "setTranslation", id: "a", translation: T },
        ]);
        expect(first.result.chats[0].translations).toEqual(["applied", "applied", "applied"]);
        expect(first.result.chats[0].stale).toBeUndefined();
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "A", "char"), translation: T });

        // A text edit after it leaves the field on both sides, stale by hash.
        chat.setMessageText(ref, "a", "A2");
        commit();
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "A2", "char"), translation: T });
        expect(storedTranslation(stored(server, "k", "a") as never)).toBeNull();
        expect(storedTranslation(message(chat, ref, "a") as never)).toBeNull();

        // A pending setTranslation is by-id work: it goes out with the page.
        const T2 = tr("ㄱ2", "A2");
        expect(chat.setMessageTranslation(ref, "a", T2)).toBe(true);
        const [request] = chat.unloadPendingChatWork(60 * 1024);
        chat.trackUnloadWork(request.work);
        expect(JSON.parse(request.body).chats[0].ops).toEqual([{ op: "setTranslation", id: "a", translation: T2 }]);
        const answer = server.store.applyChanges(JSON.parse(request.body));
        expect(answer.chats[0].translations).toEqual(["applied"]);
        chat.settleUnloadWork(request.work, answer.chats);
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "A2", "char"), translation: T2 });
        expect(chat.hasChatWork()).toBe(false);
    });

    it("replaceMessage keeps the held translation as the server keeps its stored one, and a translation the server ignores leaves the result stale so the idle refresh converges the mirror", async () => {
        const { server, chat, ref, commit } = await boot();
        const T = tr("ㄱ", "A");
        expect(chat.setMessageTranslation(ref, "a", T)).toBe(true);
        commit();

        // A whole-message write from a copy without the key, then from one with an older translation.
        chat.replaceMessage(ref, { ...m("a", "A", "char"), name: "n" });
        expect(message(chat, ref, "a")).toEqual({ ...m("a", "A", "char"), name: "n", translation: T });
        const replaced = commit();
        expect(replaced.work.groups[0].ops).toEqual([
            { op: "setMessage", message: { ...m("a", "A", "char"), name: "n", translation: T } },
        ]);
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "A", "char"), name: "n", translation: T });
        chat.replaceMessage(ref, { ...m("a", "A", "char"), translation: tr("old", "A", { translatedAt: 0 }) });
        expect(message(chat, ref, "a")).toEqual({ ...m("a", "A", "char"), translation: T });
        commit();
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "A", "char"), translation: T });

        // Another tab edits the text; this tab, still showing "A", translates it: taken locally (the
        // hash matches its copy), ignored by the server, which also says the base is older.
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "a", text: "remote" }],
            },
        ]);
        const T2 = tr("ㄱ2", "A", { translatedAt: 2 });
        expect(chat.setMessageTranslation(ref, "a", T2)).toBe(true);
        expect(message(chat, ref, "a")).toEqual({ ...m("a", "A", "char"), translation: T2 });
        const ignored = commit();
        expect(ignored.result.chats[0]).toMatchObject({ translations: ["ignored"], stale: true });
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "remote", "char"), translation: T });

        // The idle re-read replaces the optimistic copy with the server's: the older translation,
        // stale by hash.
        expect(chat.idleChatRefreshes()).toEqual([ref]);
        const refreshed = server.store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
        expect(chat.finishIdleChatRefresh(refreshed as any)).toBe(true);
        expect(message(chat, ref, "a")).toEqual({ ...m("a", "remote", "char"), translation: T });
        expect(storedTranslation(message(chat, ref, "a") as never)).toBeNull();
        expect(chat.hasChatWork()).toBe(false);
        expect(chat.chatDiscardsSince(0)).toEqual([]);
    });

    it("drops a translation that is not a MessageTranslation wherever messages come in, so the mirror holds the server's copy and a create whose acknowledgement was lost is recognized with the edit made meanwhile kept", async () => {
        const { server, chat, take, apply, recover, commit } = await boot();
        const ref = { chaId: "c", chatId: "n" };
        const T = tr("ㄷ", "C");
        const stale = tr("ㅅ", "before the edit");
        chat.createChat("c", {
            id: "n",
            name: "N",
            message: [
                { ...m("x", "old"), translation: "legacy string" },
                { ...m("y", "Y"), translation: null },
                { ...m("z", "C"), translation: T },
                { ...m("w", "W"), translation: stale },
            ],
        } as any);
        const translations = (messages: readonly unknown[]) =>
            messages.map((entry) => (entry as Record<string, unknown>).translation);
        expect(translations(chat.findChat(ref)!.message)).toEqual([undefined, undefined, T, stale]);
        expect(message(chat, ref, "x")).not.toHaveProperty("translation");
        expect(message(chat, ref, "y")).not.toHaveProperty("translation");
        const sent = take();
        apply(sent);
        expect(translations(server.chat("c", "n")!.data.message)).toEqual([undefined, undefined, T, stale]);
        expect(stored(server, "n", "x")).toEqual(m("x", "old"));

        // The answer was lost; the retry of the create is recognized as landed (the mirror's copy
        // matches the server's, translations included) and the newer edit goes out after it.
        chat.setMessageText(ref, "x", "newer edit");
        chat.requeueChatWork(sent);
        const { conflicts, reloaded } = recover(take());
        expect(conflicts).toHaveLength(1);
        expect(reloaded).toBe(false);
        const { work } = commit();
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["setText"]);
        expect(server.texts("c", "n")).toEqual(["newer edit", "Y", "C", "W"]);
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);

        // An appended message is taken in the same way.
        chat.appendMessage(ref, { ...m("v", "V"), translation: { text: "no hash" } } as any);
        expect(message(chat, ref, "v")).toEqual(m("v", "V"));
        commit();
        expect(stored(server, "n", "v")).toEqual(m("v", "V"));
    });
});
