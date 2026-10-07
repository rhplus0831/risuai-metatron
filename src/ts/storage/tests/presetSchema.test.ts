// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Database } from "../../../../shared/database.ts";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import { isRecordId, newId } from "../../../../shared/ids.ts";
import {
    newPersonaId,
    newPresetId,
    normalizePreset,
    normalizePresets,
    PERSONA_ROOT_ALIASES,
    PRESET_DEFAULTS,
    PRESET_FIELDS,
    PRESET_KEEP_ON_SWITCH_FIELDS,
    PRESET_NULLABLE_FIELDS,
    PRESET_ROOT_ALIASES,
    defaultOoba,
    presetTemplate,
    type PresetField,
} from "../../../../shared/presets.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    DROPPED_FIELDS,
    FORWARDED_PRESET_KEYS,
    FORWARDED_ROOT_KEYS,
    PERSONA_ROOT_KEYS,
    PHASE1_FIELDS,
    SECTION_FIELDS,
    SECTION_KIND,
    SELECTION_KEYS,
    type CollectionKind,
    type SectionKind,
} from "../../../../shared/sections.ts";
import { createTranslatorPreset } from "../../../../shared/translatorPresets.ts";

// Phase 3, slice 2 (`docs/plan/phases/slices/phase-3-settings-sections/shared-schema-and-ids.md`,
// "Review-step tests"): the canonical preset schema, its normalizer, the id helpers, and the
// field-to-resource partition. Everything here is pure `shared/` code, so the file runs in node.

const fixtureDir = path.resolve(import.meta.dirname, "fixtures/phase3");
const bootSnapshot = JSON.parse(readFileSync(path.join(fixtureDir, "boot-snapshot.json"), "utf-8")) as Record<
    string,
    unknown
>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const presetToRootName: Record<string, string> = Object.fromEntries(
    Object.entries(PRESET_ROOT_ALIASES).map(([root, preset]) => [preset, root]),
);

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
        for (const inner of Object.values(value as object)) {
            deepFreeze(inner);
        }
        Object.freeze(value);
    }
    return value;
}

describe("PRESET_DEFAULTS", () => {
    it("equals the fresh-boot fixture for every preset field the fixture has (through the root aliases)", () => {
        const compared: string[] = [];
        for (const field of PRESET_FIELDS) {
            if (field === "name" || field === "image") {
                continue; // preset-only fields, no root mirror
            }
            const rootName = presetToRootName[field] ?? field;
            if (!Object.hasOwn(bootSnapshot, rootName)) {
                continue;
            }
            compared.push(field);
            expect(PRESET_DEFAULTS[field], `${field} (root ${rootName})`).toEqual(bootSnapshot[rootName]);
        }
        // The comparison is not vacuous: the snapshot covers the bulk of the schema, including the
        // three aliased fields and the values that differ from `presetTemplate`.
        expect(compared.length).toBeGreaterThan(50);
        expect(compared).toEqual(expect.arrayContaining(["NAISettings", "reasonEffort", "regex", "maxResponse"]));
        expect(PRESET_DEFAULTS.maxResponse).toBe(500);
        expect(presetTemplate.maxResponse).toBe(300);
    });

    it("lists no credential or global field and exactly the documented unset fields", () => {
        expect(PRESET_FIELDS).not.toContain("id");
        expect(PRESET_FIELDS).not.toContain("openAIKey");
        expect(PRESET_FIELDS).not.toContain("forceReplaceUrl2");
        expect(PRESET_FIELDS).not.toContain("autoSuggestPrefix");
        expect(PRESET_FIELDS).not.toContain("autoSuggestClean");
        // Slice 7: both LLM credentials live in `llmSecrets` (`proxyKey` by preset id), so neither is a preset field.
        expect(PRESET_FIELDS).not.toContain("proxyKey");
        const unset = PRESET_FIELDS.filter((field) => PRESET_DEFAULTS[field] === undefined).sort();
        expect(unset).toEqual([
            "koboldURL",
            "localStopStrings",
            "promptPreprocess",
            "promptTemplate",
            "proxyRequestModel",
        ]);
    });
});

