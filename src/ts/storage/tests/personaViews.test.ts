// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 6 (`docs/plan/phases/slices/phase-3-settings-sections/forwarding-personas.md`):
// the persona half of the selected-record rules, over the settings record views
// (`settingsViews.svelte.ts`, `activePersona`) since Phase 6 slice 10 moved them there from the
// removed forwarding layer (`forwarding.svelte.ts`, the accessors on the whole-database aggregate),
// and the persona functions of `persona.ts` that changed with it. The cases pin: the four persona
// fields and `selectedPersonaIndex` (reads and writes by the selected id, tracked reads and
// untracked writes), the resolution after the collection is replaced or the selected persona
// removed (a read repairs the selection, a write is dropped and never redirected), the non-string
// read rule, the legacy flat snapshot (`rootSnapshot`), `changeUserPersona`, `selectUserImg`
// keeping the id across its `await` (the exit criterion: a bound chat keeps its binding after an
// icon change) and dropping the icon when the persona was deleted meanwhile, and `importUserPersona`
// reaching the live list when the collection was replaced while its image was being saved (Astra
// challenge point 3). The cases about the accessors themselves (their descriptors, `setDatabaseLite`,
// the index setter's input checks) and about the removed boot backstop (`setDatabase`'s personas
// contract; the server normalizes) were retired with the aggregate.

await vi.hoisted(async () => {
    const { Buffer: BufferPolyfill } = await import("buffer");
    (globalThis as any).Buffer = BufferPolyfill;
});

const held = vi.hoisted(() => ({
    file: null as null | ((value: { name: string; data: Uint8Array } | null) => void),
    asset: null as null | ((path: string) => void),
    chunks: [] as { key: string; value: string }[],
}));

vi.mock("../../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(() => new Promise<string>((resolve) => (held.asset = resolve))),
    AppendableBuffer: class {},
}));
vi.mock("../../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../process/files/inlays", () => ({ reencodeImage: vi.fn(async (data: Uint8Array) => data) }));
vi.mock("../../pngChunk", () => ({
    PngChunk: {
        readGenerator: async function* () {
            yield* held.chunks;
        },
    },
}));
vi.mock("../../util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../util")>()),
    selectSingleFile: vi.fn(
        () => new Promise<{ name: string; data: Uint8Array } | null>((resolve) => (held.file = resolve)),
    ),
}));

import { initializeRecords, resetRecords, takeRecordFields } from "../records.svelte";
import { selection, selectPersona, selectPreset } from "../selection.svelte";
import {
    activePersona,
    currentPersonaRecord,
    personaRecordForWrite,
    readSettingsRoot,
    reconcileSelection,
    selectedPersonaIndex,
    settings,
    writeSettingsRoot,
} from "../settingsViews.svelte";
import { rootSnapshot } from "../snapshots.svelte";
import { changeUserPersona, importUserPersona, selectUserImg } from "../../persona";
import { alertNormal } from "../../alert";
import { saveAsset } from "../../globalApi.svelte";
import { PERSONA_DEFAULTS } from "../../../../shared/personas.ts";
import { PERSONA_ROOT_ALIASES, plainClone } from "../../../../shared/presets.ts";
import { createProbe, createWriterEffect } from "./reactiveProbe.svelte";

type AnyDb = Record<string, any>;

const persona$ = activePersona as unknown as AnyDb;
/** The views under a loose type, for the fixture-shaped writes below. */
const settings$ = settings as unknown as AnyDb;
const personas = () => settings.personas as unknown as AnyDb[];
const persona = (id: string) => personas().find((entry: { id: string }) => entry.id === id);
const text = (value: unknown) => JSON.stringify(plainClone(value));
const ids = () => personas().map((entry: { id: string }) => entry.id);

const u1 = () => ({ id: "u1", name: "One", icon: "icon-1", personaPrompt: "prompt one", note: "note one" });
const u2 = () => ({
    id: "u2",
    name: "Two",
    icon: "",
    personaPrompt: "prompt two",
    note: "note two",
    largePortrait: true,
});

