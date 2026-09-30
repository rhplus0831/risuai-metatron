import * as fflate from "fflate";
import { decode as decodeMsgpack } from "msgpackr/index-no-eval";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 2 (`docs/plan/phases/slices/phase-3-settings-sections/shared-schema-and-ids.md`):
// the client preset paths that build on `normalizePreset`. `setDatabase` normalizes the stored
// list on every call (also the plugin `setDatabase` path), `copyPreset` and every `importPreset`
// path assign fresh ids, and `downloadPreset` strips the id. Since slice 5
// (`forwarding-presets-and-selection.md`) the preset fields of `DBState.db` are forwarded to the
// preset this client selected (`selection.svelte.ts`, never persisted), `changeToPreset`,
// `copyPreset`, and `downloadPreset` take ids, and `saveCurrentPreset` writes only the keep-on-switch
// fields into the selected preset. The step-0 fixtures (`fixtures/phase3/*.risup`, captured before
// any Phase 3 change) pin the `.risup` contract: an import followed by an export decodes to the
// fixture preset apart from `id` (Astra challenge point 1 found `seperateModels` gained a default
// here before the keep-on-switch rule).

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

vi.mock("../../alert", () => ({
    alertNormal: vi.fn(),
    alertError: vi.fn(),
}));

// `stores.svelte` runs a module-level effect that reaches back into `database.svelte` while it is
// still being evaluated, and the real parser module reads `selIdState` early. Neither is exercised.
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
import { DBState } from "../../stores.svelte";
import {
    changeToPreset,
    copyPreset,
    downloadPreset,
    importPreset,
    saveCurrentPreset,
    setDatabase,
    type botPreset,
    type Database,
} from "../database.svelte";
import { selection, selectPreset } from "../selection.svelte";
import { normalizePromptTemplate, PRESET_KEEP_ON_SWITCH_FIELDS, presetTemplate } from "../../../../shared/presets.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fixtureDir = path.resolve(__dirname, "fixtures/phase3");

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

function legacySave(extra: Record<string, unknown>): Database {
    return { characters: [], ...extra } as unknown as Database;
}

function bootWith(extra: Record<string, unknown> = {}) {
    DBState.db = {} as Database;
    setDatabase(legacySave(extra));
    return DBState.db;
}