describe("normalizePreset", () => {
    it("fills an empty input with the defaults plus a v4 id, and never the keep-on-switch or unset fields", () => {
        const preset = normalizePreset({}) as unknown as Record<string, unknown>;
        expect(preset.id).toMatch(UUID_V4);
        for (const field of PRESET_FIELDS) {
            const fallback = PRESET_DEFAULTS[field];
            if (fallback === undefined || (PRESET_KEEP_ON_SWITCH_FIELDS as readonly string[]).includes(field)) {
                expect(Object.hasOwn(preset, field), field).toBe(false);
            } else {
                expect(preset[field], field).toEqual(fallback);
            }
        }
        expect(Object.keys(preset).sort()).toEqual(
            [
                "id",
                ...PRESET_FIELDS.filter(
                    (field) =>
                        PRESET_DEFAULTS[field] !== undefined &&
                        !(PRESET_KEEP_ON_SWITCH_FIELDS as readonly string[]).includes(field),
                ),
            ].sort(),
        );
        expect(preset.name).toBe("New Preset");
    });

    it("returns fresh copies of the defaults", () => {
        const a = normalizePreset({});
        const b = normalizePreset({});
        expect(a.formatingOrder).toEqual(b.formatingOrder);
        expect(a.formatingOrder).not.toBe(b.formatingOrder);
        expect(a.ooba).not.toBe(PRESET_DEFAULTS.ooba);
        expect(a.NAISettings).not.toBe(PRESET_DEFAULTS.NAISettings);
    });

    it("keeps only the canonical fields: extra, credential, and legacy global keys are dropped", () => {
        const preset = normalizePreset({
            name: "p",
            openAIKey: "sk-secret",
            forceReplaceUrl2: "https://x",
            autoSuggestPrefix: "pre",
            autoSuggestClean: true,
            somethingElse: 1,
            presetVersion: 2,
        }) as unknown as Record<string, unknown>;
        expect(preset.name).toBe("p");
        for (const dropped of [
            "openAIKey",
            "forceReplaceUrl2",
            "autoSuggestPrefix",
            "autoSuggestClean",
            "somethingElse",
            "presetVersion",
        ]) {
            expect(Object.hasOwn(preset, dropped), dropped).toBe(false);
        }
    });

    it("keeps an explicit null and fills only absent or undefined fields (Astra challenge points 1 and 2)", () => {
        const withNulls = normalizePreset({
            min_p: null,
            top_a: null,
            repetition_penalty: null,
            thinkingTokens: null,
            seperateModels: null,
            fallbackModels: null,
            promptTemplate: null,
        });
        expect(withNulls.min_p).toBeNull();
        expect(withNulls.top_a).toBeNull();
        expect(withNulls.repetition_penalty).toBeNull();
        expect(withNulls.thinkingTokens).toBeNull();
        expect(Object.hasOwn(withNulls, "seperateModels")).toBe(true);
        expect(withNulls.seperateModels).toBeNull();
        expect(withNulls.fallbackModels).toBeNull();
        expect(withNulls.promptTemplate).toBeNull();

        const withUndefined = normalizePreset({ min_p: undefined, top_a: undefined, repetition_penalty: undefined });
        expect(withUndefined.min_p).toBe(0);
        expect(withUndefined.top_a).toBe(0);
        expect(withUndefined.repetition_penalty).toBe(1);

        const omitted = normalizePreset({ name: "x" });
        expect(omitted.min_p).toBe(0);
        expect(omitted.top_a).toBe(0);
        expect(omitted.repetition_penalty).toBe(1);
    });

    it("keeps a present keep-on-switch value and leaves an absent one to setPreset's fallback", () => {
        const present = normalizePreset({
            seperateModels: { memory: "m", emotion: "e", translate: "t", otherAx: "o" },
            seperateModelsForAxModels: true,
            fallbackModels: { model: ["a", ""], memory: [], emotion: [], translate: [], otherAx: [] },
            fallbackWhenBlankResponse: true,
            seperateParameters: { memory: { temperature: 1 }, emotion: {}, translate: {}, otherAx: {} },
        });
        expect(present.seperateModels).toEqual({ memory: "m", emotion: "e", translate: "t", otherAx: "o" });
        expect(present.seperateModelsForAxModels).toBe(true);
        expect(present.fallbackModels).toEqual({ model: ["a"], memory: [], emotion: [], translate: [], otherAx: [] });
        expect(present.fallbackWhenBlankResponse).toBe(true);
        expect(present.seperateParameters).toEqual({
            memory: { temperature: 1 },
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: {},
        });

        const absent = normalizePreset({ name: "x" }) as unknown as Record<string, unknown>;
        for (const field of PRESET_KEEP_ON_SWITCH_FIELDS) {
            expect(Object.hasOwn(absent, field), field).toBe(false);
        }
    });

    it("applies the migrations setDatabase and setPreset applied to the root copy", () => {
        const preset = normalizePreset({
            NAISettings: { topK: 1 },
            promptSettings: { assistantPrefill: "a" },
            formatingOrder: ["description", "main", "chats"],
            top_p: "0.9",
            localNetworkMode: "yes",
            localNetworkTimeoutSec: Number.NaN,
            seperateParameters: { memory: {}, emotion: {}, translate: {}, otherAx: {} },
            fallbackModels: { model: ["", "gpt"], memory: "nope" },
            openrouterProvider: "DeepInfra",
            promptTemplate: [
                { type: "plain", type2: "main", text: "t", role: "assistant" },
                { type: "cot", text: "c", role: "char" },
                { type: "persona", role2: "assistant" },
                { type: "cache", role: "bot" },
                { type: "cache", role: "nonsense" },
                { type: "description" },
            ],
        }) as any;
        expect(preset.NAISettings).toEqual({ topK: 1, starter: "", cfg_scale: 1, mirostat_tau: 0, mirostat_lr: 1 });
        expect(preset.promptSettings).toEqual({ assistantPrefill: "a", maxThoughtTagDepth: -1 });
        expect(preset.formatingOrder).toEqual(["description", "personaPrompt", "main", "chats"]);
        expect(preset.top_p).toBe(1);
        expect(preset.localNetworkMode).toBe(false);
        expect(preset.localNetworkTimeoutSec).toBe(600);
        expect(preset.seperateParameters.overrides).toEqual({});
        expect(preset.fallbackModels).toEqual({ model: ["gpt"], memory: [], emotion: [], translate: [], otherAx: [] });
        expect(preset.openrouterProvider).toEqual({ order: ["DeepInfra"], only: [], ignore: [] });
        expect(preset.promptTemplate).toEqual([
            { type: "plain", type2: "main", text: "t", role: "bot" },
            { type: "cot", text: "c", role: "bot" },
            { type: "persona", role2: "bot" },
            { type: "cache", role: "assistant" },
            { type: "cache", role: "all" },
            { type: "description" },
        ]);

        expect(normalizePreset({ openrouterProvider: "" }).openrouterProvider).toEqual({
            order: [],
            only: [],
            ignore: [],
        });
        expect(normalizePreset({ formatingOrder: ["main", "personaPrompt"] }).formatingOrder).toEqual([
            "main",
            "personaPrompt",
        ]);
    });

    it("keeps a valid id, lets options.id win, and assigns a new one otherwise", () => {
        expect(normalizePreset({ id: "keep-me" }).id).toBe("keep-me");
        expect(normalizePreset({ id: "keep-me" }, { id: "override" }).id).toBe("override");
        expect(normalizePreset({ id: "" }).id).toMatch(UUID_V4);
        expect(normalizePreset({ id: 42 }).id).toMatch(UUID_V4);
        expect(normalizePreset(null).id).toMatch(UUID_V4);
        expect(normalizePreset([1, 2]).id).toMatch(UUID_V4);
        expect(normalizePreset("text").id).toMatch(UUID_V4);
    });

    it("never mutates its input", () => {
        const input = deepFreeze({
            id: "frozen",
            name: "frozen",
            NAISettings: { topK: 1 },
            promptSettings: {},
            formatingOrder: ["main"],
            seperateParameters: { memory: {}, emotion: {}, translate: {}, otherAx: {} },
            fallbackModels: { model: [""], memory: [], emotion: [], translate: [], otherAx: [] },
            openrouterProvider: "x",
            promptTemplate: [{ type: "plain", role: "assistant" }],
            extra: { nested: true },
        });
        const before = JSON.stringify(input);
        const output = normalizePreset(input) as any;
        expect(JSON.stringify(input)).toBe(before);
        expect(output.NAISettings).not.toBe(input.NAISettings);
        expect(output.formatingOrder).toEqual(["personaPrompt", "main"]);
        expect(input.formatingOrder).toEqual(["main"]);
    });
});

