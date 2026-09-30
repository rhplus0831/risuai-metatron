// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 5 (`docs/plan/phases/slices/phase-3-settings-sections/forwarding-presets-and-selection.md`):
// the production forwarding layer (`forwarding.svelte.ts`) installed by `setDatabase` on the real
// database, over the real Svelte proxy. The spike (`forwardingSpike.test.ts`) proved the mechanism
// on a test-only harness; these cases pin the shipped layer: the install and its idempotence through
// the live proxy, the reads and writes by the selected id (with the three root aliases), tracked
// reads and untracked writes, the resolution after a collection replacement, the fallback after a
// removal (a read repairs the selection, a write is dropped and never redirected), the missing and
// `null` value rules (a read never writes), the `proxyKey` and selection-index accessors, and the
// preset functions of `database.svelte.ts` that changed with it (`changeToPreset` with the three
// keep-on-switch toggles, `applyPresetTemplate`, `copyPreset`, `importPreset`).

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

import { DBState } from "../../stores.svelte";
import {
    applyPresetTemplate,
    changeToPreset,
    copyPreset,
    getDatabase,
    importPreset,
    setDatabase,
    setDatabaseLite,
    type Database,
} from "../database.svelte";
import { installForwarding, selectedPreset, selectedPresetForWrite } from "../forwarding.svelte";
import { getPresetSecret, llmSecretPresets, replacePresetSecrets, setPresetSecret } from "../llmSecrets.svelte";
import { selection, selectPreset } from "../selection.svelte";
import { PRESET_DEFAULTS, PRESET_ROOT_ALIASES, defaultOoba, plainClone } from "../../../../shared/presets.ts";
import { FORWARDED_ROOT_KEYS } from "../../../../shared/sections.ts";
import { createProbe, createWriterEffect } from "./reactiveProbe.svelte";

type AnyDb = Record<string, any>;

const db = () => DBState.db as unknown as AnyDb;
const preset = (id: string) => db().botPresets.find((entry: { id: string }) => entry.id === id);
const text = (value: unknown) => JSON.stringify(plainClone(value));

function presetA() {
    return {
        id: "a",
        name: "A",
        temperature: 80,
        maxContext: 4000,
        maxResponse: 500,
        NAISettings: { starter: "starter-a" },
        reasonEffort: 1,
        regex: [{ comment: "ra", type: "editinput", in: "x", out: "y", flag: "" }],
        seperateModels: { memory: "am", emotion: "ae", translate: "at", otherAx: "ao" },
        seperateModelsForAxModels: true,
        fallbackModels: { memory: ["afm"], emotion: [], translate: [], otherAx: [], model: [] },
        fallbackWhenBlankResponse: true,
        seperateParameters: { memory: { temperature: 1 }, emotion: {}, translate: {}, otherAx: {}, overrides: {} },
    };
}

function presetB() {
    return {
        id: "b",
        name: "B",
        temperature: 50,
        maxContext: 5000,
        maxResponse: 555,
        NAISettings: { starter: "starter-b" },
        reasonEffort: 2,
        regex: [],
        seperateModels: { memory: "bm", emotion: "be", translate: "bt", otherAx: "bo" },
        seperateModelsForAxModels: false,
        fallbackModels: { memory: [], emotion: ["bfe"], translate: [], otherAx: [], model: [] },
        fallbackWhenBlankResponse: false,
        seperateParameters: { memory: {}, emotion: { temperature: 2 }, translate: {}, otherAx: {}, overrides: {} },
    };
}

/** Boots the real `setDatabase` over a legacy-shaped save with the given presets and root fields. */
function boot(extra: Record<string, unknown> = {}) {
    DBState.db = {} as Database;
    setDatabase({ characters: [], botPresets: [presetA(), presetB()], ...extra } as unknown as Database);
    return db();
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    replacePresetSecrets({});
});

afterEach(() => {
    DBState.db = {} as Database;
});

