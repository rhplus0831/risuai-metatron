// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 5: the seven declarative settings wrappers (`src/lib/Setting/Wrappers/`) over the
// production forwarding layer. Each binds its input with a function binding, so a user edit is
// written synchronously into the preset selected at that moment (`updateSettingValue`), `onChange`
// fires once per edit and never on a switch re-render (plan amendment A16), and a switch shows the
// other preset's value. `SettingNumber` also keeps a cleared input empty (the record holds `null`;
// Astra challenge point 3), and `SettingSelect` still writes its hidden-option fallback once.
// Since Phase 6 slice 6 the wrappers get the real context (the settings record views), and
// `SettingSegmented` binds through the registry like the others (it bound the aggregate's field);
// `SettingRenderer` builds that context and shows an item by its condition over the views. The
// fixture is installed into the records (slice 10: no aggregate), and the presets are read back
// through `settings.presets`.

vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
    alertMd: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import type { SettingContext, SettingItem } from "../../setting/types";
import type { Database } from "../database.svelte";
import { changeToModelPreset, changeToPreset } from "../presets.svelte";
import { llmSecretState, setMaskedSecrets } from "../llmSecrets.svelte";
import { maskLlmSecrets } from "../../../../shared/llmSecrets.ts";
import { recordData } from "../records.svelte";
import { selectModelPreset, selectPreset } from "../selection.svelte";
import { installFlatDatabase } from "./installFlatDatabase";
import SettingCheck from "src/lib/Setting/Wrappers/SettingCheck.svelte";
import SettingColor from "src/lib/Setting/Wrappers/SettingColor.svelte";
import SettingNumber from "src/lib/Setting/Wrappers/SettingNumber.svelte";
import SettingSelect from "src/lib/Setting/Wrappers/SettingSelect.svelte";
import SettingSlider from "src/lib/Setting/Wrappers/SettingSlider.svelte";
import SettingText from "src/lib/Setting/Wrappers/SettingText.svelte";
import SettingTextarea from "src/lib/Setting/Wrappers/SettingTextarea.svelte";
import SettingSegmented from "src/lib/Setting/Wrappers/SettingSegmented.svelte";
import SettingRenderer from "src/lib/Setting/SettingRenderer.svelte";
import { activeModelPreset, activePersona, activePreset, settings } from "../settingsViews.svelte";
import { accessibilitySettingsItems } from "../../setting/accessibilitySettingsData";
import { chatFormatSettingsItems } from "../../setting/chatFormatSettingsData";

type Mounted = ReturnType<typeof mount>;

const mounted: Mounted[] = [];
const preset = (id: string) => (settings.presets as unknown as Record<string, any>[]).find((entry) => entry.id === id)!;
/** The model preset of the same id (`installFlatDatabase` splits the fixture's model fields off). */
const modelPreset = (id: string) =>
    (settings.modelPresets as unknown as Record<string, any>[]).find((entry) => entry.id === id)!;

/** The context `SettingRenderer` builds: the settings record views (Phase 6 slice 6). */
function ctx(): SettingContext {
    return {
        settings,
        preset: activePreset,
        modelPreset: activeModelPreset,
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
                useInstructPrompt: false,
                aiModel: "model-a",
                mainPrompt: "main a",
                instructChatTemplate: "chatml",
                customPromptTemplateToggle: "#112233",
            },
            {
                id: "b",
                name: "B",
                temperature: 50,
                maxResponse: 555,
                useInstructPrompt: true,
                aiModel: "model-b",
                mainPrompt: "main b",
                instructChatTemplate: "alpaca",
                customPromptTemplateToggle: "#445566",
            },
        ],
    } as unknown as Database);
}

