import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { encodeRecordHeader } from "../data/archive.ts";

/**
 * Archive records streamed from stored files (`u32le nameLength`, the UTF-8 name, `u32le dataLength`,
 * the bytes; `server/src/data/archive.ts`), the answers of the backup export and of the batch asset
 * read (`/api/assets/read`).
 */

/** How stored files are opened for reading: no symlinks, and a FIFO opens without blocking so an `isFile` check can reject it. */
export const STORAGE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const missingFileCodes = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);
const RECORD_CHUNK_BYTES = 1024 * 1024;

/** Whether an open failed because the file is not there; a symlink opened with `STORAGE_READ_FLAGS` (`ELOOP`) counts. */
export function isMissingFileError(error: unknown): boolean {
    return missingFileCodes.has((error as NodeJS.ErrnoException)?.code ?? "");
}

/**
 * One archive record streamed from a file. The size comes from the open handle, so an atomic replace
 * of the file meanwhile cannot mix two versions. A file that cannot be opened or read any more fails
 * the stream (the backup manifest already lists it as included), so the download ends in an error
 * instead of a silently incomplete archive.
 */
export async function* fileRecord(name: string, file: string): AsyncGenerator<Uint8Array> {
    const handle = await fs.open(file, STORAGE_READ_FLAGS);
    try {
        yield* handleRecord(name, handle, (await handle.stat()).size);
    } finally {
        await handle.close();
    }
}

/**
 * `fileRecord` for a stored file that may be absent: a zero-length record, without touching the disk,
 * when `file` is null (a key with no storage location), and also when the file is missing, is a
 * symlink, or is not a regular file (the `/api/read` rule: empty means missing). Any other error
 * fails the stream.
 */
export async function* storedFileRecord(name: string, file: string | null): AsyncGenerator<Uint8Array> {
    let handle: FileHandle | null = null;
    if (file !== null) {
        try {
            handle = await fs.open(file, STORAGE_READ_FLAGS);
        } catch (error) {
            if (!isMissingFileError(error)) {
                throw error;
            }
        }
    }
    if (handle === null) {
        yield encodeRecordHeader(name, 0);
        return;
    }
    try {
        const stat = await handle.stat();
        yield* handleRecord(name, handle, stat.isFile() ? stat.size : 0);
    } finally {
        await handle.close();
    }
}

/** The header, then `size` bytes of an open file in 1 MiB chunks; a file that shrank meanwhile fails. */
async function* handleRecord(name: string, handle: FileHandle, size: number): AsyncGenerator<Uint8Array> {
    yield encodeRecordHeader(name, size);
    let done = 0;
    while (done < size) {
        const chunk = Buffer.alloc(Math.min(RECORD_CHUNK_BYTES, size - done));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, done);
        if (bytesRead === 0) {
            throw new Error(`Record ${name} shrank while it was read`);
        }
        done += bytesRead;
        yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
    }
}

/**
 * A pull-based stream over an async iterator; cancelling it (client gone) finishes the iterator, so
 * a file it holds open is closed, and then runs `finalize` (a generator that never started has no
 * `finally` to run).
 */
export function iteratorStream(
    iterator: AsyncGenerator<Uint8Array>,
    finalize: () => Promise<void> = async () => {},
): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next();
                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel() {
            await iterator.return(undefined);
            await finalize();
        },
    });
}
