// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";

// The HypaV3 section warns about the summarization model the server cannot run in the background:
// a preset model other than `subModel` (a browser WebLLM model), else a `memory` slot that resolves
// to a plugin model (one this tab registered or any `pluginmodel:::` id), through the real model
// preset and profile routing. The request-trigger note is always shown; the gap threshold is
// bound to the selected preset.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import MemorySettings from "./MemorySettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render(models: { aiModel: string; subModel: string }, presetSettings: Record<string, unknown> = {}) {
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