describe("install", () => {
    it("defines an enumerable accessor for every FORWARDED_ROOT_KEYS entry, idempotently through the live proxy", () => {
        boot();
        const getters = new Map<string, unknown>();
        for (const key of FORWARDED_ROOT_KEYS) {
            const descriptor = Object.getOwnPropertyDescriptor(DBState.db, key);
            expect(typeof descriptor?.get, key).toBe("function");
            expect(typeof descriptor?.set, key).toBe("function");
            expect(descriptor?.enumerable, key).toBe(true);
            getters.set(key, descriptor?.get);
        }
        expect(Object.keys(DBState.db)).toEqual(expect.arrayContaining([...FORWARDED_ROOT_KEYS]));

        // The plugin setters and `checkNewFormat` pass the live proxy back into `setDatabase`; the
        // descriptor check must see the target's getters and skip (a defineProperty through the
        // proxy would throw), and `installForwarding` on the proxy is a no-op too.
        expect(() => setDatabase(DBState.db)).not.toThrow();
        expect(() => installForwarding(DBState.db)).not.toThrow();
        for (const key of FORWARDED_ROOT_KEYS) {
            expect(Object.getOwnPropertyDescriptor(DBState.db, key)?.get, key).toBe(getters.get(key));
        }
        expect(db().temperature).toBe(80);
    });

    it("a snapshot of the database carries the selected preset's values and the selection index", () => {
        boot();
        const snapshot = getDatabase({ snapshot: true }) as unknown as AnyDb;
        expect(snapshot.temperature).toBe(80);
        expect(snapshot.NAIsettings).toMatchObject({ starter: "starter-a", cfg_scale: 1 });
        expect(snapshot.reasoningEffort).toBe(1);
        expect(snapshot.botPresetsId).toBe(0);
        expect(snapshot.proxyKey).toBe("");
        expect(snapshot.loreBookPage).toBe(0);
        // The snapshot is plain data: the accessors did not travel.
        expect(Object.getOwnPropertyDescriptor(snapshot, "temperature")).toHaveProperty("value", 80);
    });

    it("selects the first preset for an empty or unknown stored selection when it installs a database", () => {
        selectPreset("gone");
        boot();
        expect(selection.presetId).toBe("a");
        // A write right after boot, before any read, has a record to go to.
        db().temperature = 12;
        expect(preset("a").temperature).toBe(12);
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
        expect(db().temperature).toBe(80);
        expect(db().NAIsettings.starter).toBe("starter-a");
        expect(db().reasoningEffort).toBe(1);
        expect(db().presetRegex).toEqual(presetA().regex);

        db().temperature = 70;
        db().reasoningEffort = 3;
        db().presetRegex = [];
        // A nested write goes through the getter to the record's own object.
        db().NAIsettings.starter = "typed";
        db().promptSettings.sendName = true;

        expect(preset("a")).toMatchObject({ temperature: 70, reasonEffort: 3, regex: [] });
        expect(preset("a").NAISettings.starter).toBe("typed");
        expect(preset("a").promptSettings.sendName).toBe(true);
        expect(preset("b")).toMatchObject({ temperature: 50, reasonEffort: 2, regex: [] });
        expect(preset("b").NAISettings.starter).toBe("starter-b");
        expect(preset("b").promptSettings.sendName).toBe(false);
        // The root never holds a value: the accessor is still there.
        expect(typeof Object.getOwnPropertyDescriptor(DBState.db, "temperature")?.get).toBe("function");

        changeToPreset("b", false);
        expect(db().temperature).toBe(50);
        expect(db().NAIsettings.starter).toBe("starter-b");
        expect(db().botPresetsId).toBe(1);
        expect(selectedPreset(DBState.db)?.id).toBe("b");
    });

    it("tracks reads (a derived and an effect follow a record edit and a switch) and resolves writes untracked", () => {
        boot();
        const probe = createProbe(() => db().temperature);
        expect(probe.seen).toEqual([80]);
        expect(probe.derived()).toBe(80);

        preset("a").temperature = 81;
        flushSync();
        expect(probe.seen).toEqual([80, 81]);

        changeToPreset("b", false);
        flushSync();
        expect(probe.seen).toEqual([80, 81, 50]);
        expect(probe.derived()).toBe(50);

        // An effect that assigns a forwarded field must not rerun into the next preset on a switch:
        // the setter resolves the record, the secret map, and the selection untracked.
        const writer = createWriterEffect(() => {
            db().maxContext = 9100;
        });
        expect(writer.runs()).toBe(1);
        expect(preset("b").maxContext).toBe(9100);
        changeToPreset("a", false);
        flushSync();
        expect(writer.runs()).toBe(1);
        expect(preset("a").maxContext).toBe(4000);

        writer.dispose();
        probe.dispose();
    });

    it("resolves anew after the collection is replaced, as a conflict reload or a plugin setter does", () => {
        boot();
        const replacement = plainClone(db().botPresets);
        replacement[0].temperature = 11;
        db().botPresets = replacement;
        expect(db().temperature).toBe(11);
        db().temperature = 13;
        expect(db().botPresets[0].temperature).toBe(13);
        expect(selection.presetId).toBe("a");
    });

    it("falls back to the first record on a read when the selected id is gone, and makes it the selection (also inside a derived)", () => {
        boot();
        changeToPreset("b", false);
        const probe = createProbe(() => db().temperature);
        expect(probe.seen).toEqual([50]);

        db().botPresets.splice(1, 1);
        flushSync();
        expect(probe.seen).toEqual([50, 80]);
        expect(() => probe.derived()).not.toThrow();
        expect(probe.derived()).toBe(80);
        expect(selection.presetId).toBe("a");
        expect(db().botPresetsId).toBe(0);
        probe.dispose();
    });

    it("drops a write while the selection names no record, never redirecting it; the next read repairs the selection", () => {
        boot();
        const before = [text(preset("a")), text(preset("b"))];
        selectPreset("missing");
        expect(selectedPresetForWrite(DBState.db)).toBeUndefined();

        db().temperature = 1;
        db().NAIsettings = { starter: "lost" };
        db().proxyKey = "pk-lost";
        expect([text(preset("a")), text(preset("b"))]).toEqual(before);
        expect(llmSecretPresets.value).toEqual({});
        expect(selection.presetId).toBe("missing");

        expect(db().temperature).toBe(80);
        expect(selection.presetId).toBe("a");
        db().temperature = 2;
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
        record.maxContext = null;
        record.promptTemplate = null;
        record.min_p = null;
        const before = text(record);

        expect(db().maxResponse).toBe(PRESET_DEFAULTS.maxResponse);
        expect(db().ooba).toEqual(defaultOoba);
        expect(db().ooba).not.toBe(db().ooba);
        expect(db().maxContext).toBeNull();
        expect(db().promptTemplate).toBeNull();
        expect(db().min_p).toBeNull();

        // Neither the reads nor a snapshot of the whole database materialized anything in the record.
        getDatabase({ snapshot: true });
        JSON.stringify(DBState.db);
        expect(text(record)).toBe(before);
        expect(record.ooba).toBeNull();
        expect(Object.hasOwn(record, "maxResponse")).toBe(false);

        // An edit does land: the setter writes the record.
        db().ooba = { ...defaultOoba, formating: { ...defaultOoba.formating, header: "h" } };
        expect(record.ooba.formating.header).toBe("h");
        db().maxContext = 4001;
        expect(record.maxContext).toBe(4001);
    });
});

