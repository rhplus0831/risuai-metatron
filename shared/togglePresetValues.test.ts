import { describe, expect, it, vi } from "vitest";
import { captureToggleValues, compareTogglePreset, toggleValuesForChat, type TogglePreset } from "./togglePresets.ts";

// Slice 4's contract: resolved values are captured under bare keys; projection is
// restricted to defined toggles and comparison distinguishes edits from schema drift.
const definitions = [
    "help=Help=caption",
    "flag=Flag",
    "group=Details=group",
    "mode=Mode=select=First,Second",
    "title=Title=text",
    "notes=Notes=textarea",
    "end=End=groupEnd",
    "rule=Rule=divider",
    "flag=Later flag=text",
    "mode=Later mode=select=First,Second,Third",
].join("\n");

function preset(values: TogglePreset["values"], kinds: TogglePreset["kinds"] = {}): TogglePreset {
    return { id: "p", name: "P", values, kinds, createdAt: 1, updatedAt: 2 };
}

describe("toggle preset values", () => {
    it("captures resolved defaults and all four kinds once under bare keys, ignoring layout and later definitions", () => {
        const resolved: Record<string, string> = {
            toggle_flag: "0",
            toggle_mode: "0",
            toggle_title: "",
            toggle_notes: "line one\nline two",
        };
        const read = vi.fn((key: string) => resolved[key]);
        expect(captureToggleValues(definitions, read)).toEqual({
            values: { flag: "0", mode: "0", title: "", notes: "line one\nline two" },
            kinds: { flag: "checkbox", mode: "select", title: "text", notes: "textarea" },
        });
        read.mockClear();
        expect(captureToggleValues("help=Help=caption\nrule=Rule=divider", read)).toEqual({ values: {}, kinds: {} });
        expect(read).not.toHaveBeenCalled();
    });

    it("projects only defined storage keys, preserving own values without saved kinds and defaulting missing or changed kinds", () => {
        const saved = preset({ flag: "1", mode: "1", title: "", notes: "saved\nnotes", stale: "ignore" });
        const original = structuredClone(saved);
        expect(toggleValuesForChat(saved, definitions)).toEqual({
            toggle_flag: "1",
            toggle_mode: "1",
            toggle_title: "",
            toggle_notes: "saved\nnotes",
        });
        const defaults = { toggle_flag: "0", toggle_mode: "0", toggle_title: "", toggle_notes: "" };
        expect(toggleValuesForChat(preset({}), definitions)).toEqual(defaults);
        expect(
            toggleValuesForChat(
                preset(
                    { flag: "1", mode: "1", title: "old", notes: "old" },
                    { flag: "text", mode: "checkbox", title: "textarea", notes: "text" },
                ),
                definitions,
            ),
        ).toEqual(defaults);
        expect(toggleValuesForChat(saved, "")).toEqual({});
        expect(saved).toEqual(original);
    });

    it("rejects non-integer and out-of-range select values in both projection and comparison, using the first option list", () => {
        const text = "mode=Mode=select=First,Second\nmode=Later=select=First,Second,Third";
        for (const value of ["-1", "2", "0.5", "", "bad", "NaN", "Infinity"]) {
            const saved = preset({ mode: value }, { mode: "select" });
            expect(toggleValuesForChat(saved, text), value).toEqual({ toggle_mode: "0" });
            expect(
                compareTogglePreset(saved, text, () => value),
                value,
            ).toEqual({
                missing: [],
                stale: [],
                kindMismatch: ["mode"],
                differing: ["mode"],
                hasMismatch: true,
                hasDifference: true,
            });
        }
        for (const value of ["0", "1"]) {
            const saved = preset({ mode: value });
            expect(toggleValuesForChat(saved, text)).toEqual({ toggle_mode: value });
            expect(compareTogglePreset(saved, text, () => value)).toEqual({
                missing: [],
                stale: [],
                kindMismatch: [],
                differing: [],
                hasMismatch: false,
                hasDifference: false,
            });
        }
        expect(toggleValuesForChat(preset({ mode: "0" }), "mode=Empty=select")).toEqual({ toggle_mode: "0" });
        expect(compareTogglePreset(preset({ mode: "0" }), "mode=Empty=select", () => "0").kindMismatch).toEqual([
            "mode",
        ]);
    });

    it("compares missing, incompatible, edited and stale bare keys independently, including kinds-only stale keys", () => {
        const resolved: Record<string, string> = {
            toggle_flag: "0",
            toggle_mode: "0",
            toggle_title: "now",
            toggle_notes: "same",
        };
        const read = (key: string) => resolved[key];
        const saved = preset(
            { mode: "0", title: "before", notes: "same", old: "stale" },
            { mode: "text", old: "checkbox", kindsOnly: "textarea" },
        );
        const original = structuredClone(saved);
        expect(compareTogglePreset(saved, definitions, read)).toEqual({
            missing: ["flag"],
            stale: ["old", "kindsOnly"],
            kindMismatch: ["mode"],
            differing: ["flag", "mode", "title"],
            hasMismatch: true,
            hasDifference: true,
        });
        const equal = preset({ flag: "0", mode: "0", title: "now", notes: "same" });
        const matched = {
            missing: [],
            stale: [],
            kindMismatch: [],
            differing: [],
            hasMismatch: false,
            hasDifference: false,
        };
        expect(compareTogglePreset(equal, definitions, read)).toEqual(matched);
        expect(
            compareTogglePreset({ ...equal, values: { ...equal.values, title: "before" } }, definitions, read),
        ).toEqual({
            ...matched,
            differing: ["title"],
            hasDifference: true,
        });
        expect(compareTogglePreset({ ...equal, kinds: { orphan: "text" } }, definitions, read)).toEqual({
            ...matched,
            stale: ["orphan"],
            hasMismatch: true,
            hasDifference: true,
        });
        expect(compareTogglePreset(preset({}), "", read)).toEqual(matched);
        expect(saved).toEqual(original);
    });
});
