// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESOURCE_KIND, type ResourceKindName } from "../../../shared/resources.ts";
import { COLLECTION_KIND } from "../../../shared/sections.ts";
import { createUpstreamImportReport, type UpstreamImportReport } from "../../../shared/upstreamBackup.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, isValidResourceId } from "../data/resourceStore.ts";
import type { ColdRecordResult } from "../data/upstream/archive.ts";
import {
    convertUpstreamDatabase,
    type UpstreamConversion,
    type UpstreamConversionOptions,
} from "../data/upstream/importDatabase.ts";

// The library half of the upstream `.bin` converter (characters, groups, chats, cold storage,
// modules, plugins, plugin storage, assets), on synthetic objects only. Covers the character,
// cold-storage, and chat rules, the two departures (kept `GLGlobalVariables` minus its `""` toggles;
// `_coldplugin` into `_pluginStorage`), the end-to-end staged-store write, and the recovery defects
// (report overflow, tool-call and lorebook exceptions, plugin storage envelopes, the message list's
// depth budget, silent JSON-copy repairs).

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);

/** Upstream's cold-chat marker (U `process/coldstorageData.ts` `coldStorageHeader`). */
const COLD = "\uEF01COLDSTORAGE\uEF01";
const K = {
    chatArray: "11111111-1111-1111-1111-111111111111",
    chatObject: "22222222-2222-2222-2222-222222222222",
    character: "33333333-3333-3333-3333-333333333333",
    absent: "44444444-4444-4444-4444-444444444444",
    plugin: "55555555-5555-5555-5555-555555555555",
    pluginAbsent: "66666666-6666-6666-6666-666666666666",
};

type Dict = Record<string, unknown>;
type Out = UpstreamConversion;

const ok = (value: unknown): ColdRecordResult => ({ ok: true, value });

function convert(db: Dict, options: UpstreamConversionOptions = {}): Out {
    return convertUpstreamDatabase(db, { now: 1, ...options });
}

function record<T>(out: Out, kind: ResourceKindName): T {
    const found = out.resources.filter((resource) => resource.kind === kind);
    expect(found, kind).toHaveLength(1);
    return found[0].data as T;
}

const entry = (list: UpstreamImportReport["converted"] | UpstreamImportReport["excluded"], code: string) =>
    list.find((item) => item.code === code);
const excluded = (out: Out, code: string) => entry(out.report.excluded, code);
const converted = (out: Out, code: string) => entry(out.report.converted, code);

const characterNamed = (out: Out, name: string) => {
    const found = out.characters.find((character) => character.data.name === name);
    expect(found, name).toBeDefined();
    return found!;
};
const chatsOf = (out: Out, characterId: string) =>
    out.chats
        .filter((group) => group.characterId === characterId)
        .map((group) => {
            const op = group.ops[0];
            expect(op.op).toBe("create");
            expect(group.baseRevision).toBeNull();
            expect(group.chatId).toBe((op as unknown as { chat: Dict }).chat.id);
            return (op as unknown as { chat: Dict }).chat as Dict & { message: Dict[] };
        });

/** An object nested `levels` deep (the store refuses JSON nested 256 levels or deeper). */
function deep(levels: number): Dict {
    let value: Dict = {};
    for (let i = 0; i < levels; i++) {
        value = { x: value };
    }
    return value;
}

/** A character's messages as upstream stores them: no `chatId` yet. */
const msg = (role: "user" | "char", data: string, extra: Dict = {}): Dict => ({ role, data, time: 5, ...extra });

/**
 * A synthetic upstream library: a dropped `null` and `§temp`, character A with two chats (one a cold
 * pointer), a cold stub B whose payload holds the whole character, a duplicate of A's id, a group with
 * a member that no longer exists, a stub whose payload the archive lacks; modules, plugins, and plugin
 * storage with legacy and cold values; and the preset/persona selection the chats bind to.
 */
