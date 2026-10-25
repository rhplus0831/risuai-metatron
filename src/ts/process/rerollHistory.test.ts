import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";
import * as chat from "../storage/chatStore.svelte";
import { editChatSync } from "../storage/chatEdits";
import { characterList } from "../storage/characterStore.svelte";
import { initializeRecords, takeRecordFields } from "../storage/records.svelte";
import { selectCharacterAt } from "../storage/selection.svelte";
import type { Message } from "../storage/database.svelte";
import { createRerollHistory, restoreRerolledReplies } from "./rerollHistory";
import { addRerolls, PreUnreroll, Prereroll } from "./prereroll";

// The chat screen's swipe history (`rerollHistory.ts`) over the real chat module and the real
// server store. The history is keyed by chat, and a bundle is swapped in only while its anchor
// message exists and the chat's tail still holds exactly the bundle the cursor points at; otherwise
// the chat's history is dropped and nothing is written. Before the fix, one component array held
// every chat's bundles and Undo Reroll wrote the previous bundle over whatever chat was selected,
// by tail position.
//
// The bundle at the cursor and the prereroll candidate on display are refreshed from the chat
// before they are kept or swapped away, so an edit made since they were recorded is what a later
// back or forward brings.

const m = (id: string, data: string, role: "user" | "char" = "char") => ({ role, data, chatId: id }) as Message;
const edit = (ref: chat.ChatRef, id: string, text: string) => chat.setMessageText(ref, id, text);
const texts = (ref: chat.ChatRef) => chat.findChat(ref)!.message.map((message) => message.data);
const ids = (ref: chat.ChatRef) => chat.findChat(ref)!.message.map((message) => message.chatId);
const tail = (ref: chat.ChatRef, after: string) => {
    const messages = chat.findChat(ref)!.message;
    return messages.slice(messages.findIndex((message) => message.chatId === after) + 1);
};

let server: StoreBackedServer;
let chatNumber = 0;

/** One save cycle by hand (take, apply on the server, acknowledge). */
function commit() {
    const work = chat.takeChatWork(new Set());
    const result =
        work.groups.length + work.orders.length === 0
            ? { chats: [], chatOrders: [] }
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
    chat.ackChatWork(work, result.chats as any, result.chatOrders as any);
}

/** A fresh saved chat of character `c` holding `messages`. */
function freshChat(messages: Message[]): chat.ChatRef {
    chatNumber += 1;
    const created = chat.createChat("c", {
        id: `chat${chatNumber}`,
        name: `Chat ${chatNumber}`,
        note: "",
        localLore: [],
        message: messages,
    } as any);
    commit();
    return { chaId: "c", chatId: created.id! };
}

/** The screen's reroll: the replies after `anchor` go, the new reply comes, and both are recorded. */
function rerollTo(
    history: ReturnType<typeof createRerollHistory>,
    ref: chat.ChatRef,
    anchor: string,
    reply: Message[],
) {
    history.begin(ref, anchor, tail(ref, anchor));
    editChatSync(ref, (c) => {
        c.message = c.message.slice(0, c.message.findIndex((message) => message.chatId === anchor) + 1);
    });
    editChatSync(ref, (c) => {
        c.message = [...c.message, ...reply];
    });
    history.record(ref, anchor, tail(ref, anchor));
}

beforeAll(async () => {
    server = await StoreBackedServer.create();
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C", type: "character" } }],
        chats: [
            {
                characterId: "c",
                chatId: "first",
                baseRevision: null,
                ops: [
                    { op: "create", chat: { id: "first", name: "First", note: "", localLore: [], message: [] } as any },
                ],
            },
        ],
    });
    const read = server.store.readKinds([characters], { chats: true });
    const raw = { characters: read.kinds.characters.map((record) => record.data) } as any;
    initializeRecords(takeRecordFields(raw));
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(characterList(), read.chats!, read.chatOrders!);
    chat.initializeChats();
    selectCharacterAt(0);
});

afterAll(() => {
    server.close();
});

