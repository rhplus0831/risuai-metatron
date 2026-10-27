// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset, resolveHypaV3Budget } from "../../../../shared/hypaV3Presets.ts";

// The HypaV3 section warns about the summarization model the server cannot run in the background:
// a preset model other than `subModel` (a browser WebLLM model), else a `memory` slot that resolves
// to a plugin model (one this tab registered or any `pluginmodel:::` id), through the real model
// preset and profile routing. The request-trigger note is always shown; the gap threshold is
// bound to the selected preset.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import { activeMainProfile, activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import MemorySettings from "./MemorySettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render(
    models: {
        aiModel: string;
        subModel: string;
        maxContext?: number;
        maxResponse?: number;
        maxContextOverride?: boolean;
        maxContextOverrideSize?: number;
    },
    presetSettings: Record<string, unknown> = {},
) {
    const preset = createHypaV3Preset("Selected", presetSettings);
    installFlatDatabase({
        characters: [],
        hypaV3: true,
        hypav2: false,
        hanuraiEnable: false,
        supaModelType: "none",
        useLegacyGUI: false,
        hypaV3Presets: [preset],
        hypaV3PresetId: preset.id,
        ...models,
    } as any);
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(MemorySettings, { target }));
    flushSync();
    return target;
}

const text = (target: HTMLElement) => target.textContent ?? "";
const strings = () => language.hypaV3Settings;

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
});

describe("the HypaV3 summarization model warnings", () => {
    it("shows neither warning for an ordinary auxiliary model, and the request-trigger note", () => {
        const target = render({ aiModel: "gpt-4o", subModel: "gpt-4o-mini" });
        expect(text(target)).not.toContain(strings().pluginMemoryModelWarning);
        expect(text(target)).not.toContain(strings().localSummarizationWarning);
        expect(text(target)).toContain(strings().requestTriggerNote);
    });

    it.each([
        ["a registered plugin model", "custom"],
        ["an unregistered plugin provider id", "pluginmodel:::NotLoaded"],
    ])("warns that the tab must stay open when the memory slot resolves to %s", (_, subModel) => {
        const target = render({ aiModel: "gpt-4o", subModel });
        expect(text(target)).toContain(strings().pluginMemoryModelWarning);
        expect(text(target)).not.toContain(strings().localSummarizationWarning);
        expect(text(target)).toContain(strings().requestTriggerNote);
    });

    it("warns that the server cannot run a local summarization model, instead of the plugin warning", () => {
        const target = render(
            { aiModel: "gpt-4o", subModel: "pluginmodel:::NotLoaded" },
            { summarizationModel: "Qwen3-4B-q4f32_1-MLC" },
        );
        expect(text(target)).toContain(strings().localSummarizationWarning);
        expect(text(target)).not.toContain(strings().pluginMemoryModelWarning);
    });

    it("follows the selected preset's summarization model", () => {
        const target = render({ aiModel: "gpt-4o", subModel: "gpt-4o-mini" });
        settings.hypaV3Presets.items[0].settings.summarizationModel = "Qwen3-4B-q4f32_1-MLC";
        flushSync();
        expect(text(target)).toContain(strings().localSummarizationWarning);
        settings.hypaV3Presets.items[0].settings.summarizationModel = "subModel";
        flushSync();
        expect(text(target)).not.toContain(strings().localSummarizationWarning);
    });
});

describe("the HypaV3 gap threshold", () => {
    function gapInput(target: HTMLElement): HTMLInputElement {
        const label = [...target.querySelectorAll("span")].find((span) =>
            span.textContent?.includes(strings().gapConfirmTokensLabel),
        );
        expect(label, "Expected the gap threshold label").toBeDefined();
        const input = label!.nextElementSibling;
        expect(input).toBeInstanceOf(HTMLInputElement);
        return input as HTMLInputElement;
    }

    it("shows the preset's value and writes an edit into the selected preset", () => {
        const target = render({ aiModel: "gpt-4o", subModel: "gpt-4o-mini" }, { gapConfirmTokens: 2500 });
        const input = gapInput(target);
        expect(input.value).toBe("2500");
        expect(input.min).toBe("0");

        input.value = "0";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(settings.hypaV3Presets.items[0].settings.gapConfirmTokens).toBe(0);
    });
});