describe("normalizePresets", () => {
    it("turns a non-array or empty input into one default preset", () => {
        for (const input of [undefined, null, [], "x", {}]) {
            const presets = normalizePresets(input);
            expect(presets).toHaveLength(1);
            expect(presets[0].id).toMatch(UUID_V4);
            expect(presets[0].name).toBe("New Preset");
            expect(presets[0].maxResponse).toBe(500);
        }
    });

    it("keeps unique ids, assigns missing ones, and re-keys a duplicate (the first occurrence keeps it)", () => {
        const presets = normalizePresets([
            { id: "a", name: "first" },
            { name: "no id" },
            { id: "a", name: "duplicate" },
            { id: "b", name: "second" },
            { id: "b", name: "duplicate b" },
        ]);
        expect(presets.map((preset) => preset.name)).toEqual(["first", "no id", "duplicate", "second", "duplicate b"]);
        expect(presets[0].id).toBe("a");
        expect(presets[1].id).toMatch(UUID_V4);
        expect(presets[2].id).toMatch(UUID_V4);
        expect(presets[2].id).not.toBe("a");
        expect(presets[3].id).toBe("b");
        expect(presets[4].id).not.toBe("b");
        expect(new Set(presets.map((preset) => preset.id)).size).toBe(5);
    });

    it("is idempotent: a normalized list normalizes to itself", () => {
        const once = normalizePresets([{ id: "a", name: "x", min_p: null }, { name: "y" }]);
        const twice = normalizePresets(JSON.parse(JSON.stringify(once)));
        expect(twice).toEqual(once);
    });
});

