// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 6 (`docs/plan/phases/slices/phase-3-settings-sections/forwarding-personas.md`):
// the persona half of the forwarding layer (`forwarding.svelte.ts`) installed by `setDatabase` on
// the real database, over the real Svelte proxy, and the persona functions of `persona.ts` that
// changed with it. The cases pin: the four persona accessors and `selectedPersona` (reads and writes
// by the selected id, tracked reads and untracked writes), the resolution after the collection is
// replaced or the selected persona removed (a read repairs the selection, a write is dropped and
// never redirected), the non-string read rule, `setDatabase`'s persona contract, `changeUserPersona`,
// `selectUserImg` keeping the id across its `await` (the exit criterion: a bound chat keeps its
// binding after an icon change) and dropping the icon when the persona was deleted meanwhile, and
// `importUserPersona` reaching the live list when the collection was replaced while its image was
// being saved (Astra challenge point 3).

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
vi.mock("../../alert", () => ({
    alertNormal: vi.fn(),
    alertError: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
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

import { DBState } from "../../stores.svelte";
import { getDatabase, setDatabase, setDatabaseLite, type Database } from "../database.svelte";
import { reconcileSelection, selectedPersona, selectedPersonaForWrite } from "../forwarding.svelte";
import { selection, selectPersona, selectPreset } from "../selection.svelte";
import { changeUserPersona, importUserPersona, selectUserImg } from "../../persona";
import { alertNormal } from "../../alert";
import { saveAsset } from "../../globalApi.svelte";
import { PERSONA_DEFAULTS } from "../../../../shared/personas.ts";
import { PERSONA_ROOT_ALIASES, plainClone } from "../../../../shared/presets.ts";
import { PERSONA_ROOT_KEYS } from "../../../../shared/sections.ts";
import { createProbe, createWriterEffect } from "./reactiveProbe.svelte";

type AnyDb = Record<string, any>;

const db = () => DBState.db as unknown as AnyDb;
const persona = (id: string) => db().personas.find((entry: { id: string }) => entry.id === id);
const text = (value: unknown) => JSON.stringify(plainClone(value));
const ids = () => db().personas.map((entry: { id: string }) => entry.id);

const u1 = () => ({ id: "u1", name: "One", icon: "icon-1", personaPrompt: "prompt one", note: "note one" });
const u2 = () => ({
    id: "u2",
    name: "Two",
    icon: "",
    personaPrompt: "prompt two",
    note: "note two",
    largePortrait: true,
});

/** Boots the real `setDatabase` over a save with the given personas (and extra fields). */
function boot(personas: unknown = [u1(), u2()], extra: Record<string, unknown> = {}) {
    DBState.db = {} as Database;
    setDatabase({ characters: [], botPresets: [], personas, ...extra } as unknown as Database);
    return db();
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
    DBState.db = {} as Database;
});

describe("install and the contract at setDatabase", () => {
    it("defines the four persona accessors and selectedPersona; a snapshot carries the selected persona's values", () => {
        boot();
        expect(PERSONA_ROOT_ALIASES).toEqual({
            username: "name",
            userIcon: "icon",
            userNote: "note",
            personaPrompt: "personaPrompt",
        });
        for (const key of [...PERSONA_ROOT_KEYS, "selectedPersona"]) {
            const descriptor = Object.getOwnPropertyDescriptor(DBState.db, key);
            expect(typeof descriptor?.get, key).toBe("function");
            expect(typeof descriptor?.set, key).toBe("function");
            expect(descriptor?.enumerable, key).toBe(true);
        }
        expect(selection.personaId).toBe("u1");
        const snapshot = getDatabase({ snapshot: true }) as unknown as AnyDb;
        expect(snapshot).toMatchObject({
            username: "One",
            userIcon: "icon-1",
            userNote: "note one",
            personaPrompt: "prompt one",
            selectedPersona: 0,
        });
        expect(Object.getOwnPropertyDescriptor(snapshot, "username")).toHaveProperty("value", "One");
    });

    it("applies the personas contract: an empty or missing list becomes the default persona, fields are filled, duplicate ids repaired", () => {
        boot([]);
        expect(db().personas).toHaveLength(1);
        expect(db().personas[0]).toMatchObject({ name: "User", icon: "", personaPrompt: "", note: "" });
        expect(db().personas[0].id).toEqual(expect.any(String));
        expect(db().username).toBe("User");
        expect(selection.personaId).toBe(db().personas[0].id);

        DBState.db = {} as Database;
        setDatabase({ characters: [], botPresets: [] } as unknown as Database);
        expect(db().personas).toHaveLength(1);
        expect(db().username).toBe("User");

        boot([{ id: "dup", name: "first", extra: 1 }, { id: "dup", name: "second", note: 5 }, { id: "" }]);
        expect(db().personas.map((entry: AnyDb) => entry.name)).toEqual(["first", "second", "User"]);
        expect(db().personas[0]).toEqual({
            id: "dup",
            name: "first",
            extra: 1,
            icon: "",
            personaPrompt: "",
            note: "",
        });
        expect(db().personas[1].id).not.toBe("dup");
        expect(db().personas[1].note).toBe("");
        expect(new Set(ids()).size).toBe(3);
        // A stored selection that names the kept id resolves to it; the repaired one is a new persona.
        expect(selection.personaId).toBe("dup");
    });

    it("selects the first persona for an empty or unknown stored selection, and keeps a stored one that exists", () => {
        selectPersona("gone");
        boot();
        expect(selection.personaId).toBe("u1");
        // A write right after boot, before any read, has a record to go to.
        db().userNote = "written first";
        expect(persona("u1").note).toBe("written first");

        selectPersona("u2");
        boot();
        expect(selection.personaId).toBe("u2");
        expect(db().username).toBe("Two");
        expect(db().selectedPersona).toBe(1);
    });
});

describe("reads and writes by the selected id", () => {
    it("reads and writes the selected persona through the aliases, leaving the other persona alone", () => {
        boot();
        expect(db().username).toBe("One");
        expect(db().userIcon).toBe("icon-1");
        expect(db().userNote).toBe("note one");
        expect(db().personaPrompt).toBe("prompt one");

        db().username = "Renamed";
        db().userIcon = "icon-new";
        db().userNote = "n";
        db().personaPrompt = "p";
        expect(persona("u1")).toEqual({ id: "u1", name: "Renamed", icon: "icon-new", personaPrompt: "p", note: "n" });
        expect(persona("u2")).toEqual(u2());
        // The root never holds a value: the accessor is still there, and the record is the source.
        expect(typeof Object.getOwnPropertyDescriptor(DBState.db, "username")?.get).toBe("function");
        persona("u1").name = "Edited in the record";
        expect(db().username).toBe("Edited in the record");

        changeUserPersona("u2");
        expect(selection.personaId).toBe("u2");
        expect(db().username).toBe("Two");
        expect(db().personaPrompt).toBe("prompt two");
        expect(db().selectedPersona).toBe(1);
        expect(selectedPersona(DBState.db)?.id).toBe("u2");
        // An unknown id changes nothing.
        changeUserPersona("nope");
        expect(selection.personaId).toBe("u2");
    });

    it("tracks reads (a derived and an effect follow a record edit and a switch) and resolves writes untracked", () => {
        boot();
        const probe = createProbe(() => db().personaPrompt);
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
            db().userNote = "from effect";
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
        expect(db().userNote).toBe(PERSONA_DEFAULTS.note);
        expect(db().userIcon).toBe(PERSONA_DEFAULTS.icon);
        expect(db().personaPrompt).toBe(PERSONA_DEFAULTS.personaPrompt);
        getDatabase({ snapshot: true });
        JSON.stringify(DBState.db);
        expect(text(record)).toBe(before);
        db().userIcon = "set";
        expect(record.icon).toBe("set");
    });
});

describe("reconcileSelection after a replacement or a removal", () => {
    it("resolves anew after the collection is replaced, as a conflict reload or a plugin setter does", () => {
        boot();
        changeUserPersona("u2");
        const replacement = plainClone(db().personas);
        replacement[1].personaPrompt = "replaced";
        db().personas = replacement;
        reconcileSelection(DBState.db);
        expect(selection.personaId).toBe("u2");
        expect(db().personaPrompt).toBe("replaced");
        db().personaPrompt = "after";
        expect(db().personas[1].personaPrompt).toBe("after");

        // A replacement without the selected id: the selection moves to the first record.
        db().personas = [{ id: "u3", name: "Three", icon: "", personaPrompt: "", note: "" }];
        reconcileSelection(DBState.db);
        expect(selection.personaId).toBe("u3");
        expect(db().username).toBe("Three");
        expect(db().selectedPersona).toBe(0);
    });

    it("falls back to the first record on a read when the selected persona is removed, and makes it the selection (also inside a derived)", () => {
        boot();
        changeUserPersona("u2");
        const probe = createProbe(() => db().username);
        expect(probe.seen).toEqual(["Two"]);

        db().personas.splice(1, 1);
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
        expect(db().selectedPersona).toBe(0);
        probe.dispose();
    });

    it("drops a write while the selection names no record, never redirecting it; the next read repairs the selection", () => {
        boot();
        const before = [text(persona("u1")), text(persona("u2"))];
        selectPersona("missing");
        expect(selectedPersonaForWrite(DBState.db)).toBeUndefined();

        db().username = "lost";
        db().personaPrompt = "lost";
        db().userIcon = "lost";
        db().userNote = "lost";
        expect([text(persona("u1")), text(persona("u2"))]).toEqual(before);
        expect(selection.personaId).toBe("missing");

        expect(db().username).toBe("One");
        expect(selection.personaId).toBe("u1");
        db().username = "found";
        expect(persona("u1").name).toBe("found");
    });

    it("selectedPersona is the selected persona's index; assigning an index selects on this client; out of range or non-number is ignored; a reorder keeps the persona", () => {
        boot();
        expect(db().selectedPersona).toBe(0);
        db().selectedPersona = 1;
        expect(selection.personaId).toBe("u2");
        expect(db().selectedPersona).toBe(1);
        expect(db().username).toBe("Two");
        db().selectedPersona = 5;
        db().selectedPersona = -1;
        db().selectedPersona = "0";
        db().selectedPersona = undefined;
        expect(selection.personaId).toBe("u2");
        // The selection travels with the persona, not the slot (the settings page reorders the list).
        db().personas = [plainClone(persona("u2")), plainClone(persona("u1"))];
        expect(db().selectedPersona).toBe(0);
        expect(selection.personaId).toBe("u2");
        expect(db().username).toBe("Two");
    });

    it("setDatabaseLite installs the accessors on a raw object and resolves the persona selection against it", () => {
        boot();
        changeUserPersona("u2");
        const raw = { characters: [], botPresets: [], personas: [u1()] } as unknown as Database;
        setDatabaseLite(raw);
        expect(typeof Object.getOwnPropertyDescriptor(DBState.db, "username")?.get).toBe("function");
        expect(selection.personaId).toBe("u1");
        db().userNote = "lite";
        expect(db().personas[0].note).toBe("lite");
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
        expect(db().userIcon).toBe("icon-1");
    });

    it("drops the icon when that persona was deleted meanwhile, never redirecting it; a cancelled dialog changes nothing", async () => {
        boot();
        changeUserPersona("u2");
        const done = selectUserImg();
        await Promise.resolve();
        db().personas.splice(1, 1);
        held.file!({ name: "icon.png", data: new Uint8Array([1]) });
        await vi.waitFor(() => expect(held.asset).not.toBeNull());
        held.asset!("assets/orphan.png");
        await done;
        expect(db().personas).toEqual([u1()]);
        // Nothing read a persona accessor: the selection still names the deleted persona (a write
        // there is dropped) until the next read repairs it.
        expect(selection.personaId).toBe("u2");
        expect(selectedPersonaForWrite(DBState.db)).toBeUndefined();
        expect(db().username).toBe("One");
        expect(selection.personaId).toBe("u1");

        const cancelled = selectUserImg();
        await Promise.resolve();
        held.file!(null);
        await cancelled;
        expect(vi.mocked(saveAsset)).toHaveBeenCalledTimes(1);
        expect(db().personas).toEqual([u1()]);
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
        const detached = db().personas;
        db().personas = plainClone(db().personas);
        held.asset!("assets/imported.png");
        await done;

        expect(vi.mocked(alertNormal)).toHaveBeenCalledTimes(1);
        expect(db().personas).toHaveLength(3);
        expect(db().personas[2]).toEqual({
            name: "Imported",
            icon: "assets/imported.png",
            personaPrompt: "ip",
            note: "",
            id: expect.any(String),
        });
        expect(db().personas[2].id.length).toBeGreaterThan(0);
        expect(detached).toHaveLength(2);
        expect(selection.personaId).toBe("u1");
    });
});
