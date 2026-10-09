// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 5 (`docs/plan/phases/slices/phase-3-settings-sections/forwarding-presets-and-selection.md`)
// rules of the selected preset, over the settings record views (`settingsViews.svelte.ts`) since
// Phase 6 slice 10 moved them there from the removed forwarding layer (`forwarding.svelte.ts`, the
// accessors on the whole-database aggregate). The spike (`forwardingSpike.test.ts`) proved the
// mechanism on a test-only harness; these cases pin the shipped rules: the reads and writes by the
// selected id (`activePreset` under the preset's own field names, the root names with their three
// aliases through `readSettingsRoot`/`writeSettingsRoot`), tracked reads and untracked writes, the
// resolution after a collection replacement, the fallback after a removal (a read repairs the
// selection, a write is dropped and never redirected), the missing and `null` value rules (a read
// never writes), the legacy flat snapshot (`rootSnapshot`: the selection indexes),
// the index shims (`selectedPresetIndex`, `selectedLoreBookPage`), and the preset actions
// (`presets.svelte.ts`) that changed with the layer (`changeToPreset`, `applyPresetTemplate`,
// `copyPreset`, `importPreset`), and since the preset split (`docs/plan/split-preset.md`) the model
// preset's own: `activeModelPreset` over the `modelPresets` collection, `changeToModelPreset`,
// `copyModelPreset`, `removeModelPreset`, with the two selections independent of each other. Since
// the model profiles (`docs/plan/model-profiles.md`) the model preset holds the slot choices, and the
// profile fields (`maxContext`, ...) are served by `activeMainProfile` from the main slot's profile
// and at root; `proxyKey` is removed (O2): it is no root name, a write of it to a model preset or a
// profile is refused, nothing copies or cleans up a per-preset key, and an imported file's
// `proxyKey` is ignored. The cases about the accessors themselves (their descriptors, the idempotent
// install, `setDatabaseLite`, the index setters' input checks) were retired with the aggregate.

await vi.hoisted(async () => {
    const { Buffer: BufferPolyfill } = await import("buffer");
    (globalThis as any).Buffer = BufferPolyfill;
});

vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", () => ({ alertNormal: vi.fn(), alertError: vi.fn() }));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import {
    applyPresetTemplate,
    changeToModelPreset,
    changeToPreset,
    copyModelPreset,
    copyPreset,
    importPreset,
    removeModelPreset,
} from "../presets.svelte";
import { llmSecretState, setMaskedSecrets } from "../llmSecrets.svelte";
import { maskLlmSecrets } from "../../../../shared/llmSecrets.ts";
import { CredentialRefusedError, initializeRecords, resetRecords, takeRecordFields } from "../records.svelte";
import { selection, selectLoreBookPage, selectModelPreset, selectPreset } from "../selection.svelte";
import {
    activeMainProfile,
    activeModelPreset,
    activePreset,
    currentModelPresetRecord,
    currentPresetRecord,
    modelPresetRecordForWrite,
    presetRecordForWrite,
    readSettingsRoot,
    reconcileSelection,
    selectedLoreBookPage,
    selectedPresetIndex,
    settings,
    writeSettingsRoot,
} from "../settingsViews.svelte";
import { rootSnapshot } from "../snapshots.svelte";
import {
    normalizeModelPresets,
    normalizeModelProfiles,
    normalizePresets,
    PRESET_DEFAULTS,
    PRESET_ROOT_ALIASES,
    defaultOoba,
    plainClone,
} from "../../../../shared/presets.ts";
import { createProbe, createWriterEffect } from "./reactiveProbe.svelte";

type AnyView = Record<string, any>;