describe("the HypaV3 token budget", () => {
    function controlFor(target: HTMLElement, label: string): Element {
        const span = [...target.querySelectorAll("span")].find((span) => span.textContent?.includes(label));
        expect(span, `Expected the ${label} label`).toBeDefined();
        expect(span!.nextElementSibling).not.toBeNull();
        return span!.nextElementSibling!;
    }

    function tokenInput(target: HTMLElement, label: string): HTMLInputElement {
        const input = controlFor(target, label);
        expect(input).toBeInstanceOf(HTMLInputElement);
        return input as HTMLInputElement;
    }

    function modeButton(target: HTMLElement, label: string): HTMLButtonElement {
        const group = [...target.querySelectorAll('[role="group"]')].find(
            (group) => group.getAttribute("aria-label") === strings().budgetModeLabel,
        );
        expect(group, "Expected the budget mode control").toBeDefined();
        const button = [...group!.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
        expect(button, `Expected the ${label} mode`).toBeDefined();
        return button!;
    }

    it("shows each reduction at the effective context and updates warnings as token inputs are edited", () => {
        const target = render(
            {
                aiModel: "gpt-4o",
                subModel: "gpt-4o-mini",
                maxContext: 20000,
                maxResponse: 2000,
                maxContextOverride: true,
                maxContextOverrideSize: 10000,
            },
            {
                budgetMode: "tokens",
                memoryBudgetTokens: 6000,
                lookaheadHeadroomTokens: 4000,
                extraSummarizationTokens: 5000,
            },
        );
        const selected = settings.hypaV3Presets.items[0].settings;
        const labels = {
            memory: strings().memoryBudgetTokensLabel,
            headroom: strings().lookaheadHeadroomTokensLabel,
            extra: strings().extraSummarizationTokensLabel,
        };
        const warnings = () =>
            [...target.querySelectorAll<HTMLElement>("[data-hypav3-budget-reduced]")].map((line) => {
                expect(line.classList.contains("text-draculared")).toBe(true);
                return [line.dataset.hypav3BudgetReduced, line.textContent?.trim()];
            });
        const expectedWarnings = (context: number) =>
            resolveHypaV3Budget(selected, context, 2000).reduced.map(({ field, applied }) => [
                field,
                `${labels[field]}: ${strings().budgetReducedWarning(
                    context.toLocaleString(),
                    Math.max(0, context - 2000).toLocaleString(),
                    applied.toLocaleString(),
                )}`,
            ]);
        expect(warnings()).toHaveLength(3);
        expect(warnings()).toEqual(expectedWarnings(10000));

        // The main profile has enough space; disabling the prompt override clears the warnings.
        activePreset.maxContextOverride = false;
        flushSync();
        expect(warnings()).toEqual([]);
        activeMainProfile.maxContext = 10000;
        flushSync();
        expect(warnings()).toEqual(expectedWarnings(10000));

        const inputs = [
            ["memoryBudgetTokens", labels.memory, 3000],
            ["extraSummarizationTokens", labels.extra, 1000],
            ["lookaheadHeadroomTokens", labels.headroom, 1000],
        ] as const;
        for (const [key, label, value] of inputs) {
            const input = tokenInput(target, label);
            expect(input.type).toBe("number");
            expect(input.min).toBe("0");
            expect(input.value).toBe(String(selected[key]));
            input.value = String(value);
            // No change event or blur: the warning must follow typing immediately.
            input.dispatchEvent(new Event("input", { bubbles: true }));
            flushSync();
            expect(selected[key]).toBe(value);
            expect(warnings()).toEqual(expectedWarnings(10000));
        }
        expect(warnings()).toEqual([]);

        const memory = tokenInput(target, labels.memory);
        memory.value = "6000";
        memory.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(warnings()).toHaveLength(1);
        expect(warnings()).toEqual(expectedWarnings(10000));
        memory.value = "3000";
        memory.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(warnings()).toEqual([]);
    });

    it("converts ratios at the current context into token amounts and preserves the ratios when switching modes", () => {
        const ratios = { memoryTokensRatio: 0.25, lookaheadHeadroomRatio: 0.1, extraSummarizationRatio: 0.08 };
        const target = render(
            { aiModel: "gpt-4o", subModel: "gpt-4o-mini", maxContext: 0, maxResponse: 2000 },
            { budgetMode: "ratio", ...ratios },
        );
        const convert = () => target.querySelector<HTMLButtonElement>("[data-hypav3-convert-to-tokens]");
        expect(convert()).toBeNull();

        activeMainProfile.maxContext = 20000;
        activePreset.maxContextOverride = true;
        activePreset.maxContextOverrideSize = 10007;
        flushSync();
        expect(convert()!.textContent?.trim()).toBe(strings().convertToTokens((10007).toLocaleString()));
        expect(modeButton(target, strings().budgetModeRatio).getAttribute("aria-pressed")).toBe("true");

        convert()!.click();
        flushSync();
        // floor(10007 × .25), round(10007 × .1), round(10007 × .08).
        const selected = settings.hypaV3Presets.items[0].settings;
        expect(selected).toMatchObject({
            budgetMode: "tokens",
            memoryBudgetTokens: 2501,
            lookaheadHeadroomTokens: 1001,
            extraSummarizationTokens: 801,
            ...ratios,
        });
        expect(modeButton(target, strings().budgetModeTokens).getAttribute("aria-pressed")).toBe("true");
        expect(convert()).toBeNull();
        expect(tokenInput(target, strings().memoryBudgetTokensLabel).value).toBe("2501");
        expect(tokenInput(target, strings().lookaheadHeadroomTokensLabel).value).toBe("1001");
        expect(tokenInput(target, strings().extraSummarizationTokensLabel).value).toBe("801");
        expect(text(target)).not.toContain(strings().memoryTokensRatioLabel);

        modeButton(target, strings().budgetModeRatio).click();
        flushSync();
        expect(selected).toMatchObject({ budgetMode: "ratio", ...ratios });
        for (const [label, ratio] of [
            [strings().memoryTokensRatioLabel, ratios.memoryTokensRatio],
            [strings().lookaheadHeadroomRatioLabel, ratios.lookaheadHeadroomRatio],
            [strings().extraSummarizationRatioLabel, ratios.extraSummarizationRatio],
        ] as const) {
            expect(controlFor(target, label).querySelector('[role="slider"]')!.getAttribute("aria-valuenow")).toBe(
                String(ratio),
            );
        }
        expect(text(target)).not.toContain(strings().memoryBudgetTokensLabel);
        modeButton(target, strings().budgetModeTokens).click();
        flushSync();
        expect(selected.budgetMode).toBe("tokens");
        expect(tokenInput(target, strings().memoryBudgetTokensLabel).value).toBe("2501");
    });

    it("creates and selects a token-mode preset with the plus button", () => {
        const target = render({ aiModel: "gpt-4o", subModel: "gpt-4o-mini", maxContext: 20000, maxResponse: 2000 });
        const original = settings.hypaV3Presets.items[0];
        expect(original.settings.budgetMode).toBe("ratio");
        const picker = [...target.querySelectorAll("select")].find((select) =>
            [...select.options].some((option) => option.value === original.id),
        );
        expect(picker, "Expected the HypaV3 preset picker").toBeDefined();
        // The first action in the preset's button row is +.
        const plus = picker!.nextElementSibling!.querySelector<HTMLButtonElement>("button")!;
        plus.click();
        flushSync();

        expect(settings.hypaV3Presets.items).toHaveLength(2);
        const added = settings.hypaV3Presets.items.find((preset) => preset.id !== original.id)!;
        expect(settings.hypaV3Presets.selectedId).toBe(added.id);
        expect(picker!.value).toBe(added.id);
        expect(added.settings.budgetMode).toBe("tokens");
        expect(modeButton(target, strings().budgetModeTokens).getAttribute("aria-pressed")).toBe("true");
        expect(tokenInput(target, strings().memoryBudgetTokensLabel).value).toBe(
            String(added.settings.memoryBudgetTokens),
        );
        expect(original.settings.budgetMode).toBe("ratio");
    });
});
