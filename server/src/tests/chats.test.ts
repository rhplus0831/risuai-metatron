// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CHAT_META_FORBIDDEN_KEYS, MAX_TOOL_CALL_RECORD_BYTES } from "../../../shared/chats.ts";
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
    it("keeps every field except the messages and the streaming flags, sets the id, and defaults name, note, localLore, and fmIndex", () => {
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
        expect(normalizeChatMeta({}, "k")).toEqual({ id: "k", name: "", note: "", localLore: [], fmIndex: -1 });
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
            fmIndex: -1,
        });
        rejects(() => normalizeChatMeta({ localLore: {} }, "k"), "chat.localLore must be an array");
        rejects(() => normalizeChatMeta({ fmIndex: "0" }, "k"), "chat.fmIndex must be a number");
        // An absent `fmIndex` starts the chat from the first message (-1); a given one is kept.
        expect(normalizeChatMeta({ fmIndex: undefined }, "k").fmIndex).toBe(-1);
        expect(normalizeChatMeta({ fmIndex: 2 }, "k").fmIndex).toBe(2);
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
        expect(JSON.parse(create.meta)).toEqual({ name: "n", id: "k", note: "", localLore: [], fmIndex: -1 });
        expect(create.messages[0]).toEqual({ id: "a", text: JSON.stringify(message("a", "x")) });
        expect(create.messages[1].id).toMatch(uuid);
        expect(created.ops[1]).toEqual({ op: "meta", set: { note: "n" }, unset: [], merge: {}, mergeUnset: {} });
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
        expect(edited.ops[0]).toEqual({ op: "meta", set: {}, unset: ["note"], merge: {}, mergeUnset: {} });
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

