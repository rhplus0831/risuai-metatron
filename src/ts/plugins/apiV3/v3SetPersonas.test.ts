// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The plugin `setDatabase` and `setDatabaseLite` host setters over the settings records, for
// `personas` and `selectedPersona`. Both setters apply the personas contract (`shared/personas.ts`)
// to a plain copy of the plugin's list (never empty, the four fields strings, unique ids; a
// non-list is refused and the personas kept), and apply `selectedPersona` after `personas` whatever
// the object's key order, so the index names a persona of the list the same call sets. The
// direct-index readers of the UI (`DefaultChatScreen`, `PersonaSettings`:
// `personas[selectedPersona]`) must find a record after every call. A persona import whose image is
// still being saved when the full setter replaces the list reaches the live list.

await vi.hoisted(async () => {
    const { Buffer: BufferPolyfill } = await import("buffer");
    (globalThis as any).Buffer = BufferPolyfill;
});

const captured = vi.hoisted(() => ({
    api: null as null | Record<string, any>,
    file: null as null | ((value: { name: string; data: Uint8Array } | null) => void),
    asset: null as null | ((path: string) => void),
    chunks: [] as { key: string; value: string }[],
}));

vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(api: Record<string, any>) {
            captured.api = api;
        }
        run() {}
    },
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(() => new Promise<string>((resolve) => (captured.asset = resolve))),
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    getFetchLogs: vi.fn(),
    checkCharOrder: vi.fn(),
    AppendableBuffer: class {},
}));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text), hasher: vi.fn() }));
vi.mock("src/ts/process/index.svelte", () => ({
    sendChat: vi.fn(),
    doingChat: { set: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock("src/ts/process/files/inlays", () => ({ reencodeImage: vi.fn(async (data: Uint8Array) => data) }));
vi.mock("src/ts/pngChunk", () => ({
    PngChunk: {
        readGenerator: async function* () {
            yield* captured.chunks;
        },
    },
}));
vi.mock("src/ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    selectSingleFile: vi.fn(
        () => new Promise<{ name: string; data: Uint8Array } | null>((resolve) => (captured.file = resolve)),
    ),
}));

import { selection, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { activePersona, selectedPersonaIndex, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { importUserPersona } from "src/ts/persona";
import { executePluginV3 } from "./v3.svelte";

const personas = () => settings.personas as any[];
const names = () => personas().map((entry: { name: string }) => entry.name);
const ids = () => personas().map((entry: { id: string }) => entry.id);
/** What `DefaultChatScreen` and `PersonaSettings` read: the persona at the selection index. */
const directIndexReader = () => {
    const record = personas()[selectedPersonaIndex()];
    return { icon: record.icon, largePortrait: record.largePortrait, name: record.name };
};

const personaA = { id: "a", name: "A", icon: "ia", personaPrompt: "pa", note: "na" };
const personaB = { id: "b", name: "B", icon: "ib", personaPrompt: "pb", note: "nb" };

/** The records installed as the app installs them (there is no whole-database aggregate). */
function install() {
    installFlatDatabase({ characters: [], plugins: [], botPresets: [], personas: [personaA, personaB] });
}

beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectPersona("");
    captured.file = null;
    captured.asset = null;
    captured.chunks = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    install();
    if (!captured.api) {
        await executePluginV3({ name: "host-persona-test", script: "", version: "3.0" } as any);
    }
    expect(captured.api?.setDatabase).toBeTypeOf("function");
    expect(captured.api?.setDatabaseLite).toBeTypeOf("function");
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** Runs `check` for both setters, each from the same starting state. */
async function withBothSetters(check: (set: (value: unknown) => Promise<void>, label: string) => Promise<void>) {
    await check(async (value) => {
        captured.api!.setDatabaseLite(value);
    }, "setDatabaseLite");
    install();
    await check(async (value) => {
        await captured.api!.setDatabase(value);
    }, "setDatabase");
}

describe("the plugin setters and personas", () => {
    it("turn an empty list into the default persona, which the selection and the direct-index readers resolve", async () => {
        await withBothSetters(async (set, label) => {
            selectPersona("b");
            await set({ personas: [] });
            expect(personas(), label).toHaveLength(1);
            expect(personas()[0], label).toMatchObject({ name: "User", icon: "", personaPrompt: "", note: "" });
            expect(activePersona.name, label).toBe("User");
            expect(selectedPersonaIndex(), label).toBe(0);
            expect(selection.personaId, label).toBe(personas()[0].id);
            expect(() => directIndexReader(), label).not.toThrow();
            expect(directIndexReader().name, label).toBe("User");
        });
    });

    it("repair duplicate ids so that a selection by index names one persona, and fill missing fields as strings", async () => {
        await withBothSetters(async (set, label) => {
            await set({
                personas: [
                    { id: "dup", name: "first" },
                    { id: "dup", name: "second", note: 7 },
                ],
                selectedPersona: 1,
            });
            expect(names(), label).toEqual(["first", "second"]);
            expect(personas()[0].id, label).toBe("dup");
            expect(personas()[1].id, label).not.toBe("dup");
            expect(personas()[1].id.length, label).toBeGreaterThan(0);
            expect(personas()[0], label).toEqual({
                id: "dup",
                name: "first",
                icon: "",
                personaPrompt: "",
                note: "",
            });
            expect(personas()[1].note, label).toBe("");
            expect(selectedPersonaIndex(), label).toBe(1);
            expect(activePersona.name, label).toBe("second");
            expect(selection.personaId, label).toBe(personas()[1].id);
            expect(directIndexReader().name, label).toBe("second");
        });
    });

    it("apply selectedPersona after personas whatever the key order, against the list the same call sets", async () => {
        await withBothSetters(async (set, label) => {
            const c = { id: "c", name: "C", icon: "", personaPrompt: "", note: "" };
            const d = { id: "d", name: "D", icon: "", personaPrompt: "", note: "" };
            await set({ selectedPersona: 1, personas: [c, d] });
            expect(selection.personaId, `${label}: selection first`).toBe("d");
            expect(selectedPersonaIndex(), label).toBe(1);
            expect(activePersona.name, label).toBe("D");
            expect(directIndexReader().name, label).toBe("D");

            const e = { id: "e", name: "E", icon: "ie", personaPrompt: "", note: "" };
            const f = { id: "f", name: "F", icon: "if", personaPrompt: "", note: "", largePortrait: true };
            await set({ personas: [e, f], selectedPersona: 1 });
            expect(selection.personaId, `${label}: personas first`).toBe("f");
            expect(activePersona.name, label).toBe("F");
            expect(directIndexReader(), label).toEqual({ icon: "if", largePortrait: true, name: "F" });

            // Without a list, the index selects in the current one; out of range is ignored.
            await set({ selectedPersona: 0 });
            expect(selection.personaId, label).toBe("e");
            await set({ selectedPersona: 7 });
            expect(selection.personaId, label).toBe("e");
            expect(directIndexReader().name, label).toBe("E");
        });
    });

    it("keep the selected persona by id when a plugin replaces the list without a selection", async () => {
        await withBothSetters(async (set, label) => {
            selectPersona("b");
            await set({ personas: [{ ...personaB, name: "B2" }, personaA] });
            expect(selection.personaId, label).toBe("b");
            expect(selectedPersonaIndex(), label).toBe(0);
            expect(activePersona.name, label).toBe("B2");
            // The selected id is gone from the new list: the lite setter leaves the repair to the
            // next read (the lazy fallback of the settings views), the full setter's `setDatabase`
            // resolves it at once. Either way the first read serves the first persona.
            await set({ personas: [{ ...personaA, name: "A only" }] });
            expect(activePersona.name, label).toBe("A only");
            expect(selection.personaId, label).toBe("a");
            expect(directIndexReader().name, label).toBe("A only");
        });
    });

    it("refuse a non-list and keep the personas, and do not mutate the plugin's own array", async () => {
        await withBothSetters(async (set, label) => {
            const before = JSON.stringify(personas());
            for (const value of ["x", {}, 1, true]) {
                await set({ personas: value });
                expect(JSON.stringify(personas()), `${label} ${JSON.stringify(value)}`).toBe(before);
            }
            expect(console.warn, label).toHaveBeenCalledTimes(4);
            vi.mocked(console.warn).mockClear();

            const own = [{ name: "no id" }, { id: "b", name: "B" }];
            await set({ personas: own });
            expect(own, label).toEqual([{ name: "no id" }, { id: "b", name: "B" }]);
            expect(ids()[0], label).toEqual(expect.any(String));
            expect(ids()[1], label).toBe("b");
        });
    });
});

describe("a persona import while the full setter replaces the list", () => {
    it("reaches the live list: the push runs after the image is saved, on the collection of that moment", async () => {
        captured.chunks = [
            {
                key: "persona",
                value: Buffer.from(JSON.stringify({ name: "Imported", personaPrompt: "ip", note: "n" })).toString(
                    "base64",
                ),
            },
        ];
        const done = importUserPersona();
        await Promise.resolve();
        captured.file!({ name: "card.png", data: new Uint8Array([1]) });
        await vi.waitFor(() => expect(captured.asset).not.toBeNull());

        // The image is being saved: a plugin's full setter replaces (and normalizes) the list.
        const detached = personas();
        await captured.api!.setDatabase({ personas: [{ ...personaA, name: "A from plugin" }, personaB] });
        // A retained wrapper follows its record across replacements: the list held before the
        // setter is the live list's wrapper, and it shows the replaced list.
        expect(personas()).toBe(detached);
        expect(names()).toEqual(["A from plugin", "B"]);

        captured.asset!("assets/imported.png");
        await done;
        expect(names()).toEqual(["A from plugin", "B", "Imported"]);
        expect(personas()[2]).toMatchObject({ icon: "assets/imported.png", personaPrompt: "ip", note: "n" });
        expect(personas()[2].id.length).toBeGreaterThan(0);
        expect(detached).toHaveLength(3);
    });
});
