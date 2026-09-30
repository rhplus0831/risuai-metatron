// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { botPreset } from "../../../shared/database.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import { ResourceValidationError } from "../data/resourceStore.ts";

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;
const phase1Kinds = ["presets", "modules", "plugins", "pluginStorage", "pluginPermissions", "characters", "inlays"];
/** The Phase 3 sections and collections (slice 3): singletons the store materializes. */
const phase3Kinds = [
    "providers",
    "secrets",
    "llmSecrets",
    "ui",
    "memoryTranslateMedia",
    "loreBook",
    "globalscript",
    "hotkeys",
    "customSidebarItems",
    "characterOrder",
    "authRefreshes",
    "globalChatVariables",
    "personas",
    "translatorPresets",
    "hypaV3Presets",
    "customModels",
    "enabledModules",
    "statics",
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
    it("holds the seven Phase 1 kinds (root is gone since slice 6), five of them singletons, and the 18 Phase 3 singletons; presets and Phase 3 materialize", () => {
        expect([...kinds.keys()]).toEqual([...phase1Kinds, ...phase3Kinds]);
        expect(kinds.has("root")).toBe(false);
        expect([...kinds.values()].filter((k) => k.singleton).map((k) => k.name)).toEqual([
            "presets",
            "modules",
            "plugins",
            "pluginStorage",
            "pluginPermissions",
            ...phase3Kinds,
        ]);
        // `presets` materializes too (one default preset), so a selection always has a record.
        expect([...kinds.values()].filter((k) => k.materialize).map((k) => k.name)).toEqual([
            "presets",
            ...phase3Kinds,
        ]);
        // Phase 5 makes the credential kinds write-only; until then the client may still read `llmSecrets`.
        expect([...kinds.values()].filter((k) => k.clientReadable).map((k) => k.name)).toEqual(["llmSecrets"]);
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
    it("return the input unchanged when the minimum shape holds, except presets, which get the canonical schema", () => {
        // `presets` (slice 3) returns `normalizePresets`' copy: every preset gets an id and the
        // canonical fields, and an empty list becomes one default preset.
        const presets = kind("presets").normalize([{ name: "p" }, {}], { id: "main" }) as botPreset[];
        expect(presets.map((p) => p.name)).toEqual(["p", "New Preset"]);
        for (const preset of presets) {
            expect(preset.id).toMatch(UUID);
            expect(preset).toMatchObject({ temperature: 80, maxContext: 4000, formatingOrder: expect.any(Array) });
        }
        expect(kind("presets").normalize([], { id: "main" })).toMatchObject([
            { id: expect.stringMatching(UUID), name: "New Preset", temperature: 80 },
        ]);
        accepts("modules", "main", [{ id: "m" }]);
        accepts("plugins", "main", [{ name: "p" }]);
        accepts("pluginStorage", "main", {});
        accepts("pluginStorage", "main", { _safeLocalPluginStorage: { a: 1 } });
        accepts("pluginPermissions", "main", { grants: {}, lastGrantTime: {} });
        accepts("pluginPermissions", "main", { grants: { h_db: true }, lastGrantTime: { p_db_lastGrantTime: 1 } });
        accepts("characters", "c1", { chaId: "c1" });
        accepts("characters", "§playground", { chaId: "§playground", name: "n", chatPage: 0 });
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
        // Chats are their own resource (Phase 2); a Phase 1 record with embedded chats is refused.
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