/**
 * Installs the records from a legacy-shaped save with the given personas (and extra fields), as
 * boot installs them, and resolves the selection. The fixture is valid data: the removed boot
 * backstop normalized it before; the server does now.
 */
function boot(list: unknown = [u1(), u2()], extra: Record<string, unknown> = {}) {
    initializeRecords(takeRecordFields({ characters: [], botPresets: [], personas: list, ...extra }));
    reconcileSelection();
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectPersona("");
    held.file = null;
    held.asset = null;
    held.chunks = [];
    vi.mocked(saveAsset).mockClear();
    vi.mocked(alertNormal).mockClear();
});

afterEach(() => {
    resetRecords();
});

describe("installation", () => {
    it("a root snapshot carries the selected persona's values under the four root names and the selection index, as plain data", () => {
        boot();
        expect(PERSONA_ROOT_ALIASES).toEqual({
            username: "name",
            userIcon: "icon",
            userNote: "note",
            personaPrompt: "personaPrompt",
        });
        expect(selection.personaId).toBe("u1");
        const snapshot = rootSnapshot();
        expect(snapshot).toMatchObject({
            username: "One",
            userIcon: "icon-1",
            userNote: "note one",
            personaPrompt: "prompt one",
            selectedPersona: 0,
        });
        expect(Object.getOwnPropertyDescriptor(snapshot, "username")).toHaveProperty("value", "One");
    });

    it("selects the first persona for an empty or unknown stored selection, and keeps a stored one that exists", () => {
        selectPersona("gone");
        boot();
        expect(selection.personaId).toBe("u1");
        // A write right after boot, before any read, has a record to go to.
        persona$.note = "written first";
        expect(persona("u1").note).toBe("written first");

        selectPersona("u2");
        boot();
        expect(selection.personaId).toBe("u2");
        expect(persona$.name).toBe("Two");
        expect(selectedPersonaIndex()).toBe(1);
    });
});

describe("reads and writes by the selected id", () => {
    it("reads and writes the selected persona through the aliases, leaving the other persona alone", () => {
        boot();
        expect(persona$.name).toBe("One");
        expect(readSettingsRoot("username")).toBe("One");
        expect(persona$.icon).toBe("icon-1");
        expect(readSettingsRoot("userIcon")).toBe("icon-1");
        expect(persona$.note).toBe("note one");
        expect(readSettingsRoot("userNote")).toBe("note one");
        expect(persona$.personaPrompt).toBe("prompt one");
        expect(readSettingsRoot("personaPrompt")).toBe("prompt one");

        persona$.name = "Renamed";
        writeSettingsRoot("userIcon", "icon-new");
        writeSettingsRoot("userNote", "n");
        persona$.personaPrompt = "p";
        expect(persona("u1")).toEqual({ id: "u1", name: "Renamed", icon: "icon-new", personaPrompt: "p", note: "n" });
        expect(persona("u2")).toEqual(u2());
        // The record is the source: an edit there is what the view reads.
        persona("u1").name = "Edited in the record";
        expect(persona$.name).toBe("Edited in the record");

        changeUserPersona("u2");
        expect(selection.personaId).toBe("u2");
        expect(persona$.name).toBe("Two");
        expect(persona$.personaPrompt).toBe("prompt two");
        expect(selectedPersonaIndex()).toBe(1);
        expect(currentPersonaRecord()?.id).toBe("u2");
        // An unknown id changes nothing.
        changeUserPersona("nope");
        expect(selection.personaId).toBe("u2");
    });

    it("tracks reads (a derived and an effect follow a record edit and a switch) and resolves writes untracked", () => {
        boot();
        const probe = createProbe(() => persona$.personaPrompt);
        expect(probe.seen).toEqual(["prompt one"]);
        expect(probe.derived()).toBe("prompt one");

        persona("u1").personaPrompt = "edited";
        flushSync();
        expect(probe.seen).toEqual(["prompt one", "edited"]);

        changeUserPersona("u2");
        flushSync();
        expect(probe.seen).toEqual(["prompt one", "edited", "prompt two"]);
        expect(probe.derived()).toBe("prompt two");

        // An effect that assigns a persona field must not rerun into the next persona on a switch.
        const writer = createWriterEffect(() => {
            persona$.note = "from effect";
        });
        expect(writer.runs()).toBe(1);
        expect(persona("u2").note).toBe("from effect");
        changeUserPersona("u1");
        flushSync();
        expect(writer.runs()).toBe(1);
        expect(persona("u1").note).toBe("note one");

        writer.dispose();
        probe.dispose();
    });

    it("reads a non-string field as its default and never writes the record on a read", () => {
        boot();
        const record = persona("u1");
        // Bypass the normalizer, as a record between a plugin's lite write and its normalization looks.
        record.note = 7;
        delete record.icon;
        record.personaPrompt = null;
        const before = text(record);
        expect(persona$.note).toBe(PERSONA_DEFAULTS.note);
        expect(persona$.icon).toBe(PERSONA_DEFAULTS.icon);
        expect(persona$.personaPrompt).toBe(PERSONA_DEFAULTS.personaPrompt);
        rootSnapshot();
        JSON.stringify(settings.personas);
        expect(text(record)).toBe(before);
        persona$.icon = "set";
        expect(record.icon).toBe("set");
    });
});