describe("setDatabase normalizes the stored presets", () => {
    beforeEach(() => {
        DBState.db = {} as Database;
        // The selection store is module state: an empty id makes `setDatabase` select the first preset.
        selectPreset("");
    });

    it("gives a fresh save one default preset with an id, selected", () => {
        const db = bootWith();
        expect(db.botPresets).toHaveLength(1);
        expect(db.botPresets[0].id).toMatch(UUID_V4);
        expect(db.botPresets[0].name).toBe("New Preset");
        expect(db.botPresetsId).toBe(0);
    });

    it("backstops ids of presets saved before Phase 3, keeps existing ids and values, and re-keys a duplicate", () => {
        const db = bootWith({
            botPresets: [
                {
                    name: "legacy",
                    temperature: 42,
                    openAIKey: "sk-old",
                    autoSuggestPrefix: "p",
                    autoSuggestClean: true,
                },
                { id: "keep", name: "kept", maxResponse: 777 },
                { id: "keep", name: "dup" },
            ],
        });
        const [legacy, kept, dup] = db.botPresets;
        expect(legacy.id).toMatch(UUID_V4);
        expect(legacy.name).toBe("legacy");
        expect(legacy.temperature).toBe(42);
        // Not preset fields any more: the global secret and the two `ui` fields leave the record.
        expect(Object.hasOwn(legacy, "openAIKey")).toBe(false);
        expect(Object.hasOwn(legacy, "autoSuggestPrefix")).toBe(false);
        expect(Object.hasOwn(legacy, "autoSuggestClean")).toBe(false);
        expect(kept.id).toBe("keep");
        expect(kept.maxResponse).toBe(777);
        expect(dup.id).toMatch(UUID_V4);
        expect(dup.name).toBe("dup");
        // The selection is per client and by id (slice 5): selecting the kept id reads back as its index.
        selectPreset("keep");
        expect(db.botPresetsId).toBe(1);
    });

    it("fills an omitted sampling field but keeps an explicit null (Astra challenge point 2)", () => {
        const db = bootWith({
            botPresets: [
                {
                    id: "nulls",
                    name: "nulls",
                    min_p: null,
                    top_a: null,
                    repetition_penalty: null,
                    seperateModels: null,
                },
                { id: "omitted", name: "omitted" },
            ],
        });
        const [nulls, omitted] = db.botPresets;
        expect(nulls.min_p).toBeNull();
        expect(nulls.top_a).toBeNull();
        expect(nulls.repetition_penalty).toBeNull();
        expect(nulls.seperateModels).toBeNull();
        expect(omitted.min_p).toBe(0);
        expect(omitted.top_a).toBe(0);
        expect(omitted.repetition_penalty).toBe(1);
        for (const field of PRESET_KEEP_ON_SWITCH_FIELDS) {
            expect(Object.hasOwn(omitted, field), field).toBe(false);
        }

        // After a switch the forwarded reads serve the selected preset: an explicit null of a nullable
        // field stays null (as `setPreset` always passed it through), and `setPreset` copies the
        // keep-on-switch fallback for the null `seperateModels` into `providers`.
        changeToPreset("nulls", false);
        expect(DBState.db.min_p).toBeNull();
        expect(DBState.db.repetition_penalty).toBeNull();
        expect(DBState.db.seperateModels).toEqual({ memory: "", emotion: "", translate: "", otherAx: "" });
        changeToPreset("omitted", false);
        expect(DBState.db.min_p).toBe(0);
        expect(DBState.db.repetition_penalty).toBe(1);
    });

    it("re-entering setDatabase on the live database (the plugin setDatabase path) keeps ids, values, and the selection, and later save and switch land on the right preset", () => {
        bootWith({
            botPresets: [
                { id: "first", name: "first", temperature: 10, maxContext: 1000 },
                { id: "second", name: "second", temperature: 20, maxContext: 2000 },
                { id: "third", name: "third", temperature: 30, maxContext: 3000 },
            ],
        });
        changeToPreset("second", false);
        expect(DBState.db.temperature).toBe(20);

        // What `setPluginDatabase` does after assigning an allowed key on the live database.
        const live = DBState.db;
        live.theme = "plugin-theme";
        setDatabase(live);

        expect(DBState.db.botPresets.map((preset) => preset.id)).toEqual(["first", "second", "third"]);
        expect(DBState.db.botPresets.map((preset) => preset.temperature)).toEqual([10, 20, 30]);
        expect(DBState.db.botPresets.map((preset) => preset.maxContext)).toEqual([1000, 2000, 3000]);
        expect(DBState.db.botPresetsId).toBe(1);
        expect(DBState.db.theme).toBe("plugin-theme");

        // An edit of a forwarded field lands in the selected preset under its id, and
        // `saveCurrentPreset` leaves it there.
        DBState.db.temperature = 25;
        saveCurrentPreset();
        expect(DBState.db.botPresets[1].id).toBe("second");
        expect(DBState.db.botPresets[1].temperature).toBe(25);
        expect(DBState.db.botPresets[0].temperature).toBe(10);
        expect(DBState.db.botPresets[2].temperature).toBe(30);

        // A switch keeps the edit in preset 1 and reads preset 2.
        DBState.db.temperature = 26;
        changeToPreset("third");
        expect(DBState.db.botPresetsId).toBe(2);
        expect(DBState.db.temperature).toBe(30);
        expect(DBState.db.maxContext).toBe(3000);
        expect(DBState.db.botPresets[1].temperature).toBe(26);
        expect(DBState.db.botPresets.map((preset) => preset.id)).toEqual(["first", "second", "third"]);
    });

    it("normalizes the same list to the same text on a second pass (no spurious save on reload)", () => {
        const db = bootWith({
            botPresets: [
                { id: "a", name: "a", min_p: null, promptTemplate: [{ type: "plain", role: "assistant", text: "t" }] },
                { name: "b" },
            ],
        });
        const first = JSON.stringify(db.botPresets);
        setDatabase(DBState.db);
        expect(JSON.stringify(DBState.db.botPresets)).toBe(first);
    });
});

