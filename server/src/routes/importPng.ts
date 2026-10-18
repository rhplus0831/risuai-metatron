import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
// The tab's `Buffer` (the `buffer` package, `src/ts/polyfill.ts`), not Node's: the two decode base64
// with stray characters differently, and an asset's bytes (and so its key) must match the tab's.
import { Buffer as TabBuffer } from "buffer/index.js";
import {
    type CharxImportFailure,
    type CharxImportProgress,
    INVALID_CHARX_FILE,
    MAX_CHARX_ENTRIES,
    MAX_CHARX_ENTRY_BYTES,
} from "../../../shared/charxImport.ts";
import type { RealmPngResult } from "../../../shared/realmImport.ts";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import { publishStagedContentAsset, writeContentAsset } from "../http/contentAsset.ts";
import { type FileImportStream, readFileAt } from "../http/fileImport.ts";
import { ndjsonLine } from "../http/spool.ts";

/**
 * The server's reader of PNG character cards (the Realm download, `routes/importRealm.ts`), the
 * second reader of the format beside the tab's `PngChunk.readGenerator` (`src/ts/pngChunk.ts`) and
 * `importCharacterProcess` (`src/ts/characterCards.ts`), whose rules it keeps:
 *
 * - The chunks are walked by their length fields from the 8-byte signature; CRCs are not checked; the
 *   walk ends at `IEND` (bytes after it are ignored) or at the file's end on a chunk boundary.
 * - A `tEXt` chunk's key is its bytes before the first NUL within its first 70 bytes (no NUL: no key),
 *   its value the bytes after that NUL, both decoded as UTF-8 by `TextDecoder`'s defaults.
 * - `chara` and `ccv3`: each is replaced by a later chunk of its key only while the text it holds is
 *   shorter than 5 MiB (JavaScript string length); the card is the `ccv3` text when it is not empty,
 *   else the `chara` text.
 * - `chara-ext-asset_<index>` (or `chara-ext-asset_:<index>`): the value base64-decoded by the tab's
 *   decoder (the `buffer` package's `Buffer.from(value, "base64")`) is an asset stored under its
 *   content key and mapped from its index; a later chunk of the same index wins.
 * - The image is the PNG without its `tEXt` chunks: the signature and every other chunk (through
 *   `IEND`) byte for byte, stored under its content key as the tab's `saveAsset` stores it.
 *
 * Stricter than the tab, before anything is written (`planPngFile`): a file that does not start with
 * the PNG signature, a chunk that runs past the file's end (or a partial chunk header), a file
 * without a `chara` or `ccv3` chunk, a card or asset chunk over `MAX_PNG_TEXT_CHUNK_BYTES`, more than
 * `MAX_CHARX_ENTRIES` asset chunks, or more than `MAX_PNG_CHUNKS` chunks is refused as an invalid
 * character file. Memory holds one chunk's text at a time (and the asset map, bounded by the asset
 * chunk count and the 70-byte key); the image is copied to a staged file while it is hashed, and moved
 * into place.
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** A chunk's length and type before its data; its CRC after. */
const CHUNK_HEADER_BYTES = 8;
const CHUNK_CRC_BYTES = 4;
/** A `tEXt` chunk's key is looked for in its first 70 bytes, as the tab does. */
const KEY_SEARCH_BYTES = 70;
/** The tab replaces a card text only while the one it holds is shorter than this (string length). */
const CARD_KEEP_LENGTH = 5 * 1024 * 1024;
/** The largest card or asset chunk read: the base64 text of a `MAX_CHARX_ENTRY_BYTES` asset and its key. */
export const MAX_PNG_TEXT_CHUNK_BYTES = Math.ceil(MAX_CHARX_ENTRY_BYTES / 3) * 4 + 1024;
const ASSET_KEY_PREFIX = "chara-ext-asset_";
/** Most chunks of a PNG the server reads (a card's image has a few hundred). */
export const MAX_PNG_CHUNKS = 1_000_000;
/** The chunk walk reads headers through a window this large; the image is copied in pieces this large. */
const WINDOW_BYTES = 64 * 1024;
const COPY_BYTES = 1024 * 1024;
/** Least time between two progress lines; the last asset always has one. */
const PROGRESS_INTERVAL_MS = 200;

const decoder = new TextDecoder();

/** A PNG the reader refuses: answered as an invalid character file. */
export class PngFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PngFileError";
    }
}

/** A validated PNG: how many asset chunks the lines will store. */
export type PngFilePlan = { total: number };

type PngChunkHeader = { position: number; length: number; type: string };

/**
 * Checks the PNG's structure before anything is written (see the file comment): reads the signature
 * and each chunk's header, and each `tEXt` chunk's key. Stops early (an incomplete plan the caller
 * drops) once `signal` aborts.
 */
