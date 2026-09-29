// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CHAT_META_FORBIDDEN_KEYS } from "../../../shared/chats.ts";
import { assertPatchableMetaKeys, normalizeChatMeta, normalizeMessage, normalizeMessageList } from "../data/chats.ts";
import {
    countChatOperations,
    type PreparedChatGroup,
    prepareChatGroups,
    prepareChatOrders,
} from "../data/chatStore.ts";
import { ResourceValidationError } from "../data/resourceStore.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const message = (id: string, data = "", role = "user") => ({ role, data, chatId: id });
const rejects = (fn: () => unknown, error: string, label = error) => {
    expect(fn, label).toThrow(new ResourceValidationError(error));
};

describe("normalizeChatMeta", () => {
    it("keeps every field except the messages and the streaming flags, sets the id, and defaults name, note, and localLore", () => {
        const input = {
            id: "k",
            name: "Chat",
            message: [message("m", "hello")],
            isStreaming: true,
            activeStreamingDisplayOptimizationMode: "balanced",
            fmIndex: -1,
            scriptstate: { $a: 1 },
            hypaV3Data: { summaries: [] },
            folderId: null,
        };
        const meta = normalizeChatMeta(input, "k");
        expect(meta).toEqual({
            id: "k",
            name: "Chat",
            note: "",
            localLore: [],
            fmIndex: -1,
            scriptstate: { $a: 1 },
            hypaV3Data: { summaries: [] },
            folderId: null,
        });
        // The input is not changed and the result is a copy.
        expect(input.message).toHaveLength(1);
        expect(meta).not.toBe(input);
        // Without an id the chat id is stamped on.
        expect(normalizeChatMeta({}, "k")).toEqual({ id: "k", name: "", note: "", localLore: [] });
        expect(normalizeChatMeta({ note: "n", localLore: [{ key: "x" }] }, "k")).toMatchObject({
            note: "n",
            localLore: [{ key: "x" }],
        });
    });

    it("refuses non-objects, an id that is not the chat id, and wrongly typed defaults", () => {
        for (const input of [null, 1, "x", [], undefined]) {
            rejects(() => normalizeChatMeta(input, "k"), "chat must be an object", JSON.stringify(input));
        }
        rejects(() => normalizeChatMeta({ id: "other" }, "k"), "chat.id must equal the chat id");
        rejects(() => normalizeChatMeta({ id: undefined }, "k"), "chat.id must equal the chat id");
        rejects(() => normalizeChatMeta({ name: 1 }, "k"), "chat.name and chat.note must be strings");
        rejects(() => normalizeChatMeta({ note: 5 }, "k"), "chat.name and chat.note must be strings");
        // A null default is treated as absent.
        expect(normalizeChatMeta({ name: null, note: null, localLore: null }, "k")).toEqual({
            id: "k",
            name: "",
            note: "",
            localLore: [],
        });
        rejects(() => normalizeChatMeta({ localLore: {} }, "k"), "chat.localLore must be an array");
        rejects(() => normalizeChatMeta({ fmIndex: "0" }, "k"), "chat.fmIndex must be a number");
        // `fmIndex` stays optional: its default depends on the character, which the creator has.
        expect(normalizeChatMeta({ fmIndex: undefined }, "k").fmIndex).toBeUndefined();
    });
});

describe("assertPatchableMetaKeys", () => {
    it("refuses the identity, the messages, and the streaming flags, and accepts everything else", () => {
        expect(CHAT_META_FORBIDDEN_KEYS).toEqual([
            "id",
            "message",
            "isStreaming",
            "activeStreamingDisplayOptimizationMode",
        ]);
        for (const key of CHAT_META_FORBIDDEN_KEYS) {
            rejects(() => assertPatchableMetaKeys(["name", key]), `chat meta cannot change ${key}`);
        }
        expect(() => assertPatchableMetaKeys(["name", "note", "scriptstate", "localLore", "fmIndex"])).not.toThrow();
        expect(() => assertPatchableMetaKeys([])).not.toThrow();
    });
});

describe("normalizeMessage", () => {
    it("requires a user or char role, string data, and a valid chatId, and returns the input", () => {
        const input = message("m", "hi", "char");
        expect(normalizeMessage(input)).toBe(input);
        expect(normalizeMessage({ ...input, time: 1, saying: "s", extra: { any: true } })).toMatchObject({ time: 1 });
        for (const input of [null, 1, "x", [], undefined]) {
            rejects(() => normalizeMessage(input), "message must be an object", JSON.stringify(input));
        }
        for (const role of [undefined, "assistant", "system", 1]) {
            rejects(
                () => normalizeMessage({ ...message("m"), role }),
                "message.role must be user or char",
                String(role),
            );
        }
        for (const data of [undefined, null, 1, ["x"]]) {
            rejects(() => normalizeMessage({ ...message("m"), data }), "message.data must be a string", String(data));
        }
        for (const chatId of [undefined, "", ".", "a\u0000", 1, "x".repeat(513)]) {
            rejects(
                () => normalizeMessage({ ...message("m"), chatId }),
                "message.chatId must be a valid id",
                JSON.stringify(chatId),
            );
        }
    });
});

