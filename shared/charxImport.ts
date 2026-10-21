/**
 * The CharX character file, a cross-user format (STRUCTURE D5): a zip archive, alone (`.charx`) or
 * after a JPEG (`charxJpeg`, a `.jpg`/`.jpeg`: the JPEG's bytes, then the zip, whose offsets count
 * from the zip's own start). The client's `CharXWriter` (`src/ts/process/processzip.ts`) writes it
 * with fflate: every entry a `ZipDeflate` stream (level 0 for the assets, so their bytes stand in
 * stored deflate blocks), a data descriptor after each (general-purpose flag bit 3: no sizes in the
 * local header), flag bit 11 for a non-ASCII name, and no zip64 (fflate wraps the entry count past
 * 65,535 and every offset past 4 GiB).
 *
 * Two readers read it. The client's in-tab `CharXImporter` runs fflate's streaming `Unzip`, which
 * finds the end of a data-descriptor entry by scanning its bytes for the next signature, so a stored
 * entry whose bytes hold one is cut short (Known Hazards of `docs/structure/characters-modules.md`).
 * The self-host server (`POST /api/import/charx`, `server/src/routes/importCharx.ts`) delimits the
 * entries by the central directory with the parsers below, whatever bytes they hold. Both apply the
 * same entry rules:
 *
 * - `card.json`: the card, as UTF-8 text (`TextDecoder`'s defaults);
 * - `module.risum`: the embedded module's bytes (the client reads them with `readModule`);
 * - any other name ending in `.json` (the exporter's `x_meta/*.json`): ignored;
 * - every other entry: an asset, stored under `assets/<SHA-256 hex of its bytes>.png` (the key the
 *   client's `saveAsset` gives it; the extension is never sniffed) and mapped from its entry name.
 *
 * An entry is excluded, nothing kept or stored for it and its name listed, when its local header
 * declares an uncompressed size of at least `MAX_CHARX_ENTRY_BYTES` (fflate's `originalSize`, known
 * only without a data descriptor) or when its bytes decode to more than that. The server also
 * excludes an entry without reading it when the central directory declares an uncompressed size over
 * `MAX_CHARX_ENTRY_BYTES` or the compressed size is over `MAX_CHARX_COMPRESSED_BYTES`. An entry name
 * decodes as fflate's `strFromU8` decodes it (UTF-8 with flag bit 11, Latin-1 without), so both
 * readers key the asset map alike.
 *
 * The helpers are pure (`Uint8Array`, `DataView`, `TextDecoder`): the server reads the file and hands
 * them its bytes. A record that does not parse throws `CharxFileError`.
 */

/** `POST`: a CharX file as the raw body; the answer is NDJSON `CharxImportLine`s. */
export const CHARX_IMPORT_PATH = "/api/import/charx";
/** The route's `error` text for a file that is not a CharX it can read (a 400, or a failure line once streaming). */
export const INVALID_CHARX_FILE = "Invalid character file";
/** Most bytes of one entry, decoded; a larger entry is excluded. Both readers share it. */
export const MAX_CHARX_ENTRY_BYTES = 50 * 1024 * 1024;
/** Deflate can grow stored data only slightly: a compressed size past this is excluded without being read. */
export const MAX_CHARX_COMPRESSED_BYTES = MAX_CHARX_ENTRY_BYTES + 1024 * 1024;
/** Most bytes of a central directory the server reads (each entry takes at least 46). */
export const MAX_CHARX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
/** Most entries of a CharX the server reads. */
export const MAX_CHARX_ENTRIES = 200_000;

/** The end-of-central-directory record without its comment. */
export const ZIP_END_BYTES = 22;
/** The span at a file's end that holds the end record: the record and a comment of at most 65,535 bytes. */
export const ZIP_END_SEARCH_BYTES = ZIP_END_BYTES + 0xffff;
export const ZIP64_LOCATOR_BYTES = 20;
/** The zip64 end record without its extensible data. */
export const ZIP64_END_BYTES = 56;
/** A local header before its name and extra field. */
export const ZIP_LOCAL_HEADER_BYTES = 30;
/** A central-directory record before its name, extra field, and comment. */
export const ZIP_CENTRAL_HEADER_BYTES = 46;
/** Most bytes of a data descriptor: its signature, the CRC, and two 64-bit sizes. */
export const ZIP_DESCRIPTOR_MAX_BYTES = 24;
/** Offsets of a zip without zip64 are 32-bit fields, wrapped by fflate past 4 GiB. */
export const ZIP_OFFSET_MODULUS = 2 ** 32;

