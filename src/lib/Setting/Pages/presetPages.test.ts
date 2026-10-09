// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slice 4 of `docs/plan/split-preset.md`: the Chat Bot page is split into the Model page
// (`ModelSettings.svelte`, the selected model preset) and the Prompt page
// (`PromptPresetSettings.svelte`, the selected prompt preset). Each page names its preset and opens
// its own list, and an edit on one page lands in that page's preset only. With the model profiles
// (`docs/plan/model-profiles.md`), the Model menu's Preset tab picks a profile per slot and its Connections tab
// (`ModelProfilesSettings.svelte`) edits the profiles themselves.

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
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets.ts";
import { settings, activePreset, activeMainProfile } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import {
    API_KEYS_SETTINGS_MENU,
    MODEL_PROFILES_SETTINGS_MENU,
    MODEL_SETTINGS_MENU,
    openModelPresetList,
    openPresetList,
    SettingsMenuIndex,
    settingsOpen,
} from "src/ts/stores.svelte";
import ModelProfilesSettings from "./ModelProfilesSettings.svelte";
import ModelSettings from "./ModelSettings.svelte";
import PromptPresetSettings from "./PromptPresetSettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render(component: typeof ModelSettings | typeof PromptPresetSettings | typeof ModelProfilesSettings) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(component as typeof ModelSettings, { target }));
    flushSync();
    return target;
}

/** Selects an option as a user would; happy-dom has no `:checked` for options, which Svelte's select binding reads. */
function chooseOption(element: HTMLSelectElement, value: string) {
    element.value = value;
    const querySelector = element.querySelector.bind(element);
    (element as { querySelector: unknown }).querySelector = (selector: string) =>
        selector === ":checked" ? (element.options[element.selectedIndex] ?? null) : querySelector(selector);
    element.dispatchEvent(new Event("change"));
}

beforeEach(() => {
    installFlatDatabase({
        characters: [],
        useLegacyGUI: false,
        botPresets: [{ id: "p1", name: "Prompt One", temperature: 80, maxResponse: 300 }],
        modelPresets: [
            normalizeModelPreset(
                { name: "Model One", mainSlot: { profileId: "echo" }, subSlot: { profileId: "echo" } },
                { id: "m1" },
            ),
        ],
        // The main and sub slots name one profile (`docs/plan/model-profiles.md`).
        modelProfiles: [
            normalizeModelProfile({ id: "echo", name: "Echo", modelId: "echo_model", maxContext: 9000 }),
            normalizeModelProfile({ id: "spare", name: "Spare", modelId: "echo_model", maxContext: 5000 }),
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
    it("names the selected model preset, opens the model list, and picks the main slot's profile", () => {
        const page = render(ModelSettings);
        expect(page.querySelector("h2")?.textContent).toBe("Model");
        expect(page.textContent).toContain("Model One");
        expect(page.textContent).not.toContain("Prompt One");

        page.querySelector<HTMLElement>(".lucide-list")!.closest("button")!.click();
        expect(get(openModelPresetList)).toBe(true);
        expect(get(openPresetList)).toBe(false);

        // The context size is the profile's, edited on the Connections tab.
        const numbers = [...page.querySelectorAll<HTMLInputElement>("input[type=number]")].map((input) => input.value);
        expect(numbers).not.toContain("9000");

        const main = page.querySelector<HTMLSelectElement>("[data-model-slot=model] select")!;
        expect(main.value).toBe("profile:echo");
        chooseOption(main, "profile:spare");
        flushSync();
        expect(settings.modelPresets[0].mainSlot).toEqual({ profileId: "spare" });
        expect(settings.modelPresets[0].subSlot).toEqual({ profileId: "echo" });
        expect(activeMainProfile.maxContext).toBe(5000);
    });

    // The Model menu's tabs (`Model/ModelMenuTabs.svelte`) switch the settings screen by menu index.
    function tab(page: HTMLElement, label: string) {
        return [...page.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
            (button) => button.textContent?.trim() === label,
        )!;
    }

    it("switches the settings screen between its Preset, Connections, and API Keys tabs", () => {
        SettingsMenuIndex.set(MODEL_SETTINGS_MENU);
        settingsOpen.set(true);
        const page = render(ModelSettings);
        expect(tab(page, "Preset").getAttribute("aria-pressed")).toBe("true");

        tab(page, "Connections").click();
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(MODEL_PROFILES_SETTINGS_MENU);
        tab(page, "API Keys").click();
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(API_KEYS_SETTINGS_MENU);
        expect(tab(page, "API Keys").getAttribute("aria-pressed")).toBe("true");
    });

    it("opens the settings screen at a tab from the quick settings panel, which shows only the Preset tab", () => {
        SettingsMenuIndex.set(-1);
        settingsOpen.set(false);
        const target = document.createElement("div");
        document.body.appendChild(target);
        mounted.push(mount(ModelSettings, { target, props: { quick: true } }));
        flushSync();
        expect(tab(target, "Preset").getAttribute("aria-pressed")).toBe("true");

        tab(target, "Preset").click();
        flushSync();
        expect(get(settingsOpen)).toBe(false);
        expect(get(SettingsMenuIndex)).toBe(-1);

        tab(target, "API Keys").click();
        flushSync();
        expect(get(settingsOpen)).toBe(true);
        expect(get(SettingsMenuIndex)).toBe(API_KEYS_SETTINGS_MENU);
        // The panel keeps showing the preset.
        expect(tab(target, "Preset").getAttribute("aria-pressed")).toBe("true");
    });
});

describe("the Connections tab", () => {
    it("edits the selected profile's context size, also for a profile no slot uses", () => {
        const page = render(ModelProfilesSettings);
        page.querySelector<HTMLElement>("[data-profile-id=spare]")!.click();
        flushSync();
        const context = [...page.querySelectorAll<HTMLInputElement>("input[type=number]")].find(
            (input) => input.value === "5000",
        );
        expect(context, "the context size input").toBeDefined();
        context!.value = "12000";
        context!.dispatchEvent(new Event("input"));
        context!.dispatchEvent(new Event("change"));
        flushSync();
        expect(settings.modelProfiles.find((profile) => profile.id === "spare")?.maxContext).toBe(12000);
        // The main slot's profile keeps its own value.
        expect(activeMainProfile.maxContext).toBe(9000);
        expect(settings.modelPresets[0]).not.toHaveProperty("maxContext");
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
