import { kMaxLength } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { compressSync } from "fflate";
import { Packr, Unpackr } from "msgpackr";

/**
 * The upstream RisuAI database codec (`database.risudat` of an upstream `.bin` backup), matching
 * upstream's `src/ts/storage/risuSave.ts` (`encodeRisuSaveLegacy`, `decodeRisuSave`). A save is an
 * 11-byte header, `\0RISUSAVE\0` and a version byte, then MessagePack of the flat `Database`:
 *
 * - `\x07`: the MessagePack bytes as they are;
 * - `\x08`: gzip of them (`fflate.compressSync`), what every upstream backup writes;
 * - `\x09`: gzip of them made by a `CompressionStream`.
 *
 * Upstream's block format (`RISUSAVE\0` with no leading zero byte) holds live saves, never a
 * backup, and is refused, as is anything else. Both functions are synchronous and pure.
 */

const HEADER_PREFIX = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0]);
const HEADER_BYTES = HEADER_PREFIX.length + 1;
const RAW_VERSION = 7;
const GZIP_VERSION = 8;
const STREAM_GZIP_VERSION = 9;
const BLOCK_HEADER = new Uint8Array([82, 73, 83, 85, 83, 65, 86, 69, 0]);
/** gzip member header (10 bytes) and trailer (CRC-32 and ISIZE, 8 bytes). */
const GZIP_MIN_BYTES = 18;

export type UpstreamSaveFormat = "raw" | "gzip" | "streamGzip" | "block" | "unknownVersion" | "headerless";

const FORMAT_NAMES: Record<UpstreamSaveFormat, string> = {
    raw: "RisuAI save (uncompressed, version 7)",
    gzip: "RisuAI save (gzip, version 8)",
    streamGzip: "RisuAI save (stream gzip, version 9)",
    block: "RisuAI block save (RISUSAVE), which only live saves use",
    unknownVersion: "RisuAI save of an unknown version",
    headerless: "data without a RisuAI save header",
};

export class UpstreamFormatError extends Error {
    readonly format: UpstreamSaveFormat;

    constructor(format: UpstreamSaveFormat, message: string) {
        super(message);
        this.name = "UpstreamFormatError";
        this.format = format;
    }
}

/** A decoded upstream `Database`: only its `characters` list is checked here. */
export type UpstreamDatabase = { characters: unknown[]; [key: string]: unknown };

// Upstream's options. `useRecords: false` also makes maps decode as plain objects; `undefined`
// (fixext type 0) decodes as `undefined`. `int64AsType: "number"` reads a 64-bit integer as a number:
// upstream's `\x08` reader uses msgpackr's default `decode`, which gives a BigInt, but upstream's
// encoder writes an integer past 32 bits as a float64, so only a BigInt in the database (none in
// upstream's `Database`) decodes differently, rounded to a number. `copyBuffers` keeps a binary
// value from holding the whole inflated database in memory; the decoded values are the same. The
// byte cap alone does not bound the decode's allocations: msgpackr 2 refuses an array or map header
// longer than the bytes left, but nested headers each preallocate up to that, so a caller decoding
// untrusted data runs it under a heap limit (the import worker's `resourceLimits`).
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false, int64AsType: "number", copyBuffers: true });