describe("saveCurrentPreset", () => {
    beforeEach(() => {
        DBState.db = {} as Database;
        // The selection store is module state: an empty id makes `setDatabase` select the first preset.
        selectPreset("");
    });

    it("writes the canonical form under the current id: no id churn, no credential or global fields", () => {
        bootWith({ botPresets: [{ id: "current", name: "current" }] });
        DBState.db.openAIKey = "sk-live";
        DBState.db.autoSuggestPrefix = "prefix";
        DBState.db.autoSuggestClean = true;
        DBState.db.temperature = 55;
        saveCurrentPreset();
        const saved = DBState.db.botPresets[0] as unknown as Record<string, unknown>;
        expect(saved.id).toBe("current");
        expect(saved.name).toBe("current");
        expect(saved.temperature).toBe(55);
        for (const field of ["openAIKey", "autoSuggestPrefix", "autoSuggestClean", "forceReplaceUrl2"]) {
            expect(Object.hasOwn(saved, field), field).toBe(false);
        }
        expect(DBState.db.openAIKey).toBe("sk-live");
    });

    it("keeps seperateModels null while doNotChangeSeperateModels is on (Astra challenge point 1)", () => {
        bootWith({ botPresets: [{ id: "current", name: "current" }] });
        DBState.db.seperateModels = { memory: "m", emotion: "e", translate: "t", otherAx: "o" };
        DBState.db.seperateModelsForAxModels = true;

        DBState.db.doNotChangeSeperateModels = true;
        saveCurrentPreset();
        const frozen = DBState.db.botPresets[0];
        expect(Object.hasOwn(frozen, "seperateModels")).toBe(true);
        expect(frozen.seperateModels).toBeNull();
        expect(frozen.seperateModelsForAxModels).toBe(false);
        expect(frozen.id).toBe("current");

        DBState.db.doNotChangeSeperateModels = false;
        saveCurrentPreset();
        const written = DBState.db.botPresets[0];
        expect(written.seperateModels).toEqual({ memory: "m", emotion: "e", translate: "t", otherAx: "o" });
        expect(written.seperateModelsForAxModels).toBe(true);
    });

    it("never pushes a preset: while the selection names no record it writes nothing (dropped, never redirected)", () => {
        // Before slice 5 an out-of-bounds `botPresetsId` made `saveCurrentPreset` push a new preset.
        // The selection is an id now, and `saveCurrentPreset` resolves it like the accessor setters
        // (`selectedPresetForWrite`): an id naming no record means no target, so the keep-on-switch
        // fields go nowhere; the first preset is not written instead.
        bootWith({ botPresets: [{ id: "only", name: "only" }] });
        selectPreset("missing");
        DBState.db.fallbackWhenBlankResponse = true;
        saveCurrentPreset();
        expect(DBState.db.botPresets).toHaveLength(1);
        expect(DBState.db.botPresets[0].id).toBe("only");
        expect(Object.hasOwn(DBState.db.botPresets[0], "fallbackWhenBlankResponse")).toBe(false);
        expect(selection.presetId).toBe("missing");
    });
});

describe("copyPreset and importPreset", () => {
    beforeEach(() => {
        DBState.db = {} as Database;
        // The selection store is module state: an empty id makes `setDatabase` select the first preset.
        selectPreset("");
    });

    it("copyPreset gives the copy a fresh id and the source's values", () => {
        bootWith({ botPresets: [{ id: "source", name: "Source", temperature: 33, min_p: null }] });
        changeToPreset("source", false);
        copyPreset("source");
        const [source, copy] = DBState.db.botPresets;
        expect(source.id).toBe("source");
        expect(copy.id).toMatch(UUID_V4);
        expect(copy.name).toBe("Source Copy");
        expect(copy.temperature).toBe(33);
        expect(copy.min_p).toBeNull();
        expect(copy.formatingOrder).not.toBe(source.formatingOrder);
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
        expect(DBState.db.botPresets).toHaveLength(2);
        const imported = DBState.db.botPresets[1] as unknown as Record<string, unknown>;
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

        const [, naiPreset, stPreset] = DBState.db.botPresets;
        expect(naiPreset.id).toMatch(UUID_V4);
        expect(naiPreset.name).toBe("NAI file");
        expect(naiPreset.maxResponse).toBe(150);
        expect(naiPreset.NAISettings.cfg_scale).toBe(1.2);
        expect(stPreset.id).toMatch(UUID_V4);
        expect(stPreset.name).toBe("Imported ST Preset");
        expect(stPreset.temperature).toBe(50);
        expect(stPreset.promptTemplate).toEqual([{ type: "plain", type2: "main", text: "hello", role: "system" }]);
        expect(new Set(DBState.db.botPresets.map((preset) => preset.id)).size).toBe(3);
    });
});