export async function planPngFile(handle: FileHandle, signal: AbortSignal): Promise<PngFilePlan> {
    const size = (await handle.stat()).size;
    if (size < PNG_SIGNATURE.length) {
        throw new PngFileError("The file is not a PNG");
    }
    const signature = await readAt(handle, new Uint8Array(PNG_SIGNATURE.length), 0);
    if (!signature.every((byte, i) => byte === PNG_SIGNATURE[i])) {
        throw new PngFileError("The file is not a PNG");
    }
    let total = 0;
    let card = false;
    let chunks = 0;
    for await (const chunk of walkChunks(handle, size)) {
        if (signal.aborted) {
            break;
        }
        chunks += 1;
        if (chunks > MAX_PNG_CHUNKS) {
            throw new PngFileError("The PNG has too many chunks");
        }
        if (chunk.type !== "tEXt") {
            continue;
        }
        const key = keyOf(
            await readAt(handle, new Uint8Array(Math.min(KEY_SEARCH_BYTES, chunk.length)), dataStart(chunk)),
        );
        if (key === null) {
            continue;
        }
        const read = key.name === "chara" || key.name === "ccv3" || key.name.startsWith(ASSET_KEY_PREFIX);
        if (read && chunk.length > MAX_PNG_TEXT_CHUNK_BYTES) {
            throw new PngFileError("A PNG text chunk is too large");
        }
        if (key.name === "chara" || key.name === "ccv3") {
            card = true;
        } else if (key.name.startsWith(ASSET_KEY_PREFIX)) {
            total += 1;
            if (total > MAX_CHARX_ENTRIES) {
                throw new PngFileError("The PNG has too many asset chunks");
            }
        }
    }
    if (!card && !signal.aborted) {
        throw new PngFileError("The PNG holds no card");
    }
    return { total };
}

/** What the PNG lines need beyond their file: the storage, its maintenance gate, and the journal. */
export type PngLinesDeps = {
    savePath: string;
    snapshots: SnapshotManager;
    diagnostics?: DiagnosticsRecorder;
};

/**
 * The Realm download's lines for a PNG: `{ done, total }` lines as the asset chunks are stored (at
 * most every 200 ms, and for the last), then the `RealmPngResult` line, or one `{ error }` line at the
 * first failure. Never throws once the stream has started, and sends its last line once `finalize`
 * has run, as the CharX lines do.
 */
export async function* pngLines(
    { savePath, snapshots, diagnostics }: PngLinesDeps,
    { total }: PngFilePlan,
    { handle, staging, signal, finalize }: FileImportStream,
): AsyncGenerator<Uint8Array> {
    let out: FileHandle | null = null;
    const closeOut = async () => {
        const file = out;
        out = null;
        await file?.close().catch(() => {});
    };
    try {
        const size = (await handle.stat()).size;
        const imagePath = path.join(staging, "image.png");
        const image = await fs.open(imagePath, "wx");
        out = image;
        const hash = createHash("sha256");
        const writeImage = async (bytes: Uint8Array) => {
            hash.update(bytes);
            await writeAll(image, bytes);
        };
        await writeImage(PNG_SIGNATURE);
        let chara = "";
        let ccv3 = "";
        // No prototype: an index may be `__proto__`.
        const assets: Record<string, string> = Object.create(null);
        let done = 0;
        let lastLine = performance.now();
        for await (const chunk of walkChunks(handle, size)) {
            if (signal.aborted) {
                return;
            }
            if (chunk.type !== "tEXt") {
                await copyChunk(handle, chunk, writeImage, signal);
                continue;
            }
            const head = await readAt(
                handle,
                new Uint8Array(Math.min(KEY_SEARCH_BYTES, chunk.length)),
                dataStart(chunk),
            );
            const key = keyOf(head);
            if (key === null) {
                continue;
            }
            const isAsset = key.name.startsWith(ASSET_KEY_PREFIX);
            if (key.name !== "chara" && key.name !== "ccv3" && !isAsset) {
                continue;
            }
            const data = await readAt(handle, new Uint8Array(chunk.length), dataStart(chunk));
            const value = decoder.decode(data.subarray(key.end + 1));
            if (key.name === "chara") {
                if (chara.length < CARD_KEEP_LENGTH) {
                    chara = value;
                }
                continue;
            }
            if (key.name === "ccv3") {
                if (ccv3.length < CARD_KEEP_LENGTH) {
                    ccv3 = value;
                }
                continue;
            }
            const index = key.name.replace("chara-ext-asset_:", "").replace("chara-ext-asset_", "");
            const bytes = TabBuffer.from(value, "base64");
            const stored = await writeContentAsset(
                savePath,
                snapshots,
                new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                signal,
            );
            if (stored === null) {
                return;
            }
            assets[index] = stored;
            done += 1;
            const now = performance.now();
            if (done === total || now - lastLine >= PROGRESS_INTERVAL_MS) {
                lastLine = now;
                yield ndjsonLine({ done, total } satisfies CharxImportProgress);
            }
        }
        await closeOut();
        const imageKey = await publishStagedContentAsset(savePath, snapshots, imagePath, hash.digest("hex"), signal);
        if (imageKey === null) {
            return;
        }
        const card = ccv3 || chara;
        const result = ndjsonLine({
            kind: "png",
            card: card === "" ? null : card,
            image: imageKey,
            assets,
        } satisfies RealmPngResult);
        recordSafely(diagnostics, { kind: "lifecycle", phase: "realmImport" });
        await finalize();
        yield result;
    } catch (error) {
        const known = error instanceof MaintenanceError || error instanceof PngFileError;
        if (!known) {
            console.error("[Server] PNG import failed:", error);
        }
        await closeOut();
        await finalize();
        const message =
            error instanceof MaintenanceError
                ? error.message
                : error instanceof PngFileError
                  ? INVALID_CHARX_FILE
                  : "Import failed";
        yield ndjsonLine({ error: message } satisfies CharxImportFailure);
    } finally {
        await closeOut();
        await finalize();
    }
}

