// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    decodeRPack,
    decodeRPackInPlace,
    encodeRPack,
    encodeRPackInPlace,
    RPACK_MAP,
    RPACK_MAP_HEX,
} from "../rpack.ts";

// The vendored binary is the independent source of truth, not the inlined map.
const vendoredMap = readFileSync(new URL("../../src/ts/rpack/rpack_map.bin", import.meta.url));
const allBytes = Uint8Array.from({ length: 256 }, (_, byte) => byte);
// Visit every byte twice in a different order to exercise lookup by value and repeated bytes.
const payload = Uint8Array.from({ length: 512 }, (_, index) => (index * 73 + 19) % 256);

describe("shared rpack codec", () => {
    it("exports the vendored 512-byte map and its hex literal", () => {
        expect(vendoredMap).toHaveLength(512);
        expect(RPACK_MAP_HEX.toLowerCase()).toBe(vendoredMap.toString("hex"));
        expect(RPACK_MAP).toBeInstanceOf(Uint8Array);
        expect(RPACK_MAP).toEqual(new Uint8Array(vendoredMap));
    });

    it("maps every byte synchronously into a new array without changing the input", () => {
        for (const [transform, offset] of [
            [encodeRPack, 0],
            [decodeRPack, 256],
        ] as const) {
            for (const original of [payload, new Uint8Array()]) {
                const input = original.slice();
                const expected = Uint8Array.from(original, (byte) => vendoredMap[offset + byte]);
                const result = transform(input);

                expect(result).toBeInstanceOf(Uint8Array);
                expect(result).not.toBe(input);
                expect(result).toHaveLength(original.length);
                expect(result).toEqual(expected);
                expect(input).toEqual(original);
                if (result.length > 0) {
                    result[0] ^= 0xff;
                    expect(input).toEqual(original);
                }
            }
        }
    });

    it("decoding undoes encoding for every byte value", () => {
        expect(decodeRPack(encodeRPack(allBytes))).toEqual(allBytes);
    });

    it("maps borrowed views in place and returns the same input", () => {
        for (const [transform, offset] of [
            [encodeRPackInPlace, 0],
            [decodeRPackInPlace, 256],
        ] as const) {
            for (const original of [payload, new Uint8Array()]) {
                const backing = new Uint8Array([0x12, ...original, 0x34]);
                const input = backing.subarray(1, backing.length - 1);
                const expected = Uint8Array.from(original, (byte) => vendoredMap[offset + byte]);

                expect(transform(input)).toBe(input);
                expect(input).toEqual(expected);
                expect(backing).toEqual(new Uint8Array([0x12, ...expected, 0x34]));
            }
        }
    });

    it("re-exports the shared functions at the legacy client path", async () => {
        // Import at runtime: the legacy JS entrypoint has no TypeScript declaration.
        const legacyClientPath = "../../src/ts/rpack/rpack_js.js";
        const legacy = await import(legacyClientPath);
        expect(legacy.encodeRPack).toBe(encodeRPack);
        expect(legacy.decodeRPack).toBe(decodeRPack);
    });
});
