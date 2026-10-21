import * as fflate from "fflate";
import { decode as decodeMsgpack } from "msgpackr/index-no-eval";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 2 (`docs/plan/phases/slices/phase-3-settings-sections/shared-schema-and-ids.md`):
// the client preset paths that build on `normalizePreset`: `copyPreset` and every `importPreset`
// path assign fresh ids, and `downloadPreset` strips the id. Since slice 5
// (`forwarding-presets-and-selection.md`) the preset fields are served from the preset this client
// selected (`selection.svelte.ts`, never persisted; `activePreset` since Phase 6 slice 10, where the
// whole-database aggregate and its boot normalization backstop went away: the server normalizes, so
// the fixtures here are normalized by the shared normalizer), `changeToPreset`, `copyPreset`, and
// `downloadPreset` take ids. The actions live in `presets.svelte.ts`. Since the preset split
// (`docs/plan/split-preset.md`) the stored prompt preset and the `.risup` export carry the prompt
// fields only, and a fixture's model fields live in the model preset of the same id
// (`installFlatDatabase`); since the model profiles (`docs/plan/model-profiles.md`) that model
// preset names its profiles by slot, and the connection fields (`maxContext`) live on the profiles. The step-0 fixtures (`fixtures/boot/*.risup`, captured before any
// Phase 3 change) pin the `.risup` reader contract: an import followed by an export decodes to the
// fixture preset's prompt fields apart from `id` (Astra challenge point 1
// found `seperateModels` gained a default here before the keep-on-switch rule).

// As in the browser, the `buffer` polyfill is the global `Buffer` before msgpackr loads. msgpackr
// binds its string encoder at load time: with Node's `Buffer` it takes the `utf8Write` path, which
// later fails on the polyfill buffers `polyfill.ts` installs (and on Node 24's bounds check).
await vi.hoisted(async () => {
    const { Buffer: BufferPolyfill } = await import("buffer");
    (globalThis as any).Buffer = BufferPolyfill;
});

vi.mock("../../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));

vi.mock("../../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

// `stores.svelte` wires module updates into a module-level effect, and the real parser module
// reaches the request pipeline. Neither is exercised.
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

vi.mock("../../parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string) => text),
}));

// The real RPack loads its byte map with `fetch` of a Vite `?url` asset; here the map comes from
// disk, so the fixtures are decoded with the real map (the codec itself is a byte substitution).
vi.mock("../../rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "../../rpack/rpack_map.bin")));
    const encodeMap = map.slice(0, 256);
    const decodeMap = map.slice(256, 512);
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(encodeMap), decodeRPack: apply(decodeMap) };
});

import { decodeRPack } from "../../rpack/rpack_js";
import { decryptBuffer } from "../../util";
import type { botPreset, Database } from "../database.svelte";
import { changeToModelPreset, changeToPreset, copyPreset, downloadPreset, importPreset } from "../presets.svelte";
import { selection, selectModelPreset, selectPreset } from "../selection.svelte";
import { llmSecretState } from "../llmSecrets.svelte";
import {
    activeMainProfile,
    activeModelPreset,
    activePreset,
    readSettingsRoot,
    selectedPresetIndex,
    settings,
} from "../settingsViews.svelte";
import { installFlatDatabase } from "./installFlatDatabase";
import {
    normalizeModelPresets,
    normalizeModelProfiles,
    normalizePresets,
    normalizePromptTemplate,
    plainClone,
    PRESET_DEFAULTS,
    PRESET_RECORD_FIELDS,
    presetTemplate,
    PROMPT_PRESET_FIELDS,
} from "../../../../shared/presets.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fixtureDir = path.resolve(__dirname, "fixtures/boot");

function readFixture(name: string): Uint8Array {
    return new Uint8Array(readFileSync(path.join(fixtureDir, name)));
}

/** The preset a `.risup` file carries, decoded the way `importPreset` decodes it. */
async function decodeRisup(bytes: Uint8Array): Promise<Record<string, unknown>> {
    const container = decodeMsgpack(fflate.decompressSync(await decodeRPack(bytes)));
    expect(container).toMatchObject({ presetVersion: 2, type: "preset" });
    return decodeMsgpack(Buffer.from(await decryptBuffer(container.preset, "risupreset")));
}

/** `toEqual` ignores an own `undefined` property; the exports must not carry an `id` key at all. */
function ownKeys(value: object): string[] {
    return Object.keys(value).sort();
}

