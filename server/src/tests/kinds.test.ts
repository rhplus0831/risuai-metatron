// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import { DEFAULT_MODEL_PROFILE_ID, MODEL_PROFILE_DEFAULT_NAME, PRESET_DEFAULTS } from "../../../shared/presets.ts";
import type { botPreset } from "../../../shared/database.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import { ResourceValidationError } from "../data/resourceStore.ts";

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;
const recordKinds = ["presets", "modules", "plugins", "pluginStorage", "pluginPermissions", "characters", "inlays"];
/** The settings sections and collections: singletons the store materializes. */
const settingsKinds = [
    "providers",
    "secrets",
    "llmSecrets",
    "ui",
    "memoryTranslateMedia",
    "loreBook",
    "globalscript",
    "hotkeys",
    "characterOrder",
    "authRefreshes",
    "globalChatVariables",
    "personas",
    "translatorPresets",
    "hypaV3Presets",
    "togglePresets",
    "customModels",
    "credentials",
    "enabledModules",
    "statics",
    "modelPresets",
    "modelProfiles",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rejects = (name: string, id: string, input: unknown, message: string) => {
    expect(() => kind(name).normalize(input, { id }), `${name}: ${JSON.stringify(input)}`).toThrow(
        new ResourceValidationError(message),
    );
};
const accepts = (name: string, id: string, input: unknown) => {
    expect(kind(name).normalize(input, { id }), `${name}: ${JSON.stringify(input)}`).toBe(input);
};

describe("createKindRegistry", () => {
    it("holds the seven record kinds (no root), five of them singletons, and the 21 settings singletons (including credentials and togglePresets); presets and the settings kinds materialize", () => {
        expect([...kinds.keys()]).toEqual([...recordKinds, ...settingsKinds]);
        expect(kinds.has("root")).toBe(false);
        expect([...kinds.values()].filter((k) => k.singleton).map((k) => k.name)).toEqual([
            "presets",
            "modules",
            "plugins",
            "pluginStorage",
            "pluginPermissions",
            ...settingsKinds,
        ]);
        // `presets` materializes too (one default preset), so a selection always has a record.
        expect([...kinds.values()].filter((k) => k.materialize).map((k) => k.name)).toEqual([
            "presets",
            ...settingsKinds,
        ]);
        // `llmSecrets` is write-only, the only kind with a projection and a write rule.
        expect([...kinds.values()].filter((k) => k.project).map((k) => k.name)).toEqual(["llmSecrets"]);
        expect([...kinds.values()].filter((k) => k.prepareWrite).map((k) => k.name)).toEqual(["llmSecrets"]);
    });

    it("rejects invalid, reserved, and duplicate names and invalid schema versions", () => {
        const make = (name: string, schemaVersion = 1): ResourceKind => ({ name, schemaVersion, normalize: (i) => i });
        for (const name of ["", "1a", "a b", "a/b", "a".repeat(65), "batch", "read", "chat", "chatOrder"]) {
            expect(() => createKindRegistry([make(name)]), name).toThrow(`Invalid resource kind name: ${name}`);
        }
        expect(() => createKindRegistry([make("a"), make("a")])).toThrow("Duplicate resource kind: a");
        for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => createKindRegistry([make("a", version)]), String(version)).toThrow(
                "Invalid schema version for resource kind a",
            );
        }
        expect(createKindRegistry([make("a"), make("B-c_9")]).size).toBe(2);
    });
});

