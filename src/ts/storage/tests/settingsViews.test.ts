// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 slice 6 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/readers-settings-pages.md`):
// the settings record views (`settingsViews.svelte.ts`) that the settings pages and the registry
// read and write, over the records a fixture installs (`installFlatDatabase`). The records
// themselves (`records.svelte.ts`, read under the root names through the shared partition tables,
// not through the views module) are the independent oracle: every view must read what the record
// holds under the root name (the removed facade read the same: slice 10 took the aggregate away)
// and write into the record. Covered: `activePreset` (its own field names for the three root aliases, tracked reads
// and untracked writes, the read fallback that repairs the selection also inside a `$derived`, the
// dropped write, the detached default of a missing field, the nullable `null`), `activePersona`
// (the four aliases, the string defaults, a raw `largePortrait`), the record resolvers, the section
// and collection views, the credential boundary (`llmSecrets` routed, `proxyKey` served by neither
// the views nor the root resolver), `readSettingsRoot`/`writeSettingsRoot` over every root name and
// their refusal of every other name, `selectedLoreBookPage`, and the registry functions over the
// real context: every registry item's binding read and written through the views, `getValue`/
// `bindPath`/`bindKey` precedence, a `bindPath` into a `null` container, and the custom quote items.
// Since the model profiles (`docs/plan/model-profiles.md`) `activeModelPreset` serves the slot
// fields, `activeMainProfile`/`activeSubProfile` the slots' profiles, and the model root names are
// derived: `aiModel`/`subModel`/`seperateModels` the slots' model ids, the profile fields the main
// profile's.

await vi.hoisted(async () => {
    const { Buffer: BufferPolyfill } = await import("buffer");
    (globalThis as any).Buffer = BufferPolyfill;
});

vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", () => ({
    alertNormal: vi.fn(),
    alertError: vi.fn(),
    alertSelect: vi.fn(),
    alertConfirm: vi.fn(),
    alertWait: vi.fn(),
    alertMd: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../translator/translator", () => ({
    exportLLMCacheAsJSON: vi.fn(),
    importLLMCacheFromJSON: vi.fn(),
    clearLLMCache: vi.fn(),
}));

import { characterList } from "../characterStore.svelte";
import type { Database } from "../database.svelte";
import { changeToModelPreset, changeToPreset } from "../presets.svelte";
import { llmSecretState, setMaskedSecrets } from "../llmSecrets.svelte";
import { recordData, setRecordWriteListener, trackedRecord, type RecordKind } from "../records.svelte";
import { selection, selectLoreBookPage, selectModelPreset, selectPersona, selectPreset } from "../selection.svelte";
import { installFlatDatabase } from "./installFlatDatabase";
import {
    ACTIVE_MODEL_PRESET_FIELDS,
    ACTIVE_PRESET_FIELDS,
    activeMainProfile,
    activeModelPreset,
    activeSubProfile,
    activePersona,
    activePreset,
    currentModelPresetRecord,
    currentPersonaRecord,
    currentPresetRecord,
    isSettingsRootKey,
    missingScopeTarget,
    PresetTargetGoneError,
    readSettingsRoot,
    scopedPresetRoot,
    selectedLoreBookPage,
    settings,
    writeSettingsRoot,
    type SettingsRootKey,
} from "../settingsViews.svelte";
import { getFullSettingsData, getSettingValue, setSettingValue } from "../../setting/utils";
import { displaySettingsItems } from "../../setting/displaySettingsData.svelte";
import type { SettingContext, SettingItem } from "../../setting/types";
import { maskLlmSecrets } from "../../../../shared/llmSecrets.ts";
import { PERSONA_DEFAULTS } from "../../../../shared/personas.ts";
import {
    MODEL_PRESET_FIELDS,
    MODEL_PROFILE_FIELDS,
    PERSONA_ROOT_ALIASES,
    PRESET_DEFAULTS,
    PRESET_ROOT_ALIASES,
    presetFieldOwner,
    defaultOoba,
    plainClone,
} from "../../../../shared/presets.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_SELECTION_FIELDS,
    FORWARDED_MODEL_PRESET_KEYS,
    FORWARDED_PRESET_KEYS,
    MODEL_PROFILE_ROOT_FIELDS,
    PERSONA_ROOT_KEYS,
    SECTION_FIELDS,
    SECTION_KIND,
    type SectionKind,
} from "../../../../shared/sections.ts";
import { createProbe, createWriterEffect } from "./reactiveProbe.svelte";
import { evaluateInDerived } from "./derivedProbe.svelte";

type AnyView = Record<string, any>;

/** A record's live data, untracked (the oracle: never a view). */
const record = (kind: string) => recordData<any>(kind as RecordKind);
const preset = (id: string) => trackedRecord<any[]>("presets")!.find((entry) => entry.id === id);
const modelPreset = (id: string) => trackedRecord<any[]>("modelPresets")!.find((entry) => entry.id === id);
const profile = (id: string) => trackedRecord<any[]>("modelProfiles")!.find((entry) => entry.id === id);
const persona = (id: string) => trackedRecord<any[]>("personas")!.find((entry) => entry.id === id);
const text = (value: unknown) => JSON.stringify(plainClone(value));
const queued = () => llmSecretState.queue.map((op) => op.request);
const preset$ = activePreset as unknown as AnyView;
const modelPreset$ = activeModelPreset as unknown as AnyView;
const mainProfile$ = activeMainProfile as unknown as AnyView;
const persona$ = activePersona as unknown as AnyView;
const views = settings as unknown as Record<string, AnyView>;

/** The root name a preset field is served under (`PRESET_ROOT_ALIASES`, root → preset). */
const rootOfPresetField: Record<string, string> = Object.fromEntries(
    Object.entries(PRESET_ROOT_ALIASES).map(([root, field]) => [field, root]),
);
const presetFieldOfRoot: Record<string, string> = PRESET_ROOT_ALIASES;
const personaFieldOfRoot: Record<string, string> = PERSONA_ROOT_ALIASES;
const sectionOfField = new Map<string, SectionKind>(
    (Object.values(SECTION_KIND) as SectionKind[]).flatMap((section) =>
        (SECTION_FIELDS[section] as readonly string[]).map((field) => [field, section] as const),
    ),
);
const forwardedPresetKeys = new Set<string>(FORWARDED_PRESET_KEYS as string[]);
const forwardedModelPresetKeys = new Set<string>(FORWARDED_MODEL_PRESET_KEYS as readonly string[]);
const AUX_MODES = ["memory", "translate", "emotion", "otherAx"] as const;

