// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultHotkeys } from "../../../shared/hotkeys.ts";
import { COLLECTION_KIND, SECTION_KIND } from "../../../shared/sections.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    normalizeAuthRefreshes,
    normalizeCharacterOrder,
    normalizeCustomModels,
    normalizeEnabledModules,
    normalizeGlobalChatVariables,
    normalizeGlobalscript,
    normalizeHotkeys,
    normalizeHypaV3Presets,
    normalizeLoreBook,
    normalizeStatics,
    normalizeTranslatorPresets,
} from "../data/normalize/collections.ts";
import { normalizePersonas } from "../data/normalize/personas.ts";
import { normalizePresetCollection } from "../data/normalize/presets.ts";
import { ResourceValidationError, serialize } from "../data/resourceStore.ts";

// Phase 3, slice 3 (`docs/plan/phases/slices/phase-3-settings-sections/server-section-normalizers.md`,
// "Validation"): the collection normalizers, and the registry entries of every Phase 3 kind.

const fixtureDir = path.resolve(import.meta.dirname, "../../../src/ts/storage/tests/fixtures/phase3");
const bootSnapshot = JSON.parse(readFileSync(path.join(fixtureDir, "boot-snapshot.json"), "utf-8")) as Record<
    string,
    unknown
>;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);

type Normalizer = (input: unknown) => unknown;
const rejects = (normalize: Normalizer, input: unknown, message: string) =>
    expect(() => normalize(input), JSON.stringify(input)).toThrow(new ResourceValidationError(message));
/** Normalizing the stored form of the output must give the same text (the startup pass rewrites otherwise). */
function expectIdempotent(normalize: Normalizer, input: unknown) {
    const once = serialize(normalize(input));
    expect(serialize(normalize(once.stored)).text).toBe(once.text);
}
/** `value` with every `id` removed, at any depth, to compare against a fixture whose ids were random. */
function withoutIds(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(withoutIds);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "id")
                .map(([key, inner]) => [key, withoutIds(inner)]),
        );
    }
    return value;
}

describe("the registry", () => {
    it("registers every section and collection kind as a materialized singleton, `llmSecrets` write-only", () => {
        for (const name of [...Object.values(SECTION_KIND), ...Object.values(COLLECTION_KIND)]) {
            const kind = kinds.get(name);
            expect(kind, name).toBeDefined();
            expect(kind, name).toMatchObject({ singleton: true, materialize: true, schemaVersion: 1 });
            // Phase 5 slice 7b: only `llmSecrets` projects its reads and prepares its plain writes.
            expect(typeof kind!.project, name).toBe(name === "llmSecrets" ? "function" : "undefined");
            expect(typeof kind!.prepareWrite, name).toBe(name === "llmSecrets" ? "function" : "undefined");
        }
    });

    it("materializes every `materialize` kind to a value that is its own fixed point after serialization", () => {
        for (const kind of DEFAULT_RESOURCE_KINDS.filter((k) => k.materialize)) {
            expectIdempotent((input) => kind.normalize(input, { id: "main" }), undefined);
        }
    });
});