function fixture(): Dict {
    return {
        formatversion: 5,
        botPresets: [{ name: "P0" }, { name: "P1" }],
        botPresetsId: 1,
        personas: [
            { id: "p-a", name: "A", icon: "", personaPrompt: "", note: "" },
            { id: "p-b", name: "B", icon: "assets/pb.png", personaPrompt: "", note: "" },
        ],
        selectedPersona: 1,
        characters: [
            null,
            { chaId: "§temp", name: "tmp", chats: [] },
            {
                chaId: "a",
                name: "A",
                image: "assets/a.png",
                emotionImages: [["happy", "assets/h.webp"]],
                additionalAssets: [["add", "assets/add.png", "png"]],
                firstMsgIndex: 2,
                postHistoryInstructions: "PHI",
                chatPage: 1,
                ttsMode: "none",
                globalLore: [{ key: "k", content: "<char> said @@end", bookVersion: 1, activationPercent: 50 }],
                chats: [
                    {
                        id: "chat-one",
                        name: "c1",
                        note: "n1",
                        bindedPersona: "p-a",
                        bindingReview: true,
                        useLocallySetGlobalVariables: false,
                        GLGlobalVariables: { toggle_x: "", toggle_y: "1", other: "" },
                        message: [
                            msg("user", "hi {{inlay::img1}}", { chatId: "dup" }),
                            msg("char", "yo {{inlayed::img2}}", { chatId: "dup", saying: "b" }),
                            msg("char", "third"),
                        ],
                    },
                    {
                        name: "c2",
                        bindedPersona: "gone",
                        scriptstate: { stale: true },
                        message: [msg("user", COLD + K.chatArray)],
                    },
                ],
            },
            {
                chaId: "b",
                name: "B",
                type: "character",
                image: "assets/b.png",
                coldstorage: K.character,
                coldStoragedChats: [],
                chats: [{ message: [msg("char", "")], note: "", name: "", localLore: [] }],
            },
            { chaId: "a", name: "Adup", chats: [] },
            {
                chaId: "g",
                name: "G",
                type: "group",
                characters: ["a", "b", "zz"],
                characterTalks: [1, 2, 3],
                characterActive: [true, false, true],
                chats: [{ message: [msg("char", "group talk", { saying: "a" })] }],
            },
            {
                chaId: "m",
                name: "Missing",
                image: "assets/m.png",
                coldstorage: K.absent,
                chats: [{ message: [msg("char", "")] }],
            },
        ],
        characterOrder: [
            "a",
            "zz",
            { id: "f", name: "F", data: ["b", "nope"], color: "", img: "assets/f.png" },
            "g",
            5,
        ],
        modules: [
            {
                id: "mod1",
                name: "M1",
                namespace: "ns",
                icon: "assets/mod.png",
                lorebook: [{ content: "<char>", bookVersion: 1 }],
            },
            null,
            3,
            { name: "NoId", description: "gets an id" },
            { name: "Bad", lorebook: 5 },
        ],
        enabledModules: ["mod1", "ns", "gone", 7],
        plugins: [{ name: "p3", version: "3.0", script: "" }, { name: "p2", version: "2.0", script: "" }, "nope"],
        pluginCustomStorage: {
            legacyKey: "legacy",
            _coldplugin: { plugA: K.plugin, plugB: K.pluginAbsent, plugC: 9 },
        },
    };
}

function cold(): Map<string, ColdRecordResult> {
    return new Map<string, ColdRecordResult>([
        [K.chatArray, ok([msg("user", "restored one"), msg("char", "restored two")])],
        [
            K.character,
            ok({
                character: {
                    chaId: "b",
                    name: "B",
                    desc: "whole",
                    image: "assets/b.png",
                    chats: [{ id: "bc", name: "bc", message: [msg("char", "b says")] }],
                },
            }),
        ],
        [K.plugin, ok(["v"])],
    ]);
}

