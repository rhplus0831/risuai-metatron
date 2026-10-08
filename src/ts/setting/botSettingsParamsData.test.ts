import { describe, expect, it } from "vitest";
import { presetFieldOwner } from "../../../shared/presets.ts";
import { forwardedPresetField } from "../storage/settingsViews.svelte";
import { allBasicParameterItems, modelParameterItems } from "./botSettingsParamsData";
import { getFullSettingsData } from "./utils";
import type { SettingItem } from "./types";

// Slice 4 of `docs/plan/split-preset.md`: the Model page renders `modelParameterItems` and the Prompt
// page's Parameters tab renders `allBasicParameterItems`, so each list binds only fields its page's
// preset owns (a section field, such as a global provider setting, may sit on either).

function ownerOf(item: SettingItem): "model" | "prompt" | "section" {
    const root = (item.bindPath ?? item.bindKey)!.split(".")[0];
    const field = forwardedPresetField(root);
    return field === undefined ? "section" : (presetFieldOwner(field) ?? "section");
}

describe("the parameter items by page", () => {
    it("binds only model preset fields on the Model page", () => {
        expect(modelParameterItems.map((item) => item.bindKey)).toEqual(["maxContext"]);
        expect(modelParameterItems.map(ownerOf)).toEqual(["model"]);
    });

    it("binds no model preset field on the Prompt page's Parameters tab", () => {
        const bound = allBasicParameterItems.filter((item) => item.bindKey || item.bindPath);
        expect(bound.length).toBeGreaterThan(10);
        expect(bound.filter((item) => ownerOf(item) === "model").map((item) => item.id)).toEqual([]);
    });

    it("keeps the moved item in the settings search", () => {
        expect(getFullSettingsData("context").map((item) => item.id)).toContain("params.maxContext");
    });
});