export const ZIP_METHOD_STORED = 0;
export const ZIP_METHOD_DEFLATED = 8;

const END_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EXTRA_ID = 0x0001;
const ENCRYPTED_FLAG = 0x0001;
const DESCRIPTOR_FLAG = 0x0008;
const UTF8_FLAG = 0x0800;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** A file that is not a zip the CharX readers accept. */
export class CharxFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CharxFileError";
    }
}

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A little-endian 64-bit field; one past `Number.MAX_SAFE_INTEGER` is refused. */
function u64(view: DataView, position: number): number {
    const high = view.getUint32(position + 4, true);
    if (high >= 2 ** 21) {
        throw new CharxFileError("A zip64 field is too large");
    }
    return high * 2 ** 32 + view.getUint32(position, true);
}

/** The end-of-central-directory record: where it starts in the file and what it declares. */
export type ZipEnd = {
    /** Its file position. */
    position: number;
    cdSize: number;
    /** The central directory's offset from the zip's start (mod 2^32 for fflate's writer). */
    cdOffset: number;
    /** A field holds its zip64 marker (`0xFFFF`/`0xFFFFFFFF`): a zip64 locator may follow. */
    zip64: boolean;
};

/**
 * Finds the end record in `tail`, the file's last bytes (at most `ZIP_END_SEARCH_BYTES`), which start
 * at file position `tailStart`. It scans back from the end, so the last record whose comment fits
 * wins; one naming another disk (a split archive, or a signature inside a comment) is passed over.
 * Throws `CharxFileError` when there is none.
 */
export function findZipEnd(tail: Uint8Array, tailStart: number): ZipEnd {
    const view = viewOf(tail);
    for (let i = tail.length - ZIP_END_BYTES; i >= 0; i--) {
        if (view.getUint32(i, true) !== END_SIGNATURE) {
            continue;
        }
        if (i + ZIP_END_BYTES + view.getUint16(i + 20, true) > tail.length) {
            continue;
        }
        const disk = view.getUint16(i + 4, true);
        const cdDisk = view.getUint16(i + 6, true);
        if ((disk !== 0 && disk !== U16_MAX) || (cdDisk !== 0 && cdDisk !== U16_MAX)) {
            continue;
        }
        const cdSize = view.getUint32(i + 12, true);
        const cdOffset = view.getUint32(i + 16, true);
        const zip64 =
            disk === U16_MAX ||
            cdDisk === U16_MAX ||
            view.getUint16(i + 8, true) === U16_MAX ||
            view.getUint16(i + 10, true) === U16_MAX ||
            cdSize === U32_MAX ||
            cdOffset === U32_MAX;
        return { position: tailStart + i, cdSize, cdOffset, zip64 };
    }
    throw new CharxFileError("The file has no zip end record");
}

/**
 * The zip64 end record's offset from the zip's start, from the `ZIP64_LOCATOR_BYTES` before the end
 * record; null when they are not a zip64 locator (the end record's 32-bit fields then stand).
 */
export function readZip64Locator(bytes: Uint8Array): number | null {
    if (bytes.length < ZIP64_LOCATOR_BYTES) {
        return null;
    }
    const view = viewOf(bytes);
    if (view.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) {
        return null;
    }
    const disks = view.getUint32(16, true);
    if (view.getUint32(4, true) !== 0 || disks > 1) {
        throw new CharxFileError("A split zip archive is not supported");
    }
    return u64(view, 8);
}

/** The central directory's size and offset from a zip64 end record (its first `ZIP64_END_BYTES`); null for another record. */
export function readZip64End(bytes: Uint8Array): { cdSize: number; cdOffset: number } | null {
    if (bytes.length < ZIP64_END_BYTES) {
        return null;
    }
    const view = viewOf(bytes);
    if (view.getUint32(0, true) !== ZIP64_END_SIGNATURE) {
        return null;
    }
    if (view.getUint32(16, true) !== 0 || view.getUint32(20, true) !== 0) {
        throw new CharxFileError("A split zip archive is not supported");
    }
    return { cdSize: u64(view, 40), cdOffset: u64(view, 48) };
}