const preset$ = activePreset as unknown as AnyView;
const modelPreset$ = activeModelPreset as unknown as AnyView;
const mainProfile$ = activeMainProfile as unknown as AnyView;
/** The views under a loose type, for the fixture-shaped writes below. */
const settings$ = settings as unknown as AnyView;
const presets = () => settings.presets as unknown as AnyView[];
const modelPresets = () => settings.modelPresets as unknown as AnyView[];
const modelProfiles = () => settings.modelProfiles as unknown as AnyView[];
const preset = (id: string) => presets().find((entry) => entry.id === id);
const modelPreset = (id: string) => modelPresets().find((entry) => entry.id === id);
const profile = (id: string) => modelProfiles().find((entry) => entry.id === id);
const text = (value: unknown) => JSON.stringify(plainClone(value));
/** The queued credential writes, in order. */
const queued = () => llmSecretState.queue.map((op) => op.request);

/** Each model preset's auxiliary model ids: bare slots (`{ modelId }`), read back as those ids. */
const auxIdsA = { memory: "am", emotion: "ae", translate: "at", otherAx: "ao" };
const auxIdsB = { memory: "bm", emotion: "be", translate: "bt", otherAx: "bo" };
const bareSlots = (ids: Record<string, string>) =>
    Object.fromEntries(Object.entries(ids).map(([mode, modelId]) => [mode, { modelId }]));

function presetA() {
    return {
        id: "a",
        name: "A",
        temperature: 80,
        maxResponse: 500,
        NAISettings: { starter: "starter-a" },
        reasonEffort: 1,
        regex: [{ comment: "ra", type: "editinput", in: "x", out: "y", flag: "" }],
        mainSlot: { profileId: "pa" },
        subSlot: { profileId: "pa" },
        auxSlots: bareSlots(auxIdsA),
        seperateModelsForAxModels: true,
        seperateParameters: { memory: { temperature: 1 }, emotion: {}, translate: {}, otherAx: {}, overrides: {} },
    };
}

function presetB() {
    return {
        id: "b",
        name: "B",
        temperature: 50,
        maxResponse: 555,
        NAISettings: { starter: "starter-b" },
        reasonEffort: 2,
        regex: [],
        mainSlot: { profileId: "pb" },
        subSlot: { profileId: "pb" },
        auxSlots: bareSlots(auxIdsB),
        seperateModelsForAxModels: false,
        seperateParameters: { memory: {}, emotion: { temperature: 2 }, translate: {}, otherAx: {}, overrides: {} },
    };
}

/** The main (and sub) profiles of the model presets `a` and `b`. */
function profiles() {
    return [
        { id: "pa", name: "PA", modelId: "model-a", maxContext: 4000 },
        { id: "pb", name: "PB", modelId: "model-b", maxContext: 5000 },
    ];
}

/**
 * Installs the records from a legacy-shaped save with the given presets and root fields, as boot
 * installs them, and resolves the selections. The presets go in canonical (`normalizePresets`,
 * `normalizeModelPresets`, and `normalizeModelProfiles`, what the server stores): the two fixture
 * presets `a` and `b` are split by owner into the prompt presets `a`/`b` and the model presets
 * `a`/`b`, whose slots name the profiles `pa`/`pb` (the removed boot backstop did the normalization
 * for a fixture before).
 */
function boot(extra: Record<string, unknown> = {}) {
    initializeRecords(
        takeRecordFields({
            characters: [],
            botPresets: normalizePresets([presetA(), presetB()]),
            modelPresets: normalizeModelPresets([presetA(), presetB()]),
            modelProfiles: normalizeModelProfiles(profiles()),
            ...extra,
        }),
    );
    reconcileSelection();
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectModelPreset("");
    selectLoreBookPage(0);
    llmSecretState.queue.splice(0);
    setMaskedSecrets(maskLlmSecrets({}));
});

afterEach(() => {
    resetRecords();
});

