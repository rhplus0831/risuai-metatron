// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Database } from "../../../../shared/database.ts";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import { isRecordId, newId } from "../../../../shared/ids.ts";
import {
    MODEL_PRESET_DEFAULT_NAME,
    MODEL_PRESET_FIELDS,
    newPersonaId,
    newPresetId,
    normalizeModelPreset,
    normalizeModelPresets,
    normalizePreset,
    normalizePresets,
    PERSONA_ROOT_ALIASES,
    PRESET_DEFAULTS,
    PRESET_FIELDS,
    PRESET_NULLABLE_FIELDS,
    PRESET_RECORD_FIELDS,
    PRESET_ROOT_ALIASES,
    presetFieldOwner,
    PROMPT_PRESET_FIELDS,
    defaultOoba,
    presetTemplate,
    type ModelPresetField,
    type PresetField,
    type PromptPresetField,
} from "../../../../shared/presets.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    DROPPED_FIELDS,
    FORWARDED_MODEL_PRESET_KEYS,
    FORWARDED_PRESET_KEYS,
    FORWARDED_ROOT_KEYS,
    forwardPresetRoots,
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
// "Review-step tests"): the canonical preset schema, its normalizers, the id helpers, and the
// field-to-resource partition; since the preset split (`docs/plan/split-preset.md`) the schema is
// one table with two owners, the prompt preset (`presets`) and the model preset (`modelPresets`),
// each normalized to its own fields. Everything here is pure `shared/` code, so the file runs in node.

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
        // Slice 7: both LLM credentials live in `llmSecrets` (`proxyKey` by model preset id), so neither is a preset field.
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

const modelFields = new Set<string>(MODEL_PRESET_FIELDS);
const promptRecordFields: readonly PresetField[] = [...PRESET_RECORD_FIELDS, ...PROMPT_PRESET_FIELDS];
const modelRecordFields: readonly PresetField[] = ["name", ...MODEL_PRESET_FIELDS];

