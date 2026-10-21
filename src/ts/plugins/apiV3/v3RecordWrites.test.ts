// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    previewBody: vi.fn(),
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

import { recordData, setRecordWriteListener } from "src/ts/storage/records.svelte";
import { selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { activeMainProfile, activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { DEFAULT_MODEL_PROFILE_ID, normalizeModelProfile } from "../../../../shared/presets";
import { executePluginV3 } from "./v3.svelte";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const personaA = { id: "a", name: "A", icon: "", personaPrompt: "", note: "" };

let notified: string[] = [];

beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectPersona("");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The records installed as the app installs them (there is no whole-database aggregate).
    installFlatDatabase({
        characters: [],
        plugins: [],
        modules: [],
        botPresets: [{ id: "p", name: "P", temperature: 1 }],
        // The default profile the installed model preset's main slot names.
        modelProfiles: [normalizeModelProfile({}, { id: DEFAULT_MODEL_PROFILE_ID })],
        personas: [personaA],
        theme: "",
        lineHeight: 1,
        pluginCustomStorage: {},
    });
    notified = [];
    setRecordWriteListener((kind) => notified.push(kind));
    if (!captured.api) {
        await executePluginV3({ name: "host-record-test", script: "", version: "3.0" } as any);
    }
});

afterEach(() => {
    setRecordWriteListener(null);
    vi.restoreAllMocks();
});

// A plugin's `setDatabase`/`setDatabaseLite` call runs in one `batchRecordWrites` scope, so each
// settings record it changes is queued once, whatever the number of keys, and a key the mutations
// refuse keeps its value (warned) without stopping the others.
describe("the plugin database setters over the settings records", () => {
    for (const setter of ["setDatabaseLite", "setDatabase"] as const) {
        it(`${setter} queues each record it changes once and keeps a refused key's value`, async () => {
            const modulesBefore = plain(recordData("modules"));
            await captured.api![setter]({
                theme: "waifu",
                lineHeight: 2,
                customCSS: "body{}",
                temperature: 7,
                maxContext: 4096,
                modules: "not a list",
                customKey: { a: 1 },
                otherKey: 2,
                personas: [personaA, { id: "b", name: "B", icon: "", personaPrompt: "", note: "" }],
            });
            // `maxContext` is the model preset's main profile's: one more record, once.
            expect(notified.sort()).toEqual(["modelProfiles", "personas", "pluginStorage", "presets", "ui"]);
            expect(settings.ui.theme).toBe("waifu");
            expect(settings.ui.lineHeight).toBe(2);
            expect(activePreset.temperature).toBe(7);
            expect(activeMainProfile.maxContext).toBe(4096);
            expect(plain(settings.pluginStorage)).toEqual({ customKey: { a: 1 }, otherKey: 2 });
            expect(settings.personas).toHaveLength(2);
            expect(plain(recordData("modules"))).toEqual(modulesBefore);
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("the database key modules"));
        });
    }
});
