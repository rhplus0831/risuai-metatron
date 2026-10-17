/**
 * The rpack codec: a simple obfuscation file format first made for resource packs of some
 * closed-source software and kept in Risuai for compatibility (`src/ts/rpack/README`). It is a
 * byte-for-byte substitution over a 512-byte map: the first 256 bytes encode, the last 256 decode.
 * `.risum` modules, preset files, and translator presets use it.
 *
 * The map is inlined from `src/ts/rpack/rpack_map.bin`, which stays the source of truth
 * (`shared/tests/rpack.test.ts` compares the two). The vendored directory's license files
 * (`src/ts/rpack/LICENSE`, `LICENSE_MIT`, `LICENSE_AGPL`) cover this code and the map.
 *
 * Synchronous and dependency-free so the client (`src/ts/rpack/rpack_js.js` re-exports it) and the
 * self-host server can both import it.
 */

/** `rpack_map.bin` as 1024 hex characters, 32 bytes per chunk. */
export const RPACK_MAP_HEX = [
    // Encode table (bytes 0..255).
    "c40d1e0bbd2b3f55fc456ef566534f1ae0bb309486ba6bbf41506f9befdeb710",
    "611720df3289a89d6dabc990000c5dafd2c156e516649182657497ca23d652d1",
    "ffb4a0e82f8a58385a60199649dbd7c83b3e434ba56347aa6a2992f415cf6234",
    "78d31d3ce2058e2a570e1bcd4c2df2402c2579480fb27ab5a76c37e69c7b547e",
    "fe87dc9a02e433a2ebb12e03dd99a6b0e7d58818837cf6bee15c9fc321461f08",
    "4ed076125feefd8f44eaa35e8b2809359e69cc0ac78507ad4af377e967d4da84",
    "8093b64d73fa27267f04c6fbf1723951c236a968acf8edc5b9cbce75a43d81d9",
    "42701c9511bcd88c98f959a113f7147db3ec71c0e38df001ae5b310624223ab8",
    // Decode table (bytes 256..511).
    "2cf7848bc965fbb69faeb3032d0169741fe4a3ecee5c3421934a0f6ae262029e",
    "229cfd3cfc71c7c6ad596705706d8a4412fa24865fafd17a47cefe5063dd5106",
    "6f18e052a8099d56734cb8536cc3a00e19cf3e0d7e07326846ea48f9992eaba4",
    "49205e5535380cbcd3b1581679280a1ae1f2cdc439dba2ba6072767d95ef7fc8",
    "c0de3794bfb51481922545ace7f566a72b365ac113e34b3ae88d831b7c27b09a",
    "42eb87aadc548e7826d25729d4b7f82f8f8975f04177c21effd81511e5049717",
    "f331d09b00d7cab44f2a3bd9b26bda5da13f3061bd913d4ee6dfbe4d828c1d23",
    "109864f485337b9043bba988f1d6a51cf6cc6eb95b0b96edd5e9c5cb08a68040",
].join("");

function parseHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** The 512-byte map: `[0, 256)` encodes, `[256, 512)` decodes. */
export const RPACK_MAP: Uint8Array = parseHex(RPACK_MAP_HEX);

const ENCODE_MAP = RPACK_MAP.subarray(0, 256);
const DECODE_MAP = RPACK_MAP.subarray(256, 512);

function mapBytes(map: Uint8Array, data: Uint8Array, out: Uint8Array): Uint8Array {
    for (let i = 0; i < data.length; i++) {
        out[i] = map[data[i]];
    }
    return out;
}

/** A new array of `data.length` bytes, byte `i` being `RPACK_MAP[data[i]]`. */
export function encodeRPack(data: Uint8Array): Uint8Array {
    return mapBytes(ENCODE_MAP, data, new Uint8Array(data.length));
}

/** A new array of `data.length` bytes, byte `i` being `RPACK_MAP[256 + data[i]]`. */
export function decodeRPack(data: Uint8Array): Uint8Array {
    return mapBytes(DECODE_MAP, data, new Uint8Array(data.length));
}

/** `encodeRPack` written back into `data` (a buffer the caller owns); returns `data`. */
export function encodeRPackInPlace(data: Uint8Array): Uint8Array {
    return mapBytes(ENCODE_MAP, data, data);
}

/** `decodeRPack` written back into `data` (a buffer the caller owns); returns `data`. */
export function decodeRPackInPlace(data: Uint8Array): Uint8Array {
    return mapBytes(DECODE_MAP, data, data);
}
