// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slice 4 of `docs/plan/split-preset.md`: the Chat Bot page is split into the Model page
// (`ModelSettings.svelte`, the selected model preset) and the Prompt page
// (`PromptPresetSettings.svelte`, the selected prompt preset). Each page names its preset and opens
// its own list, and an edit on one page lands in that page's preset only.

vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertInput: vi.fn(),
    alertMd: vi.fn(),
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn(), globalFetch: vi.fn() }));
vi.mock("src/ts/tokenizer", () => ({
    tokenizeAccurate: vi.fn(async () => 0),
    tokenizerList: [["tik", "Tiktoken"]],
}));
vi.mock("src/ts/process/prompt", () => ({ tokenizePreset: vi.fn(async () => 0) }));

import { get } from "svelte/store";
import { settings, activePreset, activeModelPreset } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import { openModelPresetList, openPresetList } from "src/ts/stores.svelte";
import ModelSettings from "./ModelSettings.svelte";
import PromptPresetSettings from "./PromptPresetSettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render(component: typeof ModelSettings | typeof PromptPresetSettings) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(component as typeof ModelSettings, { target }));
    flushSync();
    return target;
}

beforeEach(() => {
    installFlatDatabase({
        characters: [],
        useLegacyGUI: false,
        botPresets: [{ id: "p1", name: "Prompt One", temperature: 80, maxResponse: 300 }],
        modelPresets: [
            { id: "m1", name: "Model One", aiModel: "echo_model", subModel: "echo_model", maxContext: 9000 },
        ],
    } as any);
    selectPreset("p1");
    selectModelPreset("m1");
    openPresetList.set(false);
    openModelPresetList.set(false);
});

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("the Model page", () => {
    it("names the selected model preset, opens the model list, and writes the context size into the model preset", () => {
        const page = render(ModelSettings);
        expect(page.querySelector("h2")?.textContent).toBe("Model");
        expect(page.textContent).toContain("Model One");
        expect(page.textContent).not.toContain("Prompt One");

        page.querySelector<HTMLElement>(".lucide-list")!.closest("button")!.click();
        expect(get(openModelPresetList)).toBe(true);
        expect(get(openPresetList)).toBe(false);

        const context = [...page.querySelectorAll<HTMLInputElement>("input[type=number]")].find(
            (input) => input.value === "9000",
        );
        expect(context, "the context size input").toBeDefined();
        context!.value = "12000";
        context!.dispatchEvent(new Event("input"));
        context!.dispatchEvent(new Event("change"));
        flushSync();
        expect(activeModelPreset.maxContext).toBe(12000);
        expect(settings.presets[0]).not.toHaveProperty("maxContext");
    });
});

describe("the Prompt page", () => {
    it("names the selected prompt preset, opens the prompt list, and shows no model selector", () => {
        const page = render(PromptPresetSettings);
        expect(page.querySelector("h2")?.textContent).toBe("Prompt");
        expect(page.textContent).toContain("Prompt One");
        expect(page.textContent).not.toContain("Model One");
        // The context size is the Model page's; the response size stays here.
        const numbers = [...page.querySelectorAll<HTMLInputElement>("input[type=number]")].map((input) => input.value);
        expect(numbers).toContain("300");
        expect(numbers).not.toContain("9000");

        page.querySelector<HTMLElement>(".lucide-list")!.closest("button")!.click();
        expect(get(openPresetList)).toBe(true);
        expect(get(openModelPresetList)).toBe(false);
        expect(activePreset.id).toBe("p1");
    });
});