describe("proxyKey", () => {
    it("reads and writes the selected preset's llmSecrets entry; an empty write deletes it; the record's field stays empty", () => {
        boot();
        expect(db().proxyKey).toBe("");
        db().proxyKey = "pk-a";
        expect(getPresetSecret("a")).toEqual({ proxyKey: "pk-a" });
        expect(preset("a").proxyKey).toBe("");
        expect(db().proxyKey).toBe("pk-a");

        changeToPreset("b", false);
        expect(db().proxyKey).toBe("");
        db().proxyKey = "pk-b";
        expect(getPresetSecret("b")).toEqual({ proxyKey: "pk-b" });
        db().proxyKey = "";
        expect(getPresetSecret("b")).toBeUndefined();
        expect(getPresetSecret("a")).toEqual({ proxyKey: "pk-a" });

        // A tracked read: the accessor follows the map.
        const probe = createProbe(() => db().proxyKey);
        expect(probe.seen).toEqual([""]);
        setPresetSecret("b", { proxyKey: "pk-b2" });
        flushSync();
        expect(probe.seen).toEqual(["", "pk-b2"]);
        probe.dispose();
    });

    it("copyPreset copies the entry and importPreset moves a file's proxyKey into the map", async () => {
        boot();
        db().proxyKey = "pk-a";
        copyPreset("a");
        const copy = db().botPresets[2];
        expect(copy.name).toBe("A Copy");
        expect(copy.id).not.toBe("a");
        expect(copy.proxyKey).toBe("");
        expect(getPresetSecret(copy.id)).toEqual({ proxyKey: "pk-a" });

        await importPreset({
            name: "hand.json",
            data: new TextEncoder().encode(JSON.stringify({ name: "Hand", proxyKey: "pk-hand", temperature: 33 })),
        });
        const imported = db().botPresets[3];
        expect(imported).toMatchObject({ name: "Hand", proxyKey: "", temperature: 33 });
        expect(getPresetSecret(imported.id)).toEqual({ proxyKey: "pk-hand" });
        expect(Object.keys(llmSecretPresets.value).sort()).toEqual(["a", copy.id, imported.id].sort());
    });
});

