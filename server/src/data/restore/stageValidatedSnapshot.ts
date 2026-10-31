import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { ResourceKindRegistry } from "../kinds.ts";
import {
    assertStagedFileStat,
    NOT_A_RESOURCE_DATABASE,
    ResourceValidationError,
    writeValidatedStore,
} from "../resourceStore.ts";

/**
 * A restore's work off the store: `stageValidatedSnapshot` checks a snapshot file and writes a trusted
 * staged store, free of any worker API, so it runs in the restore worker (`validateWorker.ts`), in the
 * upstream import's worker, and in process. `verifyStagedFile` is the serving thread's check of what a
 * worker reported, right before `replaceAll` installs the file.
 */

/** What the staged store's writer reports about the closed file: what the install knows it by. */
export type StagedFileReport = { size: number; mtimeMs: number; ino: number; sha256: string };

export type RestoreProgress = (done: number, total: number) => void;

/** One step of a staged file's hash. `createHash` runs on the calling thread, so this bounds a step's work. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * The SHA-256 of `file`, read one chunk at a time. Every read is an await of the file system, so the
 * event loop runs between chunks, and an aborted `signal` stops the pass with its reason.
 */
async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    const handle = await fs.open(file, "r");
    try {
        while (true) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length);
            if (bytesRead === 0) {
                return hash.digest("hex");
            }
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        await handle.close();
    }
}

/**
 * Checks the snapshot file `source` and writes its checked rows into a new store at `output`
 * (`writeValidatedStore`; the row loop is synchronous), then reports the closed file. Throws
 * `ResourceValidationError` for a refused file, or an aborted `signal`'s reason at its next row or
 * chunk. The caller owns `output`'s folder and removes what a failure leaves.
 */
export async function stageValidatedSnapshot(
    source: string,
    output: string,
    kinds: ResourceKindRegistry,
    onProgress: RestoreProgress = () => {},
    signal?: AbortSignal,
): Promise<StagedFileReport> {
    onProgress(0, 1);
    writeValidatedStore(source, output, kinds, signal);
    const { size, mtimeMs, ino } = await fs.lstat(output);
    const sha256 = await hashFile(output, signal);
    onProgress(1, 1);
    return { size, mtimeMs, ino, sha256 };
}

/**
 * Checks that `file` is the staged store `report` describes, on the serving thread: the same regular
 * file (size, mtime, inode), then its SHA-256 in chunks that yield between them. A mismatch is a
 * `ResourceValidationError`; an aborted `signal` throws its reason.
 */
export async function verifyStagedFile(file: string, report: StagedFileReport, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    assertStagedFileStat(await fs.lstat(file).catch(() => undefined), report);
    if ((await hashFile(file, signal)) !== report.sha256) {
        throw new ResourceValidationError(NOT_A_RESOURCE_DATABASE);
    }
}
