// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
    CharacterShapeError,
    defaultSdData,
    inlayScreenGenData,
    normalizeCharacter,
} from "../../../shared/characters.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore, ResourceValidationError } from "../data/resourceStore.ts";

// Phase 6 slice 5b (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/character-ownership.md`,
// "5b as built", "Validation": the character normalizer tests): the shared pure helper
// (`normalizeCharacter`: purity, fresh mutable defaults, supplied values and unknown or prototype-named
// keys kept, `null` filled in its position, a byte-stable second pass, both character types, every
// inlay mode, the group repair and the non-list refusal), the server's `characters` normalizer on a
// write (and its refusal), and the startup pass rewriting a stored character once, then nothing.

const SINGLE_DEFAULTS = [
    "desc",
    "bias",
    "sdData",
    "utilityBot",
    "triggerscript",
    "alternateGreetings",
    "exampleMessage",
    "creatorNotes",
    "systemPrompt",
    "tags",
    "creator",
    "characterVersion",
    "personality",
    "scenario",
    "firstMsgIndex",
    "additionalData",
    "voicevoxConfig",
    "additionalText",
    "depth_prompt",
    "hfTTS",
    "backgroundHTML",
    "backgroundCSS",
    "ttsMode",
];

describe("normalizeCharacter", () => {
    it("fills every default of a single character in a fixed order after its own fields, and leaves the input unchanged", () => {
        const input = { chaId: "c", extra: { nested: [1] } };
        const before = structuredClone(input);
        const out = normalizeCharacter(input) as Record<string, unknown>;
        expect(input).toEqual(before);
        expect(out).not.toBe(input);
        expect(Object.keys(out)).toEqual([
            "chaId",
            "extra",
            "type",
            "name",
            "firstMessage",
            "globalLore",
            "customscript",
            "emotionImages",
            "viewScreen",
            ...SINGLE_DEFAULTS,
            "newGenData",
        ]);
        expect(out).toMatchObject({
            type: "character",
            name: "",
            firstMessage: "",
            globalLore: [],
            customscript: [],
            emotionImages: [],
            viewScreen: "none",
            desc: "",
            bias: [],
            sdData: defaultSdData(),
            utilityBot: false,
            firstMsgIndex: -1,
            additionalData: { tag: [], creator: "", character_version: "" },
            voicevoxConfig: { SPEED_SCALE: 1, PITCH_SCALE: 0, INTONATION_SCALE: 1, VOLUME_SCALE: 1 },
            depth_prompt: { depth: 0, prompt: "" },
            hfTTS: { model: "", language: "en" },
            ttsMode: "",
            newGenData: inlayScreenGenData("none", undefined),
        });
        // An unknown field is kept by reference (the helper is shallow).
        expect(out.extra).toBe(input.extra);
        // Never chats, chatPage, reloadKeys, or chaId.
        expect(out).not.toHaveProperty("chats");
        expect(out).not.toHaveProperty("chatPage");
        expect(out).not.toHaveProperty("reloadKeys");
        const local = { chats: [{ id: "k" }], chatPage: 3, reloadKeys: 2 };
        const withLocal = normalizeCharacter(local) as Record<string, unknown>;
        expect(withLocal.chats).toBe(local.chats);
        expect(withLocal.chatPage).toBe(3);
        expect(withLocal.reloadKeys).toBe(2);
        expect(withLocal).not.toHaveProperty("chaId");
    });

    it("allocates every mutable default fresh, the nested sdData rows included", () => {
        const a = normalizeCharacter({}) as Record<string, any>;
        const b = normalizeCharacter({}) as Record<string, any>;
        for (const field of Object.keys(a)) {
            if (typeof a[field] === "object" && a[field] !== null) {
                expect(a[field], field).not.toBe(b[field]);
            }
        }
        a.sdData[0][1] = "changed";
        a.additionalData.tag.push("t");
        expect(b.sdData[0][1]).toBe("solo, 1girl");
        expect(defaultSdData()[0][1]).toBe("solo, 1girl");
        expect(b.additionalData.tag).toEqual([]);
        expect((normalizeCharacter({}) as Record<string, unknown>).newGenData).toEqual(b.newGenData);
    });

    it("keeps every supplied value, falsy ones included, and fills a null field in its position", () => {
        const supplied = {
            chaId: "c",
            type: "character",
            name: "N",
            firstMessage: "",
            desc: "",
            utilityBot: true,
            firstMsgIndex: 0,
            bias: [["a", 1]],
            ttsMode: "none",
            tags: [],
            newGenData: { prompt: "mine", negative: "", instructions: "", emotionInstructions: "" },
            viewScreen: "emotion",
            inlayViewScreen: true,
        };
        const out = normalizeCharacter(supplied) as Record<string, unknown>;
        for (const [field, value] of Object.entries(supplied)) {
            expect(out[field], field).toBe(value);
        }
        // The helper maps no existing value: `"none"` stays (the creation maps it).
        expect(out.ttsMode).toBe("none");

        const nulls = { chaId: "c", desc: null, name: null, tail: 1 };
        const filled = normalizeCharacter(nulls) as Record<string, unknown>;
        expect(Object.keys(filled).slice(0, 4)).toEqual(["chaId", "desc", "name", "tail"]);
        expect(filled.desc).toBe("");
        expect(filled.name).toBe("");
        expect(nulls.desc).toBeNull();
    });

    it("keeps own prototype-named keys, at the top level and nested", () => {
        const input = JSON.parse('{"chaId":"c","__proto__":{"x":1},"constructor":2,"deep":{"__proto__":"n"}}');
        const out = normalizeCharacter(input) as Record<string, unknown>;
        expect(Object.hasOwn(out, "__proto__")).toBe(true);
        expect(Object.getOwnPropertyDescriptor(out, "__proto__")!.value).toEqual({ x: 1 });
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        expect(out.constructor).toBe(2);
        expect(Object.hasOwn(out.deep as object, "__proto__")).toBe(true);
        expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(normalizeCharacter(out))));
        expect(JSON.stringify(out)).toContain('"__proto__":{"x":1}');
    });

    it("is byte-stable on a second pass for both character types and every inlay mode", () => {
        const inputs: Record<string, unknown>[] = [
            {},
            { chaId: "c", desc: null, sdData: null },
            { type: "group", chaId: "g" },
            { type: "group", characters: ["a", "b"], characterTalks: [0.1], characterActive: "x" },
        ];
        for (const viewScreen of ["none", "emotion", "imggen", undefined]) {
            for (const inlayViewScreen of [true, false, undefined]) {
                inputs.push({ chaId: "c", viewScreen, inlayViewScreen });
            }
        }
        for (const input of inputs) {
            const once = normalizeCharacter(input);
            const twice = normalizeCharacter(once);
            expect(JSON.stringify(twice), JSON.stringify(input)).toBe(JSON.stringify(once));
            // Through JSON (what the server stores and the client sends) too.
            expect(JSON.stringify(normalizeCharacter(JSON.parse(JSON.stringify(once))))).toBe(JSON.stringify(once));
        }
    });

    it("gives newGenData the table of the view screen and its inlay mode, only when missing", () => {
        const modes = [
            ["emotion", true],
            ["emotion", false],
            ["imggen", true],
            ["imggen", false],
            ["none", true],
            ["none", false],
        ] as const;
        const tables = new Set<string>();
        for (const [viewScreen, inlayViewScreen] of modes) {
            const out = normalizeCharacter({ viewScreen, inlayViewScreen }) as Record<string, any>;
            expect(out.newGenData, `${viewScreen}/${inlayViewScreen}`).toEqual(
                inlayScreenGenData(viewScreen, inlayViewScreen),
            );
            tables.add(JSON.stringify(out.newGenData));
        }
        // Four distinct tables (emotion and imggen each with and without inlay) and the empty one.
        expect(tables.size).toBe(5);
        expect(inlayScreenGenData("emotion", true).emotionInstructions).toContain("at the end of a conversation");
        expect(inlayScreenGenData("emotion", false).emotionInstructions).not.toContain("at the end of a conversation");
        expect(inlayScreenGenData("imggen", true).instructions).toContain("<ImgGen=");
        expect(inlayScreenGenData("imggen", false).prompt).toBe("best quality, {{slot}}");
        expect(inlayScreenGenData("none", true)).toEqual({
            prompt: "",
            negative: "",
            instructions: "",
            emotionInstructions: "",
        });
        // A supplied table is kept even when it does not match the view screen.
        const own = { prompt: "p", negative: "", instructions: "", emotionInstructions: "" };
        expect((normalizeCharacter({ viewScreen: "imggen", newGenData: own }) as any).newGenData).toBe(own);
    });

    it("gives a group the shared fields only, defaults its members to [], and rebuilds companion arrays of the wrong shape", () => {
        const empty = normalizeCharacter({ type: "group", chaId: "g" }) as Record<string, unknown>;
        expect(empty).toEqual({
            type: "group",
            chaId: "g",
            name: "",
            firstMessage: "",
            globalLore: [],
            customscript: [],
            emotionImages: [],
            viewScreen: "none",
            characters: [],
            characterTalks: [],
            characterActive: [],
        });
        for (const field of SINGLE_DEFAULTS) {
            expect(empty, field).not.toHaveProperty(field);
        }
        expect(empty).not.toHaveProperty("newGenData");
        expect((normalizeCharacter({ type: "group", characters: null }) as any).characters).toEqual([]);

        // Lists of the members' length are kept as supplied (by reference).
        const kept = {
            type: "group",
            characters: ["a", "b"],
            characterTalks: [0.5, 1],
            characterActive: [false, true],
        };
        const keptOut = normalizeCharacter(kept) as any;
        expect(keptOut.characterTalks).toBe(kept.characterTalks);
        expect(keptOut.characterActive).toBe(kept.characterActive);

        // A wrong length or a non-list is rebuilt: every weight and flag reset, one per member.
        for (const [talks, active] of [
            [[0.5], [false]],
            [undefined, undefined],
            ["x", { 0: true }],
            [
                [0.5, 1, 1],
                [false, false, false],
            ],
        ]) {
            const out = normalizeCharacter({
                type: "group",
                characters: ["a", "b"],
                characterTalks: talks,
                characterActive: active,
            }) as any;
            expect(out.characterTalks, JSON.stringify(talks)).toEqual([(1 / 6) * 4, (1 / 6) * 4]);
            expect(out.characterActive, JSON.stringify(active)).toEqual([true, true]);
        }
    });

    it("refuses a group whose members are set but not a list, and leaves a character's own 'characters' alone", () => {
        for (const characters of ["a", { 0: "a" }, 1, true]) {
            expect(() => normalizeCharacter({ type: "group", characters }), JSON.stringify(characters)).toThrow(
                CharacterShapeError,
            );
        }
        expect((normalizeCharacter({ characters: "a" }) as any).characters).toBe("a");
    });
});