describe("chat.toolCalls", () => {
    const record = (id: string, response: unknown[] = [{ type: "text", text: "4" }]) => ({
        call: { id, name: "rollDice", arg: '{"sides":6}' },
        response,
    });
    const withCalls = (toolCalls: unknown) => normalizeChatMeta({ id: "k", toolCalls }, "k");
    /** A map with prototype names as own entries (an object literal would set the prototype). */
    const protoNamed = JSON.parse(
        `{"__proto__": ${JSON.stringify(record("__proto__"))}, "constructor": ${JSON.stringify(record("constructor"))}}`,
    ) as Record<string, unknown>;

    it("accepts every tool content the request adapters read under the call's own id, an omitted argument, an empty answer, and prototype names as ids", () => {
        const toolCalls = {
            text: record("text"),
            image: record("image", [{ type: "image", data: "aGk=", mimeType: "image/png" }]),
            audio: record("audio", [{ type: "audio", data: "aGk=", mimeType: "audio/wav" }]),
            resource: record("resource", [{ type: "resource", resource: { uri: "x://y", text: "t" } }]),
            mixed: record("mixed", [
                { type: "text", text: "a" },
                { type: "image", data: "aGk=", mimeType: "image/png" },
            ]),
            empty: record("empty", []),
            noArg: { call: { id: "noArg", name: "tool" }, response: [{ type: "text", text: "" }] },
        };
        expect(withCalls(toolCalls).toolCalls).toEqual(toolCalls);
        expect(withCalls({}).toolCalls).toEqual({});
        expect(Object.keys(withCalls(protoNamed).toolCalls as object)).toEqual(["__proto__", "constructor"]);
        // Absent: nothing is added.
        expect(normalizeChatMeta({ id: "k" }, "k")).not.toHaveProperty("toolCalls");
    });

    it("refuses a map that is not an object, an entry under another or an empty id, a missing name, a response that is not a list, a malformed piece, and an entry over 1 MiB", () => {
        const refused = (toolCalls: unknown, label: string) =>
            expect(() => withCalls(toolCalls), label).toThrow(ResourceValidationError);
        refused([], "a list");
        refused("x", "a string");
        refused(null, "null");
        refused({ a: null }, "a null entry");
        refused({ a: record("b") }, "another id");
        refused({ "": record("") }, "an empty id");
        refused({ a: { call: { id: "a" }, response: [] } }, "no name");
        refused({ a: { call: { id: "a", name: 5 }, response: [] } }, "a name that is not a string");
        refused({ a: { call: "a", response: [] } }, "a call that is not an object");
        refused({ a: { call: { id: "a", name: "t" }, response: {} } }, "a response that is not a list");
        refused({ a: { call: { id: "a", name: "t" } } }, "no response");
        refused({ a: record("a", [{ type: "text" }]) }, "text without its text");
        refused({ a: record("a", [{ type: "image", data: "x" }]) }, "an image without a MIME type");
        refused({ a: record("a", [{ type: "audio", mimeType: "audio/wav" }]) }, "audio without data");
        refused({ a: record("a", [{ type: "resource" }]) }, "a resource without its resource");
        refused({ a: record("a", [{ type: "video", data: "x", mimeType: "video/mp4" }]) }, "an unknown type");
        refused({ a: record("a", [null]) }, "a null piece");
        refused({ a: record("a", ["text"]) }, "a piece that is a string");
        // The cap is on the serialized entry: at the cap it passes, one byte over it does not, and
        // multi-byte text counts in UTF-8 bytes.
        const base = record("big", [{ type: "text", text: "" }]);
        const room = MAX_TOOL_CALL_RECORD_BYTES - Buffer.byteLength(JSON.stringify(base), "utf8");
        expect(() => withCalls({ big: record("big", [{ type: "text", text: "x".repeat(room) }]) })).not.toThrow();
        refused({ big: record("big", [{ type: "text", text: "x".repeat(room + 1) }]) }, "over the cap");
        refused(
            { big: record("big", [{ type: "text", text: "가".repeat(Math.floor(room / 3) + 1) }]) },
            "over in UTF-8",
        );
    });

    it("prepares a meta op's `merge` for the map fields only, apart from the fields the op sets or unsets", () => {
        const group = (ops: unknown[]) => ({ characterId: "c", chatId: "k", baseRevision: "e:1:1", ops });
        const [prepared] = prepareChatGroups([
            group([
                { op: "meta", merge: { toolCalls: { a: record("a") } } },
                { op: "meta", set: { note: "n" } },
            ]),
        ]);
        expect(prepared.ops[0]).toEqual({
            op: "meta",
            set: {},
            unset: [],
            merge: { toolCalls: { a: record("a") } },
            mergeUnset: {},
        });
        expect(prepared.ops[1]).toEqual({ op: "meta", set: { note: "n" }, unset: [], merge: {}, mergeUnset: {} });
        expect(prepared.needsCurrent).toBe(false);
        const groupRejects = (op: unknown, error: string) =>
            rejects(() => prepareChatGroups([group([op])]), `chats[0].ops[0]: ${error}`);
        groupRejects(
            { op: "meta", merge: { note: { a: 1 } } },
            "meta.merge takes entries for toolCalls, GLGlobalVariables, scriptstate",
        );
        groupRejects(
            { op: "meta", merge: { toolCalls: "x" } },
            "meta.merge takes entries for toolCalls, GLGlobalVariables, scriptstate",
        );
        groupRejects(
            { op: "meta", merge: { toolCalls: [] } },
            "meta.merge takes entries for toolCalls, GLGlobalVariables, scriptstate",
        );
        groupRejects(
            { op: "meta", merge: { toolCalls: null } },
            "meta.merge takes entries for toolCalls, GLGlobalVariables, scriptstate",
        );
        groupRejects(
            { op: "meta", merge: 5 },
            "meta.merge takes entries for toolCalls, GLGlobalVariables, scriptstate",
        );
        groupRejects(
            { op: "meta", merge: [] },
            "meta.merge takes entries for toolCalls, GLGlobalVariables, scriptstate",
        );
        groupRejects(
            { op: "meta", merge: { toolCalls: {} }, set: { toolCalls: {} } },
            "meta merges a field it also sets or unsets",
        );
        groupRejects(
            { op: "meta", merge: { toolCalls: {} }, unset: ["toolCalls"] },
            "meta merges a field it also sets or unsets",
        );
    });
});

