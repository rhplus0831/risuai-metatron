// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultHotkeys } from "../../../shared/hotkeys.ts";
import { createHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import { COLLECTION_KIND, SECTION_KIND } from "../../../shared/sections.ts";
import {
    normalizeStructuredMemorySettings,
    structuredMemoryHighlightOverride,
    structuredMemoryLanguageOverride,
} from "../../../shared/structuredMemory.ts";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    normalizeAuthRefreshes,
    normalizeCharacterOrder,
    normalizeCredentials,
    normalizeCustomModels,
    normalizeEnabledModules,
    normalizeGlobalChatVariables,
    normalizeGlobalscript,
    normalizeHotkeys,
    normalizeHypaV3Presets,
    normalizeLoreBook,
    normalizeStatics,
    normalizeTogglePresets,
    normalizeTranslatorPresets,
} from "../data/normalize/collections.ts";
import { normalizePersonas } from "../data/normalize/personas.ts";
import { normalizeModelPresetCollection, normalizePresetCollection } from "../data/normalize/presets.ts";
import { ResourceValidationError, serialize } from "../data/resourceStore.ts";

// The collection normalizers, and the registry entries of every settings section and collection kind.

const fixtureDir = path.resolve(import.meta.dirname, "../../../src/ts/storage/tests/fixtures/boot");
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
            // Only `llmSecrets` projects its reads and prepares its plain writes.
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