/**
 * The data of an extra field's zip64 record (header id 1), or null without one. The walk stops at a
 * record that runs past the field (some writers pad it with bytes that are no record).
 */
function zip64Extra(extra: Uint8Array): DataView | null {
    const view = viewOf(extra);
    for (let position = 0; position + 4 <= extra.length;) {
        const id = view.getUint16(position, true);
        const length = view.getUint16(position + 2, true);
        if (position + 4 + length > extra.length) {
            return null;
        }
        if (id === ZIP64_EXTRA_ID) {
            return new DataView(extra.buffer, extra.byteOffset + position + 4, length);
        }
        position += 4 + length;
    }
    return null;
}

/**
 * The values a zip64 record holds for the fields whose 32-bit value is `0xFFFFFFFF` (a disk number:
 * `0xFFFF`), in the format's order (uncompressed size, compressed size, local header offset, each 64
 * bits; then the 32-bit disk number start), each present only for such a field, as fflate reads the
 * sizes and offset. A size or offset the record does not reach is refused; a disk number it does not
 * reach is left out (the marker then stands for disk 0).
 */
function zip64Values(
    record: DataView,
    wants: { uncompressed: boolean; compressed: boolean; offset: boolean; disk?: boolean },
): { uncompressed?: number; compressed?: number; offset?: number; disk?: number } {
    const values: { uncompressed?: number; compressed?: number; offset?: number; disk?: number } = {};
    let position = 0;
    for (const field of ["uncompressed", "compressed", "offset"] as const) {
        if (!wants[field]) {
            continue;
        }
        if (position + 8 > record.byteLength) {
            throw new CharxFileError("A zip64 extra field is truncated");
        }
        values[field] = u64(record, position);
        position += 8;
    }
    if (wants.disk && position + 4 <= record.byteLength) {
        values.disk = record.getUint32(position, true);
    }
    return values;
}

/** One central-directory record. */
export type ZipCentralEntry = {
    /** The name's raw bytes. */
    name: Uint8Array;
    flags: number;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    /** The local header's offset from the zip's start (mod 2^32 for fflate's writer). */
    offset: number;
    /** A size came from the zip64 extra field: the data descriptor, if any, holds 64-bit sizes. */
    zip64Sizes: boolean;
};

/**
 * The records of a central directory (`bytes`: exactly `cdSize` bytes from its start), walked by
 * size, never by the end record's count (fflate's writer wraps it). A field marked `0xFFFFFFFF` takes
 * its zip64 value when the record has a zip64 extra field and keeps the 32-bit value otherwise (an
 * fflate offset can wrap to it). Every entry must start on disk 0: a disk number start of `0xFFFF` is
 * the zip64 marker, and stands for disk 0 unless the record's zip64 extra field names another disk.
 * Throws `CharxFileError` for a record that does not parse or runs past the directory, an entry on
 * another disk (a split archive), an encrypted entry, or more than `MAX_CHARX_ENTRIES` records.
 */