describe("installation", () => {
    it("a root snapshot carries the selected preset's values under their root names and the selection indexes, as plain data", () => {
        boot();
        const snapshot = rootSnapshot();
        expect(snapshot.temperature).toBe(80);
        expect(snapshot.NAIsettings).toMatchObject({ starter: "starter-a", cfg_scale: 1 });
        expect(snapshot.reasoningEffort).toBe(1);
        // The model roots come from the selected model preset (`a`): its slots' model ids and its main
        // profile's fields.
        expect(snapshot.aiModel).toBe("model-a");
        expect(snapshot.maxContext).toBe(4000);
        expect(snapshot.seperateModels).toEqual(auxIdsA);
        expect(snapshot.botPresetsId).toBe(0);
        expect(Object.hasOwn(snapshot, "proxyKey")).toBe(false);
        expect(snapshot.loreBookPage).toBe(0);
        // The snapshot is plain data: no view travels.
        expect(Object.getOwnPropertyDescriptor(snapshot, "temperature")).toHaveProperty("value", 80);
    });

    it("selects the first preset for an empty or unknown stored selection when the records are installed", () => {
        selectPreset("gone");
        selectModelPreset("gone");
        boot();
        expect(selection.presetId).toBe("a");
        expect(selection.modelPresetId).toBe("a");
        // A write right after boot, before any read, has a record to go to.
        preset$.temperature = 12;
        expect(preset("a").temperature).toBe(12);
        modelPreset$.seperateModelsForAxModels = false;
        expect(modelPreset("a").seperateModelsForAxModels).toBe(false);
        mainProfile$.maxContext = 4100;
        expect(profile("pa").maxContext).toBe(4100);
    });
});

describe("reads and writes by the selected id", () => {
    it("reads and writes the selected preset, with the three root aliases, leaving the other preset alone", () => {
        boot();
        expect(PRESET_ROOT_ALIASES).toEqual({
            NAIsettings: "NAISettings",
            reasoningEffort: "reasonEffort",
            presetRegex: "regex",
        });
        expect(preset$.temperature).toBe(80);
        expect(preset$.NAISettings.starter).toBe("starter-a");
        expect((readSettingsRoot("NAIsettings") as AnyView).starter).toBe("starter-a");
        expect(preset$.reasonEffort).toBe(1);
        expect(readSettingsRoot("reasoningEffort")).toBe(1);
        expect(preset$.regex).toEqual(presetA().regex);
        expect(readSettingsRoot("presetRegex")).toEqual(presetA().regex);

        preset$.temperature = 70;
        writeSettingsRoot("reasoningEffort", 3);
        writeSettingsRoot("presetRegex", []);
        // A nested write goes through the getter to the record's own object.
        preset$.NAISettings.starter = "typed";
        preset$.promptSettings.sendName = true;

        expect(preset("a")).toMatchObject({ temperature: 70, reasonEffort: 3, regex: [] });
        expect(preset("a").NAISettings.starter).toBe("typed");
        expect(preset("a").promptSettings.sendName).toBe(true);
        expect(preset("b")).toMatchObject({ temperature: 50, reasonEffort: 2, regex: [] });
        expect(preset("b").NAISettings.starter).toBe("starter-b");
        expect(preset("b").promptSettings.sendName).toBe(false);

        changeToPreset("b");
        expect(preset$.temperature).toBe(50);
        expect(preset$.NAISettings.starter).toBe("starter-b");
        expect(selectedPresetIndex()).toBe(1);
        expect(currentPresetRecord()?.id).toBe("b");
    });

    it("tracks reads (a derived and an effect follow a record edit and a switch) and resolves writes untracked", () => {
        boot();
        const probe = createProbe(() => preset$.temperature);
        expect(probe.seen).toEqual([80]);
        expect(probe.derived()).toBe(80);

        preset("a").temperature = 81;
        flushSync();
        expect(probe.seen).toEqual([80, 81]);

        changeToPreset("b");
        flushSync();
        expect(probe.seen).toEqual([80, 81, 50]);
        expect(probe.derived()).toBe(50);

        // An effect that assigns a preset field must not rerun into the next preset on a switch:
        // the setter resolves the record and the selection untracked.
        const writer = createWriterEffect(() => {
            preset$.maxResponse = 9100;
        });
        expect(writer.runs()).toBe(1);
        expect(preset("b").maxResponse).toBe(9100);
        changeToPreset("a");
        flushSync();
        expect(writer.runs()).toBe(1);
        expect(preset("a").maxResponse).toBe(500);

        writer.dispose();
        probe.dispose();
    });

    it("resolves anew after the collection is replaced, as a conflict reload or a plugin setter does", () => {
        boot();
        const replacement = plainClone(presets());
        replacement[0].temperature = 11;
        settings$.presets = replacement;
        expect(preset$.temperature).toBe(11);
        preset$.temperature = 13;
        expect(presets()[0].temperature).toBe(13);
        expect(selection.presetId).toBe("a");
    });

    it("falls back to the first record on a read when the selected id is gone, and makes it the selection (also inside a derived)", () => {
        boot();
        changeToPreset("b");
        const probe = createProbe(() => preset$.temperature);
        expect(probe.seen).toEqual([50]);

        presets().splice(1, 1);
        flushSync();
        expect(probe.seen).toEqual([50, 80]);
        expect(() => probe.derived()).not.toThrow();
        expect(probe.derived()).toBe(80);
        expect(selection.presetId).toBe("a");
        expect(selectedPresetIndex()).toBe(0);
        probe.dispose();
    });

    it("drops a write while the selection names no record, never redirecting it; the next read repairs the selection", () => {
        boot();
        const before = [text(preset("a")), text(preset("b"))];
        selectPreset("missing");
        expect(presetRecordForWrite()).toBeUndefined();

        preset$.temperature = 1;
        preset$.NAISettings = { starter: "lost" };
        writeSettingsRoot("reasoningEffort", 9);
        expect([text(preset("a")), text(preset("b"))]).toEqual(before);
        expect(selection.presetId).toBe("missing");

        expect(preset$.temperature).toBe(80);
        expect(selection.presetId).toBe("a");
        preset$.temperature = 2;
        expect(preset("a").temperature).toBe(2);
    });
});

