import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";
import * as chat from "../storage/chatStore.svelte";
import { editChatSync } from "../storage/chatEdits";
import { characterList } from "../storage/characterStore.svelte";
import { initializeRecords, takeRecordFields } from "../storage/records.svelte";
import { selectCharacterAt } from "../storage/selection.svelte";
import type { Message } from "../storage/database.svelte";
import { createRerollHistory } from "./rerollHistory";

// The chat screen's swipe history (`rerollHistory.ts`) over the real chat module and the real server
// store: audit GEN-01 (`docs/plan/audit-findings-perf.md` slice 2a). The history is keyed by chat,
// and a bundle is swapped in only while its anchor message exists and the chat's tail still holds
// exactly the bundle the cursor points at; otherwise the chat's history is dropped and nothing is
// written. Before the fix, one component array held every chat's bundles and Undo Reroll wrote the
// previous bundle over whatever chat was selected, by tail position.

const m = (id: string, data: string, role: "user" | "char" = "char") => ({ role, data, chatId: id }) as Message;
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
    it("undo in chat B after a reroll in chat A leaves B's reply and ids alone (GEN-01)", () => {
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
});