describe("convertUpstreamDatabase: characters", () => {
    it("drops null and §temp entries, keeps the rest in upstream order, and counts them", () => {
        const out = convert(fixture(), { cold: cold() });
        expect(out.characters.map((character) => character.data.name)).toEqual(["A", "B", "Adup", "G", "Missing"]);
        expect(excluded(out, "temporary-character")).toEqual({
            code: "temporary-character",
            count: 1,
            examples: ["tmp"],
        });
        expect(excluded(out, "invalid-character")).toBeUndefined();
        expect(out.report.counts).toMatchObject({
            characters: 4,
            groups: 1,
            chats: 6,
            messages: 7,
            modules: 2,
            plugins: 2,
        });
        for (const character of out.characters) {
            expect(character.data.chaId).toBe(character.id);
            for (const field of ["chats", "chatPage", "coldstorage", "coldStoragedChats", "realmId", "reloadKeys"]) {
                expect(field in character.data, `${character.id}.${field}`).toBe(false);
            }
        }
    });

    it("gives a duplicate chaId a new id and keeps the first holder's", () => {
        const out = convert(fixture(), { cold: cold() });
        expect(characterNamed(out, "A").id).toBe("a");
        const dup = characterNamed(out, "Adup").id;
        expect(dup).not.toBe("a");
        expect(isValidResourceId(dup)).toBe(true);
        expect(new Set(out.characters.map((character) => character.id)).size).toBe(out.characters.length);
        expect(converted(out, "character-id-replaced")).toEqual({
            code: "character-id-replaced",
            count: 1,
            examples: ["Adup"],
        });
    });

    it("rewrites an invalid id held once in group members, message speakers, and characterOrder", () => {
        const out = convert({
            formatversion: 5,
            characters: [
                { chaId: "..", name: "Dots", chats: [] },
                {
                    chaId: "g",
                    name: "G",
                    type: "group",
                    characters: [".."],
                    characterTalks: [1],
                    characterActive: [true],
                    chats: [{ message: [msg("char", "x", { saying: ".." })] }],
                },
            ],
            characterOrder: ["..", { id: "f", name: "F", data: [".."] }],
        });
        const dots = characterNamed(out, "Dots").id;
        expect(isValidResourceId(dots)).toBe(true);
        expect(characterNamed(out, "G").data).toMatchObject({
            characters: [dots],
            characterTalks: [1],
            characterActive: [true],
        });
        expect(chatsOf(out, "g")[0].message[0].saying).toBe(dots);
        expect(record<unknown[]>(out, COLLECTION_KIND.characterOrder)).toEqual([
            dots,
            { id: "f", name: "F", data: [dots] },
        ]);
        expect(excluded(out, "group-member-missing")).toBeUndefined();
    });

    it("ports prepareNewCharacter: ttsMode, creation_date, globalLore upgrade, a first chat, fmIndex and localLore", () => {
        const out = convert(fixture(), { cold: cold() });
        const a = characterNamed(out, "A").data;
        expect(a.ttsMode).toBe("");
        expect(a.creation_date).toBe(1);
        expect(a.globalLore).toEqual([
            { key: "k", content: "@@probability 50\n{{char}} said @@depth 0", bookVersion: 2, activationPercent: null },
        ]);
        const [c1, c2] = chatsOf(out, "a");
        expect(c1.fmIndex).toBe(2);
        expect(c1.localLore).toEqual([]);
        expect(c2.fmIndex).toBe(2);
        const adup = chatsOf(out, characterNamed(out, "Adup").id);
        expect(adup).toHaveLength(1);
        expect(adup[0]).toMatchObject({ name: "Chat 1", note: "", localLore: [], fmIndex: -1, message: [] });
        expect(isValidResourceId(adup[0].id)).toBe(true);
    });

    it("moves postHistoryInstructions into the note of the chat at the original chatPage", () => {
        const out = convert(fixture(), { cold: cold() });
        const a = characterNamed(out, "A").data;
        expect(a.postHistoryInstructions).toBe("");
        const [c1, c2] = chatsOf(out, "a");
        expect(c1.note).toBe("n1");
        expect(c2.note).toBe("PHI");
        expect(converted(out, "post-history-instructions-to-note")).toEqual({
            code: "post-history-instructions-to-note",
            count: 1,
            examples: ["A"],
        });

        // The index is upstream's: a dropped earlier chat does not shift the target.
        const shifted = convert({
            formatversion: 5,
            characters: [
                {
                    chaId: "a",
                    name: "A",
                    postHistoryInstructions: "PHI",
                    chatPage: 2,
                    chats: [{ name: "c0", note: "n0", message: [] }, 5, { name: "c2", message: [] }],
                },
            ],
        });
        expect(chatsOf(shifted, "a").map((chat) => [chat.name, chat.note])).toEqual([
            ["c0", "n0"],
            ["c2", "PHI"],
        ]);
        expect(excluded(shifted, "invalid-chat")).toEqual({ code: "invalid-chat", count: 1, examples: ["A"] });
    });

    it("repairs old image paths only for a database without formatversion", () => {
        const character = {
            chaId: "a",
            name: "A",
            image: "C:\\risu\\assets\\x.png",
            emotionImages: [["happy", "D:\\assets\\h.png"]],
            chats: [],
        };
        const old = characterNamed(convert({ characters: [character] }), "A").data;
        expect(old.image).toBe("assets/x.png");
        expect(old.emotionImages).toEqual([["happy", "assets/h.png"]]);
        const current = characterNamed(convert({ formatversion: 5, characters: [character] }), "A").data;
        expect(current.image).toBe("C:\\risu\\assets\\x.png");
    });

    it("removes group members that name no kept character with their talk and active entries", () => {
        const out = convert(fixture(), { cold: cold() });
        expect(characterNamed(out, "G").data).toMatchObject({
            type: "group",
            characters: ["a", "b"],
            characterTalks: [1, 2],
            characterActive: [true, false],
        });
        expect(excluded(out, "group-member-missing")).toEqual({
            code: "group-member-missing",
            count: 1,
            examples: ["G"],
        });
        // A non-list `characters` is reset instead of refusing the group.
        const reset = convert({
            formatversion: 5,
            characters: [{ chaId: "g", name: "G", type: "group", characters: "a", chats: [] }],
        });
        expect(characterNamed(reset, "G").data).toMatchObject({
            characters: [],
            characterTalks: [],
            characterActive: [],
        });
        expect(excluded(reset, "invalid-data")?.examples).toEqual(["G"]);
    });

    it("drops a character the store refuses, with its chats, and a non-object entry", () => {
        const out = convert({
            formatversion: 5,
            characters: [
                { chaId: "a", name: "Deep", desc: deep(300), chats: [{ message: [] }] },
                7,
                { chaId: "b", name: "B" },
            ],
        });
        expect(out.characters.map((character) => character.data.name)).toEqual(["B"]);
        expect(out.chats.map((group) => group.characterId)).toEqual(["b"]);
        expect(excluded(out, "invalid-character")).toEqual({
            code: "invalid-character",
            count: 2,
            examples: ["Deep", "characters[1]"],
        });
    });
});

