import { describe, expect, it, vi } from "vitest";
import * as fflate from "fflate";
import { decode as decodeMsgpack, encode as encodeMsgpack } from "msgpackr/index-no-eval";

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

/** `value` with every `id` removed, at any depth (the preset's and its steps' are generated on decode). */
function withoutIds(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(withoutIds);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "id")
                .map(([key, inner]) => [key, withoutIds(inner)]),
        );
    }
    return value;
}

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

        // The shared fields round-trip as the one step; neither the preset id nor the step id does,
        // because the decoder always assigns fresh ones.
        expect(withoutIds(decoded)).toEqual(withoutIds(preset));
        expect(decoded.steps).toHaveLength(1);
        expect(typeof decoded.id).toBe("string");
        expect(decoded.id.length).toBeGreaterThan(0);
        expect(decoded.id).not.toBe(preset.id);
        expect(decoded.steps[0].id).not.toBe(preset.steps[0].id);

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

    // Translation slice 3.1: version 2 holds every step. The mocks make encryption and RPack identity
    // transforms, so a file is compressed msgpack around a plain msgpack payload, in both directions.
    const fileOf = (encoded: Uint8Array) => {
        const container = decodeMsgpack(fflate.decompressSync(encoded)) as {
            translatorPresetVersion: number;
            type: string;
            preset: Uint8Array;
        };
        return {
            version: container.translatorPresetVersion,
            type: container.type,
            payload: decodeMsgpack(new Uint8Array(container.preset)) as Record<string, unknown>,
        };
    };
    const fileWith = (version: number, payload: unknown) =>
        fflate.compressSync(
            encodeMsgpack({
                translatorPresetVersion: version,
                type: "translator-preset",
                preset: encodeMsgpack(payload),
            }),
        );
    const INVALID = "Invalid translator preset file.";
    const stepPayload = (overrides: Record<string, unknown> = {}) => ({
        name: "Step",
        enabled: true,
        prompt: "p {{slot::content}}",
        maxResponse: 100,
        model: { mode: "inherit" },
        ...overrides,
    });

    it("writes version 2 for a preset version 1 would lose, with every step's fields and no id, and reads it back as the same preset under fresh ids", async () => {
        const preset = createTranslatorPreset("Steps", {
            steps: [
                { name: "Draft", enabled: true, prompt: "a {{slot::content}}", maxResponse: 7, outputKey: "draft" },
                {
                    name: "Polish",
                    enabled: false,
                    prompt: "b {{slot::out::draft}}",
                    maxResponse: 8,
                    model: { mode: "profile", profileId: "pr-1" },
                },
            ],
        });
        const encoded = await encodeTranslatorPresetFile(preset);
        const file = fileOf(encoded);
        expect(file.version).toBe(2);
        expect(file.type).toBe("translator-preset");
        expect(file.payload).toStrictEqual({
            name: "Steps",
            steps: [
                {
                    name: "Draft",
                    enabled: true,
                    prompt: "a {{slot::content}}",
                    maxResponse: 7,
                    model: { mode: "inherit" },
                    outputKey: "draft",
                },
                {
                    name: "Polish",
                    enabled: false,
                    prompt: "b {{slot::out::draft}}",
                    maxResponse: 8,
                    model: { mode: "profile", profileId: "pr-1" },
                },
            ],
        });
        expect(JSON.stringify(file.payload)).not.toContain('"id"');

        const decoded = await decodeTranslatorPresetFile(encoded);
        expect(withoutIds(decoded)).toStrictEqual(withoutIds(preset));
        expect(decoded.id).not.toBe(preset.id);
        expect(decoded.steps.map((step) => step.id)).not.toContain(preset.steps[0].id);
        expect(decoded.steps.map((step) => step.id)).not.toContain(preset.steps[1].id);
        expect(new Set(decoded.steps.map((step) => step.id)).size).toBe(2);
        // The profile step keeps its profile id: it runs where that profile exists, else shows as missing.
        expect(decoded.steps[1].model).toEqual({ mode: "profile", profileId: "pr-1" });
        // A second cycle is a fixed point on the file.
        expect(fileOf(await encodeTranslatorPresetFile(decoded)).payload).toStrictEqual(file.payload);
    });

    it("writes version 1 only for a preset it holds without loss: one enabled step on the translate slot, without an output key, named Step 1", async () => {
        const v1 = createTranslatorPreset("One", { prompt: "a", maxResponse: 7 });
        expect(fileOf(await encodeTranslatorPresetFile(v1))).toMatchObject({
            version: 1,
            payload: { name: "One", prompt: "a", maxResponse: 7 },
        });
        // Each of these would lose something in version 1 (Astra's plan review, point 4).
        const lossy: Record<string, Parameters<typeof createTranslatorPreset>[1]> = {
            "two steps": { steps: [{ prompt: "a" }, { prompt: "b" }] },
            "a disabled second step": { steps: [{ prompt: "a" }, { prompt: "b", enabled: false }] },
            "a profile step": { steps: [{ prompt: "a", model: { mode: "profile", profileId: "pr" } }] },
            "a named step": { steps: [{ name: "Named", prompt: "a" }] },
            "a disabled step": { steps: [{ enabled: false, prompt: "a" }] },
            "an output key": { steps: [{ prompt: "a", outputKey: "k" }] },
        };
        for (const [label, input] of Object.entries(lossy)) {
            const preset = createTranslatorPreset("P", input);
            const encoded = await encodeTranslatorPresetFile(preset);
            expect(fileOf(encoded).version, label).toBe(2);
            expect(withoutIds(await decodeTranslatorPresetFile(encoded)), label).toStrictEqual(withoutIds(preset));
        }
    });

    it("reads a version 2 payload only in its exact shape at every level, and names a blank import", async () => {
        const valid = { name: "V2", steps: [stepPayload(), stepPayload({ outputKey: "k_1", enabled: false })] };
        const decoded = await decodeTranslatorPresetFile(fileWith(2, valid));
        expect(withoutIds(decoded)).toStrictEqual(withoutIds(createTranslatorPreset("V2", { steps: valid.steps })));
        expect(decoded.steps[1].outputKey).toBe("k_1");
        expect(await decodeTranslatorPresetFile(fileWith(2, { ...valid, name: "  " }))).toMatchObject({
            name: "Imported Preset",
        });

        const refused: Record<string, unknown> = {
            // The Fastify fork's file carries the preset's own fields beside the steps (decision 8).
            "a Fastify-shaped payload": { ...valid, prompt: "p", maxResponse: 1 },
            "a preset id": { ...valid, id: "keep-me" },
            "a missing name": { steps: valid.steps },
            "a non-string name": { ...valid, name: 3 },
            "no steps": { name: "V2", steps: [] },
            "six steps": { name: "V2", steps: Array.from({ length: 6 }, () => stepPayload()) },
            "steps not a list": { name: "V2", steps: stepPayload() },
            "a step id": { name: "V2", steps: [stepPayload({ id: "s-1" })] },
            "a step without a model": { name: "V2", steps: [{ ...stepPayload(), model: undefined }] },
            "a step missing enabled": { name: "V2", steps: [{ ...stepPayload(), enabled: undefined }] },
            "a non-boolean enabled": { name: "V2", steps: [stepPayload({ enabled: 1 })] },
            "a non-string prompt": { name: "V2", steps: [stepPayload({ prompt: null })] },
            "a non-finite size": { name: "V2", steps: [stepPayload({ maxResponse: Infinity })] },
            "a string size": { name: "V2", steps: [stepPayload({ maxResponse: "100" })] },
            "an unknown step field": { name: "V2", steps: [stepPayload({ extra: true })] },
            "an unknown model mode": { name: "V2", steps: [stepPayload({ model: { mode: "slot" } })] },
            "a profile model without an id": { name: "V2", steps: [stepPayload({ model: { mode: "profile" } })] },
            "a profile model with an empty id": {
                name: "V2",
                steps: [stepPayload({ model: { mode: "profile", profileId: "" } })],
            },
            "an inherit model with extra fields": {
                name: "V2",
                steps: [stepPayload({ model: { mode: "inherit", profileId: "x" } })],
            },
            "an invalid output key": { name: "V2", steps: [stepPayload({ outputKey: "1bad" })] },
            "a non-string output key": { name: "V2", steps: [stepPayload({ outputKey: 5 })] },
            "a repeated output key": {
                name: "V2",
                steps: [stepPayload({ outputKey: "k" }), stepPayload({ outputKey: "k" })],
            },
            "a version 1 payload": { name: "V1", prompt: "p", maxResponse: 1 },
        };
        for (const [label, payload] of Object.entries(refused)) {
            await expect(decodeTranslatorPresetFile(fileWith(2, payload)), label).rejects.toThrow(INVALID);
        }
        // The version is the container's: a version 1 container holds no steps, and no other version exists.
        await expect(decodeTranslatorPresetFile(fileWith(1, valid))).rejects.toThrow(INVALID);
        await expect(decodeTranslatorPresetFile(fileWith(3, valid))).rejects.toThrow(INVALID);
        await expect(decodeTranslatorPresetFile(fileWith(2, "not a record"))).rejects.toThrow(INVALID);
    });

    // Translation slice 3.2: version 2 carries Send Text As-Is as an optional boolean, written only
    // when it is on; version 1 cannot hold it, so a version 1 payload carrying it is refused.
    it("writes sendTextAsIs: true as version 2, even for the lone default step, reads it back, and writes nothing of it when off", async () => {
        const on = createTranslatorPreset("On", { prompt: "a", maxResponse: 7, sendTextAsIs: true });
        const encoded = await encodeTranslatorPresetFile(on);
        const file = fileOf(encoded);
        expect(file.version).toBe(2);
        expect(file.payload).toStrictEqual({
            name: "On",
            steps: [{ name: "Step 1", enabled: true, prompt: "a", maxResponse: 7, model: { mode: "inherit" } }],
            sendTextAsIs: true,
        });
        const decoded = await decodeTranslatorPresetFile(encoded);
        expect(decoded.sendTextAsIs).toBe(true);
        expect(withoutIds(decoded)).toStrictEqual(withoutIds(on));
        expect(fileOf(await encodeTranslatorPresetFile(decoded)).payload).toStrictEqual(file.payload);

        // Off, a stray `false` included: the version 1 file of before for the default lone step, and
        // no key at all in a version 2 payload.
        const off = { ...createTranslatorPreset("Off", { prompt: "a", maxResponse: 7 }), sendTextAsIs: false };
        expect(fileOf(await encodeTranslatorPresetFile(off))).toMatchObject({
            version: 1,
            payload: { name: "Off", prompt: "a", maxResponse: 7 },
        });
        const twoOff = createTranslatorPreset("Two", { steps: [{ prompt: "a" }, { prompt: "b" }] });
        expect(Object.hasOwn(fileOf(await encodeTranslatorPresetFile(twoOff)).payload, "sendTextAsIs")).toBe(false);
    });

    it("reads a version 2 flag only as a boolean (false is off), refuses an own undefined, null, or other value, and refuses a version 1 payload carrying it while tolerating other extra keys", async () => {
        const valid = { name: "V2", steps: [stepPayload()] };
        expect((await decodeTranslatorPresetFile(fileWith(2, { ...valid, sendTextAsIs: true }))).sendTextAsIs).toBe(
            true,
        );
        const off = await decodeTranslatorPresetFile(fileWith(2, { ...valid, sendTextAsIs: false }));
        expect(Object.hasOwn(off, "sendTextAsIs")).toBe(false);
        expect(withoutIds(off)).toStrictEqual(withoutIds(createTranslatorPreset("V2", { steps: valid.steps })));
        // msgpack keeps an own key whose value is undefined: present, so not a boolean.
        expect(Object.hasOwn(decodeMsgpack(encodeMsgpack({ ...valid, sendTextAsIs: undefined })), "sendTextAsIs")).toBe(
            true,
        );
        const invalid: Record<string, unknown> = {
            undefined: undefined,
            null: null,
            number: 1,
            string: "true",
            object: {},
        };
        for (const [label, value] of Object.entries(invalid)) {
            await expect(
                decodeTranslatorPresetFile(fileWith(2, { ...valid, sendTextAsIs: value })),
                label,
            ).rejects.toThrow(INVALID);
        }

        // Version 1: an id or another extra key of an older writer is tolerated; the flag is not,
        // whatever its value (the file would otherwise import with the option silently off).
        const v1 = { name: "V1", prompt: "p", maxResponse: 1 };
        expect(withoutIds(await decodeTranslatorPresetFile(fileWith(1, { ...v1, id: "old", extra: 1 })))).toStrictEqual(
            withoutIds(createTranslatorPreset("V1", v1)),
        );
        for (const value of [true, false, undefined, null]) {
            await expect(
                decodeTranslatorPresetFile(fileWith(1, { ...v1, sendTextAsIs: value })),
                String(value),
            ).rejects.toThrow(INVALID);
        }
    });

    // Translation slice 3.4: Exclude Chain-of-Thought rides in version 2 as Send Text As-Is does,
    // written only when on and after it; version 1 cannot hold it.
    it("writes excludeThoughts: true as version 2, even for the lone default step, after sendTextAsIs when both are on, reads it back, and writes nothing of it when off", async () => {
        const on = createTranslatorPreset("On", { prompt: "a", maxResponse: 7, excludeThoughts: true });
        const encoded = await encodeTranslatorPresetFile(on);
        const file = fileOf(encoded);
        expect(file.version).toBe(2);
        expect(file.payload).toStrictEqual({
            name: "On",
            steps: [{ name: "Step 1", enabled: true, prompt: "a", maxResponse: 7, model: { mode: "inherit" } }],
            excludeThoughts: true,
        });
        const decoded = await decodeTranslatorPresetFile(encoded);
        expect(decoded.excludeThoughts).toBe(true);
        expect(Object.hasOwn(decoded, "sendTextAsIs")).toBe(false);
        expect(withoutIds(decoded)).toStrictEqual(withoutIds(on));
        expect(fileOf(await encodeTranslatorPresetFile(decoded)).payload).toStrictEqual(file.payload);

        const both = createTranslatorPreset("Both", {
            prompt: "a",
            maxResponse: 7,
            sendTextAsIs: true,
            excludeThoughts: true,
        });
        const bothEncoded = await encodeTranslatorPresetFile(both);
        expect(Object.keys(fileOf(bothEncoded).payload)).toEqual(["name", "steps", "sendTextAsIs", "excludeThoughts"]);
        expect(withoutIds(await decodeTranslatorPresetFile(bothEncoded))).toStrictEqual(withoutIds(both));

        // Off, a stray `false` included: the version 1 file of before for the default lone step, and
        // no key at all in a version 2 payload.
        const off = { ...createTranslatorPreset("Off", { prompt: "a", maxResponse: 7 }), excludeThoughts: false };
        expect(fileOf(await encodeTranslatorPresetFile(off))).toMatchObject({
            version: 1,
            payload: { name: "Off", prompt: "a", maxResponse: 7 },
        });
        const twoOff = createTranslatorPreset("Two", { steps: [{ prompt: "a" }, { prompt: "b" }] });
        expect(Object.hasOwn(fileOf(await encodeTranslatorPresetFile(twoOff)).payload, "excludeThoughts")).toBe(false);
    });

    it("reads a version 2 excludeThoughts only as a boolean (false is off), refuses an own undefined, null, or other value, and refuses a version 1 payload carrying it", async () => {
        const valid = { name: "V2", steps: [stepPayload()] };
        expect(
            (await decodeTranslatorPresetFile(fileWith(2, { ...valid, excludeThoughts: true }))).excludeThoughts,
        ).toBe(true);
        const off = await decodeTranslatorPresetFile(fileWith(2, { ...valid, excludeThoughts: false }));
        expect(Object.hasOwn(off, "excludeThoughts")).toBe(false);
        expect(withoutIds(off)).toStrictEqual(withoutIds(createTranslatorPreset("V2", { steps: valid.steps })));
        const invalid: Record<string, unknown> = {
            undefined: undefined,
            null: null,
            number: 1,
            string: "true",
            object: {},
        };
        for (const [label, value] of Object.entries(invalid)) {
            await expect(
                decodeTranslatorPresetFile(fileWith(2, { ...valid, excludeThoughts: value })),
                label,
            ).rejects.toThrow(INVALID);
        }
        const v1 = { name: "V1", prompt: "p", maxResponse: 1 };
        for (const value of [true, false, undefined, null]) {
            await expect(
                decodeTranslatorPresetFile(fileWith(1, { ...v1, excludeThoughts: value })),
                String(value),
            ).rejects.toThrow(INVALID);
        }
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