describe("normalizeMessageList", () => {
    it("gives a missing, invalid, or repeated id a fresh UUID, keeps the first of duplicates, and copies", () => {
        const input = [
            message("a", "first"),
            { role: "char", data: "no id" },
            message("a", "dup"),
            { ...message("b"), chatId: "" },
            message("c"),
        ];
        const before = JSON.stringify(input);
        const list = normalizeMessageList(input);
        expect(list.map((m) => m.data)).toEqual(["first", "no id", "dup", "", ""]);
        expect(list[0].chatId).toBe("a");
        expect(list[1].chatId).toMatch(uuid);
        expect(list[2].chatId).toMatch(uuid);
        expect(list[3].chatId).toMatch(uuid);
        expect(list[4].chatId).toBe("c");
        expect(new Set(list.map((m) => m.chatId)).size).toBe(5);
        expect(JSON.stringify(input)).toBe(before);
        expect(list[0]).not.toBe(input[0]);
        expect(normalizeMessageList(undefined)).toEqual([]);
        expect(normalizeMessageList([])).toEqual([]);
    });

    it("refuses a non-array and any entry the message normalizer refuses", () => {
        for (const input of [null, {}, "x", 1]) {
            rejects(() => normalizeMessageList(input), "chat.message must be an array", JSON.stringify(input));
        }
        rejects(() => normalizeMessageList([message("a"), null]), "message must be an object");
        rejects(
            () => normalizeMessageList([message("a"), { ...message("b"), role: "x" }]),
            "message.role must be user or char",
        );
        rejects(() => normalizeMessageList([{ ...message("b"), data: 1 }]), "message.data must be a string");
    });
});