/**
 * Installs a legacy save into the records, its presets normalized by the shared normalizers as the
 * server normalizes what it serves (the boot's backstop is gone since slice 10): the prompt presets
 * and the model presets of the same ids from the same fixture entries (each keeps its own fields),
 * and the model profiles (`modelProfiles`); a save without presets or profiles gets the one default
 * record of each kind (the default model preset's slots name the default profile), and the
 * installation selects the first preset of each kind.
 */
function bootWith(extra: Record<string, unknown> = {}) {
    installFlatDatabase({
        characters: [],
        ...extra,
        botPresets: normalizePresets(plainClone(extra.botPresets)),
        modelPresets: normalizeModelPresets(plainClone(extra.botPresets)),
        modelProfiles: normalizeModelProfiles(plainClone(extra.modelProfiles)),
    } as unknown as Database);
}

/** The keys a `.risup` carries since the split: `name`, `image`, and the prompt fields (D5). */
const EXPORTED_KEYS = [...PRESET_RECORD_FIELDS, ...PROMPT_PRESET_FIELDS] as readonly string[];

/** `value` restricted to the exported keys, an absent one as an explicit `undefined` key. */
function promptOnly(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(EXPORTED_KEYS.map((key) => [key, value[key]]));
}

/**
 * The stored preset an import of a file from before the context size override gives: the file's
 * prompt fields, the override off (only a file's own `maxContextOverride: true` turns it on), and
 * `maxContextOverrideSize` seeded from the file's upstream `maxContext` (the file has no size of its
 * own). The two fields are the only additions the normalizer and the importer make.
 */
function storedOf(fixture: Record<string, unknown>): Record<string, unknown> {
    return { ...promptOnly(fixture), maxContextOverride: false, maxContextOverrideSize: fixture.maxContext };
}

/**
 * The export of that stored preset: its prompt fields and the one compatibility model key, upstream
 * RisuAI's `maxContext`, holding the main model's effective size (the override when on and above 0,
 * else the current main profile's `maxContext`).
 */
function exportOf(fixture: Record<string, unknown>, maxContext: number = activeMainProfile.maxContext) {
    return { ...storedOf(fixture), maxContext };
}

