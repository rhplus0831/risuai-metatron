// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { Chat, Message, MessageTranslation } from "../../../shared/database.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";

// Public store/feed contract: expected rows come from the operations below, not the patch builder.
const stores: ResourceStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const m = (chatId: string, data: string): Message => ({ chatId, data, role: "char" });
const initial = {
    id: "k",
    name: "K",
    note: "keep",
    fmIndex: -1,
    localLore: [],
    message: [m("a", "A"), m("b", "B"), m("c", "C")],
} as Chat;
function setup() {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const feed = createChangeFeed();
    const store = createResourceStore({ file: ":memory:", kinds, feed });
    stores.push(store);
    const events: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
    feed.subscribe((event) => {
        if (event.type === "change") events.push(event);
    });
    store.put(kinds.get("characters")!, "c", { chaId: "c", name: "C" }, null);
    const write = (ops: ChatOp[], baseRevision = store.chatRevision("c", "k")) =>
        store.applyChanges({ chats: [{ characterId: "c", chatId: "k", baseRevision, ops }] });
    write([{ op: "create", chat: initial }]);
    const read = () => {
        const record = store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
        if (!record?.data) throw new Error("The fixture chat must exist");
        return { ...record, data: record.data };
    };
    const notice = () => {
        expect(events.at(-1)?.changes.chats).toHaveLength(1);
        return events.at(-1)!.changes.chats[0];
    };
    return { store, events, write, read, notice };
}