/** The selected model preset record (the one `selection.modelPresetId` names, else the first). */
function selectedModelPreset(): any {
    return modelPreset(selection.modelPresetId) ?? trackedRecord<any[]>("modelPresets")?.[0];
}

/** A record's field, or a copy of its `PRESET_DEFAULTS` value when the record lacks it. */
function fieldOf(owner: any, field: string): unknown {
    return owner !== undefined && Object.hasOwn(owner, field)
        ? owner[field]
        : plainClone((PRESET_DEFAULTS as Record<string, unknown>)[field]);
}

/** A slot's profile record: a bare, unset, or dangling slot has none. */
const profileOfSlot = (slot: any) => (slot && "profileId" in slot ? profile(slot.profileId) : undefined);
/** A slot's model id: a bare slot's own, a profile's `modelId`, "" for an unset or dangling slot. */
const modelIdOfSlot = (slot: any): string =>
    !slot ? "" : "modelId" in slot ? slot.modelId : (profileOfSlot(slot)?.modelId ?? "");
const phase1Kinds: Record<string, string> = {
    botPresets: "presets",
    modules: "modules",
    plugins: "plugins",
    pluginCustomStorage: "pluginStorage",
};

/**
 * What the records hold under a root name, resolved from the shared partition (what the removed
 * facade read): a section record's field; the selected preset's field (the record
 * `selection.presetId` names, else the first, as the selection rule reads; its `PRESET_DEFAULTS`
 * value when the record lacks it); the selected persona's field likewise (its string default when
 * not a string); a collection's record, or a selectable one's `items`/`selectedId`; a Phase 1
 * list's record. Throws for a name outside the partition.
 */
function root(key: string): unknown {
    const section = sectionOfField.get(key);
    if (section !== undefined) {
        return record(section)?.[key];
    }
    if (forwardedPresetKeys.has(key)) {
        const field = presetFieldOfRoot[key] ?? key;
        const selected = preset(selection.presetId) ?? trackedRecord<any[]>("presets")?.[0];
        return selected !== undefined && Object.hasOwn(selected, field)
            ? selected[field]
            : plainClone((PRESET_DEFAULTS as Record<string, unknown>)[field]);
    }
    if (forwardedModelPresetKeys.has(key)) {
        // A model root (`docs/plan/model-profiles.md`, "Compatibility"): the selected model preset's
        // slots' model ids and toggle, and its main profile's fields, same rules.
        const selected = selectedModelPreset();
        if (key === "aiModel") {
            return modelIdOfSlot(selected?.mainSlot);
        }
        if (key === "subModel") {
            return modelIdOfSlot(selected?.subSlot);
        }
        if (key === "seperateModels") {
            return Object.fromEntries(AUX_MODES.map((mode) => [mode, modelIdOfSlot(selected?.auxSlots?.[mode])]));
        }
        return fieldOf(key === "seperateModelsForAxModels" ? selected : profileOfSlot(selected?.mainSlot), key);
    }
    if (Object.hasOwn(personaFieldOfRoot, key)) {
        const field = personaFieldOfRoot[key];
        const selected = persona(selection.personaId) ?? trackedRecord<any[]>("personas")?.[0];
        const value = selected?.[field];
        return typeof value === "string" ? value : (PERSONA_DEFAULTS as Record<string, string>)[field];
    }
    for (const [kind, field] of Object.entries(COLLECTION_FIELDS)) {
        if (field === key) {
            return Object.hasOwn(COLLECTION_SELECTION_FIELDS, kind) ? record(kind)?.items : record(kind);
        }
    }
    for (const [kind, field] of Object.entries(COLLECTION_SELECTION_FIELDS)) {
        if (field === key) {
            return record(kind)?.selectedId;
        }
    }
    if (Object.hasOwn(phase1Kinds, key)) {
        return record(phase1Kinds[key]);
    }
    throw new Error(`${key} is not a root name of the partition`);
}

/** Every root name the views serve, built from the shared partition (not from the views module). */
const ROOT_KEYS: string[] = [
    ...(Object.values(SECTION_KIND) as SectionKind[]).flatMap((section) => [...SECTION_FIELDS[section]]),
    ...(FORWARDED_PRESET_KEYS as string[]),
    ...(FORWARDED_MODEL_PRESET_KEYS as readonly string[]),
    ...PERSONA_ROOT_KEYS,
    ...Object.values(COLLECTION_FIELDS),
    ...Object.values(COLLECTION_SELECTION_FIELDS),
    "botPresets",
    "modules",
    "plugins",
    "pluginCustomStorage",
];

/** The record kinds a write notified, in order (the save loop's hook). */
let notified: string[] = [];

function presetA() {
    return {
        id: "a",
        name: "A",
        image: "img-a",
        temperature: 80,
        maxContext: 4000,
        maxResponse: 500,
        aiModel: "model-a",
        NAISettings: { starter: "starter-a" },
        reasonEffort: 1,
        regex: [{ comment: "ra", type: "editinput", in: "x", out: "y", flag: "" }],
        localNetworkMode: false,
    };
}

function presetB() {
    return {
        id: "b",
        name: "B",
        temperature: 50,
        maxContext: 5000,
        maxResponse: 555,
        aiModel: "model-b",
        NAISettings: { starter: "starter-b" },
        reasonEffort: 2,
        regex: [],
        localNetworkMode: true,
    };
}

/**
 * The model presets `a` and `b` (the same ids as the prompt presets): their main slots name the
 * profiles `pa` and `pb`, their sub slots the profile `sub`. The profiles are stored sparse, so a
 * field they lack reads its default.
 */
