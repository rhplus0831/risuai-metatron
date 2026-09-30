import { describe, expect, it, vi } from "vitest";
import * as fflate from "fflate";
import { decode as decodeMsgpack } from "msgpackr/index-no-eval";

vi.mock("src/ts/util", () => ({
    encryptBuffer: async (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    decryptBuffer: async (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
}));

vi.mock("src/ts/rpack/rpack_js.js", () => ({
    encodeRPack: async (data: Uint8Array) => data,
    decodeRPack: async (data: Uint8Array) => data,
}));

import {
    createTranslatorPreset,
    decodeTranslatorPresetFile,
    encodeTranslatorPresetFile,
    getCurrentTranslatorPresetFromState,
    getTranslatorPresetDownloadName,
    translatorPresetImportExtensions,
    type TranslatorPresetStateLike,
} from "./presets";

// The list's defaults and the id's validity are the server `translatorPresets` normalizer's job
// (`server/src/tests/normalizeCollections.test.ts`); the client only selects.
describe("getCurrentTranslatorPresetFromState", () => {
    it("selects the preset by id, falls back to the first one, and never writes the state", () => {
        const presets = [
            createTranslatorPreset("Default", {
                prompt: "Default prompt",
                maxResponse: 128,
            }),
            createTranslatorPreset("Detailed", {
                prompt: "Detailed prompt",
                maxResponse: 256,
            }),
        ];
        const state: TranslatorPresetStateLike = {
            translatorPresets: presets,
            translatorPresetId: presets[1].id,
        };

        const preset = getCurrentTranslatorPresetFromState(state);

        expect(preset).toBe(presets[1]);
        expect(state.translatorPresets).toBe(presets);
        expect(state).toEqual({ translatorPresets: presets, translatorPresetId: presets[1].id });

        // An id no preset has (another client deleted it) or no id at all: the first preset.
        const stale: TranslatorPresetStateLike = { translatorPresets: presets, translatorPresetId: "gone" };
        expect(getCurrentTranslatorPresetFromState(stale)).toBe(presets[0]);
        expect(stale).toEqual({ translatorPresets: presets, translatorPresetId: "gone" });
        expect(getCurrentTranslatorPresetFromState({ translatorPresets: presets })).toBe(presets[0]);
    });
});

describe("translator preset file codec", () => {
    it("only allows .risutl files in the import picker", () => {
        expect(translatorPresetImportExtensions).toEqual(["risutl"]);
    });

    it("round-trips the new encrypted .risutl file payload", async () => {
        const preset = createTranslatorPreset("My Preset", {
            prompt: "Translate into {{slot}}.",
            maxResponse: 256,
        });

        const encoded = await encodeTranslatorPresetFile(preset);
        const decoded = await decodeTranslatorPresetFile(encoded);

        // The shared fields round-trip; the id does not, because the decoder always assigns a fresh one.
        const { id: originalId, ...presetWithoutId } = preset;
        const { id: decodedId, ...decodedWithoutId } = decoded;
        expect(decodedWithoutId).toEqual(presetWithoutId);
        expect(typeof decodedId).toBe("string");
        expect(decodedId.length).toBeGreaterThan(0);
        expect(decodedId).not.toBe(originalId);

        // The `.risutl` payload carries no id (D5). The mocks make encryption and RPack identity
        // transforms, so the container is just compressed msgpack and the inner preset plain msgpack.
        const container = decodeMsgpack(fflate.decompressSync(encoded)) as { preset: Uint8Array };
        const filePreset = decodeMsgpack(new Uint8Array(container.preset)) as Record<string, unknown>;
        expect(filePreset).toEqual({
            name: "My Preset",
            prompt: "Translate into {{slot}}.",
            maxResponse: 256,
        });
        expect(filePreset).not.toHaveProperty("id");

        expect(() => JSON.parse(new TextDecoder().decode(encoded))).toThrow();
        expect(getTranslatorPresetDownloadName("My/Translator:Preset")).toBe(
            "translator_preset_My_Translator_Preset.risutl",
        );
    });

    it("rejects plain JSON translator preset payloads", async () => {
        const plainJsonPayload = new TextEncoder().encode(
            JSON.stringify({
                type: "risu",
                ver: 1,
                data: {
                    name: "Plain JSON Preset",
                    prompt: "Plain JSON prompt",
                    maxResponse: 111,
                },
            }),
        );

        await expect(decodeTranslatorPresetFile(plainJsonPayload)).rejects.toThrow("Invalid translator preset file.");
    });

    it("rejects non-translator preset payloads", async () => {
        const hypaLikePayload = new TextEncoder().encode(
            JSON.stringify({
                type: "risu",
                ver: 1,
                data: {
                    name: "HypaV3",
                    settings: {
                        summarizationPrompt: "not a translator preset",
                    },
                },
            }),
        );

        await expect(decodeTranslatorPresetFile(hypaLikePayload)).rejects.toThrow("Invalid translator preset file.");
    });
});