describe("ids", () => {
    it("newId is a lower-case v4 UUID and unique, and the preset and persona helpers use it", () => {
        const ids = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            const id = newId();
            expect(id).toMatch(UUID_V4);
            ids.add(id);
        }
        expect(ids.size).toBe(1000);
        expect(newPresetId()).toMatch(UUID_V4);
        expect(newPersonaId()).toMatch(UUID_V4);
    });

    it("isRecordId accepts only a non-empty string", () => {
        expect(isRecordId("x")).toBe(true);
        expect(isRecordId("")).toBe(false);
        expect(isRecordId(1)).toBe(false);
        expect(isRecordId(null)).toBe(false);
        expect(isRecordId(undefined)).toBe(false);
    });

    it("createTranslatorPreset keeps a valid id and assigns one otherwise", () => {
        expect(createTranslatorPreset("n", { id: "keep", prompt: "p", maxResponse: 5 })).toEqual({
            id: "keep",
            name: "n",
            prompt: "p",
            maxResponse: 5,
        });
        expect(createTranslatorPreset("n", { id: "" }).id).toMatch(UUID_V4);
        expect(createTranslatorPreset().id).toMatch(UUID_V4);
        expect(createTranslatorPreset("n", { id: 3 as unknown as string }).id).toMatch(UUID_V4);
    });

    it("createHypaV3Preset keeps a valid id and assigns one otherwise", () => {
        const kept = createHypaV3Preset("n", { memoryTokensRatio: 0.5, unknown: 1 }, "keep");
        expect(kept.id).toBe("keep");
        expect(kept.name).toBe("n");
        expect(kept.settings.memoryTokensRatio).toBe(0.5);
        expect("unknown" in kept.settings).toBe(false);
        expect(createHypaV3Preset("n", {}, "").id).toMatch(UUID_V4);
        expect(createHypaV3Preset("n", {}, 7).id).toMatch(UUID_V4);
        expect(createHypaV3Preset().id).toMatch(UUID_V4);
        expect(createHypaV3Preset().id).not.toBe(createHypaV3Preset().id);
    });
});

