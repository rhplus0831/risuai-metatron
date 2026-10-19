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
    /** The request body as the save loop sends it (`groupId` and `retry` included, slice 6b). */
    const bodyOf = (work: ChatModule["takeChatWork"] extends (...args: any) => infer R ? R : never) => {
        const body = chat.chatWorkBody(work);
        return {
            chats: body.chats.map((text) => JSON.parse(text)),
            chatOrders: body.chatOrders.map((text) => JSON.parse(text)),
        };
    };
    const apply = (work: ChatModule["takeChatWork"] extends (...args: any) => infer R ? R : never) =>
        work.groups.length + work.orders.length === 0
            ? { results: [], chats: [], chatOrders: [] }
            : server.store.applyChanges(bodyOf(work));
    /**
     * Applies the work as a server that remembers no group id does (slice 6b: the id was dropped, or
     * the chat's list of ids moved past it), so a resend meets the ordinary checks instead of the
     * remembered answer.
     */
    const applyForgotten = (work: ReturnType<typeof take>) => {
        const body = bodyOf(work);
        return server.store.applyChanges({
            ...body,
            chats: body.chats.map(({ groupId: _groupId, retry: _retry, ...group }) => group),
        });
    };
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
        const keyOf = (conflict: any) => `${conflict.characterId}\u0000${conflict.id}`;
        const result = chat.recoverChatConflicts(
            work,
            new Set(chats.map(keyOf)),
            new Set(orders.map((conflict) => conflict.characterId)),
            remote as any,
            undefined,
            undefined,
            new Set(chats.filter((conflict) => conflict.reason === "expired").map(keyOf)),
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
        applyForgotten,
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
        const { server, chat, take, applyForgotten, recover, commit } = await boot();
        const ref = { chaId: "c", chatId: "n" };
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "old")] } as any);
        const sent = take();
        // Landed, but not remembered by its id (slice 6b): the resend is recognized by its content.
        applyForgotten(sent);
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
        // The hook's change of `a` goes as a patch of the field it changed (slice 1b), not the row.
        expect(work.groups[0].ops.map((op) => op.op)).toEqual([
            "setText",
            "append",
            "remove",
            "patchMessage",
            "append",
        ]);
        expect(work.groups[0].ops[3]).toEqual({ op: "patchMessage", id: "a", set: { data: "A by the hook" } });
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
        // `scriptstate` is a map field: the baseline lacked it (an empty map), so its entry is merged
        // (slice 1b), folded into the same `meta` op as the set and the unset.
        expect(work.groups[0].ops).toEqual([
            {
                op: "meta",
                set: { note: "hook note" },
                unset: ["hypaV3Data"],
                merge: { scriptstate: { $count: "1" } },
            },
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
        expect(work.groups[0].ops.map((op) => op.op)).toEqual(["meta", "patchMessage"]);
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

    it("sends a changed message as a patch of only the fields the hook changed (a plugin setChat of one field), so another tab's text survives an older base, and a translation-only change sends nothing", async () => {
        const { server, chat, ref, take, commit } = await boot();
        chat.replaceMessage(ref, { ...m("b", "B"), saying: "old" });
        commit();
        const baseline = chat.captureChatBaseline(ref);
        // Another tab edits `a` meanwhile; this tab's base is older.
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "a", text: "A by the other tab" }],
            },
        ]);
        const result = clone(baseline.chat) as any;
        result.message[0].disabled = true;
        delete result.message[1].saying;
        chat.applyChatResult(baseline, result);
        expect(chat.findChat(ref)!.message[0]).toEqual({ ...m("a", "A", "char"), disabled: true });
        expect(chat.findChat(ref)!.message[1]).toEqual(m("b", "B"));
        const applied = commit();
        expect(applied.work.groups[0].ops).toEqual([
            { op: "patchMessage", id: "a", set: { disabled: true } },
            { op: "patchMessage", id: "b", unset: ["saying"] },
        ]);
        expect(applied.result.chats[0].stale).toBe(true);
        const stored = server.chat("c", "k")!.data.message as any[];
        expect(stored[0]).toEqual({ ...m("a", "A by the other tab", "char"), disabled: true });
        expect(stored[1]).toEqual(m("b", "B"));

        // A result that only carries a translation (the runner's field) changes nothing and sends nothing.
        const again = chat.captureChatBaseline(ref);
        const translated = clone(again.chat) as any;
        translated.message[2].translation = {
            text: "ㄷ",
            sourceHash: translationSourceHash("C"),
            targetLanguage: "ko",
            translatedAt: 1,
        };
        chat.applyChatResult(again, translated);
        expect(chat.findChat(ref)!.message[2]).toEqual(m("c", "C", "char"));
        // Nothing queued (the chat is marked for an idle refresh since its stale acknowledgement).
        expect(take().groups).toEqual([]);
    });

    it("refuses an invalid message change before anything lands, and ignores one of a message removed meanwhile", async () => {
        const { chat, ref, take } = await boot();
        const baseline = chat.captureChatBaseline(ref);
        // A valid first change and an invalid second one: neither lands.
        let result = clone(baseline.chat) as any;
        result.message[0].disabled = true;
        result.message[1].role = "system";
        expect(() => chat.applyChatResult(baseline, result)).toThrow(/role must be user or char/);
        result = clone(baseline.chat) as any;
        result.message[0].disabled = true;
        result.message[1].data = 7;
        expect(() => chat.applyChatResult(baseline, result)).toThrow(/data must be a string/);
        expect(chat.findChat(ref)!.message[0]).toEqual(m("a", "A", "char"));
        expect(chat.hasChatWork()).toBe(false);
        expect(take().groups).toEqual([]);

        // The hook also mangled `c`, removed meanwhile: that change has nothing to land on, so it
        // does not refuse the result.
        chat.removeMessages(ref, ["c"]);
        result = clone(baseline.chat) as any;
        result.message[0].disabled = true;
        result.message[2].role = "system";
        chat.applyChatResult(baseline, result);
        expect(chat.findChat(ref)!.message[0]).toEqual({ ...m("a", "A", "char"), disabled: true });
        expect(take().groups[0].ops).toEqual([
            { op: "remove", ids: ["c"] },
            { op: "patchMessage", id: "a", set: { disabled: true } },
        ]);
    });

    it("merges a changed map field entry by entry: a map the baseline lacked counts as empty, removed entries are unset, and a transition from or to a non-map is a whole-field write", async () => {
        const { server, chat, ref, commit } = await boot();
        const saved = () => server.chat("c", "k")!.data as any;
        // No `scriptstate` in the baseline; another tab adds `$b` meanwhile: the hook's `$a` is merged.
        let baseline = chat.captureChatBaseline(ref);
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "meta", merge: { scriptstate: { $b: "2" } } }],
            },
        ]);
        let result = clone(baseline.chat) as any;
        result.scriptstate = { $a: "1" };
        result.GLGlobalVariables = { toggle_x: "1" };
        chat.applyChatResult(baseline, result);
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $a: "1" });
        // Two merges, one per field, folded into one op (set and unset appear once it coalesces).
        expect(commit().work.groups[0].ops).toEqual([
            {
                op: "meta",
                set: {},
                unset: [],
                merge: { scriptstate: { $a: "1" }, GLGlobalVariables: { toggle_x: "1" } },
            },
        ]);
        expect(saved().scriptstate).toEqual({ $b: "2", $a: "1" });
        expect(saved().GLGlobalVariables).toEqual({ toggle_x: "1" });

        // A changed, a removed, and an added entry of a map the baseline had.
        chat.setChatMeta(ref, { scriptstate: { $a: "1", $c: "3" } });
        commit();
        baseline = chat.captureChatBaseline(ref);
        result = clone(baseline.chat) as any;
        result.scriptstate = { $a: "1x", $d: "4" };
        chat.applyChatResult(baseline, result);
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $a: "1x", $d: "4" });
        expect(commit().work.groups[0].ops).toEqual([
            { op: "meta", merge: { scriptstate: { $a: "1x", $d: "4" } }, mergeUnset: { scriptstate: ["$c"] } },
        ]);
        expect(saved().scriptstate).toEqual({ $a: "1x", $d: "4" });

        // A map replaced by a value that is not one, and a map replacing such a value, are whole-field
        // sets; removing the field is an unset.
        baseline = chat.captureChatBaseline(ref);
        result = clone(baseline.chat) as any;
        result.scriptstate = "text";
        chat.applyChatResult(baseline, result);
        expect(commit().work.groups[0].ops).toEqual([{ op: "meta", set: { scriptstate: "text" }, unset: [] }]);
        expect(saved().scriptstate).toBe("text");
        baseline = chat.captureChatBaseline(ref);
        result = clone(baseline.chat) as any;
        result.scriptstate = { $e: "5" };
        chat.applyChatResult(baseline, result);
        expect(commit().work.groups[0].ops).toEqual([{ op: "meta", set: { scriptstate: { $e: "5" } }, unset: [] }]);
        expect(saved().scriptstate).toEqual({ $e: "5" });
        baseline = chat.captureChatBaseline(ref);
        result = clone(baseline.chat) as any;
        delete result.scriptstate;
        chat.applyChatResult(baseline, result);
        expect(commit().work.groups[0].ops).toEqual([{ op: "meta", set: {}, unset: ["scriptstate"] }]);
        expect(saved()).not.toHaveProperty("scriptstate");
        expect(chat.findChat(ref)).not.toHaveProperty("scriptstate");
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

        // Lost answer (the request failed, or the page did not survive to see it) after the server
        // applied it: the group is resent alone, exactly as sent and with `retry` (slice 6b), and the
        // server answers it as the duplicate it is; the note typed meanwhile follows in its own group
        // on the revision the unload write produced, so nothing is stale, reloaded, or discarded.
        const [lost] = chat.unloadPendingChatWork(LIMIT);
        chat.trackUnloadWork(lost.work);
        const sentBody = JSON.parse(lost.body).chats[0];
        expect(sentBody.groupId).toEqual(expect.any(String));
        expect(sentBody.retry).toBeUndefined();
        const landed = server.store.applyChanges(JSON.parse(lost.body)).chats[0];
        chat.settleUnloadWork(lost.work, null);
        chat.setChatMeta(ref, { note: "after the lost answer" });
        const resend = commit();
        expect(
            resend.work.groups.map((group) => [group.ops, group.baseRevision, group.groupId, group.inDoubt]),
        ).toEqual([[sentBody.ops, sentBody.baseRevision, sentBody.groupId, true]]);
        expect(resend.result.chats[0]).toEqual(landed);
        expect(server.texts("c", "k")[0]).toBe("unload write");
        const note = commit();
        expect(note.work.groups.map((group) => group.ops)).toEqual([
            [{ op: "meta", set: { note: "after the lost answer" }, unset: [] }],
        ]);
        expect(note.work.groups[0].groupId).not.toBe(sentBody.groupId);
        expect(note.result.chats[0].stale).toBeUndefined();
        expect(chat.chatDiscardsSince(0)).toEqual([]);
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
        // Built again: the same request but for its fresh group id (slice 6b).
        const withoutId = (body: string) => JSON.parse(body, (key, value) => (key === "groupId" ? undefined : value));
        expect(withoutId(onlyJ[0].body)).toEqual(withoutId(requestJ.body));
        expect(bytes(onlyJ[0].body)).toBe(bytes(requestJ.body));
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

