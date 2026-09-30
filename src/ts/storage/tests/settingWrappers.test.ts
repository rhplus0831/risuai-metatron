// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 5: the seven declarative settings wrappers (`src/lib/Setting/Wrappers/`) over the
// production forwarding layer. Each binds its input with a function binding, so a user edit is
// written synchronously into the preset selected at that moment (`updateSettingValue`), `onChange`
// fires once per edit and never on a switch re-render (plan amendment A16), and a switch shows the
// other preset's value. `SettingNumber` also keeps a cleared input empty (the record holds `null`;
// Astra challenge point 3), and `SettingSelect` still writes its hidden-option fallback once.

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
import { DBState } from "../../stores.svelte";
import { changeToPreset, setDatabase, type Database } from "../database.svelte";
import { replacePresetSecrets } from "../llmSecrets.svelte";
import { selectPreset } from "../selection.svelte";
import SettingCheck from "src/lib/Setting/Wrappers/SettingCheck.svelte";
import SettingColor from "src/lib/Setting/Wrappers/SettingColor.svelte";
import SettingNumber from "src/lib/Setting/Wrappers/SettingNumber.svelte";
import SettingSelect from "src/lib/Setting/Wrappers/SettingSelect.svelte";
import SettingSlider from "src/lib/Setting/Wrappers/SettingSlider.svelte";
import SettingText from "src/lib/Setting/Wrappers/SettingText.svelte";
import SettingTextarea from "src/lib/Setting/Wrappers/SettingTextarea.svelte";

type AnyDb = Record<string, any>;
type Mounted = ReturnType<typeof mount>;

const mounted: Mounted[] = [];
const db = () => DBState.db as unknown as AnyDb;
const preset = (id: string) => db().botPresets.find((entry: { id: string }) => entry.id === id);

function ctx(): SettingContext {
    return { db: DBState.db, modelInfo: undefined, subModelInfo: undefined } as unknown as SettingContext;
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
    DBState.db = {} as Database;
    setDatabase({
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
    replacePresetSecrets({});
    boot();
});

afterEach(async () => {
    const instances = mounted.splice(0);
    await Promise.all(instances.map((instance) => unmount(instance)));
    document.body.replaceChildren();
    DBState.db = {} as Database;
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

        changeToPreset("b", false);
        flushSync();
        expect(input.value).toBe("555");
        expect(number.onChange).toHaveBeenCalledTimes(1);

        // An edit and a switch in the same flush: the edit stays with the preset it was made on.
        typeInto(input, "600");
        changeToPreset("a", false);
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
        expect(db().maxResponse).toBeNull();
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

        changeToPreset("b", false);
        flushSync();
        expect(handle.getAttribute("aria-valuenow")).toBe("50");
        expect(slider.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingCheck", () => {
    it("writes a toggle synchronously into the selected preset and follows a switch", () => {
        const check = item({ type: "check", bindKey: "useInstructPrompt" });
        const { query } = render(SettingCheck, { item: check, ctx: ctx() });
        const box = query<HTMLInputElement>("input[type=checkbox]");
        expect(box.checked).toBe(false);

        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        expect(preset("a").useInstructPrompt).toBe(true);
        expect(preset("b").useInstructPrompt).toBe(true);
        expect(check.onChange).toHaveBeenCalledTimes(1);
        expect(check.onChange).toHaveBeenCalledWith(true, expect.anything());

        // The same value again is not a write: onChange stays at one.
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        expect(check.onChange).toHaveBeenCalledTimes(1);

        preset("b").useInstructPrompt = false;
        changeToPreset("b", false);
        flushSync();
        expect(box.checked).toBe(false);
        expect(check.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("SettingText", () => {
    it("writes each keystroke synchronously into the selected preset and follows a switch", () => {
        const text = item({ type: "text", bindKey: "aiModel" });
        const { query } = render(SettingText, { item: text, ctx: ctx() });
        const input = query<HTMLInputElement>("input");
        expect(input.value).toBe("model-a");

        typeInto(input, "model-a2");
        expect(preset("a").aiModel).toBe("model-a2");
        expect(preset("b").aiModel).toBe("model-b");
        expect(text.onChange).toHaveBeenCalledTimes(1);

        typeInto(input, "model-a3");
        changeToPreset("b", false);
        flushSync();
        expect(preset("a").aiModel).toBe("model-a3");
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

        changeToPreset("b", false);
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

    it("writes a choice synchronously into the selected preset and follows a switch", () => {
        const select = item({ type: "select", bindKey: "instructChatTemplate", options });
        const { query } = render(SettingSelect, { item: select, ctx: ctx() });
        const element = query<HTMLSelectElement>("select");
        expect(element.value).toBe("chatml");
        expect(select.onChange).not.toHaveBeenCalled();

        chooseOption(element, "vicuna");
        expect(preset("a").instructChatTemplate).toBe("vicuna");
        expect(preset("b").instructChatTemplate).toBe("alpaca");
        expect(select.onChange).toHaveBeenCalledTimes(1);
        expect(select.onChange).toHaveBeenCalledWith("vicuna", expect.anything());

        changeToPreset("b", false);
        flushSync();
        expect(element.value).toBe("alpaca");
        expect(select.onChange).toHaveBeenCalledTimes(1);
    });

    it("writes the hidden-option fallback once into the selected preset", () => {
        preset("a").instructChatTemplate = "gone";
        const select = item({ type: "select", bindKey: "instructChatTemplate", options });
        render(SettingSelect, { item: select, ctx: ctx() });
        flushSync();
        expect(preset("a").instructChatTemplate).toBe("vicuna");
        expect(preset("b").instructChatTemplate).toBe("alpaca");
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

        changeToPreset("b", false);
        flushSync();
        expect(swatch()).toContain("#445566");
        expect(color.onChange).toHaveBeenCalledTimes(1);
    });
});