describe("the selected preset over a normalized list", () => {
    beforeEach(() => {
        // The selection store is module state: an empty id makes the installation select the first preset.
        selectPreset("");
        selectModelPreset("");
    });

    it("fills an omitted sampling field but keeps an explicit null (Astra challenge point 2)", () => {
        bootWith({
            botPresets: [
                {
                    id: "nulls",
                    name: "nulls",
                    min_p: null,
                    top_a: null,
                    repetition_penalty: null,
                    auxSlots: null,
                },
                { id: "omitted", name: "omitted" },
            ],
        });
        const [nulls, omitted] = settings.presets;
        expect(nulls.min_p).toBeNull();
        expect(nulls.top_a).toBeNull();
        expect(nulls.repetition_penalty).toBeNull();
        expect(omitted.min_p).toBe(0);
        expect(omitted.top_a).toBe(0);
        expect(omitted.repetition_penalty).toBe(1);
        // A model field never lands in a prompt preset; the `null` marker of the old keep-on-switch
        // copy is the model preset's default now.
        expect(Object.hasOwn(nulls, "auxSlots")).toBe(false);
        expect(settings.modelPresets.find((preset) => preset.id === "nulls")!.auxSlots).toEqual(
            PRESET_DEFAULTS.auxSlots,
        );

        // After a switch the forwarded reads serve the selected preset: an explicit null of a nullable
        // field stays null (as `setPreset` always passed it through); the auxiliary models are the
        // selected model preset's.
        changeToPreset("nulls");
        changeToModelPreset("nulls");
        expect(activePreset.min_p).toBeNull();
        expect(activePreset.repetition_penalty).toBeNull();
        expect(activeModelPreset.auxSlots).toEqual({});
        expect(readSettingsRoot("seperateModels")).toEqual({ memory: "", emotion: "", translate: "", otherAx: "" });
        changeToPreset("omitted");
        expect(activePreset.min_p).toBe(0);
        expect(activePreset.repetition_penalty).toBe(1);
    });

    it("keeps ids, values, and the selections across an edit, and a later switch of either kind lands on the right preset", () => {
        bootWith({
            botPresets: [
                { id: "first", name: "first", temperature: 10, mainSlot: { profileId: "p1" } },
                { id: "second", name: "second", temperature: 20, mainSlot: { profileId: "p2" } },
                { id: "third", name: "third", temperature: 30, mainSlot: { profileId: "p3" } },
            ],
            modelProfiles: [
                { id: "p1", name: "p1", maxContext: 1000 },
                { id: "p2", name: "p2", maxContext: 2000 },
                { id: "p3", name: "p3", maxContext: 3000 },
            ],
        });
        changeToPreset("second");
        changeToModelPreset("second");
        expect(activePreset.temperature).toBe(20);
        expect(activeMainProfile.maxContext).toBe(2000);

        // A section write beside the presets (what a plugin `setDatabase` of an allowed key does
        // through the views now) touches neither the list nor the selection.
        settings.ui.theme = "plugin-theme";

        expect(settings.presets.map((preset) => preset.id)).toEqual(["first", "second", "third"]);
        expect(settings.presets.map((preset) => preset.temperature)).toEqual([10, 20, 30]);
        expect(settings.modelPresets.map((preset) => preset.id)).toEqual(["first", "second", "third"]);
        expect(settings.modelPresets.map((preset) => preset.mainSlot.profileId)).toEqual(["p1", "p2", "p3"]);
        expect(settings.modelProfiles.map((profile) => profile.maxContext)).toEqual([1000, 2000, 3000]);
        expect(settings.presets.every((preset) => !Object.hasOwn(preset, "maxContext"))).toBe(true);
        expect(settings.modelPresets.every((preset) => !Object.hasOwn(preset, "maxContext"))).toBe(true);
        expect(selectedPresetIndex()).toBe(1);
        expect(settings.ui.theme).toBe("plugin-theme");

        // An edit of a forwarded field lands in its owner under its id: the selected prompt preset, or
        // the selected model preset's main profile.
        activePreset.temperature = 25;
        activeMainProfile.maxContext = 2500;
        expect(settings.presets[1].id).toBe("second");
        expect(settings.presets[1].temperature).toBe(25);
        expect(settings.presets[0].temperature).toBe(10);
        expect(settings.presets[2].temperature).toBe(30);
        expect(settings.modelProfiles.map((profile) => profile.maxContext)).toEqual([1000, 2500, 3000]);

        // A prompt switch keeps the edit in preset 1 and reads preset 2; the model preset stays.
        activePreset.temperature = 26;
        changeToPreset("third");
        expect(selectedPresetIndex()).toBe(2);
        expect(activePreset.temperature).toBe(30);
        expect(activeMainProfile.maxContext).toBe(2500);
        expect(settings.presets[1].temperature).toBe(26);
        // A model switch reads the other model preset and leaves the prompt selection.
        changeToModelPreset("third");
        expect(activeMainProfile.maxContext).toBe(3000);
        expect(activePreset.temperature).toBe(30);
        expect(selection.presetId).toBe("third");
        expect(settings.presets.map((preset) => preset.id)).toEqual(["first", "second", "third"]);
    });
});