function modelPresets() {
    return [
        {
            id: "a",
            name: "A",
            mainSlot: { profileId: "pa" },
            subSlot: { profileId: "sub" },
            auxSlots: {},
            seperateModelsForAxModels: false,
        },
        {
            id: "b",
            name: "B",
            mainSlot: { profileId: "pb" },
            subSlot: { profileId: "sub" },
            auxSlots: {},
            seperateModelsForAxModels: false,
        },
    ];
}

function modelProfiles() {
    return [
        { id: "pa", name: "PA", modelId: "model-a", maxContext: 4000, localNetworkMode: false },
        { id: "pb", name: "PB", modelId: "model-b", maxContext: 5000, localNetworkMode: true },
        { id: "sub", name: "Sub", modelId: "model-sub" },
    ];
}

function boot(extra: Record<string, unknown> = {}) {
    installFlatDatabase({
        characters: [],
        // The prompt records keep the legacy model fields of the fixture presets (nothing is
        // normalized at install); the model fields live in the model presets and profiles.
        botPresets: [presetA(), presetB()],
        modelPresets: modelPresets(),
        modelProfiles: modelProfiles(),
        personas: [
            { id: "p1", name: "Ann", icon: "icon-1", note: "n1", personaPrompt: "pp1", largePortrait: true },
            { id: "p2", name: "Bob", icon: "", note: "", personaPrompt: "pp2" },
        ],
        loreBook: [
            { name: "L0", data: [] },
            { name: "L1", data: [] },
        ],
        hotkeys: [{ key: "a", action: "send" }],
        translatorPresets: [
            { id: "t1", name: "T1" },
            { id: "t2", name: "T2" },
        ],
        translatorPresetId: "t1",
        customQuotes: true,
        customQuotesData: null,
        deeplXOptions: null,
        autoScrollToNewMessage: true,
        alwaysScrollToNewMessage: false,
        useExperimental: false,
        theme: "",
        ...extra,
    } as unknown as Database);
    notified = [];
    setRecordWriteListener((kind) => notified.push(kind));
}

function realCtx(): SettingContext {
    return {
        settings,
        preset: activePreset,
        modelPreset: activeModelPreset,
        modelProfile: activeMainProfile,
        persona: activePersona,
        modelInfo: undefined,
        subModelInfo: undefined,
    } as unknown as SettingContext;
}

/** Every registry item, accordion children included. */
function registryItems(): SettingItem[] {
    const out: SettingItem[] = [];
    const visit = (item: SettingItem) => {
        out.push(item);
        item.options?.children?.forEach(visit);
    };
    getFullSettingsData().forEach(visit);
    return out;
}

/** What the records hold for an item's binding (the walk the registry made over the facade before slice 6). */
function recordRead(item: SettingItem): unknown {
    const [first, ...rest] = (item.bindPath ?? item.bindKey!).split(".");
    let value: any = root(first);
    for (const part of rest) {
        value = value?.[part];
    }
    return value;
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectModelPreset("");
    selectPersona("");
    selectLoreBookPage(0);
    llmSecretState.queue.splice(0);
    setMaskedSecrets(maskLlmSecrets({}));
    boot();
});

afterEach(() => {
    setRecordWriteListener(null);
});