export function readCentralDirectory(bytes: Uint8Array): ZipCentralEntry[] {
    const view = viewOf(bytes);
    const entries: ZipCentralEntry[] = [];
    let position = 0;
    while (position < bytes.length) {
        if (
            position + ZIP_CENTRAL_HEADER_BYTES > bytes.length ||
            view.getUint32(position, true) !== CENTRAL_SIGNATURE
        ) {
            throw new CharxFileError("The zip central directory is malformed");
        }
        if (entries.length === MAX_CHARX_ENTRIES) {
            throw new CharxFileError("The zip holds too many entries");
        }
        const flags = view.getUint16(position + 8, true);
        if (flags & ENCRYPTED_FLAG) {
            throw new CharxFileError("An encrypted zip entry is not supported");
        }
        let compressedSize = view.getUint32(position + 20, true);
        let uncompressedSize = view.getUint32(position + 24, true);
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const commentLength = view.getUint16(position + 32, true);
        const diskStart = view.getUint16(position + 34, true);
        if (diskStart !== 0 && diskStart !== U16_MAX) {
            throw new CharxFileError("A zip entry on another disk is not supported");
        }
        let offset = view.getUint32(position + 42, true);
        const nameStart = position + ZIP_CENTRAL_HEADER_BYTES;
        const extraStart = nameStart + nameLength;
        const end = extraStart + extraLength + commentLength;
        if (end > bytes.length) {
            throw new CharxFileError("The zip central directory is malformed");
        }
        const wants = {
            uncompressed: uncompressedSize === U32_MAX,
            compressed: compressedSize === U32_MAX,
            offset: offset === U32_MAX,
            disk: diskStart === U16_MAX,
        };
        const record =
            wants.uncompressed || wants.compressed || wants.offset || wants.disk
                ? zip64Extra(bytes.subarray(extraStart, extraStart + extraLength))
                : null;
        let zip64Sizes = false;
        if (record) {
            const values = zip64Values(record, wants);
            if (values.disk !== undefined && values.disk !== 0) {
                throw new CharxFileError("A zip entry on another disk is not supported");
            }
            uncompressedSize = values.uncompressed ?? uncompressedSize;
            compressedSize = values.compressed ?? compressedSize;
            offset = values.offset ?? offset;
            zip64Sizes = wants.uncompressed || wants.compressed;
        }
        entries.push({
            name: bytes.subarray(nameStart, extraStart),
            flags,
            method: view.getUint16(position + 10, true),
            compressedSize,
            uncompressedSize,
            offset,
            zip64Sizes,
        });
        position = end;
    }
    return entries;
}

/**
 * A local header's whole length (`ZIP_LOCAL_HEADER_BYTES`, its name, its extra field), from its first
 * `ZIP_LOCAL_HEADER_BYTES` bytes. Throws `CharxFileError` when they are not a local header.
 */
export function localHeaderLength(bytes: Uint8Array): number {
    const view = viewOf(bytes);
    if (bytes.length < ZIP_LOCAL_HEADER_BYTES || view.getUint32(0, true) !== LOCAL_SIGNATURE) {
        throw new CharxFileError("A zip entry has no local header");
    }
    return ZIP_LOCAL_HEADER_BYTES + view.getUint16(26, true) + view.getUint16(28, true);
}

/** A local header, read as fflate's streaming `Unzip` reads it. */
export type ZipLocalHeader = {
    /** Its whole length: the fixed part, the name, and the extra field (the entry's bytes follow). */
    headerLength: number;
    /** The name's raw bytes (a copy). */
    name: Uint8Array;
    flags: number;
    method: number;
    /** As declared: zero, or not yet known, with a data descriptor. */
    compressedSize: number;
    uncompressedSize: number;
    /** The header has a zip64 extra field: the data descriptor, if any, holds 64-bit sizes. */
    zip64: boolean;
};

/**
 * The local header at the start of `bytes` (its whole `localHeaderLength`). A size marked
 * `0xFFFFFFFF` takes its zip64 value when the header has a zip64 extra field. Throws `CharxFileError`
 * for a header that does not parse or an encrypted entry.
 */
export function readLocalHeader(bytes: Uint8Array): ZipLocalHeader {
    const length = localHeaderLength(bytes);
    if (bytes.length < length) {
        throw new CharxFileError("A zip local header is truncated");
    }
    const view = viewOf(bytes);
    const flags = view.getUint16(6, true);
    if (flags & ENCRYPTED_FLAG) {
        throw new CharxFileError("An encrypted zip entry is not supported");
    }
    let compressedSize = view.getUint32(18, true);
    let uncompressedSize = view.getUint32(22, true);
    const nameEnd = ZIP_LOCAL_HEADER_BYTES + view.getUint16(26, true);
    const record = zip64Extra(bytes.subarray(nameEnd, length));
    if (record) {
        const values = zip64Values(record, {
            uncompressed: uncompressedSize === U32_MAX,
            compressed: compressedSize === U32_MAX,
            offset: false,
        });
        uncompressedSize = values.uncompressed ?? uncompressedSize;
        compressedSize = values.compressed ?? compressedSize;
    }
    return {
        headerLength: length,
        name: bytes.slice(ZIP_LOCAL_HEADER_BYTES, nameEnd),
        flags,
        method: view.getUint16(8, true),
        compressedSize,
        uncompressedSize,
        zip64: record !== null,
    };
}