describe("convertUpstreamDatabase: cold storage", () => {
    it("restores a cold character from its payload when the chaId matches", () => {
        const out = convert(fixture(), { cold: cold() });
        const b = characterNamed(out, "B");
        expect(b.id).toBe("b");
        expect(b.data.desc).toBe("whole");
        expect(chatsOf(out, "b").map((chat) => [chat.id, chat.message.map((message) => message.data)])).toEqual([
            ["bc", ["b says"]],
        ]);
        expect(converted(out, "cold-character-restored")).toEqual({
            code: "cold-character-restored",
            count: 1,
            examples: ["B"],
        });
    });

    it("restores a cold chat from a list payload and from an object payload, unsetting fields the object lacks", () => {
        const db = fixture();
        const chats = (db.characters as Dict[])[2].chats as Dict[];
        chats.push({
            name: "c3",
            hypaV3Data: { stale: true },
            message: [msg("user", COLD + K.chatObject)],
        });
        const payloads = cold();
        payloads.set(
            K.chatObject,
            ok({
                message: [msg("char", "object restored")],
                hypaV2Data: { chunks: [] },
                scriptstate: { s: 1 },
                localLore: [{ content: "lore", bookVersion: 2 }],
            }),
        );
        const out = convert(db, { cold: payloads });
        const [, c2, c3] = chatsOf(out, "a");
        expect(c2.message.map((message) => message.data)).toEqual(["restored one", "restored two"]);
        expect(c2.scriptstate).toEqual({ stale: true });
        expect(c3.message.map((message) => message.data)).toEqual(["object restored"]);
        expect(c3).toMatchObject({
            hypaV2Data: { chunks: [] },
            scriptstate: { s: 1 },
            localLore: [{ content: "lore", bookVersion: 2 }],
        });
        expect("hypaV3Data" in c3).toBe(false);
        expect(converted(out, "cold-chat-restored")).toEqual({ code: "cold-chat-restored", count: 2, examples: ["A"] });
        for (const chat of [c2, c3]) {
            for (const message of chat.message) {
                expect(isValidResourceId(message.chatId)).toBe(true);
            }
        }
    });

    it("keeps the stub (name, image, one empty chat) when the payload is absent, unreadable, mismatched, or refused", () => {
        const payloads = cold();
        payloads.set(K.absent, { ok: false, reason: "invalidJson" });
        const db = fixture();
        (db.characters as unknown[]).push(
            { chaId: "x", name: "Mismatch", image: "assets/x.png", coldstorage: K.chatArray, chats: [] },
            { chaId: "y", name: "Refused", coldstorage: "refused-key", chats: [] },
        );
        payloads.set("refused-key", ok({ character: { chaId: "y", name: "Refused", desc: deep(300) } }));
        const out = convert(db, { cold: payloads });
        const stubs: [string, string, string | undefined][] = [
            ["m", "Missing", "assets/m.png"],
            ["x", "Mismatch", "assets/x.png"],
            ["y", "Refused", undefined],
        ];
        for (const [id, name, image] of stubs) {
            const stub = characterNamed(out, name);
            expect(stub.id).toBe(id);
            expect(stub.data.image).toBe(image);
            expect(stub.data.desc).toBe("");
            expect(chatsOf(out, id).map((chat) => [chat.name, chat.message.length])).toEqual([["Chat 1", 0]]);
        }
        expect(excluded(out, "cold-missing")).toEqual({
            code: "cold-missing",
            count: 5,
            examples: ["Missing", "Mismatch", "Refused", "plugB", "plugC"],
        });
        expect(converted(out, "cold-character-restored")?.examples).toEqual(["B"]);

        // A cold chat without a payload keeps its metadata and no messages.
        const chatOnly = convert(fixture());
        const [, c2] = chatsOf(chatOnly, "a");
        expect(c2.name).toBe("c2");
        expect(c2.message).toEqual([]);
        expect(excluded(chatOnly, "cold-missing")?.count).toBe(6);
        expect(converted(chatOnly, "cold-chat-restored")).toBeUndefined();
    });

    it("folds _coldplugin values into _pluginStorage and reports the pointers without a payload", () => {
        const out = convert(fixture(), { cold: cold() });
        const storage = record<Dict>(out, RESOURCE_KIND.pluginStorage);
        expect(storage).toEqual({ legacyKey: "legacy", _pluginStorage: { legacyKey: "legacy", plugA: ["v"] } });
        expect(converted(out, "cold-plugin-storage-restored")).toEqual({
            code: "cold-plugin-storage-restored",
            count: 1,
            examples: ["plugA"],
        });
        expect(converted(out, "legacy-plugin-storage")).toEqual({
            code: "legacy-plugin-storage",
            count: 1,
            examples: ["legacyKey"],
        });
        expect(excluded(out, "cold-missing")?.examples).toContain("plugB");
        expect(excluded(out, "cold-missing")?.examples).toContain("plugC");
    });
});