describe("missing and null values", () => {
    it("reads a missing field as its default and a null as null, except a null container outside PRESET_NULLABLE_FIELDS; a read never writes", () => {
        boot();
        const record = preset("a");
        // Bypass the normalizer, as a record between a local write and its normalization looks.
        delete record.maxResponse;
        record.ooba = null;
        record.promptTemplate = null;
        record.min_p = null;
        const before = text(record);
        const modelRecord = modelPreset("a");
        delete modelRecord.subSlot;
        modelRecord.auxSlots = null;
        const modelBefore = text(modelRecord);
        const profileRecord = profile("pa");
        delete profileRecord.forceReplaceUrl;
        profileRecord.maxContext = null;
        profileRecord.customFlags = null;
        const profileBefore = text(profileRecord);

        expect(preset$.maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(preset$.ooba).toEqual(defaultOoba);
        expect(preset$.ooba).not.toBe(preset$.ooba);
        expect(preset$.promptTemplate).toBeNull();
        expect(preset$.min_p).toBeNull();
        // The model preset and profile views read with the same rules over their own records.
        expect(modelPreset$.subSlot).toEqual(PRESET_DEFAULTS.subSlot);
        expect(modelPreset$.auxSlots).toEqual(PRESET_DEFAULTS.auxSlots);
        expect(modelPreset$.auxSlots).not.toBe(modelPreset$.auxSlots);
        expect(mainProfile$.forceReplaceUrl).toBe(PRESET_DEFAULTS.forceReplaceUrl);
        expect(mainProfile$.maxContext).toBeNull();
        expect(mainProfile$.customFlags).toEqual(PRESET_DEFAULTS.customFlags);
        expect(mainProfile$.customFlags).not.toBe(mainProfile$.customFlags);

        // Neither the reads nor a snapshot of every root name materialized anything in the record.
        rootSnapshot();
        JSON.stringify(settings.presets);
        JSON.stringify(settings.modelPresets);
        JSON.stringify(settings.modelProfiles);
        expect(text(record)).toBe(before);
        expect(text(modelRecord)).toBe(modelBefore);
        expect(text(profileRecord)).toBe(profileBefore);
        expect(record.ooba).toBeNull();
        expect(Object.hasOwn(record, "maxResponse")).toBe(false);

        // An edit does land: the setter writes the record.
        preset$.ooba = { ...defaultOoba, formating: { ...defaultOoba.formating, header: "h" } };
        expect(record.ooba.formating.header).toBe("h");
        mainProfile$.maxContext = 4001;
        expect(profileRecord.maxContext).toBe(4001);
        expect(Object.hasOwn(record, "maxContext")).toBe(false);
        expect(Object.hasOwn(modelRecord, "maxContext")).toBe(false);
    });
});

describe("proxyKey (removed, Model Profiles O2)", () => {
    it("is no root name of the snapshot, and a proxyKey written to a model preset or a model profile is refused: nothing is queued or stored", () => {
        boot();
        expect(Object.hasOwn(rootSnapshot(), "proxyKey")).toBe(false);
        expect(() => {
            modelPreset("a").proxyKey = "pk-a";
        }).toThrow(CredentialRefusedError);
        expect(() => {
            profile("pa").proxyKey = "pk-a";
        }).toThrow(CredentialRefusedError);
        expect(queued()).toEqual([]);
        expect(Object.hasOwn(modelPreset("a"), "proxyKey")).toBe(false);
        expect(Object.hasOwn(profile("pa"), "proxyKey")).toBe(false);
        expect(JSON.stringify(settings.modelPresets)).not.toContain("pk-");
        expect(JSON.stringify(settings.modelProfiles)).not.toContain("pk-");
        expect(JSON.stringify(settings.presets)).not.toContain("pk-");
    });

    it("copyModelPreset copies the slot choices and queues nothing; copyPreset and importPreset queue nothing, and a file's proxyKey is ignored", async () => {
        boot();
        const copyId = copyModelPreset("a")!;
        const copy = modelPreset(copyId);
        expect(copy.name).toBe("A Copy");
        expect(copy.id).not.toBe("a");
        expect(copy).toMatchObject({
            mainSlot: { profileId: "pa" },
            subSlot: { profileId: "pa" },
            auxSlots: bareSlots(auxIdsA),
            seperateModelsForAxModels: true,
        });
        expect(Object.hasOwn(copy, "proxyKey")).toBe(false);
        expect(Object.hasOwn(copy, "temperature")).toBe(false);
        expect(Object.hasOwn(copy, "maxContext")).toBe(false);
        // The copy names the same shared profiles; no profile and no key is copied.
        expect(modelProfiles()).toHaveLength(2);
        expect(queued()).toEqual([]);
        expect(copyModelPreset("nope")).toBeUndefined();

        // A prompt preset copy carries no credential.
        copyPreset("a");
        const promptCopy = presets()[2];
        expect(promptCopy.name).toBe("A Copy");
        expect(Object.hasOwn(promptCopy, "aiModel")).toBe(false);
        expect(queued()).toEqual([]);

        await importPreset({
            name: "hand.json",
            data: new TextEncoder().encode(
                JSON.stringify({ name: "Hand", proxyKey: "pk-hand", temperature: 33, aiModel: "file-model" }),
            ),
        });
        const imported = presets()[3];
        expect(imported).toMatchObject({ name: "Hand", temperature: 33 });
        // The file's credential and model fields are ignored (`docs/plan/split-preset.md`).
        expect(Object.hasOwn(imported, "proxyKey")).toBe(false);
        expect(Object.hasOwn(imported, "aiModel")).toBe(false);
        expect(queued()).toEqual([]);
        expect(modelPresets()).toHaveLength(3);
        expect(JSON.stringify(modelProfiles())).not.toContain("file-model");
    });
});

describe("the selection indexes", () => {
    it("selectedPresetIndex is the selected preset's index; selecting an id moves it; an unknown id leaves the index on the fallback; a reorder keeps the preset", () => {
        boot();
        expect(selectedPresetIndex()).toBe(0);
        selectPreset("b");
        expect(selection.presetId).toBe("b");
        expect(selectedPresetIndex()).toBe(1);
        expect(preset$.temperature).toBe(50);
        // An unknown id names no record: the index read resolves the fallback (the first preset).
        selectPreset("nope");
        expect(selectedPresetIndex()).toBe(0);
        expect(selection.presetId).toBe("a");
        selectPreset("b");
        // A reorder keeps the selection on the same preset (the index follows).
        settings$.presets = [plainClone(preset("b")), plainClone(preset("a"))];
        expect(selectedPresetIndex()).toBe(0);
        expect(selection.presetId).toBe("b");
    });

    it("selectedLoreBookPage reads 0 when out of range and resets the stored page", () => {
        boot({
            loreBook: [
                { name: "one", data: [] },
                { name: "two", data: [] },
            ],
        });
        selectLoreBookPage(1);
        expect(selection.loreBookPage).toBe(1);
        expect(selectedLoreBookPage()).toBe(1);
        expect(rootSnapshot().loreBookPage).toBe(1);

        (settings.loreBook as unknown as unknown[]).splice(1, 1);
        expect(selectedLoreBookPage()).toBe(0);
        expect(selection.loreBookPage).toBe(0);
    });
});

describe("changeToPreset, changeToModelPreset, and applyPresetTemplate", () => {
    it("changeToPreset switches the prompt selection only: the model preset and its fields stay, and nothing is copied", () => {
        boot();
        const all = () => [preset("a"), preset("b"), modelPreset("a"), modelPreset("b"), ...modelProfiles()].map(text);
        const before = all();
        changeToPreset("b");
        expect(selection.presetId).toBe("b");
        expect(selection.modelPresetId).toBe("a");
        expect(preset$.temperature).toBe(50);
        expect(preset$.NAISettings.starter).toBe("starter-b");
        expect(mainProfile$.maxContext).toBe(4000);
        expect(readSettingsRoot("seperateModels")).toEqual(auxIdsA);
        expect(rootSnapshot()).toMatchObject({ temperature: 50, maxContext: 4000, botPresetsId: 1 });
        // Nothing was written anywhere: a switch is a selection change.
        expect(all()).toEqual(before);
        // An unknown id changes nothing.
        changeToPreset("nope");
        expect(selection.presetId).toBe("b");
    });

    it("changeToModelPreset switches the model selection only, independently of the prompt preset", () => {
        boot();
        changeToModelPreset("b");
        expect(selection.modelPresetId).toBe("b");
        expect(selection.presetId).toBe("a");
        expect(modelPreset$.id).toBe("b");
        expect(mainProfile$.id).toBe("pb");
        expect(mainProfile$.maxContext).toBe(5000);
        expect(readSettingsRoot("seperateModels")).toEqual(auxIdsB);
        expect(modelPreset$.seperateModelsForAxModels).toBe(false);
        expect(preset$.temperature).toBe(80);
        expect(rootSnapshot()).toMatchObject({ temperature: 80, maxContext: 5000 });
        // A write lands in the selected model preset (or its main profile), never the prompt preset,
        // the other model preset, or its profile.
        modelPreset$.auxSlots = { memory: { modelId: "bm2" } };
        expect(modelPreset("b").auxSlots).toEqual({ memory: { modelId: "bm2" } });
        expect(modelPreset("a").auxSlots).toEqual(bareSlots(auxIdsA));
        mainProfile$.maxContext = 5100;
        expect(profile("pb").maxContext).toBe(5100);
        expect(profile("pa").maxContext).toBe(4000);
        expect(Object.hasOwn(preset("a"), "maxContext")).toBe(false);
        expect(Object.hasOwn(preset("a"), "auxSlots")).toBe(false);
        // The four combinations are reachable.
        changeToPreset("b");
        expect([selection.presetId, selection.modelPresetId]).toEqual(["b", "b"]);
        changeToModelPreset("a");
        expect([selection.presetId, selection.modelPresetId]).toEqual(["b", "a"]);
        expect(rootSnapshot()).toMatchObject({ temperature: 50, maxContext: 4000 });
        changeToModelPreset("nope");
        expect(selection.modelPresetId).toBe("a");
    });

    it("activeModelPreset falls back to the first model preset when the selected one is gone, and drops a write meanwhile", () => {
        boot();
        changeToModelPreset("b");
        modelPresets().splice(1, 1);
        expect(selection.modelPresetId).toBe("b");
        expect(modelPresetRecordForWrite()).toBeUndefined();
        const before = [text(modelPreset("a")), text(profile("pa")), text(profile("pb"))];
        modelPreset$.seperateModelsForAxModels = false;
        mainProfile$.maxContext = 1;
        expect([text(modelPreset("a")), text(profile("pa")), text(profile("pb"))]).toEqual(before);
        expect(selection.modelPresetId).toBe("b");
        expect(modelPreset$.seperateModelsForAxModels).toBe(true);
        expect(mainProfile$.maxContext).toBe(4000);
        expect(selection.modelPresetId).toBe("a");
        modelPreset$.seperateModelsForAxModels = false;
        expect(modelPreset("a").seperateModelsForAxModels).toBe(false);
        mainProfile$.maxContext = 2;
        expect(profile("pa").maxContext).toBe(2);
    });

    it("removeModelPreset removes the record, moves the selection off it, queues nothing, and never removes the last one", () => {
        boot();
        changeToModelPreset("b");
        expect(removeModelPreset("nope")).toBe(false);
        expect(removeModelPreset("b")).toBe(true);
        expect(modelPresets().map((entry) => entry.id)).toEqual(["a"]);
        expect(selection.modelPresetId).toBe("a");
        // No per-preset key exists to clean up (O2), and the shared profiles stay.
        expect(queued()).toEqual([]);
        expect(modelProfiles().map((entry) => entry.id)).toEqual(["pa", "pb"]);
        // The prompt presets are untouched.
        expect(presets().map((entry) => entry.id)).toEqual(["a", "b"]);
        expect(selection.presetId).toBe("a");
        // The last model preset stays: a selection always needs a record.
        expect(removeModelPreset("a")).toBe(false);
        expect(modelPresets()).toHaveLength(1);
        expect(queued()).toEqual([]);
    });

    it("applyPresetTemplate replaces the selected prompt preset's settings, keeps its id, name, and image, and leaves the model preset and its profiles alone", () => {
        boot();
        preset("a").image = "data:image/jpeg;base64,x";
        const modelBefore = [text(modelPreset("a")), text(profile("pa"))];
        applyPresetTemplate({
            ...PRESET_DEFAULTS,
            name: "Template",
            image: "template-image",
            temperature: 33,
            mainPrompt: "template main",
            seperateModels: { memory: "tm", emotion: "te", translate: "tt", otherAx: "to" },
            aiModel: "template-model",
        } as any);
        const applied = presets()[0];
        expect(applied.id).toBe("a");
        expect(applied.name).toBe("A");
        expect(applied.image).toBe("data:image/jpeg;base64,x");
        expect(applied.temperature).toBe(33);
        expect(applied.mainPrompt).toBe("template main");
        expect(preset$.temperature).toBe(33);
        // The template's model fields are dropped: the prompt preset stores none, the model preset is unchanged.
        expect(Object.hasOwn(applied, "seperateModels")).toBe(false);
        expect(Object.hasOwn(applied, "aiModel")).toBe(false);
        expect([text(modelPreset("a")), text(profile("pa"))]).toEqual(modelBefore);
        expect(readSettingsRoot("seperateModels")).toEqual(auxIdsA);
        expect(readSettingsRoot("aiModel")).toBe("model-a");
        expect(preset("b").temperature).toBe(50);
    });
});