describe("plain list and map collections", () => {
    it("materialize the fresh-boot value and copy a well-formed record", () => {
        expect(normalizeLoreBook(undefined)).toEqual(bootSnapshot.loreBook);
        expect(normalizeLoreBook(undefined)).toEqual([{ name: "My First LoreBook", data: [] }]);
        expect(normalizeLoreBook([])).toEqual([]);
        expect(normalizeGlobalscript(undefined)).toEqual([]);
        expect(normalizeCharacterOrder(undefined)).toEqual([]);
        expect(normalizeAuthRefreshes(undefined)).toEqual([]);
        expect(normalizeGlobalChatVariables(undefined)).toEqual({});
        expect(normalizeCustomModels(undefined)).toEqual([]);
        expect(normalizeEnabledModules(undefined)).toEqual([]);
        expect(normalizeStatics(undefined)).toEqual(bootSnapshot.statics);

        const lore = [{ name: "L", data: [{ key: "k", comment: "c" }], extra: 1 }];
        const copied = normalizeLoreBook(lore);
        expect(copied).toEqual(lore);
        expect(copied).not.toBe(lore);
        expect(copied[0]).not.toBe(lore[0]);
        const order = ["a", { name: "f", data: ["b"], color: "", id: "x" }];
        expect(normalizeCharacterOrder(order)).toEqual(order);
        const modules = ["m1", "m2"];
        expect(normalizeEnabledModules(modules)).toEqual(modules);
        expect(normalizeEnabledModules(modules)).not.toBe(modules);
        // A model's key is an `llmSecrets` credential (Phase 5 slice 7b): one in the record is dropped.
        const models = [{ id: "a", internalId: "b", key: "secret", extra: 1 }];
        expect(normalizeCustomModels(models)).toEqual([{ id: "a", internalId: "b", extra: 1 }]);
    });

    it("reject a record or an element of the wrong shape", () => {
        for (const [name, normalize] of [
            ["loreBook", normalizeLoreBook],
            ["globalscript", normalizeGlobalscript],
            ["authRefreshes", normalizeAuthRefreshes],
            ["customModels", normalizeCustomModels],
        ] as const) {
            for (const input of [{}, null, "x", [1], [null], [[]]]) {
                rejects(normalize, input, `${name} must be an array of objects`);
            }
        }
        for (const input of [{}, null, [1], [null], [[]]]) {
            rejects(normalizeCharacterOrder, input, "characterOrder must be an array of ids and folders");
        }
        for (const input of [{}, null, [1], [null], [{}]]) {
            rejects(normalizeEnabledModules, input, "enabledModules must be an array of strings");
        }
        for (const input of [[], null, "x"]) {
            rejects(normalizeGlobalChatVariables, input, "globalChatVariables must be an object");
            rejects(normalizeStatics, input, "statics must be an object");
        }
        rejects(normalizeCustomModels, [{ id: "a" }], "customModels entries need string id and internalId");
        rejects(
            normalizeCustomModels,
            [{ id: 1, internalId: "b" }],
            "customModels entries need string id and internalId",
        );
    });

    it("authRefreshes: every known field is a string or absent (a public client has no secret)", () => {
        const entries = [
            { url: "u", tokenUrl: "t", refreshToken: "r", clientId: "c" },
            { url: "u", tokenUrl: "t", refreshToken: "r", clientId: "c", clientSecret: "s", extra: 1 },
            {},
        ];
        expect(normalizeAuthRefreshes(entries)).toEqual(entries);
        rejects(normalizeAuthRefreshes, [{ url: 1 }], "authRefreshes entries must hold strings");
        rejects(normalizeAuthRefreshes, [{ clientSecret: null }], "authRefreshes entries must hold strings");
    });

    it("globalChatVariables keeps an own `__proto__` key as an ordinary entry", () => {
        const input = JSON.parse('{"__proto__":"value","normal":"v"}');
        const out = normalizeGlobalChatVariables(input);
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        expect(Object.keys(out)).toEqual(["__proto__", "normal"]);
        expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("value");
        expect(serialize(out).text).toBe('{"__proto__":"value","normal":"v"}');
        expectIdempotent(normalizeGlobalChatVariables, input);
    });

    it("statics keeps the two counters and zeroes a missing or non-number one", () => {
        expect(normalizeStatics({ messages: 3, imports: "x", extra: 1 })).toEqual({ messages: 3, imports: 0 });
        expect(normalizeStatics({})).toEqual({ messages: 0, imports: 0 });
        expectIdempotent(normalizeStatics, { messages: 3, imports: null });
    });
});

describe("hotkeys", () => {
    it("materializes a copy of the built-in hotkeys", () => {
        const out = normalizeHotkeys(undefined);
        expect(out).toEqual(defaultHotkeys);
        expect(out).toEqual(bootSnapshot.hotkeys);
        out[0].key = "changed";
        expect(defaultHotkeys[0].key).not.toBe("changed");
    });

    it("keeps the stored list first and appends each built-in hotkey whose action is missing", () => {
        const stored = [
            { key: "x", ctrl: true, alt: false, action: "reroll" },
            { key: "y", ctrl: false, alt: false, action: "custom" },
        ];
        const out = normalizeHotkeys(stored);
        expect(out.slice(0, 2)).toEqual(stored);
        expect(out.slice(2)).toEqual(defaultHotkeys.filter((hotkey) => hotkey.action !== "reroll"));
        expect(normalizeHotkeys([])).toEqual(defaultHotkeys);
        expect(normalizeHotkeys(defaultHotkeys)).toEqual(defaultHotkeys);
        expectIdempotent(normalizeHotkeys, stored);
        for (const input of [{}, null, [1]]) {
            rejects(normalizeHotkeys, input, "hotkeys must be an array of objects");
        }
    });
});