describe("copyPreset and importPreset", () => {
    beforeEach(() => {
        // The selection store is module state: an empty id makes the installation select the first preset.
        selectPreset("");
    });

    it("copyPreset gives the copy a fresh id and the source's values", () => {
        bootWith({ botPresets: [{ id: "source", name: "Source", temperature: 33, min_p: null }] });
        changeToPreset("source");
        copyPreset("source");
        const [source, copy] = settings.presets;
        expect(source.id).toBe("source");
        expect(copy.id).toMatch(UUID_V4);
        expect(copy.name).toBe("Source Copy");
        expect(copy.temperature).toBe(33);
        expect(copy.min_p).toBeNull();
        expect(copy.formatingOrder).not.toBe(source.formatingOrder);
    });

    // The archive feature (risuai-fastify `ee5382a9a` port): `archived` is list metadata of one
    // install. A copy and an import start active; a preset share file never carries it (fastify's
    // export does, so a file with it imports active too).
    it("copyPreset of an archived preset starts active, and the source stays archived", () => {
        bootWith({ botPresets: [{ id: "source", name: "Source", temperature: 33, archived: true }] });
        expect(settings.presets[0].archived).toBe(true);
        copyPreset("source");
        const [source, copy] = settings.presets;
        expect(source.archived).toBe(true);
        expect(copy.name).toBe("Source Copy");
        expect(copy.temperature).toBe(33);
        expect(Object.hasOwn(copy, "archived")).toBe(false);
    });

    it("a JSON import with `archived: true` (another fork's export) starts active", async () => {
        bootWith();
        const file = { name: "Archived elsewhere", temperature: 12, archived: true };
        await importPreset({ name: "archived.json", data: new TextEncoder().encode(JSON.stringify(file)) });
        const imported = settings.presets[1];
        expect(imported.name).toBe("Archived elsewhere");
        expect(imported.temperature).toBe(12);
        expect(Object.hasOwn(imported, "archived")).toBe(false);
    });

    it("neither export format carries `archived`, so a shared file never arrives hidden in the recipient's archive", async () => {
        bootWith({ botPresets: [{ id: "source", name: "Source", temperature: 33, archived: true }] });
        const risup = await downloadPreset("source", "return");
        expect(ownKeys(risup.data)).not.toContain("archived");
        expect(ownKeys(risup.data)).toEqual([...EXPORTED_KEYS, "maxContext"].sort());
        const decoded = await decodeRisup(risup.buf as Uint8Array);
        expect(ownKeys(decoded)).not.toContain("archived");
        const json = await downloadPreset("source", "json");
        expect(ownKeys(json.data)).not.toContain("archived");
        // The stored record keeps it: only the file leaves it out.
        expect(settings.presets[0].archived).toBe(true);
    });

    it("a JSON import gets a fresh id even when the file carries one, keeps its values, and drops the ui fields", async () => {
        bootWith();
        const file = {
            id: "from-file",
            name: "From file",
            temperature: 12,
            min_p: null,
            autoSuggestClean: true,
            openAIKey: "sk-in-file",
        };
        await importPreset({ name: "p.json", data: new TextEncoder().encode(JSON.stringify(file)) });
        expect(settings.presets).toHaveLength(2);
        const imported = settings.presets[1] as unknown as Record<string, unknown>;
        expect(imported.id).toMatch(UUID_V4);
        expect(imported.id).not.toBe("from-file");
        expect(imported.name).toBe("From file");
        expect(imported.temperature).toBe(12);
        expect(imported.min_p).toBeNull();
        // The `importPreset` base is `presetTemplate`, unchanged (`maxResponse` 300).
        expect(imported.maxResponse).toBe(300);
        expect(Object.hasOwn(imported, "autoSuggestClean")).toBe(false);
        expect(Object.hasOwn(imported, "openAIKey")).toBe(false);
    });

    it("the NAI and SillyTavern import paths assign ids", async () => {
        bootWith();
        const nai = {
            presetVersion: 3,
            name: "NAI file",
            parameters: {
                temperature: 1.1,
                max_length: 150,
                top_k: 1,
                top_p: 0.9,
                top_a: 0.1,
                typical_p: 1,
                tail_free_sampling: 0.9,
                repetition_penalty: 2,
                repetition_penalty_range: 100,
                repetition_penalty_slope: 0.1,
                repetition_penalty_frequency: 0,
                repetition_penalty_presence: 0.5,
                cfg_scale: 1.2,
                mirostat_lr: 1,
                mirostat_tau: 0,
            },
        };
        await importPreset({ name: "nai.json", data: new TextEncoder().encode(JSON.stringify(nai)) });
        const st = {
            temperature: 0.5,
            prompt_order: [{ order: [{ identifier: "main", enabled: true }] }],
            prompts: [{ identifier: "main", content: "hello", role: "system" }],
        };
        await importPreset({ name: "st.json", data: new TextEncoder().encode(JSON.stringify(st)) });

        const [, naiPreset, stPreset] = settings.presets;
        expect(naiPreset.id).toMatch(UUID_V4);
        expect(naiPreset.name).toBe("NAI file");
        expect(naiPreset.maxResponse).toBe(150);
        expect(naiPreset.NAISettings.cfg_scale).toBe(1.2);
        expect(stPreset.id).toMatch(UUID_V4);
        expect(stPreset.name).toBe("Imported ST Preset");
        expect(stPreset.temperature).toBe(50);
        expect(stPreset.promptTemplate).toEqual([{ type: "plain", type2: "main", text: "hello", role: "system" }]);
        expect(new Set(settings.presets.map((preset) => preset.id)).size).toBe(3);
    });
});