describe("the selection indexes", () => {
    it("botPresetsId is the selected preset's index; assigning an index selects that preset; an out-of-range index is ignored", () => {
        boot();
        expect(db().botPresetsId).toBe(0);
        db().botPresetsId = 1;
        expect(selection.presetId).toBe("b");
        expect(db().botPresetsId).toBe(1);
        expect(db().temperature).toBe(50);
        db().botPresetsId = 5;
        expect(selection.presetId).toBe("b");
        db().botPresetsId = "0";
        expect(selection.presetId).toBe("b");
        // A reorder keeps the selection on the same preset (the index follows).
        db().botPresets = [plainClone(preset("b")), plainClone(preset("a"))];
        expect(db().botPresetsId).toBe(0);
        expect(selection.presetId).toBe("b");
    });

    it("loreBookPage reads 0 when out of range and resets the stored page; the setter takes a non-negative integer", () => {
        boot({
            loreBook: [
                { name: "one", data: [] },
                { name: "two", data: [] },
            ],
        });
        db().loreBookPage = 1;
        expect(selection.loreBookPage).toBe(1);
        expect(db().loreBookPage).toBe(1);
        db().loreBookPage = -1;
        db().loreBookPage = 1.5;
        db().loreBookPage = "0";
        expect(db().loreBookPage).toBe(1);

        db().loreBook.splice(1, 1);
        expect(db().loreBookPage).toBe(0);
        expect(selection.loreBookPage).toBe(0);
    });
});

