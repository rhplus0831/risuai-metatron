// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Search plan slice 3b: the settings search in the real `Settings.svelte` shell with the Model,
// Connections, Prompt and Display pages real (the jump's consumers) and the other pages mocked. The
// field lists hits instead of the groups; Enter, a click and Escape are search-owned; the keyed page
// remounts per jump and its attachment scrolls, rings, or shows the unavailable note, then finishes.

vi.mock("./Pages/UserSettings.svelte", () => ({ default: () => {} }));
vi.mock("./Pages/ApiKeysSettings.svelte", () => ({ default: () => {} }));
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
vi.mock("./Pages/HotkeySettings.svelte", () => ({ default: () => {} }));
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
vi.mock("src/ts/parser/transformClient", () => ({ resetTransformEffects: vi.fn() }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn(), globalFetch: vi.fn() }));
vi.mock("src/ts/process/index.svelte", () => ({}));
vi.mock("src/ts/tokenizer", () => ({
    tokenizeAccurate: vi.fn(async () => 0),
    tokenizerList: [["tik", "Tiktoken"]],
}));
vi.mock("src/ts/process/prompt", () => ({ tokenizePreset: vi.fn(async () => 0) }));

import { get } from "svelte/store";
import { language } from "src/lang";
import { defaultColorScheme } from "../../../shared/colorScheme.ts";
import { normalizeModelPreset, normalizeModelProfile } from "../../../shared/presets.ts";
import { takeRequestedDisplayTab } from "src/ts/setting/displaySettingsData.svelte";
import { currentJump, finishJump, jumpVersion, SETTING_HIGHLIGHT_MS } from "src/ts/setting/settingJump.svelte";
import { selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import {
    MODEL_PROFILES_SETTINGS_MENU,
    MODEL_SETTINGS_MENU,
    PROMPT_SETTINGS_MENU,
    SettingsMenuIndex,
    settingsOpen,
} from "src/ts/stores.svelte";
import Settings from "./Settings.svelte";

const DISPLAY_MENU = 3;
const HOTKEY_MENU = 15;

let component: ReturnType<typeof mount> | null = null;
let target: HTMLDivElement;
let initialWidth: number;
let documentKeydown: ReturnType<typeof vi.fn<(event: KeyboardEvent) => void>>;

beforeEach(() => {
    vi.useFakeTimers();
    initialWidth = window.innerWidth;
    window.innerWidth = 1024;
    installFlatDatabase({
        characters: [],
        useLegacyGUI: false,
        // Display's colour scheme picker and the Prompt page's ban-character-set editor read these.
        customColorScheme: { ...defaultColorScheme },
        banCharacterset: [],
        botPresets: [{ id: "p1", name: "Prompt One", temperature: 80, maxResponse: 300 }],
        modelPresets: [
            normalizeModelPreset(
                { name: "Model One", mainSlot: { profileId: "echo" }, subSlot: { profileId: "echo" } },
                { id: "m1" },
            ),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "echo", name: "Echo", modelId: "echo_model", maxContext: 9000 }),
            normalizeModelProfile({ id: "spare", name: "Spare", modelId: "echo_model", maxContext: 5000 }),
        ],
    } as any);
    selectPreset("p1");
    selectModelPreset("m1");
    settingsOpen.set(true);
    // A mocked page: the shell mounts without any real page until a test jumps.
    SettingsMenuIndex.set(HOTKEY_MENU);
    target = document.createElement("div");
    document.body.append(target);
    documentKeydown = vi.fn();
    document.addEventListener("keydown", documentKeydown);
});

afterEach(async () => {
    document.removeEventListener("keydown", documentKeydown);
    if (component) await unmount(component);
    component = null;
    target.remove();
    finishJump(jumpVersion());
    takeRequestedDisplayTab();
    settingsOpen.set(false);
    SettingsMenuIndex.set(-1);
    window.innerWidth = initialWidth;
    vi.useRealTimers();
});

function render() {
    component = mount(Settings, { target });
    flushSync();
}

/** The jump's DOM step waits a tick, then its finish settles a microtask later. */
async function settle() {
    await tick();
    await tick();
    flushSync();
}

const input = () => target.querySelector<HTMLInputElement>("input[type=search]")!;
const page = () => target.querySelector<HTMLElement>(".rs-setting-cont-4");
const groups = () => target.querySelectorAll('[role="group"][aria-labelledby^="settings-nav-"]');
const ringed = () => [...target.querySelectorAll<HTMLElement>(".ring-2")];
const pressedTab = () =>
    [...(page()?.querySelectorAll<HTMLButtonElement>("button[aria-pressed=true]") ?? [])].map((button) =>
        button.textContent?.trim(),
    );
const expanded = (wrapper: Element | null) => wrapper?.querySelector("button")?.getAttribute("aria-expanded");