describe("default normalizers", () => {
    it("return the input unchanged when the minimum shape holds, except presets, which get the canonical schema, and characters, which get the shared defaults", () => {
        // `presets` returns `normalizePresets`' copy: every preset gets an id and the
        // canonical fields, and an empty list becomes one default preset.
        const presets = kind("presets").normalize([{ name: "p" }, {}], { id: "main" }) as botPreset[];
        const { name, temperature } = PRESET_DEFAULTS;
        expect(presets.map((p) => p.name)).toEqual(["p", name]);
        for (const preset of presets) {
            expect(preset.id).toMatch(UUID);
            expect(preset).toMatchObject({ temperature, formatingOrder: expect.any(Array) });
            // A prompt preset: the model fields live in `modelPresets`.
            expect(Object.hasOwn(preset, "maxContext")).toBe(false);
        }
        const modelPresets = kind("modelPresets").normalize([{ name: "m" }, {}], { id: "main" }) as Record<
            string,
            unknown
        >[];
        expect(modelPresets.map((p) => p.name)).toEqual(["m", "New Model Preset"]);
        for (const preset of modelPresets) {
            expect(preset.id).toMatch(UUID);
            // A model preset holds only the slot choices.
            expect(preset).toMatchObject({
                mainSlot: { profileId: DEFAULT_MODEL_PROFILE_ID },
                subSlot: { profileId: DEFAULT_MODEL_PROFILE_ID },
                auxSlots: {},
                seperateModelsForAxModels: false,
            });
            expect(Object.hasOwn(preset, "temperature")).toBe(false);
            expect(Object.hasOwn(preset, "maxContext")).toBe(false);
        }
        const modelProfiles = kind("modelProfiles").normalize([{ name: "p" }, {}], { id: "main" }) as Record<
            string,
            unknown
        >[];
        expect(modelProfiles.map((p) => p.name)).toEqual(["p", MODEL_PROFILE_DEFAULT_NAME]);
        for (const profile of modelProfiles) {
            expect(profile.id).toMatch(UUID);
            expect(profile).toMatchObject({ maxContext: PRESET_DEFAULTS.maxContext, modelId: PRESET_DEFAULTS.modelId });
            expect(Object.hasOwn(profile, "temperature")).toBe(false);
            expect(Object.hasOwn(profile, "mainSlot")).toBe(false);
        }
        expect(kind("modelProfiles").normalize([], { id: "main" })).toMatchObject([
            { id: DEFAULT_MODEL_PROFILE_ID, name: MODEL_PROFILE_DEFAULT_NAME },
        ]);
        expect(kind("presets").normalize([], { id: "main" })).toMatchObject([
            { id: expect.stringMatching(UUID), name, temperature },
        ]);
        accepts("modules", "main", [{ id: "m" }]);
        accepts("plugins", "main", [{ name: "p" }]);
        accepts("pluginStorage", "main", {});
        accepts("pluginStorage", "main", { _safeLocalPluginStorage: { a: 1 } });
        accepts("pluginPermissions", "main", { grants: {}, lastGrantTime: {} });
        accepts("pluginPermissions", "main", { grants: { h_db: true }, lastGrantTime: { p_db_lastGrantTime: 1 } });
        // `characters` returns a copy with the shared defaults (`normalizeCharacter`);
        // the input is not changed.
        for (const [id, input] of [
            ["c1", { chaId: "c1" }],
            ["§playground", { chaId: "§playground", name: "n", chatPage: 0 }],
        ] as const) {
            const before = structuredClone(input);
            expect(kind("characters").normalize(input, { id }), id).toEqual(normalizeCharacter(input));
            expect(input, id).toEqual(before);
        }
        accepts("inlays", "i", { name: "n", ext: "png", type: "image", asset: "assets/inlay_x.png" });
        accepts("inlays", "i", {
            name: "n",
            ext: "mp4",
            type: "video",
            width: 1,
            height: 2,
            size: 3,
            asset: "assets/v",
        });
        accepts("inlays", "i", { name: "n", ext: "mp3", type: "audio", asset: "assets/a.mp3", width: undefined });
        accepts("inlays", "i", { name: "n", ext: "", type: "signature", text: "{}" });
    });

    it("refuse non-objects", () => {
        for (const name of ["pluginStorage", "pluginPermissions", "characters", "inlays"]) {
            for (const input of [null, 1, "x", [], undefined]) {
                expect(() => kind(name).normalize(input, { id: "main" }), name).toThrow(ResourceValidationError);
            }
        }
        for (const name of ["presets", "modules", "plugins"]) {
            for (const input of [null, {}, "x", [1], [null], [[]]]) {
                rejects(name, "main", input, `${name} must be an array of objects`);
            }
        }
    });

    it("require the character id to match and refuse a character record holding chats", () => {
        rejects("characters", "c1", {}, "character.chaId must equal the resource id");
        rejects("characters", "c1", { chaId: "c2" }, "character.chaId must equal the resource id");
        // Chats are their own resource; a character record with embedded chats is refused.
        rejects("characters", "c1", { chaId: "c1", chats: [] }, "character must not hold chats");
        rejects("characters", "c1", { chaId: "c1", chats: undefined }, "character must not hold chats");
    });

    it("require the plugin permission maps to hold true and numbers", () => {
        rejects("pluginPermissions", "main", { grants: {} }, "pluginPermissions.lastGrantTime must be an object");
        rejects("pluginPermissions", "main", { lastGrantTime: {} }, "pluginPermissions.grants must be an object");
        rejects(
            "pluginPermissions",
            "main",
            { grants: [], lastGrantTime: {} },
            "pluginPermissions.grants must be an object",
        );
        rejects(
            "pluginPermissions",
            "main",
            { grants: { a: false }, lastGrantTime: {} },
            "pluginPermissions.grants values must be true",
        );
        rejects(
            "pluginPermissions",
            "main",
            { grants: { a: 1 }, lastGrantTime: {} },
            "pluginPermissions.grants values must be true",
        );
        rejects(
            "pluginPermissions",
            "main",
            { grants: {}, lastGrantTime: { a: "1" } },
            "pluginPermissions.lastGrantTime values must be numbers",
        );
    });

    it("require an inlay's type discriminant, a signature's text, and a resolvable asset key for media", () => {
        const media = { name: "n", ext: "png", type: "image" };
        rejects(
            "inlays",
            "i",
            { ext: "png", type: "image", asset: "assets/a" },
            "inlay.name and inlay.ext must be strings",
        );
        rejects(
            "inlays",
            "i",
            { name: "n", type: "image", asset: "assets/a" },
            "inlay.name and inlay.ext must be strings",
        );
        rejects(
            "inlays",
            "i",
            { name: "n", ext: "png", type: "gif" },
            "inlay.type must be image, video, audio, or signature",
        );
        rejects("inlays", "i", { name: "n", ext: "png" }, "inlay.type must be image, video, audio, or signature");
        rejects("inlays", "i", { ...media, asset: "assets/a", width: "1" }, "inlay.width must be a number");
        rejects("inlays", "i", { ...media, asset: "assets/a", height: null }, "inlay.height must be a number");
        rejects("inlays", "i", { ...media, asset: "assets/a", size: "3" }, "inlay.size must be a number");
        rejects("inlays", "i", { name: "n", ext: "", type: "signature" }, "A signature inlay needs text");
        rejects("inlays", "i", { name: "n", ext: "", type: "signature", text: {} }, "A signature inlay needs text");
        // The key must resolve to a file the storage routes can read back (`resolveStorageKey`).
        const unresolvable = "A media inlay needs a resolvable asset key in the assets namespace";
        for (const asset of [
            undefined,
            "",
            "inlay_x.png",
            "assets",
            "assets/",
            "/assets/x.png",
            "Assets/x.png",
            "database/x.png",
            "assets/" + "x".repeat(300),
            "assets/" + "가".repeat(60),
            12,
        ]) {
            rejects("inlays", "i", { ...media, asset }, unresolvable);
        }
        accepts("inlays", "i", { ...media, asset: "assets/x.a/b" });
        accepts("inlays", "i", { ...media, asset: "assets/" + "x".repeat(255) });
    });
});