// The partition (slice 2 "Proposed decisions", plan amendments A2 and A3; slices 5 and 6 forwarded
// the whole root): the five sections, the twelve collections with their two selection fields, the
// forwarded root keys (served by the client forwarding layer, never stored), the dropped fields, and
// the Phase 1 fields cover `keyof Database` exactly once. The type-level half below is checked by
// `pnpm check`; the runtime half checks the counts derived from the lists and the keys the
// maintained fresh-boot fixture actually holds.

type KeepOnSwitch = (typeof PRESET_KEEP_ON_SWITCH_FIELDS)[number];
type PresetRootName<F extends PresetField> = F extends "NAISettings"
    ? "NAIsettings"
    : F extends "reasonEffort"
      ? "reasoningEffort"
      : F extends "regex"
        ? "presetRegex"
        : F;
type ForwardedPresetKey = {
    [F in PresetField]: F extends "name" | "image" | "proxyKey" | KeepOnSwitch ? never : PresetRootName<F>;
}[PresetField];
// `FORWARDED_ROOT_KEYS` is typed `keyof Database`, so its members are spelled out here from the
// lists it is built from.
type ForwardedRootKey =
    ForwardedPresetKey | "proxyKey" | keyof typeof PERSONA_ROOT_ALIASES | (typeof SELECTION_KEYS)[number];
type ListedKey =
    | (typeof SECTION_FIELDS)[SectionKind][number]
    | (typeof COLLECTION_FIELDS)[CollectionKind]
    | (typeof COLLECTION_SELECTION_FIELDS)[keyof typeof COLLECTION_SELECTION_FIELDS]
    | ForwardedRootKey
    | (typeof DROPPED_FIELDS)[number]
    | (typeof PHASE1_FIELDS)[number];
type UnlistedDatabaseKey = Exclude<keyof Database, ListedKey>;
type NotADatabaseKey = Exclude<ListedKey, keyof Database>;
// Both resolve to `never` when the lists partition `keyof Database`; a new `Database` field that
// no list names, or a listed name that is not a `Database` field, fails `pnpm check` here.
const everyDatabaseKeyIsListed: [UnlistedDatabaseKey] extends [never] ? true : false = true;
const everyListedKeyIsADatabaseKey: [NotADatabaseKey] extends [never] ? true : false = true;