describe(".risup round trip against the step-0 fixtures", () => {
    beforeEach(() => {
        // The selection store is module state: an empty id makes the installation select the first preset.
        selectPreset("");
    });

    for (const name of ["default.risup", "custom.risup"]) {
        it(`${name}: the import gets a fresh id, and the export decodes to the fixture preset without an id`, async () => {
            bootWith();
            const fixture = await decodeRisup(readFixture(name));
            expect(Object.hasOwn(fixture, "id")).toBe(false);

            await importPreset({ name, data: readFixture(name) });
            expect(settings.presets).toHaveLength(2);
            const imported = settings.presets[1];
            expect(imported.id).toMatch(UUID_V4);
            expect(imported.name).toBe(fixture.name);

            const exported = await downloadPreset(imported.id, "return");
            expect(exported.buf).toBeInstanceOf(Uint8Array);
            expect(ownKeys(exported.data)).not.toContain("id");
            // A prompt preset file (`docs/plan/split-preset.md`): no credential, and no model field
            // but the compatibility `maxContext`: the main model's effective size, here the main
            // profile's since the override is off.
            for (const key of ["openAIKey", "proxyKey", "forceReplaceUrl", "aiModel"]) {
                expect(Object.hasOwn(exported.data, key), key).toBe(false);
            }
            expect(exported.data.maxContext).toBe(activeMainProfile.maxContext);

            const decoded = await decodeRisup(exported.buf as Uint8Array);
            expect(ownKeys(decoded)).not.toContain("id");
            expect(decoded).toEqual(exportOf(fixture));
            // The import itself, apart from the id, is the fixture preset's prompt fields: the
            // normalizer changed nothing the pre-phase reader wrote (no explicit value replaced), and
            // the record carries no model field (not the file's `maxContext`) and no credential. The
            // only additions are the two override fields the fixture predates: the flag off, the size
            // seeded from the file's `maxContext`.
            const { id, ...importedWithoutId } = imported as botPreset & Record<string, unknown>;
            expect(id).toMatch(UUID_V4);
            expect(Object.hasOwn(importedWithoutId, "proxyKey")).toBe(false);
            expect(Object.hasOwn(importedWithoutId, "aiModel")).toBe(false);
            expect(Object.hasOwn(importedWithoutId, "maxContext")).toBe(false);
            expect(importedWithoutId).toEqual(storedOf(fixture));
            expect(importedWithoutId.maxContextOverride).toBe(false);
            expect(importedWithoutId.maxContextOverrideSize).toBe(fixture.maxContext);
            // The fixture does carry model fields, so the comparison is not vacuous.
            expect(fixture).toHaveProperty("aiModel");
            expect(fixture).toHaveProperty("maxContext");
        });
    }

    it("the custom fixture carries the non-default values the capture set, so the comparison is not vacuous", async () => {
        const custom = await decodeRisup(readFixture("custom.risup"));
        expect(custom.name).toBe("커스텀 プリセット ✓");
        expect(custom.temperature).not.toBe(80);
        expect(custom.regex).not.toEqual([]);
        expect((custom.seperateParameters as { overrides: object }).overrides).not.toEqual({});
        expect(Array.isArray(custom.promptTemplate)).toBe(true);
    });
});

/**
 * The pre-Phase 3 `importPreset` logic for a decoded `.risup` preset (commit `577c43ae`): the
 * template spread under the file, the prompt template normalized, and the object stored as it is
 * (no canonical list, so every key the file carries, an explicit `undefined` included, lands in the
 * stored preset; the old `setPreset` kept the working value for an `undefined` field and applied a
 * `false`). `presetTemplate` is the pre-phase template unchanged.
 */
function legacyImportPreset(decoded: Record<string, unknown>): Record<string, unknown> {
    const pre: Record<string, unknown> = { ...presetTemplate, ...decoded };
    if (pre.promptTemplate !== undefined) {
        pre.promptTemplate = normalizePromptTemplate(pre.promptTemplate as never);
    }
    return pre;
}