describe("reconcileSelection after a replacement or a removal", () => {
    it("resolves anew after the collection is replaced, as a conflict reload or a plugin setter does", () => {
        boot();
        changeUserPersona("u2");
        const replacement = plainClone(personas());
        replacement[1].personaPrompt = "replaced";
        settings$.personas = replacement;
        reconcileSelection();
        expect(selection.personaId).toBe("u2");
        expect(persona$.personaPrompt).toBe("replaced");
        persona$.personaPrompt = "after";
        expect(personas()[1].personaPrompt).toBe("after");

        // A replacement without the selected id: the selection moves to the first record.
        settings.personas = [{ id: "u3", name: "Three", icon: "", personaPrompt: "", note: "" }];
        reconcileSelection();
        expect(selection.personaId).toBe("u3");
        expect(persona$.name).toBe("Three");
        expect(selectedPersonaIndex()).toBe(0);
    });

    it("falls back to the first record on a read when the selected persona is removed, and makes it the selection (also inside a derived)", () => {
        boot();
        changeUserPersona("u2");
        const probe = createProbe(() => persona$.name);
        expect(probe.seen).toEqual(["Two"]);

        personas().splice(1, 1);
        flushSync();
        // The read that repairs the selection writes a dependency of its own effect, which Svelte
        // may run once more (self-invalidation, bounded); every run after the removal sees the
        // fallback, and the state is settled.
        expect(probe.seen.slice(0, 2)).toEqual(["Two", "One"]);
        expect(probe.seen.length).toBeLessThanOrEqual(3);
        expect(new Set(probe.seen.slice(1))).toEqual(new Set(["One"]));
        expect(() => probe.derived()).not.toThrow();
        expect(probe.derived()).toBe("One");
        expect(selection.personaId).toBe("u1");
        expect(selectedPersonaIndex()).toBe(0);
        probe.dispose();
    });

    it("drops a write while the selection names no record, never redirecting it; the next read repairs the selection", () => {
        boot();
        const before = [text(persona("u1")), text(persona("u2"))];
        selectPersona("missing");
        expect(personaRecordForWrite()).toBeUndefined();

        persona$.name = "lost";
        persona$.personaPrompt = "lost";
        writeSettingsRoot("userIcon", "lost");
        writeSettingsRoot("userNote", "lost");
        expect([text(persona("u1")), text(persona("u2"))]).toEqual(before);
        expect(selection.personaId).toBe("missing");

        expect(persona$.name).toBe("One");
        expect(selection.personaId).toBe("u1");
        persona$.name = "found";
        expect(persona("u1").name).toBe("found");
    });

    it("selectedPersonaIndex is the selected persona's index; selecting an id moves it; an unknown id leaves the index on the fallback; a reorder keeps the persona", () => {
        boot();
        expect(selectedPersonaIndex()).toBe(0);
        selectPersona("u2");
        expect(selection.personaId).toBe("u2");
        expect(selectedPersonaIndex()).toBe(1);
        expect(persona$.name).toBe("Two");
        // An unknown id names no record: the index read resolves the fallback (the first persona).
        selectPersona("nope");
        expect(selectedPersonaIndex()).toBe(0);
        expect(selection.personaId).toBe("u1");
        selectPersona("u2");
        // The selection travels with the persona, not the slot (the settings page reorders the list).
        settings$.personas = [plainClone(persona("u2")), plainClone(persona("u1"))];
        expect(selectedPersonaIndex()).toBe(0);
        expect(selection.personaId).toBe("u2");
        expect(persona$.name).toBe("Two");
    });
});