describe("changeToPreset and applyPresetTemplate", () => {
    it("saves the five keep-on-switch fields into the old preset and copies the new preset's into providers, honoring the three toggles", () => {
        boot({
            seperateModels: { memory: "pm", emotion: "pe", translate: "pt", otherAx: "po" },
            seperateModelsForAxModels: false,
            fallbackModels: { memory: ["pfm"], emotion: [], translate: [], otherAx: [], model: [] },
            fallbackWhenBlankResponse: false,
            seperateParameters: { memory: {}, emotion: {}, translate: {}, otherAx: {}, overrides: { p: 1 } },
            doNotChangeSeperateModels: false,
            doNotChangeFallbackModels: false,
            disableSeperateParameterChangeOnPresetChange: false,
        });

        changeToPreset("b");
        expect(preset("a")).toMatchObject({
            seperateModels: { memory: "pm", emotion: "pe", translate: "pt", otherAx: "po" },
            seperateModelsForAxModels: false,
            fallbackModels: { memory: ["pfm"], emotion: [], translate: [], otherAx: [], model: [] },
            fallbackWhenBlankResponse: false,
            seperateParameters: { memory: {}, emotion: {}, translate: {}, otherAx: {}, overrides: { p: 1 } },
        });
        expect(db()).toMatchObject({
            seperateModels: presetB().seperateModels,
            seperateModelsForAxModels: false,
            fallbackModels: presetB().fallbackModels,
            fallbackWhenBlankResponse: false,
            seperateParameters: presetB().seperateParameters,
        });
        expect(selection.presetId).toBe("b");
        // The other fields were not copied anywhere: they are read from the record.
        expect(preset("a").temperature).toBe(80);
        expect(db().temperature).toBe(50);

        db().doNotChangeSeperateModels = true;
        db().doNotChangeFallbackModels = true;
        db().disableSeperateParameterChangeOnPresetChange = true;
        db().fallbackWhenBlankResponse = true;
        changeToPreset("a");
        // The old preset gets `seperateModels: null` on purpose while the toggle is on.
        expect(preset("b").seperateModels).toBeNull();
        expect(preset("b").seperateModelsForAxModels).toBe(false);
        expect(preset("b").fallbackWhenBlankResponse).toBe(true);
        // The providers keep their values: none of the three copies ran.
        expect(db().seperateModels).toEqual(presetB().seperateModels);
        expect(db().fallbackModels).toEqual(presetB().fallbackModels);
        expect(db().fallbackWhenBlankResponse).toBe(true);
        expect(db().seperateParameters).toEqual(presetB().seperateParameters);
        expect(selection.presetId).toBe("a");

        // An unknown id changes nothing, not even the old preset.
        const before = [text(preset("a")), text(preset("b"))];
        changeToPreset("nope");
        expect(selection.presetId).toBe("a");
        expect([text(preset("a")), text(preset("b"))]).toEqual(before);
    });

    it("applyPresetTemplate replaces the selected preset's settings, keeps its id, name, and image, and copies the keep-on-switch fields", () => {
        boot({ doNotChangeSeperateModels: false, doNotChangeFallbackModels: false });
        preset("a").image = "data:image/jpeg;base64,x";
        applyPresetTemplate({
            ...PRESET_DEFAULTS,
            name: "Template",
            image: "template-image",
            temperature: 33,
            mainPrompt: "template main",
            seperateModels: { memory: "tm", emotion: "te", translate: "tt", otherAx: "to" },
        } as any);
        const applied = db().botPresets[0];
        expect(applied.id).toBe("a");
        expect(applied.name).toBe("A");
        expect(applied.image).toBe("data:image/jpeg;base64,x");
        expect(applied.temperature).toBe(33);
        expect(applied.mainPrompt).toBe("template main");
        expect(db().temperature).toBe(33);
        expect(db().seperateModels).toEqual({ memory: "tm", emotion: "te", translate: "tt", otherAx: "to" });
        expect(preset("b").temperature).toBe(50);
    });
});

describe("setDatabaseLite", () => {
    it("installs the accessors on a raw object and resolves the selection against it", () => {
        boot();
        selectPreset("b");
        const raw = { characters: [], botPresets: [presetA()] } as unknown as Database;
        setDatabaseLite(raw);
        expect(typeof Object.getOwnPropertyDescriptor(DBState.db, "temperature")?.get).toBe("function");
        expect(selection.presetId).toBe("a");
        db().temperature = 5;
        expect(db().botPresets[0].temperature).toBe(5);
    });
});
