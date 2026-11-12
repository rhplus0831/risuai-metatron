import { describe, expect, it } from "vitest";
import { chatMemoryEnabled, legacyMemoryAlgorithm, type ChatMemorySettings } from "../chatMemory.ts";
import { createHypaV3Preset } from "../hypaV3Presets.ts";

const presets = [
    createHypaV3Preset("Manual", { alwaysToggleOn: false }, "manual"),
    createHypaV3Preset("Automatic", { alwaysToggleOn: true }, "automatic"),
];
const automatic = { hypaV3Presets: presets, hypaV3PresetId: "automatic", supaModelType: "none" };

describe("chat memory resolution", () => {
    it("uses the legacy priority even when lower-priority algorithms are enabled", () => {
        const settings: ChatMemorySettings = {
            memoryAlgorithmType: "structuredMemory",
            hanuraiEnable: true,
            hypav2: true,
            hypaV3: true,
            supaModelType: "subModel",
        };
        expect(legacyMemoryAlgorithm(settings)).toBe("structuredMemory");
        expect(legacyMemoryAlgorithm({ ...settings, memoryAlgorithmType: undefined })).toBe("hanuraiMemory");
        expect(legacyMemoryAlgorithm({ ...settings, memoryAlgorithmType: undefined, hanuraiEnable: false })).toBe(
            "hypaMemoryV2",
        );
        expect(legacyMemoryAlgorithm({ hypaV3: true, supaModelType: "subModel" })).toBe("hypaMemoryV3");
        expect(legacyMemoryAlgorithm({ supaModelType: "subModel" })).toBe("supaMemory");
        expect(legacyMemoryAlgorithm({ supaModelType: "none" })).toBe("none");
    });

    it("defaults to the selected preset only for HypaV3 and Structured Memory, otherwise to the owner's boolean", () => {
        for (const algorithm of [{ hypaV3: true }, { memoryAlgorithmType: "structuredMemory" }]) {
            expect(chatMemoryEnabled({}, { supaMemory: false }, { ...automatic, ...algorithm })).toBe(true);
            expect(
                chatMemoryEnabled({}, { supaMemory: false }, { ...automatic, ...algorithm, hypaV3PresetId: "manual" }),
            ).toBe(false);
        }
        for (const settings of [
            { ...automatic, hanuraiEnable: true, hypaV3: true },
            { ...automatic, hypav2: true, hypaV3: true },
            { ...automatic, supaModelType: "subModel" },
            automatic,
        ]) {
            expect(chatMemoryEnabled({}, { supaMemory: false }, settings)).toBe(false);
            expect(chatMemoryEnabled(undefined, { supaMemory: true }, settings)).toBe(true);
            expect(chatMemoryEnabled(null, undefined, settings)).toBe(false);
            expect(chatMemoryEnabled({}, { supaMemory: "true" }, settings)).toBe(false);
        }
    });

    it("lets an explicit switch win over the owner and alwaysToggleOn", () => {
        for (const algorithm of [{ hypaV3: true }, { memoryAlgorithmType: "structuredMemory" }]) {
            expect(
                chatMemoryEnabled({ memoryEnabled: false }, { supaMemory: true }, { ...automatic, ...algorithm }),
            ).toBe(false);
        }
        expect(chatMemoryEnabled({ memoryEnabled: true }, { supaMemory: false }, { supaModelType: "none" })).toBe(true);
    });

    it("reads a malformed switch as absent without activating stored mode, preset, or connection", () => {
        for (const memoryEnabled of ["false", 0, null, {}]) {
            const chat = {
                memoryEnabled,
                memoryMode: "structuredMemory",
                memoryPresetId: "automatic",
                memoryProfileId: "connection",
            };
            expect(chatMemoryEnabled(chat, { supaMemory: true }, { supaModelType: "none" })).toBe(true);
            expect(chatMemoryEnabled(chat, { supaMemory: false }, { ...automatic, hypaV3PresetId: "manual" })).toBe(
                false,
            );
            expect(chatMemoryEnabled(chat, { supaMemory: false }, { ...automatic, hypaV3: true })).toBe(true);
        }
    });
});