describe("convertUpstreamDatabase: chats and messages", () => {
    it("binds every chat to the converted selection and keeps bindedPersona only when it names a persona", () => {
        const out = convert(fixture(), { cold: cold() });
        expect(out.selection).toEqual({
            promptPresetId: expect.any(String),
            modelPresetId: expect.any(String),
            personaId: "p-b",
        });
        const [c1, c2] = chatsOf(out, "a");
        expect(c1).toMatchObject({
            promptPresetId: out.selection.promptPresetId,
            modelPresetId: out.selection.modelPresetId,
            bindedPersona: "p-a",
        });
        expect("bindingReview" in c1).toBe(false);
        expect(c2.bindedPersona).toBe("p-b");
        for (const group of out.chats) {
            const chat = (group.ops[0] as unknown as { chat: Dict }).chat;
            expect(chat.promptPresetId).toBe(out.selection.promptPresetId);
            expect(chat.modelPresetId).toBe(out.selection.modelPresetId);
            expect(typeof chat.bindedPersona).toBe("string");
        }
    });

    it("keeps GLGlobalVariables without its empty toggle_* values and drops the local flag", () => {
        const [c1] = chatsOf(convert(fixture(), { cold: cold() }), "a");
        expect(c1.GLGlobalVariables).toEqual({ toggle_y: "1", other: "" });
        expect("useLocallySetGlobalVariables" in c1).toBe(false);
    });

    it("keeps a valid unique chat id and assigns the others; message chatIds likewise within a chat", () => {
        const db = fixture();
        const chats = (db.characters as Dict[])[2].chats as Dict[];
        chats.push({ id: "chat-one", name: "dup-id", message: [] }, { id: "..", name: "bad-id", message: [] });
        const out = convert(db, { cold: cold() });
        const [c1, c2, c3, c4] = chatsOf(out, "a");
        expect(c1.id).toBe("chat-one");
        expect(c3.id).not.toBe("chat-one");
        expect(isValidResourceId(c2.id) && isValidResourceId(c3.id) && isValidResourceId(c4.id)).toBe(true);
        expect(new Set([c1.id, c2.id, c3.id, c4.id]).size).toBe(4);
        const ids = c1.message.map((message) => message.chatId as string);
        expect(ids[0]).toBe("dup");
        expect(ids[1]).not.toBe("dup");
        expect(ids.every(isValidResourceId)).toBe(true);
        expect(new Set(ids).size).toBe(3);
        expect(c1.message[1].saying).toBe("b");
        expect(c1.message.map((message) => message.data)).toEqual([
            "hi {{inlay::img1}}",
            "yo {{inlayed::img2}}",
            "third",
        ]);
    });

    it("leaves out a message or chat the store would refuse and resets a field of the wrong kind", () => {
        const out = convert({
            formatversion: 5,
            characters: [
                {
                    chaId: "a",
                    name: "A",
                    chats: [
                        {
                            name: 7,
                            note: ["x"],
                            localLore: "lore",
                            fmIndex: "3",
                            toolCalls: { bad: 1 },
                            message: [
                                msg("user", "keep"),
                                { role: "system", data: "dropped" },
                                { role: "user", data: 5 },
                                { role: "char", data: null },
                                "text",
                                { role: "char", data: "bigint", extra: 10n },
                            ],
                        },
                        { name: "empty", message: null },
                        { name: "not-a-list", message: "x" },
                    ],
                },
            ],
        });
        const [c0, c1, c2] = chatsOf(out, "a");
        expect(c0).toMatchObject({ name: "", note: "", localLore: [], fmIndex: -1 });
        expect("toolCalls" in c0).toBe(false);
        expect(c0.message.map((message) => message.data)).toEqual(["keep", ""]);
        expect(c1.message).toEqual([]);
        expect(c2.message).toEqual([]);
        expect(excluded(out, "invalid-data")).toEqual({ code: "invalid-data", count: 10, examples: ["A"] });
        expect(excluded(out, "invalid-chat")).toBeUndefined();
    });

    it("counts a chat showing a complete inlay reference once", () => {
        const out = convert(fixture(), { cold: cold() });
        expect(excluded(out, "inlays-not-in-backup")).toEqual({
            code: "inlays-not-in-backup",
            count: 1,
            examples: ["A"],
        });
        const partial = convert({
            formatversion: 5,
            characters: [
                {
                    chaId: "a",
                    name: "A",
                    chats: [{ message: [msg("user", "{{inlay::"), msg("char", "{{inlayeddata::z}}")] }],
                },
            ],
        });
        expect(excluded(partial, "inlays-not-in-backup")?.count).toBe(1);
        const none = convert({
            formatversion: 5,
            characters: [{ chaId: "a", name: "A", chats: [{ message: [msg("user", "{{inlay:: x")] }] }],
        });
        expect(excluded(none, "inlays-not-in-backup")).toBeUndefined();
    });
});