/**
 * The chunks' headers in file order, through `IEND` (or the file's end on a chunk boundary). A chunk
 * header or a chunk that runs past the file's end is a `PngFileError`.
 */
async function* walkChunks(handle: FileHandle, size: number): AsyncGenerator<PngChunkHeader> {
    const window = forwardWindow(handle, size);
    let position = PNG_SIGNATURE.length;
    while (position < size) {
        if (position + CHUNK_HEADER_BYTES > size) {
            throw new PngFileError("A PNG chunk header runs past the file's end");
        }
        const header = await window(position, CHUNK_HEADER_BYTES);
        const length = ((header[0] << 24) >>> 0) + (header[1] << 16) + (header[2] << 8) + header[3];
        const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
        const end = position + CHUNK_HEADER_BYTES + length + CHUNK_CRC_BYTES;
        if (end > size) {
            throw new PngFileError("A PNG chunk runs past the file's end");
        }
        yield { position, length, type };
        if (type === "IEND") {
            return;
        }
        position = end;
    }
}

/** A chunk's data offset. */
function dataStart(chunk: PngChunkHeader): number {
    return chunk.position + CHUNK_HEADER_BYTES;
}

/** A `tEXt` chunk's key and the NUL's index in its first bytes, or null without a NUL there. */
function keyOf(head: Uint8Array): { name: string; end: number } | null {
    const end = head.indexOf(0);
    return end < 0 ? null : { name: decoder.decode(head.subarray(0, end)), end };
}

/** Copies a whole chunk (header, data, CRC) to the image, in pieces. */
async function copyChunk(
    handle: FileHandle,
    chunk: PngChunkHeader,
    write: (bytes: Uint8Array) => Promise<void>,
    signal: AbortSignal,
): Promise<void> {
    const end = chunk.position + CHUNK_HEADER_BYTES + chunk.length + CHUNK_CRC_BYTES;
    let position = chunk.position;
    while (position < end && !signal.aborted) {
        const piece = await readAt(handle, new Uint8Array(Math.min(COPY_BYTES, end - position)), position);
        await write(piece);
        position += piece.length;
    }
}

/**
 * A reader of short spans moving forward through the file: one `WINDOW_BYTES` window, so the headers
 * of small chunks take a read for several. The bytes returned are valid until the next call.
 */
function forwardWindow(handle: FileHandle, size: number) {
    const buffer = new Uint8Array(WINDOW_BYTES);
    let start = 0;
    let filled = 0;
    return async (position: number, length: number): Promise<Uint8Array> => {
        if (position >= start && position + length <= start + filled) {
            return buffer.subarray(position - start, position - start + length);
        }
        start = position;
        filled = Math.min(buffer.length, size - position);
        await readAt(handle, buffer.subarray(0, filled), position);
        return buffer.subarray(0, length);
    };
}

/** Writes every byte of `bytes` at the handle's current position. */
async function writeAll(out: FileHandle, bytes: Uint8Array): Promise<void> {
    let done = 0;
    while (done < bytes.byteLength) {
        done += (await out.write(bytes, done, bytes.byteLength - done)).bytesWritten;
    }
}

/** Fills `buffer` from the file at `position`; a file that ends first is malformed. */
function readAt(handle: FileHandle, buffer: Uint8Array, position: number): Promise<Uint8Array> {
    return readFileAt(handle, buffer, position, () => new PngFileError("The PNG is truncated"));
}
