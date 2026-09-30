import * as fflate from "fflate";
import { decode as decodeMsgpack } from "msgpackr/index-no-eval";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Phase 3, slice 7 (`docs/plan/phases/slices/phase-3-settings-sections/credentials-and-closeout.md`,
// "`.risup` round trip": `.risutl` gets the same decoded round trip). `presets.test.ts` mocks the
// encryption and RPack to identity; this file runs the real codecs (WebCrypto `encryptBuffer` and
// `decryptBuffer`, the RPack byte map from disk, `fflate`, msgpack) and decodes the file the way
// `decodeTranslatorPresetFile` does, to pin the on-disk contract: the container
// `{ translatorPresetVersion: 1, type: "translator-preset", preset }` and a preset payload of exactly
// `name`, `prompt`, and `maxResponse`, never an `id` (D5; the pre-phase container is the same).

// As in the browser, the `buffer` polyfill is the global `Buffer` before msgpackr loads (see
// `src/ts/storage/tests/presetIds.test.ts`).
await vi.hoisted(async () => {
    const { Buffer: BufferPolyfill } = await import("buffer");
    (globalThis as any).Buffer = BufferPolyfill;
});

// `src/ts/util` reaches `database.svelte`, `stores.svelte`, and the parser; nothing here needs them.
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/alert", () => ({ alertNormal: vi.fn(), alertError: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

// The real RPack loads its byte map with `fetch` of a Vite `?url` asset; here the map comes from disk.
vi.mock("src/ts/rpack/rpack_js.js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "../rpack/rpack_map.bin")));
    const encodeMap = map.slice(0, 256);
    const decodeMap = map.slice(256, 512);
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(encodeMap), decodeRPack: apply(decodeMap) };
});

import { decodeRPack } from "src/ts/rpack/rpack_js.js";
import { decryptBuffer } from "src/ts/util";
import { createTranslatorPreset, decodeTranslatorPresetFile, encodeTranslatorPresetFile } from "./presets";

/** The preset payload a `.risutl` file carries, decoded the way `decodeTranslatorPresetFile` decodes it. */
async function decodeRisutl(bytes: Uint8Array): Promise<Record<string, unknown>> {
    const container = decodeMsgpack(fflate.decompressSync(await decodeRPack(bytes)));
    expect(Object.keys(container).sort()).toEqual(["preset", "translatorPresetVersion", "type"]);
    expect(container).toMatchObject({ translatorPresetVersion: 1, type: "translator-preset" });
    expect(container.preset).toBeInstanceOf(Uint8Array);
    return decodeMsgpack(new Uint8Array(await decryptBuffer(container.preset, "risutl")));
}

describe(".risutl round trip through the real codecs", () => {
    it("encodes exactly name, prompt, and maxResponse, and decodes to the same preset under a fresh id, over two cycles", async () => {
        const preset = createTranslatorPreset("번역 ✓ Preset", {
            prompt: "Translate {{slot}} into {{language}}.\n\nKeep the tone.",
            maxResponse: 2048,
        });
        expect(preset.id).toEqual(expect.any(String));

        const bytes = await encodeTranslatorPresetFile(preset);
        expect(bytes).toBeInstanceOf(Uint8Array);
        const payload = await decodeRisutl(bytes);
        expect(payload).toStrictEqual({
            name: "번역 ✓ Preset",
            prompt: "Translate {{slot}} into {{language}}.\n\nKeep the tone.",
            maxResponse: 2048,
        });
        expect(Object.hasOwn(payload, "id")).toBe(false);

        const decoded = await decodeTranslatorPresetFile(bytes);
        const { id: decodedId, ...decodedWithoutId } = decoded;
        const { id: originalId, ...presetWithoutId } = preset;
        expect(decodedWithoutId).toStrictEqual(presetWithoutId);
        expect(decodedId).toEqual(expect.any(String));
        expect(decodedId).not.toBe(originalId);

        // The decoded preset exports to the same payload (the codec is a fixed point on the file).
        const again = await encodeTranslatorPresetFile(decoded);
        expect(await decodeRisutl(again)).toStrictEqual(payload);
        const { id: secondId, ...secondWithoutId } = await decodeTranslatorPresetFile(again);
        expect(secondWithoutId).toStrictEqual(presetWithoutId);
        expect(secondId).not.toBe(decodedId);
    });

    it("rejects a file whose payload is not a translator preset, after the real decryption", async () => {
        const preset = createTranslatorPreset("P", { prompt: "x", maxResponse: 1 });
        const bytes = await encodeTranslatorPresetFile(preset);
        // Corrupt the RPack-encoded bytes: the decryption or the msgpack decode must fail cleanly.
        const corrupt = new Uint8Array(bytes);
        corrupt[corrupt.length - 1] ^= 0xff;
        corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
        await expect(decodeTranslatorPresetFile(corrupt)).rejects.toThrow("Invalid translator preset file.");
    });
});