/** Whether a data descriptor follows the entry's bytes (flag bit 3). */
export function hasDataDescriptor(local: ZipLocalHeader): boolean {
    return (local.flags & DESCRIPTOR_FLAG) !== 0;
}

/**
 * The data descriptor's length from its first bytes (`bytes`, up to `ZIP_DESCRIPTOR_MAX_BYTES`): its
 * optional signature, the CRC, then two 32-bit sizes, or 64-bit ones for a zip64 entry.
 */
export function dataDescriptorLength(bytes: Uint8Array, zip64: boolean): number {
    const signed = bytes.length >= 4 && viewOf(bytes).getUint32(0, true) === DESCRIPTOR_SIGNATURE;
    return (signed ? 4 : 0) + 4 + (zip64 ? 16 : 8);
}

/** Whether two names (raw bytes) are the same. */
export function sameZipName(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

// `strFromU8`'s decoder: UTF-8, invalid bytes replaced, a leading BOM dropped.
const utf8 = new TextDecoder();

/** An entry name as fflate's `strFromU8(name, !utf8)` reads it: UTF-8 with flag bit 11, else Latin-1 (one code point per byte). */
export function decodeZipName(name: Uint8Array, flags: number): string {
    if (flags & UTF8_FLAG) {
        return utf8.decode(name);
    }
    let text = "";
    for (let i = 0; i < name.length; i += 16384) {
        text += String.fromCharCode(...name.subarray(i, i + 16384));
    }
    return text;
}

/** The card's text from the `card.json` entry's bytes, as the in-tab reader decodes it. */
export function decodeCharxCard(bytes: Uint8Array): string {
    return utf8.decode(bytes);
}

/** What an entry is, by its name (the entry rules above). */
export type CharxEntryKind = "card" | "module" | "ignored" | "asset";

export function charxEntryKind(name: string): CharxEntryKind {
    if (name === "card.json") {
        return "card";
    }
    if (name === "module.risum") {
        return "module";
    }
    return name.endsWith(".json") ? "ignored" : "asset";
}

/**
 * The compressed size to read: the central directory's, or the local header's when it declares one
 * (not zero, without a data descriptor).
 */
export function entryCompressedSize(local: ZipLocalHeader, central: ZipCentralEntry): number {
    return !hasDataDescriptor(local) && local.compressedSize !== 0 ? local.compressedSize : central.compressedSize;
}

/**
 * Whether an entry is excluded before it is read: its local header declares, without a data
 * descriptor, an uncompressed size of at least `MAX_CHARX_ENTRY_BYTES` (the in-tab rule), the central
 * directory one over it, or `compressedSize` is over `MAX_CHARX_COMPRESSED_BYTES`.
 */
export function excludedBeforeReading(
    local: ZipLocalHeader,
    central: ZipCentralEntry,
    compressedSize: number,
): boolean {
    return (
        (!hasDataDescriptor(local) && local.uncompressedSize >= MAX_CHARX_ENTRY_BYTES) ||
        central.uncompressedSize > MAX_CHARX_ENTRY_BYTES ||
        compressedSize > MAX_CHARX_COMPRESSED_BYTES
    );
}

/** A progress line: `done` of the file's `total` asset entries are stored (or found stored, or excluded while decoding). */
export type CharxImportProgress = { done: number; total: number };

/**
 * The last line of an import that read every entry: the card's text (null without a readable
 * `card.json`), the embedded `module.risum` base64-encoded (null without one), each asset entry's
 * name mapped to the key its bytes are stored under, and the names of the excluded entries.
 */
export type CharxImportResult = {
    card: string | null;
    moduleData: string | null;
    assets: Record<string, string>;
    excluded: string[];
};

/** The last line of an import that failed: nothing more is written (the files stored before stay, content-addressed). */
export type CharxImportFailure = { error: string };

/** One line of the route's NDJSON answer: progress lines, then one result or one failure. */
export type CharxImportLine = CharxImportProgress | CharxImportResult | CharxImportFailure;