describe("createRerollHistory", () => {
    it("undo in chat B after a reroll in chat A leaves B's reply and ids alone", () => {
        const history = createRerollHistory();
        const b = freshChat([m("ub", "Hello B", "user"), m("rb1", "AUDIT_REPLY_1")]);
        const a = freshChat([m("ua", "Hello A", "user"), m("ra1", "AUDIT_REPLY_2")]);
        // The sends that produced each chat's first reply.
        history.record(b, "ub", tail(b, "ub"));
        history.record(a, "ua", tail(a, "ua"));
        // Reroll A once.
        rerollTo(history, a, "ua", [m("ra2", "AUDIT_REPLY_3")]);
        expect(texts(a)).toEqual(["Hello A", "AUDIT_REPLY_3"]);

        // Undo Reroll in B: B has no earlier swipe, so nothing happens.
        expect(history.back(b)).toBe(false);
        expect(texts(b)).toEqual(["Hello B", "AUDIT_REPLY_1"]);
        expect(ids(b)).toEqual(["ub", "rb1"]);
        commit();
        expect(server.texts("c", b.chatId)).toEqual(["Hello B", "AUDIT_REPLY_1"]);

        // A's own history is intact: undo there restores its earlier reply.
        expect(history.back(a)).toBe(true);
        expect(texts(a)).toEqual(["Hello A", "AUDIT_REPLY_2"]);
        expect(ids(a)).toEqual(["ua", "ra1"]);
        commit();
        expect(server.texts("c", a.chatId)).toEqual(["Hello A", "AUDIT_REPLY_2"]);
    });

    it("same chat: back and forward swap the stored bundles and persist (the control)", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("r2", "second")]);
        rerollTo(history, ref, "u", [m("r3", "third")]);
        expect(history.canForward(ref)).toBe(false);

        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "second"]);
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "first"]);
        expect(history.back(ref)).toBe(false);
        expect(history.canForward(ref)).toBe(true);
        expect(history.forward(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "second"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "second"]);
        expect(ids(ref)).toEqual(["u", "r2"]);
    });

    it("a bundle recorded under another anchor starts a new slot (auto mode sends in a row)", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        // Auto mode: the next send's bundle follows the previous reply, not the user message.
        editChatSync(ref, (c) => {
            c.message = [...c.message, m("r2", "second")];
        });
        history.record(ref, "r1", tail(ref, "r1"));
        // Undo: the new slot has one bundle, so nothing is swapped; the earlier slot is gone too.
        expect(history.back(ref)).toBe(false);
        expect(texts(ref)).toEqual(["Hi", "first", "second"]);
        expect(history.canForward(ref)).toBe(false);
    });

    it("a tail that changed since the bundle was recorded (a /send in between) drops the chat's history", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("r2", "second")]);
        // A `/send` appended a user message and a reply after the bundle.
        editChatSync(ref, (c) => {
            c.message = [...c.message, m("u2", "More", "user"), m("r3", "third")];
        });
        expect(history.back(ref)).toBe(false);
        expect(texts(ref)).toEqual(["Hi", "second", "More", "third"]);
        // Dropped: even after the extra messages are removed, there is nothing to go back to.
        editChatSync(ref, (c) => {
            c.message = c.message.slice(0, 2);
        });
        expect(history.back(ref)).toBe(false);
        expect(texts(ref)).toEqual(["Hi", "second"]);
    });

    it("a deleted anchor drops the chat's history and writes nothing", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("r2", "second")]);
        editChatSync(ref, (c) => {
            c.message = c.message.filter((message) => message.chatId !== "u");
        });
        expect(history.back(ref)).toBe(false);
        expect(texts(ref)).toEqual(["second"]);
    });

    it("group bundles of different lengths are swapped whole", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("g1", "Alice says"), m("g2", "Bob says")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("g3", "Only Carol")]);
        expect(texts(ref)).toEqual(["Hi", "Only Carol"]);
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "Alice says", "Bob says"]);
        expect(ids(ref)).toEqual(["u", "g1", "g2"]);
        expect(history.forward(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "Only Carol"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "Only Carol"]);
    });

    it("a bundle at the start of the chat has no anchor", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("r1", "greeting one")]);
        history.begin(ref, null, chat.findChat(ref)!.message);
        editChatSync(ref, (c) => {
            c.message = [m("r2", "greeting two")];
        });
        history.record(ref, null, chat.findChat(ref)!.message);
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["greeting one"]);
        expect(history.forward(ref)).toBe(true);
        expect(texts(ref)).toEqual(["greeting two"]);
    });

    it("begin keeps the slot when the removed replies are the bundle at the cursor, else starts over", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("r2", "second")]);
        history.back(ref);
        expect(texts(ref)).toEqual(["Hi", "first"]);
        // A reroll from the first bundle keeps the slot: forward still reaches the second.
        history.begin(ref, "u", tail(ref, "u"));
        expect(history.canForward(ref)).toBe(true);
        // The user edited the reply's id set (a message removed): a reroll starts a new slot.
        editChatSync(ref, (c) => {
            c.message = [...c.message, m("r1b", "first, continued")];
        });
        history.begin(ref, "u", tail(ref, "u"));
        expect(history.canForward(ref)).toBe(false);
        expect(history.back(ref)).toBe(false);
    });

    it("keeps the 16 most recently used chats", () => {
        const history = createRerollHistory();
        const refs = Array.from({ length: 17 }, () => freshChat([m("u", "Hi", "user"), m("r1", "first")]));
        for (const ref of refs.slice(0, 16)) {
            history.record(ref, "u", tail(ref, "u"));
            rerollTo(history, ref, "u", [m("r2", "second")]);
        }
        // Touch the first chat so the second one is the least recently used.
        history.canForward(refs[0]);
        history.record(refs[16], "u", tail(refs[16], "u"));
        expect(history.back(refs[1])).toBe(false);
        expect(texts(refs[1])).toEqual(["Hi", "second"]);
        expect(history.back(refs[0])).toBe(true);
        expect(texts(refs[0])).toEqual(["Hi", "first"]);
    });

    it("clear forgets the chat", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("r2", "second")]);
        history.clear(ref);
        expect(history.back(ref)).toBe(false);
        expect(texts(ref)).toEqual(["Hi", "second"]);
    });

    it("an edit of a reply before a reroll comes back with it", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        edit(ref, "r1", "first, edited");
        commit();
        rerollTo(history, ref, "u", [m("r2", "second")]);
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "first, edited"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "first, edited"]);
    });

    it("an edit of the reply on display survives back and forward", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("r2", "second")]);
        edit(ref, "r2", "second, edited");
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "first"]);
        expect(history.forward(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "second, edited"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "second, edited"]);
    });

    it("a reroll from an earlier bundle keeps its edit: begin refreshes the kept slot", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "first")]);
        history.record(ref, "u", tail(ref, "u"));
        rerollTo(history, ref, "u", [m("r2", "second")]);
        expect(history.back(ref)).toBe(true);
        edit(ref, "r1", "first, edited");
        rerollTo(history, ref, "u", [m("r3", "third")]);
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "second"]);
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "first, edited"]);
    });

    it("a group bundle with one edited member round-trips whole", () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("g1", "Alice says"), m("g2", "Bob says")]);
        history.record(ref, "u", tail(ref, "u"));
        edit(ref, "g2", "Bob says, edited");
        rerollTo(history, ref, "u", [m("g3", "Carol says"), m("g4", "Dave says")]);
        edit(ref, "g3", "Carol says, edited");
        expect(history.back(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "Alice says", "Bob says, edited"]);
        expect(ids(ref)).toEqual(["u", "g1", "g2"]);
        expect(history.forward(ref)).toBe(true);
        expect(texts(ref)).toEqual(["Hi", "Carol says, edited", "Dave says"]);
        expect(history.back(ref)).toBe(true);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "Alice says", "Bob says, edited"]);
    });
});