describe("normalizePreset", () => {
    it("fills an empty input with the prompt fields' defaults plus a v4 id, and never a model or unset field", () => {
        const preset = normalizePreset({}) as unknown as Record<string, unknown>;
        expect(preset.id).toMatch(UUID_V4);
        for (const field of PRESET_FIELDS) {
            const fallback = PRESET_DEFAULTS[field];
            if (fallback === undefined || modelFields.has(field)) {
                expect(Object.hasOwn(preset, field), field).toBe(false);
            } else {
                expect(preset[field], field).toEqual(fallback);
            }
        }
        expect(Object.keys(preset).sort()).toEqual(
            ["id", ...promptRecordFields.filter((field) => PRESET_DEFAULTS[field] !== undefined)].sort(),
        );
        expect(preset.name).toBe("New Preset");
    });

    it("drops every model field an old file or record carries, whatever its value (the prompt preset stores only its own)", () => {
        const legacy: Record<string, unknown> = { name: "old" };
        for (const field of MODEL_PRESET_FIELDS) {
            legacy[field] = PRESET_DEFAULTS[field] ?? "set";
        }
        legacy.maxContext = 123456;
        legacy.aiModel = "gpt-x";
        const preset = normalizePreset(legacy) as unknown as Record<string, unknown>;
        for (const field of MODEL_PRESET_FIELDS) {
            expect(Object.hasOwn(preset, field), field).toBe(false);
        }
        expect(preset.name).toBe("old");
        // The stored shapes are disjoint: no key but `id` and `name` is in both records.
        const model = normalizeModelPreset(legacy) as unknown as Record<string, unknown>;
        const shared = Object.keys(preset).filter((key) => Object.hasOwn(model, key));
        expect(shared.sort()).toEqual(["id", "name"]);
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
            promptTemplate: null,
        });
        expect(withNulls.min_p).toBeNull();
        expect(withNulls.top_a).toBeNull();
        expect(withNulls.repetition_penalty).toBeNull();
        expect(withNulls.thinkingTokens).toBeNull();
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

    it("treats the former keep-on-switch fields as ordinary fields of their owners: filled with their defaults, a null replaced", () => {
        // `seperateParameters` is the prompt preset's; the auxiliary and fallback four the model preset's.
        const present = normalizePreset({
            seperateParameters: { memory: { temperature: 1 }, emotion: {}, translate: {}, otherAx: {} },
        });
        expect(present.seperateParameters).toEqual({
            memory: { temperature: 1 },
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: {},
        });
        const absent = normalizePreset({ name: "x" });
        expect(absent.seperateParameters).toEqual(PRESET_DEFAULTS.seperateParameters);
        expect(normalizePreset({ seperateParameters: null }).seperateParameters).toEqual(
            PRESET_DEFAULTS.seperateParameters,
        );

        const model = normalizeModelPreset({
            seperateModels: { memory: "m", emotion: "e", translate: "t", otherAx: "o" },
            seperateModelsForAxModels: true,
            fallbackModels: { model: ["a", ""], memory: [], emotion: [], translate: [], otherAx: [] },
            fallbackWhenBlankResponse: true,
        });
        expect(model.seperateModels).toEqual({ memory: "m", emotion: "e", translate: "t", otherAx: "o" });
        expect(model.seperateModelsForAxModels).toBe(true);
        expect(model.fallbackModels).toEqual({ model: ["a"], memory: [], emotion: [], translate: [], otherAx: [] });
        expect(model.fallbackWhenBlankResponse).toBe(true);
        const modelAbsent = normalizeModelPreset({ name: "x" });
        expect(modelAbsent.seperateModels).toEqual(PRESET_DEFAULTS.seperateModels);
        expect(modelAbsent.seperateModelsForAxModels).toBe(false);
        expect(modelAbsent.fallbackModels).toEqual(PRESET_DEFAULTS.fallbackModels);
        expect(modelAbsent.fallbackWhenBlankResponse).toBe(false);
        // A `null` was `saveCurrentPreset`'s "keep" marker; it is the default now, never stored.
        expect(normalizeModelPreset({ seperateModels: null, fallbackModels: null }).seperateModels).toEqual(
            PRESET_DEFAULTS.seperateModels,
        );
    });

    it("applies the migrations setDatabase and setPreset applied to the root copy, each on the record that owns the field", () => {
        const legacy = {
            NAISettings: { topK: 1 },
            promptSettings: { assistantPrefill: "a" },
            formatingOrder: ["description", "main", "chats"],
            top_p: "0.9",
            localNetworkMode: "yes",
            localNetworkTimeoutSec: Number.NaN,
            seperateParameters: { memory: {}, emotion: {}, translate: {}, otherAx: {} },
            fallbackModels: { model: ["", "gpt"], memory: "nope" },
            openrouterProvider: "DeepInfra",
        };
        const preset = normalizePreset({
            ...legacy,
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
        expect(preset.seperateParameters.overrides).toEqual({});
        // The model-owned migrations run on the model preset, and never put the field on the prompt preset.
        for (const field of ["localNetworkMode", "localNetworkTimeoutSec", "fallbackModels", "openrouterProvider"]) {
            expect(Object.hasOwn(preset, field), field).toBe(false);
        }
        const model = normalizeModelPreset(legacy) as any;
        expect(model.localNetworkMode).toBe(false);
        expect(model.localNetworkTimeoutSec).toBe(600);
        expect(model.fallbackModels).toEqual({ model: ["gpt"], memory: [], emotion: [], translate: [], otherAx: [] });
        expect(model.openrouterProvider).toEqual({ order: ["DeepInfra"], only: [], ignore: [] });
        for (const field of ["NAISettings", "promptSettings", "formatingOrder", "top_p", "seperateParameters"]) {
            expect(Object.hasOwn(model, field), field).toBe(false);
        }
        expect(preset.promptTemplate).toEqual([
            { type: "plain", type2: "main", text: "t", role: "bot" },
            { type: "cot", text: "c", role: "bot" },
            { type: "persona", role2: "bot" },
            { type: "cache", role: "assistant" },
            { type: "cache", role: "all" },
            { type: "description" },
        ]);

        expect(normalizeModelPreset({ openrouterProvider: "" }).openrouterProvider).toEqual({
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
        const model = normalizeModelPreset(input) as any;
        expect(JSON.stringify(input)).toBe(before);
        expect(model.fallbackModels).toEqual({ model: [], memory: [], emotion: [], translate: [], otherAx: [] });
        expect(input.fallbackModels).toEqual({ model: [""], memory: [], emotion: [], translate: [], otherAx: [] });
    });
});

describe("normalizeModelPreset", () => {
    it("fills an empty input with the model fields' defaults, its own name default, a v4 id, and no image or prompt field", () => {
        const preset = normalizeModelPreset({}) as unknown as Record<string, unknown>;
        expect(preset.id).toMatch(UUID_V4);
        expect(preset.name).toBe(MODEL_PRESET_DEFAULT_NAME);
        expect(MODEL_PRESET_DEFAULT_NAME).not.toBe(PRESET_DEFAULTS.name);
        for (const field of MODEL_PRESET_FIELDS) {
            const fallback = PRESET_DEFAULTS[field];
            if (fallback === undefined) {
                expect(Object.hasOwn(preset, field), field).toBe(false);
            } else {
                expect(preset[field], field).toEqual(fallback);
            }
        }
        expect(Object.keys(preset).sort()).toEqual(
            ["id", ...modelRecordFields.filter((field) => PRESET_DEFAULTS[field] !== undefined)].sort(),
        );
        for (const field of ["image", ...PROMPT_PRESET_FIELDS]) {
            expect(Object.hasOwn(preset, field), field).toBe(false);
        }
        // The unset model fields stay absent, as in the prompt preset.
        expect(MODEL_PRESET_FIELDS.filter((field) => PRESET_DEFAULTS[field] === undefined).sort()).toEqual([
            "koboldURL",
            "proxyRequestModel",
        ]);
    });

    it("keeps a given name, drops the credentials and the prompt fields, keeps a valid id, and lets options.id win", () => {
        const preset = normalizeModelPreset({
            id: "keep-me",
            name: "Model",
            image: "img",
            proxyKey: "pk-leak",
            openAIKey: "sk-leak",
            temperature: 1,
            mainPrompt: "m",
            aiModel: "gpt-x",
            maxContext: 12,
        }) as unknown as Record<string, unknown>;
        expect(preset).toMatchObject({ id: "keep-me", name: "Model", aiModel: "gpt-x", maxContext: 12 });
        for (const dropped of ["image", "proxyKey", "openAIKey", "temperature", "mainPrompt"]) {
            expect(Object.hasOwn(preset, dropped), dropped).toBe(false);
        }
        expect(JSON.stringify(preset)).not.toContain("leak");
        expect(normalizeModelPreset({ id: "keep-me" }, { id: "override" }).id).toBe("override");
        expect(normalizeModelPreset({ id: 42 }).id).toMatch(UUID_V4);
        expect(normalizeModelPreset(null).id).toMatch(UUID_V4);
        // A wrong kind takes the default; a name that is not a string takes the model default.
        expect(normalizeModelPreset({ maxContext: "big", name: 5 })).toMatchObject({
            maxContext: PRESET_DEFAULTS.maxContext,
            name: MODEL_PRESET_DEFAULT_NAME,
        });
    });

    it("returns fresh copies of the defaults", () => {
        const a = normalizeModelPreset({});
        const b = normalizeModelPreset({});
        expect(a.fallbackModels).toEqual(b.fallbackModels);
        expect(a.fallbackModels).not.toBe(b.fallbackModels);
        expect(a.seperateModels).not.toBe(PRESET_DEFAULTS.seperateModels);
    });
});

describe("normalizeModelPresets", () => {
    it("turns a non-array or empty input into one default model preset", () => {
        for (const input of [undefined, null, [], "x", {}]) {
            const presets = normalizeModelPresets(input);
            expect(presets).toHaveLength(1);
            expect(presets[0].id).toMatch(UUID_V4);
            expect(presets[0].name).toBe(MODEL_PRESET_DEFAULT_NAME);
            expect(presets[0].maxContext).toBe(PRESET_DEFAULTS.maxContext);
        }
    });

    it("keeps unique ids, assigns missing ones, re-keys a duplicate, and is idempotent", () => {
        const presets = normalizeModelPresets([
            { id: "a", name: "first" },
            { name: "no id" },
            { id: "a", name: "dup" },
        ]);
        expect(presets.map((preset) => preset.name)).toEqual(["first", "no id", "dup"]);
        expect(presets[0].id).toBe("a");
        expect(presets[1].id).toMatch(UUID_V4);
        expect(presets[2].id).not.toBe("a");
        expect(new Set(presets.map((preset) => preset.id)).size).toBe(3);
        const once = normalizeModelPresets([{ id: "a", name: "x", openrouterProvider: "legacy" }, { name: "y" }]);
        expect(normalizeModelPresets(JSON.parse(JSON.stringify(once)))).toEqual(once);
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
// the whole root; the preset split, `docs/plan/split-preset.md`, gave the root preset keys two
// owners): the five sections, the thirteen collections with their two selection fields, the
// forwarded root keys (served by the client forwarding layer, never stored), the dropped fields, and
// the Phase 1 fields cover `keyof Database` exactly once. The type-level half below is checked by
// `pnpm check`; the runtime half checks the counts derived from the lists and the keys the
// maintained fresh-boot fixture actually holds.

type PresetRootName<F extends PresetField> = F extends "NAISettings"
    ? "NAIsettings"
    : F extends "reasonEffort"
      ? "reasoningEffort"
      : F extends "regex"
        ? "presetRegex"
        : F;
type ForwardedPresetKey = {
    [F in PresetField]: F extends "name" | "image" | "proxyKey" ? never : PresetRootName<F>;
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
// The two owners partition the schema at the type level too: a field of both, or of neither, is `never`.
type OwnedTwice = Extract<ModelPresetField, PromptPresetField>;
type Unowned = Exclude<PresetField, ModelPresetField | PromptPresetField | "name" | "image">;
const noFieldIsOwnedTwice: [OwnedTwice] extends [never] ? true : false = true;
const everyFieldIsOwned: [Unowned] extends [never] ? true : false = true;

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
        expect(noFieldIsOwnedTwice).toBe(true);
        expect(everyFieldIsOwned).toBe(true);
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

    it("splits the schema between the two owners: disjoint, exhaustive, in schema order, the design's model table exactly", () => {
        // `name` and `image` are the records' own; every other field has exactly one owner.
        expect(PRESET_RECORD_FIELDS).toEqual(["name", "image"]);
        const owned = [...MODEL_PRESET_FIELDS, ...PROMPT_PRESET_FIELDS];
        expect(new Set(owned).size).toBe(owned.length);
        expect([...owned, ...PRESET_RECORD_FIELDS].sort()).toEqual([...PRESET_FIELDS].sort());
        expect(PROMPT_PRESET_FIELDS).toEqual(
            PRESET_FIELDS.filter(
                (field) =>
                    !(MODEL_PRESET_FIELDS as readonly string[]).includes(field) &&
                    field !== "name" &&
                    field !== "image",
            ),
        );
        for (const field of PRESET_FIELDS) {
            const owner = presetFieldOwner(field);
            if (field === "name" || field === "image") {
                expect(owner, field).toBeUndefined();
            } else {
                expect(owner, field).toBe(
                    (MODEL_PRESET_FIELDS as readonly string[]).includes(field) ? "model" : "prompt",
                );
            }
        }
        // The model table of `docs/plan/split-preset.md` ("Field partition", "Decided placements").
        expect([...MODEL_PRESET_FIELDS].sort()).toEqual(
            [
                "aiModel",
                "subModel",
                "apiType",
                "currentPluginProvider",
                "forceReplaceUrl",
                "customProxyRequestModel",
                "proxyRequestModel",
                "customAPIFormat",
                "textgenWebUIStreamURL",
                "textgenWebUIBlockingURL",
                "koboldURL",
                "localNetworkMode",
                "localNetworkTimeoutSec",
                "openrouterRequestModel",
                "openrouterProvider",
                "useInstructPrompt",
                "enableCustomFlags",
                "customFlags",
                "systemContentReplacement",
                "systemRoleReplacement",
                "instructChatTemplate",
                "JinjaTemplate",
                "outputImageModal",
                "modelTools",
                "maxContext",
                "seperateModelsForAxModels",
                "seperateModels",
                "fallbackModels",
                "fallbackWhenBlankResponse",
            ].sort(),
        );
        // The confirmed placements: sampling, reasoning, the JSON schema, and the per-role parameters
        // are the prompt's; the context window, the system replacements, and the custom flags the model's.
        for (const field of [
            "temperature",
            "maxResponse",
            "top_p",
            "reasonEffort",
            "thinkingTokens",
            "jsonSchema",
            "extractJson",
            "seperateParameters",
            "seperateParametersEnabled",
            "ooba",
            "reverseProxyOobaArgs",
        ] as const) {
            expect(presetFieldOwner(field), field).toBe("prompt");
        }
        expect(MODEL_PRESET_FIELDS).toHaveLength(29);
        expect(PROMPT_PRESET_FIELDS).toHaveLength(PRESET_FIELDS.length - 29 - 2);
    });

    it("derives the forwarded lists from the two owners: 45 prompt keys, 29 model keys, proxyKey, 4 persona keys, and 3 selections are forwarded; nothing remains in root", () => {
        expect(FORWARDED_PRESET_KEYS).toEqual(PROMPT_PRESET_FIELDS.map((field) => presetToRootName[field] ?? field));
        expect(FORWARDED_PRESET_KEYS).toHaveLength(45);
        expect(FORWARDED_MODEL_PRESET_KEYS).toEqual([...MODEL_PRESET_FIELDS]);
        expect(FORWARDED_MODEL_PRESET_KEYS).toHaveLength(29);
        // The aliases appear under their root names, never their preset names (all three are prompt fields).
        expect(FORWARDED_PRESET_KEYS).toEqual(
            expect.arrayContaining(["NAIsettings", "reasoningEffort", "presetRegex"]),
        );
        expect(FORWARDED_PRESET_KEYS).not.toContain("NAISettings");
        expect(FORWARDED_PRESET_KEYS).not.toContain("reasonEffort");
        expect(FORWARDED_PRESET_KEYS).not.toContain("regex");
        expect(FORWARDED_PRESET_KEYS).not.toContain("proxyKey");
        for (const key of FORWARDED_MODEL_PRESET_KEYS) {
            expect(FORWARDED_PRESET_KEYS, key).not.toContain(key);
            expect(Object.hasOwn(PRESET_ROOT_ALIASES, key), key).toBe(false);
        }

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
            ...FORWARDED_MODEL_PRESET_KEYS,
            "proxyKey",
            ...PERSONA_ROOT_KEYS,
            ...SELECTION_KEYS,
        ]);
        expect(FORWARDED_ROOT_KEYS).toHaveLength(45 + 29 + 1 + 4 + 3);
    });

    it("forwardPresetRoots writes every forwarded preset key from its owner, with the owner's defaults, and nothing else", () => {
        const prompt = { id: "p", name: "P", temperature: 7, NAISettings: { starter: "s" }, regex: [{ in: "x" }] };
        const model = { id: "m", name: "M", aiModel: "model-x", maxContext: 9 };
        const target: Record<string, unknown> = { untouched: true };
        forwardPresetRoots(target, prompt, model);
        expect(target.untouched).toBe(true);
        expect(target.temperature).toBe(7);
        expect(target.NAIsettings).toEqual({ starter: "s" });
        expect(target.presetRegex).toEqual([{ in: "x" }]);
        expect(target.aiModel).toBe("model-x");
        expect(target.maxContext).toBe(9);
        // A field the owner lacks takes its default; a field of the other owner is never read.
        expect(target.maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(target.subModel).toBe(PRESET_DEFAULTS.subModel);
        forwardPresetRoots(target, { ...prompt, aiModel: "leak" }, { ...model, temperature: 1 });
        expect(target.aiModel).toBe("model-x");
        expect(target.temperature).toBe(7);
        // Every forwarded key is an own key of the target (an unset one as `undefined`), nothing else.
        expect(Object.keys(target).sort()).toEqual(
            ["untouched", ...FORWARDED_PRESET_KEYS, ...FORWARDED_MODEL_PRESET_KEYS].sort(),
        );
        for (const key of ["name", "image", "id", "proxyKey"]) {
            expect(Object.hasOwn(target, key), key).toBe(false);
        }
    });

    it("places the review corrections: the former keep-on-switch group in the presets, auto-suggest in ui, supaMemoryKey in llmSecrets, hypaMemoryKey dropped", () => {
        // The preset split (`docs/plan/split-preset.md`, "Keep-on-switch retires"): the five fields
        // are preset fields, their three toggles are gone from `providers` and from the schema.
        for (const field of [
            "seperateModels",
            "seperateModelsForAxModels",
            "fallbackModels",
            "fallbackWhenBlankResponse",
        ]) {
            expect(SECTION_FIELDS.providers as readonly string[], field).not.toContain(field);
            expect(presetFieldOwner(field as PresetField), field).toBe("model");
        }
        expect(SECTION_FIELDS.providers as readonly string[]).not.toContain("seperateParameters");
        expect(presetFieldOwner("seperateParameters")).toBe("prompt");
        for (const toggle of [
            "doNotChangeSeperateModels",
            "doNotChangeFallbackModels",
            "disableSeperateParameterChangeOnPresetChange",
        ]) {
            expect(union, toggle).not.toContain(toggle);
        }
        expect(SECTION_FIELDS.ui).toEqual(expect.arrayContaining(["autoSuggestPrefix", "autoSuggestClean"]));
        expect(SECTION_FIELDS.llmSecrets).toContain("supaMemoryKey");
        expect(SECTION_FIELDS.llmSecrets).toContain("openAIKey");
        expect(DROPPED_FIELDS).toContain("hypaMemoryKey");
        expect(sectionKeys).not.toContain("statics");
        expect(COLLECTION_FIELDS.statics).toBe("statics");
    });

    it("lists five sections and thirteen collections, two of them with a selection field, modelPresets among them", () => {
        expect(Object.keys(SECTION_KIND)).toHaveLength(5);
        expect(Object.keys(SECTION_FIELDS).sort()).toEqual(Object.keys(SECTION_KIND).sort());
        expect(Object.keys(COLLECTION_KIND)).toHaveLength(13);
        expect(Object.keys(COLLECTION_FIELDS).sort()).toEqual(Object.keys(COLLECTION_KIND).sort());
        expect(COLLECTION_KIND.modelPresets).toBe("modelPresets");
        expect(COLLECTION_FIELDS.modelPresets).toBe("modelPresets");
        expect(COLLECTION_SELECTION_FIELDS).toEqual({
            translatorPresets: "translatorPresetId",
            hypaV3Presets: "hypaV3PresetId",
        });
        // Its own literal since slice 6 (`ROOT_EXCLUDED_KEYS` went with the `root` resource).
        expect(PHASE1_FIELDS).toEqual(["characters", "botPresets", "modules", "plugins", "pluginCustomStorage"]);
    });
});

// Slice 5 (`forwarding-presets-and-selection.md`, "Missing and null values"): the normalizers keep an
// explicit `null` only where it is a value the readers handle (`PRESET_NULLABLE_FIELDS`); any other
// `null` gets the default, as `setPreset` gave the root working copy before Phase 3 (the former
// keep-on-switch `null` marker went with the split). The server `presets` and `modelPresets`
// normalizers run the same functions, so a cleared number comes back as its default after a reload.
// This replaces slice 2's rule, which kept every `null` (Astra challenge point 4).
describe("null canonicalization", () => {
    it("lists the nullable fields as preset fields of either owner", () => {
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
        }
        expect(PRESET_NULLABLE_FIELDS.filter((field) => presetFieldOwner(field) === "model")).toEqual([
            "openrouterProvider",
        ]);
    });

    it("keeps a null in a nullable field and gives any other null its default, on either record", () => {
        const nulls = {
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
            // Anything else: the default, scalars and containers alike.
            seperateModels: null,
            fallbackModels: null,
            maxResponse: null,
            temperature: null,
            mainPrompt: null,
            ooba: null,
            promptSettings: null,
            formatingOrder: null,
            systemContentReplacement: null,
            JinjaTemplate: null,
            NAISettings: null,
            maxContext: null,
        };
        const preset = normalizePreset(nulls) as unknown as Record<string, unknown>;
        for (const field of ["promptTemplate", "min_p", "repetition_penalty", "top_a", "thinkingTokens"]) {
            expect(preset[field], field).toBeNull();
        }
        expect(preset.dynamicOutput).toBeNull();
        expect(preset.NAIadventure).toBeNull();

        expect(preset.maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(preset.temperature).toBe(PRESET_DEFAULTS.temperature);
        expect(preset.mainPrompt).toBe(PRESET_DEFAULTS.mainPrompt);
        expect(preset.ooba).toEqual(defaultOoba);
        expect(preset.promptSettings).toEqual(PRESET_DEFAULTS.promptSettings);
        expect(preset.formatingOrder).toEqual(PRESET_DEFAULTS.formatingOrder);
        expect(preset.NAISettings).toEqual(PRESET_DEFAULTS.NAISettings);

        const model = normalizeModelPreset(nulls) as unknown as Record<string, unknown>;
        expect(model.openrouterProvider).toBeNull();
        expect(model.seperateModels).toEqual(PRESET_DEFAULTS.seperateModels);
        expect(model.fallbackModels).toEqual(PRESET_DEFAULTS.fallbackModels);
        expect(model.maxContext).toBe(PRESET_DEFAULTS.maxContext);
        expect(model.systemContentReplacement).toBe("system: {{slot}}");
        expect(model.JinjaTemplate).toBe("");
        // A fresh copy of the default, never the shared default object.
        expect(preset.ooba).not.toBe(defaultOoba);
        expect(preset.promptSettings).not.toBe(PRESET_DEFAULTS.promptSettings);
    });

    it("is what the server presets and modelPresets normalizers store, and a fixed point of itself", async () => {
        // Loaded at run time through a computed specifier, like `storeBackedServer.ts`: the client
        // `tsconfig.json` must not type-check the strict server sources.
        const { normalizePresetCollection, normalizeModelPresetCollection } = (await import(
            /* @vite-ignore */ `${"../../../../server/src/data/normalize/"}presets.ts`
        )) as {
            normalizePresetCollection: (input: unknown) => Record<string, unknown>[];
            normalizeModelPresetCollection: (input: unknown) => Record<string, unknown>[];
        };
        const stored = normalizePresetCollection([{ id: "nulls", maxResponse: null, ooba: null, min_p: null }]);
        expect(stored).toHaveLength(1);
        expect(stored[0].maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(stored[0].ooba).toEqual(defaultOoba);
        expect(stored[0].min_p).toBeNull();
        expect(normalizePresets(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
        const models = normalizeModelPresetCollection([
            { id: "nulls", maxContext: null, openrouterProvider: null, proxyKey: "leak", temperature: 1 },
        ]);
        expect(models).toHaveLength(1);
        expect(models[0].maxContext).toBe(PRESET_DEFAULTS.maxContext);
        expect(models[0].openrouterProvider).toBeNull();
        expect(Object.hasOwn(models[0], "proxyKey")).toBe(false);
        expect(Object.hasOwn(models[0], "temperature")).toBe(false);
        expect(normalizeModelPresets(JSON.parse(JSON.stringify(models)))).toEqual(models);
    });
});
