// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { LLMFormat, LLMTokenizer } from "../../../../shared/llm.ts";
import { selectTokenizer } from "../../../../shared/tokenizerChoice.ts";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Chat Bot page is split into the Model page (`ModelSettings.svelte`, the selected model
// preset) and the Prompt page (`PromptPresetSettings.svelte`, the selected prompt preset). Each
// page names its preset and opens its own list, and an edit on one page lands in that page's preset
// only. With the model profiles, the Model menu's Preset tab picks a profile per slot and its
// Connections tab (`ModelProfilesSettings.svelte`) edits the profiles themselves.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/tokenizer", () => ({
    tokenizeAccurate: vi.fn(async () => 0),
    tokenizerList: [["tik", "Tiktoken"]],
}));
vi.mock("src/ts/process/prompt", () => ({ tokenizePreset: vi.fn(async () => 0) }));

import { get } from "svelte/store";
import { language } from "src/lang";
import { alertConfirm } from "src/ts/alert";
import { deleteModelProfile, translatorPresetsUsingModelProfile } from "src/ts/storage/collectionStore.svelte";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets.ts";
import { createTranslatorPreset } from "../../../../shared/translatorPresets.ts";
import { settings, activePreset, activeMainProfile } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { selectChat } from "src/ts/storage/chatStore.svelte";
import { applyRaw } from "src/ts/storage/records.svelte";
import { selectCharacter, selectModelPreset, selectPreset, setChatOpen } from "src/ts/storage/selection.svelte";
import {
    API_KEYS_SETTINGS_MENU,
    closePopupEditorSession,
    MODEL_PROFILES_SETTINGS_MENU,
    MODEL_SETTINGS_MENU,
    openModelPresetList,
    openPresetList,
    popUpEditorStore,
    SettingsMenuIndex,
    settingsOpen,
} from "src/ts/stores.svelte";
import ModelProfilesSettings from "./ModelProfilesSettings.svelte";
import ModelSettings from "./ModelSettings.svelte";
import PromptPresetSettings from "./PromptPresetSettings.svelte";
import CustomModelsSettings from "./Advanced/CustomModelsSettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render(
    component:
        typeof ModelSettings | typeof PromptPresetSettings | typeof ModelProfilesSettings | typeof CustomModelsSettings,
) {
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
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
    installFlatDatabase({
        characters: [],
        customModels: [],
        useLegacyGUI: false,
        botPresets: [{ id: "p1", name: "Prompt One", temperature: 80, maxResponse: 300 }],
        modelPresets: [
            normalizeModelPreset(
                { name: "Model One", mainSlot: { profileId: "echo" }, subSlot: { profileId: "echo" } },
                { id: "m1" },
            ),
        ],
        // The main and sub slots name one profile.
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
});

describe("the Connections tab", () => {
    it("offers flags 25, 26, and 27 and stores their numbers on the edited profile", () => {
        const page = render(ModelProfilesSettings);
        page.querySelector<HTMLElement>("[data-profile-id=spare]")!.click();
        flushSync();
        const button = (label: string) =>
            [...page.querySelectorAll<HTMLButtonElement>("button")].find(
                (entry) => entry.textContent?.trim() === label,
            );
        button(language.customFlags)!.click();
        flushSync();
        page.querySelector<HTMLInputElement>(`input[alt="${language.enableCustomFlags}"]`)!.click();
        flushSync();
        const flags = [
            ["noStructuredOutput", 25],
            ["geminiThinkingNoMinimal", 26],
            ["claudeThinkingOnByDefault", 27],
        ] as const;
        for (const [label, number] of flags) {
            expect(button(label), label).toBeDefined();
            button(label)!.click();
            flushSync();
            expect(settings.modelProfiles.find((profile) => profile.id === "spare")?.customFlags).toEqual([number]);
            button(label)!.click();
            flushSync();
            expect(settings.modelProfiles.find((profile) => profile.id === "spare")?.customFlags).toEqual([]);
        }
    });

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

    // A tab switch remounts the page (`Settings.svelte` keys it by the menu index); the selected
    // connection survives the remount.
    it("keeps the selected connection when the tab is left and opened again", () => {
        const page = render(ModelProfilesSettings);
        page.querySelector<HTMLElement>("[data-profile-id=spare]")!.click();
        flushSync();
        unmount(mounted.pop()!);
        page.remove();
        flushSync();

        const again = render(ModelProfilesSettings);
        expect(again.querySelector("[data-profile-id=spare]")?.getAttribute("aria-pressed")).toBe("true");
        expect(again.querySelector("[data-profile-id=echo]")?.getAttribute("aria-pressed")).toBe("false");
        expect(again.querySelector<HTMLInputElement>("#model-profile-name")?.value).toBe("Spare");
        // The selection is editor state only: no slot changed.
        expect(settings.modelPresets[0].mainSlot).toEqual({ profileId: "echo" });

        // A removed connection falls back to the first one.
        unmount(mounted.pop()!);
        again.remove();
        expect(deleteModelProfile("spare")).toBe(true);
        flushSync();
        const after = render(ModelProfilesSettings);
        expect(after.querySelector("[data-profile-id=echo]")?.getAttribute("aria-pressed")).toBe("true");
    });

    // A translator step may name a profile; deleting the profile lists them.
    it("lists the translator presets with a step on the profile in the delete confirmation, disabled steps included, each preset once", async () => {
        const onSpare = (overrides: Record<string, unknown> = {}) => ({
            prompt: "x",
            model: { mode: "profile" as const, profileId: "spare" },
            ...overrides,
        });
        settings.translatorPresets.items = [
            createTranslatorPreset("Twice", { id: "t1", steps: [onSpare(), onSpare({ enabled: false })] }),
            createTranslatorPreset("Slot only", { id: "t2", prompt: "y" }),
            createTranslatorPreset("Disabled step", {
                id: "t3",
                steps: [{ prompt: "z" }, onSpare({ enabled: false })],
            }),
            createTranslatorPreset("Other profile", {
                id: "t4",
                steps: [{ prompt: "w", model: { mode: "profile", profileId: "echo" } }],
            }),
        ];
        expect(translatorPresetsUsingModelProfile("spare").map((preset) => preset.name)).toEqual([
            "Twice",
            "Disabled step",
        ]);
        expect(translatorPresetsUsingModelProfile("nobody")).toEqual([]);

        const page = render(ModelProfilesSettings);
        page.querySelector<HTMLElement>("[data-profile-id=spare]")!.click();
        flushSync();
        vi.mocked(alertConfirm).mockResolvedValueOnce(false);
        [...page.querySelectorAll("button")]
            .find((entry) => entry.textContent?.trim() === language.modelProfiles.delete)!
            .click();
        await Promise.resolve();
        // No model preset slot names `spare`; two translator presets do.
        expect(alertConfirm).toHaveBeenCalledWith(
            language.modelProfiles.deleteConfirm("Spare", "", "Twice\nDisabled step"),
        );
        const text = vi.mocked(alertConfirm).mock.calls[0][0] as string;
        expect(text).toContain("Used by steps of these translator presets:\nTwice\nDisabled step");
        expect(text).not.toContain("Used by these model presets");
        // Declined: the profile and the presets stay.
        await Promise.resolve();
        expect(settings.modelProfiles.map((profile) => profile.id)).toEqual(["echo", "spare"]);
        expect(settings.translatorPresets.items).toHaveLength(4);
    });
});

describe("custom model definitions", () => {
    it("offers every supported format and tokenizer and persists newly exposed numeric codes", () => {
        settings.customModels = [
            {
                id: "xcustom:::test",
                name: "Definition",
                internalId: "test",
                url: "",
                format: 0,
                tokenizer: 1,
                params: "",
                flags: [],
            },
        ];
        const page = render(CustomModelsSettings);
        for (const label of [language.customModels, "Definition"]) {
            [...page.querySelectorAll("button")].find((button) => button.textContent?.trim() === label)!.click();
            flushSync();
        }
        const [tokenizer, format] = [...page.querySelectorAll("select")];
        expect([...format.options].map((option) => Number(option.value))).toEqual(Object.values(LLMFormat));
        expect([...tokenizer.options].map((option) => Number(option.value))).toEqual(Object.values(LLMTokenizer));
        // The UI's persisted discriminator must have a dispatch branch, including local/plugin dispatch.
        const dispatch = readFileSync("server/src/llm/request.ts", "utf8");
        for (const [name] of Object.entries(LLMFormat)) expect(dispatch).toContain(`case LLMFormat.${name}:`);
        for (const code of [10, 12, 15, 16, 19, 20, 21, 22, 23]) {
            chooseOption(format, String(code));
            flushSync();
            expect(settings.customModels[0].format).toBe(code);
        }
        chooseOption(tokenizer, "12");
        flushSync();
        expect(settings.customModels[0].tokenizer).toBe(12);
        expect(
            selectTokenizer({
                aiModel: "xcustom:::test",
                modelTokenizer: settings.customModels[0].tokenizer,
                customTokenizer: "tik",
                pluginTokenizer: "none",
                googleClaudeTokenizing: false,
            }),
        ).toEqual({ kind: "family", family: "cl100k_base" });
    });

    it("offers flags 11, 25, 26, and 27 and stores their numbers on the custom model", () => {
        settings.customModels = [
            {
                id: "xcustom:::claude",
                name: "Custom Claude",
                internalId: "claude-opus-5",
                url: "https://custom.example/v1/messages",
                format: 2,
                tokenizer: 6,
                params: "",
                flags: [],
            },
        ];
        const page = render(CustomModelsSettings);
        const button = (label: string) =>
            [...page.querySelectorAll<HTMLButtonElement>("button")].find(
                (entry) => entry.textContent?.trim() === label,
            );
        for (const label of [language.customModels, "Custom Claude", language.flags]) {
            button(label)!.click();
            flushSync();
        }
        const flags = [
            ["poolSupported", 11],
            ["noStructuredOutput", 25],
            ["geminiThinkingNoMinimal", 26],
            ["claudeThinkingOnByDefault", 27],
        ] as const;
        for (const [label, number] of flags) {
            expect(button(label), label).toBeDefined();
            button(label)!.click();
            flushSync();
            expect(settings.customModels[0].flags).toEqual([number]);
            button(label)!.click();
            flushSync();
            expect(settings.customModels[0].flags).toEqual([]);
        }
    });
});

describe("the Prompt page", () => {
    it("initializes text to an empty string when a persona item is switched to chatML through the type select", () => {
        activePreset.promptTemplate = [{ type: "persona" }];
        const page = render(PromptPresetSettings);
        [...page.querySelectorAll("button")].find((button) => button.textContent?.trim() === language.prompt)!.click();
        flushSync();
        [...page.querySelectorAll<HTMLElement>('[draggable="true"]')]
            .find((header) => header.textContent?.trim() === language.formating.personaPrompt)!
            .click();
        flushSync();
        const typeSelect = [...page.querySelectorAll("select")].find((select) =>
            [...select.options].some((option) => option.value === "chatML"),
        )!;
        expect(typeSelect.value).toBe("persona");
        chooseOption(typeSelect, "chatML");
        flushSync();
        expect(activePreset.promptTemplate[0]).toMatchObject({ type: "chatML", text: "" });
    });

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

    it("a field's popup writes the preset it opened on; a preset change while it is open discards it, even between presets with the same text", async () => {
        vi.useFakeTimers();
        const previousPopup = { ...popUpEditorStore };
        try {
            installFlatDatabaseWithChats({
                characters: [
                    {
                        chaId: "c",
                        type: "character",
                        name: "C",
                        chats: [{ id: "chat", name: "chat", message: [], localLore: [], promptPresetId: "bound" }],
                    },
                ],
                botPresets: [
                    { id: "bound", name: "Bound", moduleIntergration: "" },
                    { id: "tab", name: "Tab", moduleIntergration: "" },
                ],
                useLegacyGUI: false,
            } as any);
            selectPreset("tab");
            selectCharacter("c");
            selectChat("c", "chat");
            setChatOpen(true);
            expect(activePreset.id).toBe("bound");
            const page = render(PromptPresetSettings);
            const button = (name: string) =>
                [...page.querySelectorAll("button")].find((button) => button.textContent?.trim() === name)!;
            button(language.others).click();
            flushSync();
            button(language.moduleIntergration).click();
            flushSync();
            const openPopup = () => {
                const area = [...page.querySelectorAll("textarea")].find((area) =>
                    area.closest("div.relative")?.querySelector("button"),
                )!;
                area.parentElement!.querySelector("button")!.click();
                flushSync();
                expect(popUpEditorStore).toMatchObject({ open: true, value: "" });
            };
            const closePopupWith = async (text: string) => {
                popUpEditorStore.value = text;
                closePopupEditorSession(popUpEditorStore.sessionId);
                await vi.advanceTimersByTimeAsync(100);
                flushSync();
                await vi.advanceTimersByTimeAsync(0);
                flushSync();
            };
            const moduleIntegrations = () => settings.presets.map((preset) => [preset.id, preset.moduleIntergration]);

            // The chat's bound preset is shown; Home closes the chat while its popup is open, and the
            // tab's preset (also "") is shown next, so the bound value alone would not notice.
            openPopup();
            popUpEditorStore.value = "typed for the bound preset";
            selectCharacter(null);
            flushSync();
            expect(activePreset.id).toBe("tab");
            await closePopupWith("typed for the bound preset");
            expect(moduleIntegrations()).toEqual([
                ["bound", ""],
                ["tab", ""],
            ]);

            // Without a change the popup writes the shown preset, also across a refresh of the preset
            // list (another client renamed it) that keeps its id.
            openPopup();
            const refreshed = JSON.parse(JSON.stringify(settings.presets));
            refreshed[1].name = "Tab, renamed";
            applyRaw("presets", refreshed);
            flushSync();
            await vi.advanceTimersByTimeAsync(100);
            flushSync();
            expect(popUpEditorStore.open).toBe(true);
            await closePopupWith("typed for the tab preset");
            expect(moduleIntegrations()).toEqual([
                ["bound", ""],
                ["tab", "typed for the tab preset"],
            ]);
        } finally {
            popUpEditorStore.open = false;
            await vi.advanceTimersByTimeAsync(100);
            Object.assign(popUpEditorStore, previousPopup);
            vi.useRealTimers();
        }
    });
});