describe("restoreRerolledReplies", () => {
    const settled = { ran: true, settled: true, blockedChats: [] };
    /** The screen's reroll up to its send: the replies after `anchor` go (queued, not yet saved). */
    function removeTail(ref: chat.ChatRef, anchor: string) {
        const removed = tail(ref, anchor);
        editChatSync(ref, (c) => {
            c.message = c.message.slice(0, c.message.findIndex((message) => message.chatId === anchor) + 1);
        });
        return removed;
    }

    it("a job that ended without a reply gets the removed replies back, saved after the anchor", async () => {
        const ref = freshChat([m("u1", "Hi", "user"), m("r1", "First"), m("u2", "Again", "user"), m("r2", "Second")]);
        const owner = chat.chatOwnerToken("c");
        const removed = removeTail(ref, "u2");
        // The job's flush saved the removal before the job failed.
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "First", "Again"]);

        expect(await restoreRerolledReplies(ref, owner, "u2", removed, settled)).toBe("restored");
        expect(ids(ref)).toEqual(["u1", "r1", "u2", "r2"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "First", "Again", "Second"]);
    });

    it("a group's replies come back whole and in order", async () => {
        const ref = freshChat([m("u", "Hi", "user"), m("a", "Alice says"), m("b", "Bob says")]);
        const removed = removeTail(ref, "u");
        commit();
        expect(await restoreRerolledReplies(ref, chat.chatOwnerToken("c"), "u", removed, settled)).toBe("restored");
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "Alice says", "Bob says"]);
    });

    it("a refusal after the removal was saved (a second flush waited on another chat) writes them back", async () => {
        const ref = freshChat([m("u", "Hi", "user"), m("r", "Reply")]);
        const removed = removeTail(ref, "u");
        commit();
        const end = { ran: false, settled: true, blockedChats: [{ chaId: "c", chatId: "first" }] };
        expect(await restoreRerolledReplies(ref, chat.chatOwnerToken("c"), "u", removed, end)).toBe("restored");
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "Reply"]);
    });

    it("a refusal before the removal was saved withdraws it", async () => {
        const ref = freshChat([m("u", "Hi", "user"), m("r", "Reply")]);
        const removed = removeTail(ref, "u");
        const end = { ran: false, settled: true, blockedChats: [{ chaId: ref.chaId, chatId: ref.chatId }] };
        expect(await restoreRerolledReplies(ref, chat.chatOwnerToken("c"), "u", removed, end)).toBe("restored");
        expect(ids(ref)).toEqual(["u", "r"]);
        // Nothing is queued: the removal never reaches the server.
        const work = chat.takeChatWork(new Set());
        expect(work.groups).toEqual([]);
        chat.ackChatWork(work, [], []);
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "Reply"]);
    });

    it("writes nothing while the send may still write, or for a character that was replaced", async () => {
        const ref = freshChat([m("u", "Hi", "user"), m("r", "Reply")]);
        const removed = removeTail(ref, "u");
        commit();
        const owner = chat.chatOwnerToken("c");
        // A create without an answer, or a lost follow: the job may still bring its reply.
        expect(await restoreRerolledReplies(ref, owner, "u", removed, { ...settled, settled: false })).toBe("none");
        expect(
            await restoreRerolledReplies(ref, owner, "u", removed, { ran: false, settled: false, blockedChats: [] }),
        ).toBe("none");
        expect(await restoreRerolledReplies(ref, `${owner}-old`, "u", removed, settled)).toBe("none");
        expect(ids(ref)).toEqual(["u"]);
    });

    it("leaves a chat that no longer ends at the anchor as it is (a reply came, or the anchor is gone)", async () => {
        const ref = freshChat([m("u", "Hi", "user"), m("r1", "Old")]);
        const removed = removeTail(ref, "u");
        editChatSync(ref, (c) => {
            c.message = [...c.message, m("r2", "New")];
        });
        commit();
        expect(await restoreRerolledReplies(ref, chat.chatOwnerToken("c"), "u", removed, settled)).toBe("none");
        expect(ids(ref)).toEqual(["u", "r2"]);

        const gone = freshChat([m("u", "Hi", "user"), m("r", "Reply")]);
        const lost = removeTail(gone, "u");
        editChatSync(gone, (c) => {
            c.message = [];
        });
        commit();
        expect(await restoreRerolledReplies(gone, chat.chatOwnerToken("c"), "u", lost, settled)).toBe("none");
        expect(ids(gone)).toEqual([]);
    });

    it("reports unsafe and writes nothing while another generation writes into the chat", async () => {
        const ref = freshChat([m("u1", "Hi", "user"), m("r1", "First"), m("u2", "Again", "user"), m("r2", "Second")]);
        const owner = chat.chatOwnerToken("c");
        const removed = removeTail(ref, "u2");
        commit();
        // The server refused this chat's save, or the job's create, for another tab's generation.
        const blocked = { ran: false, settled: true, blockedChats: [{ chaId: ref.chaId, chatId: ref.chatId }] };
        expect(await restoreRerolledReplies(ref, owner, "u2", removed, blocked)).toBe("unsafe");
        // A lock in the chat (here a continue of an earlier reply).
        chat.applyServerGeneration(ref, {
            jobId: "other",
            messageId: "r1",
            generationId: "g-other",
            text: "First",
            seq: 1,
        });
        expect(await restoreRerolledReplies(ref, owner, "u2", removed, settled)).toBe("unsafe");
        chat.endServerJob("other");
        expect(ids(ref)).toEqual(["u1", "r1", "u2"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "First", "Again"]);
    });
    it("reads a chat whose job end did not apply before deciding: the reply that came is kept alone and Undo reaches the old one", async () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u", "Hi", "user"), m("old", "Old")]);
        const owner = chat.chatOwnerToken("c");
        history.begin(ref, "u", tail(ref, "u"));
        const removed = removeTail(ref, "u");
        commit();
        // The job's reply is stored, but a local edit kept its chat copy from applying.
        server.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: ref.chatId,
                    baseRevision: server.chat("c", ref.chatId)!.revision,
                    ops: [{ op: "append", messages: [m("new", "New")], anchor: { after: "u" } } as any],
                },
            ],
        });
        chat.setMessageText(ref, "u", "Hi, edited");
        const stored = () => {
            const record = server.chat("c", ref.chatId)!;
            return { characterId: "c", id: ref.chatId, revision: record.revision, data: record.data as any };
        };
        expect(chat.hydrateChat(stored())).toBe(false);
        expect(chat.isChatBehind(ref)).toBe(true);
        expect(ids(ref)).toEqual(["u"]);

        const sync = vi.fn(async () => {
            commit();
            chat.hydrateChat(stored());
            return !chat.isChatBehind(ref);
        });
        expect(await history.restore(ref, owner, "u", removed, settled, sync)).toBe("none");
        expect(sync).toHaveBeenCalledOnce();
        expect(ids(ref)).toEqual(["u", "new"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi, edited", "New"]);
        // The reply the read brought is in the history, so Undo Reroll brings the removed one back.
        expect(history.back(ref)).toBe(true);
        expect(ids(ref)).toEqual(["u", "old"]);
        expect(history.forward(ref)).toBe(true);
        expect(ids(ref)).toEqual(["u", "new"]);
    });

    it("does not record a later turn the read brings (another tab sent meanwhile) as the reroll's reply", async () => {
        const history = createRerollHistory();
        const ref = freshChat([m("u1", "Hi", "user"), m("old", "Old")]);
        const owner = chat.chatOwnerToken("c");
        history.begin(ref, "u1", tail(ref, "u1"));
        const removed = removeTail(ref, "u1");
        commit();
        server.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: ref.chatId,
                    baseRevision: server.chat("c", ref.chatId)!.revision,
                    ops: [
                        {
                            op: "append",
                            messages: [m("u2", "Next", "user"), m("r2", "Answer")],
                            anchor: { after: "u1" },
                        } as any,
                    ],
                },
            ],
        });
        chat.setMessageText(ref, "u1", "Hi, edited");
        const record = server.chat("c", ref.chatId)!;
        chat.hydrateChat({ characterId: "c", id: ref.chatId, revision: record.revision, data: record.data as any });
        const sync = async () => {
            commit();
            const stored = server.chat("c", ref.chatId)!;
            chat.hydrateChat({ characterId: "c", id: ref.chatId, revision: stored.revision, data: stored.data as any });
            return !chat.isChatBehind(ref);
        };
        expect(await history.restore(ref, owner, "u1", removed, settled, sync)).toBe("none");
        expect(ids(ref)).toEqual(["u1", "u2", "r2"]);
        // Undo Reroll leaves the other tab's turn alone.
        expect(history.back(ref)).toBe(false);
        expect(ids(ref)).toEqual(["u1", "u2", "r2"]);
    });

    it("keeps the chat loaded while it is saved and read, then writes the replies back", async () => {
        const ref = freshChat([m("u", "Hi", "user"), m("old", "Old")]);
        const owner = chat.chatOwnerToken("c");
        const removed = removeTail(ref, "u");
        commit();
        // A local edit still queued: the chat is saved before the decision.
        chat.setMessageText(ref, "u", "Hi, edited");
        const sync = vi.fn(async () => {
            commit();
            // Newer chats load meanwhile and idle chats are trimmed.
            for (let index = 0; index <= chat.MAX_LOADED_CHATS; index++) {
                freshChat([m("x", "Other", "user")]);
            }
            chat.trimLoadedChats();
            return true;
        });
        expect(await restoreRerolledReplies(ref, owner, "u", removed, settled, { syncChat: sync })).toBe("restored");
        expect(ids(ref)).toEqual(["u", "old"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi, edited", "Old"]);
    });

    it("reports unsafe and writes nothing when the chat stays behind or its work unsaved", async () => {
        const ref = freshChat([m("u", "Hi", "user"), m("old", "Old")]);
        const owner = chat.chatOwnerToken("c");
        const removed = removeTail(ref, "u");
        commit();
        // A local edit still queued: the job's end may not have applied.
        chat.setMessageText(ref, "u", "Hi, edited");
        const failed = vi.fn(async () => {
            throw new Error("offline");
        });
        expect(await restoreRerolledReplies(ref, owner, "u", removed, settled, { syncChat: failed })).toBe("unsafe");
        expect(failed).toHaveBeenCalledOnce();
        expect(ids(ref)).toEqual(["u"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi, edited"]);
    });
});

describe("prereroll candidates", () => {
    const reply = (id: string, data: string, generationId: string) =>
        ({ ...m(id, data), generationInfo: { generationId } }) as Message;
    /** The screen's swipe over the candidates: a candidate is applied with `setMessageText`. */
    const swipe = (ref: chat.ChatRef, id: string, step: typeof Prereroll, genId: string) => {
        const text = step(genId);
        if (text !== null) {
            edit(ref, id, text);
        }
        return text;
    };

    it("an edit of a candidate is what swiping back to it brings", () => {
        const ref = freshChat([m("u", "Hi", "user"), reply("r1", "A", "gen-edit")]);
        chat.selectChat("c", ref.chatId);
        addRerolls("gen-edit", ["A", "B", "C"], ref, "r1");
        edit(ref, "r1", "A, edited");
        expect(swipe(ref, "r1", Prereroll, "gen-edit")).toBe("B");
        edit(ref, "r1", "B, edited");
        expect(swipe(ref, "r1", Prereroll, "gen-edit")).toBe("C");
        expect(swipe(ref, "r1", Prereroll, "gen-edit")).toBeNull();
        expect(swipe(ref, "r1", PreUnreroll, "gen-edit")).toBe("B, edited");
        expect(swipe(ref, "r1", PreUnreroll, "gen-edit")).toBe("A, edited");
        expect(swipe(ref, "r1", PreUnreroll, "gen-edit")).toBeNull();
        expect(swipe(ref, "r1", Prereroll, "gen-edit")).toBe("B, edited");
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "B, edited"]);
    });

    it("an emptied candidate is shown again by swiping back to it", () => {
        const ref = freshChat([m("u", "Hi", "user"), reply("r1", "A", "gen-empty")]);
        chat.selectChat("c", ref.chatId);
        addRerolls("gen-empty", ["A", "B", "C"], ref, "r1");
        expect(swipe(ref, "r1", Prereroll, "gen-empty")).toBe("B");
        edit(ref, "r1", "");
        expect(swipe(ref, "r1", Prereroll, "gen-empty")).toBe("C");
        expect(swipe(ref, "r1", PreUnreroll, "gen-empty")).toBe("");
        expect(texts(ref)).toEqual(["Hi", ""]);
        expect(swipe(ref, "r1", PreUnreroll, "gen-empty")).toBe("A");
        expect(swipe(ref, "r1", Prereroll, "gen-empty")).toBe("");
        expect(swipe(ref, "r1", Prereroll, "gen-empty")).toBe("C");
    });

    it("an empty alternative is shown and saved, and the ends stay where they are", () => {
        const ref = freshChat([m("u", "Hi", "user"), reply("r1", "A", "gen-blank")]);
        chat.selectChat("c", ref.chatId);
        addRerolls("gen-blank", ["A", "", ""], ref, "r1");
        expect(swipe(ref, "r1", PreUnreroll, "gen-blank")).toBeNull();
        expect(swipe(ref, "r1", Prereroll, "gen-blank")).toBe("");
        expect(swipe(ref, "r1", Prereroll, "gen-blank")).toBe("");
        expect(swipe(ref, "r1", Prereroll, "gen-blank")).toBeNull();
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", ""]);
        expect(swipe(ref, "r1", PreUnreroll, "gen-blank")).toBe("");
        expect(swipe(ref, "r1", PreUnreroll, "gen-blank")).toBe("A");
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["Hi", "A"]);
    });

    it("a copy of the chat holding the same reply does not use or change the candidates", () => {
        const ref = freshChat([m("u", "Hi", "user"), reply("r1", "A", "gen-copy")]);
        const copy = freshChat([m("u", "Hi", "user"), reply("r1", "A, in the copy", "gen-copy")]);
        addRerolls("gen-copy", ["A", "B"], ref, "r1");
        chat.selectChat("c", copy.chatId);
        expect(swipe(copy, "r1", Prereroll, "gen-copy")).toBeNull();
        expect(texts(copy)).toEqual(["Hi", "A, in the copy"]);
        chat.selectChat("c", ref.chatId);
        expect(swipe(ref, "r1", Prereroll, "gen-copy")).toBe("B");
        expect(swipe(ref, "r1", PreUnreroll, "gen-copy")).toBe("A");
    });
});
