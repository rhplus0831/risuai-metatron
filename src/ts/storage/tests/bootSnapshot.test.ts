import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
    MODEL_PRESET_FIELDS,
    PRESET_FIELDS,
    PRESET_ROOT_ALIASES,
    presetFieldOwner,
} from "../../../../shared/presets.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_SELECTION_FIELDS,
    DROPPED_FIELDS,
    SECTION_FIELDS,
    SELECTION_KEYS,
} from "../../../../shared/sections.ts";
import { StoreBackedServer } from "./storeBackedServer";

// Phase 3, slice 7 (`docs/plan/phases/slices/phase-3-settings-sections/credentials-and-closeout.md`,
// "Boot-snapshot comparison rule", amended by A10 of `implementation-plan.md`): the Safety Contract's
// oracle, kept as a test. `fixtures/phase3/boot-snapshot.json` is the hand-maintained record of
// fresh-boot defaults (see the fixture README). Here the client boots the way `loadData` does against
// the real server store (`storeBackedServer.ts`: the server normalizers materialize every section
// and collection, so what `installBootRecords` receives is what a fresh server holds), and the same
// shape (`rootSnapshot()`, the legacy flat settings with `proxyKey: ""` and the three selection
// indexes, plus the characters; Phase 6 slice 10) is compared by the rule:
//
// 1. every root field of the fixture outside `DROPPED_FIELDS` and the selection keys equals the
//    post-phase value, a forwarded field read through the layer (the model fields through the
//    selected model preset since the preset split, `docs/plan/split-preset.md`);
// 2. the selected prompt preset equals the fixture's effective root (the root working copy, not
//    the dormant `botPresets[0]` template payload) through `PRESET_ROOT_ALIASES` for the prompt
//    fields, and the selected model preset for the model fields, apart from `name` and `image`;
// 3. `personas[0]` and `modelPresets[0]` ignoring `id`;
// 4. the translator and HypaV3 preset lists ignoring ids, with the first item selected;
// 5. every other collection deep-equal.
//
// The only value differences are the four `llmSecrets` credential fields the server record leaves
// absent while the write-only mirror holds them as `""` (Phase 5 slice 7b,
// `request-layer-and-llm-secrets.md`; `mirrorFields` reads every credential field as `""`). A field
// intentionally absent from the fixture that is still `undefined` is equal. Anything else is a
// regression.

const { server } = vi.hoisted(() => ({ server: { current: null as any } }));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("../../alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
}));
// `installBootRecords` applies the stored language; the locale tables are not under test.
vi.mock("src/lang", () => ({ language: {}, changeLanguage: vi.fn() }));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

const fixture: Record<string, any> = JSON.parse(
    readFileSync(path.resolve(__dirname, "fixtures/phase3/boot-snapshot.json"), "utf8"),
);

/**
 * The fixture omits these four fields because the server record has no credential default, while
 * the write-only `llmSecrets` client mirror reads every credential field as `""` (7b).
 */
const EMPTY_CREDENTIALS = ["claudeAPIKey", "mistralKey", "cohereAPIKey", "novellistAPI"];

const PHASE1_LISTS = ["botPresets", "characters", "modules", "plugins", "pluginCustomStorage"];
/** The collections compared without their ids (random in the capture, or never captured). */
const SELECTABLE = ["personas", "modelPresets", "translatorPresets", "hypaV3Presets"];

const withoutId = (value: unknown) => {
    const { id, ...rest } = (value ?? {}) as Record<string, unknown>;
    return rest;
};

/** Boots the client the way `loadData` does for the data: read, seed, the real `installBootRecords`. */
async function bootFresh() {
    vi.resetModules();
    server.current = await StoreBackedServer.create();
    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const bootstrap = await import("../../bootstrap");
    const snapshots = await import("../snapshots.svelte");
    const views = await import("../settingsViews.svelte");
    const characterStore = await import("../characterStore.svelte");
    const selection = await import("../selection.svelte");
    const records = await import("../records.svelte");
    selection.selectPreset("");
    selection.selectModelPreset("");
    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    // The compared shape: the legacy flat settings, plus the characters (`rootSnapshot` has none).
    const root = snapshots.rootSnapshot();
    root.characters = JSON.parse(JSON.stringify(characterStore.characterList()));
    return {
        snapshot: root as Record<string, any>,
        selected: JSON.parse(JSON.stringify(views.currentPresetRecord())) as Record<string, unknown>,
        selectedModel: JSON.parse(JSON.stringify(views.currentModelPresetRecord())) as Record<string, unknown>,
        presetCount: views.settings.presets.length as number,
        modelPresetCount: views.settings.modelPresets.length as number,
        records,
        close: () => server.current.close(),
    };
}

