// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";

// Phase 3, slice 7 (`docs/plan/phases/slices/phase-3-settings-sections/credentials-and-closeout.md`,
// "`.risup` round trip": the HypaV3 JSON export is checked for no `id`). The export lives inline in
// the page's download button, so the page is mounted on the HypaV3 memory section and the button
// clicked: the file handed to `downloadFile` is exactly `{ type: "risu", ver: 1, data: { name,
// settings } }`, and the import button beside it gives the same file a fresh id and selects it.

const mocks = vi.hoisted(() => ({
    downloadFile: vi.fn(async () => undefined),
    selectSingleFile: vi.fn(),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
}));

vi.mock("src/ts/alert", () => ({
    alertError: mocks.alertError,
    alertNormal: mocks.alertNormal,
    alertInput: vi.fn(),
    alertConfirm: vi.fn(),
    alertMd: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    downloadFile: mocks.downloadFile,
    saveAsset: vi.fn(),
    globalFetch: vi.fn(),
}));
vi.mock("src/ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    selectSingleFile: mocks.selectSingleFile,
}));
// The page's token counters, character images, and the memory module reach the request pipeline;
// nothing under test needs them.
vi.mock("src/ts/process/prompt", () => ({ tokenizePreset: vi.fn(async () => 0) }));
vi.mock("src/ts/tokenizer", () => ({ getCharToken: vi.fn(async () => ({ total: 0 })) }));
vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn(() => "") }));
vi.mock("src/ts/process/memory/hypav3", async () => ({
    createHypaV3Preset: (await import("../../../../shared/hypaV3Presets.ts")).createHypaV3Preset,
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import { DBState } from "src/ts/stores.svelte";
import OtherBotSettings from "./OtherBotSettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(OtherBotSettings, { target }));
    flushSync();
    const button = (icon: string) => {
        const element = [...target.querySelectorAll("button")].find((entry) => entry.innerHTML.includes(icon));
        expect(element, `Expected the ${icon} button to be rendered`).toBeDefined();
        return element!;
    };
    return {
        target,
        exportButton: () => button("lucide-download"),
        importButton: () => button("lucide-hard-drive-upload"),
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    const exported = createHypaV3Preset("Exported", { memoryTokensRatio: 0.35, queryChatCount: 7 });
    const other = createHypaV3Preset("Other");
    DBState.db = {
        characters: [],
        hypaV3: true,
        hypav2: false,
        hanuraiEnable: false,
        supaModelType: "none",
        useLegacyGUI: false,
        hypaV3Presets: [other, exported],
        hypaV3PresetId: exported.id,
    } as any;
});

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("the HypaV3 preset export", () => {
    it("writes exactly { type, ver, data: { name, settings } } for the selected preset, without its id", async () => {
        const page = render();
        page.exportButton().click();
        await settle();

        expect(mocks.alertError).not.toHaveBeenCalled();
        expect(mocks.downloadFile).toHaveBeenCalledTimes(1);
        const [name, bytes] = mocks.downloadFile.mock.calls[0] as unknown as [string, Uint8Array];
        expect(name).toBe("hypaV3_export_Exported.json");
        const text = new TextDecoder().decode(bytes);
        expect(text).not.toContain(DBState.db.hypaV3PresetId);
        const file = JSON.parse(text);
        expect(Object.keys(file)).toEqual(["type", "ver", "data"]);
        expect(Object.keys(file.data)).toEqual(["name", "settings"]);
        const selected = DBState.db.hypaV3Presets[1];
        expect(file).toStrictEqual({
            type: "risu",
            ver: 1,
            data: { name: "Exported", settings: JSON.parse(JSON.stringify(selected.settings)) },
        });
        expect(file.data.settings).toMatchObject({ memoryTokensRatio: 0.35, queryChatCount: 7 });
    });

    it("imports its own export as a new preset with a fresh id and selects it", async () => {
        const page = render();
        page.exportButton().click();
        await settle();
        const [, bytes] = mocks.downloadFile.mock.calls[0] as unknown as [string, Uint8Array];
        const before = DBState.db.hypaV3Presets.map((preset) => preset.id);

        mocks.selectSingleFile.mockResolvedValueOnce({ name: "hypaV3_export_Exported.json", data: bytes });
        page.importButton().click();
        await settle();

        expect(mocks.alertError).not.toHaveBeenCalled();
        expect(DBState.db.hypaV3Presets).toHaveLength(3);
        const imported = DBState.db.hypaV3Presets[2];
        expect(before).not.toContain(imported.id);
        expect(imported.id).toEqual(expect.any(String));
        expect(DBState.db.hypaV3PresetId).toBe(imported.id);
        expect(imported.name).toBe("Exported");
        expect(JSON.parse(JSON.stringify(imported.settings))).toStrictEqual(
            JSON.parse(JSON.stringify(DBState.db.hypaV3Presets[1].settings)),
        );
    });
});