function search(text: string): HTMLButtonElement[] {
    input().value = text;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    return [
        ...target.querySelectorAll<HTMLButtonElement>(
            `[role="group"][aria-label="${language.settingsSearch.label}"] button`,
        ),
    ];
}

/** The hit whose label is `label` and whose breadcrumb holds every `crumbs` entry. */
function hit(hits: HTMLButtonElement[], label: string, ...crumbs: string[]): HTMLButtonElement {
    const found = hits.find((button) => {
        const [own, crumb] = [...button.querySelectorAll("span")].map((span) => span.textContent ?? "");
        return own === label && crumbs.every((part) => crumb?.includes(part));
    });
    expect(found, `a hit labelled ${label}`).toBeDefined();
    return found!;
}

function key(name: string, init: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    input().dispatchEvent(event);
    flushSync();
    return event;
}

describe("the settings search field", () => {
    it("lists the hits instead of the groups while the query is non-empty, and Escape clears the field itself", () => {
        render();
        expect(groups().length).toBeGreaterThan(0);

        const hits = search("retrys");
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].textContent).toContain("Request Retrys when Fail");
        expect(hits[0].textContent).toContain(language.settingsSectionModelAdvanced);
        expect(groups()).toHaveLength(0);

        expect(search("zzzz qqqq")).toHaveLength(0);
        expect(target.textContent).toContain(language.settingsSearch.empty);

        search("retrys");
        const escape = key("Escape");
        expect(escape.defaultPrevented).toBe(true);
        expect(documentKeydown).not.toHaveBeenCalled();
        expect(input().value).toBe("");
        expect(groups().length).toBeGreaterThan(0);
        expect(get(settingsOpen)).toBe(true);

        // An empty field leaves Escape to the shell's own handling.
        key("Escape");
        expect(documentKeydown).toHaveBeenCalledTimes(1);
    });

    it("opens the first hit on Enter without reaching a document listener, also with a modifier, and not during a composition", () => {
        render();
        const version = jumpVersion();
        search("retrys");

        key("Enter", { isComposing: true });
        key("Enter", { keyCode: 229 });
        expect(jumpVersion()).toBe(version);
        expect(get(SettingsMenuIndex)).toBe(HOTKEY_MENU);
        expect(documentKeydown).toHaveBeenCalledTimes(2);

        const enter = key("Enter");
        expect(enter.defaultPrevented).toBe(true);
        expect(documentKeydown).toHaveBeenCalledTimes(2);
        expect(jumpVersion()).toBe(version + 1);
        expect(get(SettingsMenuIndex)).toBe(MODEL_SETTINGS_MENU);

        key("Enter", { ctrlKey: true });
        expect(documentKeydown).toHaveBeenCalledTimes(2);
        expect(jumpVersion()).toBe(version + 2);
    });
});