describe("the characters normalizer", () => {
    const kind = createKindRegistry(DEFAULT_RESOURCE_KINDS).get("characters")!;

    it("returns the helper's record for a valid character and refuses the shapes it cannot store", () => {
        const input = { chaId: "c", name: "C" };
        expect(kind.normalize(input, { id: "c" })).toEqual(normalizeCharacter(input));
        for (const [data, message] of [
            [{ chaId: "c", type: "group", characters: "a" }, "character: a group's characters must be a list"],
            [{ chaId: "other" }, "character.chaId must equal the resource id"],
            [{ chaId: "c", chats: [] }, "character must not hold chats"],
        ] as const) {
            expect(() => kind.normalize(data, { id: "c" }), message).toThrow(new ResourceValidationError(message));
        }
    });
});

describe("the store with the characters normalizer", () => {
    const stores: ResourceStore[] = [];
    const dirs: string[] = [];
    afterEach(() => {
        for (const store of stores.splice(0)) {
            store.close();
        }
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    const defaults = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const characters = defaults.get("characters")!;
    const open = (file: string, kinds = defaults) => {
        const store = createResourceStore({ file, kinds });
        stores.push(store);
        return store;
    };
    const tempFile = () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-characters-"));
        dirs.push(dir);
        return path.join(dir, "resources.sqlite");
    };
    const rawData = (file: string, id: string) => {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            return (
                db.prepare("SELECT data FROM resources WHERE kind = 'characters' AND id = ?").get(id) as {
                    data: string;
                }
            ).data;
        } finally {
            db.close();
        }
    };

    it("stores a partial character normalized, and refuses a group with non-list members without a write", () => {
        const store = open(tempFile());
        const put = store.put(characters, "c", { chaId: "c", name: "C", __extra: 1 }, null);
        expect(put.data).toEqual(normalizeCharacter({ chaId: "c", name: "C", __extra: 1 }));
        expect(store.get(characters, "c")!.data).toEqual(put.data);
        const writes = store.writeCount();
        expect(() => store.put(characters, "g", { chaId: "g", type: "group", characters: {} }, null)).toThrow(
            ResourceValidationError,
        );
        expect(store.writeCount()).toBe(writes);
        expect(store.get(characters, "g")).toBeNull();
    });

    it("rewrites a character stored without its defaults once at startup, then writes nothing", () => {
        const file = tempFile();
        // An older server stored characters as it got them.
        const passThrough: ResourceKind = { ...characters, normalize: (input) => input };
        const older = createKindRegistry(
            DEFAULT_RESOURCE_KINDS.map((kind) => (kind.name === "characters" ? passThrough : kind)),
        );
        const first = open(file, older);
        const raw = { chaId: "c", name: "C", desc: null, globalLore: [{ content: "<char>" }] };
        const token = first.put(passThrough, "c", raw, null).revision;
        const group = { chaId: "g", type: "group", characters: ["c"] };
        first.put(passThrough, "g", group, null);
        const normalizedAlready = normalizeCharacter({ chaId: "n", name: "N" });
        first.put(passThrough, "n", normalizedAlready, null);
        stores.pop()!.close();

        const store = open(file);
        expect(store.writeCount()).toBe(2);
        const c = store.get(characters, "c")!;
        expect(c.data).toEqual(normalizeCharacter(raw));
        // The lorebook keeps its content: the conversion is a creation step, not a default.
        expect((c.data as any).globalLore).toEqual([{ content: "<char>" }]);
        expect(c.revision).not.toBe(token);
        expect((store.get(characters, "g")!.data as any).characterTalks).toEqual([(1 / 6) * 4]);
        expect(rawData(file, "n")).toBe(JSON.stringify(normalizedAlready));
        const after = store.readKinds([characters]);
        stores.pop()!.close();

        const again = open(file);
        expect(again.writeCount()).toBe(0);
        expect(again.readKinds([characters])).toEqual(after);
    });
});