describe("translatorPresets", () => {
    it("materializes the fresh-boot preset with the first item selected", () => {
        const out = normalizeTranslatorPresets(undefined);
        expect(withoutIds(out.items)).toEqual(bootSnapshot.translatorPresets);
        expect(out.items[0].id).toMatch(UUID_V4);
        expect(out.selectedId).toBe(out.items[0].id);
        expect(normalizeTranslatorPresets({ items: [] })).toMatchObject({ items: [{ name: "Default" }] });
    });

    it("rebuilds every item, keeps a valid id, re-keys a repeated one, and falls the selection back to the first item", () => {
        const out = normalizeTranslatorPresets({
            items: [
                { name: "A", id: "x", prompt: 5, maxResponse: 7, extra: 1 },
                { name: "   ", id: "x", prompt: "p" },
                { id: "y", maxResponse: "many" },
                { name: "D", id: "", prompt: "q", maxResponse: 3 },
            ],
            selectedId: "y",
        });
        expect(out.items.map((item) => item.name)).toEqual(["A", "Preset 2", "Preset 3", "D"]);
        expect(out.items[0]).toEqual({ id: "x", name: "A", prompt: "", maxResponse: 7 });
        expect(out.items[1].id).toMatch(UUID_V4);
        expect(out.items[1]).toMatchObject({ prompt: "p", maxResponse: 1000 });
        expect(out.items[2]).toEqual({ id: "y", name: "Preset 3", prompt: "", maxResponse: 1000 });
        expect(out.items[3].id).toMatch(UUID_V4);
        expect(out.selectedId).toBe("y");
        expect(new Set(out.items.map((item) => item.id)).size).toBe(4);

        const items = [{ name: "A", id: "x" }];
        expect(normalizeTranslatorPresets({ items, selectedId: "nope" }).selectedId).toBe("x");
        expect(normalizeTranslatorPresets({ items, selectedId: 0 }).selectedId).toBe("x");
        expect(normalizeTranslatorPresets({ items }).selectedId).toBe("x");
        expectIdempotent(normalizeTranslatorPresets, { items: [{ name: " ", id: "x" }, { id: "x" }] });
    });

    it("rejects a record without an items list of objects", () => {
        for (const input of [[], null, "x"]) {
            rejects(normalizeTranslatorPresets, input, "translatorPresets must be an object");
        }
        for (const input of [{}, { items: {} }, { items: null }, { items: [1] }]) {
            rejects(normalizeTranslatorPresets, input, "translatorPresets.items must be an array of objects");
        }
    });
});

describe("hypaV3Presets", () => {
    it("materializes the fresh-boot preset with the first item selected", () => {
        const out = normalizeHypaV3Presets(undefined);
        expect(withoutIds(out.items)).toEqual(bootSnapshot.hypaV3Presets);
        expect(out.items[0].id).toMatch(UUID_V4);
        expect(out.selectedId).toBe(out.items[0].id);
        expect(normalizeHypaV3Presets({ items: [] })).toMatchObject({ items: [{ name: "Default" }] });
    });

    it("keeps known settings of the right type, defaults the rest, names and re-keys items, and falls the selection back", () => {
        const out = normalizeHypaV3Presets({
            items: [
                { id: "a", name: "A", settings: { memoryTokensRatio: 0.5, maxChatsPerSummary: "6", unknown: 1 } },
                { id: "a", name: "", settings: "nope" },
                { id: 3, extra: true },
            ],
            selectedId: "missing",
        });
        const defaults = normalizeHypaV3Presets(undefined).items[0].settings;
        expect(out.items[0]).toEqual({ id: "a", name: "A", settings: { ...defaults, memoryTokensRatio: 0.5 } });
        expect(out.items[1]).toEqual({ id: expect.stringMatching(UUID_V4), name: "Preset 2", settings: defaults });
        expect(out.items[2]).toEqual({ id: expect.stringMatching(UUID_V4), name: "Preset 3", settings: defaults });
        expect(out.selectedId).toBe("a");
        expect(normalizeHypaV3Presets({ items: [{ id: "a" }, { id: "b" }], selectedId: "b" }).selectedId).toBe("b");
        for (const input of [{}, { items: null }, { items: [null] }]) {
            rejects(normalizeHypaV3Presets, input, "hypaV3Presets.items must be an array of objects");
        }
    });

    it("gives a settings object with an own `__proto__` key an ordinary prototype and a stable stored form (Astra challenge, point 1)", () => {
        const input = JSON.parse(
            '{"items":[{"id":"p","name":"P","settings":{"__proto__":{"extra":0},"extra":42}}],"selectedId":"p"}',
        );
        const out = normalizeHypaV3Presets(input);
        const settings = out.items[0].settings as unknown as Record<string, unknown>;
        expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
        expect(Object.hasOwn(settings, "__proto__")).toBe(false);
        expect(Object.hasOwn(settings, "extra")).toBe(false);
        expect(settings.extra).toBeUndefined();
        expect(settings).toEqual(normalizeHypaV3Presets(undefined).items[0].settings);
        expectIdempotent(normalizeHypaV3Presets, input);
        expect(Object.hasOwn(Object.prototype, "extra")).toBe(false);
    });
});

