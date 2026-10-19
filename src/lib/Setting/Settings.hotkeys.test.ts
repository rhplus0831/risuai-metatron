import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WEB-03: mount the actual Settings shell, so a responsive guard around HotkeySettings is tested.
// Other pages are not rendered and their service graphs are unnecessary for this boundary.
vi.mock("./Pages/DisplaySettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/UserSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/ModelSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/ModelProfilesSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/ApiKeysSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/PromptPresetSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/MemorySettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/ImageGenerationSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/VoiceSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/PluginSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/AdvancedSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/LanguageSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/TranslationSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/AccessibilitySettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/PersonaSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/PromptSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/ThanksPage.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/Module/ModuleSettings.svelte", () => ({ default: () => {} }));
vi.mock("src/ts/process/modules", () => ({ moduleUpdate: vi.fn(), getModules: () => [] }));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: (text: string) => text }));
vi.mock("src/ts/parser/transformClient", () => ({ resetTransformEffects: vi.fn() }));
vi.mock("src/ts/globalApi.svelte", () => ({ saveAsset: vi.fn(), downloadFile: vi.fn() }));
vi.mock("src/ts/process/index.svelte", () => ({}));

import { language } from "src/lang";
import { defaultHotkeys } from "src/ts/defaulthotkeys";
import { activeHotkeys } from "src/ts/hotkey";
import { initializeRecords } from "src/ts/storage/records.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { SettingsMenuIndex } from "src/ts/stores.svelte";
import Settings from "./Settings.svelte";

let component: ReturnType<typeof mount>;
let target: HTMLDivElement;
let initialWidth: number;

beforeEach(() => {
    initialWidth = window.innerWidth;
    initializeRecords({
        ui: { settingsCloseButtonSize: 20, enableScrollToActiveChar: false },
        hotkeys: structuredClone(defaultHotkeys),
    });
    SettingsMenuIndex.set(15);
    target = document.createElement("div");
    document.body.append(target);
});

afterEach(async () => {
    if (component) await unmount(component);
    target.remove();
    SettingsMenuIndex.set(-1);
    window.innerWidth = initialWidth;
});

function render(width: number) {
    window.innerWidth = width;
    component = mount(Settings, { target });
    flushSync();
}

describe("Settings Hotkey page", () => {
    it.each([390, 767])("shows the small-screen message at %i px", (width) => {
        render(width);
        expect(target.textContent).toContain(language.screenTooSmall);
        expect(target.querySelector("table")).toBeNull();
    });

    it.each([768, 1024])("shows one row per active hotkey at %i px", (width) => {
        render(width);
        const hotkeys = activeHotkeys(settings.hotkeys, settings.ui);
        expect(hotkeys.length).toBeGreaterThan(0);
        expect(target.textContent).not.toContain(language.screenTooSmall);
        expect(target.querySelectorAll("table")).toHaveLength(1);
        const rows = [...target.querySelectorAll("tbody tr")];
        expect(rows).toHaveLength(hotkeys.length);
        expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual(
            hotkeys.map((hotkey) => language.hotkeyDesc[hotkey.action]),
        );
    });
});
