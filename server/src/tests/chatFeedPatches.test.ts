// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, Message, MessageTranslation } from "../../../shared/database.ts";
import type { ChatGroup, ChatOp } from "../../../shared/chats.ts";
import { MAX_FEED_PATCH_BYTES, SMALL_FEED_PATCH_BYTES, type ResourceBatchResult } from "../../../shared/resources.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import type { ChatWriteChange } from "../data/chatStore.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    createResourceStore,
    ResourceBatchConflictError,
    type AppliedChanges,
    type ResourceStore,
    type WrittenChanges,
} from "../data/resourceStore.ts";
import { createResourceTestClient } from "./testSupport.ts";

// Public store/feed contract: expected rows come from the operations below, not the patch builder.
const stores: ResourceStore[] = [];
afterEach(() => {
    stores.splice(0).forEach((store) => store.close());
    vi.restoreAllMocks();
});
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
    it("publishes an over-cap row manifest with removals and no body", () => {
        const b = setup();
        const baseRevision = b.read().revision;
        const candidates = [
            { id: "previous", data: "한".repeat(24 * 1024) },
            { id: "current", data: "B" },
        ];
        const carrier = { ...m("b", "B"), candidates, candidatesRevision: 1 };
        expect(Buffer.byteLength(JSON.stringify(candidates))).toBeGreaterThan(MAX_FEED_PATCH_BYTES);
        b.write([
            { op: "setMessage", message: carrier },
            { op: "append", anchor: { after: "b" }, messages: [m("inserted", "I")] },
            { op: "remove", ids: ["a", "c"] },
        ]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            rows: { baseRevision, changed: ["b", "inserted"], removed: ["a", "c"], count: 2, meta: [] },
        });
    });

    it("names set, removed, merged and merge-unset metadata in an over-cap manifest", () => {
        const b = setup();
        b.write([
            {
                op: "meta",
                set: { folderId: "gone", scriptstate: { keep: "same" }, bookmarkNames: { old: "remove" } },
            },
        ]);
        const baseRevision = b.read().revision;
        const carrier = {
            ...m("b", "B"),
            candidates: [
                { id: "previous", data: "x".repeat(MAX_FEED_PATCH_BYTES + 1) },
                { id: "current", data: "B" },
            ],
            candidatesRevision: 1,
        };
        b.write([
            { op: "setMessage", message: carrier },
            { op: "begin", id: "b", generationId: "reroll" },
            {
                op: "meta",
                set: { note: "reroll started" },
                unset: ["folderId"],
                merge: { scriptstate: { active: "reroll" } },
                mergeUnset: { bookmarkNames: ["old"] },
            },
        ]);
        const entry = b.notice();
        expect(entry).toMatchObject({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            rows: {
                baseRevision,
                changed: ["b"],
                removed: [],
                count: 3,
                meta: expect.arrayContaining(["note", "folderId", "scriptstate", "bookmarkNames"]),
            },
        });
        expect(entry.rows!.meta).toHaveLength(4);
        for (const key of ["patch", "delta", "rowDelta"]) expect(entry).not.toHaveProperty(key);
    });

    it("omits the row manifest too when its ids exceed the feed cap", () => {
        const b = setup();
        const messages = Array.from({ length: 140 }, (_, i) => m(`${i}-${"x".repeat(500)}`, "new"));
        expect(Buffer.byteLength(JSON.stringify(messages.map((message) => message.chatId)))).toBeGreaterThan(
            MAX_FEED_PATCH_BYTES,
        );
        b.write([{ op: "append", anchor: { end: true }, messages }]);
        const entry = b.notice();
        expect(entry.revision).toBe(b.read().revision);
        for (const key of ["patch", "delta", "rowDelta", "rows"]) expect(entry).not.toHaveProperty(key);
    });

    it.each([
        { label: "4 KiB", before: "x".repeat(4 * 1024), body: "patch" },
        { label: "32 KiB", before: "x".repeat(32 * 1024), body: "rowDelta" },
        { label: "100 KiB", before: "x".repeat(100 * 1024), body: "rowDelta" },
        { label: "9 KiB of UTF-8", before: "한".repeat(3 * 1024), body: "rowDelta" },
    ] as const)("publishes an appending $label checkpoint as $body", ({ before, body }) => {
        const b = setup();
        b.write([{ op: "setText", id: "b", text: before }]);
        const baseRevision = b.read().revision;
        const suffix = "😀 appended";
        const patch = { baseRevision, count: 3, messages: [{ after: "a", message: m("b", before + suffix) }] };
        const rowDelta = {
            baseRevision,
            count: 3,
            rowDiffs: [{ id: "b", text: { keep: before.length, text: suffix } }],
        };
        b.write([{ op: "setText", id: "b", text: before + suffix }]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            [body]: body === "patch" ? patch : rowDelta,
        });
        const patchBytes = Buffer.byteLength(JSON.stringify(patch));
        if (body === "patch") expect(patchBytes).toBeLessThan(SMALL_FEED_PATCH_BYTES);
        else {
            expect(patchBytes).toBeGreaterThanOrEqual(SMALL_FEED_PATCH_BYTES);
            expect(Buffer.byteLength(JSON.stringify(rowDelta))).toBeLessThan(patchBytes);
            expect(Buffer.byteLength(JSON.stringify(rowDelta))).toBeLessThanOrEqual(MAX_FEED_PATCH_BYTES);
        }
        expect(b.read().data.message[1]).toEqual(m("b", before + suffix));
    });

    it("publishes a same-text final generationInfo write as fields without text", () => {
        const b = setup();
        const data = "x".repeat(100 * 1024);
        b.write([
            {
                op: "setMessage",
                message: { ...m("b", data), generationInfo: { model: "before", inputTokens: 1, maxContext: 1000 } },
            },
        ]);
        const baseRevision = b.read().revision;
        const generationInfo = { model: "test-model", generationId: "g", inputTokens: 12, outputTokens: 34 };
        b.write([{ op: "setMessage", message: { ...m("b", data), generationInfo } }]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            rowDelta: {
                baseRevision,
                count: 3,
                rowDiffs: [{ id: "b", fields: { set: { generationInfo }, unset: [] } }],
            },
        });
        expect(b.read().data.message[1]).toEqual({ ...m("b", data), generationInfo });
    });

    it("diffs a group's final fields and UTF-16 text against its first read beside whole inserted rows", () => {
        const b = setup();
        const prefix = "x".repeat(32 * 1024) + "😀";
        b.write([
            {
                op: "setMessage",
                message: {
                    ...m("b", prefix + "old"),
                    saying: "gone",
                    generationInfo: { model: "same", inputTokens: 12 },
                },
            },
        ]);
        const baseRevision = b.read().revision;
        b.write([
            {
                op: "setMessage",
                message: {
                    ...m("b", prefix + "intermediate"),
                    saying: "gone",
                    role: "user",
                    generationInfo: { inputTokens: 12, model: "same" },
                },
            },
            { op: "patchMessage", id: "b", set: { data: prefix + "new" }, unset: ["saying"] },
            { op: "append", anchor: { after: "b" }, messages: [m("inserted", "first")] },
            { op: "setText", id: "inserted", text: "final" },
            { op: "remove", ids: ["a"] },
            { op: "meta", set: { note: "changed" } },
        ]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            rowDelta: {
                baseRevision,
                count: 3,
                metaFields: { set: { note: "changed" }, remove: [] },
                removed: ["a"],
                messages: [{ after: "b", message: m("inserted", "final") }],
                rowDiffs: [
                    {
                        id: "b",
                        fields: { set: { role: "user" }, unset: ["saying"] },
                        text: { keep: prefix.length, text: "new" },
                    },
                ],
            },
        });
        expect(b.read().data.message).toEqual([
            { ...m("b", prefix + "new"), role: "user", generationInfo: { model: "same", inputTokens: 12 } },
            m("inserted", "final"),
            m("c", "C"),
        ]);
    });

    it("keeps a row with a changed __proto__ whole beside an eligible row diff", () => {
        const b = setup();
        const data = "x".repeat(32 * 1024);
        const before = m("c", "old");
        const after = {
            ...m("c", "new"),
            ...JSON.parse('{"__proto__":{"value":"own field"}}'),
        };
        b.write([
            { op: "setText", id: "b", text: data },
            { op: "setMessage", message: before },
        ]);
        const baseRevision = b.read().revision;
        b.write([
            { op: "setText", id: "b", text: data + "!" },
            { op: "setMessage", message: after },
        ]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            rowDelta: {
                baseRevision,
                count: 3,
                messages: [{ after: "b", message: after }],
                rowDiffs: [{ id: "b", text: { keep: data.length, text: "!" } }],
            },
        });
        expect(b.read().data.message).toEqual([m("a", "A"), m("b", data + "!"), after]);
    });

    it.each([
        { comparison: "equal in size", saying: "s".repeat(8), excess: 0 },
        { comparison: "larger", saying: undefined, excess: 20 },
    ])("keeps a fitting whole-row patch when the row diff would be $comparison", ({ saying, excess }) => {
        const b = setup();
        const unchanged = saying === undefined ? {} : { saying };
        b.write([{ op: "setMessage", message: { ...m("b", "B"), ...unchanged } }]);
        const baseRevision = b.read().revision;
        const message = { ...m("b", "x".repeat(12 * 1024)), role: "user" as const, ...unchanged };
        const patch = { baseRevision, count: 3, messages: [{ after: "a", message }] };
        const rowDelta = {
            baseRevision,
            count: 3,
            rowDiffs: [
                { id: "b", fields: { set: { role: "user" }, unset: [] }, text: { keep: 0, text: message.data } },
            ],
        };
        expect(Buffer.byteLength(JSON.stringify(rowDelta)) - Buffer.byteLength(JSON.stringify(patch))).toBe(excess);
        b.write([{ op: "setMessage", message }]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            patch,
        });
        expect(b.read().data.message[1]).toEqual(message);
    });

    it("publishes a row manifest and no body when a changed row field exceeds the UTF-8 cap", () => {
        const b = setup();
        const data = "x".repeat(100 * 1024);
        b.write([{ op: "setText", id: "b", text: data }]);
        const baseRevision = b.read().revision;
        const generationInfo = { model: "한".repeat(23 * 1024) };
        expect(Buffer.byteLength(JSON.stringify(generationInfo))).toBeGreaterThan(MAX_FEED_PATCH_BYTES);
        b.write([{ op: "setMessage", message: { ...m("b", data), generationInfo } }]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            rows: { baseRevision, changed: ["b"], removed: [], count: 3, meta: [] },
        });
        expect(b.read().data.message[1]).toEqual({ ...m("b", data), generationInfo });
    });

    it("keeps summaryBase for equal listed fields without reparsing large metadata for the summary", () => {
        const b = setup();
        const memory = "m".repeat(56 * 1024);
        b.write([{ op: "meta", set: { supaMemoryData: memory } }]);
        const baseRevision = b.store.chatRevision("c", "k")!;
        const parse = JSON.parse;
        const largeParses: number[] = [];
        const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (typeof text === "string" && text.length > 50 * 1024) largeParses.push(text.length);
            return parse(text, reviver);
        });
        try {
            b.write([{ op: "meta", set: { name: "K", note: "changed unlisted field" } }]);
            const notice = b.notice();
            expect(notice).toMatchObject({
                summaryBase: baseRevision,
                patch: { baseRevision, meta: { name: "K", note: "changed unlisted field", supaMemoryData: memory } },
            });
            expect(notice).not.toHaveProperty("summary");
            expect(Buffer.byteLength(JSON.stringify(notice.patch))).toBeLessThan(MAX_FEED_PATCH_BYTES);
            // The write may parse for its metadata merge, stored-value validation, and full feed
            // payload. The summary comparison has no allowance to parse either metadata again.
            expect(largeParses.length).toBeLessThanOrEqual(3);
        } finally {
            spy.mockRestore();
        }
    });

    it("uses the stored summary base for text checkpoints and unlisted metadata, keeping small metadata whole", () => {
        const b = setup();
        const requestedBase = b.read().revision;
        b.write([{ op: "meta", set: { name: "Renamed elsewhere" } }]);
        const storedBase = b.read().revision;
        b.write([{ op: "setText", id: "b", text: "checkpoint" }], requestedBase);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: storedBase,
            patch: { baseRevision: storedBase, count: 3, messages: [{ after: "a", message: m("b", "checkpoint") }] },
        });
        const baseRevision = b.read().revision;
        b.write([{ op: "meta", set: { note: "unlisted note" } }]);
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
            patch: {
                baseRevision,
                count: 3,
                meta: { id: "k", name: "Renamed elsewhere", note: "unlisted note", fmIndex: -1, localLore: [] },
            },
        });
    });

    it("sends only changed metadata fields beside large memory, including map entries and whole shape transitions", () => {
        const b = setup();
        const maps = ["scriptstate", "toolCalls", "GLGlobalVariables", "bookmarkNames"];
        const entries = (key: string, values: Record<string, string>) =>
            Object.fromEntries(
                Object.entries(values).map(([id, text]) => [
                    id,
                    key === "toolCalls"
                        ? { call: { id, name: "t", arg: {} }, response: [{ type: "text", text }] }
                        : text,
                ]),
            );
        b.write([
            {
                op: "meta",
                set: {
                    supaMemoryData: "m".repeat(100 * 1024),
                    ...Object.fromEntries(
                        maps.map((key) => [key, entries(key, { keep: "same", change: "old", gone: "remove" })]),
                    ),
                },
            },
        ]);
        const cases: { ops: ChatOp[]; fields: Record<string, unknown> }[] = [
            {
                ops: [{ op: "meta", set: { autoTranslate: true } }],
                fields: { set: { autoTranslate: true }, remove: [] },
            },
            ...maps.map((key) => ({
                // A whole-map input still produces a diff of the stored entries, not a copy of the op.
                ops: [
                    {
                        op: "meta" as const,
                        set: { [key]: entries(key, { keep: "same", change: "new", added: "value" }) },
                    },
                ],
                fields: {
                    set: {},
                    remove: [],
                    merge: { [key]: entries(key, { change: "new", added: "value" }) },
                    mergeUnset: { [key]: ["gone"] },
                },
            })),
            {
                ops: [{ op: "meta", set: { scriptstate: "legacy string" } }],
                fields: { set: { scriptstate: "legacy string" }, remove: [] },
            },
            {
                ops: [{ op: "meta", set: { scriptstate: { back: "map" } } }],
                fields: { set: { scriptstate: { back: "map" } }, remove: [] },
            },
            { ops: [{ op: "meta", unset: ["scriptstate"] }], fields: { set: {}, remove: ["scriptstate"] } },
            {
                ops: [{ op: "meta", merge: { scriptstate: { appeared: "map" } } }],
                fields: { set: { scriptstate: { appeared: "map" } }, remove: [] },
            },
        ];
        for (const { ops, fields } of cases) {
            const baseRevision = b.read().revision;
            b.write(ops);
            const entry = b.notice();
            expect(entry.delta, JSON.stringify(ops)).toEqual({ baseRevision, count: 3, metaFields: fields });
            expect(entry).not.toHaveProperty("patch");
            expect(entry).not.toHaveProperty("rowDelta");
            expect(Buffer.byteLength(JSON.stringify(entry.delta))).toBeLessThan(1024);
            expect(b.read().data.supaMemoryData).toBe("m".repeat(100 * 1024));
        }
    });

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
            // The rename changes the summary; no message carries a time, so it has no lastMessageAt.
            summary: { characterId: "c", id: "k", revision: b.read().revision, name: "renamed", fmIndex: -1 },
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
            summaryBase: baseRevision,
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

    it("keeps a remove and reappend of the same id without a by-id patch", () => {
        const b = setup();
        const baseRevision = b.read().revision;
        b.write([
            { op: "remove", ids: ["b"] },
            { op: "append", anchor: { end: true }, messages: [m("b", "moved")] },
        ]);
        expect(b.read().data.message).toEqual([m("a", "A"), m("c", "C"), m("b", "moved")]);
        // Neither last row has a time and the metadata is unchanged: the summary is the base's.
        expect(b.notice()).toEqual({
            characterId: "c",
            id: "k",
            revision: b.read().revision,
            summaryBase: baseRevision,
        });
    });

    it("keeps a no-op replay as a plain reference at the unchanged revision", () => {
        const b = setup();
        const revision = b.read().revision;
        b.events.length = 0;
        b.write([{ op: "append", anchor: { end: true }, messages: [m("c", "C")] }]);
        expect(b.events).toHaveLength(1);
        expect(b.notice()).toEqual({ characterId: "c", id: "k", revision });
    });

    it("allows a whole-row patch of 64 KiB exactly and a row manifest above it, measured in UTF-8 bytes", () => {
        const b = setup();
        for (const excess of [0, 1]) {
            const baseRevision = b.read().revision;
            // An inserted row has no row diff, so the whole-row patch is the only body that can carry it.
            const count = b.read().data.message.length + 1;
            const after = b.read().data.message.at(-1)!.chatId!;
            const id = `inserted-${excess}`;
            const overhead = Buffer.byteLength(
                JSON.stringify({ baseRevision, count, messages: [{ after, message: m(id, "") }] }),
            );
            const text = "한".repeat(100) + "x".repeat(64 * 1024 - overhead - 300 + excess);
            b.write([{ op: "append", anchor: { end: true }, messages: [m(id, text)] }]);
            const patch = { baseRevision, count, messages: [{ after, message: m(id, text) }] };
            expect(Buffer.byteLength(JSON.stringify(patch))).toBe(64 * 1024 + excess);
            expect(Object.hasOwn(b.notice(), "patch")).toBe(excess === 0);
            expect(b.notice()).toEqual({
                characterId: "c",
                id: "k",
                revision: b.read().revision,
                // The summary base is independent of whether the patch fits.
                summaryBase: baseRevision,
                ...(excess ? { rows: { baseRevision, changed: [id], removed: [], count, meta: [] } } : { patch }),
            });
            expect(b.read().data.message.at(-1)).toEqual(m(id, text));
        }
    });

    it("publishes one final reference without a patch when a chat is recorded twice in a publishing scope", () => {
        const b = setup();
        const firstBase = b.read().revision;
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
        // Two writes that leave the summary unchanged: unchanged since the first write's base.
        expect(b.notice()).toEqual({ characterId: "c", id: "k", revision: b.read().revision, summaryBase: firstBase });
        expect(b.read().data.message).toEqual([m("a", "A2"), m("b", "B2"), m("c", "C")]);
    });
});

