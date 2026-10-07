// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 5: the plugin `setDatabase` host setter over the settings records. A forwarded key
// of `allowedDbKeys` (`temperature`, `maxContext`, ...) lands in the preset this client has selected.
// When the object also carries `plugins`, the install prompt is awaited before anything is assigned,
// so every field lands in the preset selected when the prompt is answered, not in two different
// presets depending on the key order (Astra challenge point 2, adopted in reduced form).

const captured = vi.hoisted(() => ({
    api: null as null | Record<string, any>,
    confirm: [] as ((v: boolean) => void)[],
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
    saveAsset: vi.fn(),
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    getFetchLogs: vi.fn(),
    checkCharOrder: vi.fn(),
}));
vi.mock("src/ts/alert", () => ({
    alertNormal: vi.fn(),
    alertError: vi.fn(),
    alertConfirm: vi.fn(() => new Promise<boolean>((resolve) => captured.confirm.push(resolve))),
}));
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

import { llmSecretState, setMaskedSecrets } from "src/ts/storage/llmSecrets.svelte";
import { maskLlmSecrets } from "../../../../shared/llmSecrets.ts";
import { changeToPreset } from "src/ts/storage/presets.svelte";
import { selectPreset } from "src/ts/storage/selection.svelte";
import { activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { executePluginV3 } from "./v3.svelte";

const preset = (id: string) => settings.presets.find((entry: { id: string }) => entry.id === id) as any;

beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    // The write-only `llmSecrets` state (7b): an empty masked record and no queued credential write.
    llmSecretState.queue.splice(0);
    setMaskedSecrets(maskLlmSecrets({}));
    captured.confirm.length = 0;
    // The records installed as the app installs them (the aggregate is gone since Phase 6 slice 10).
    installFlatDatabase({
        characters: [],
        plugins: [],
        botPresets: [
            { id: "a", name: "A", temperature: 80, maxContext: 4000 },
            { id: "b", name: "B", temperature: 50, maxContext: 5000 },
        ],
    });
    if (!captured.api) {
        await executePluginV3({ name: "host-setter-test", script: "", version: "3.0" } as any);
    }
    expect(captured.api?.setDatabase).toBeTypeOf("function");
});

describe("the plugin setDatabase host setter", () => {
    it("lands a forwarded key in the selected preset and leaves the other alone", async () => {
        await captured.api!.setDatabase({ temperature: 91, maxContext: 9100 });
        expect(preset("a")).toMatchObject({ temperature: 91, maxContext: 9100 });
        expect(preset("b")).toMatchObject({ temperature: 50, maxContext: 5000 });
        expect(activePreset.temperature).toBe(91);

        changeToPreset("b", false);
        await captured.api!.setDatabase({ temperature: 92 });
        expect(preset("b").temperature).toBe(92);
        expect(preset("a").temperature).toBe(91);
    });

    it("awaits the plugin install prompt before assigning anything, so every field lands in the preset selected then", async () => {
        const pending = captured.api!.setDatabase({
            temperature: 91,
            plugins: [{ name: "installed-via-plugin", script: "", version: "3.0" }],
            maxContext: 9100,
        });
        // The prompt is open: nothing has been assigned, whatever the key order.
        await Promise.resolve();
        expect(captured.confirm).toHaveLength(1);
        expect(preset("a")).toMatchObject({ temperature: 80, maxContext: 4000 });

        // The user switches presets while the prompt is open, then accepts.
        changeToPreset("b", false);
        captured.confirm[0](true);
        await pending;

        expect(preset("b")).toMatchObject({ temperature: 91, maxContext: 9100 });
        expect(preset("a")).toMatchObject({ temperature: 80, maxContext: 4000 });
        expect(settings.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(["installed-via-plugin"]);
    });
});
