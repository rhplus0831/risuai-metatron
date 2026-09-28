import fs, { type FileHandle } from "node:fs/promises";

/**
 * The local backup archive container: concatenated records of `u32le nameLength`, the UTF-8 name,
 * `u32le dataLength`, and the bytes. It has no header or footer of its own; format version 2 starts
 * with a `manifest.json` record (`BackupArchiveManifest`).
 */
export const MAX_ARCHIVE_RECORD_BYTES = 0xffffffff;
const MAX_ARCHIVE_NAME_BYTES = 4096;
/**
 * Most records an archive may hold, and most bytes its names may total: the index is held in memory,
 * so a crafted archive of millions of empty records is refused early. An export never exceeds them:
 * it stops at `MAX_ARCHIVE_RECORDS` records, and an asset key is at most 7 + 255 bytes.
 */
export const MAX_ARCHIVE_RECORDS = 200_000;
export const MAX_ARCHIVE_NAME_TOTAL_BYTES = 64 * 1024 * 1024;
/** Read window of `indexArchive`; it must hold one header (8 bytes plus the longest name). */
const INDEX_WINDOW_BYTES = 64 * 1024;

export class ArchiveFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ArchiveFormatError";
    }
}

export type ArchiveRecord = { name: string; offset: number; length: number };

export function encodeRecordHeader(name: string, length: number): Uint8Array {
    const nameBytes = Buffer.from(name, "utf-8");
    if (length > MAX_ARCHIVE_RECORD_BYTES || nameBytes.length > MAX_ARCHIVE_NAME_BYTES) {
        throw new ArchiveFormatError(`Archive record ${name} is too large`);
    }
    const header = Buffer.alloc(8 + nameBytes.length);
    header.writeUInt32LE(nameBytes.length, 0);
    nameBytes.copy(header, 4);
    header.writeUInt32LE(length, 4 + nameBytes.length);
    return header;
}

/**
 * Reads the record headers of an archive file without reading record data. Every name must be
 * strict UTF-8, every record must fit, and the last one must end exactly at the end of the file. The
 * index stops with an error at `MAX_ARCHIVE_RECORDS` records or `MAX_ARCHIVE_NAME_TOTAL_BYTES` of names.
 */
export async function indexArchive(handle: FileHandle): Promise<ArchiveRecord[]> {
    const { size } = await handle.stat();
    const records: ArchiveRecord[] = [];
    // Headers are read through one window, so many tiny records cost few reads.
    const window = Buffer.alloc(INDEX_WINDOW_BYTES);
    let windowStart = 0;
    let windowLength = 0;
    const bytesAt = async (at: number, length: number): Promise<Buffer> => {
        if (at < windowStart || at + length > windowStart + windowLength) {
            const { bytesRead } = await handle.read(window, 0, window.length, at);
            windowStart = at;
            windowLength = bytesRead;
            if (bytesRead < length) {
                throw new ArchiveFormatError("The archive is truncated");
            }
        }
        return window.subarray(at - windowStart, at - windowStart + length);
    };
    let offset = 0;
    let nameBytesTotal = 0;
    while (offset < size) {
        const nameLength = (await bytesAt(offset, 4)).readUInt32LE(0);
        if (nameLength === 0 || nameLength > MAX_ARCHIVE_NAME_BYTES || offset + 4 + nameLength + 4 > size) {
            throw new ArchiveFormatError("The archive has an invalid record header");
        }
        nameBytesTotal += nameLength;
        if (records.length >= MAX_ARCHIVE_RECORDS || nameBytesTotal > MAX_ARCHIVE_NAME_TOTAL_BYTES) {
            throw new ArchiveFormatError("The archive holds too many records");
        }
        const nameBytes = await bytesAt(offset + 4, nameLength);
        const name = nameBytes.toString("utf-8");
        if (!Buffer.from(name, "utf-8").equals(nameBytes)) {
            throw new ArchiveFormatError("The archive has a record name that is not UTF-8");
        }
        const length = (await bytesAt(offset + 4 + nameLength, 4)).readUInt32LE(0);
        const dataOffset = offset + 4 + nameLength + 4;
        if (dataOffset + length > size) {
            throw new ArchiveFormatError("The archive is truncated");
        }
        records.push({ name, offset: dataOffset, length });
        offset = dataOffset + length;
    }
    return records;
}

/** Reads one record's bytes (for small records such as the manifest). */
export async function readRecord(handle: FileHandle, record: ArchiveRecord): Promise<Buffer> {
    const data = Buffer.alloc(record.length);
    let done = 0;
    while (done < record.length) {
        const { bytesRead } = await handle.read(data, done, record.length - done, record.offset + done);
        if (bytesRead === 0) {
            throw new ArchiveFormatError("The archive is truncated");
        }
        done += bytesRead;
    }
    return data;
}

/** Copies one record's bytes into a new file (`wx`: it must not exist). */
export async function copyRecordToFile(handle: FileHandle, record: ArchiveRecord, target: string): Promise<void> {
    const out = await fs.open(target, "wx");
    try {
        const chunk = Buffer.alloc(1024 * 1024);
        let done = 0;
        while (done < record.length) {
            const want = Math.min(chunk.length, record.length - done);
            const { bytesRead } = await handle.read(chunk, 0, want, record.offset + done);
            if (bytesRead === 0) {
                throw new ArchiveFormatError("The archive is truncated");
            }
            let written = 0;
            while (written < bytesRead) {
                written += (await out.write(chunk, written, bytesRead - written)).bytesWritten;
            }
            done += bytesRead;
        }
    } finally {
        await out.close();
    }
}