describe("togglePresets", () => {
    it("materializes an empty list and normalizes object entries without a selection field", () => {
        expect(normalizeTogglePresets(undefined)).toEqual([]);
        expect(normalizeTogglePresets([])).toEqual([]);
        const input = [
            {
                id: "p",
                name: "",
                values: { title: "", bad: 3 },
                kinds: { title: "text", bad: "group" },
                createdAt: 4,
                extra: true,
            },
        ];
        expect(normalizeTogglePresets(input)).toEqual([
            {
                id: "p",
                name: "Toggle Preset 1",
                values: { title: "" },
                kinds: { title: "text" },
                createdAt: 4,
                updatedAt: 4,
            },
        ]);
        expectIdempotent(normalizeTogglePresets, input);
    });

    it("rejects every non-array record and any non-object entry with ResourceValidationError", () => {
        for (const input of [null, {}, "x", 1, true, [null], [1], ["x"], [[]], [{ id: "p" }, false]]) {
            expect(() => normalizeTogglePresets(input), JSON.stringify(input)).toThrow(ResourceValidationError);
            rejects(normalizeTogglePresets, input, "togglePresets must be an array of objects");
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
        // A model's key is an `llmSecrets` credential: one in the record is dropped.
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

    it("characterOrder keeps the first id across characters and folders with detached optional fields", () => {
        const folder = { id: "folder", name: "First", color: "", data: ["nested"], extra: { pinned: true } };
        const input = [
            "character",
            folder,
            "character",
            { id: "folder", name: "Later", color: "red", data: [] },
            { id: "character", name: "Collision", color: "", data: [] },
            "folder",
            "last",
        ];
        const expected = ["character", folder, "last"];
        const out = normalizeCharacterOrder(input);
        expect(out).toEqual(expected);
        expectIdempotent(normalizeCharacterOrder, input);
        const copied = out[1] as typeof folder;
        copied.data.push("changed");
        copied.extra.pinned = false;
        expect(folder).toEqual({ id: "folder", name: "First", color: "", data: ["nested"], extra: { pinned: true } });
        expect(normalizeCharacterOrder(input)).toEqual(expected);
    });

    it("characterOrder drops no folder: older folders missing id, name, color, or data stay, non-string members go, and an id-less folder is never deduplicated", () => {
        const valid = { id: "folder", name: "Valid", color: "", data: ["character"] };
        const legacy = [
            { name: "Old", data: ["a"] },
            { name: "Old", data: ["b"] },
            { id: "x", data: [] },
            { name: "No list" },
        ];
        const mixed = { id: "mixed", name: "Mixed", color: "", data: ["character", 1, null] };
        const input = [valid, ...legacy, mixed, "last"];
        expect(normalizeCharacterOrder(input)).toEqual([valid, ...legacy, { ...mixed, data: ["character"] }, "last"]);
        // The input is not edited in place.
        expect(mixed.data).toEqual(["character", 1, null]);
        expectIdempotent(normalizeCharacterOrder, [valid, ...legacy, mixed]);
    });

    it("customModels keeps the first definition per id, detaches extras, and strips retired credentials", () => {
        const first = {
            id: "model",
            internalId: "first",
            key: "secret",
            credentialId: "retired",
            extra: { labels: ["keep"] },
        };
        const input = [first, { id: "model", internalId: "later" }, { id: "other", internalId: "second" }];
        const expected = [
            { id: "model", internalId: "first", extra: { labels: ["keep"] } },
            { id: "other", internalId: "second" },
        ];
        const out = normalizeCustomModels(input);
        expect(out).toEqual(expected);
        expectIdempotent(normalizeCustomModels, input);
        (out[0] as unknown as typeof first).extra.labels.push("changed");
        expect(first.extra.labels).toEqual(["keep"]);
        expect(normalizeCustomModels(input)).toEqual(expected);
        // Even a duplicate must satisfy the required definition shape before deduplication.
        expect(() => normalizeCustomModels([first, { id: "model", internalId: 1 }])).toThrow(ResourceValidationError);
    });

    it("credentials: metadata only (the key is dropped), a client email and project only on a Vertex key, unique record ids, a known type", () => {
        expect(normalizeCredentials(undefined)).toEqual([]);
        expect(
            normalizeCredentials([
                {
                    id: "c1",
                    name: "Work",
                    type: "anthropic",
                    key: "secret",
                    clientEmail: "x@example.test",
                    projectId: "p",
                    extra: 1,
                },
                { id: "c2", name: "", type: "custom" },
                { id: "c3", name: "SA", type: "vertex", clientEmail: "sa@example.test", projectId: "p", key: "pem" },
                { id: "c4", name: "SA without email", type: "vertex" },
            ]),
        ).toEqual([
            { id: "c1", name: "Work", type: "anthropic" },
            { id: "c2", name: "", type: "custom" },
            { id: "c3", name: "SA", type: "vertex", clientEmail: "sa@example.test", projectId: "p" },
            { id: "c4", name: "SA without email", type: "vertex" },
        ]);
        for (const input of [{}, null, [1], [null]]) {
            rejects(normalizeCredentials, input, "credentials must be an array of objects");
        }
        const shape = "credentials entries need a record id, string name and known type";
        rejects(normalizeCredentials, [{ id: "", name: "n", type: "openai" }], shape);
        rejects(normalizeCredentials, [{ id: 1, name: "n", type: "openai" }], shape);
        rejects(normalizeCredentials, [{ id: "c1", type: "openai" }], shape);
        rejects(normalizeCredentials, [{ id: "c1", name: "n", type: "aws" }], shape);
        rejects(normalizeCredentials, [{ id: "c1", name: "n" }], shape);
        rejects(
            normalizeCredentials,
            [
                { id: "c1", name: "a", type: "openai" },
                { id: "c1", name: "b", type: "custom" },
            ],
            "credentials entries must have unique ids",
        );
        rejects(
            normalizeCredentials,
            [{ id: "c1", name: "n", type: "vertex", clientEmail: 1 }],
            "credentials.clientEmail must be a string when present for vertex",
        );
        rejects(
            normalizeCredentials,
            [{ id: "c1", name: "n", type: "vertex", projectId: 1 }],
            "credentials.projectId must be a string when present for vertex",
        );
    });

    it("customModels: a definition holds no credential binding or key; either is dropped, of any kind", () => {
        const model = { id: "xcustom:::a", internalId: "b" };
        // The profile picks the key.
        expect(normalizeCustomModels([{ ...model, credentialId: "c1" }])).toEqual([model]);
        expect(normalizeCustomModels([{ ...model, credentialId: 1, key: "sk-leak" }])).toEqual([model]);
        expect(normalizeCustomModels([model])).toEqual([model]);
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
        // The shape before steps (`{ prompt, maxResponse }`) becomes one inherited step; both old
        // fields are dropped from the record.
        const oneStep = (prompt: string, maxResponse: number) => [
            {
                id: expect.stringMatching(UUID_V4),
                name: "Step 1",
                enabled: true,
                prompt,
                maxResponse,
                model: { mode: "inherit" },
            },
        ];
        expect(out.items.map((item) => item.name)).toEqual(["A", "Preset 2", "Preset 3", "D"]);
        expect(out.items[0]).toEqual({ id: "x", name: "A", steps: oneStep("", 7) });
        expect(out.items[1].id).toMatch(UUID_V4);
        expect(out.items[1]).toMatchObject({ steps: oneStep("p", 1000) });
        expect(out.items[2]).toEqual({ id: "y", name: "Preset 3", steps: oneStep("", 1000) });
        expect(out.items[3]).toMatchObject({ id: expect.stringMatching(UUID_V4), steps: oneStep("q", 3) });
        expect(out.selectedId).toBe("y");
        expect(new Set(out.items.map((item) => item.id)).size).toBe(4);
        for (const item of out.items) {
            expect(Object.keys(item).sort()).toEqual(["id", "name", "steps"]);
        }

        const items = [{ name: "A", id: "x" }];
        expect(normalizeTranslatorPresets({ items, selectedId: "nope" }).selectedId).toBe("x");
        expect(normalizeTranslatorPresets({ items, selectedId: 0 }).selectedId).toBe("x");
        expect(normalizeTranslatorPresets({ items }).selectedId).toBe("x");
        expectIdempotent(normalizeTranslatorPresets, { items: [{ name: " ", id: "x" }, { id: "x" }] });
    });

    it("normalizes the steps: an empty list is one step, the first five are kept, and each step is coerced", () => {
        const step = (overrides: Record<string, unknown>) => ({
            id: expect.stringMatching(UUID_V4),
            name: expect.any(String),
            enabled: true,
            prompt: "",
            maxResponse: 1000,
            model: { mode: "inherit" },
            ...overrides,
        });
        const out = normalizeTranslatorPresets({
            items: [
                { id: "empty", name: "E", steps: [] },
                { id: "empty-with-old", name: "O", steps: [], prompt: "old", maxResponse: 2 },
                { id: "six", name: "S", steps: Array.from({ length: 6 }, (_, index) => ({ name: `N${index}` })) },
                {
                    id: "mixed",
                    name: "M",
                    steps: [
                        {
                            id: "a",
                            name: "First",
                            enabled: false,
                            prompt: "{{slot::content}}",
                            maxResponse: 3,
                            outputKey: "draft",
                        },
                        { id: "a", prompt: 1, model: { mode: "profile", profileId: "pr" }, outputKey: "draft" },
                        "not a step",
                    ],
                },
            ],
            selectedId: "mixed",
        });
        expect(out.items[0].steps).toEqual([step({ name: "Step 1" })]);
        // The old fields are read only when there are no steps at all; an empty list reads them too.
        expect(out.items[1].steps).toEqual([step({ name: "Step 1", prompt: "old", maxResponse: 2 })]);
        expect(out.items[2].steps.map((entry) => entry.name)).toEqual(["N0", "N1", "N2", "N3", "N4"]);
        expect(out.items[3].steps).toEqual([
            {
                id: "a",
                name: "First",
                enabled: false,
                prompt: "{{slot::content}}",
                maxResponse: 3,
                model: { mode: "inherit" },
                outputKey: "draft",
            },
            step({ name: "Step 2", model: { mode: "profile", profileId: "pr" } }),
            step({ name: "Step 3" }),
        ]);
        expect(out.items[3].steps[1].id).not.toBe("a");
        expect(Object.hasOwn(out.items[3].steps[1], "outputKey")).toBe(false);
        expectIdempotent(normalizeTranslatorPresets, { items: out.items, selectedId: "mixed" });
        expectIdempotent(normalizeTranslatorPresets, {
            items: [{ id: "x", steps: [{ outputKey: "k" }, { id: "d" }, { id: "d" }, 1, 2, 3, 4] }],
        });
    });

    it("stores a preset the tab creates with `createTranslatorPreset` as it is", () => {
        const created = createTranslatorPreset("Two", {
            steps: [
                { name: "Draft", prompt: "{{slot::content}}", maxResponse: 300, outputKey: "draft" },
                { name: "Polish", prompt: "{{slot::prev}}", model: { mode: "profile", profileId: "pr" } },
            ],
        });
        const record = { items: [createTranslatorPreset("Default"), created], selectedId: created.id };
        const text = serialize(record).text;
        expect(serialize(normalizeTranslatorPresets(JSON.parse(text))).text).toBe(text);
    });

    // Send Text As-Is is stored only as `true`; a preset from before the option (no field) and one
    // carrying any other value are stored without it.
    it("stores sendTextAsIs only as true, drops any other value, and leaves a preset without it as it was", () => {
        const out = normalizeTranslatorPresets({
            items: [
                { id: "on", name: "On", steps: [{ prompt: "p" }], sendTextAsIs: true },
                { id: "false", name: "F", steps: [{ prompt: "p" }], sendTextAsIs: false },
                { id: "string", name: "S", steps: [{ prompt: "p" }], sendTextAsIs: "true" },
                { id: "null", name: "N", steps: [{ prompt: "p" }], sendTextAsIs: null },
                { id: "old", name: "Old", prompt: "p", maxResponse: 3 },
            ],
            selectedId: "on",
        });
        expect(out.items[0]).toMatchObject({ id: "on", sendTextAsIs: true });
        expect(Object.keys(out.items[0])).toEqual(["id", "name", "steps", "sendTextAsIs"]);
        for (const item of out.items.slice(1)) {
            expect(Object.hasOwn(item, "sendTextAsIs"), item.id).toBe(false);
            expect(Object.keys(item), item.id).toEqual(["id", "name", "steps"]);
        }
        expectIdempotent(normalizeTranslatorPresets, { items: out.items, selectedId: "on" });
        // A preset the tab turns on with `createTranslatorPreset` is stored as it is.
        const created = createTranslatorPreset("As-Is", {
            steps: [{ prompt: "{{slot::content}}" }],
            sendTextAsIs: true,
        });
        const record = { items: [created], selectedId: created.id };
        const text = serialize(record).text;
        expect(text).toContain('"sendTextAsIs":true');
        expect(serialize(normalizeTranslatorPresets(JSON.parse(text))).text).toBe(text);
    });

    // Exclude Chain-of-Thought is stored only as `true`, after `sendTextAsIs` and independent of it.
    it("stores excludeThoughts only as true, after sendTextAsIs and independent of it, drops any other value, and leaves a preset without it as it was", () => {
        const out = normalizeTranslatorPresets({
            items: [
                { id: "on", name: "On", steps: [{ prompt: "p" }], excludeThoughts: true },
                { id: "both", name: "B", steps: [{ prompt: "p" }], excludeThoughts: true, sendTextAsIs: true },
                { id: "false", name: "F", steps: [{ prompt: "p" }], excludeThoughts: false },
                { id: "string", name: "S", steps: [{ prompt: "p" }], excludeThoughts: "true" },
                { id: "null", name: "N", steps: [{ prompt: "p" }], excludeThoughts: null, sendTextAsIs: true },
                { id: "old", name: "Old", prompt: "p", maxResponse: 3 },
            ],
            selectedId: "on",
        });
        expect(out.items[0]).toMatchObject({ id: "on", excludeThoughts: true });
        expect(Object.keys(out.items[0])).toEqual(["id", "name", "steps", "excludeThoughts"]);
        expect(Object.keys(out.items[1])).toEqual(["id", "name", "steps", "sendTextAsIs", "excludeThoughts"]);
        for (const item of out.items.slice(2)) {
            expect(Object.hasOwn(item, "excludeThoughts"), item.id).toBe(false);
        }
        expect(Object.keys(out.items[4])).toEqual(["id", "name", "steps", "sendTextAsIs"]);
        expect(Object.keys(out.items[5])).toEqual(["id", "name", "steps"]);
        expectIdempotent(normalizeTranslatorPresets, { items: out.items, selectedId: "on" });
        // A preset the tab turns on with `createTranslatorPreset` is stored as it is.
        const created = createTranslatorPreset("Thoughts", {
            steps: [{ prompt: "{{slot::content}}" }],
            excludeThoughts: true,
        });
        const record = { items: [created], selectedId: created.id };
        const text = serialize(record).text;
        expect(text).toContain('"excludeThoughts":true');
        expect(serialize(normalizeTranslatorPresets(JSON.parse(text))).text).toBe(text);
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

const structuredDefaults = {
    cadence: "everyTurn",
    cadenceTurns: 5,
    cadenceTokens: 4000,
    cadenceRatio: 0.1,
    windowTurns: 3,
    flowEvents: 8,
    laneTargets: { pages: 2000, events: 1500, evidence: 700, threads: 300 },
    requiredCap: 1500,
    screening: { refusal: [], format: [] },
    language: "",
    instructions: "",
    analysisPrompt: "",
    patchPrompt: "",
    fineTuning: false,
    highlightMode: "important",
    highlightKinds: ["create", "contradiction", "delete"],
    highlightChangeGrade: 5,
    volatileBeforeLastUser: false,
};

const structuredCustom = {
    cadence: "tokens",
    cadenceTurns: 1,
    cadenceTokens: 1,
    cadenceRatio: 0.25,
    windowTurns: 1,
    flowEvents: 0,
    laneTargets: { pages: 0, events: 21, evidence: 32, threads: 43 },
    requiredCap: 1,
    screening: { refusal: ["Cannot comply"], format: ["Bad format"] },
    language: "ko",
    instructions: "Keep names",
    analysisPrompt: "Analyze this",
    patchPrompt: "Patch this",
    fineTuning: true,
    highlightMode: "all",
    highlightKinds: ["change", "create"],
    highlightChangeGrade: 9,
    volatileBeforeLastUser: true,
};

describe("Structured Memory settings", () => {
    it("keeps volatile placement opt-in and normalizes it independently of other settings", () => {
        for (const [value, expected] of [
            [true, true],
            [false, false],
            [undefined, false],
            [null, false],
            [1, false],
            ["true", false],
        ] as const) {
            expect(normalizeStructuredMemorySettings({ volatileBeforeLastUser: value, windowTurns: 2 })).toMatchObject({
                volatileBeforeLastUser: expected,
                windowTurns: 2,
            });
        }
        expect(normalizeStructuredMemorySettings(undefined).volatileBeforeLastUser).toBe(false);
    });

    it("fills absent fields and non-object settings with the writer defaults", () => {
        for (const input of [undefined, null, [], "stored text", {}]) {
            expect(normalizeStructuredMemorySettings(input)).toStrictEqual(structuredDefaults);
        }
    });

    it("validates every scalar independently, preserves valid boundaries, and drops unknown keys", () => {
        expect(normalizeStructuredMemorySettings({ ...structuredCustom, unknown: true })).toStrictEqual(
            structuredCustom,
        );
        const invalid: Record<string, unknown[]> = {
            cadence: ["sometimes", "", null, 1],
            cadenceTurns: [0, -1, 1.5, "5", null, NaN, Infinity],
            cadenceTokens: [0, -1, 1.5, "4000", null, NaN, Infinity],
            cadenceRatio: [0, 1, -0.1, 1.1, "0.5", null, NaN, Infinity],
            windowTurns: [0, -1, 1.5, "3", null, NaN, Infinity],
            flowEvents: [-1, 0.5, "8", null, NaN, Infinity],
            requiredCap: [0, -1, 1.5, "1500", null, NaN, Infinity],
            language: [null, 1, [], {}],
            instructions: [null, 1, [], {}],
            analysisPrompt: [null, 1, [], {}],
            patchPrompt: [null, 1, [], {}],
            fineTuning: [null, 0, 1, "true"],
            highlightMode: ["sometimes", "", null, 1],
            highlightChangeGrade: [-1, 10, 0.5, "5", null, NaN, Infinity],
        };
        for (const [key, values] of Object.entries(invalid)) {
            for (const value of [...values, undefined]) {
                expect(
                    normalizeStructuredMemorySettings({ ...structuredCustom, [key]: value }),
                    `${key} = ${value}`,
                ).toStrictEqual({
                    ...structuredCustom,
                    [key]: structuredDefaults[key as keyof typeof structuredDefaults],
                });
            }
        }
        for (const cadence of ["everyTurn", "everyK", "tokens", "manual"]) {
            expect(normalizeStructuredMemorySettings({ ...structuredCustom, cadence })).toStrictEqual({
                ...structuredCustom,
                cadence,
            });
        }
        for (const highlightMode of ["none", "important", "all"]) {
            expect(normalizeStructuredMemorySettings({ ...structuredCustom, highlightMode })).toStrictEqual({
                ...structuredCustom,
                highlightMode,
            });
        }
        expect(
            normalizeStructuredMemorySettings({ ...structuredCustom, cadenceRatio: 0.99, highlightChangeGrade: 0 }),
        ).toStrictEqual({ ...structuredCustom, cadenceRatio: 0.99, highlightChangeGrade: 0 });
    });

    it("validates each lane and screening list without resetting its siblings", () => {
        const lanes = structuredCustom.laneTargets;
        for (const key of ["pages", "events", "evidence", "threads"] as const) {
            expect(
                normalizeStructuredMemorySettings({
                    ...structuredCustom,
                    laneTargets: { ...lanes, [key]: 0, unknown: 1 },
                }),
            ).toStrictEqual({ ...structuredCustom, laneTargets: { ...lanes, [key]: 0 } });
            for (const value of [undefined, null, -1, 0.5, "5", NaN, Infinity]) {
                expect(
                    normalizeStructuredMemorySettings({ ...structuredCustom, laneTargets: { ...lanes, [key]: value } }),
                    `${key} = ${value}`,
                ).toStrictEqual({
                    ...structuredCustom,
                    laneTargets: { ...lanes, [key]: structuredDefaults.laneTargets[key] },
                });
            }
        }
        for (const value of [undefined, null, [], "invalid"]) {
            expect(normalizeStructuredMemorySettings({ ...structuredCustom, laneTargets: value })).toStrictEqual({
                ...structuredCustom,
                laneTargets: structuredDefaults.laneTargets,
            });
            expect(normalizeStructuredMemorySettings({ ...structuredCustom, screening: value })).toStrictEqual({
                ...structuredCustom,
                screening: { refusal: [], format: [] },
            });
            for (const key of ["refusal", "format"] as const) {
                expect(
                    normalizeStructuredMemorySettings({
                        ...structuredCustom,
                        screening: { ...structuredCustom.screening, [key]: value },
                    }),
                ).toStrictEqual({ ...structuredCustom, screening: { ...structuredCustom.screening, [key]: [] } });
            }
        }
        expect(
            normalizeStructuredMemorySettings({
                ...structuredCustom,
                screening: {
                    refusal: ["No", "", 0, null, "No"],
                    format: [false, {}, [], "Wrong format"],
                    unknown: ["drop"],
                },
            }),
        ).toStrictEqual({ ...structuredCustom, screening: { refusal: ["No", "No"], format: ["Wrong format"] } });
    });

    it("keeps known highlight kinds once in their first-occurrence order, drops a stored retract, and preserves an empty selection", () => {
        for (const [input, expected] of [
            [
                ["change", "delete", "create", "change", null, "unknown", "retract", "contradiction", "delete"],
                ["change", "delete", "create", "contradiction"],
            ],
            [[], []],
            [["unknown", 1], []],
            [undefined, ["create", "contradiction", "delete"]],
            [null, ["create", "contradiction", "delete"]],
            ["create", ["create", "contradiction", "delete"]],
        ]) {
            expect(normalizeStructuredMemorySettings({ ...structuredCustom, highlightKinds: input })).toStrictEqual({
                ...structuredCustom,
                highlightKinds: expected,
            });
        }
    });

    it("is idempotent and detaches every list from the input and other results", () => {
        const input = structuredClone(structuredCustom);
        const first = normalizeStructuredMemorySettings(input);
        const second = normalizeStructuredMemorySettings(first);
        expect(second).toStrictEqual(structuredCustom);
        first.screening.refusal.push("New refusal");
        first.screening.format.push("New format");
        first.highlightKinds.push("delete");
        expect(input).toStrictEqual(structuredCustom);
        expect(second).toStrictEqual(structuredCustom);

        const defaults = normalizeStructuredMemorySettings(undefined);
        const otherDefaults = normalizeStructuredMemorySettings(undefined);
        defaults.screening.refusal.push("Changed");
        defaults.screening.format.push("Changed");
        defaults.highlightKinds.length = 0;
        expect(otherDefaults).toStrictEqual(structuredDefaults);
        expect(normalizeStructuredMemorySettings(undefined)).toStrictEqual(structuredDefaults);
    });

    it("reads only non-empty language strings and known highlight overrides", () => {
        for (const value of [undefined, null, "", 0, false, [], {}]) {
            expect(structuredMemoryLanguageOverride({ structuredMemoryLanguage: value })).toBeUndefined();
        }
        expect(structuredMemoryLanguageOverride(undefined)).toBeUndefined();
        expect(structuredMemoryLanguageOverride({})).toBeUndefined();
        expect(structuredMemoryLanguageOverride({ structuredMemoryLanguage: "한국어" })).toBe("한국어");
        for (const value of [undefined, null, "", "unknown", 0, false, [], {}]) {
            expect(structuredMemoryHighlightOverride({ structuredMemoryHighlight: value })).toBeUndefined();
        }
        expect(structuredMemoryHighlightOverride(undefined)).toBeUndefined();
        expect(structuredMemoryHighlightOverride({})).toBeUndefined();
        for (const value of ["none", "important", "all"] as const) {
            expect(structuredMemoryHighlightOverride({ structuredMemoryHighlight: value })).toBe(value);
        }
    });
});

describe.each([
    ["createHypaV3Preset", (settings: object) => createHypaV3Preset("Stored", settings, "stored").settings],
    [
        "normalizeHypaV3Presets",
        (settings: object) =>
            normalizeHypaV3Presets({ items: [{ id: "stored", name: "Stored", settings }], selectedId: "stored" })
                .items[0].settings,
    ],
] as const)("%s Structured Memory settings", (_, read) => {
    const legacySettings = {
        summarizationModel: "otherModel",
        summarizationPrompt: "Summarize",
        reSummarizationPrompt: "Resummarize",
        memoryTokensRatio: 0.3,
        extraSummarizationRatio: 0.1,
        lookaheadHeadroomRatio: 0.2,
        budgetMode: "tokens",
        memoryBudgetTokens: 3000,
        lookaheadHeadroomTokens: 2000,
        extraSummarizationTokens: 1000,
        maxChatsPerSummary: 4,
        recentMemoryRatio: 0.5,
        similarMemoryRatio: 0.6,
        enableSimilarityCorrection: true,
        preserveOrphanedMemory: true,
        processRegexScript: true,
        doNotSummarizeUserMessage: true,
        summaryChunkSeparator: "---",
        useExperimentalImpl: true,
        summarizationRequestsPerMinute: 10,
        summarizationMaxConcurrent: 2,
        embeddingRequestsPerMinute: 50,
        embeddingMaxConcurrent: 3,
        alwaysToggleOn: true,
        queryChatCount: 2,
        gapConfirmTokens: 0,
    };

    it("fills missing writer settings while preserving every existing HypaV3 setting", () => {
        expect(read(legacySettings)).toStrictEqual({ ...legacySettings, structured: structuredDefaults });
    });

    it("normalizes nested writer settings field by field", () => {
        const structured = {
            ...structuredCustom,
            cadenceTurns: 0,
            laneTargets: { pages: -1, events: 2, evidence: 0, threads: 4, unknown: 1 },
            screening: { refusal: ["Refusal", "", false], format: "invalid" },
            highlightKinds: ["change", "create", "change", "unknown"],
            unknown: true,
        };
        const input = { ...legacySettings, structured, unknown: true };
        const expected = {
            ...legacySettings,
            structured: {
                ...structuredCustom,
                cadenceTurns: 5,
                laneTargets: { pages: 2000, events: 2, evidence: 0, threads: 4 },
                screening: { refusal: ["Refusal"], format: [] },
            },
        };
        const first = read(input);
        expect(first).toStrictEqual(expected);
        expect(read(JSON.parse(JSON.stringify(first)))).toStrictEqual(expected);
        for (const value of [undefined, null, [], "invalid"]) {
            expect(read({ ...legacySettings, structured: value })).toStrictEqual({
                ...legacySettings,
                structured: structuredDefaults,
            });
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
        // A stored preset without `budgetMode` stays in ratio mode; only the seeded one is in token mode.
        const defaults = { ...normalizeHypaV3Presets(undefined).items[0].settings, budgetMode: "ratio" };
        expect(out.items[0]).toEqual({ id: "a", name: "A", settings: { ...defaults, memoryTokensRatio: 0.5 } });
        expect(out.items[1]).toEqual({ id: expect.stringMatching(UUID_V4), name: "Preset 2", settings: defaults });
        expect(out.items[2]).toEqual({ id: expect.stringMatching(UUID_V4), name: "Preset 3", settings: defaults });
        expect(out.selectedId).toBe("a");
        expect(normalizeHypaV3Presets({ items: [{ id: "a" }, { id: "b" }], selectedId: "b" }).selectedId).toBe("b");
        for (const input of [{}, { items: null }, { items: [null] }]) {
            rejects(normalizeHypaV3Presets, input, "hypaV3Presets.items must be an array of objects");
        }
    });

    it("gives a settings object with an own `__proto__` key an ordinary prototype and a stable stored form", () => {
        const input = JSON.parse(
            '{"items":[{"id":"p","name":"P","settings":{"__proto__":{"extra":0},"extra":42}}],"selectedId":"p"}',
        );
        const out = normalizeHypaV3Presets(input);
        const settings = out.items[0].settings as unknown as Record<string, unknown>;
        expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
        expect(Object.hasOwn(settings, "__proto__")).toBe(false);
        expect(Object.hasOwn(settings, "extra")).toBe(false);
        expect(settings.extra).toBeUndefined();
        expect(settings).toEqual({ ...normalizeHypaV3Presets(undefined).items[0].settings, budgetMode: "ratio" });
        expectIdempotent(normalizeHypaV3Presets, input);
        expect(Object.hasOwn(Object.prototype, "extra")).toBe(false);
    });
});

describe("personas", () => {
    it("materializes the fresh-boot persona, turns an empty list into it, fills the four fields, and backstops ids", () => {
        const materialized = normalizePersonas(undefined);
        expect(withoutIds(materialized)).toEqual(withoutIds(bootSnapshot.personas));
        expect(materialized[0].id).toMatch(UUID_V4);
        // Never empty (`shared/personas.ts`): a selection always has a record.
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
        const out = normalizePresetCollection([
            { name: "p", temperature: 1, aiModel: "gpt-4o" },
            { id: "keep" },
            { id: "keep" },
        ]);
        expect(out.map((preset) => preset.name)).toEqual(["p", "New Preset", "New Preset"]);
        expect(out[0]).toMatchObject({ temperature: 1 });
        // A prompt preset holds no model field.
        expect(Object.hasOwn(out[0], "aiModel")).toBe(false);
        expect(Object.hasOwn(out[0], "maxContext")).toBe(false);
        expect(out[1].id).toBe("keep");
        expect(out[2].id).toMatch(UUID_V4);
        expectIdempotent(normalizePresetCollection, [{ name: "p" }, { openrouterProvider: "legacy" }]);
        for (const input of [{}, null, "x", [1], [null]]) {
            rejects(normalizePresetCollection, input, "presets must be an array of objects");
        }
    });

    it("keeps a prompt preset's boolean `archived` (list metadata), drops any other value, and leaves an absent one absent", () => {
        // The archive feature (risuai-fastify `ee5382a9a` port): what a tab archives survives the
        // server's normalization and a reload, and a record without the flag is not rewritten for it.
        const out = normalizePresetCollection([
            { id: "a", name: "a", archived: true },
            { id: "b", name: "b", archived: false },
            { id: "c", name: "c", archived: "yes" },
            { id: "d", name: "d", archived: null },
            { id: "e", name: "e" },
        ]);
        expect(out.map((preset) => (Object.hasOwn(preset, "archived") ? preset.archived : "absent"))).toEqual([
            true,
            false,
            "absent",
            "absent",
            "absent",
        ]);
        expectIdempotent(normalizePresetCollection, [
            { id: "a", name: "a", archived: true },
            { id: "e", name: "e" },
        ]);
        // The stored text of a record without the flag is the same with and without this field in the schema.
        const stored = serialize(normalizePresetCollection([{ id: "e", name: "e" }]));
        expect(stored.text).not.toContain("archived");
    });
});

describe("modelPresets", () => {
    it("materializes one default model preset, gives every element the slot fields and an id, and rejects a non-list", () => {
        const defaultSlots = {
            mainSlot: { profileId: "default" },
            subSlot: { profileId: "default" },
            auxSlots: {},
            seperateModelsForAxModels: false,
        };
        for (const input of [undefined, []]) {
            const out = normalizeModelPresetCollection(input);
            expect(out).toHaveLength(1);
            expect(out[0]).toEqual({ id: expect.stringMatching(UUID_V4), name: "New Model Preset", ...defaultSlots });
        }
        const out = normalizeModelPresetCollection([
            {
                name: "m",
                auxSlots: { memory: { profileId: "p" } },
                seperateModelsForAxModels: true,
                maxContext: 1,
                aiModel: "gpt",
                apiType: "gpt",
                temperature: 5,
                proxyKey: "leak",
                proxyCredentialId: "c1",
            },
            { id: "keep" },
            { id: "keep" },
        ]);
        expect(out.map((preset) => preset.name)).toEqual(["m", "New Model Preset", "New Model Preset"]);
        expect(out[0]).toMatchObject({ auxSlots: { memory: { profileId: "p" } }, seperateModelsForAxModels: true });
        // A model preset holds only its slot choices: no prompt field, profile field, credential, or image.
        for (const field of [
            "temperature",
            "proxyKey",
            "proxyCredentialId",
            "apiType",
            "aiModel",
            "maxContext",
            "image",
            "mainPrompt",
        ]) {
            expect(Object.hasOwn(out[0], field), field).toBe(false);
        }
        expect(out[1].id).toBe("keep");
        expect(out[2].id).toMatch(UUID_V4);
        expectIdempotent(normalizeModelPresetCollection, [{ name: "m" }, { openrouterProvider: "legacy" }]);
        for (const input of [{}, null, "x", [1], [null]]) {
            rejects(normalizeModelPresetCollection, input, "modelPresets must be an array of objects");
        }
    });
});
