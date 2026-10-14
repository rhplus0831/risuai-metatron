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

// The prompt preset's context size override on the Parameters tab: a check item over the preset's
// `maxContextOverride` whose turn-on seeds an unset (<= 0) `maxContextOverrideSize` from the page's
// main profile (`ctx.modelProfile`, chat-bound through `SettingRenderer`), and a number item bound
// to that prompt field, shown only while the flag is on. The profile is read, never written.
describe("the context size override items", () => {
    const check = allBasicParameterItems.find((item) => item.id === "params.maxContextOverride")!;
    const size = allBasicParameterItems.find((item) => item.id === "params.maxContextOverrideSize")!;

    function context(preset: Record<string, unknown>, maxContext = 32000) {
        const modelProfile = { maxContext };
        return { preset, modelProfile, ctx: { preset, modelProfile } as unknown as SettingContext };
    }

    it("sits after the response size, binds prompt fields only, and is searchable", () => {
        const ids = allBasicParameterItems.map((item) => item.id);
        expect(ids.indexOf("params.maxContextOverride")).toBe(ids.indexOf("params.maxResponse") + 1);
        expect(ids.indexOf("params.maxContextOverrideSize")).toBe(ids.indexOf("params.maxContextOverride") + 1);
        expect(check.type).toBe("check");
        expect(check.bindKey ?? check.bindPath).toBeUndefined();
        expect(size.type).toBe("number");
        expect(size.bindKey).toBe("maxContextOverrideSize");
        expect(ownerOf(size)).toBe("prompt");
        expect(size.options).toEqual({ min: 0 });
        for (const query of ["context", "override"]) {
            expect(
                getFullSettingsData(query).map((item) => item.id),
                query,
            ).toEqual(expect.arrayContaining(["params.maxContextOverride", "params.maxContextOverrideSize"]));
        }
    });

    it("ticking the box with an unset size copies the main profile's size into the preset; the size item shows only while on", () => {
        const { preset, modelProfile, ctx } = context({ maxContextOverride: false, maxContextOverrideSize: 0 });
        expect(check.getValue!(ctx)).toBe(false);
        expect(size.condition!(ctx)).toBe(false);
        check.setValue!(true, ctx);
        expect(preset).toEqual({ maxContextOverride: true, maxContextOverrideSize: 32000 });
        expect(check.getValue!(ctx)).toBe(true);
        expect(size.condition!(ctx)).toBe(true);
        expect(modelProfile.maxContext).toBe(32000);
        // Off keeps the size (so a later tick keeps the user's number).
        check.setValue!(false, ctx);
        expect(preset).toEqual({ maxContextOverride: false, maxContextOverrideSize: 32000 });
        expect(size.condition!(ctx)).toBe(false);
    });

    it("ticking the box with a size above 0 keeps it; a negative or missing size is seeded like 0", () => {
        const kept = context({ maxContextOverride: false, maxContextOverrideSize: 1234 });
        check.setValue!(true, kept.ctx);
        expect(kept.preset).toEqual({ maxContextOverride: true, maxContextOverrideSize: 1234 });

        const negative = context({ maxContextOverride: false, maxContextOverrideSize: -5 }, 8000);
        check.setValue!(true, negative.ctx);
        expect(negative.preset).toEqual({ maxContextOverride: true, maxContextOverrideSize: 8000 });

        const missing = context({}, 16000);
        expect(check.getValue!(missing.ctx)).toBeUndefined();
        expect(size.condition!(missing.ctx)).toBe(false);
        check.setValue!(true, missing.ctx);
        expect(missing.preset).toEqual({ maxContextOverride: true, maxContextOverrideSize: 16000 });

        // A profile whose size is 0 seeds 0: the override then never takes effect (0 is unset).
        const zeroProfile = context({ maxContextOverride: false, maxContextOverrideSize: 0 }, 0);
        check.setValue!(true, zeroProfile.ctx);
        expect(zeroProfile.preset).toEqual({ maxContextOverride: true, maxContextOverrideSize: 0 });
    });
});