describe("patchMessage and meta.mergeUnset", () => {
    const group = (ops: unknown[]) => ({ characterId: "c", chatId: "k", baseRevision: "e:1:1", ops });
    const prepare = (op: unknown) => prepareChatGroups([group([op])])[0];
    const opRejects = (op: unknown, error: string) =>
        rejects(() => prepareChatGroups([group([{ op: "meta", set: {} }, op])]), `chats[0].ops[1]: ${error}`);
    const translation = { text: "t", sourceHash: "h", targetLanguage: "ko", translatedAt: 1 };

    it("prepares a patchMessage as the JSON copy of its fields, without translation, with unset deduplicated, as a by-id op", () => {
        const prepared = prepare({
            op: "patchMessage",
            id: "a",
            set: { disabled: true, translation, dropped: undefined, time: new Date(0) },
            unset: ["saying", "translation", "saying", "name"],
        });
        expect(prepared.needsCurrent).toBe(false);
        expect(prepared.ops[0]).toEqual({
            op: "patchMessage",
            id: "a",
            set: { disabled: true, time: "1970-01-01T00:00:00.000Z" },
            unset: ["saying", "name"],
        });
        // Either half alone is enough; role and data may be set, with their message shape.
        expect(prepare({ op: "patchMessage", id: "a", unset: ["disabled"] }).ops[0]).toEqual({
            op: "patchMessage",
            id: "a",
            set: {},
            unset: ["disabled"],
        });
        expect(prepare({ op: "patchMessage", id: "a", set: { role: "char", data: "d" } }).ops[0]).toEqual({
            op: "patchMessage",
            id: "a",
            set: { role: "char", data: "d" },
            unset: [],
        });
        // Nested prototype names are plain entry names, only the message's own `__proto__` is refused.
        const nested = JSON.parse('{"generationInfo": {"__proto__": {"x": 1}}, "constructor": "own"}') as unknown;
        expect(prepare({ op: "patchMessage", id: "a", set: nested }).ops[0]).toMatchObject({
            set: { generationInfo: { ["__proto__"]: { x: 1 } }, constructor: "own" },
        });
        expect(
            countChatOperations(prepareChatGroups([group([{ op: "patchMessage", id: "a", unset: ["name"] }])]), []),
        ).toBe(1);
    });

    it("refuses a malformed patchMessage, in the documented order, with the group and op index", () => {
        opRejects({ op: "patchMessage", set: { disabled: true } }, "patchMessage must be { id, set?, unset? }");
        opRejects({ op: "patchMessage", id: "", set: { disabled: true } }, "patchMessage must be { id, set?, unset? }");
        opRejects({ op: "patchMessage", id: 1, set: { disabled: true } }, "patchMessage must be { id, set?, unset? }");
        // A generation is refused before the fields are looked at (a manual write only).
        opRejects(
            { op: "patchMessage", id: "a", set: { role: 1 }, generation: { id: "g", seq: 1 } },
            "patchMessage carries no generation",
        );
        opRejects({ op: "patchMessage", id: "a", generation: null }, "patchMessage carries no generation");
        const shape = "patchMessage must be { id, set?: object, unset?: string[] }";
        for (const set of [null, [], "x", 1, true]) {
            opRejects({ op: "patchMessage", id: "a", set }, shape);
        }
        for (const unset of [null, "name", {}, [1], ["name", null], [["name"]]]) {
            opRejects({ op: "patchMessage", id: "a", unset }, shape);
        }
        // A hole in an in-process array is not a string.
        const holed: unknown[] = [];
        holed[1] = "name";
        opRejects({ op: "patchMessage", id: "a", unset: holed }, shape);
        // The set is checked as its JSON copy.
        opRejects({ op: "patchMessage", id: "a", set: { n: 1e400 } }, "Resource data contains a non-finite number");
        opRejects({ op: "patchMessage", id: "a", set: { n: 1n } }, "Resource data is not serializable as JSON");
        // Identity and the prototype, in set or in unset.
        opRejects({ op: "patchMessage", id: "a", set: { chatId: "b" } }, "patchMessage cannot change chatId");
        opRejects({ op: "patchMessage", id: "a", unset: ["chatId"] }, "patchMessage cannot change chatId");
        opRejects(
            { op: "patchMessage", id: "a", set: JSON.parse('{"__proto__": {"polluted": true}}') },
            "patchMessage cannot change __proto__",
        );
        opRejects({ op: "patchMessage", id: "a", unset: ["__proto__"] }, "patchMessage cannot change __proto__");
        // Translation is dropped from either half, so it cannot carry a patch on its own.
        for (const op of [
            { op: "patchMessage", id: "a" },
            { op: "patchMessage", id: "a", set: {}, unset: [] },
            { op: "patchMessage", id: "a", set: { translation } },
            { op: "patchMessage", id: "a", unset: ["translation"] },
            { op: "patchMessage", id: "a", set: { translation }, unset: ["translation"] },
            { op: "patchMessage", id: "a", set: { disabled: undefined } },
            { op: "patchMessage", id: "a", set: { disabled: () => true } },
        ]) {
            rejects(
                () => prepareChatGroups([group([op])]),
                "chats[0].ops[0]: patchMessage must set or unset a field",
                JSON.stringify(op),
            );
        }
        // Role and data stay on the row and keep their shapes when set.
        opRejects({ op: "patchMessage", id: "a", unset: ["role"] }, "patchMessage cannot unset role or data");
        opRejects({ op: "patchMessage", id: "a", unset: ["name", "data"] }, "patchMessage cannot unset role or data");
        opRejects(
            { op: "patchMessage", id: "a", set: { name: "n" }, unset: ["name"] },
            "patchMessage sets and unsets the same field",
        );
        opRejects({ op: "patchMessage", id: "a", set: { role: "system" } }, "message.role must be user or char");
        opRejects({ op: "patchMessage", id: "a", set: { role: null } }, "message.role must be user or char");
        opRejects({ op: "patchMessage", id: "a", set: { data: 1 } }, "message.data must be a string");
        opRejects({ op: "patchMessage", id: "a", set: { data: null } }, "message.data must be a string");
    });

    it("prepares meta.mergeUnset for the map fields only, apart from the fields the op sets or unsets, next to merge", () => {
        expect(
            prepare({
                op: "meta",
                mergeUnset: { scriptstate: ["$a", "$a"], toolCalls: [] },
                merge: { scriptstate: { $b: "1" } },
                set: { note: "n" },
                unset: ["name"],
            }).ops[0],
        ).toEqual({
            op: "meta",
            set: { note: "n" },
            unset: ["name"],
            merge: { scriptstate: { $b: "1" } },
            mergeUnset: { scriptstate: ["$a", "$a"], toolCalls: [] },
        });
        expect(prepare({ op: "meta", merge: { scriptstate: { $x: "1" } } }).ops[0]).toEqual({
            op: "meta",
            set: {},
            unset: [],
            merge: { scriptstate: { $x: "1" } },
            mergeUnset: {},
        });
        const shape = "meta.mergeUnset takes entry ids for toolCalls, GLGlobalVariables, scriptstate";
        for (const mergeUnset of [
            null,
            [],
            "x",
            { note: ["a"] },
            { scriptstate: "a" },
            { scriptstate: [1] },
            { scriptstate: null },
        ]) {
            opRejects({ op: "meta", mergeUnset }, shape);
        }
        const holed: unknown[] = [];
        holed[1] = "$a";
        opRejects({ op: "meta", mergeUnset: { scriptstate: holed } }, shape);
        opRejects(
            { op: "meta", mergeUnset: { scriptstate: ["$a"] }, set: { scriptstate: {} } },
            "meta merges a field it also sets or unsets",
        );
        opRejects(
            { op: "meta", mergeUnset: { scriptstate: ["$a"] }, unset: ["scriptstate"] },
            "meta merges a field it also sets or unsets",
        );
        opRejects(
            { op: "meta", merge: { scriptstate: {} }, unset: ["scriptstate"] },
            "meta merges a field it also sets or unsets",
        );
        // The forbidden meta keys are refused before the merge halves are looked at.
        opRejects({ op: "meta", set: { message: [] }, mergeUnset: 5 }, "chat meta cannot change message");
    });
});
