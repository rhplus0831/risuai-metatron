import { kMaxLength } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { compressSync } from "fflate";
import { Packr, Unpackr } from "msgpackr";

/**
 * The upstream RisuAI database codec (`database.risudat` of an upstream `.bin` backup), matching
 * upstream's `src/ts/storage/risuSave.ts` (`encodeRisuSave`, `encodeRisuSaveLegacy`, `decodeRisuSave`).
 * Legacy saves have an 11-byte header, `\0RISUSAVE\0` and a version byte, then MessagePack of the
 * flat `Database`:
 *
 * - `\x07`: the MessagePack bytes as they are;
 * - `\x08`: gzip of them (`fflate.compressSync`), what older upstream backups and this app's
 *   RisuAI-compatible export write;
 * - `\x09`: gzip of them made by a `CompressionStream`.
 *
 * Current upstream backups use blocks (`RISUSAVE\0` with no leading zero byte), each with JSON
 * content and optional independent gzip compression. Self-contained block saves are accepted;
 * live saves referring to external blocks are refused. The codec is synchronous and pure.
 */

const HEADER_PREFIX = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0]);
const HEADER_BYTES = HEADER_PREFIX.length + 1;
const RAW_VERSION = 7;
const GZIP_VERSION = 8;
const STREAM_GZIP_VERSION = 9;
const BLOCK_HEADER = new Uint8Array([82, 73, 83, 85, 83, 65, 86, 69, 0]);
const BLOCK_TYPE = {
    CONFIG: 0,
    ROOT: 1,
    CHARACTER_WITH_CHAT: 2,
    BOTPRESET: 4,
    MODULES: 5,
    REMOTE: 6,
    CHARACTER_WITHOUT_CHAT: 7,
    ROOT_COMPONENT: 8,
    PLUGINS: 9,
    LOADOUTS: 10,
    PLUGIN_STORAGE: 11,
    KV: 12,
} as const;
const OPTIONAL_BLOCK_FIELDS: Partial<Record<number, string>> = {
    [BLOCK_TYPE.BOTPRESET]: "botPresets",
    [BLOCK_TYPE.MODULES]: "modules",
    [BLOCK_TYPE.PLUGINS]: "plugins",
    [BLOCK_TYPE.LOADOUTS]: "loadouts",
    [BLOCK_TYPE.PLUGIN_STORAGE]: "pluginCustomStorage",
};
/** gzip member header (10 bytes) and trailer (CRC-32 and ISIZE, 8 bytes). */
const GZIP_MIN_BYTES = 18;

export type UpstreamSaveFormat = "raw" | "gzip" | "streamGzip" | "block" | "unknownVersion" | "headerless";