describe("prepareChatGroups", () => {
    const group = (ops: unknown[], extra: Record<string, unknown> = {}) => ({
        characterId: "c",
        chatId: "k",
        baseRevision: "e:1:1",
        ops,
        ...extra,
    });
    const groupRejects = (raw: unknown, error: string) => rejects(() => prepareChatGroups(raw), error);

    it("normalizes every op before any transaction and records whether the group needs the current revision", () => {
        expect(prepareChatGroups(undefined)).toEqual([]);
        expect(prepareChatGroups([])).toEqual([]);
        const [created, edited, destructive] = prepareChatGroups([
            group(
                [
                    {
                        op: "create",
                        chat: {
                            name: "n",
                            message: [message("a", "x"), { role: "char", data: "no id" }],
                            isStreaming: true,
                        },
                        index: 0,
                    },
                    { op: "meta", set: { note: "n" } },
                    { op: "begin", id: "a", generationId: "g" },
                ],
                { baseRevision: null },
            ),
            group(
                [
                    { op: "meta", unset: ["note"] },
                    { op: "append", messages: [message("b")], anchor: { end: true } },
                    { op: "append", messages: [message("c")], anchor: { start: true } },
                    { op: "append", messages: [message("d")], anchor: { after: "a" } },
                    { op: "setMessage", message: message("a", "edited") },
                    { op: "setText", id: "a", text: "t", generation: { id: "g", seq: 2 } },
                    { op: "setText", id: "a", text: "t", generation: { id: "g", seq: 3, final: true } },
                    { op: "remove", ids: ["a"] },
                ],
                { chatId: "k2" },
            ),
            group([{ op: "remove", ids: ["a", "b"] }], { chatId: "k3" }),
        ]);
        expect(created).toMatchObject({
            characterId: "c",
            chatId: "k",
            baseRevision: null,
            needsCurrent: false,
        } satisfies Partial<PreparedChatGroup>);
        expect(created.ops[0]).toMatchObject({ op: "create", index: 0 });
        const create = created.ops[0] as Extract<PreparedChatGroup["ops"][number], { op: "create" }>;
        expect(JSON.parse(create.meta)).toEqual({ name: "n", id: "k", note: "", localLore: [] });
        expect(create.messages[0]).toEqual({ id: "a", text: JSON.stringify(message("a", "x")) });
        expect(create.messages[1].id).toMatch(uuid);
        expect(created.ops[1]).toEqual({ op: "meta", set: { note: "n" }, unset: [] });
        expect(created.ops[2]).toEqual({ op: "begin", id: "a", generationId: "g" });

        expect(edited.needsCurrent).toBe(false);
        expect(edited.ops.map((op) => op.op)).toEqual([
            "meta",
            "append",
            "append",
            "append",
            "setMessage",
            "setText",
            "setText",
            "remove",
        ]);
        expect(edited.ops[0]).toEqual({ op: "meta", set: {}, unset: ["note"] });
        expect(edited.ops[1]).toMatchObject({ anchor: { end: true } });
        expect(edited.ops[2]).toMatchObject({ anchor: { start: true } });
        expect(edited.ops[3]).toMatchObject({ anchor: { after: "a" } });
        expect(edited.ops[4]).toMatchObject({ message: { id: "a" }, generation: null });
        expect(edited.ops[5]).toMatchObject({ generation: { id: "g", seq: 2, final: false } });
        expect(edited.ops[6]).toMatchObject({ generation: { id: "g", seq: 3, final: true } });
        expect(destructive.needsCurrent).toBe(true);
        for (const ops of [[{ op: "delete" }], [{ op: "replace", chat: {} }]]) {
            expect(prepareChatGroups([group(ops)])[0].needsCurrent, ops[0].op).toBe(true);
        }
    });

    it("refuses malformed envelopes and illegal combinations, naming the entry", () => {
        groupRejects({}, "chats must be an array");
        groupRejects([null], "chats[0]: must name a valid characterId and chatId");
        groupRejects([group([], { characterId: "" })], "chats[0]: must name a valid characterId and chatId");
        groupRejects([group([], { chatId: ".." })], "chats[0]: must name a valid characterId and chatId");
        groupRejects([group([{ op: "delete" }]), group([{ op: "delete" }])], "chats[1]: duplicate chat");
        groupRejects([group([])], "chats[0]: ops must be a non-empty array");
        groupRejects([group({} as never)], "chats[0]: ops must be a non-empty array");
        groupRejects(
            [
                group(
                    [
                        { op: "meta", set: {} },
                        { op: "create", chat: {} },
                    ],
                    { baseRevision: null },
                ),
            ],
            "chats[0]: create must be the first op",
        );
        groupRejects([group([{ op: "delete" }, { op: "meta", set: {} }])], "chats[0]: delete must be the only op");
        groupRejects([group([{ op: "meta", set: {} }, { op: "delete" }])], "chats[0]: delete must be the only op");
        const base = "chats[0]: baseRevision must be null for a create and a revision string otherwise";
        groupRejects([group([{ op: "create", chat: {} }])], base);
        groupRejects([group([{ op: "create", chat: {} }], { baseRevision: undefined })], base);
        groupRejects([group([{ op: "meta", set: {} }], { baseRevision: null })], base);
        groupRejects([group([{ op: "meta", set: {} }], { baseRevision: 1 })], base);
    });

    it("refuses malformed operations with the group and op index", () => {
        const opRejects = (op: unknown, error: string) =>
            groupRejects([group([{ op: "meta", set: {} }, op])], `chats[0].ops[1]: ${error}`);
        opRejects(null, "must be an object with an op");
        opRejects({ op: 1 }, "must be an object with an op");
        opRejects({ op: "nope" }, "unknown op nope");
        // create
        groupRejects(
            [group([{ op: "create", chat: {}, index: -1 }], { baseRevision: null })],
            "chats[0].ops[0]: create.index must be a non-negative integer",
        );
        groupRejects(
            [group([{ op: "create", chat: {}, index: 1.5 }], { baseRevision: null })],
            "chats[0].ops[0]: create.index must be a non-negative integer",
        );
        groupRejects(
            [group([{ op: "create", chat: null }], { baseRevision: null })],
            "chats[0].ops[0]: chat must be an object",
        );
        groupRejects(
            [group([{ op: "create", chat: { id: "other" } }], { baseRevision: null })],
            "chats[0].ops[0]: chat.id must equal the chat id",
        );
        groupRejects(
            [group([{ op: "create", chat: { message: [{ role: "x" }] } }], { baseRevision: null })],
            "chats[0].ops[0]: message.role must be user or char",
        );
        // replace
        opRejects({ op: "replace", chat: [] }, "chat must be an object");
        opRejects({ op: "replace", chat: { message: {} } }, "chat.message must be an array");
        // meta
        opRejects({ op: "meta", set: [] }, "meta must be { set?: object, unset?: string[] }");
        opRejects({ op: "meta", unset: "note" }, "meta must be { set?: object, unset?: string[] }");
        opRejects({ op: "meta", unset: [1] }, "meta must be { set?: object, unset?: string[] }");
        for (const key of CHAT_META_FORBIDDEN_KEYS) {
            opRejects({ op: "meta", set: { [key]: 1 } }, `chat meta cannot change ${key}`);
            opRejects({ op: "meta", unset: [key] }, `chat meta cannot change ${key}`);
        }
        opRejects({ op: "meta", set: { note: "a" }, unset: ["note"] }, "meta sets and unsets the same field");
        // append
        opRejects({ op: "append", messages: [], anchor: { end: true } }, "append.messages must be a non-empty array");
        opRejects({ op: "append", messages: {}, anchor: { end: true } }, "append.messages must be a non-empty array");
        opRejects(
            { op: "append", messages: [{ role: "user", data: "x" }], anchor: { end: true } },
            "message.chatId must be a valid id",
        );
        opRejects(
            { op: "append", messages: [message("a"), message("a")], anchor: { end: true } },
            "append.messages has duplicate ids",
        );
        const anchor = "append.anchor must be { start: true }, { end: true }, or { after: id }";
        for (const bad of [
            undefined,
            null,
            "end",
            {},
            { start: false },
            { end: 1 },
            { start: true, end: true },
            { after: "" },
            { after: "a", start: true },
            { after: 1 },
        ]) {
            opRejects({ op: "append", messages: [message("a")], anchor: bad }, anchor);
        }
        // setMessage, setText, remove, begin
        opRejects({ op: "setMessage", message: message("a", 1 as never) }, "message.data must be a string");
        opRejects(
            { op: "setMessage", message: message("a"), generation: {} },
            "generation must be { id, seq, final? }",
        );
        opRejects({ op: "setText", id: "a" }, "setText must be { id, text }");
        opRejects({ op: "setText", id: "", text: "t" }, "setText must be { id, text }");
        for (const generation of [
            null,
            { id: "g" },
            { id: "", seq: 1 },
            { id: "g", seq: -1 },
            { id: "g", seq: 1.5 },
            { id: "g", seq: Number.MAX_SAFE_INTEGER + 1 },
            { id: "g", seq: 1, final: "yes" },
        ]) {
            opRejects({ op: "setText", id: "a", text: "t", generation }, "generation must be { id, seq, final? }");
        }
        opRejects({ op: "remove", ids: [] }, "remove.ids must be a non-empty array of ids");
        opRejects({ op: "remove", ids: "a" }, "remove.ids must be a non-empty array of ids");
        opRejects({ op: "remove", ids: ["a", ""] }, "remove.ids must be a non-empty array of ids");
        opRejects({ op: "remove", ids: ["a", "a"] }, "remove.ids has duplicate ids");
        opRejects({ op: "begin", id: "a" }, "begin must be { id, generationId }");
        opRejects({ op: "begin", id: "a", generationId: 1 }, "begin must be { id, generationId }");
    });
});