describe(".risup round trip against the step-0 fixtures", () => {
    beforeEach(() => {
        DBState.db = {} as Database;
        // The selection store is module state: an empty id makes `setDatabase` select the first preset.
        selectPreset("");
    });

    for (const name of ["default.risup", "custom.risup"]) {
        it(`${name}: the import gets a fresh id, and the export decodes to the fixture preset without an id`, async () => {
            bootWith();
            const fixture = await decodeRisup(readFixture(name));
            expect(Object.hasOwn(fixture, "id")).toBe(false);

            await importPreset({ name, data: readFixture(name) });
            expect(DBState.db.botPresets).toHaveLength(2);
            const imported = DBState.db.botPresets[1];
            expect(imported.id).toMatch(UUID_V4);
            expect(imported.name).toBe(fixture.name);

            const exported = await downloadPreset(imported.id, "return");
            expect(exported.buf).toBeInstanceOf(Uint8Array);
            expect(ownKeys(exported.data)).not.toContain("id");
            expect((exported.data as botPreset).openAIKey).toBe("");

            const decoded = await decodeRisup(exported.buf as Uint8Array);
            expect(ownKeys(decoded)).not.toContain("id");
            expect(decoded).toEqual(fixture);
            // The import itself, apart from the id, is the fixture preset too: the normalizer changed
            // nothing the pre-phase reader wrote (no default was added, no explicit value replaced),
            // except that the record carries no credential (`openAIKey`, and `proxyKey` since slice 7)
            // and no `forceReplaceUrl2`; `downloadPreset` writes the blank credentials back into the export.
            const { id, ...importedWithoutId } = imported as botPreset & Record<string, unknown>;
            expect(id).toMatch(UUID_V4);
            expect(Object.hasOwn(importedWithoutId, "proxyKey")).toBe(false);
            expect(importedWithoutId).toEqual({
                ...fixture,
                openAIKey: undefined,
                proxyKey: undefined,
                forceReplaceUrl2: undefined,
            });
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
        DBState.db = {} as Database;
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

            await importPreset({ name, data: readFixture(name) });
            const first = await downloadPreset(DBState.db.botPresets[1].id, "return");
            const decodedFirst = await decodeRisup(first.buf as Uint8Array);
            // `toStrictEqual` distinguishes a missing key from an `undefined` one (`toEqual` does not).
            expect(ownKeys(decodedFirst)).toEqual(ownKeys(fixture));
            expect(decodedFirst).toStrictEqual(fixture);
            for (const key of unsetInFixture) {
                expect(Object.hasOwn(decodedFirst, key), key).toBe(true);
                expect(decodedFirst[key], key).toBeUndefined();
            }
            expect((first.data as botPreset).proxyKey).toBe("");
            expect((first.data as botPreset).openAIKey).toBe("");

            // A second import/export cycle of the new export is a fixed point.
            await importPreset({ name, data: first.buf as Uint8Array });
            expect(DBState.db.botPresets).toHaveLength(3);
            const second = await downloadPreset(DBState.db.botPresets[2].id, "return");
            expect(await decodeRisup(second.buf as Uint8Array)).toStrictEqual(fixture);

            // The pre-phase reader stores the same preset from the new export as from the fixture: in
            // particular `promptPreprocess` stays `undefined` (its working value kept), not the
            // template's `false` an absent key would have given it.
            const fromExport = legacyImportPreset(decodedFirst);
            expect(fromExport).toStrictEqual(legacyImportPreset(fixture));
            expect(presetTemplate.promptPreprocess).toBe(false);
            expect(Object.hasOwn(fromExport, "promptPreprocess")).toBe(true);
            expect(fromExport.promptPreprocess).toBeUndefined();
        });
    }

    it("the JSON export drops the unset fields, as the pre-phase JSON export did (JSON has no undefined)", async () => {
        bootWith();
        await importPreset({ name: "default.risup", data: readFixture("default.risup") });
        const exported = await downloadPreset(DBState.db.botPresets[1].id, "json");
        // The `.json` path hands the same object to the file writer; its JSON text has no unset key.
        const text = JSON.stringify(exported.data);
        expect(Object.hasOwn(exported.data, "promptPreprocess")).toBe(true);
        expect(JSON.parse(text)).not.toHaveProperty("promptPreprocess");
        expect(JSON.parse(text)).not.toHaveProperty("id");
    });
});
