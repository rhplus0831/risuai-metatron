import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
    PRESET_KEEP_ON_SWITCH_FIELDS,
    PRESET_FIELDS,
    PRESET_ROOT_ALIASES,
    type PresetField,
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
// oracle, kept as a test. `fixtures/phase3/boot-snapshot.json` is `getDatabase({ snapshot: true })`
// of a fresh pre-Phase 3 boot (`4914ccc7`, see the fixture README). Here the client boots the way
// `loadData` does against the real server store (`storeBackedServer.ts`: the server normalizers
// materialize every section and collection, so what `installBootRecords` receives is what a fresh
// server holds), and the same shape (`rootSnapshot()`, the legacy flat settings with `proxyKey: ""`
// and the three selection indexes, plus the characters; Phase 6 slice 10) is compared by the rule:
//
// 1. every root field of the fixture outside `DROPPED_FIELDS` and the selection keys equals the
//    post-phase value, a forwarded field read through the layer; the keep-on-switch fields are
//    `providers` fields and are compared here;
// 2. the selected preset equals the old effective root (the fixture's root working copy, not the
//    dormant `botPresets[0]` template payload) through `PRESET_ROOT_ALIASES`, apart from `name`,
//    `image`, and the keep-on-switch group;
// 3. `personas[0]` ignoring `id`;
// 4. the translator and HypaV3 preset lists ignoring ids, with the first item selected;
// 5. every other collection deep-equal.
//
// The only allowed differences are pinned by field and value: the nine preset fields the pre-phase
// first boot left unset in the root (absent from the fixture) that now read the canonical default,
// the value `saveCurrentPreset` already wrote into every preset before the phase, and (Phase 5 slice
// 7b, `request-layer-and-llm-secrets.md`) the four `llmSecrets` credential fields the fixture left
// absent that the write-only mirror now holds as `""` (`mirrorFields`: every credential field of
// the `llmSecrets` record is `""`). A field the pre-phase boot left `undefined` (dropped by the fixture's JSON)
// that is still `undefined` is equal. The phase file records the result; anything else is a regression.

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

/** The nine allowed differences: unset in the pre-phase first boot, now the canonical default. */
const ALLOWED_DEFAULTS: Partial<Record<PresetField, unknown>> = {
    moduleIntergration: "",
    JinjaTemplate: "",
    jsonSchemaEnabled: false,
    jsonSchema: "",
    extractJson: "",
    groupTemplate: "",
    thinkingTokens: null,
    outputImageModal: false,
    dynamicOutput: null,
};

/**
 * The four credential fields the pre-phase boot left unset: the write-only `llmSecrets` mirror
 * holds `""` for every credential field (7b), so these read `""` where the fixture has nothing.
 */
const EMPTY_CREDENTIALS = ["claudeAPIKey", "mistralKey", "cohereAPIKey", "novellistAPI"];

const PHASE1_LISTS = ["botPresets", "characters", "modules", "plugins", "pluginCustomStorage"];
const SELECTABLE = ["personas", "translatorPresets", "hypaV3Presets"];

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
    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    // The compared shape: the legacy flat settings, plus the characters (`rootSnapshot` has none).
    const root = snapshots.rootSnapshot();
    root.characters = JSON.parse(JSON.stringify(characterStore.characterList()));
    return {
        snapshot: root as Record<string, any>,
        selected: JSON.parse(JSON.stringify(views.currentPresetRecord())) as Record<string, unknown>,
        presetCount: views.settings.presets.length as number,
        records,
        close: () => server.current.close(),
    };
}

describe("the boot snapshot of a fresh store against the pre-Phase 3 fixture", () => {
    it("differs only in the nine recorded preset defaults, ids, and the id selections", async () => {
        const booted = await bootFresh();
        try {
            const { snapshot, selected } = booted;
            expect(booted.presetCount).toBe(1);

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
            const absentNowDefault: string[] = [];
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
                } else if (
                    Object.hasOwn(ALLOWED_DEFAULTS, key) &&
                    isDeepStrictEqual(snapshot[key], ALLOWED_DEFAULTS[key])
                ) {
                    absentNowDefault.push(key);
                } else if (EMPTY_CREDENTIALS.includes(key) && snapshot[key] === "") {
                    absentNowEmptyCredential.push(key);
                } else {
                    unexpected.push({ rule: 1, key, before: "(absent)", after: snapshot[key] });
                }
            }
            // The keep-on-switch fields are `providers` fields: compared as root fields, never through
            // the selected preset. The pre-phase boot left three of them `undefined` in the root, and
            // the `providers` normalizer never fills the group, so they are unset in both.
            for (const field of PRESET_KEEP_ON_SWITCH_FIELDS) {
                expect(isDeepStrictEqual(snapshot[field], fixture[field]), field).toBe(true);
            }
            expect(PRESET_KEEP_ON_SWITCH_FIELDS.filter((field) => Object.hasOwn(fixture, field))).toEqual([
                "fallbackModels",
                "seperateParameters",
            ]);
            expect(snapshot.fallbackModels).not.toBeUndefined();
            expect(snapshot.seperateParameters).not.toBeUndefined();

            // (2) The selected preset against the old effective root, through the aliases.
            const rootOf: Record<string, string> = Object.fromEntries(
                Object.entries(PRESET_ROOT_ALIASES).map(([root, preset]) => [preset, root]),
            );
            const keepOnSwitch = new Set<string>(PRESET_KEEP_ON_SWITCH_FIELDS);
            const presetDefaults: string[] = [];
            for (const field of PRESET_FIELDS) {
                if (field === "name" || field === "image" || keepOnSwitch.has(field)) continue;
                const rootKey = rootOf[field] ?? field;
                if (isDeepStrictEqual(fixture[rootKey], selected[field])) continue;
                if (
                    fixture[rootKey] === undefined &&
                    Object.hasOwn(ALLOWED_DEFAULTS, field) &&
                    isDeepStrictEqual(selected[field], ALLOWED_DEFAULTS[field])
                ) {
                    presetDefaults.push(field);
                } else {
                    unexpected.push({ rule: 2, field, rootBefore: fixture[rootKey], presetAfter: selected[field] });
                }
            }

            // (3) personas[0] ignoring id.
            expect(snapshot.personas).toHaveLength(fixture.personas.length);
            expect(withoutId(snapshot.personas[0])).toEqual(withoutId(fixture.personas[0]));

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
            // The allowed differences, each seen: as a root read and as the selected preset's field.
            const nine = Object.keys(ALLOWED_DEFAULTS).sort();
            expect(absentNowDefault.sort()).toEqual(nine);
            expect(presetDefaults.sort()).toEqual(nine);
            // The write-only mirror's `""` for the four credentials the fixture left absent (7b).
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
            // The pre-phase boot left these `undefined` too (the fixture's JSON dropped them).
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