describe("field patches and entry removals (data-loss slice 1b)", () => {
    const LIMIT = 60 * 1024;
    const stored = (server: Awaited<ReturnType<typeof boot>>["server"], chatId: string, id: string) =>
        server.chat("c", chatId)!.data.message.find((message) => message.chatId === id) as unknown as Record<
            string,
            unknown
        >;
    const message = (chat: ChatModule, ref: { chaId: string; chatId: string }, id: string) =>
        chat.findChat(ref)!.message.find((message) => message.chatId === id) as unknown as Record<string, unknown>;
    const scriptstate = (server: Awaited<ReturnType<typeof boot>>["server"]) =>
        (server.chat("c", "k")!.data as { scriptstate?: unknown }).scriptstate;

    it("patchMessage sends only the named fields, so a tab on an older base cannot revert another tab's text by toggling Disable; a field the mirror already holds and a removal it lacks still go", async () => {
        const { server, chat, ref, commit } = await boot();
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "a", text: "A by the other tab" }],
            },
        ]);
        const input = { disabled: true };
        chat.patchMessage(ref, "a", input);
        (input as { disabled: unknown }).disabled = "mutated after the call";
        // The mirror changed in place (still its older text), the op carries the one field.
        expect(message(chat, ref, "a")).toEqual({ ...m("a", "A", "char"), disabled: true });
        const applied = commit();
        expect(applied.work.groups[0].ops).toEqual([{ op: "patchMessage", id: "a", set: { disabled: true } }]);
        expect(applied.result.chats[0].stale).toBe(true);
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "A by the other tab", "char"), disabled: true });

        // A value the mirror already holds is sent (the server's copy may differ, and the write closes
        // the message's generation fence), without a mirror change; so is a removal of a field the
        // mirror lacks. Nothing is queued when no field is left.
        const version = chat.captureChatBaseline(ref).version;
        chat.patchMessage(ref, "b", { data: "B" });
        expect(chat.captureChatBaseline(ref).version).toBe(version);
        chat.patchMessage(ref, "c", {}, ["disabled"]);
        expect(chat.captureChatBaseline(ref).version).toBe(version);
        chat.patchMessage(ref, "c", {});
        chat.patchMessage(ref, "c", { translation: null }, ["translation"]);
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "patchMessage", id: "b", set: { data: "B" } },
            { op: "patchMessage", id: "c", unset: ["disabled"] },
        ]);
        expect(stored(server, "k", "b")).toEqual(m("b", "B"));
        expect(stored(server, "k", "c")).toEqual(m("c", "C", "char"));

        // The stored translation is the `setTranslation` op's: a patch naming it leaves it, and the
        // message's other fields are kept as stored.
        const T = {
            text: "ㄷ",
            sourceHash: translationSourceHash("C"),
            targetLanguage: "ko",
            translatedAt: 1,
        } as MessageTranslation;
        expect(chat.setMessageTranslation(ref, "c", T)).toBe(true);
        commit();
        chat.patchMessage(ref, "c", { translation: { ...T, text: "older" }, name: "n" }, ["translation"]);
        expect(message(chat, ref, "c")).toEqual({ ...m("c", "C", "char"), name: "n", translation: T });
        expect(commit().work.groups[0].ops).toEqual([{ op: "patchMessage", id: "c", set: { name: "n" } }]);
        expect(stored(server, "k", "c")).toEqual({ ...m("c", "C", "char"), name: "n", translation: T });
    });

    it("patchMessage refuses a malformed patch, a missing message, and a locked message before anything changes", async () => {
        const { chat, ref, take } = await boot();
        const before = clone(chat.findChat(ref)!.message);
        const shape = /patchMessage needs/;
        expect(() => chat.patchMessage(ref, "zz", { disabled: true })).toThrow(/No message zz/);
        expect(() => chat.patchMessage(ref, "a", [] as any)).toThrow(shape);
        expect(() => chat.patchMessage(ref, "a", "disabled" as any)).toThrow(shape);
        expect(() => chat.patchMessage(ref, "a", {}, [1] as any)).toThrow(shape);
        expect(() => chat.patchMessage(ref, "a", {}, new Array<string>(1))).toThrow(shape);
        expect(() => chat.patchMessage(ref, "a", { chatId: "other" })).toThrow(/cannot change chatId/);
        expect(() => chat.patchMessage(ref, "a", {}, ["chatId"])).toThrow(/cannot change chatId/);
        expect(() => chat.patchMessage(ref, "a", JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(
            /cannot change __proto__/,
        );
        expect(() => chat.patchMessage(ref, "a", {}, ["__proto__"])).toThrow(/cannot change __proto__/);
        expect(() => chat.patchMessage(ref, "a", {}, ["role"])).toThrow(/cannot unset role or data/);
        expect(() => chat.patchMessage(ref, "a", {}, ["data"])).toThrow(/cannot unset role or data/);
        expect(() => chat.patchMessage(ref, "a", { disabled: true }, ["disabled"])).toThrow(
            /sets and unsets the same field/,
        );
        expect(() => chat.patchMessage(ref, "a", { role: "system" } as any)).toThrow(/role must be user or char/);
        expect(() => chat.patchMessage(ref, "a", { data: 7 } as any)).toThrow(/data must be a string/);
        // A nested own `__proto__` is a legal value; only the field name is refused.
        chat.patchMessage(ref, "a", { custom: JSON.parse('{"__proto__": {"keep": true}, "x": 1}') });
        expect(Object.hasOwn(message(chat, ref, "a").custom as object, "__proto__")).toBe(true);
        chat.patchMessage(ref, "a", {}, ["custom"]);
        expect(chat.findChat(ref)!.message).toEqual(before);

        // The job's accepted snapshot holds the stored text so far: the message is locked.
        chat.applyServerGeneration(ref, { jobId: "J", messageId: "b", generationId: "g", text: "B", seq: 0 });
        expect(() => chat.patchMessage(ref, "b", { disabled: true })).toThrow(/being generated/);
        expect(chat.findChat(ref)!.message).toEqual(before);
        // Two patches of `a` that undo each other: an op the server applies as a no-op, nothing else.
        expect(take().groups[0].ops).toEqual([{ op: "patchMessage", id: "a", set: {}, unset: ["custom"] }]);
    });

    it("coalesces a patch with the unsent writes of its message as the server would apply them in order, never across messages", async () => {
        const { server, chat, ref, commit } = await boot();
        // patch + patch: a later unset drops the earlier set, a later set drops the earlier unset.
        chat.patchMessage(ref, "a", { disabled: true, name: "n1" });
        chat.patchMessage(ref, "a", {}, ["disabled"]);
        chat.patchMessage(ref, "a", { disabled: "allBefore" });
        // patch + a manual text write: the text joins the patch.
        chat.setMessageText(ref, "a", "A2");
        // text + patch stays two ops (a text write may carry a generation).
        chat.setMessageText(ref, "b", "B2");
        chat.patchMessage(ref, "b", { disabled: true });
        // patch + a whole row stays two ops; the row replaces the patched fields.
        chat.replaceMessage(ref, m("b", "B3"));
        // a whole row + patch: the patch goes into the row.
        chat.replaceMessage(ref, { ...m("c", "C2", "char"), name: "old" });
        chat.patchMessage(ref, "c", { disabled: true }, ["name"]);
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "patchMessage", id: "a", set: { name: "n1", disabled: "allBefore", data: "A2" }, unset: [] },
            { op: "setText", id: "b", text: "B2" },
            { op: "patchMessage", id: "b", set: { disabled: true } },
            { op: "setMessage", message: m("b", "B3") },
            { op: "setMessage", message: { ...m("c", "C2", "char"), disabled: true } },
        ]);
        // The server holds what the mirror holds.
        expect(server.chat("c", "k")!.data.message).toEqual(clone(chat.findChat(ref)!.message));
        expect(server.chat("c", "k")!.data.message).toEqual([
            { ...m("a", "A2", "char"), name: "n1", disabled: "allBefore" },
            m("b", "B3"),
            { ...m("c", "C2", "char"), disabled: true },
        ]);
    });

    it("goes out in the unload request, and a patch queued behind a create follows the server's rename of its message id", async () => {
        const { server, chat, ref, take, apply, ack, commit } = await boot();
        chat.patchMessage(ref, "a", { disabled: true });
        const [request] = chat.unloadPendingChatWork(LIMIT);
        expect(request.work.groups[0].ops).toEqual([{ op: "patchMessage", id: "a", set: { disabled: true } }]);
        chat.trackUnloadWork(request.work);
        chat.settleUnloadWork(request.work, server.store.applyChanges(JSON.parse(request.body)).chats);
        expect(stored(server, "k", "a")).toEqual({ ...m("a", "A", "char"), disabled: true });
        expect(chat.hasChatWork()).toBe(false);

        // The create is in flight when the patch is queued; the server renames the message.
        const refN = { chaId: "c", chatId: "n" };
        chat.createChat("c", { id: "n", name: "N", note: "", localLore: [], message: [m("bad\tid", "old")] } as any);
        const create = take();
        chat.patchMessage(refN, "bad\tid", { disabled: true });
        ack(create, apply(create));
        const serverId = server.chat("c", "n")!.data.message[0].chatId as string;
        expect(serverId).not.toBe("bad\tid");
        expect(chat.findChat(refN)!.message[0]).toEqual({ ...m(serverId, "old"), disabled: true });
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([{ op: "patchMessage", id: serverId, set: { disabled: true } }]);
        expect(stored(server, "n", serverId)).toEqual({ ...m(serverId, "old"), disabled: true });
    });

    it("mergeChatMeta removes entries (`mergeUnset`) and keeps what another writer added on an older base; a removal is sent also for an entry the mirror lacks, and is never folded", async () => {
        const { server, chat, ref, take, commit } = await boot();
        chat.setChatMeta(ref, { scriptstate: { $a: "1", $c: "3" } });
        commit();
        // Another tab adds `$x` meanwhile; this tab (older base) changes `$b` and removes `$c`.
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "meta", merge: { scriptstate: { $x: "x" } } }],
            },
        ]);
        const removals = ["$c"];
        chat.mergeChatMeta(ref, "scriptstate", { $b: "2" }, removals);
        removals.push("$a");
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $a: "1", $b: "2" });
        const applied = commit();
        expect(applied.work.groups[0].ops).toEqual([
            { op: "meta", merge: { scriptstate: { $b: "2" } }, mergeUnset: { scriptstate: ["$c"] } },
        ]);
        expect(applied.result.chats[0].stale).toBe(true);
        expect(scriptstate(server)).toEqual({ $a: "1", $x: "x", $b: "2" });

        // Removals alone (also of an entry the mirror lacks: the server's copy may hold it), an id
        // both added and removed (added), an entry normalized away before the overlap check (its
        // removal stays), and a set after them: none of these fold.
        chat.mergeChatMeta(ref, "scriptstate", {}, ["$nothere", "$nothere"]);
        chat.mergeChatMeta(ref, "scriptstate", { $d: "4" }, ["$d"]);
        chat.mergeChatMeta(ref, "scriptstate", { $a: undefined }, ["$a"]);
        chat.setChatMeta(ref, { note: "after" });
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $b: "2", $d: "4" });
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "meta", mergeUnset: { scriptstate: ["$nothere"] } },
            { op: "meta", merge: { scriptstate: { $d: "4" } } },
            { op: "meta", mergeUnset: { scriptstate: ["$a"] } },
            { op: "meta", set: { note: "after" }, unset: [] },
        ]);
        expect(scriptstate(server)).toEqual({ $x: "x", $b: "2", $d: "4" });

        // Nothing to do, and malformed arguments, change nothing.
        chat.mergeChatMeta(ref, "scriptstate", {}, []);
        expect(() => chat.mergeChatMeta(ref, "scriptstate", [] as any)).toThrow(/needs entries and entry ids/);
        expect(() => chat.mergeChatMeta(ref, "scriptstate", {}, [1] as any)).toThrow(/needs entries and entry ids/);
        expect(() => chat.mergeChatMeta(ref, "scriptstate", {}, new Array<string>(1))).toThrow(
            /needs entries and entry ids/,
        );
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $b: "2", $d: "4" });
        // Nothing queued (the chat is marked for an idle refresh since its stale acknowledgement).
        expect(take().groups).toEqual([]);
    });

    it("mergeChatMeta onto a field that is not a map: removals leave it, entries replace it, and a merge after a set of such a value is not folded into it", async () => {
        const { server, chat, ref, commit } = await boot();
        chat.setChatMeta(ref, { scriptstate: "ab" });
        chat.mergeChatMeta(ref, "scriptstate", {}, ["$z"]);
        expect((chat.findChat(ref) as any).scriptstate).toBe("ab");
        expect(commit().work.groups[0].ops).toEqual([
            { op: "meta", set: { scriptstate: "ab" }, unset: [] },
            { op: "meta", mergeUnset: { scriptstate: ["$z"] } },
        ]);
        expect(scriptstate(server)).toBe("ab");
        chat.mergeChatMeta(ref, "scriptstate", { $x: "1" });
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $x: "1" });
        commit();
        expect(scriptstate(server)).toEqual({ $x: "1" });
        // Set to a non-map, then entries: two ops (a fold would spread "cd" into the entries).
        chat.setChatMeta(ref, { scriptstate: "cd" });
        chat.mergeChatMeta(ref, "scriptstate", { $y: "2" });
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $y: "2" });
        expect(commit().work.groups[0].ops).toEqual([
            { op: "meta", set: { scriptstate: "cd" }, unset: [] },
            { op: "meta", merge: { scriptstate: { $y: "2" } } },
        ]);
        expect(scriptstate(server)).toEqual({ $y: "2" });
        // Set to a map, then entries: one op, the entries in the set value.
        chat.setChatMeta(ref, { scriptstate: { $e: "5" } });
        chat.mergeChatMeta(ref, "scriptstate", { $f: "6" });
        expect(commit().work.groups[0].ops).toEqual([
            { op: "meta", set: { scriptstate: { $e: "5", $f: "6" } }, unset: [] },
        ]);
        expect(scriptstate(server)).toEqual({ $e: "5", $f: "6" });
    });

    it("mergeChatMeta keeps an entry named __proto__ as an own entry of the mirror, as the server stores it", async () => {
        const { server, chat, ref, commit } = await boot();
        chat.mergeChatMeta(ref, "scriptstate", JSON.parse('{"__proto__": "p", "$old": "old"}'));
        commit();
        expect(Object.hasOwn(scriptstate(server) as object, "__proto__")).toBe(true);
        chat.mergeChatMeta(ref, "scriptstate", { $new: "new" }, ["$old"]);
        const held = (chat.findChat(ref) as any).scriptstate as Record<string, unknown>;
        expect(Object.hasOwn(held, "__proto__")).toBe(true);
        expect(JSON.stringify(held)).toBe(JSON.stringify(JSON.parse('{"__proto__": "p", "$new": "new"}')));
        commit();
        expect(JSON.stringify(scriptstate(server))).toBe(JSON.stringify(held));
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
        const { server, chat, take, applyForgotten, recover, commit } = await boot();
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
        // Landed, but not remembered by its id (slice 6b): the retry below meets the ordinary checks.
        applyForgotten(sent);
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

describe("stream updates per frame", () => {
    // The frames the chat module asked for, run by hand (the timers are fake: the fallback waits).
    let frames: FrameRequestCallback[] = [];

    beforeEach(() => {
        frames = [];
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const update = (seq: number, text: string, generationId = "g") => ({
        jobId: "J",
        messageId: "a",
        generationId,
        text,
        seq,
    });

    it("writes a generation's first update at once, holds the later ones, and writes the newest at the next frame", async () => {
        const { chat, ref } = await boot();
        const text = () => chat.findChat(ref)!.message[0].data;
        expect(chat.applyServerGeneration(ref, update(0, "one"))).toBe(true);
        expect(text()).toBe("one");
        expect(chat.applyServerGeneration(ref, update(1, "one two"))).toBe(true);
        expect(chat.applyServerGeneration(ref, update(2, "one two three"))).toBe(true);
        expect(text()).toBe("one");
        expect(frames).toHaveLength(1);

        frames[0](0);
        expect(text()).toBe("one two three");
        // A frame that wrote asks for the next one; a frame with nothing held ends the window.
        expect(frames).toHaveLength(2);
        frames[1](0);
        expect(frames).toHaveLength(2);

        // With no frame pending, an update is written at once again.
        chat.applyServerGeneration(ref, update(3, "one two three four"));
        expect(text()).toBe("one two three four");
        expect(frames).toHaveLength(3);
    });

    it("writes a new generation's first update at once even inside a frame window", async () => {
        const { chat, ref } = await boot();
        const text = () => chat.findChat(ref)!.message[0].data;
        chat.applyServerGeneration(ref, update(0, "old"));
        chat.applyServerGeneration(ref, update(1, "old more"));
        chat.applyServerGeneration(ref, update(0, "continued", "g2"));
        expect(text()).toBe("continued");
        // The old generation's held update is not written over it.
        frames[0](0);
        expect(text()).toBe("continued");
    });

    it("keeps a held update through another chat's hydration and writes it before its job's end releases the lock", async () => {
        const { chat, ref } = await boot();
        const text = () => chat.findChat(ref)!.message[0].data;
        chat.applyServerGeneration(ref, update(0, "one"));
        chat.applyServerGeneration(ref, update(1, "one two"));
        chat.hydrateChat({
            characterId: "c",
            id: "other",
            revision: "r",
            data: { id: "other", message: [] } as any,
        });
        expect(text()).toBe("one");

        chat.endServerJob("J");
        expect(text()).toBe("one two");
        expect(chat.isMessageLocked(ref, "a")).toBe(false);
        // The frame that was asked for finds nothing held.
        frames[0](0);
        expect(text()).toBe("one two");
        expect(frames).toHaveLength(1);
    });

    it("writes a held update by the timer when no frame runs (a hidden tab)", async () => {
        const { chat, ref } = await boot();
        const text = () => chat.findChat(ref)!.message[0].data;
        chat.applyServerGeneration(ref, update(0, "one"));
        chat.applyServerGeneration(ref, update(1, "one two"));
        vi.advanceTimersByTime(249);
        expect(text()).toBe("one");
        vi.advanceTimersByTime(1);
        expect(text()).toBe("one two");
        // The frame that never ran does nothing when it finally does.
        frames[0](0);
        expect(text()).toBe("one two");
    });
});

describe("a lost delete with the chat created again under its id, and a lost create (data-loss slice 6b)", () => {
    const refJ = { chaId: "c", chatId: "j" };
    const chatJ = { id: "j", name: "J", note: "", localLore: [], message: [m("x", "X")] } as any;
    /** `k` deleted here with its answer lost (`landed`: the server applied it), then created again under its id. */
    async function lostDelete(landed: boolean) {
        const booted = await boot();
        const { server, chat, ref, take, apply, commit } = booted;
        chat.createChat("c", chatJ);
        commit();
        chat.deleteChat(ref);
        const work = take();
        expect(work.groups.map((group) => group.ops)).toEqual([[{ op: "delete" }]]);
        if (landed) {
            apply(work);
        }
        chat.requeueChatWork(work, { lost: true });
        expect(server.chat("c", "k") === null).toBe(landed);
        const recreated = chat.createChat("c", {
            id: "k",
            name: "K again",
            note: "",
            localLore: [],
            message: [m("n", "N")],
        } as any);
        expect(recreated.id).toBe("k");
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["j", "k"]);
        return { ...booted, sent: work.groups[0] };
    }

    it("keeps the recreation in the list while the server's list still shows the old chat, sends the delete first (its id, retry) and the create after it", async () => {
        const { server, chat, ref, take, apply, ack, sent } = await lostDelete(false);
        chat.acceptRemoteCollection(server.store.readRefs([], { chatCollections: ["c"] }).chatCollections[0] as any);
        // The recreation, at the old chat's server position.
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["k", "j"]);
        expect(texts(chat.findChat(ref))).toEqual(["N"]);
        const resend = take();
        expect(resend.groups.map((group) => [group.ops, group.groupId, group.inDoubt])).toEqual([
            [[{ op: "delete" }], sent.groupId, true],
        ]);
        const answer = apply(resend);
        expect(answer.chats[0].revision).toBeNull();
        ack(resend, answer);
        expect(chat.hasChatWork()).toBe(true);
        const create = take();
        expect(create.groups.map((group) => group.ops[0].op)).toEqual(["create"]);
        ack(create, apply(create));
        expect(server.texts("c", "k")).toEqual(["N"]);
        expect(server.order("c")!.ids).toEqual(["k", "j"]);
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        expect(take().groups).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("recognizes the delete as landed when the server no longer has the chat, and the recreation still follows", async () => {
        const { server, chat, take, recover, commit } = await lostDelete(true);
        chat.acceptRemoteCollection(server.store.readRefs([], { chatCollections: ["c"] }).chatCollections[0] as any);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["j", "k"]);
        const { conflicts, reloaded } = recover(take());
        expect(conflicts).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: null }]);
        expect(reloaded).toBe(false);
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        const create = commit();
        expect(create.work.groups.map((group) => group.ops[0].op)).toEqual(["create"]);
        expect(server.texts("c", "k")).toEqual(["N"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("keeps the unresolved delete when the recreation is deleted again, so the old chat does not survive on the server", async () => {
        const { server, chat, ref, take, apply, ack, sent, open } = await lostDelete(false);
        chat.deleteChat(ref);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["j"]);
        const resend = take();
        expect(resend.groups.map((group) => [group.ops, group.groupId, group.inDoubt])).toEqual([
            [[{ op: "delete" }], sent.groupId, true],
        ]);
        ack(resend, apply(resend));
        expect(server.chat("c", "k")).toBeNull();
        // The newer delete has nothing left to delete: settled without a request.
        expect(take().groups).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        expect(open()).toEqual([]);
    });

    it("reports the recreation discarded when the character is deleted elsewhere", async () => {
        const { chat } = await lostDelete(false);
        expect(chat.forgetCharacter("c", { discard: true })).toBe(true);
        expect(chat.chatDiscardsSince(0)).toEqual(["c/k"]);
    });

    it("counts a lost delete without a recreation as fulfilled by the character's deletion elsewhere", async () => {
        const { chat, ref, take, commit } = await boot();
        chat.createChat("c", chatJ);
        commit();
        chat.deleteChat(ref);
        chat.requeueChatWork(take(), { lost: true });
        expect(chat.forgetCharacter("c", { discard: true })).toBe(false);
        expect(chat.chatDiscardsSince(0)).toEqual([]);
    });

    it("recognizes a lost create by its content when the server does not remember its id, settles it, and keeps the work queued behind it", async () => {
        const { server, chat, take, recover, commit } = await boot();
        chat.createChat("c", chatJ);
        const work = take();
        // Applied by a server that recorded no id (dropped): a create that landed unremembered.
        server.store.applyChanges({
            chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                characterId,
                chatId,
                baseRevision,
                ops,
            })),
        });
        chat.requeueChatWork(work, { lost: true });
        chat.setChatMeta(refJ, { note: "behind the resend" });
        const resend = take();
        expect(resend.groups.map((group) => [group.ops[0].op, group.groupId, group.inDoubt])).toEqual([
            ["create", work.groups[0].groupId, true],
        ]);
        const { conflicts, reloaded } = recover(resend);
        expect(conflicts).toEqual([
            { kind: "chat", characterId: "c", id: "j", revision: server.chat("c", "j")!.revision },
        ]);
        expect(reloaded).toBe(false);
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        const note = commit();
        expect(note.work.groups.map((group) => group.ops)).toEqual([
            [{ op: "meta", set: { note: "behind the resend" }, unset: [] }],
        ]);
        expect(note.result.chats[0].stale).toBeUndefined();
        expect((server.chat("c", "j")!.data as any).note).toBe("behind the resend");
        expect(chat.hasChatWork()).toBe(false);
    });
});