const FORMAT_NAMES: Record<UpstreamSaveFormat, string> = {
    raw: "RisuAI save (uncompressed, version 7)",
    gzip: "RisuAI save (gzip, version 8)",
    streamGzip: "RisuAI save (stream gzip, version 9)",
    block: "RisuAI block save (RISUSAVE)",
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

export type UpstreamSave = { database: UpstreamDatabase; kv: Record<string, unknown> };

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
function inflate(
    format: UpstreamSaveFormat,
    payload: Uint8Array,
    maxDecodedBytes: number,
    totalDecodedBytes = maxDecodedBytes,
): Uint8Array {
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
                `${FORMAT_NAMES[format]}: the database is over the limit of ${totalDecodedBytes} bytes decoded`,
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

/** Decodes only the database from `database.risudat`, without its separate SaveKV namespaces. */
export function decodeUpstreamDatabase(bytes: Uint8Array, options: { maxDecodedBytes: number }): UpstreamDatabase {
    return decodeUpstreamSave(bytes, options).database;
}

/**
 * Decodes `database.risudat` and its SaveKV namespaces (empty for legacy saves). Throws
 * `UpstreamFormatError` for an unsupported format, damaged or external data, a database over the
 * byte cap, or a root that is not an object with a `characters` list. The cap charges MessagePack
 * bytes for legacy saves, and framing plus the larger of stored and decoded data for each block.
 */
export function decodeUpstreamSave(bytes: Uint8Array, options: { maxDecodedBytes: number }): UpstreamSave {
    const format = detectFormat(bytes);
    const decoded =
        format === "block"
            ? decodeBlocks(bytes, options.maxDecodedBytes)
            : { database: decodeLegacyDatabase(bytes, format, options), kv: {} };
    if (!isPlainObject(decoded.database) || !Array.isArray(decoded.database.characters)) {
        throw new UpstreamFormatError(format, `${FORMAT_NAMES[format]}: not a RisuAI database (no characters list)`);
    }
    return decoded as UpstreamSave;
}

function decodeLegacyDatabase(
    bytes: Uint8Array,
    format: UpstreamSaveFormat,
    options: { maxDecodedBytes: number },
): unknown {
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
    return root;
}

type SaveBlock = { type: number; name: string; data: Uint8Array };

function blockError(message: string): UpstreamFormatError {
    return new UpstreamFormatError("block", `${FORMAT_NAMES.block}: ${message}`);
}

function parseBlock(block: SaveBlock): unknown {
    try {
        return JSON.parse(new TextDecoder().decode(block.data));
    } catch (error) {
        throw blockError(`block "${block.name}" is damaged (${errorMessage(error)})`);
    }
}

/** Dynamic keys, including `__proto__`, stay data properties without changing the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function decodeBlocks(bytes: Uint8Array, maxDecodedBytes: number) {
    const blocks: SaveBlock[] = [];
    const names = new Set<string>();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = BLOCK_HEADER.length;
    let remaining = maxDecodedBytes;
    const overLimit = () => blockError(`the database is over the limit of ${maxDecodedBytes} bytes decoded`);
    while (offset < bytes.length) {
        if (bytes.length - offset < 3) {
            throw blockError("truncated block header");
        }
        const type = bytes[offset++];
        const compressed = bytes[offset++] === 1;
        const nameLength = bytes[offset++];
        if (nameLength > bytes.length - offset) {
            throw blockError("truncated block name");
        }
        const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));
        offset += nameLength;
        if (bytes.length - offset < 4) {
            throw blockError(`truncated length field for block "${name}"`);
        }
        const storedLength = view.getUint32(offset, true);
        offset += 4;
        if (storedLength > bytes.length - offset) {
            throw blockError(`truncated data for block "${name}"`);
        }
        remaining -= 7 + nameLength;
        if (storedLength > remaining) {
            throw overLimit();
        }
        const stored = bytes.subarray(offset, offset + storedLength);
        offset += storedLength;
        const data = compressed ? inflate("block", stored, remaining, maxDecodedBytes) : stored;
        remaining -= Math.max(storedLength, data.length);
        if (remaining < 0) {
            throw overLimit();
        }
        blocks.push({ type, name, data });
        names.add(name);
    }

    const database: Record<string, unknown> = {};
    const kv: Record<string, unknown> = {};
    let hasRoot = false;
    for (const block of blocks) {
        const field = OPTIONAL_BLOCK_FIELDS[block.type];
        if (field) {
            // Upstream encodes JSON.stringify(undefined) as empty content for these fields.
            if (block.data.length !== 0) {
                database[field] = parseBlock(block);
            }
            continue;
        }
        switch (block.type) {
            case BLOCK_TYPE.ROOT: {
                const root = parseBlock(block);
                if (!isPlainObject(root)) {
                    throw blockError(`root block "${block.name}" is damaged (not an object)`);
                }
                hasRoot = true;
                if (Array.isArray(root.__directory)) {
                    for (const name of root.__directory) {
                        if (typeof name !== "string" || !names.has(name)) {
                            throw blockError(
                                "the save refers to blocks outside the file (a live save); export a backup from RisuAI instead",
                            );
                        }
                    }
                }
                for (const key of Object.keys(root)) {
                    if (!key.startsWith("__") && (!Object.hasOwn(database, key) || !database[key])) {
                        setOwn(database, key, root[key]);
                    }
                }
                break;
            }
            case BLOCK_TYPE.CHARACTER_WITH_CHAT:
            case BLOCK_TYPE.CHARACTER_WITHOUT_CHAT: {
                const character = parseBlock(block);
                database.characters ??= [];
                if (!Array.isArray(database.characters)) {
                    throw blockError(`block "${block.name}" is damaged (characters is not a list)`);
                }
                database.characters.push(character);
                break;
            }
            case BLOCK_TYPE.ROOT_COMPONENT: {
                const component = parseBlock(block);
                if (!isPlainObject(component) || typeof component.key !== "string") {
                    throw blockError(`root component "${block.name}" is damaged (no string key)`);
                }
                setOwn(database, component.key, component.data);
                break;
            }
            case BLOCK_TYPE.KV:
                if (block.name.startsWith("kv:")) {
                    setOwn(kv, block.name.slice(3), parseBlock(block));
                }
                break;
            case BLOCK_TYPE.CONFIG:
                break;
            case BLOCK_TYPE.REMOTE:
                throw blockError(
                    `the file is a live save whose data (block "${block.name}") is stored outside it, so it cannot be imported; export a backup from RisuAI instead`,
                );
            default:
                throw blockError(`unknown block type ${block.type} for block "${block.name}"`);
        }
    }
    if (!hasRoot) {
        throw blockError("the save is damaged (no ROOT block)");
    }
    if (database.characters === undefined) {
        database.characters = [];
    }
    if (!Array.isArray(database.botPresets) || database.botPresets.length === 0) {
        delete database.botPresets;
        database.botPresetsId = 0;
    }
    return { database, kv };
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