describe("the boot snapshot of a fresh store against the fresh-boot fixture", () => {
    it("differs only in ids and the id selections", async () => {
        const booted = await bootFresh();
        try {
            const { snapshot, selected, selectedModel } = booted;
            expect(booted.presetCount).toBe(1);
            expect(booted.modelPresetCount).toBe(1);

            const skip = new Set<string>([
                ...DROPPED_FIELDS,
                ...SELECTION_KEYS,
                ...Object.values(COLLECTION_FIELDS),
                ...Object.values(COLLECTION_SELECTION_FIELDS),
                ...PHASE1_LISTS,
            ]);
            const unexpected: unknown[] = [];

            // (1) Every root field of the fixture, forwarded ones read through the layer.
            const absentNowUndefined: string[] = [];
            const absentNowEmptyCredential: string[] = [];
            for (const key of Object.keys(fixture)) {
                if (skip.has(key)) continue;
                if (!isDeepStrictEqual(fixture[key], snapshot[key])) {
                    unexpected.push({ rule: 1, key, before: fixture[key], after: snapshot[key] });
                }
            }
            for (const key of Object.keys(snapshot)) {
                if (Object.hasOwn(fixture, key) || skip.has(key)) continue;
                if (snapshot[key] === undefined) {
                    absentNowUndefined.push(key);
                } else if (EMPTY_CREDENTIALS.includes(key) && snapshot[key] === "") {
                    absentNowEmptyCredential.push(key);
                } else {
                    unexpected.push({ rule: 1, key, before: "(absent)", after: snapshot[key] });
                }
            }
            // The former keep-on-switch fields are forwarded preset fields now: compared in (1) as
            // root fields, and present in the fresh boot with their owner's defaults.
            for (const field of ["seperateModels", "seperateModelsForAxModels", "fallbackWhenBlankResponse"]) {
                expect(Object.hasOwn(fixture, field), field).toBe(true);
                expect(snapshot[field], field).not.toBeUndefined();
            }
            expect(snapshot.fallbackModels).not.toBeUndefined();
            expect(snapshot.seperateParameters).not.toBeUndefined();

            // (2) The selected prompt and model presets against the fixture's effective root, through
            // the aliases, each field read from its owner.
            const rootOf: Record<string, string> = Object.fromEntries(
                Object.entries(PRESET_ROOT_ALIASES).map(([root, preset]) => [preset, root]),
            );
            for (const field of PRESET_FIELDS) {
                if (field === "name" || field === "image") continue;
                const rootKey = rootOf[field] ?? field;
                const record = presetFieldOwner(field) === "model" ? selectedModel : selected;
                if (isDeepStrictEqual(fixture[rootKey], record[field])) continue;
                unexpected.push({ rule: 2, field, rootBefore: fixture[rootKey], presetAfter: record[field] });
            }
            // The stored shapes are disjoint: the model preset holds no prompt field or image, the
            // prompt preset no model field.
            for (const field of MODEL_PRESET_FIELDS) {
                expect(Object.hasOwn(selected, field), field).toBe(false);
            }
            expect(Object.hasOwn(selectedModel, "image")).toBe(false);
            expect(Object.hasOwn(selectedModel, "temperature")).toBe(false);

            // (3) personas[0] and modelPresets[0] ignoring id.
            expect(snapshot.personas).toHaveLength(fixture.personas.length);
            expect(withoutId(snapshot.personas[0])).toEqual(withoutId(fixture.personas[0]));
            expect(snapshot.modelPresets).toHaveLength(1);
            expect(withoutId(snapshot.modelPresets[0])).toEqual(withoutId(fixture.modelPresets[0]));

            // (4) The translator and HypaV3 presets ignoring ids; the selection is the first item.
            for (const [list, selectionKey] of Object.entries(COLLECTION_SELECTION_FIELDS)) {
                expect(snapshot[list].map(withoutId), list).toEqual(fixture[list].map(withoutId));
                expect(fixture[selectionKey], selectionKey).toBe(0);
                expect(snapshot[selectionKey], selectionKey).toBe(snapshot[list][0].id);
            }

            // (5) Every other collection, and the Phase 1 lists, deep-equal.
            for (const key of Object.values(COLLECTION_FIELDS)) {
                if (SELECTABLE.includes(key)) continue;
                expect(snapshot[key], key).toEqual(fixture[key]);
            }
            for (const key of PHASE1_LISTS) {
                if (key === "botPresets") continue;
                expect(snapshot[key], key).toEqual(fixture[key]);
            }

            expect(unexpected).toEqual([]);
            // The write-only mirror's `""` for the four credentials the server leaves absent (7b).
            expect(absentNowEmptyCredential.sort()).toEqual([...EMPTY_CREDENTIALS].sort());
            // Every declared section field is an accessor onto its record (Phase 6 slice 4,
            // `settings-ownership.md`, "Observable changes"): the snapshot lists it, `undefined`
            // when the record lacks it. Each such field is one its record does not hold.
            const sectionOf = new Map<string, string>(
                Object.entries(SECTION_FIELDS).flatMap(([section, fields]) =>
                    (fields as readonly string[]).map((field) => [field, section] as [string, string]),
                ),
            );
            for (const key of absentNowUndefined.filter((key) => sectionOf.has(key))) {
                const record = JSON.parse(JSON.stringify(booted.records.recordData(sectionOf.get(key) as never)));
                expect(Object.hasOwn(record, key), key).toBe(false);
            }
            // These fresh-boot fields intentionally remain `undefined` (and therefore absent in JSON).
            expect(absentNowUndefined.filter((key) => !sectionOf.has(key)).sort()).toEqual([
                "koboldURL",
                "localStopStrings",
                "promptPreprocess",
                "promptTemplate",
                "proxyRequestModel",
            ]);
        } finally {
            booted.close();
        }
    });
});
