// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The seven declarative settings wrappers (`src/lib/Setting/Wrappers/`) over the production
// forwarding layer. Each binds its input with a function binding, so a user edit is written
// synchronously into the preset selected at that moment (`updateSettingValue`), `onChange` fires
// once per edit and never on a switch re-render, and a switch shows the other preset's value.
// `SettingNumber` also keeps a cleared input empty (the record holds `null`), and `SettingSelect`
// still writes its hidden-option fallback once. The wrappers get the real context (the settings
// record views), and `SettingSegmented` binds through the registry like the others;
// `SettingRenderer` builds that context and shows an item by its condition over the views. The
// fixture is installed into the records, and the presets are read back through `settings.presets`.
// The model-side fields (`useInstructPrompt`, `instructChatTemplate`, `forceReplaceUrl`, ...)
// belong to the selected model preset's main profile (`activeMainProfile`, the context's
// `modelProfile`): a write lands in that profile, and a model preset switch shows the other main
// profile's value.

vi.mock("../../globalApi.svelte", async () => (await import("../../tests/globalApiMock")).createGlobalApiMock());
vi.mock("../../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import { changeLanguage, language } from "src/lang";
import type { SettingContext, SettingItem } from "../../setting/types";
import type { Database } from "../database.svelte";
import { changeToModelPreset, changeToPreset } from "../presets.svelte";
import { llmSecretState, setMaskedSecrets } from "../llmSecrets.svelte";
import { maskLlmSecrets } from "../../../../shared/llmSecrets.ts";
import { applyRaw, recordData, setRecordWriteListener } from "../records.svelte";
import { pickBinding } from "../chatBindingPick";
import { chatBindingIds } from "../chatBinding.svelte";
import { selectChat } from "../chatStore.svelte";
import { selectCharacter, selection, selectModelPreset, selectPersona, selectPreset } from "../selection.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "./installFlatDatabase";
import { normalizeModelPresets, normalizeModelProfiles } from "../../../../shared/presets.ts";
import SettingCheck from "src/lib/Setting/Wrappers/SettingCheck.svelte";
import SettingColor from "src/lib/Setting/Wrappers/SettingColor.svelte";
import SettingNumber from "src/lib/Setting/Wrappers/SettingNumber.svelte";
import SettingSelect from "src/lib/Setting/Wrappers/SettingSelect.svelte";
import SettingSlider from "src/lib/Setting/Wrappers/SettingSlider.svelte";
import SettingText from "src/lib/Setting/Wrappers/SettingText.svelte";
import SettingTextarea from "src/lib/Setting/Wrappers/SettingTextarea.svelte";
import SettingSegmented from "src/lib/Setting/Wrappers/SettingSegmented.svelte";
import SettingRenderer from "src/lib/Setting/SettingRenderer.svelte";
import { activeMainProfile, activeModelPreset, activePersona, activePreset, settings } from "../settingsViews.svelte";
import { accessibilitySettingsItems } from "../../setting/accessibilitySettingsData";
import { displaySettingsItems } from "../../setting/displaySettingsData.svelte";
import { storageSettingsItems } from "../../setting/storageSettingsData";
import { interactionSettingsItems } from "../../setting/interactionSettingsData";
import { chatFormatSettingsItems } from "../../setting/chatFormatSettingsData";
import { modelSpecificParameterItems } from "../../setting/botSettingsParamsData";
import { LLMFlags } from "../../model/types";
import LanguageSettings from "src/lib/Setting/Pages/LanguageSettings.svelte";
import { langState } from "../../setting/languageSettingsData.svelte";

type Mounted = ReturnType<typeof mount>;

const mounted: Mounted[] = [];
const preset = (id: string) => (settings.presets as unknown as Record<string, any>[]).find((entry) => entry.id === id)!;
/** The model profile by id: `pa` is model preset `a`'s main profile, `pb` model preset `b`'s. */
const profile = (id: string) =>
    (settings.modelProfiles as unknown as Record<string, any>[]).find((entry) => entry.id === id)!;

/** The context `SettingRenderer` builds: the settings record views. */
function ctx(): SettingContext {
    return {
        settings,
        preset: activePreset,
        modelPreset: activeModelPreset,
        modelProfile: activeMainProfile,
        persona: activePersona,
        modelInfo: undefined,
        subModelInfo: undefined,
    } as unknown as SettingContext;
}

function item(overrides: Partial<SettingItem> & Pick<SettingItem, "type" | "bindKey">): SettingItem {
    return { id: `wrappers.${overrides.bindKey}`, fallbackLabel: overrides.bindKey!, onChange: vi.fn(), ...overrides };
}

function render(component: Parameters<typeof mount>[0], props: Record<string, unknown>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(component, { target, props });
    mounted.push(instance);
    flushSync();
    const query = <T extends Element>(selector: string) => {
        const element = target.querySelector<T>(selector);
        expect(element, `Expected ${selector} to be rendered`).not.toBeNull();
        return element as T;
    };
    return { target, query };
}

/** A user edit: the value changes and `input` fires; the effects are not flushed (the caller decides). */
function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * A user choosing an option. Svelte's `bind_select_value` resolves the chosen option with
 * `select.querySelector(":checked")`, which happy-dom never matches, so the query is answered from
 * `selectedIndex` for the duration of the `change` dispatch.
 */
function chooseOption(element: HTMLSelectElement, value: string) {
    element.value = value;
    const querySelector = element.querySelector.bind(element);
    (element as { querySelector: unknown }).querySelector = (selector: string) =>
        selector === ":checked" ? (element.options[element.selectedIndex] ?? null) : querySelector(selector);
    try {
        element.dispatchEvent(new Event("change", { bubbles: true }));
    } finally {
        delete (element as { querySelector?: unknown }).querySelector;
    }
}

function boot() {
    installFlatDatabase({
        characters: [],
        botPresets: [
            {
                id: "a",
                name: "A",
                temperature: 80,
                maxResponse: 500,
                mainPrompt: "main a",
                customPromptTemplateToggle: "#112233",
            },
            {
                id: "b",
                name: "B",
                temperature: 50,
                maxResponse: 555,
                mainPrompt: "main b",
                customPromptTemplateToggle: "#445566",
            },
        ],
        modelPresets: normalizeModelPresets([
            { id: "a", name: "A", mainSlot: { profileId: "pa" }, subSlot: { profileId: "pa" } },
            { id: "b", name: "B", mainSlot: { profileId: "pb" }, subSlot: { profileId: "pb" } },
        ]),
        modelProfiles: normalizeModelProfiles([
            {
                id: "pa",
                name: "PA",
                modelId: "model-a",
                useInstructPrompt: false,
                forceReplaceUrl: "https://a",
                instructChatTemplate: "chatml",
            },
            {
                id: "pb",
                name: "PB",
                modelId: "model-b",
                useInstructPrompt: true,
                forceReplaceUrl: "https://b",
                instructChatTemplate: "alpaca",
            },
        ]),
    } as unknown as Database);
}

beforeEach(() => {
    changeLanguage("en");
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectModelPreset("");
    // The write-only `llmSecrets` state (7b): an empty masked record and no queued credential write.
    llmSecretState.queue.splice(0);
    setMaskedSecrets(maskLlmSecrets({}));
    boot();
});

afterEach(async () => {
    const instances = mounted.splice(0);
    await Promise.all(instances.map((instance) => unmount(instance)));
    document.body.replaceChildren();
    changeLanguage("en");
    langState.changed = false;
});

describe("SettingNumber", () => {
    it("writes synchronously into the selected preset, fires onChange once, and follows a switch without onChange", () => {
        const number = item({ type: "number", bindKey: "maxResponse" });
        const { query } = render(SettingNumber, { item: number, ctx: ctx() });
        const input = query<HTMLInputElement>("input");
        expect(input.value).toBe("500");
        expect(number.onChange).not.toHaveBeenCalled();

        typeInto(input, "777");
        // Before any flush: the record already has the edit.
        expect(preset("a").maxResponse).toBe(777);
        expect(preset("b").maxResponse).toBe(555);
        expect(number.onChange).toHaveBeenCalledTimes(1);
        expect(number.onChange).toHaveBeenCalledWith(777, expect.anything());
        flushSync();
        expect(number.onChange).toHaveBeenCalledTimes(1);

        changeToPreset("b");
        flushSync();
        expect(input.value).toBe("555");
        expect(number.onChange).toHaveBeenCalledTimes(1);

        // An edit and a switch in the same flush: the edit stays with the preset it was made on.
        typeInto(input, "600");
        changeToPreset("a");
        flushSync();
        expect(preset("b").maxResponse).toBe(600);
        expect(preset("a").maxResponse).toBe(777);
        expect(input.value).toBe("777");
        expect(number.onChange).toHaveBeenCalledTimes(2);
    });

    it("keeps a cleared input empty (the record holds null) until a value is typed again", () => {
        const number = item({ type: "number", bindKey: "maxResponse" });
        const { query } = render(SettingNumber, { item: number, ctx: ctx() });
        const input = query<HTMLInputElement>("input");

        typeInto(input, "");
        flushSync();
        expect(preset("a").maxResponse).toBeNull();
        expect(activePreset.maxResponse).toBeNull();
        expect(input.value).toBe("");
        expect(number.onChange).toHaveBeenCalledTimes(1);
        expect(number.onChange).toHaveBeenCalledWith(null, expect.anything());

        typeInto(input, "64");
        flushSync();
        expect(preset("a").maxResponse).toBe(64);
        expect(input.value).toBe("64");
        expect(preset("b").maxResponse).toBe(555);
    });

    it.each([
        ["900", 600],
        ["5", 10],
        ["90", 90],
        ["90.7", 90],
    ] as const)("commits %s as a displayed and stored plugin wait limit of %i", (typed, expected) => {
        const item = displaySettingsItems.find(({ id }) => id === "display.completionWaitMaxSeconds")!;
        const { query } = render(SettingNumber, { item, ctx: ctx() });
        const input = query<HTMLInputElement>("input");

        input.focus();
        typeInto(input, typed);
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        flushSync();

        const stored = recordData<Pick<Database, "completionWaitMaxSeconds">>("ui")?.completionWaitMaxSeconds;
        expect({ shown: input.valueAsNumber, stored }).toEqual({
            shown: expected,
            stored: expected,
        });
    });

    it.each([
        ["7.5", 7],
        ["0.5", 1],
        ["14", 14],
    ] as const)("commits %s as a displayed and stored chat trash retention of %i whole days", (typed, expected) => {
        // The server keeps whole days, so the field must not show a fraction it will not honor.
        const item = storageSettingsItems.find(({ id }) => id === "storage.chatTrashDays")!;
        const { query } = render(SettingNumber, { item, ctx: ctx() });
        const input = query<HTMLInputElement>("input");

        input.focus();
        typeInto(input, typed);
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        flushSync();

        const stored = recordData<Pick<Database, "chatTrashDays">>("ui")?.chatTrashDays;
        expect({ shown: input.valueAsNumber, stored }).toEqual({ shown: expected, stored: expected });
    });

    it("keeps the plugin wait limit while the input is empty and commits the default on change", () => {
        applyRaw("ui", { completionWaitMaxSeconds: 90 });
        const item = displaySettingsItems.find(({ id }) => id === "display.completionWaitMaxSeconds")!;
        const { query } = render(SettingNumber, { item, ctx: ctx() });
        const input = query<HTMLInputElement>("input");

        expect(input.value).toBe("90");
        input.focus();
        typeInto(input, "");
        expect(settings.ui.completionWaitMaxSeconds).toBe(90);
        flushSync();
        expect(input.value).toBe("");

        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        flushSync();

        const stored = recordData<Pick<Database, "completionWaitMaxSeconds">>("ui")?.completionWaitMaxSeconds;
        expect({ shown: input.valueAsNumber, limit: settings.ui.completionWaitMaxSeconds, stored }).toEqual({
            shown: 180,
            limit: 180,
            stored: 180,
        });
    });
});

describe("SettingSlider", () => {
    it("writes a keyboard step synchronously into the selected preset and follows a switch", () => {
        const slider = item({ type: "slider", bindKey: "temperature", options: { min: 0, max: 200, step: 1 } });
        const { query } = render(SettingSlider, { item: slider, ctx: ctx() });
        const handle = query<HTMLDivElement>("[role=slider]");
        expect(handle.getAttribute("aria-valuenow")).toBe("80");

        handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(preset("a").temperature).toBe(81);
        expect(preset("b").temperature).toBe(50);
        expect(slider.onChange).toHaveBeenCalledTimes(1);
        expect(slider.onChange).toHaveBeenCalledWith(81, expect.anything());
        flushSync();
        expect(handle.getAttribute("aria-valuenow")).toBe("81");

        changeToPreset("b");
        flushSync();
        expect(handle.getAttribute("aria-valuenow")).toBe("50");
        expect(slider.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingCheck", () => {
    it("leaves an optional checkbox absent on mount and persists and notifies once per click", () => {
        applyRaw("ui", {});
        const writes = vi.fn();
        setRecordWriteListener(writes);
        try {
            const check = item({ type: "check", bindKey: "alwaysScrollToNewMessage" });
            const { query } = render(SettingCheck, { item: check, ctx: ctx() });
            const box = query<HTMLInputElement>("input[type=checkbox]");
            expect(box.checked).toBe(false);
            expect(recordData("ui")).not.toHaveProperty("alwaysScrollToNewMessage");
            expect(writes).not.toHaveBeenCalled();
            expect(check.onChange).not.toHaveBeenCalled();

            for (const [index, expected] of [true, false].entries()) {
                box.click();
                flushSync();
                expect(recordData("ui")).toHaveProperty("alwaysScrollToNewMessage", expected);
                expect(box.checked).toBe(expected);
                expect(writes).toHaveBeenCalledTimes(index + 1);
                expect(check.onChange).toHaveBeenCalledTimes(index + 1);
                expect(check.onChange).toHaveBeenLastCalledWith(expected, expect.anything());
            }
        } finally {
            setRecordWriteListener(null);
        }
    });

    it("writes a toggle synchronously into the selected model preset's main profile and follows a switch", () => {
        const check = item({ type: "check", bindKey: "useInstructPrompt" });
        const { query } = render(SettingCheck, { item: check, ctx: ctx() });
        const box = query<HTMLInputElement>("input[type=checkbox]");
        expect(box.checked).toBe(false);

        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        expect(profile("pa").useInstructPrompt).toBe(true);
        expect(profile("pb").useInstructPrompt).toBe(true);
        expect(check.onChange).toHaveBeenCalledTimes(1);
        expect(check.onChange).toHaveBeenCalledWith(true, expect.anything());

        // The same value again is not a write: onChange stays at one.
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        expect(check.onChange).toHaveBeenCalledTimes(1);

        profile("pb").useInstructPrompt = false;
        changeToModelPreset("b");
        flushSync();
        expect(box.checked).toBe(false);
        expect(check.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingText", () => {
    it("writes each keystroke synchronously into the selected model preset's main profile and follows a switch", () => {
        // `aiModel` is a derived root now (a write must name exactly one profile), so the free
        // text goes to a profile field served at root.
        const text = item({ type: "text", bindKey: "forceReplaceUrl" });
        const { query } = render(SettingText, { item: text, ctx: ctx() });
        const input = query<HTMLInputElement>("input");
        expect(input.value).toBe("https://a");

        typeInto(input, "https://a2");
        expect(profile("pa").forceReplaceUrl).toBe("https://a2");
        expect(profile("pb").forceReplaceUrl).toBe("https://b");
        expect(text.onChange).toHaveBeenCalledTimes(1);

        typeInto(input, "https://a3");
        changeToModelPreset("b");
        flushSync();
        expect(profile("pa").forceReplaceUrl).toBe("https://a3");
        expect(input.value).toBe("https://b");
        expect(text.onChange).toHaveBeenCalledTimes(2);
    });
});

describe("SettingTextarea", () => {
    it("writes synchronously into the selected preset and follows a switch", () => {
        const area = item({ type: "textarea", bindKey: "mainPrompt" });
        const { query } = render(SettingTextarea, { item: area, ctx: ctx() });
        const textarea = query<HTMLTextAreaElement>("textarea");
        expect(textarea.value).toBe("main a");

        typeInto(textarea, "main a edited");
        expect(preset("a").mainPrompt).toBe("main a edited");
        expect(preset("b").mainPrompt).toBe("main b");
        expect(area.onChange).toHaveBeenCalledTimes(1);

        changeToPreset("b");
        flushSync();
        expect(textarea.value).toBe("main b");
        expect(area.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingSelect", () => {
    it("offers Spanish in the real language page and applies its bundled locale when selected", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            settings.ui.language = "en";
            const { query } = render(LanguageSettings, {});
            const select = query<HTMLSelectElement>("select");
            expect([...select.options].find((option) => option.value === "es")?.textContent.trim()).toBe("Español");
            chooseOption(select, "es");
            await vi.advanceTimersByTimeAsync(10);
            expect(settings.ui.language).toBe("es");
            expect(select.value).toBe("es");
            expect(language.settings).toBe("Configuración");
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it("retains a saved Spanish language when the real language page mounts", () => {
        settings.ui.language = "es";
        changeLanguage("es");
        const { query } = render(LanguageSettings, {});
        expect(query<HTMLSelectElement>("select").value).toBe("es");
        expect(settings.ui.language).toBe("es");
        expect(language.settings).toBe("Configuración");
        expect(langState.changed).toBe(false);
    });

    it("resolves all six message-button style labels in the language selected after the data import", () => {
        const style = accessibilitySettingsItems.find((entry) => entry.id === "acc.newMessageButtonStyle")!;
        settings.ui.newMessageButtonStyle = "bottom-center";
        const english = render(SettingSelect, { item: style, ctx: ctx() });
        expect(english.query<HTMLSelectElement>("select").options[0].textContent.trim()).toBe(
            "Bottom Center (Default)",
        );
        changeLanguage("ko");
        const reopened = render(SettingSelect, { item: style, ctx: ctx() });
        expect(
            [...reopened.query<HTMLSelectElement>("select").options].map((option) => [
                option.value,
                option.textContent.trim(),
            ]),
        ).toEqual([
            ["bottom-center", "하단 중앙 (기본값)"],
            ["bottom-right", "하단 우측"],
            ["bottom-left", "하단 좌측"],
            ["floating-circle", "원형 플로팅 버튼 (우측 하단)"],
            ["right-center", "우측 중앙"],
            ["top-bar", "상단 바"],
        ]);
    });

    const options = {
        selectOptions: [
            { value: "chatml", label: "ChatML" },
            { value: "alpaca", label: "Alpaca" },
            { value: "vicuna", label: "Vicuna" },
        ],
    };

    it("preserves a hidden stored value on an equal-options context rebuild and resets to the last option when options change", () => {
        profile("pb").instructChatTemplate = "hidden";
        const context = ctx();
        Object.defineProperty(context, "modelInfo", {
            get: () => {
                void activePreset.name;
                return { flags: activePreset.maxResponse < 1000 ? [LLMFlags.claudeThinking] : [] };
            },
        });
        const select = item({
            type: "select",
            bindKey: "instructChatTemplate",
            options: {
                selectOptions: [
                    { value: "chatml", label: "ChatML" },
                    {
                        value: "alpaca",
                        label: "Alpaca",
                        condition: (context) => context.modelInfo.flags.includes(LLMFlags.claudeThinking),
                    },
                    { value: "vicuna", label: "Vicuna" },
                ],
            },
        });
        const { query } = render(SettingSelect, { item: select, ctx: context });
        const element = query<HTMLSelectElement>("select");
        const visible = () => [...element.options].map((option) => option.value);
        expect(visible()).toEqual(["chatml", "alpaca", "vicuna"]);

        changeToModelPreset("b");
        changeToPreset("b");
        flushSync();
        expect(visible()).toEqual(["chatml", "alpaca", "vicuna"]);
        expect(profile("pb").instructChatTemplate).toBe("hidden");
        expect(profile("pa").instructChatTemplate).toBe("chatml");
        expect(select.onChange).not.toHaveBeenCalled();

        chooseOption(element, "alpaca");
        flushSync();
        expect(profile("pb").instructChatTemplate).toBe("alpaca");
        preset("b").maxResponse = 1000;
        flushSync();
        expect(visible()).toEqual(["chatml", "vicuna"]);
        expect(profile("pb").instructChatTemplate).toBe("vicuna");
        expect(profile("pa").instructChatTemplate).toBe("chatml");
        expect(select.onChange).toHaveBeenCalledTimes(2);
    });

    it("writes a choice synchronously into the selected model preset's main profile and follows a switch", () => {
        const select = item({ type: "select", bindKey: "instructChatTemplate", options });
        const { query } = render(SettingSelect, { item: select, ctx: ctx() });
        const element = query<HTMLSelectElement>("select");
        expect(element.value).toBe("chatml");
        expect(select.onChange).not.toHaveBeenCalled();

        chooseOption(element, "vicuna");
        expect(profile("pa").instructChatTemplate).toBe("vicuna");
        expect(profile("pb").instructChatTemplate).toBe("alpaca");
        expect(select.onChange).toHaveBeenCalledTimes(1);
        expect(select.onChange).toHaveBeenCalledWith("vicuna", expect.anything());

        changeToModelPreset("b");
        flushSync();
        expect(element.value).toBe("alpaca");
        expect(select.onChange).toHaveBeenCalledTimes(1);
    });

    it("writes the hidden-option fallback once into the selected model preset's main profile", () => {
        profile("pa").instructChatTemplate = "gone";
        const select = item({ type: "select", bindKey: "instructChatTemplate", options });
        render(SettingSelect, { item: select, ctx: ctx() });
        flushSync();
        expect(profile("pa").instructChatTemplate).toBe("vicuna");
        expect(profile("pb").instructChatTemplate).toBe("alpaca");
        expect(select.onChange).toHaveBeenCalledTimes(1);
        flushSync();
        expect(select.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingColor", () => {
    it("shows the selected preset's color, writes a typed hex synchronously, and follows a switch", () => {
        const color = item({ type: "color", bindKey: "customPromptTemplateToggle" });
        const { query } = render(SettingColor, { item: color, ctx: ctx() });
        const swatch = () => query<HTMLDivElement>("label div[style]").getAttribute("style");
        expect(swatch()).toContain("#112233");
        expect(color.onChange).not.toHaveBeenCalled();

        const hex = query<HTMLInputElement>('input[aria-label="hex color"]');
        typeInto(hex, "#778899");
        flushSync();
        expect(preset("a").customPromptTemplateToggle).toBe("#778899");
        expect(preset("b").customPromptTemplateToggle).toBe("#445566");
        expect(color.onChange).toHaveBeenCalledTimes(1);

        changeToPreset("b");
        flushSync();
        expect(swatch()).toContain("#445566");
        expect(color.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingSegmented", () => {
    const options = {
        segmentOptions: [
            { value: "chatml", label: "ChatML" },
            { value: "alpaca", label: "Alpaca" },
            { value: "vicuna", label: "Vicuna" },
        ],
    };
    const segment = (target: HTMLElement, label: string) =>
        [...target.querySelectorAll<HTMLButtonElement>("[data-segment-btn]")].find(
            (button) => button.textContent?.trim() === label,
        )!;
    const active = (target: HTMLElement) =>
        target.querySelector<HTMLButtonElement>(".segmented-btn-active")?.textContent?.trim();

    it("writes a choice synchronously into the selected model preset's main profile through the registry, fires onChange once, and follows a switch", () => {
        const segmented = item({ type: "segmented", bindKey: "instructChatTemplate", options });
        const { target } = render(SettingSegmented, { item: segmented, ctx: ctx() });
        expect(active(target)).toBe("ChatML");
        expect(segmented.onChange).not.toHaveBeenCalled();

        segment(target, "Vicuna").click();
        expect(profile("pa").instructChatTemplate).toBe("vicuna");
        expect(profile("pb").instructChatTemplate).toBe("alpaca");
        expect(segmented.onChange).toHaveBeenCalledTimes(1);
        expect(segmented.onChange).toHaveBeenCalledWith("vicuna", expect.anything());
        flushSync();
        expect(active(target)).toBe("Vicuna");

        // The value already there is not a write.
        segment(target, "Vicuna").click();
        expect(segmented.onChange).toHaveBeenCalledTimes(1);

        changeToModelPreset("b");
        flushSync();
        expect(active(target)).toBe("Alpaca");
        expect(segmented.onChange).toHaveBeenCalledTimes(1);

        // An edit and a switch in the same flush: the edit stays with the preset it was made on.
        segment(target, "ChatML").click();
        changeToModelPreset("a");
        flushSync();
        expect(profile("pb").instructChatTemplate).toBe("chatml");
        expect(profile("pa").instructChatTemplate).toBe("vicuna");
        expect(active(target)).toBe("Vicuna");
        expect(segmented.onChange).toHaveBeenCalledTimes(2);
    });

    it("binds a custom getter and setter, not only a bindKey", () => {
        let stored = "alpaca";
        const setValue = vi.fn((value: string) => (stored = value));
        const segmented: SettingItem = {
            id: "wrappers.segmented.custom",
            type: "segmented",
            fallbackLabel: "custom",
            options,
            getValue: () => stored,
            setValue,
            onChange: vi.fn(),
        };
        const { target } = render(SettingSegmented, { item: segmented, ctx: ctx() });
        expect(active(target)).toBe("Alpaca");
        segment(target, "Vicuna").click();
        expect(setValue).toHaveBeenCalledTimes(1);
        expect(setValue).toHaveBeenCalledWith("vicuna", expect.anything());
        expect(stored).toBe("vicuna");
        expect(segmented.onChange).toHaveBeenCalledTimes(1);
        // The preset was not touched: the item has no binding of its own.
        expect(profile("pa").instructChatTemplate).toBe("chatml");
    });

    it("writes the hidden-option fallback into the selected model preset's main profile", () => {
        profile("pa").instructChatTemplate = "gone";
        const segmented = item({ type: "segmented", bindKey: "instructChatTemplate", options });
        render(SettingSegmented, { item: segmented, ctx: ctx() });
        flushSync();
        expect(profile("pa").instructChatTemplate).toBe("vicuna");
        expect(profile("pb").instructChatTemplate).toBe("alpaca");
        expect(segmented.onChange).toHaveBeenCalledTimes(1);
    });

    // A switch to a preset holding a hidden option leaves its value. The model info is rebuilt on
    // every switch, as `SettingRenderer`'s context is when a chat's prompt binding changes: equal
    // visible options do not run the reset again.
    it("leaves a hidden value in a newly selected preset, also when the switch rebuilds equal options", () => {
        const thinking = modelSpecificParameterItems.find((entry) => entry.id === "params.thinkingType")!;
        // A budget-only model: `adaptive` has no segment and does not resolve to a visible one.
        preset("a").thinkingType = "budget";
        preset("b").thinkingType = "adaptive";
        const context = ctx();
        let rebuilt = 0;
        Object.defineProperty(context, "modelInfo", {
            get: () => {
                void activePreset.name;
                rebuilt += 1;
                return { flags: [LLMFlags.claudeThinking], parameters: [] };
            },
        });
        const { target } = render(SettingSegmented, { item: thinking, ctx: context });
        expect(active(target)).toBe("Budget (Manual Tokens)");
        expect(segment(target, "Adaptive")).toBeUndefined();
        const before = rebuilt;

        changeToPreset("b");
        flushSync();
        expect(rebuilt).toBeGreaterThan(before);
        expect(preset("b").thinkingType).toBe("adaptive");
        expect(preset("a").thinkingType).toBe("budget");
        expect(active(target)).toBeUndefined();

        changeToPreset("a");
        flushSync();
        expect(active(target)).toBe("Budget (Manual Tokens)");
        expect(preset("b").thinkingType).toBe("adaptive");
    });

    // The new-chat binding choice shows anything but `empty` as inherit, as `initialChatBinding`
    // reads it, so an unset or unexpected `ui` value is not rewritten by the hidden-option fallback
    // when the page opens; a choice writes the `ui` record.
    it("acc.newChatBinding shows an unset or unexpected value as inherit without a write, and writes a choice into the ui record", () => {
        const segmented = interactionSettingsItems.find((entry) => entry.id === "acc.newChatBinding")!;
        // The fixture has no `ui` record until a write creates it.
        const ui = () => recordData<Record<string, unknown>>("ui") ?? {};
        expect(settings.ui.newChatBinding).toBeUndefined();
        const { target } = render(SettingSegmented, { item: segmented, ctx: ctx() });
        flushSync();
        expect(target.textContent).toContain(language.newChatBinding);
        expect(active(target)).toBe(language.newChatBindingInherit);
        expect(ui().newChatBinding).toBeUndefined();

        (settings.ui as Record<string, unknown>).newChatBinding = "weird";
        flushSync();
        expect(active(target)).toBe(language.newChatBindingInherit);
        expect(ui().newChatBinding).toBe("weird");
        // The option shown is not a write.
        segment(target, language.newChatBindingInherit).click();
        expect(ui().newChatBinding).toBe("weird");

        segment(target, language.newChatBindingEmpty).click();
        expect(ui().newChatBinding).toBe("empty");
        expect(settings.ui.newChatBinding).toBe("empty");
        flushSync();
        expect(active(target)).toBe(language.newChatBindingEmpty);

        segment(target, language.newChatBindingInherit).click();
        expect(ui().newChatBinding).toBe("inherit");
        flushSync();
        expect(active(target)).toBe(language.newChatBindingInherit);
    });
});

it("omits wrapper-owned row and field margins while preserving item classes", () => {
    const wrappers = [
        [SettingCheck, item({ type: "check", bindKey: "useInstructPrompt" }), "mt-2"],
        [SettingColor, item({ type: "color", bindKey: "customPromptTemplateToggle" }), "mt-2"],
        [SettingSelect, item({ type: "select", bindKey: "instructChatTemplate" }), "mt-4"],
        [SettingNumber, item({ type: "number", bindKey: "maxResponse" }), "mb-4"],
        [SettingSlider, item({ type: "slider", bindKey: "temperature", options: { min: 0, max: 200 } }), "mb-4"],
        [SettingText, item({ type: "text", bindKey: "forceReplaceUrl" }), "mb-4"],
        [SettingSegmented, item({ type: "segmented", bindKey: "instructChatTemplate" }), "segmented-margin"],
    ] as const;
    const classes = "!mt-1 pl-3";

    for (const [wrapper, setting, defaultMargin] of wrappers) {
        const { target } = render(wrapper, { item: setting, ctx: ctx() });
        const wrapperClasses = [...target.children].flatMap((child) => [...child.classList]);
        expect.soft(wrapperClasses, setting.type).not.toContain(defaultMargin);

        const customized = render(wrapper, { item: { ...setting, classes }, ctx: ctx() });
        expect
            .soft([...customized.target.firstElementChild!.classList], setting.type)
            .toEqual(expect.arrayContaining(classes.split(" ")));
    }
});

describe("SettingRenderer", () => {
    const byId = (items: SettingItem[], id: string) => items.find((entry) => entry.id === id)!;

    it("labels every item anchor with its spacing kind, inside an accordion too", () => {
        const { query } = render(SettingRenderer, {
            items: [
                item({ type: "check", bindKey: "useInstructPrompt", id: "check" }),
                {
                    id: "accordion",
                    type: "accordion",
                    fallbackLabel: "More settings",
                    options: { children: [item({ type: "number", bindKey: "maxResponse", id: "number" })] },
                },
            ],
        });

        query<HTMLButtonElement>('[data-setting-id="accordion"] button[aria-expanded="false"]').click();
        flushSync();

        expect({
            check: query('[data-setting-id="check"]').getAttribute("data-spacing-kind"),
            accordion: query('[data-setting-id="accordion"]').getAttribute("data-spacing-kind"),
            number: query('[data-setting-id="accordion"] [data-setting-id="number"]').getAttribute("data-spacing-kind"),
        }).toEqual({ check: "row", accordion: "block", number: "field" });
    });

    it("shows a stored budget as Adaptive on adaptive-only models and as Budget on budget-capable models without rewriting the preset", () => {
        preset("a").thinkingType = "budget";
        preset("a").thinkingTokens = 4096;
        preset("a").adaptiveThinkingEffort = "medium";
        profile("pa").modelId = "claude-opus-4-8";
        const { target, query } = render(SettingRenderer, {
            items: [
                byId(modelSpecificParameterItems, "params.thinkingType"),
                byId(modelSpecificParameterItems, "params.thinkingTokens"),
                byId(modelSpecificParameterItems, "params.adaptiveThinkingEffort"),
            ],
        });
        const activeMode = () =>
            query('[data-setting-id="params.thinkingType"] .segmented-btn-active').textContent?.trim();

        expect(activeMode()).toBe("Adaptive");
        expect(
            query('[data-setting-id="params.adaptiveThinkingEffort"] .segmented-btn-active').textContent?.trim(),
        ).toBe("Medium");
        expect(target.querySelector('[data-setting-id="params.thinkingTokens"]')).toBeNull();
        expect(preset("a").thinkingType).toBe("budget");

        profile("pa").modelId = "claude-opus-4-6";
        flushSync();
        expect(activeMode()).toBe("Budget (Manual Tokens)");
        expect(query('[data-setting-id="params.thinkingTokens"] [role=slider]').getAttribute("aria-valuenow")).toBe(
            "4096",
        );
        expect(target.querySelector('[data-setting-id="params.adaptiveThinkingEffort"]')).toBeNull();
        expect(preset("a").thinkingType).toBe("budget");
    });

    it("shows an item by its condition over the section views and the selected model preset's main profile, and its wrapper writes the record", () => {
        const always = byId(accessibilitySettingsItems, "acc.alwaysScrollToNewMessage");
        const jinja = byId(chatFormatSettingsItems, "chatFormat.jinjaTemplate");
        profile("pb").instructChatTemplate = "jinja";
        const { target } = render(SettingRenderer, { items: [always, jinja] });
        const checkbox = () => target.querySelector<HTMLInputElement>("input[type=checkbox]");
        const textarea = () => target.querySelector<HTMLTextAreaElement>("textarea");
        expect(checkbox()).toBeNull();
        expect(textarea()).toBeNull();

        settings.ui.autoScrollToNewMessage = true;
        flushSync();
        expect(checkbox()).not.toBeNull();
        checkbox()!.checked = true;
        checkbox()!.dispatchEvent(new Event("change", { bubbles: true }));
        expect(recordData<Record<string, unknown>>("ui")!.alwaysScrollToNewMessage).toBe(true);
        expect(settings.ui.alwaysScrollToNewMessage).toBe(true);

        changeToModelPreset("b");
        flushSync();
        expect(textarea()).not.toBeNull();
        typeInto(textarea()!, "{{ messages }}");
        expect(profile("pb").JinjaTemplate).toBe("{{ messages }}");
        expect(profile("pa").JinjaTemplate).not.toBe("{{ messages }}");

        changeToModelPreset("a");
        flushSync();
        expect(textarea()).toBeNull();
    });
});

describe("the settings registry with a bound chat open", () => {
    afterEach(() => selectCharacter(null));

    it("null-target picks move the tab selection and the rendered registry reads and writes it without changing the bound records", () => {
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chats: [
                        {
                            id: "chat",
                            name: "Chat",
                            message: [],
                            localLore: [],
                            promptPresetId: "a",
                            modelPresetId: "a",
                            bindedPersona: "u1",
                        },
                    ],
                },
            ],
            botPresets: JSON.parse(JSON.stringify(settings.presets)),
            modelPresets: JSON.parse(JSON.stringify(settings.modelPresets)),
            modelProfiles: JSON.parse(JSON.stringify(settings.modelProfiles)),
            personas: [
                { id: "u1", name: "Bound persona" },
                { id: "u2", name: "Tab persona" },
            ],
        });
        selectPreset("a");
        selectModelPreset("a");
        selectPersona("u1");
        selectCharacter("c");
        selectChat("c", "chat");
        const ref = { chaId: "c", chatId: "chat" };
        const bindingBefore = chatBindingIds(ref);
        const boundBefore = JSON.stringify([
            preset("a"),
            settings.modelPresets[0],
            profile("pa"),
            settings.personas[0],
        ]);
        const items = [
            item({ type: "number", bindKey: "maxResponse" }),
            item({ type: "text", bindKey: "forceReplaceUrl" }),
            item({ type: "text", bindKey: "username" }),
        ];
        const { query } = render(SettingRenderer, { items });
        const input = (key: string) => query<HTMLInputElement>(`[data-setting-id="wrappers.${key}"] input`);
        expect([input("maxResponse").value, input("forceReplaceUrl").value, input("username").value]).toEqual([
            "500",
            "https://a",
            "Bound persona",
        ]);
        expect(pickBinding("promptPresetId", "b", null)).toBe(true);
        expect(pickBinding("modelPresetId", "b", null)).toBe(true);
        expect(pickBinding("personaId", "u2", null)).toBe(true);
        flushSync();
        expect([selection.presetId, selection.modelPresetId, selection.personaId]).toEqual(["b", "b", "u2"]);
        expect(chatBindingIds(ref)).toEqual(bindingBefore);
        expect([input("maxResponse").value, input("forceReplaceUrl").value, input("username").value]).toEqual([
            "555",
            "https://b",
            "Tab persona",
        ]);
        typeInto(input("maxResponse"), "777");
        typeInto(input("forceReplaceUrl"), "https://tab-edited");
        typeInto(input("username"), "Tab renamed");
        flushSync();
        expect(preset("b").maxResponse).toBe(777);
        expect(profile("pb").forceReplaceUrl).toBe("https://tab-edited");
        expect(settings.personas[1].name).toBe("Tab renamed");
        expect(JSON.stringify([preset("a"), settings.modelPresets[0], profile("pa"), settings.personas[0]])).toBe(
            boundBefore,
        );
        expect(chatBindingIds(ref)).toEqual(bindingBefore);
    });
});