describe(".risup compatibility with the pre-Phase 3 reader (slice 7)", () => {
    beforeEach(() => {
        selectPreset("");
    });

    for (const name of ["default.risup", "custom.risup"]) {
        it(`${name}: the export carries exactly the fixture's keys and values, explicit undefined included, over two cycles, and the pre-phase reader stores the same preset`, async () => {
            bootWith();
            const fixture = await decodeRisup(readFixture(name));
            // The pre-phase export carried the unset fields as explicit `undefined` keys: the check
            // below is about them, so they must exist in the fixture (Astra slice 7 challenge point 1).
            const unsetInFixture = Object.keys(fixture)
                .filter((key) => fixture[key] === undefined)
                .sort();
            expect(unsetInFixture).toEqual(
                expect.arrayContaining(["promptPreprocess", "koboldURL", "proxyRequestModel", "localStopStrings"]),
            );

            // The current main profile's size is what the export carries as `maxContext`; a value
            // the legacy template does not have, so the old-reader check below is not vacuous.
            activeMainProfile.maxContext = 12345;
            expect(presetTemplate.maxContext).toBe(4000);

            await importPreset({ name, data: readFixture(name) });
            const first = await downloadPreset(settings.presets[1].id, "return");
            const decodedFirst = await decodeRisup(first.buf as Uint8Array);
            // The export carries exactly the prompt keys (`name`, `image`, `PROMPT_PRESET_FIELDS`)
            // and the compatibility `maxContext`, an unset one as an explicit `undefined`.
            // `toStrictEqual` distinguishes a missing key from an `undefined` one (`toEqual` does not).
            expect(ownKeys(decodedFirst)).toEqual([...EXPORTED_KEYS, "maxContext"].sort());
            expect(decodedFirst).toStrictEqual(exportOf(fixture, 12345));
            for (const key of unsetInFixture.filter((key) => EXPORTED_KEYS.includes(key))) {
                expect(Object.hasOwn(decodedFirst, key), key).toBe(true);
                expect(decodedFirst[key], key).toBeUndefined();
            }
            expect(Object.hasOwn(first.data, "proxyKey")).toBe(false);
            expect(Object.hasOwn(first.data, "openAIKey")).toBe(false);

            // A second import/export cycle of the new export is a fixed point: the export's own
            // size (seeded on the first import) is kept, the flag stays off.
            await importPreset({ name, data: first.buf as Uint8Array });
            expect(settings.presets).toHaveLength(3);
            const second = await downloadPreset(settings.presets[2].id, "return");
            expect(await decodeRisup(second.buf as Uint8Array)).toStrictEqual(exportOf(fixture, 12345));

            // The pre-phase reader stores the same prompt fields from the new export as from the
            // fixture: in particular `promptPreprocess` stays `undefined` (its working value kept),
            // not the template's `false` an absent key would have given it. The two override fields
            // are the one addition (that reader's template has neither). The model fields the export
            // no longer carries come from that reader's template (the upstream contract of
            // `docs/plan/split-preset.md`, "Import / export"), except `maxContext`, which the export
            // carries so that upstream's `setPreset` applies the size the preset was used with.
            const fromExport = legacyImportPreset(decodedFirst);
            expect(promptOnly(fromExport)).toStrictEqual({
                ...promptOnly(legacyImportPreset(fixture)),
                maxContextOverride: false,
                maxContextOverrideSize: fixture.maxContext,
            });
            for (const key of ["aiModel", "subModel", "forceReplaceUrl"]) {
                expect(fromExport[key], key).toStrictEqual((presetTemplate as Record<string, unknown>)[key]);
            }
            expect(fromExport.maxContext).toBe(12345);
            expect(presetTemplate.promptPreprocess).toBe(false);
            expect(Object.hasOwn(fromExport, "promptPreprocess")).toBe(true);
            expect(fromExport.promptPreprocess).toBeUndefined();
        });
    }

    it("the JSON export drops the unset fields, as the pre-phase JSON export did (JSON has no undefined)", async () => {
        bootWith();
        await importPreset({ name: "default.risup", data: readFixture("default.risup") });
        const exported = await downloadPreset(settings.presets[1].id, "json");
        // The `.json` path hands the same object to the file writer; its JSON text has no unset key.
        const text = JSON.stringify(exported.data);
        expect(Object.hasOwn(exported.data, "promptPreprocess")).toBe(true);
        expect(JSON.parse(text)).not.toHaveProperty("promptPreprocess");
        expect(JSON.parse(text)).not.toHaveProperty("id");
        expect(JSON.parse(text)).not.toHaveProperty("aiModel");
        expect(JSON.parse(text).maxContext).toBe(activeMainProfile.maxContext);
    });
});