describe("field-to-resource partition", () => {
    const sectionKeys = Object.values(SECTION_FIELDS).flat() as string[];
    const collectionKeys = Object.values(COLLECTION_FIELDS) as string[];
    const selectionFields = Object.values(COLLECTION_SELECTION_FIELDS) as string[];
    const allLists: [string, readonly string[]][] = [
        ["sections", sectionKeys],
        ["collections", collectionKeys],
        ["collection selections", selectionFields],
        ["forwarded root", FORWARDED_ROOT_KEYS],
        ["dropped", DROPPED_FIELDS],
        ["phase 1", PHASE1_FIELDS],
    ];
    const union = allLists.flatMap(([, keys]) => keys);

    it("is checked at the type level too", () => {
        expect(everyDatabaseKeyIsListed).toBe(true);
        expect(everyListedKeyIsADatabaseKey).toBe(true);
    });

    it("names every key exactly once across the lists", () => {
        const counts = new Map<string, number>();
        for (const key of union) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const duplicates = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
        expect(duplicates).toEqual([]);
        expect(union.length).toBe(counts.size);
        for (const [name, keys] of allLists) {
            expect(new Set(keys).size, name).toBe(keys.length);
        }
    });

    it("covers every key of the fresh-boot fixture", () => {
        const listed = new Set(union);
        const unlisted = Object.keys(bootSnapshot).filter((key) => !listed.has(key));
        expect(unlisted).toEqual([]);
    });

    it("derives the forwarded list from the preset schema: 69 preset keys, proxyKey, 4 persona keys, and 3 selections are forwarded; nothing remains in root", () => {
        // `proxyKey` is not a preset field since slice 7, so `name` and `image` are the only exclusions
        // besides the keep-on-switch group.
        const notForwarded = new Set<string>(["name", "image", ...PRESET_KEEP_ON_SWITCH_FIELDS]);
        const expectedForwarded = PRESET_FIELDS.filter((field) => !notForwarded.has(field)).map(
            (field) => presetToRootName[field] ?? field,
        );
        expect(FORWARDED_PRESET_KEYS).toEqual(expectedForwarded);
        expect(FORWARDED_PRESET_KEYS).toHaveLength(PRESET_FIELDS.length - 2 - PRESET_KEEP_ON_SWITCH_FIELDS.length);
        expect(FORWARDED_PRESET_KEYS).toHaveLength(69);
        // The aliases appear under their root names, never their preset names.
        expect(FORWARDED_PRESET_KEYS).toEqual(
            expect.arrayContaining(["NAIsettings", "reasoningEffort", "presetRegex"]),
        );
        expect(FORWARDED_PRESET_KEYS).not.toContain("NAISettings");
        expect(FORWARDED_PRESET_KEYS).not.toContain("reasonEffort");
        expect(FORWARDED_PRESET_KEYS).not.toContain("regex");
        expect(FORWARDED_PRESET_KEYS).not.toContain("proxyKey");

        expect(PERSONA_ROOT_KEYS).toEqual(["username", "userIcon", "userNote", "personaPrompt"]);
        expect(PERSONA_ROOT_ALIASES).toEqual({
            username: "name",
            userIcon: "icon",
            userNote: "note",
            personaPrompt: "personaPrompt",
        });
        expect(SELECTION_KEYS).toEqual(["botPresetsId", "selectedPersona", "loreBookPage"]);
        // Slice 6: the persona keys and all three selections are forwarded; no residual root is left.
        expect(FORWARDED_ROOT_KEYS).toEqual([
            ...FORWARDED_PRESET_KEYS,
            "proxyKey",
            ...PERSONA_ROOT_KEYS,
            ...SELECTION_KEYS,
        ]);
        expect(FORWARDED_ROOT_KEYS).toHaveLength(69 + 1 + 4 + 3);
    });

    it("places the review corrections: keep-on-switch in providers, auto-suggest in ui, supaMemoryKey in llmSecrets, hypaMemoryKey dropped", () => {
        for (const field of PRESET_KEEP_ON_SWITCH_FIELDS) {
            expect(SECTION_FIELDS.providers, field).toContain(field);
        }
        expect(SECTION_FIELDS.providers).toEqual(
            expect.arrayContaining([
                "doNotChangeSeperateModels",
                "doNotChangeFallbackModels",
                "disableSeperateParameterChangeOnPresetChange",
            ]),
        );
        expect(SECTION_FIELDS.ui).toEqual(expect.arrayContaining(["autoSuggestPrefix", "autoSuggestClean"]));
        expect(SECTION_FIELDS.llmSecrets).toContain("supaMemoryKey");
        expect(SECTION_FIELDS.llmSecrets).toContain("openAIKey");
        expect(DROPPED_FIELDS).toContain("hypaMemoryKey");
        expect(sectionKeys).not.toContain("statics");
        expect(COLLECTION_FIELDS.statics).toBe("statics");
    });

    it("lists five sections and twelve collections, two of them with a selection field", () => {
        expect(Object.keys(SECTION_KIND)).toHaveLength(5);
        expect(Object.keys(SECTION_FIELDS).sort()).toEqual(Object.keys(SECTION_KIND).sort());
        expect(Object.keys(COLLECTION_KIND)).toHaveLength(12);
        expect(Object.keys(COLLECTION_FIELDS).sort()).toEqual(Object.keys(COLLECTION_KIND).sort());
        expect(COLLECTION_SELECTION_FIELDS).toEqual({
            translatorPresets: "translatorPresetId",
            hypaV3Presets: "hypaV3PresetId",
        });
        // Its own literal since slice 6 (`ROOT_EXCLUDED_KEYS` went with the `root` resource).
        expect(PHASE1_FIELDS).toEqual(["characters", "botPresets", "modules", "plugins", "pluginCustomStorage"]);
    });
});