describe("a search jump", () => {
    it("remounts the page with the section open and the row ringed, and finishing leaves both in place", async () => {
        render();
        search("retrys");
        key("Enter");
        const mounted = page()!;
        const section = mounted.querySelector('[data-settings-section="model.advanced"]');
        expect(expanded(section)).toBe("true");
        expect(expanded(mounted.querySelector('[data-settings-section="model.customModels"]'))).toBe("false");

        await settle();
        expect(currentJump()).toBeNull();
        const row = mounted.querySelector<HTMLElement>('[data-setting-id="adv.retries"] > .ring-2');
        expect(row).not.toBeNull();
        expect(ringed()).toEqual([row]);
        // No remount: the same page node, still open, still ringed.
        expect(page()).toBe(mounted);
        expect(expanded(section)).toBe("true");
        vi.advanceTimersByTime(SETTING_HIGHLIGHT_MS);
        expect(ringed()).toEqual([]);
        expect(page()).toBe(mounted);
    });

    it("opens a section hit on Display's tab, and a finished jump does not reopen the section on a tab round trip", async () => {
        render();
        hit(search("Custom CSS"), language.settingsSectionCustomCSS, language.display, language.theme).click();
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(DISPLAY_MENU);
        expect(pressedTab()).toEqual([language.theme]);
        const customCSS = () => page()!.querySelector('[data-settings-section="display.theme.customCSS"]');
        expect(expanded(customCSS())).toBe("true");

        await settle();
        expect(currentJump()).toBeNull();
        expect(ringed()).toEqual([customCSS()]);
        expect(expanded(customCSS())).toBe("true");

        const tabs = (label: string) =>
            [...page()!.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
                (button) => button.textContent?.trim() === label,
            )!;
        customCSS()!.querySelector("button")!.click();
        flushSync();
        expect(expanded(customCSS())).toBe("false");
        tabs(language.displayTabLayout).click();
        flushSync();
        expect(customCSS()).toBeNull();
        tabs(language.theme).click();
        flushSync();
        expect(expanded(customCSS())).toBe("false");
    });

    it("reaches another Display tab from the Display page shown, with the row ringed", async () => {
        render();
        hit(search(language.theme), language.theme, language.display, language.theme).click();
        flushSync();
        await settle();
        const first = page()!;
        expect(pressedTab()).toEqual([language.theme]);

        hit(search(language.UISize), language.UISize, language.display, language.displayTabLayout).click();
        flushSync();
        expect(page()).not.toBe(first);
        expect(pressedTab()).toEqual([language.displayTabLayout]);
        await settle();
        expect(ringed()).toEqual([page()!.querySelector('[data-setting-id="display.zoomsize"] > *')]);
    });

    it("shows the note for a hidden hit, rings nothing, opens no section, and a later navigation clears the note", async () => {
        render();
        const hidden = hit(search(language.chatHTML), language.chatHTML, language.display);
        expect(hidden.textContent).toContain(language.settingsSearch.hiddenHit);
        hidden.click();
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(DISPLAY_MENU);
        const note = page()!.querySelector('[role="status"]');
        expect(note?.textContent).toContain(language.settingsSearch.hiddenNote);
        expect(page()!.firstElementChild).toBe(note);
        await settle();
        expect(currentJump()).toBeNull();
        expect(ringed()).toEqual([]);
        expect(expanded(page()!.querySelector('[data-settings-section="display.theme.customCSS"]'))).toBe("false");

        input().value = "";
        input().dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        [...groups()[0].querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === language.model)!
            .click();
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(MODEL_SETTINGS_MENU);
        expect(page()!.querySelector('[role="status"]')).toBeNull();
    });

    it("opens the Prompt page on the hit's tab, every tab stacked in the legacy GUI", async () => {
        render();
        hit(search(language.additionalPrompt), language.additionalPrompt, language.prompt, language.others).click();
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(PROMPT_SETTINGS_MENU);
        const TAB_LABELS = [language.parameters, language.prompt, language.others];
        const tabButtons = (pressed: boolean) =>
            [...page()!.querySelectorAll<HTMLButtonElement>("button")]
                .filter((button) => TAB_LABELS.includes(button.textContent?.trim() ?? ""))
                .filter((button) => button.classList.contains("bg-darkbutton") === pressed)
                .map((button) => button.textContent?.trim());
        expect(tabButtons(true)).toEqual([language.others]);
        expect(tabButtons(false)).toEqual([language.parameters, language.prompt]);
        await settle();
        expect(ringed()).toEqual([page()!.querySelector('[data-setting-id="adv.addPrompt"] > *')]);
        vi.advanceTimersByTime(SETTING_HIGHLIGHT_MS);

        settings.ui.useLegacyGUI = true;
        hit(search(language.additionalPrompt), language.additionalPrompt, language.prompt, language.others).click();
        flushSync();
        expect(tabButtons(true)).toEqual([]);
        expect(tabButtons(false)).toEqual([]);
        await settle();
        expect(ringed()).toEqual([page()!.querySelector('[data-setting-id="adv.addPrompt"] > *')]);
    });

    it("selects the main slot's profile for a Connections hit and opens Chat Formatting; a dangling main slot shows the note", async () => {
        render();
        // Connections last showed the spare profile.
        SettingsMenuIndex.set(MODEL_PROFILES_SETTINGS_MENU);
        flushSync();
        page()!.querySelector<HTMLElement>("[data-profile-id=spare]")!.click();
        flushSync();
        expect(page()!.querySelector("[data-profile-id=spare]")?.getAttribute("aria-pressed")).toBe("true");

        const chatFormat = () =>
            [...page()!.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) =>
                button.textContent?.includes(language.chatFormating),
            )!;
        hit(search(language.chatFormating), language.chatFormating, language.modelProfiles.title).click();
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(MODEL_PROFILES_SETTINGS_MENU);
        expect(page()!.querySelector("[data-profile-id=echo]")?.getAttribute("aria-pressed")).toBe("true");
        expect(chatFormat().getAttribute("aria-expanded")).toBe("true");
        await settle();
        expect(ringed()).toEqual([page()!.querySelector('[data-setting-id="chatFormat.template"] > *')]);
        expect(page()!.querySelector('[role="status"]')).toBeNull();
        vi.advanceTimersByTime(SETTING_HIGHLIGHT_MS);

        page()!.querySelector<HTMLElement>("[data-profile-id=spare]")!.click();
        flushSync();
        settings.modelPresets[0].mainSlot = { profileId: "missing" };
        const dangling = hit(search(language.chatFormating), language.chatFormating, language.modelProfiles.title);
        expect(dangling.textContent).toContain(language.settingsSearch.noMainProfileHit);
        dangling.click();
        flushSync();
        expect(page()!.querySelector('[role="status"]')?.textContent).toContain(
            language.settingsSearch.noMainProfileNote,
        );
        expect(page()!.querySelector("[data-profile-id=spare]")?.getAttribute("aria-pressed")).toBe("true");
        expect(chatFormat().getAttribute("aria-expanded")).toBe("false");
        await settle();
        expect(ringed()).toEqual([]);
    });
});