describe("prepareChatOrders and countChatOperations", () => {
    it("checks the reorder envelopes and counts nested ops and reorders toward the batch cap", () => {
        expect(prepareChatOrders(undefined)).toEqual([]);
        expect(prepareChatOrders([{ characterId: "c", baseRevision: "e:1:1", ids: ["a", "b"] }])).toEqual([
            { characterId: "c", baseRevision: "e:1:1", ids: ["a", "b"] },
        ]);
        expect(prepareChatOrders([{ characterId: "c", baseRevision: "e:1:1", ids: [] }])[0].ids).toEqual([]);
        rejects(() => prepareChatOrders({}), "chatOrders must be an array");
        const envelope = "chatOrders[0]: must be { characterId, baseRevision, ids }";
        rejects(() => prepareChatOrders([null]), envelope);
        rejects(() => prepareChatOrders([{ characterId: "", baseRevision: "e", ids: [] }]), envelope);
        rejects(() => prepareChatOrders([{ characterId: "c", baseRevision: null, ids: [] }]), envelope);
        rejects(() => prepareChatOrders([{ characterId: "c", ids: [] }]), envelope);
        const ids = "chatOrders[0]: ids must be a duplicate-free array of chat ids";
        rejects(() => prepareChatOrders([{ characterId: "c", baseRevision: "e", ids: "a" }]), ids);
        rejects(() => prepareChatOrders([{ characterId: "c", baseRevision: "e", ids: ["a", "a"] }]), ids);
        rejects(() => prepareChatOrders([{ characterId: "c", baseRevision: "e", ids: ["a", ""] }]), ids);
        rejects(
            () =>
                prepareChatOrders([
                    { characterId: "c", baseRevision: "e", ids: [] },
                    { characterId: "c", baseRevision: "e", ids: [] },
                ]),
            "chatOrders[1]: duplicate character",
        );

        const groups = prepareChatGroups([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    { op: "create", chat: {} },
                    { op: "meta", set: {} },
                ],
            },
            { characterId: "c", chatId: "k2", baseRevision: "e:1:1", ops: [{ op: "delete" }] },
        ]);
        const orders = prepareChatOrders([{ characterId: "c", baseRevision: "e:1:1", ids: ["k"] }]);
        expect(countChatOperations(groups, orders)).toBe(4);
        expect(countChatOperations([], [])).toBe(0);
    });
});