describe("convertUpstreamDatabase: collections, modules, plugins", () => {
    it("keeps only kept characters' ids in characterOrder, folders included, and reports other entries", () => {
        const out = convert(fixture(), { cold: cold() });
        expect(record<unknown[]>(out, COLLECTION_KIND.characterOrder)).toEqual([
            "a",
            { id: "f", name: "F", data: ["b"], color: "", img: "assets/f.png" },
            "g",
        ]);
        expect(excluded(out, "invalid-setting")?.examples).toContain("characterOrder[4]");
        expect(
            record<unknown[]>(convert({ formatversion: 5, characterOrder: "a" }), COLLECTION_KIND.characterOrder),
        ).toEqual([]);
    });

    it("drops a failing module, assigns a missing id, upgrades module lorebooks, and keeps enabledModules by id or namespace", () => {
        const out = convert(fixture(), { cold: cold() });
        const modules = record<Dict[]>(out, RESOURCE_KIND.modules);
        expect(modules.map((module) => module.name)).toEqual(["M1", "NoId"]);
        expect(modules[0].lorebook).toEqual([{ content: "{{char}}", bookVersion: 2 }]);
        expect(isValidResourceId(modules[1].id)).toBe(true);
        expect(excluded(out, "invalid-module")).toEqual({
            code: "invalid-module",
            count: 2,
            examples: ["modules[2]", "Bad"],
        });
        expect(record<string[]>(out, COLLECTION_KIND.enabledModules)).toEqual(["mod1", "ns"]);
        expect(excluded(out, "module-reference-missing")).toEqual({
            code: "module-reference-missing",
            count: 2,
            examples: ["gone", "enabledModules[3]"],
        });
    });

    it("keeps plugins as stored, reports unsupported versions and the device storage once", () => {
        const out = convert(fixture(), { cold: cold() });
        expect(record<Dict[]>(out, RESOURCE_KIND.plugins).map((plugin) => plugin.name)).toEqual(["p3", "p2"]);
        expect(excluded(out, "plugin-unsupported-version")).toEqual({
            code: "plugin-unsupported-version",
            count: 1,
            examples: ["p2"],
        });
        expect(excluded(out, "invalid-plugin")).toEqual({ code: "invalid-plugin", count: 1, examples: ["plugins[2]"] });
        expect(excluded(out, "plugin-device-storage")).toEqual({
            code: "plugin-device-storage",
            count: 1,
            examples: [],
        });
        const none = convert({ formatversion: 5, plugins: [] });
        expect(record<unknown[]>(none, RESOURCE_KIND.plugins)).toEqual([]);
        expect(excluded(none, "plugin-device-storage")).toBeUndefined();
        expect(none.resources.some((resource) => resource.kind === RESOURCE_KIND.pluginStorage)).toBe(false);
    });

    it("does not copy top-level values into _pluginStorage when the file already has one (a metatron backup)", () => {
        const out = convert({
            formatversion: 5,
            pluginCustomStorage: { custom: 1, _pluginStorage: { v3: "x" }, _safeLocalPluginStorage: { s: 1 } },
        });
        expect(record<Dict>(out, RESOURCE_KIND.pluginStorage)).toEqual({
            custom: 1,
            _pluginStorage: { v3: "x" },
            _safeLocalPluginStorage: { s: 1 },
        });
        expect(converted(out, "legacy-plugin-storage")).toBeUndefined();
        // An upstream file: the SafeLocal key is metatron's and is not copied; an array dictionary is read as the client does.
        const legacy = convert({
            formatversion: 5,
            pluginCustomStorage: { custom: 1, _safeLocalPluginStorage: { s: 1 } },
        });
        expect(record<Dict>(legacy, RESOURCE_KIND.pluginStorage)._pluginStorage).toEqual({ custom: 1 });
        const list = convert(
            { formatversion: 5, pluginCustomStorage: { _pluginStorage: ["z"], _coldplugin: { k: K.plugin } } },
            { cold: cold() },
        );
        expect(record<Dict>(list, RESOURCE_KIND.pluginStorage)._pluginStorage).toEqual({ "0": "z", k: ["v"] });
    });
});

describe("convertUpstreamDatabase: assets", () => {
    it("reports referenced keys the archive lacks by first user and role, non-png as expected", () => {
        const out = convert(fixture(), {
            cold: cold(),
            assetKeys: new Set(["assets/a.png", "assets/b.png", "assets/f.png"]),
        });
        // In the export walker's order (`collectUpstreamAssetReferences`): characters first.
        expect(out.report.missingAssets).toEqual([
            { key: "assets/h.webp", owner: "A", role: "emotion", expected: true },
            { key: "assets/add.png", owner: "A", role: "additional", expected: false },
            { key: "assets/m.png", owner: "Missing", role: "profile", expected: false },
            { key: "assets/pb.png", owner: "B", role: "persona", expected: false },
            { key: "assets/mod.png", owner: "M1", role: "moduleIcon", expected: false },
        ]);
        // No inventory: no classification. An empty inventory: everything is missing, one entry per key.
        expect(convert(fixture(), { cold: cold() }).report.missingAssets).toEqual([]);
        const shared = convert(
            {
                formatversion: 5,
                characters: [
                    { chaId: "a", name: "A", image: "assets/same.png", chats: [] },
                    { chaId: "b", name: "B", image: "assets/same.png", chats: [] },
                ],
            },
            { assetKeys: new Set() },
        );
        expect(shared.report.missingAssets).toEqual([
            { key: "assets/same.png", owner: "A", role: "profile", expected: false },
        ]);
    });
});

