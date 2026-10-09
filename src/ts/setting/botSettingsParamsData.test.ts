import { describe, expect, it } from "vitest";
import { presetFieldOwner } from "../../../shared/presets.ts";
import { forwardedPresetField } from "../storage/settingsViews.svelte";
import { allBasicParameterItems, modelParameterItems } from "./botSettingsParamsData";
import { getFullSettingsData } from "./utils";
import type { SettingContext, SettingItem } from "./types";

// Slice 4 of `docs/plan/split-preset.md`: the Model page renders `modelParameterItems` and the Prompt
// page's Parameters tab renders `allBasicParameterItems`, so each list binds only fields its page's
// preset owns (a section field, such as a global provider setting, may sit on either). Since
// `docs/plan/model-profiles.md` the context size is the model profile's, read and written through
// the page's profile (`ctx.modelProfile`).

function ownerOf(item: SettingItem): "model" | "profile" | "prompt" | "section" {
    const root = (item.bindPath ?? item.bindKey)!.split(".")[0];
    const field = forwardedPresetField(root);
    return field === undefined ? "section" : (presetFieldOwner(field) ?? "section");
}

describe("the parameter items by page", () => {
    it("binds only model profile fields on the Model page", () => {
        expect(modelParameterItems.map((item) => item.id)).toEqual(["params.maxContext"]);
        expect(modelParameterItems.map((item) => item.bindKey ?? item.bindPath)).toEqual([undefined]);
        const [item] = modelParameterItems;
        const modelProfile = { maxContext: 1234 };
        const ctx = { modelProfile } as unknown as SettingContext;
        expect(item.getValue!(ctx)).toBe(1234);
        item.setValue!(5678, ctx);
        expect(modelProfile.maxContext).toBe(5678);
    });

    it("binds no model preset field on the Prompt page's Parameters tab", () => {
        const bound = allBasicParameterItems.filter((item) => item.bindKey || item.bindPath);
        expect(bound.length).toBeGreaterThan(10);
        expect(
            bound.filter((item) => ownerOf(item) === "model" || ownerOf(item) === "profile").map((item) => item.id),
        ).toEqual([]);
    });

    it("keeps the moved item in the settings search", () => {
        expect(getFullSettingsData("context").map((item) => item.id)).toContain("params.maxContext");
    });
});