describe("activePreset", () => {
    it("reads every field it serves as the record holds it under its root name (its default when missing), and the record's own name and image", () => {
        for (const field of ACTIVE_PRESET_FIELDS) {
            if (field === "name" || field === "image") {
                continue;
            }
            expect(preset$[field], field).toEqual(root(rootOfPresetField[field] ?? field));
        }
        expect(activePreset.id).toBe("a");
        expect(activePreset.name).toBe("A");
        expect(activePreset.image).toBe("img-a");
        // The model fields are the model preset's and the profile's (`docs/plan/model-profiles.md`), and
        // proxyKey is a removed credential (never served).
        for (const field of [...MODEL_PRESET_FIELDS, ...MODEL_PROFILE_FIELDS, "proxyKey"]) {
            expect(field in activePreset, field).toBe(false);
        }
        expect(
            ACTIVE_PRESET_FIELDS.every(
                (field) => field === "name" || field === "image" || presetFieldOwner(field) === "prompt",
            ),
        ).toBe(true);
    });

    it("writes the selected preset by its own field names, leaving the other preset alone, and follows a switch", () => {
        activePreset.temperature = 70;
        activePreset.reasonEffort = 3;
        activePreset.regex = [];
        // A nested write reads the field first and lands in the record's own object.
        activePreset.NAISettings.starter = "typed";

        expect(preset("a")).toMatchObject({ temperature: 70, reasonEffort: 3, regex: [] });
        expect(preset("a").NAISettings.starter).toBe("typed");
        expect(root("temperature")).toBe(70);
        expect(root("reasoningEffort")).toBe(3);
        expect(root("presetRegex")).toEqual([]);
        expect((root("NAIsettings") as { starter: string }).starter).toBe("typed");
        expect(preset("b")).toMatchObject({ temperature: 50, reasonEffort: 2 });
        expect(preset("b").NAISettings.starter).toBe("starter-b");
        expect(notified.length).toBeGreaterThan(0);
        expect(new Set(notified)).toEqual(new Set(["presets"]));

        changeToPreset("b");
        expect(activePreset.id).toBe("b");
        expect(activePreset.temperature).toBe(50);
        expect(activePreset.NAISettings.starter).toBe("starter-b");
    });

    it("tracks its reads and resolves its writes untracked: an effect that assigns does not rerun into the next preset", () => {
        const probe = createProbe(() => activePreset.temperature);
        expect(probe.seen).toEqual([80]);
        preset("a").temperature = 81;
        flushSync();
        expect(probe.seen).toEqual([80, 81]);
        changeToPreset("b");
        flushSync();
        expect(probe.seen).toEqual([80, 81, 50]);
        expect(probe.derived()).toBe(50);

        const writer = createWriterEffect(() => {
            activePreset.maxResponse = 9100;
        });
        expect(writer.runs()).toBe(1);
        expect(preset("b").maxResponse).toBe(9100);
        changeToPreset("a");
        flushSync();
        expect(writer.runs()).toBe(1);
        expect(preset("a").maxContext).toBe(4000);
        writer.dispose();
        probe.dispose();
    });

    it("an effect that assigns a persona field resolves the persona untracked: it does not rerun into the next persona on a switch", () => {
        const writer = createWriterEffect(() => {
            activePersona.note = "from effect";
        });
        expect(writer.runs()).toBe(1);
        expect(persona("p1").note).toBe("from effect");
        selectPersona("p2");
        flushSync();
        expect(writer.runs()).toBe(1);
        expect(persona("p2").note).toBe("");
        writer.dispose();
    });

    it("falls back to the first preset on a read when the selected one is gone and selects it, also inside a $derived", () => {
        changeToPreset("b");
        trackedRecord<any[]>("presets")!.splice(1, 1);
        expect(selection.presetId).toBe("b");
        expect(evaluateInDerived(() => activePreset.temperature)).toBe(80);
        expect(selection.presetId).toBe("a");

        selectPreset("gone");
        expect(evaluateInDerived(() => activePreset.id)).toBe("a");
        expect(selection.presetId).toBe("a");
    });

    it("drops a write while the selection names no preset, never redirecting it; the next read repairs the selection", () => {
        const before = [text(preset("a")), text(preset("b"))];
        selectPreset("missing");
        activePreset.temperature = 1;
        activePreset.NAISettings = { starter: "lost" } as any;
        expect([text(preset("a")), text(preset("b"))]).toEqual(before);
        expect(notified).toEqual([]);
        expect(selection.presetId).toBe("missing");
        expect(currentPresetRecord()?.id).toBe("a");
        expect(selection.presetId).toBe("a");
        activePreset.temperature = 2;
        expect(preset("a").temperature).toBe(2);
    });

    it("reads a missing field as a detached copy of its default (a change inside it saves nothing) and a nullable null as null", () => {
        const record = preset("a");
        // As a record looks between a local write and its normalization.
        delete record.maxResponse;
        record.ooba = null;
        record.promptTemplate = null;
        const before = text(record);
        notified = [];

        expect(activePreset.maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(activePreset.ooba).toEqual(defaultOoba);
        expect(activePreset.ooba).not.toBe(activePreset.ooba);
        expect(activePreset.promptTemplate).toBeNull();

        activePreset.ooba.formating.header = "lost";
        expect(text(record)).toBe(before);
        expect(notified).toEqual([]);

        activePreset.ooba = { ...defaultOoba, formating: { ...defaultOoba.formating, header: "h" } };
        expect(record.ooba.formating.header).toBe("h");
        expect((root("ooba") as { formating: { header: string } }).formating.header).toBe("h");
        activePreset.maxResponse = 4001;
        expect(record.maxResponse).toBe(4001);
    });

    it("currentPresetRecord is the selected record itself (its wrapper)", () => {
        expect(currentPresetRecord()).toBe(preset("a"));
        currentPresetRecord()!.name = "renamed";
        expect(preset("a").name).toBe("renamed");
        expect(activePreset.name).toBe("renamed");
    });
});

describe("activeModelPreset", () => {
    it("reads every slot field it serves as the record holds it (its default when missing), and the record's own name; the main and sub profile views read their profiles' fields; never a prompt field or image", () => {
        for (const field of ACTIVE_MODEL_PRESET_FIELDS) {
            if (field === "name") {
                continue;
            }
            expect(presetFieldOwner(field), field).toBe("model");
            expect(modelPreset$[field], field).toEqual(fieldOf(selectedModelPreset(), field));
        }
        // The profile fields at root are the main profile's.
        for (const field of MODEL_PROFILE_ROOT_FIELDS) {
            expect(mainProfile$[field], field).toEqual(root(field));
        }
        expect(activeModelPreset.id).toBe("a");
        expect(activeModelPreset.name).toBe("A");
        expect(activeModelPreset.mainSlot).toEqual({ profileId: "pa" });
        expect(activeMainProfile.id).toBe("pa");
        expect(activeMainProfile.modelId).toBe("model-a");
        expect(readSettingsRoot("aiModel")).toBe("model-a");
        expect(activeMainProfile.maxContext).toBe(4000);
        expect(activeMainProfile.localNetworkMode).toBe(false);
        // A missing profile field reads its default; the sub slot's profile has its own view.
        expect(activeMainProfile.forceReplaceUrl).toBe(PRESET_DEFAULTS.forceReplaceUrl);
        expect(activeSubProfile.id).toBe("sub");
        expect(activeSubProfile.modelId).toBe("model-sub");
        expect(activeSubProfile.maxContext).toBe(PRESET_DEFAULTS.maxContext);
        expect(readSettingsRoot("subModel")).toBe("model-sub");
        // The prompt fields, `image`, `proxyKey`, and the profile fields are not served by the model
        // preset view; the profile view serves no slot or prompt field.
        for (const field of [
            "temperature",
            "mainPrompt",
            "image",
            "proxyKey",
            "seperateParameters",
            "aiModel",
            "maxContext",
        ]) {
            expect(field in activeModelPreset, field).toBe(false);
        }
        for (const field of ["temperature", "image", "proxyKey", "mainSlot", "seperateModelsForAxModels"]) {
            expect(field in activeMainProfile, field).toBe(false);
        }
        expect(currentModelPresetRecord()).toBe(modelPreset("a"));
    });

    it("writes the selected model preset by its own field names and its main profile through the profile view, leaving the other model preset, the other profiles, and the prompt presets alone, and follows a model switch only", () => {
        notified = [];
        activeModelPreset.seperateModelsForAxModels = true;
        activeModelPreset.auxSlots = { memory: { profileId: "pb" } };
        activeMainProfile.maxContext = 4100;
        expect(modelPreset("a")).toMatchObject({
            seperateModelsForAxModels: true,
            auxSlots: { memory: { profileId: "pb" } },
        });
        expect(modelPreset("b")).toMatchObject({ seperateModelsForAxModels: false, auxSlots: {} });
        expect(profile("pa").maxContext).toBe(4100);
        expect(profile("pb").maxContext).toBe(5000);
        expect(Object.hasOwn(profile("sub"), "maxContext")).toBe(false);
        // The fixture's prompt record still carries the raw legacy values (nothing is normalized at
        // install): the views neither read nor write them there.
        expect(preset("a")).toMatchObject({ maxContext: 4000, aiModel: "model-a" });
        expect(new Set(notified)).toEqual(new Set(["modelPresets", "modelProfiles"]));
        expect(root("maxContext")).toBe(4100);
        expect(readSettingsRoot("seperateModels")).toEqual({
            memory: "model-b",
            translate: "",
            emotion: "",
            otherAx: "",
        });
        // A prompt switch leaves the model preset; a model switch leaves the prompt preset.
        changeToPreset("b");
        expect(activeModelPreset.id).toBe("a");
        expect(activeMainProfile.maxContext).toBe(4100);
        expect(activePreset.id).toBe("b");
        changeToModelPreset("b");
        expect(activeModelPreset.id).toBe("b");
        expect(activeMainProfile.maxContext).toBe(5000);
        expect(activePreset.id).toBe("b");
        expect(activePreset.temperature).toBe(50);
        // `writeSettingsRoot` routes a profile root name to the selected model preset's main profile.
        writeSettingsRoot("localNetworkTimeoutSec", 42);
        expect(profile("pb").localNetworkTimeoutSec).toBe(42);
        expect(Object.hasOwn(preset("b"), "localNetworkTimeoutSec")).toBe(false);
        expect(Object.hasOwn(modelPreset("b"), "localNetworkTimeoutSec")).toBe(false);
        expect(readSettingsRoot("localNetworkTimeoutSec")).toBe(42);
        // `aiModel` is a model id: a root write naming exactly one profile points the selected model
        // preset's main slot at it (Model Profiles O8).
        writeSettingsRoot("aiModel", "model-sub");
        expect(modelPreset("b").mainSlot).toEqual({ profileId: "sub" });
        expect(modelPreset("a").mainSlot).toEqual({ profileId: "pa" });
        expect(readSettingsRoot("aiModel")).toBe("model-sub");
    });

    it("tracks its reads and resolves its writes untracked, and falls back to the first model preset on a read when the selected one is gone", () => {
        const probe = createProbe(() => activeMainProfile.maxContext);
        expect(probe.seen).toEqual([4000]);
        profile("pa").maxContext = 4001;
        flushSync();
        expect(probe.seen).toEqual([4000, 4001]);
        changeToModelPreset("b");
        flushSync();
        expect(probe.seen).toEqual([4000, 4001, 5000]);
        // A prompt switch is no read of the model preset.
        changeToPreset("b");
        flushSync();
        expect(probe.seen).toEqual([4000, 4001, 5000]);

        const writer = createWriterEffect(() => {
            activeMainProfile.maxContext = 9100;
        });
        expect(writer.runs()).toBe(1);
        expect(profile("pb").maxContext).toBe(9100);
        changeToModelPreset("a");
        flushSync();
        expect(writer.runs()).toBe(1);
        expect(profile("pa").maxContext).toBe(4001);
        writer.dispose();
        probe.dispose();

        trackedRecord<any[]>("modelPresets")!.splice(0, 1);
        expect(selection.modelPresetId).toBe("a");
        expect(evaluateInDerived(() => activeMainProfile.maxContext)).toBe(9100);
        expect(selection.modelPresetId).toBe("b");
        selectModelPreset("gone");
        expect(evaluateInDerived(() => activeModelPreset.id)).toBe("b");
        expect(selection.modelPresetId).toBe("b");
    });
});

describe("activePersona", () => {
    it("reads and writes the selected persona as the record holds it under the four root aliases", () => {
        for (const [rootKey, field] of Object.entries(PERSONA_ROOT_ALIASES)) {
            expect(persona$[field], field).toBe(root(rootKey));
        }
        expect(activePersona.id).toBe("p1");
        expect(activePersona.largePortrait).toBe(true);

        activePersona.name = "Ann2";
        activePersona.note = "n1b";
        activePersona.personaPrompt = "pp1b";
        activePersona.icon = "icon-1b";
        activePersona.largePortrait = false;
        expect(persona("p1")).toMatchObject({
            name: "Ann2",
            note: "n1b",
            personaPrompt: "pp1b",
            icon: "icon-1b",
            largePortrait: false,
        });
        expect(root("username")).toBe("Ann2");
        expect(root("userIcon")).toBe("icon-1b");
        expect(persona("p2")).toMatchObject({ name: "Bob", personaPrompt: "pp2" });
        expect(new Set(notified)).toEqual(new Set(["personas"]));

        selectPersona("p2");
        expect(activePersona.name).toBe("Bob");
        expect(activePersona.largePortrait).toBeUndefined();
    });

    it("reads a non-string field as its default, and a missing largePortrait as stored", () => {
        const record = persona("p1");
        record.name = 5;
        delete record.note;
        delete record.largePortrait;
        expect(activePersona.name).toBe(PERSONA_DEFAULTS.name);
        expect(root("username")).toBe(PERSONA_DEFAULTS.name);
        expect(activePersona.note).toBe(PERSONA_DEFAULTS.note);
        expect(activePersona.largePortrait).toBeUndefined();
    });

    it("falls back to the first persona on a read (also inside a $derived) and drops a write while the selection names none", () => {
        const before = [text(persona("p1")), text(persona("p2"))];
        selectPersona("missing");
        activePersona.name = "lost";
        activePersona.largePortrait = false;
        expect([text(persona("p1")), text(persona("p2"))]).toEqual(before);
        expect(notified).toEqual([]);
        expect(selection.personaId).toBe("missing");

        expect(evaluateInDerived(() => activePersona.name)).toBe("Ann");
        expect(selection.personaId).toBe("p1");
        expect(currentPersonaRecord()).toBe(persona("p1"));
    });

    it("with no persona: the id and the record are undefined, the fields read their defaults", () => {
        settings.personas = [];
        expect(activePersona.id).toBeUndefined();
        expect(currentPersonaRecord()).toBeUndefined();
        expect(activePersona.name).toBe(PERSONA_DEFAULTS.name);
        activePersona.name = "nobody";
        expect(root("personas")).toEqual([]);
    });
});

describe("the section and collection views", () => {
    it("read every section field as its record holds it", () => {
        for (const section of Object.values(SECTION_KIND) as SectionKind[]) {
            for (const field of SECTION_FIELDS[section]) {
                expect(views[section][field], `${section}.${field}`).toEqual(record(section)?.[field]);
            }
        }
    });

    it("write a section field into its record, queued once", () => {
        settings.ui.useExperimental = true;
        expect(record("ui").useExperimental).toBe(true);
        expect(notified).toEqual(["ui"]);
        settings.memoryTranslateMedia.translatorType = "deepl";
        expect(record("memoryTranslateMedia").translatorType).toBe("deepl");
        expect(notified).toEqual(["ui", "memoryTranslateMedia"]);
    });

    it("serve a collection as its record's wrapper, replace it on assignment, and the two selectable ones as items and selectedId", () => {
        expect(settings.loreBook).toBe(trackedRecord("loreBook"));
        expect(settings.presets).toBe(trackedRecord("presets"));
        expect(settings.personas).toBe(trackedRecord("personas"));
        expect(settings.translatorPresets.items).toBe(trackedRecord<any>("translatorPresets").items);

        settings.hotkeys = [{ key: "b", action: "reroll" }] as any;
        expect(plainClone(root("hotkeys"))).toEqual([{ key: "b", action: "reroll" }]);
        expect(notified).toEqual(["hotkeys"]);

        settings.translatorPresets.selectedId = "t2";
        expect(root("translatorPresetId")).toBe("t2");
        expect(notified).toEqual(["hotkeys", "translatorPresets"]);

        settings.loreBook.push({ name: "L2", data: [] } as any);
        expect((root("loreBook") as { name: string }[]).map((entry) => entry.name)).toEqual(["L0", "L1", "L2"]);
    });

    it("selectedLoreBookPage reads the selected page, or 0 past the end, which it then selects", () => {
        selectLoreBookPage(1);
        expect(selectedLoreBookPage()).toBe(1);
        expect(selection.loreBookPage).toBe(1);
        selectLoreBookPage(5);
        expect(evaluateInDerived(() => selectedLoreBookPage())).toBe(0);
        expect(selection.loreBookPage).toBe(0);
    });
});

describe("credentials", () => {
    it("routes an llmSecrets credential written through its section view to the credential queue; the view reads it masked", () => {
        settings.llmSecrets.openAIKey = "sk-view";
        writeSettingsRoot("claudeAPIKey", "sk-root");
        expect(queued()).toEqual([
            { kind: "put", path: { kind: "flat", field: "openAIKey" }, value: "sk-view" },
            { kind: "put", path: { kind: "flat", field: "claudeAPIKey" }, value: "sk-root" },
        ]);
        expect(settings.llmSecrets.openAIKey).not.toBe("sk-view");
        expect(readSettingsRoot("claudeAPIKey")).not.toBe("sk-root");
        expect(settings.llmSecrets.openAIKey).toBe(root("openAIKey"));
    });

    it("serves no proxyKey: neither activePreset nor the root resolver reaches the preset's credential", () => {
        expect(Object.keys(activePreset)).not.toContain("proxyKey");
        expect(isSettingsRootKey("proxyKey")).toBe(false);
        expect(() => readSettingsRoot("proxyKey")).toThrow();
        expect(() => writeSettingsRoot("proxyKey", "pk")).toThrow();
        expect(queued()).toEqual([]);
    });
});

describe("readSettingsRoot / writeSettingsRoot", () => {
    it("serve every root name of the partition, reading what the records hold under it", () => {
        expect(new Set(ROOT_KEYS).size).toBe(ROOT_KEYS.length);
        for (const key of ROOT_KEYS) {
            expect(isSettingsRootKey(key), key).toBe(true);
            expect(readSettingsRoot(key), key).toEqual(root(key));
        }
    });

    it("refuse every other name: the characters, the selection indexes, proxyKey, a dropped field, an unknown one", () => {
        for (const key of [
            "characters",
            "botPresetsId",
            "selectedPersona",
            "loreBookPage",
            "proxyKey",
            "saveTime",
            "nope",
        ]) {
            expect(isSettingsRootKey(key), key).toBe(false);
            expect(() => readSettingsRoot(key), key).toThrow();
            expect(() => writeSettingsRoot(key, 1), key).toThrow();
        }
        expect(selection.presetId).toBe("a");
        expect(characterList()).toEqual([]);
    });

    it("write each kind of root name into its record: a section field, a preset alias, a persona alias, a collection, a selected id", () => {
        writeSettingsRoot("useExperimental", true);
        writeSettingsRoot("reasoningEffort", 9);
        writeSettingsRoot("NAIsettings", { starter: "root" });
        writeSettingsRoot("temperature", 33);
        writeSettingsRoot("username", "Root Ann");
        writeSettingsRoot("hotkeys", []);
        writeSettingsRoot("translatorPresetId", "t2");
        writeSettingsRoot("botPresets", [presetB()]);

        expect(root("useExperimental")).toBe(true);
        expect(persona("p1").name).toBe("Root Ann");
        expect(root("hotkeys")).toEqual([]);
        expect(root("translatorPresetId")).toBe("t2");
        expect((root("botPresets") as { id: string }[]).map((entry) => entry.id)).toEqual(["b"]);
        // The preset writes went to `a` before the list was replaced.
        expect(notified).toContain("presets");
        expect(root("temperature")).toBe(50);
    });

    it("the SettingsRootKey type admits the served names and refuses the others (checked by pnpm check)", () => {
        const served: SettingsRootKey[] = [
            "temperature",
            "NAIsettings",
            "presetRegex",
            "reasoningEffort",
            "username",
            "seperateModels",
            "openAIKey",
            "customQuotesData",
            "translatorPresetId",
            "botPresets",
            "pluginCustomStorage",
        ];
        // @ts-expect-error the character list is not a settings field
        const characters: SettingsRootKey = "characters";
        // @ts-expect-error a preset's credential is never a root name
        const proxyKey: SettingsRootKey = "proxyKey";
        // @ts-expect-error a selection index
        const presetIndex: SettingsRootKey = "botPresetsId";
        // @ts-expect-error a preset field under its own name is not a root name
        const presetField: SettingsRootKey = "NAISettings";
        // @ts-expect-error a dropped field
        const dropped: SettingsRootKey = "saveTime";
        // @ts-expect-error a bindPath root is a served name too
        const path: SettingItem["bindPath"] = "characters.0.name";
        expect(served.every((key) => isSettingsRootKey(key))).toBe(true);
        expect([characters, proxyKey, presetIndex, presetField, dropped].some((key) => isSettingsRootKey(key))).toBe(
            false,
        );
        expect(isSettingsRootKey(path!.split(".")[0])).toBe(false);
    });

    it("drop a preset or persona write while the selection names none, as the views do", () => {
        const before = text(root("botPresets"));
        selectPreset("missing");
        writeSettingsRoot("temperature", 1);
        expect(text(root("botPresets"))).toBe(before);
        selectPersona("missing");
        writeSettingsRoot("username", "lost");
        expect(persona("p1").name).toBe("Ann");
        expect(notified).toEqual([]);
    });
});

describe("scopedPresetRoot (a request's captured pair)", () => {
    it("reads a forwarded root name from the owner of the captured pair, whatever is selected, and from the selection without a scope", () => {
        changeToPreset("b");
        changeToModelPreset("b");
        const captured = { presetId: "a", modelPresetId: "a" };
        expect(scopedPresetRoot(captured, "temperature")).toBe(80);
        expect(scopedPresetRoot(captured, "aiModel")).toBe("model-a");
        expect(scopedPresetRoot({ presetId: "a", modelPresetId: "b" }, "aiModel")).toBe("model-b");
        expect(scopedPresetRoot({ presetId: "a", modelPresetId: "b" }, "temperature")).toBe(80);
        expect(scopedPresetRoot(undefined, "temperature")).toBe(50);
        expect(scopedPresetRoot(undefined, "aiModel")).toBe("model-b");
        // A field the captured pair's main profile lacks reads its default, not the selection's value.
        delete profile("pa").localNetworkTimeoutSec;
        profile("pb").localNetworkTimeoutSec = 999;
        expect(scopedPresetRoot(captured, "localNetworkTimeoutSec")).toBe(PRESET_DEFAULTS.localNetworkTimeoutSec);
        // Nothing moved the selections.
        expect(selection.presetId).toBe("b");
        expect(selection.modelPresetId).toBe("b");
    });

    // Astra's challenge point 1 on the implementation: a tab-run (plugin or WebLLM) request whose
    // captured record was deleted meanwhile must be refused, never redirected to the selection.
    it("never reads the selection for a captured pair whose record is gone (Astra challenge point 1)", () => {
        changeToPreset("b");
        changeToModelPreset("b");
        trackedRecord<any[]>("modelPresets")!.splice(0, 1);
        const captured = { presetId: "a", modelPresetId: "a" };
        expect(() => scopedPresetRoot(captured, "aiModel")).toThrow(PresetTargetGoneError);
        expect(() => scopedPresetRoot(captured, "aiModel")).toThrow(
            "The model preset this request runs with no longer exists",
        );
        // The prompt preset still exists: its fields read; a non-preset root name reads the selection.
        expect(scopedPresetRoot(captured, "temperature")).toBe(80);
        expect(scopedPresetRoot(captured, "useExperimental")).toBe(readSettingsRoot("useExperimental"));
        trackedRecord<any[]>("presets")!.splice(0, 1);
        expect(() => scopedPresetRoot(captured, "temperature")).toThrow(PresetTargetGoneError);
        expect(() => scopedPresetRoot(captured, "temperature")).toThrow(
            "The preset this request runs with no longer exists",
        );
        // Without a scope, the selection is read as before.
        expect(scopedPresetRoot(undefined, "aiModel")).toBe("model-b");
        expect(selection.presetId).toBe("b");
        expect(selection.modelPresetId).toBe("b");
    });

    it("missingScopeTarget names the record of a captured pair that is gone, the prompt preset first", () => {
        expect(missingScopeTarget({ presetId: "a", modelPresetId: "b" })).toBeUndefined();
        expect(missingScopeTarget({ presetId: "a", modelPresetId: "nope" })).toBe("model preset");
        expect(missingScopeTarget({ presetId: "nope", modelPresetId: "a" })).toBe("preset");
        expect(missingScopeTarget({ presetId: "nope", modelPresetId: "nope" })).toBe("preset");
        trackedRecord<any[]>("modelPresets")!.splice(0, 1);
        expect(missingScopeTarget({ presetId: "a", modelPresetId: "a" })).toBe("model preset");
        // Untracked, and it moves no selection.
        expect(evaluateInDerived(() => missingScopeTarget({ presetId: "b", modelPresetId: "b" }))).toBeUndefined();
        expect(selection.modelPresetId).toBe("a");
    });
});

describe("the registry over the views", () => {
    it("every item's bindKey and bindPath root is a name the views serve", () => {
        const bound = registryItems().filter((item) => item.bindKey || item.bindPath);
        expect(bound.length).toBeGreaterThan(100);
        for (const item of bound) {
            const root = (item.bindPath ?? item.bindKey!).split(".")[0];
            expect(isSettingsRootKey(root), item.id).toBe(true);
        }
    });

    it("every bound item reads what the records hold and writes into them", () => {
        boot({ deeplOptions: { key: "dk", freeApi: false }, deeplXOptions: { url: "u", token: "t" } });
        const ctx = realCtx();
        const llmSecretFields = new Set<string>(SECTION_FIELDS.llmSecrets);
        const bound = registryItems().filter((item) => !item.getValue && (item.bindKey || item.bindPath));
        for (const item of bound) {
            expect(getSettingValue(item, ctx), item.id).toEqual(recordRead(item));
        }
        for (const item of bound) {
            const root = (item.bindPath ?? item.bindKey!).split(".")[0];
            if (llmSecretFields.has(root)) {
                continue;
            }
            const current = getSettingValue(item, ctx);
            const value =
                item.type === "check"
                    ? !current
                    : item.type === "number" || item.type === "slider"
                      ? (typeof current === "number" ? current : 0) + 7
                      : item.type === "color"
                        ? "#123456"
                        : `value-of-${item.id}`;
            // The registry write without the item's side effect (a language download, a CSS update).
            setSettingValue({ ...item, onChange: undefined }, value, ctx);
            expect(recordRead(item), item.id).toEqual(value);
            expect(getSettingValue(item, ctx), item.id).toEqual(value);
        }
        // Every preset-bound write went to the selected preset (or its main profile), none to the other.
        expect(preset("b")).toMatchObject({ temperature: 50, maxContext: 5000, maxResponse: 555 });
        expect(profile("pb")).toMatchObject({ maxContext: 5000, localNetworkMode: true });
    });

    it("value precedence: getValue, then bindPath, then bindKey; onChange once per write with the value and the context", () => {
        const ctx = realCtx();
        const onChange = vi.fn();
        const getter: SettingItem = {
            id: "t.getter",
            type: "text",
            getValue: () => "from-getter",
            bindPath: "deeplXOptions.url",
            bindKey: "theme",
        };
        expect(getSettingValue(getter, ctx)).toBe("from-getter");
        const path: SettingItem = {
            id: "t.path",
            type: "text",
            bindPath: "deeplOptions.key",
            bindKey: "theme",
            onChange,
        };
        setSettingValue(path, "path-wins", ctx);
        expect((root("deeplOptions") as { key: string }).key).toBe("path-wins");
        expect(root("theme")).toBe("");
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith("path-wins", ctx);
    });

    it("a bindPath into a null container creates it in the record and writes through it", () => {
        const ctx = realCtx();
        expect(root("deeplXOptions")).toBeNull();
        const item: SettingItem = { id: "t.deeplx", type: "text", bindPath: "deeplXOptions.url" };
        // A reader that follows the value, as the wrapper's input does.
        const probe = createProbe(() => getSettingValue(item, ctx));
        expect(probe.seen).toEqual([undefined]);
        setSettingValue(item, "https://new", ctx);
        flushSync();
        expect(plainClone(root("deeplXOptions"))).toEqual({ url: "https://new" });
        expect(getSettingValue(item, ctx)).toBe("https://new");
        expect(probe.seen.at(-1)).toBe("https://new");
        probe.dispose();
        setSettingValue({ id: "t.deeplx2", type: "text", bindPath: "deeplXOptions.token" }, "tok", ctx);
        expect(plainClone(root("deeplXOptions"))).toEqual({ url: "https://new", token: "tok" });
        expect(new Set(notified)).toEqual(new Set(["secrets"]));
    });

    it("the custom quote items read and write ctx.settings.ui.customQuotesData, creating it from null, and show by ctx.settings.ui.customQuotes", () => {
        const ctx = realCtx();
        const quotes = displaySettingsItems.filter((item) => item.id.endsWith("Quote"));
        expect(quotes.map((item) => item.id)).toEqual([
            "display.leadingDoubleQuote",
            "display.trailingDoubleQuote",
            "display.leadingSingleQuote",
            "display.trailingSingleQuote",
        ]);
        expect(quotes.map((item) => getSettingValue(item, ctx))).toEqual(["", "", "", ""]);
        expect(quotes.every((item) => item.condition!(ctx))).toBe(true);

        setSettingValue(quotes[0], "<", ctx);
        expect(plainClone(root("customQuotesData"))).toEqual(["<", '"', "'", "'"]);
        setSettingValue(quotes[3], ")", ctx);
        expect(plainClone(root("customQuotesData"))).toEqual(["<", '"', "'", ")"]);
        expect(quotes.map((item) => getSettingValue(item, ctx))).toEqual(["<", '"', "'", ")"]);
        expect(new Set(notified)).toEqual(new Set(["ui"]));

        settings.ui.customQuotes = false;
        expect(quotes.some((item) => item.condition!(ctx))).toBe(false);
    });

    it("a model-dependent condition reads the selected model preset's main profile through ctx.modelProfile and follows a model switch, not a prompt switch", () => {
        const ctx = realCtx();
        // The shape of the former Advanced `adv.localNetworkTimeout` item, which left the catalog in settings
        // UI plan slice 4 (the Connections editor edits the same profile field); no catalog item has a
        // condition on `ctx.modelProfile` now.
        const timeout: SettingItem = {
            id: "test.localNetworkTimeout",
            type: "number",
            bindKey: "localNetworkTimeoutSec",
            condition: (ctx) => ctx.modelProfile.localNetworkMode,
        };
        expect(timeout.condition!(ctx)).toBe(false);
        changeToPreset("b");
        expect(timeout.condition!(ctx)).toBe(false);
        changeToModelPreset("b");
        expect(timeout.condition!(ctx)).toBe(true);
        // The registry writes a profile key into the selected model preset's main profile by its root name.
        setSettingValue({ ...timeout, onChange: undefined }, 123, ctx);
        expect(profile("pb").localNetworkTimeoutSec).toBe(123);
        expect(Object.hasOwn(preset("b"), "localNetworkTimeoutSec")).toBe(false);
        expect(Object.hasOwn(modelPreset("b"), "localNetworkTimeoutSec")).toBe(false);
    });

    it("a registry read inside a $derived repairs a missing selection without throwing", () => {
        const ctx = realCtx();
        const temperature = getFullSettingsData().find((item) => item.bindKey === "temperature")!;
        selectPreset("missing");
        expect(evaluateInDerived(() => getSettingValue(temperature, ctx))).toBe(80);
        expect(selection.presetId).toBe("a");
    });
});