describe("by-id chat feed patches", () => {
    it("omits remembered groups from the feed while returning their earlier result and publishing newly applied groups", () => {
        const b = setup();
        const baseRevision = b.read().revision;
        const group = {
            characterId: "c",
            chatId: "k",
            baseRevision,
            groupId: "g1",
            ops: [{ op: "setText", id: "a", text: "mine" }] satisfies ChatOp[],
        };
        b.events.length = 0;
        const first = b.store.applyChanges({ chats: [group] }).chats[0];
        expect(b.events).toHaveLength(1);
        expect(b.notice()).toMatchObject({ characterId: "c", id: "k", revision: first.revision });
        b.write([{ op: "setText", id: "a", text: "theirs" }]);
        const current = b.read();
        b.events.length = 0;

        for (const retry of [false, true]) {
            const replay = b.store.applyChanges({ chats: [{ ...group, ...(retry ? { retry: true as const } : {}) }] });
            expect(replay.chats).toEqual([first]);
            expect(b.events).toEqual([]);
            expect(b.read()).toEqual(current);
        }

        // A duplicate alongside a different chat's new group still leaves that new ref on the feed.
        const mixed = b.store.applyChanges({
            chats: [
                { ...group, retry: true },
                {
                    characterId: "c",
                    chatId: "j",
                    baseRevision: null,
                    groupId: "g2",
                    ops: [{ op: "create", chat: { ...initial, id: "j" } }],
                },
            ],
        });
        expect(mixed.chats[0]).toEqual(first);
        expect(b.events).toHaveLength(1);
        expect(b.events[0].changes.chats).toEqual([{ characterId: "c", id: "j", revision: mixed.chats[1].revision }]);
        expect(b.read()).toEqual(current);
    });

    it("publishes final stored rows in order, anchors, removals and full metadata from the actual stored base", () => {
        const b = setup();
        const requestedBase = b.read().revision;
        b.write([{ op: "meta", set: { note: "concurrent note" } }]);
        const storedBase = b.read().revision;
        const translation: MessageTranslation = {
            text: "translated",
            sourceHash: translationSourceHash("B!"),
            targetLanguage: "ko",
            translatedAt: 123,
        };
        const result = b.write(
            [
                { op: "setText", id: "c", text: "C!" },
                { op: "append", anchor: { start: true }, messages: [m("first", "FIRST")] },
                { op: "append", anchor: { after: "b" }, messages: [m("x", "X")] },
                { op: "setMessage", message: { ...m("b", "B!"), saying: "speaker" } },
                { op: "setTranslation", id: "b", translation },
                { op: "remove", ids: ["a"] },
                { op: "meta", set: { name: "renamed" } },
            ],
            requestedBase,
        );
        const messages = [
            m("first", "FIRST"),
            { ...m("b", "B!"), saying: "speaker", translation },
            m("x", "X"),
            m("c", "C!"),
        ];
        expect(b.read().data.message).toEqual(messages);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            patch: {
                baseRevision: storedBase,
                count: 4,
                meta: { id: "k", name: "renamed", note: "concurrent note", fmIndex: -1, localLore: [] },
                removed: ["a"],
                messages: messages.map((message, i) => ({ after: i === 0 ? null : messages[i - 1].chatId, message })),
            },
        });
        expect(result.chats[0]).toMatchObject({ stale: true });
        expect(result.chats[0]).not.toHaveProperty("patch");
    });

    it("publishes a begin-only revision as a count patch without fabricating a message change", () => {
        const b = setup();
        const baseRevision = b.read().revision;
        b.write([{ op: "begin", id: "b", generationId: "g" }]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            patch: { baseRevision, count: 3 },
        });
        expect(b.read().data).toEqual(initial);
    });

    it.each(["create", "replace", "delete"] as const)("keeps %s as a plain reference", (op) => {
        const b = setup();
        if (op === "replace") b.write([{ op, chat: { ...initial, name: "replacement" } }]);
        if (op === "delete") b.write([{ op }]);
        expect(b.notice()).toEqual({ characterId: "c", id: "k", revision: b.store.chatRevision("c", "k") });
    });

    it("keeps a remove and reappend of the same id as a plain reference", () => {
        const b = setup();
        b.write([
            { op: "remove", ids: ["b"] },
            { op: "append", anchor: { end: true }, messages: [m("b", "moved")] },
        ]);
        expect(b.read().data.message).toEqual([m("a", "A"), m("c", "C"), m("b", "moved")]);
        expect(b.notice()).toEqual({ characterId: "c", id: "k", revision: b.read().revision });
    });

    it("keeps a no-op replay as a plain reference at the unchanged revision", () => {
        const b = setup();
        const revision = b.read().revision;
        b.events.length = 0;
        b.write([{ op: "append", anchor: { end: true }, messages: [m("c", "C")] }]);
        expect(b.events).toHaveLength(1);
        expect(b.notice()).toEqual({ characterId: "c", id: "k", revision });
    });

    it("allows 64 KiB exactly and falls back above it, measured in UTF-8 bytes", () => {
        const b = setup();
        for (const excess of [0, 1]) {
            const baseRevision = b.read().revision;
            const overhead = Buffer.byteLength(
                JSON.stringify({ baseRevision, count: 3, messages: [{ after: "a", message: m("b", "") }] }),
            );
            const text = "한".repeat(100) + "x".repeat(64 * 1024 - overhead - 300 + excess);
            b.write([{ op: "setText", id: "b", text }]);
            const patch = { baseRevision, count: 3, messages: [{ after: "a", message: m("b", text) }] };
            expect(Buffer.byteLength(JSON.stringify(patch))).toBe(64 * 1024 + excess);
            expect(Object.hasOwn(b.notice(), "patch")).toBe(excess === 0);
            expect(b.notice()).toEqual({
                characterId: "c",
                id: "k",
                revision: b.read().revision,
                ...(excess ? {} : { patch }),
            });
            expect(b.read().data.message[1].data).toBe(text);
        }
    });

    it("publishes one final plain reference when a chat is recorded twice in a publishing scope", () => {
        const b = setup();
        b.events.length = 0;
        // Input evaluation occurs inside the publishing scope, before its transaction.
        // Ordinary batches reject duplicate groups and transactions reject nested batches.
        b.store.applyChanges({
            get chats() {
                b.write([{ op: "setText", id: "a", text: "A2" }]);
                return [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: b.read().revision,
                        ops: [{ op: "setText", id: "b", text: "B2" }],
                    },
                ];
            },
        });
        expect(b.events).toHaveLength(1);
        expect(b.notice()).toEqual({ characterId: "c", id: "k", revision: b.read().revision });
        expect(b.read().data.message).toEqual([m("a", "A2"), m("b", "B2"), m("c", "C")]);
    });
});