beforeEach(() => {
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
    it("writes a toggle synchronously into the selected model preset and follows a switch", () => {
        const check = item({ type: "check", bindKey: "useInstructPrompt" });
        const { query } = render(SettingCheck, { item: check, ctx: ctx() });
        const box = query<HTMLInputElement>("input[type=checkbox]");
        expect(box.checked).toBe(false);

        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        expect(modelPreset("a").useInstructPrompt).toBe(true);
        expect(modelPreset("b").useInstructPrompt).toBe(true);
        expect(check.onChange).toHaveBeenCalledTimes(1);
        expect(check.onChange).toHaveBeenCalledWith(true, expect.anything());

        // The same value again is not a write: onChange stays at one.
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        expect(check.onChange).toHaveBeenCalledTimes(1);

        modelPreset("b").useInstructPrompt = false;
        changeToModelPreset("b");
        flushSync();
        expect(box.checked).toBe(false);
        expect(check.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingText", () => {
    it("writes each keystroke synchronously into the selected model preset and follows a switch", () => {
        const text = item({ type: "text", bindKey: "aiModel" });
        const { query } = render(SettingText, { item: text, ctx: ctx() });
        const input = query<HTMLInputElement>("input");
        expect(input.value).toBe("model-a");

        typeInto(input, "model-a2");
        expect(modelPreset("a").aiModel).toBe("model-a2");
        expect(modelPreset("b").aiModel).toBe("model-b");
        expect(text.onChange).toHaveBeenCalledTimes(1);

        typeInto(input, "model-a3");
        changeToModelPreset("b");
        flushSync();
        expect(modelPreset("a").aiModel).toBe("model-a3");
        expect(input.value).toBe("model-b");
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
    const options = {
        selectOptions: [
            { value: "chatml", label: "ChatML" },
            { value: "alpaca", label: "Alpaca" },
            { value: "vicuna", label: "Vicuna" },
        ],
    };

    it("writes a choice synchronously into the selected model preset and follows a switch", () => {
        const select = item({ type: "select", bindKey: "instructChatTemplate", options });
        const { query } = render(SettingSelect, { item: select, ctx: ctx() });
        const element = query<HTMLSelectElement>("select");
        expect(element.value).toBe("chatml");
        expect(select.onChange).not.toHaveBeenCalled();

        chooseOption(element, "vicuna");
        expect(modelPreset("a").instructChatTemplate).toBe("vicuna");
        expect(modelPreset("b").instructChatTemplate).toBe("alpaca");
        expect(select.onChange).toHaveBeenCalledTimes(1);
        expect(select.onChange).toHaveBeenCalledWith("vicuna", expect.anything());

        changeToModelPreset("b");
        flushSync();
        expect(element.value).toBe("alpaca");
        expect(select.onChange).toHaveBeenCalledTimes(1);
    });

    it("writes the hidden-option fallback once into the selected model preset", () => {
        modelPreset("a").instructChatTemplate = "gone";
        const select = item({ type: "select", bindKey: "instructChatTemplate", options });
        render(SettingSelect, { item: select, ctx: ctx() });
        flushSync();
        expect(modelPreset("a").instructChatTemplate).toBe("vicuna");
        expect(modelPreset("b").instructChatTemplate).toBe("alpaca");
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

    it("writes a choice synchronously into the selected model preset through the registry, fires onChange once, and follows a switch", () => {
        const segmented = item({ type: "segmented", bindKey: "instructChatTemplate", options });
        const { target } = render(SettingSegmented, { item: segmented, ctx: ctx() });
        expect(active(target)).toBe("ChatML");
        expect(segmented.onChange).not.toHaveBeenCalled();

        segment(target, "Vicuna").click();
        expect(modelPreset("a").instructChatTemplate).toBe("vicuna");
        expect(modelPreset("b").instructChatTemplate).toBe("alpaca");
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
        expect(modelPreset("b").instructChatTemplate).toBe("chatml");
        expect(modelPreset("a").instructChatTemplate).toBe("vicuna");
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
        expect(modelPreset("a").instructChatTemplate).toBe("chatml");
    });

    it("writes the hidden-option fallback into the selected model preset", () => {
        modelPreset("a").instructChatTemplate = "gone";
        const segmented = item({ type: "segmented", bindKey: "instructChatTemplate", options });
        render(SettingSegmented, { item: segmented, ctx: ctx() });
        flushSync();
        expect(modelPreset("a").instructChatTemplate).toBe("vicuna");
        expect(modelPreset("b").instructChatTemplate).toBe("alpaca");
        expect(segmented.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingRenderer", () => {
    const byId = (items: SettingItem[], id: string) => items.find((entry) => entry.id === id)!;

    it("shows an item by its condition over the section views and the selected model preset, and its wrapper writes the record", () => {
        const always = byId(accessibilitySettingsItems, "acc.alwaysScrollToNewMessage");
        const jinja = byId(chatFormatSettingsItems, "chatFormat.jinjaTemplate");
        modelPreset("b").instructChatTemplate = "jinja";
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
        expect(modelPreset("b").JinjaTemplate).toBe("{{ messages }}");
        expect(modelPreset("a").JinjaTemplate).not.toBe("{{ messages }}");

        changeToModelPreset("a");
        flushSync();
        expect(textarea()).toBeNull();
    });
});