const bumped = (revision: string, applied: number) =>
    revision.replace(/:\d+$/, (counter) => `:${Number(counter.slice(1)) + applied}`);
const commitSpy = () => vi.fn((_applied: AppliedChanges, _written?: WrittenChanges) => []);
const group = (baseRevision: string | null, ops: ChatOp[], chatId = "k"): ChatGroup => ({
    characterId: "c",
    chatId,
    baseRevision,
    ops,
});

/** Read the stored bytes independently of the writer's callback, without assuming JSON key order. */
function storedMetadata() {
    const prepare = DatabaseSync.prototype.prepare;
    let connection: DatabaseSync;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        connection = this;
        return prepare.call(this, sql);
    });
    return (id: string) => {
        const row = connection.prepare("SELECT meta FROM chats WHERE characterId = ? AND id = ?").get("c", id);
        if (typeof row?.meta !== "string") throw new Error("The fixture chat must have stored metadata");
        return row.meta;
    };
}

describe("a writer's own chat changes", () => {
    it("returns the stored row, anchor and count for setText only when requested", () => {
        for (const changes of [false, true]) {
            const b = setup();
            const baseRevision = b.read().revision;
            const committed = commitSpy();
            const applied = b.store.applyChanges(
                { chats: [group(baseRevision, [{ op: "setText", id: "b", text: "B!" }])] },
                { ...(changes ? { changes: true } : {}), committed },
            );
            const revision = bumped(baseRevision, 1);
            const change: ChatWriteChange = {
                baseRevision,
                revision,
                count: 3,
                removed: [],
                rows: [{ id: "b", after: "a", data: JSON.stringify(m("b", "B!")) }],
            };
            expect(committed.mock.calls).toStrictEqual([changes ? [applied, { chats: [change] }] : [applied]]);
            expect(b.notice()).toEqual({
                characterId: "c",
                id: "k",
                revision,
                summaryBase: baseRevision,
                patch: { baseRevision, count: 3, messages: [{ after: "a", message: m("b", "B!") }] },
            });
        }
    });

    it("uses the stored base for a stale group and advances by its applied op count", () => {
        const b = setup();
        const requestedBase = b.read().revision;
        b.write([{ op: "meta", set: { note: "another writer" } }]);
        const baseRevision = bumped(requestedBase, 1);
        const committed = commitSpy();
        const applied = b.store.applyChanges(
            {
                chats: [
                    group(requestedBase, [
                        { op: "setText", id: "c", text: "C!" },
                        { op: "append", anchor: { start: true }, messages: [m("first", "FIRST")] },
                        { op: "setText", id: "missing", text: "ignored" },
                        { op: "setText", id: "b", text: "B!" },
                    ]),
                ],
            },
            { changes: true, committed },
        );
        const revision = bumped(baseRevision, 3);
        expect(applied.chats).toEqual([
            { characterId: "c", id: "k", revision, stale: true, targets: ["applied", "missing", "applied"] },
        ]);
        expect(committed.mock.calls).toStrictEqual([
            [
                applied,
                {
                    chats: [
                        {
                            baseRevision,
                            revision,
                            count: 4,
                            removed: [],
                            rows: [
                                { id: "first", after: null, data: JSON.stringify(m("first", "FIRST")) },
                                { id: "b", after: "a", data: JSON.stringify(m("b", "B!")) },
                                { id: "c", after: "b", data: JSON.stringify(m("c", "C!")) },
                            ],
                        },
                    ],
                },
            ],
        ]);
    });

    it("reports base removals and stored metadata while the feed also lists an appended then removed id", () => {
        const storedMeta = storedMetadata();
        for (const changes of [false, true]) {
            const b = setup();
            const baseRevision = b.read().revision;
            const committed = commitSpy();
            const applied = b.store.applyChanges(
                {
                    chats: [
                        group(baseRevision, [
                            { op: "append", anchor: { start: true }, messages: [m("temporary", "TEMP")] },
                            { op: "setText", id: "c", text: "C!" },
                            { op: "remove", ids: ["b", "temporary", "a"] },
                            { op: "meta", set: { name: "renamed" } },
                        ]),
                    ],
                },
                { ...(changes ? { changes: true } : {}), committed },
            );
            const revision = bumped(baseRevision, 4);
            const meta = { id: "k", name: "renamed", note: "keep", fmIndex: -1, localLore: [] };
            const change: ChatWriteChange = {
                baseRevision,
                revision,
                count: 1,
                removed: ["b", "a"],
                rows: [{ id: "c", after: null, data: JSON.stringify(m("c", "C!")) }],
                meta: storedMeta("k"),
            };
            expect(JSON.parse(change.meta!)).toEqual(meta);
            expect(committed.mock.calls).toStrictEqual([changes ? [applied, { chats: [change] }] : [applied]]);
            expect(b.notice()).toEqual({
                characterId: "c",
                id: "k",
                revision,
                summary: { characterId: "c", id: "k", revision, name: "renamed", fmIndex: -1 },
                patch: {
                    baseRevision,
                    count: 1,
                    meta,
                    removed: ["b", "temporary", "a"],
                    messages: [{ after: null, message: m("c", "C!") }],
                },
            });
        }
    });

    it("returns every touched row above the feed byte cap while publishing a row manifest instead of a body", () => {
        for (const changes of [false, true]) {
            const b = setup();
            const baseRevision = b.read().revision;
            const text = "x".repeat(MAX_FEED_PATCH_BYTES + 1);
            const committed = commitSpy();
            const applied = b.store.applyChanges(
                {
                    chats: [
                        group(baseRevision, [
                            { op: "setText", id: "b", text: "B!" },
                            { op: "setText", id: "a", text },
                        ]),
                    ],
                },
                { ...(changes ? { changes: true } : {}), committed },
            );
            const revision = bumped(baseRevision, 2);
            const change: ChatWriteChange = {
                baseRevision,
                revision,
                count: 3,
                removed: [],
                rows: [
                    { id: "a", after: null, data: JSON.stringify(m("a", text)) },
                    { id: "b", after: "a", data: JSON.stringify(m("b", "B!")) },
                ],
            };
            expect(committed.mock.calls).toStrictEqual([changes ? [applied, { chats: [change] }] : [applied]]);
            expect(b.notice()).toEqual({
                characterId: "c",
                id: "k",
                revision,
                summaryBase: baseRevision,
                rows: { baseRevision, changed: ["b", "a"], removed: [], count: 3, meta: [] },
            });
        }
    });

    it("stops touched-row reads at the feed byte cap when changes are not requested", () => {
        const reads = { rows: 0, iterate: 0, all: 0 };
        const prepare = DatabaseSync.prototype.prepare;
        vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
            const statement = prepare.call(this, sql);
            if (sql.includes("FROM messages m") && sql.includes("AS after") && sql.includes("json_each")) {
                const { iterate, all } = statement;
                statement.iterate = function* (...args) {
                    reads.iterate++;
                    for (const row of Reflect.apply(iterate, this, args)) {
                        reads.rows++;
                        yield row;
                    }
                    return undefined;
                };
                statement.all = function (...args) {
                    reads.all++;
                    const rows = Reflect.apply(all, this, args);
                    reads.rows += rows.length;
                    return rows;
                };
            }
            return statement;
        });
        const b = setup();
        // A fitting patch proves the counter observes the touched-row statement.
        b.write([{ op: "setText", id: "b", text: "B!" }]);
        expect(reads).toEqual({ rows: 1, iterate: 1, all: 0 });
        Object.assign(reads, { rows: 0, iterate: 0, all: 0 });
        const committed = commitSpy();
        const large = "x".repeat(MAX_FEED_PATCH_BYTES + 1);
        const metadata = b.store.applyChanges(
            {
                chats: [
                    group(b.store.chatRevision("c", "k"), [
                        { op: "meta", set: { note: large } },
                        { op: "setText", id: "a", text: "A!" },
                        { op: "setText", id: "b", text: "B!!" },
                    ]),
                ],
            },
            { committed },
        );
        expect(reads).toEqual({ rows: 0, iterate: 0, all: 0 });
        expect(committed.mock.calls).toStrictEqual([[metadata]]);
        expect(b.notice()).not.toHaveProperty("patch");
        b.write([
            { op: "setText", id: "a", text: large },
            { op: "setText", id: "b", text: "B!!!" },
            { op: "setText", id: "c", text: "C!" },
        ]);
        expect(reads).toEqual({ rows: 1, iterate: 1, all: 0 });
        expect(b.notice()).not.toHaveProperty("patch");
    });

    it("leaves an undefined entry for whole-chat writes, reappends, replays and unapplied groups", () => {
        const cases = [
            { name: "create", ops: [{ op: "create", chat: { ...initial, id: "new" } }] },
            { name: "replace", ops: [{ op: "replace", chat: { ...initial, name: "replacement" } }] },
            { name: "delete", ops: [{ op: "delete" }] },
            {
                name: "remove and reappend",
                ops: [
                    { op: "remove", ids: ["b"] },
                    { op: "append", anchor: { end: true }, messages: [m("b", "moved")] },
                ],
            },
            { name: "duplicate replay", ops: [{ op: "setText", id: "b", text: "B!" }] },
            { name: "no-op", ops: [{ op: "append", anchor: { end: true }, messages: [m("b", "B")] }] },
            { name: "missing target", ops: [{ op: "setText", id: "missing", text: "ignored" }] },
        ] satisfies { name: string; ops: ChatOp[] }[];
        for (const { name, ops } of cases) {
            const b = setup();
            const chat = name === "create" ? group(null, ops, "new") : group(b.read().revision, ops);
            if (name === "duplicate replay") {
                chat.groupId = "remembered";
                b.store.applyChanges({ chats: [chat] });
                b.write([{ op: "setText", id: "b", text: "later writer" }]);
                chat.retry = true;
            }
            const committed = commitSpy();
            const applied = b.store.applyChanges({ chats: [chat] }, { changes: true, committed });
            expect(committed.mock.calls, name).toStrictEqual([[applied, { chats: [undefined] }]]);
        }
    });

    it("calls no committed hook and publishes nothing when a later group rolls the batch back", () => {
        const b = setup();
        const before = b.read();
        const committed = commitSpy();
        b.events.length = 0;
        expect(() =>
            b.store.applyChanges(
                {
                    chats: [
                        group(before.revision, [{ op: "setText", id: "b", text: "rolled back" }]),
                        group(before.revision, [{ op: "delete" }], "missing"),
                    ],
                },
                { changes: true, committed },
            ),
        ).toThrow(ResourceBatchConflictError);
        expect(committed).not.toHaveBeenCalled();
        expect(b.events).toEqual([]);
        expect(b.read()).toEqual(before);
    });

    it("aligns changes and undefined entries with every chat group in the batch", () => {
        const storedMeta = storedMetadata();
        const b = setup();
        const seeded = b.store.applyChanges({
            chats: ["j", "l"].map((id) => group(null, [{ op: "create", chat: { ...initial, id } }], id)),
        });
        const baseJ = seeded.chats[0].revision!;
        const baseL = seeded.chats[1].revision!;
        const committed = commitSpy();
        const applied = b.store.applyChanges(
            {
                chats: [
                    group(baseJ, [{ op: "setText", id: "b", text: "J!" }], "j"),
                    group(null, [{ op: "create", chat: { ...initial, id: "new" } }], "new"),
                    group(b.read().revision, [{ op: "setText", id: "missing", text: "ignored" }]),
                    group(baseL, [{ op: "meta", set: { note: "L!" } }], "l"),
                ],
            },
            { changes: true, committed },
        );
        expect(applied.chats.map(({ id }) => id)).toEqual(["j", "new", "k", "l"]);
        expect(committed.mock.calls).toStrictEqual([
            [
                applied,
                {
                    chats: [
                        {
                            baseRevision: baseJ,
                            revision: bumped(baseJ, 1),
                            count: 3,
                            removed: [],
                            rows: [{ id: "b", after: "a", data: JSON.stringify(m("b", "J!")) }],
                        },
                        undefined,
                        undefined,
                        {
                            baseRevision: baseL,
                            revision: bumped(baseL, 1),
                            count: 3,
                            removed: [],
                            rows: [],
                            meta: storedMeta("l"),
                        },
                    ],
                },
            ],
        ]);
        expect(JSON.parse(storedMeta("l"))).toEqual({ id: "l", name: "K", note: "L!", fmIndex: -1, localLore: [] });
    });

    it("keeps the HTTP batch response keys unchanged for a by-id chat write", async () => {
        const s = await createResourceTestClient();
        try {
            const seeded = await s.json("/api/resources/batch", {
                ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c" } }],
                chats: [group(null, [{ op: "create", chat: initial }])],
            });
            expect(seeded.status).toBe(200);
            const base = ((await seeded.json()) as ResourceBatchResult).chats![0].revision!;
            const response = await s.json("/api/resources/batch", {
                chats: [group(base, [{ op: "setText", id: "b", text: "B!" }])],
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                epoch: s.epoch,
                results: [],
                chats: [{ characterId: "c", id: "k", revision: bumped(base, 1) }],
                chatOrders: [],
            });
        } finally {
            await s.close();
        }
    });
});
