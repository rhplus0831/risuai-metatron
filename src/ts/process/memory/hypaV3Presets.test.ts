import { describe, expect, it } from "vitest";
import { createHypaV3Preset, selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";

// `hypaV3PresetId` is the selected preset's id (it travels in the `hypaV3Presets` record as
// `selectedId`). `selectedHypaV3Preset` is the one lookup behind `getCurrentHypaV3Preset`,
// the `stores.svelte.ts` toggle effect, and `MemorySettings.svelte`. The list's defaults and the
// id's validity are the server normalizer's job; the client only selects, falling back to the first
// preset until the next reload when another client deleted the selected one.

describe("selectedHypaV3Preset", () => {
    const presets = [createHypaV3Preset("First"), createHypaV3Preset("Second")];

    it("selects the preset by id, not by position", () => {
        expect(selectedHypaV3Preset({ hypaV3Presets: presets, hypaV3PresetId: presets[1].id })).toBe(presets[1]);
        expect(selectedHypaV3Preset({ hypaV3Presets: presets, hypaV3PresetId: presets[0].id })).toBe(presets[0]);
    });

    it("falls back to the first preset for an id no preset has, or no id, and never writes the state", () => {
        const stale = { hypaV3Presets: presets, hypaV3PresetId: "gone" };
        expect(selectedHypaV3Preset(stale)).toBe(presets[0]);
        expect(stale).toEqual({ hypaV3Presets: presets, hypaV3PresetId: "gone" });
        expect(selectedHypaV3Preset({ hypaV3Presets: presets })).toBe(presets[0]);
        // A numeric index (the old position-based selection) is not an id.
        expect(selectedHypaV3Preset({ hypaV3Presets: presets, hypaV3PresetId: 1 as unknown as string })).toBe(
            presets[0],
        );
    });

    it("returns undefined for an empty or missing list (the server keeps the stored list nonempty)", () => {
        expect(selectedHypaV3Preset({ hypaV3Presets: [], hypaV3PresetId: "x" })).toBeUndefined();
        expect(selectedHypaV3Preset({})).toBeUndefined();
    });
});