function detectFormat(bytes: Uint8Array): UpstreamSaveFormat {
    if (startsWith(bytes, BLOCK_HEADER)) {
        return "block";
    }
    if (bytes.length < HEADER_BYTES || !startsWith(bytes, HEADER_PREFIX)) {
        return "headerless";
    }
    switch (bytes[HEADER_PREFIX.length]) {
        case RAW_VERSION:
            return "raw";
        case GZIP_VERSION:
            return "gzip";
        case STREAM_GZIP_VERSION:
            return "streamGzip";
        default:
            return "unknownVersion";
    }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
    if (bytes.length < prefix.length) {
        return false;
    }
    for (let i = 0; i < prefix.length; i++) {
        if (bytes[i] !== prefix[i]) {
            return false;
        }
    }
    return true;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Inflates a gzip payload with `node:zlib`, which checks the CRC-32 and ISIZE of every member and
 * stops past `maxOutputLength`, so damaged data is refused and the output never exceeds the cap.
 * For any gzip stream upstream writes (one member, `fflate.compressSync` or `CompressionStream`) the
 * bytes are the ones upstream's `fflate.decompressSync` or `DecompressionStream` gives. Unlike
 * upstream's `\x08` reader, which trusts the last ISIZE field and accepts a bad CRC, concatenated
 * members are all inflated, and bytes after the last member are ignored when they start with a zero
 * byte (other trailing bytes are refused as damaged gzip). A zlib or raw deflate payload, which
 * `decompressSync` would also take, is refused as not gzip.
 */
function inflate(format: UpstreamSaveFormat, payload: Uint8Array, maxDecodedBytes: number): Uint8Array {
    if (payload.length < GZIP_MIN_BYTES || payload[0] !== 0x1f || payload[1] !== 0x8b || payload[2] !== 8) {
        throw new UpstreamFormatError(format, `${FORMAT_NAMES[format]}: the payload is not gzip data`);
    }
    let inflated: Buffer;
    try {
        inflated = gunzipSync(payload, {
            maxOutputLength: Math.max(1, Math.min(maxDecodedBytes, kMaxLength)),
        });
    } catch (error) {
        if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
            throw new UpstreamFormatError(
                format,
                `${FORMAT_NAMES[format]}: the database is over the limit of ${maxDecodedBytes} bytes decoded`,
            );
        }
        throw new UpstreamFormatError(
            format,
            `${FORMAT_NAMES[format]}: the gzip data is damaged (${errorMessage(error)})`,
        );
    }
    // A plain `Uint8Array` view, so binary values decode as `Uint8Array` as they do upstream, not `Buffer`.
    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Decodes `database.risudat`. Throws `UpstreamFormatError` for any other format, damaged data, a
 * database over `maxDecodedBytes` of MessagePack, or a root that is not an object with a
 * `characters` list.
 */
export function decodeUpstreamDatabase(bytes: Uint8Array, options: { maxDecodedBytes: number }): UpstreamDatabase {
    const format = detectFormat(bytes);
    if (format !== "raw" && format !== "gzip" && format !== "streamGzip") {
        throw new UpstreamFormatError(format, `Not a RisuAI database: ${FORMAT_NAMES[format]}`);
    }
    const payload = bytes.subarray(HEADER_BYTES);
    let packed: Uint8Array;
    if (format === "raw") {
        if (payload.length > options.maxDecodedBytes) {
            throw new UpstreamFormatError(
                format,
                `${FORMAT_NAMES[format]}: the database is ${payload.length} bytes, over the limit of ${options.maxDecodedBytes} bytes`,
            );
        }
        packed = payload;
    } else {
        packed = inflate(format, payload, options.maxDecodedBytes);
    }
    let root: unknown;
    try {
        root = unpackr.unpack(packed);
    } catch (error) {
        throw new UpstreamFormatError(
            format,
            `${FORMAT_NAMES[format]}: the MessagePack data is damaged (${errorMessage(error)})`,
        );
    }
    if (!isPlainObject(root) || !Array.isArray(root.characters)) {
        throw new UpstreamFormatError(format, `${FORMAT_NAMES[format]}: not a RisuAI database (no characters list)`);
    }
    return root as UpstreamDatabase;
}

/**
 * Encodes a flat upstream `Database` as upstream's `encodeRisuSaveLegacy(db, "compression")` does
 * (upstream locks msgpackr 1.10.1, whose Node encoder throws on Node 23 and later for a string of 64
 * characters or more; msgpackr 2.0.6 here writes the same bytes for the values a `Database` holds):
 * MessagePack with `useRecords: false`, `fflate.compressSync` (gzip, default level, the current
 * time as the header's mtime), and the version 8 header.
 */
export function encodeUpstreamDatabase(db: unknown): Uint8Array {
    const compressed = compressSync(packr.pack(db));
    const result = new Uint8Array(HEADER_BYTES + compressed.length);
    result.set(HEADER_PREFIX, 0);
    result[HEADER_PREFIX.length] = GZIP_VERSION;
    result.set(compressed, HEADER_BYTES);
    return result;
}