// Slice 5 (`forwarding-presets-and-selection.md`, "Missing and null values"): `normalizePreset` keeps an
// explicit `null` only where it is a value the readers handle (`PRESET_NULLABLE_FIELDS`) or in a
// keep-on-switch field (`saveCurrentPreset` writes `seperateModels: null` on purpose); any other
// `null` gets the default, as `setPreset` gave the root working copy before Phase 3. The server
// `presets` normalizer runs the same function, so a cleared number comes back as its default after
// a reload. This replaces slice 2's rule, which kept every `null` (Astra challenge point 4).
describe("null canonicalization", () => {
    it("lists the nullable fields as preset fields outside the keep-on-switch set", () => {
        expect(PRESET_NULLABLE_FIELDS).toEqual([
            "promptTemplate",
            "NAIadventure",
            "NAIappendName",
            "localStopStrings",
            "repetition_penalty",
            "min_p",
            "top_a",
            "openrouterProvider",
            "thinkingTokens",
            "dynamicOutput",
        ]);
        for (const field of PRESET_NULLABLE_FIELDS) {
            expect(PRESET_FIELDS, field).toContain(field);
            expect(PRESET_KEEP_ON_SWITCH_FIELDS as readonly string[], field).not.toContain(field);
        }
    });

    it("keeps a null in a nullable or keep-on-switch field and gives any other null its default", () => {
        const preset = normalizePreset({
            id: "nulls",
            // Nullable: kept.
            promptTemplate: null,
            min_p: null,
            repetition_penalty: null,
            top_a: null,
            thinkingTokens: null,
            openrouterProvider: null,
            dynamicOutput: null,
            NAIadventure: null,
            // Keep-on-switch: kept.
            seperateModels: null,
            fallbackModels: null,
            // Anything else: the default, scalars and containers alike.
            maxResponse: null,
            temperature: null,
            mainPrompt: null,
            ooba: null,
            promptSettings: null,
            formatingOrder: null,
            systemContentReplacement: null,
            JinjaTemplate: null,
            NAISettings: null,
        }) as unknown as Record<string, unknown>;
        for (const field of ["promptTemplate", "min_p", "repetition_penalty", "top_a", "thinkingTokens"]) {
            expect(preset[field], field).toBeNull();
        }
        expect(preset.openrouterProvider).toBeNull();
        expect(preset.dynamicOutput).toBeNull();
        expect(preset.NAIadventure).toBeNull();
        expect(preset.seperateModels).toBeNull();
        expect(preset.fallbackModels).toBeNull();

        expect(preset.maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(preset.temperature).toBe(PRESET_DEFAULTS.temperature);
        expect(preset.mainPrompt).toBe(PRESET_DEFAULTS.mainPrompt);
        expect(preset.ooba).toEqual(defaultOoba);
        expect(preset.promptSettings).toEqual(PRESET_DEFAULTS.promptSettings);
        expect(preset.formatingOrder).toEqual(PRESET_DEFAULTS.formatingOrder);
        expect(preset.systemContentReplacement).toBe("system: {{slot}}");
        expect(preset.JinjaTemplate).toBe("");
        expect(preset.NAISettings).toEqual(PRESET_DEFAULTS.NAISettings);
        // A fresh copy of the default, never the shared default object.
        expect(preset.ooba).not.toBe(defaultOoba);
        expect(preset.promptSettings).not.toBe(PRESET_DEFAULTS.promptSettings);
    });

    it("is what the server presets normalizer stores, and a fixed point of itself", async () => {
        // Loaded at run time through a computed specifier, like `storeBackedServer.ts`: the client
        // `tsconfig.json` must not type-check the strict server sources.
        const { normalizePresetCollection } = (await import(
            /* @vite-ignore */ `${"../../../../server/src/data/normalize/"}presets.ts`
        )) as { normalizePresetCollection: (input: unknown) => Record<string, unknown>[] };
        const stored = normalizePresetCollection([{ id: "nulls", maxResponse: null, ooba: null, min_p: null }]);
        expect(stored).toHaveLength(1);
        expect(stored[0].maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(stored[0].ooba).toEqual(defaultOoba);
        expect(stored[0].min_p).toBeNull();
        expect(normalizePresets(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    });
});