describe("convertUpstreamDatabase: recovery of malformed input", () => {
    it("reports one repair per invalid message and keeps the valid ones around them", () => {
        const out = convert({
            formatversion: 5,
            characters: [{ chaId: "a", name: "A", chats: [{ message: [null, msg("user", "kept"), null, null] }] }],
        });
        expect(chatsOf(out, "a")[0].message.map((message) => message.data)).toEqual(["kept"]);
        expect(excluded(out, "invalid-data")).toEqual({ code: "invalid-data", count: 3, examples: ["A"] });
    });

    // The cardinality is the subject: a report that spreads its entries into one call overflows the
    // stack well before this count. Slow, like the other production-scale fixtures.
    it(
        "reports every repair of a chat with very many invalid messages instead of overflowing",
        { tags: ["slow"] },
        () => {
            const out = convert({
                formatversion: 5,
                characters: [
                    { chaId: "a", name: "A", chats: [{ message: Array.from({ length: 150_000 }, () => null) }] },
                ],
            });
            expect(chatsOf(out, "a")[0].message).toEqual([]);
            expect(excluded(out, "invalid-data")?.count).toBe(150_000);
        },
    );

    it("resets tool calls the store cannot serialize and keeps the chat, also inside a cold payload", () => {
        const toolCalls = (arg: unknown) => ({ t1: { call: { id: "t1", name: "fn", arg }, response: [] } });
        for (const arg of [deep(20_000), 10n]) {
            const out = convert({
                formatversion: 5,
                characters: [
                    {
                        chaId: "a",
                        name: "A",
                        chats: [{ id: "c", message: [msg("user", "hi")], toolCalls: toolCalls(arg) }],
                    },
                ],
            });
            const [chat] = chatsOf(out, "a");
            expect(chat.id).toBe("c");
            expect("toolCalls" in chat).toBe(false);
            expect(chat.message).toHaveLength(1);
            expect(excluded(out, "invalid-data")?.count).toBe(1);
        }
        const kept = convert({
            formatversion: 5,
            characters: [{ chaId: "a", name: "A", chats: [{ id: "c", message: [], toolCalls: toolCalls({ q: 1 }) }] }],
        });
        expect(chatsOf(kept, "a")[0].toolCalls).toEqual(toolCalls({ q: 1 }));
        expect(excluded(kept, "invalid-data")).toBeUndefined();

        const cold = convert(
            {
                formatversion: 5,
                characters: [{ chaId: "b", name: "B", coldstorage: "k", chats: [{ message: [msg("char", "")] }] }],
            },
            {
                cold: new Map([
                    [
                        "k",
                        ok({
                            character: {
                                chaId: "b",
                                name: "B",
                                chats: [{ message: [msg("user", "hi")], toolCalls: toolCalls(10n) }],
                            },
                        }),
                    ],
                ]),
            },
        );
        expect(converted(cold, "cold-character-restored")?.count).toBe(1);
        expect(chatsOf(cold, "b")[0].message).toHaveLength(1);
    });

    it("removes a lorebook percentage that cannot be converted and keeps the lore, for characters and modules", () => {
        const bad = { content: "Keep this lore", activationPercent: { toString: null, valueOf: null } };
        const fine = { content: "Fine", activationPercent: 30 };
        const none = { content: "None", activationPercent: null };
        const out = convert({
            formatversion: 5,
            characters: [{ chaId: "a", name: "A", globalLore: [bad, fine, none], chats: [] }],
            modules: [{ id: "m", name: "M", lorebook: [bad] }],
        });
        const lore = characterNamed(out, "A").data.globalLore as Dict[];
        expect(lore.map((entry) => entry.content)).toEqual(["Keep this lore", "@@probability 30\nFine", "None"]);
        expect("activationPercent" in lore[0]).toBe(false);
        expect(record<Dict[]>(out, RESOURCE_KIND.modules)[0].lorebook).toEqual([
            { content: "Keep this lore", bookVersion: 2 },
        ]);
        expect(excluded(out, "invalid-data")).toEqual({ code: "invalid-data", count: 2, examples: ["M", "A"] });
    });

    it("recovers plugin storage per key inside its real envelope and reports only retained values", () => {
        const damaged = convert({
            formatversion: 5,
            pluginCustomStorage: { _pluginStorage: { safe: "keep", bad: deep(260) }, custom: "keep" },
        });
        expect(record<Dict>(damaged, RESOURCE_KIND.pluginStorage)).toEqual({
            custom: "keep",
            _pluginStorage: { safe: "keep" },
        });
        expect(converted(damaged, "legacy-plugin-storage")).toBeUndefined();
        expect(excluded(damaged, "invalid-setting")?.examples).toEqual(["pluginCustomStorage._pluginStorage.bad"]);

        const legacy = convert({ formatversion: 5, pluginCustomStorage: { safe: "keep", edge: deep(254) } });
        expect(record<Dict>(legacy, RESOURCE_KIND.pluginStorage)).toEqual({
            safe: "keep",
            edge: deep(254),
            _pluginStorage: { safe: "keep" },
        });
        expect(converted(legacy, "legacy-plugin-storage")).toEqual({
            code: "legacy-plugin-storage",
            count: 1,
            examples: ["safe"],
        });

        const coldDeep = convert(
            { formatversion: 5, pluginCustomStorage: { _coldplugin: { k: "c1" }, custom: "keep" } },
            { cold: new Map([["c1", ok(deep(254))]]) },
        );
        expect(record<Dict>(coldDeep, RESOURCE_KIND.pluginStorage)).toEqual({
            custom: "keep",
            _pluginStorage: { custom: "keep" },
        });
        expect(converted(coldDeep, "cold-plugin-storage-restored")).toBeUndefined();
        expect(excluded(coldDeep, "invalid-setting")?.examples).toEqual(["pluginCustomStorage._coldplugin.k"]);
    });

    it("leaves out only the message at the list's depth limit and keeps the chat", () => {
        for (const levels of [254, 255]) {
            const out = convert({
                formatversion: 5,
                characters: [
                    {
                        chaId: "a",
                        name: "A",
                        chats: [
                            {
                                id: "c-orig",
                                name: "orig",
                                message: [msg("user", "plain"), msg("char", "deep", { extra: deep(levels) })],
                            },
                        ],
                    },
                ],
            });
            const [chat] = chatsOf(out, "a");
            expect(chat.id, String(levels)).toBe("c-orig");
            expect(chat.message.map((message) => message.data)).toEqual(["plain"]);
            expect(excluded(out, "invalid-data")?.count).toBe(1);
            expect(excluded(out, "invalid-chat")).toBeUndefined();
        }
    });

    it("reports a JSON-copy repair of a plugin, a folder, a character, and a message", () => {
        const out = convert({
            formatversion: 5,
            characters: [
                {
                    chaId: "a",
                    name: "A",
                    extra: Infinity,
                    chats: [{ message: [msg("user", "x", { time: Infinity })] }],
                },
            ],
            plugins: [{ name: "p", version: "3.0", extra: Infinity }],
            characterOrder: [{ id: "f", name: "F", data: ["a"], extra: Infinity }],
        });
        expect(record<Dict[]>(out, RESOURCE_KIND.plugins)[0].extra).toBeNull();
        expect(record<Dict[]>(out, COLLECTION_KIND.characterOrder)[0].extra).toBeNull();
        expect(characterNamed(out, "A").data.extra).toBeNull();
        expect(chatsOf(out, "a")[0].message[0].time).toBeNull();
        expect(excluded(out, "invalid-data")).toEqual({
            code: "invalid-data",
            count: 4,
            examples: ["A", "characterOrder[0]", "p"],
        });
    });

    it("does not mutate the database or the cold payloads", () => {
        const db = fixture();
        const payloads = cold();
        const before = JSON.stringify(db);
        const beforeCold = JSON.stringify([...payloads]);
        convert(db, { cold: payloads, assetKeys: new Set() });
        expect(JSON.stringify(db)).toBe(before);
        expect(JSON.stringify([...payloads])).toBe(beforeCold);
    });
});

