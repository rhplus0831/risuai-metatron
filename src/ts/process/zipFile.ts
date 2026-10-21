import { inflateSync } from "fflate";
import {
    CharxFileError,
    decodeZipName,
    findZipEnd,
    localHeaderLength,
    MAX_CHARX_CENTRAL_DIRECTORY_BYTES,
    readCentralDirectory,
    readLocalHeader,
    readZip64End,
    readZip64Locator,
    sameZipName,
    ZIP64_END_BYTES,
    ZIP64_LOCATOR_BYTES,
    ZIP_END_SEARCH_BYTES,
    ZIP_LOCAL_HEADER_BYTES,
    ZIP_METHOD_DEFLATED,
    ZIP_METHOD_STORED,
    ZIP_OFFSET_MODULUS,
    type ZipCentralEntry,
} from "../../../shared/charxImport.ts";

/**
 * A zip archive read from a `Blob` (for the ONNX/VITS model import): the entries come from the
 * central directory with the CharX server reader's parsers (`shared/charxImport.ts`), and an
 * entry's bytes are read with `Blob.slice` only when asked for, so the tab never holds the archive.
 * Unlike fflate's streaming `Unzip`, this never scans an entry's bytes for signatures, so a
 * data-descriptor entry whose bytes hold one is read whole. A zip whose offsets wrap past 4 GiB
 * without zip64 is not supported (its entries fail the local header check). A file that is not such
 * a zip throws `CharxFileError`.
 */

/** One entry of the central directory. */
export type ZipFileEntry = {
    /** As fflate names it (UTF-8 with flag bit 11, else Latin-1). */
    name: string;
    /** A directory entry (its name ends with `/`). */
    directory: boolean;
    compressedSize: number;
    uncompressedSize: number;
    record: ZipCentralEntry;
};

export type ZipFileIndex = {
    entries: ZipFileEntry[];
    /** The bytes before the zip's start (the entries' offsets count from it). */
    prefix: number;
};

async function readSlice(file: Blob, start: number, end: number): Promise<Uint8Array> {
    if (start < 0 || end > file.size || end < start) {
        throw new CharxFileError("The zip file is truncated");
    }
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function positiveModulo(value: number): number {
    return ((value % ZIP_OFFSET_MODULUS) + ZIP_OFFSET_MODULUS) % ZIP_OFFSET_MODULUS;
}

/** The archive's entries, read from its end records and central directory (no entry's bytes). */
export async function readZipIndex(file: Blob): Promise<ZipFileIndex> {
    const size = file.size;
    const tailLength = Math.min(size, ZIP_END_SEARCH_BYTES);
    const end = findZipEnd(await readSlice(file, size - tailLength, size), size - tailLength);
    let { cdSize, cdOffset } = end;
    let cdEnd = end.position;
    let wrapped = true;
    if (end.zip64 && end.position >= ZIP64_LOCATOR_BYTES) {
        const locatorStart = end.position - ZIP64_LOCATOR_BYTES;
        const recordOffset = readZip64Locator(await readSlice(file, locatorStart, end.position));
        if (recordOffset !== null) {
            // The record's offset counts from the zip's start; a prefixed zip has it just before the locator.
            let found = false;
            for (const position of [recordOffset, locatorStart - ZIP64_END_BYTES]) {
                if (position < 0 || position + ZIP64_END_BYTES > locatorStart) {
                    continue;
                }
                const record = readZip64End(await readSlice(file, position, position + ZIP64_END_BYTES));
                if (record) {
                    ({ cdSize, cdOffset } = record);
                    cdEnd = position;
                    wrapped = false;
                    found = true;
                    break;
                }
            }
            if (!found) {
                throw new CharxFileError("The zip64 end record is missing");
            }
        }
    }
    if (cdSize > MAX_CHARX_CENTRAL_DIRECTORY_BYTES) {
        throw new CharxFileError("The zip central directory is too large");
    }
    const cdStart = cdEnd - cdSize;
    if (cdStart < 0) {
        throw new CharxFileError("The zip central directory starts before the file");
    }
    const prefix = wrapped ? positiveModulo(cdStart - cdOffset) : cdStart - cdOffset;
    if (prefix < 0 || prefix > cdStart) {
        throw new CharxFileError("The zip central directory's offset is wrong");
    }
    const entries = readCentralDirectory(await readSlice(file, cdStart, cdEnd)).map((record): ZipFileEntry => {
        const name = decodeZipName(record.name, record.flags);
        return {
            name,
            directory: name.endsWith("/"),
            compressedSize: record.compressedSize,
            uncompressedSize: record.uncompressedSize,
            record,
        };
    });
    return { entries, prefix };
}

/**
 * An entry's uncompressed bytes. Throws `CharxFileError` when its local header does not match its
 * central-directory record, it uses a method other than stored or deflate, or its bytes do not
 * decode to the declared size.
 */
export async function readZipEntry(file: Blob, index: ZipFileIndex, entry: ZipFileEntry): Promise<Uint8Array> {
    const position = index.prefix + entry.record.offset;
    const headerLength = localHeaderLength(await readSlice(file, position, position + ZIP_LOCAL_HEADER_BYTES));
    const local = readLocalHeader(await readSlice(file, position, position + headerLength));
    if (!sameZipName(local.name, entry.record.name) || local.method !== entry.record.method) {
        throw new CharxFileError("A zip entry's local header differs from its central-directory record");
    }
    const dataStart = position + local.headerLength;
    const stored = await readSlice(file, dataStart, dataStart + entry.compressedSize);
    if (local.method === ZIP_METHOD_STORED) {
        if (stored.length !== entry.uncompressedSize) {
            throw new CharxFileError("A stored zip entry's size differs from its declared size");
        }
        return stored;
    }
    if (local.method !== ZIP_METHOD_DEFLATED) {
        throw new CharxFileError("A zip entry uses an unsupported compression method");
    }
    // One byte past the declared size: a stream that decodes to more fills it and is refused.
    let inflated: Uint8Array;
    try {
        inflated = inflateSync(stored, { out: new Uint8Array(entry.uncompressedSize + 1) });
    } catch (error) {
        throw new CharxFileError(`A zip entry's deflate stream is corrupt (${error})`);
    }
    if (inflated.length !== entry.uncompressedSize) {
        throw new CharxFileError("A zip entry's bytes differ from its declared size");
    }
    return inflated;
}