describe("selectUserImg", () => {
    it("writes the icon into the persona that was selected when the dialog opened, keeping its id, even after a switch", async () => {
        boot();
        changeUserPersona("u2");
        const done = selectUserImg();
        await Promise.resolve();
        expect(held.file).not.toBeNull();

        // The user switches personas while the file chooser is open, then picks a file.
        changeUserPersona("u1");
        held.file!({ name: "icon.png", data: new Uint8Array([1, 2, 3]) });
        await vi.waitFor(() => expect(held.asset).not.toBeNull());
        held.asset!("assets/icon.png");
        await done;

        expect(vi.mocked(saveAsset)).toHaveBeenCalledTimes(1);
        expect(persona("u2")).toMatchObject({ id: "u2", icon: "assets/icon.png", name: "Two" });
        expect(persona("u1").icon).toBe("icon-1");
        expect(ids()).toEqual(["u1", "u2"]);
        expect(selection.personaId).toBe("u1");
        expect(persona$.icon).toBe("icon-1");
    });

    it("drops the icon when that persona was deleted meanwhile, never redirecting it; a cancelled dialog changes nothing", async () => {
        boot();
        changeUserPersona("u2");
        const done = selectUserImg();
        await Promise.resolve();
        personas().splice(1, 1);
        held.file!({ name: "icon.png", data: new Uint8Array([1]) });
        await vi.waitFor(() => expect(held.asset).not.toBeNull());
        held.asset!("assets/orphan.png");
        await done;
        expect(plainClone(personas())).toEqual([u1()]);
        // Nothing read a persona view: the selection still names the deleted persona (a write
        // there is dropped) until the next read repairs it.
        expect(selection.personaId).toBe("u2");
        expect(personaRecordForWrite()).toBeUndefined();
        expect(persona$.name).toBe("One");
        expect(selection.personaId).toBe("u1");

        const cancelled = selectUserImg();
        await Promise.resolve();
        held.file!(null);
        await cancelled;
        expect(vi.mocked(saveAsset)).toHaveBeenCalledTimes(1);
        expect(plainClone(personas())).toEqual([u1()]);
    });
});

describe("importUserPersona", () => {
    const card = (data: Record<string, unknown>) => Buffer.from(JSON.stringify(data)).toString("base64");

    it("pushes the imported persona into the live list even when the collection was replaced while its image was being saved", async () => {
        boot();
        held.chunks = [{ key: "persona", value: card({ name: "Imported", personaPrompt: "ip", note: 3 }) }];
        const done = importUserPersona();
        await Promise.resolve();
        held.file!({ name: "card.png", data: new Uint8Array([9]) });
        await vi.waitFor(() => expect(held.asset).not.toBeNull());

        // The list is replaced while the image is being saved, as a conflict reload or a full
        // plugin `setDatabase` (which normalizes `personas`) does.
        const detached = personas();
        settings$.personas = plainClone(personas());
        held.asset!("assets/imported.png");
        await done;

        expect(vi.mocked(alertNormal)).toHaveBeenCalledTimes(1);
        expect(personas()).toHaveLength(3);
        expect(plainClone(personas()[2])).toEqual({
            name: "Imported",
            icon: "assets/imported.png",
            personaPrompt: "ip",
            note: "",
            id: expect.any(String),
        });
        expect(personas()[2].id.length).toBeGreaterThan(0);
        // A retained wrapper follows its record across replacements (Phase 6 slice 4,
        // `settings-ownership.md`, "Observable changes"): the list held before the replacement shows
        // the live list.
        expect(detached).toHaveLength(3);
        expect(selection.personaId).toBe("u1");
    });
});