describe("convertUpstreamDatabase: the staged store (the import's hand-off)", () => {
    it("writes into a fresh store in the documented order; backupTo's copy passes readSnapshot with upstream's chat orders", async () => {
        const report = createUpstreamImportReport();
        const out = convert(fixture(), { cold: cold(), report, assetKeys: new Set(["assets/a.png"]) });
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-upstream-s4-"));
        const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds });
        try {
            for (const resource of out.resources) {
                const kind = kinds.get(resource.kind)!;
                const current = store.get(kind, resource.id);
                const materialized = ![
                    RESOURCE_KIND.modules,
                    RESOURCE_KIND.plugins,
                    RESOURCE_KIND.pluginStorage,
                ].includes(resource.kind as never);
                expect(current !== null, resource.kind).toBe(materialized);
                store.put(kind, resource.id, resource.data, current?.revision ?? null);
                expect(store.get(kind, resource.id)!.data, resource.kind).toEqual(resource.data);
            }
            const characters = kinds.get(RESOURCE_KIND.characters)!;
            for (const character of out.characters) {
                store.put(characters, character.id, character.data, null);
                expect(store.get(characters, character.id)!.data).toEqual(character.data);
            }
            // Sequential batches, in array order: here two of them.
            const half = Math.ceil(out.chats.length / 2);
            const results = [
                ...store.applyChanges({ chats: out.chats.slice(0, half) }).chats,
                ...store.applyChanges({ chats: out.chats.slice(half) }).chats,
            ];
            expect(results.map((result) => result.id)).toEqual(out.chats.map((group) => group.chatId));
            // The store renamed no message: every sent id was kept.
            results.forEach((result, index) => {
                const sent = (out.chats[index].ops[0] as { chat: { message: { chatId: string }[] } }).chat.message;
                expect(result.messageIds).toEqual(sent.map((message) => message.chatId));
            });

            const copy = path.join(dir, "copy.sqlite");
            await store.backupTo(copy);
            const snapshot = store.readSnapshot(copy);
            const ids = new Set(out.characters.map((character) => character.id));
            expect(snapshot.chats).toHaveLength(report.counts.chats);
            expect(snapshot.messages).toHaveLength(report.counts.messages);
            for (const chat of snapshot.chats) {
                expect(ids.has(chat.characterId), chat.id).toBe(true);
                expect(JSON.parse(chat.meta)).toMatchObject({
                    id: chat.id,
                    promptPresetId: out.selection.promptPresetId,
                    modelPresetId: out.selection.modelPresetId,
                });
            }
            const orders = new Map(
                snapshot.chatOrders.map((order) => [order.characterId, JSON.parse(order.ids) as string[]]),
            );
            expect([...orders.keys()].sort()).toEqual([...ids].sort());
            for (const id of ids) {
                expect(orders.get(id), id).toEqual(
                    out.chats.filter((group) => group.characterId === id).map((group) => group.chatId),
                );
            }
            expect(orders.get("a")).toEqual(["chat-one", chatsOf(out, "a")[1].id]);
            expect(snapshot.rows.filter((row) => row.kind === RESOURCE_KIND.characters)).toHaveLength(
                out.characters.length,
            );
        } finally {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