// The prompt preset's context size override in the files (`maxContextOverride`,
// `maxContextOverrideSize`; `maxContextOverrideOf` in `shared/sections.ts`): an import turns it on
// only from a file's own flag and takes the file's own size when that is a finite number above 0,
// else the file's upstream `maxContext` (the template's 4000 when the file lacks it); an export of
// either format carries upstream's `maxContext` as the effective size, never 0.
describe("the context size override in import and export", () => {
    beforeEach(() => {
        selectPreset("");
        selectModelPreset("");
    });

    async function importJson(file: Record<string, unknown>): Promise<botPreset & Record<string, unknown>> {
        const before = settings.presets.length;
        await importPreset({ name: "p.json", data: new TextEncoder().encode(JSON.stringify({ name: "f", ...file })) });
        expect(settings.presets).toHaveLength(before + 1);
        return settings.presets[before] as botPreset & Record<string, unknown>;
    }

    it("an import keeps a file's own flag and positive size, and never stores the file's maxContext", async () => {
        bootWith();
        const on = await importJson({ maxContextOverride: true, maxContextOverrideSize: 9000, maxContext: 5000 });
        expect(on.maxContextOverride).toBe(true);
        expect(on.maxContextOverrideSize).toBe(9000);
        expect(Object.hasOwn(on, "maxContext")).toBe(false);
        // The flag as the file has it: off stays off with a size, and a non-boolean is off.
        const off = await importJson({ maxContextOverride: false, maxContextOverrideSize: 9000, maxContext: 5000 });
        expect(off.maxContextOverride).toBe(false);
        expect(off.maxContextOverrideSize).toBe(9000);
        const invalid = await importJson({ maxContextOverride: "yes", maxContextOverrideSize: 9000 });
        expect(invalid.maxContextOverride).toBe(false);
        expect(invalid.maxContextOverrideSize).toBe(9000);
    });

    it("an import seeds an unset or invalid size from the file's maxContext, else from the template's 4000, with the flag off unless the file turns it on", async () => {
        bootWith();
        // A metatron export with an unset size (0) and the compatibility `maxContext`.
        const unset = await importJson({ maxContextOverrideSize: 0, maxContext: 5000 });
        expect(unset.maxContextOverride).toBe(false);
        expect(unset.maxContextOverrideSize).toBe(5000);
        // An upstream file: no override fields at all.
        const upstream = await importJson({ maxContext: 6000 });
        expect(upstream.maxContextOverride).toBe(false);
        expect(upstream.maxContextOverrideSize).toBe(6000);
        // Not finite, negative, or not a number: the file's `maxContext` instead (Astra point 6).
        for (const size of [Infinity, -1, "9000", null]) {
            const seeded = await importJson({
                maxContextOverride: true,
                maxContextOverrideSize: size,
                maxContext: 7000,
            });
            expect(seeded.maxContextOverride, String(size)).toBe(true);
            expect(seeded.maxContextOverrideSize, String(size)).toBe(7000);
        }
        // A file without `maxContext` takes the import template's 4000 (accepted).
        expect(presetTemplate.maxContext).toBe(4000);
        const bare = await importJson({});
        expect(bare.maxContextOverride).toBe(false);
        expect(bare.maxContextOverrideSize).toBe(4000);
        // A file whose `maxContext` is not a positive size either leaves the default 0.
        const zero = await importJson({ maxContext: 0 });
        expect(zero.maxContextOverrideSize).toBe(0);
    });

    it("an export of either format carries the effective size as maxContext: the override when on and above 0, else the current main profile's, else 4000; the settings root stays the profile's", async () => {
        bootWith({
            botPresets: [
                { id: "on", name: "on", maxContextOverride: true, maxContextOverrideSize: 9000 },
                { id: "zero", name: "zero", maxContextOverride: true, maxContextOverrideSize: 0 },
                { id: "off", name: "off", maxContextOverride: false, maxContextOverrideSize: 9000 },
            ],
        });
        changeToPreset("on");
        activeMainProfile.maxContext = 7000;
        // The plugin root (`getDatabase` → `setDatabase` round trip) keeps the stored profile size.
        expect(readSettingsRoot("maxContext")).toBe(7000);
        expect(activeMainProfile.maxContext).toBe(7000);

        const json = async (id: string) => JSON.parse(JSON.stringify((await downloadPreset(id, "json")).data));
        const risup = async (id: string) => decodeRisup((await downloadPreset(id, "return")).buf as Uint8Array);

        expect((await json("on")).maxContext).toBe(9000);
        expect((await risup("on")).maxContext).toBe(9000);
        expect((await json("on")).maxContextOverride).toBe(true);
        expect((await json("on")).maxContextOverrideSize).toBe(9000);
        // The export of a preset that is not the selected one still reads the current main profile.
        expect((await json("zero")).maxContext).toBe(7000);
        expect((await risup("zero")).maxContext).toBe(7000);
        expect((await json("off")).maxContext).toBe(7000);
        expect((await risup("off")).maxContext).toBe(7000);

        // Never 0: a profile whose size is 0 (the editor allows it) exports the schema default.
        activeMainProfile.maxContext = 0;
        expect((await json("off")).maxContext).toBe(PRESET_DEFAULTS.maxContext);
        expect((await risup("zero")).maxContext).toBe(PRESET_DEFAULTS.maxContext);
        expect(PRESET_DEFAULTS.maxContext).toBe(4000);
        expect((await json("on")).maxContext).toBe(9000);
        // The export never writes the profile.
        expect(activeMainProfile.maxContext).toBe(0);
        expect(settings.presets.find((preset) => preset.id === "zero")!.maxContextOverrideSize).toBe(0);
    });
});