describe("personas", () => {
    it("materializes the fresh-boot persona, turns an empty list into it, fills the four fields, and backstops ids", () => {
        const materialized = normalizePersonas(undefined);
        expect(withoutIds(materialized)).toEqual(withoutIds(bootSnapshot.personas));
        expect(materialized[0].id).toMatch(UUID_V4);
        // Never empty (slice 6, `shared/personas.ts`): a selection always has a record.
        const fromEmpty = normalizePersonas([]);
        expect(withoutIds(fromEmpty)).toEqual(withoutIds(bootSnapshot.personas));
        expect(fromEmpty[0].id).toMatch(UUID_V4);

        const module = { id: "m", name: "embedded", lorebook: [] };
        const out = normalizePersonas([
            { name: "a", icon: "i", extra: { deep: true } },
            { name: "b", id: "x", module },
            { name: "c", id: "x" },
            { name: "d", id: 5 },
            { name: "e", id: "", note: 7 },
        ]);
        expect(out.map((persona) => persona.name)).toEqual(["a", "b", "c", "d", "e"]);
        // A missing or wrong-typed `name`, `icon`, `personaPrompt`, or `note` gets its default, appended
        // after the entry's own keys; the other keys are kept.
        expect(out[0]).toEqual({
            name: "a",
            icon: "i",
            extra: { deep: true },
            personaPrompt: "",
            note: "",
            id: expect.stringMatching(UUID_V4),
        });
        expect(Object.keys(out[0])).toEqual(["name", "icon", "extra", "personaPrompt", "note", "id"]);
        expect(out[1]).toEqual({ name: "b", id: "x", module, icon: "", personaPrompt: "", note: "" });
        expect((out[1] as unknown as Record<string, unknown>).module).not.toBe(module);
        expect(out[4].note).toBe("");
        for (const index of [2, 3, 4]) {
            expect(out[index].id, `persona ${index}`).toMatch(UUID_V4);
        }
        expect(new Set(out.map((persona) => persona.id)).size).toBe(5);
        expectIdempotent(normalizePersonas, [{ name: "a" }, { id: "x" }, { id: "x" }]);
        for (const input of [{}, null, [1], [null]]) {
            rejects(normalizePersonas, input, "personas must be an array of objects");
        }
    });
});

describe("presets", () => {
    it("materializes one default preset, gives every element the canonical fields and an id, and rejects a non-list", () => {
        for (const input of [undefined, []]) {
            const out = normalizePresetCollection(input);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({ id: expect.stringMatching(UUID_V4), name: "New Preset", temperature: 80 });
        }
        const out = normalizePresetCollection([{ name: "p", temperature: 1 }, { id: "keep" }, { id: "keep" }]);
        expect(out.map((preset) => preset.name)).toEqual(["p", "New Preset", "New Preset"]);
        expect(out[0]).toMatchObject({ temperature: 1, maxContext: 4000 });
        expect(out[1].id).toBe("keep");
        expect(out[2].id).toMatch(UUID_V4);
        expectIdempotent(normalizePresetCollection, [{ name: "p" }, { openrouterProvider: "legacy" }]);
        for (const input of [{}, null, "x", [1], [null]]) {
            rejects(normalizePresetCollection, input, "presets must be an array of objects");
        }
    });
});