/**
 * Phase 4, slice 7 (`imports-through-the-module.md`, A24): every `importPreset` path adds its preset
 * through `addPreset` after `normalizePreset`, so a converted value the file lacks (the ST
 * `presence_penalty` arithmetic gives `NaN`, which `addPreset`'s JSON check would refuse) gets the
 * field's default, the preset lands under the fresh id `addPreset` returns, a `proxyKey` a JSON file
 * carries is ignored (`docs/plan/split-preset.md`: the key belongs to a model preset), and the
 * selection stays where it was.
 */
describe("importPreset through addPreset (Phase 4 slice 7)", () => {
    beforeEach(() => {
        selectPreset("");
    });

    it("an ST preset without presence_penalty gets the field's default, not NaN, and is selected nowhere", async () => {
        bootWith();
        const selected = selection.presetId;
        const st = {
            prompt_order: [{ order: [{ identifier: "main", enabled: true }] }],
            prompts: [{ identifier: "main", content: "hello", role: "system" }],
        };
        await importPreset({ name: "st.json", data: new TextEncoder().encode(JSON.stringify(st)) });
        expect(settings.presets).toHaveLength(2);
        const imported = settings.presets[1];
        expect(imported.id).toMatch(UUID_V4);
        expect(imported.PresensePenalty).toBe(PRESET_DEFAULTS.PresensePenalty);
        expect(Number.isFinite(imported.PresensePenalty)).toBe(true);
        expect(imported.name).toBe("Imported ST Preset");
        expect(selection.presetId).toBe(selected);
        expect(selectedPresetIndex()).toBe(0);
    });

    it("an NAI preset with omitted optional parameters gets the NAI defaults", async () => {
        bootWith();
        const nai = { presetVersion: 3, name: "Sparse NAI", parameters: { temperature: 1.1, max_length: 150 } };
        await importPreset({ name: "nai.json", data: new TextEncoder().encode(JSON.stringify(nai)) });
        const imported = settings.presets[1];
        expect(imported.id).toMatch(UUID_V4);
        expect(imported.name).toBe("Sparse NAI");
        expect(imported.temperature).toBeCloseTo(110);
        expect(imported.maxResponse).toBe(150);
        // `repetition_penalty_presence * 100` is NaN without the parameter: the default lands instead.
        expect(imported.PresensePenalty).toBe(PRESET_DEFAULTS.PresensePenalty);
        expect(imported.NAISettings).toMatchObject({ cfg_scale: 1, mirostat_tau: 0, mirostat_lr: 1, starter: "" });
    });

    it("a JSON preset's proxyKey and model fields are ignored: no credential write, nothing on the preset, no model preset added", async () => {
        bootWith();
        llmSecretState.queue.splice(0);
        const file = { name: "With key", proxyKey: "pk-from-file", temperature: 12, aiModel: "file-model" };
        await importPreset({ name: "keyed.json", data: new TextEncoder().encode(JSON.stringify(file)) });
        const imported = settings.presets[1] as unknown as Record<string, unknown>;
        expect(imported.id).toMatch(UUID_V4);
        expect(imported.temperature).toBe(12);
        expect(Object.hasOwn(imported, "proxyKey")).toBe(false);
        expect(Object.hasOwn(imported, "aiModel")).toBe(false);
        expect(llmSecretState.queue).toEqual([]);
        expect(settings.modelPresets).toHaveLength(1);
        expect(JSON.stringify(settings.modelPresets)).not.toContain("file-model");
        expect(selectedPresetIndex()).toBe(0);
    });
});
