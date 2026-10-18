import type { FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
    CHARX_IMPORT_PATH,
    type CharxEntryKind,
    CharxFileError,
    type CharxImportFailure,
    type CharxImportProgress,
    type CharxImportResult,
    charxEntryKind,
    dataDescriptorLength,
    decodeCharxCard,
    decodeZipName,
    entryCompressedSize,
    excludedBeforeReading,
    findZipEnd,
    hasDataDescriptor,
    INVALID_CHARX_FILE,
    localHeaderLength,
    MAX_CHARX_CENTRAL_DIRECTORY_BYTES,
    MAX_CHARX_ENTRY_BYTES,
    readCentralDirectory,
    readLocalHeader,
    readZip64End,
    readZip64Locator,
    sameZipName,
    ZIP64_END_BYTES,
    ZIP64_LOCATOR_BYTES,
    ZIP_DESCRIPTOR_MAX_BYTES,
    ZIP_END_SEARCH_BYTES,
    ZIP_LOCAL_HEADER_BYTES,
    ZIP_METHOD_DEFLATED,
    ZIP_METHOD_STORED,
    ZIP_OFFSET_MODULUS,
    type ZipCentralEntry,
} from "../../../shared/charxImport.ts";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import {
    createImportSlot,
    type FileImportStream,
    type ImportSlot,
    readFileAt,
    serveFileImport,
} from "../http/fileImport.ts";
import { ndjsonLine } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { writeContentAsset } from "../http/contentAsset.ts";

export { CHARX_IMPORT_PATH };

/** Least time between two progress lines; the last asset always has one. */
const PROGRESS_INTERVAL_MS = 200;
/** The validation walk reads the local headers and data descriptors through a window this large. */
const WALK_WINDOW_BYTES = 4096;

const inflateRaw = promisify(zlib.inflateRaw);

/** One entry of a validated file, in file order. */
type CharxPlanEntry = {
    name: string;
    kind: CharxEntryKind;
    method: number;
    /** The file position of its (compressed) bytes. */
    dataStart: number;
    compressedSize: number;
    /** Excluded by a declared size: never read. */
    excluded: boolean;
};

/** A validated file: its entries in file order, and how many asset entries will be read. */
export type CharxFilePlan = { entries: CharxPlanEntry[]; total: number };

/**
 * `POST /api/import/charx` (historical `docs/plan/large-asset-import.md` slice 2d): a CharX file (a zip, or a
 * `charxJpeg`: a JPEG, then the zip) as the raw body (`shared/charxImport.ts`), so the tab neither
 * unzips the file nor sends one request per asset. Authenticated before the body is read; no epoch
 * (only content-addressed files are written, and the client adds the character, or the module of
 * `importModule`'s `.charx` branch, itself). The request lifecycle is `serveFileImport`'s
 * (`http/fileImport.ts`), with the module import's refusals and its import slot (409 while either
 * runs); the body is spooled to `save/.tmp/charx-<uuid>/file.charx` under `maxImportBytes` (exempt
 * from the global body limit).
 *
 * The zip is read by its central directory, never by scanning for signatures (a stored entry may
 * hold them). Before anything is written the whole structure is checked from the file: the end
 * record (zip64 when it says so), the central directory (one disk: a split archive is refused by its
 * end record or by any record's disk number), and every local header, walked in file order
 * from the first entry and matched to its central-directory record by offset (mod 2^32: fflate's
 * writer wraps offsets past 4 GiB) and name, each entry's bytes and data descriptor within the file;
 * a supported method (stored or deflated) for every entry its declared sizes do not exclude, and a
 * `card.json`.
 * Anything else is a 400 `Invalid character file`, with nothing written. Then the answer is NDJSON
 * (`CharxImportLine`): each entry in file order by the shared entry rules, an asset stored under
 * `assets/<sha256 hex>.png` (skipped when that file exists; each write under the maintenance gate),
 * with `{ done, total }` lines (the asset entries to read, exact; at most every 200 ms and for the
 * last), then `{ card, moduleData, assets, excluded }`; or one `{ error }` line at the first failure
 * (`Invalid character file` for a corrupt deflate stream, `Maintenance in progress`, `Import failed`),
 * after which nothing more is written. An entry excluded by a declared size is never read; one that
 * decodes past `MAX_CHARX_ENTRY_BYTES` is dropped. Memory holds the central directory's entries and
 * one entry's bytes at a time.
 */
export function registerCharxImportRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        snapshots: SnapshotManager;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maxImportBytes: number;
        /** The diagnostics journal: a `lifecycle` event after an import read every entry. */
        diagnostics?: DiagnosticsRecorder;
        /** The import slot shared with the module import (`createServerContext`); a slot of its own without one. */
        slot?: ImportSlot;
    },
) {
    const { savePath, snapshots, auth, limiter, maxImportBytes, diagnostics } = arg;
    const deps = { savePath, snapshots, auth, maxImportBytes, slot: arg.slot ?? createImportSlot() };

    app.post(CHARX_IMPORT_PATH, limiter, (c) =>
        serveFileImport(c, deps, {
            stagingPrefix: "charx",
            fileName: "file.charx",
            missingBody: "CharX body required",
            prepare: (handle) => planCharxFile(handle),
            refusal,
            lines: (plan, stream) => charxLines({ savePath, snapshots, diagnostics }, plan, stream),
        }),
    );
}

/** What a CharX read needs beyond its file: the storage, its maintenance gate, and the journal. */
export type CharxLinesDeps = {
    savePath: string;
    snapshots: SnapshotManager;
    diagnostics?: DiagnosticsRecorder;
};

/**
 * The CharX import's lines (see the route comment), shared with the Realm download
 * (`routes/importRealm.ts`): `phase` names the diagnostics lifecycle event (`charxImport` by
 * default) and `kind`, when given, is added to the result line. Never throws once the stream has
 * started (a failure is the last line), and sends its last line once `finalize` has run, as the
 * module import does.
 */
export async function* charxLines(
    { savePath, snapshots, diagnostics }: CharxLinesDeps,
    { entries, total }: CharxFilePlan,
    { handle, signal, finalize }: FileImportStream,
    options: { phase?: "charxImport" | "realmImport"; kind?: "charx" } = {},
): AsyncGenerator<Uint8Array> {
    try {
        let card: string | null = null;
        let moduleData: string | null = null;
        // No prototype: an entry may be named `__proto__`.
        const assets: Record<string, string> = Object.create(null);
        const excluded: string[] = [];
        let done = 0;
        let lastLine = performance.now();
        for (const entry of entries) {
            if (signal.aborted) {
                return;
            }
            if (entry.excluded) {
                excluded.push(entry.name);
                continue;
            }
            if (entry.kind === "ignored") {
                continue;
            }
            const bytes = await readEntry(handle, entry);
            if (bytes === null) {
                excluded.push(entry.name);
            } else if (entry.kind === "card") {
                card = decodeCharxCard(bytes);
            } else if (entry.kind === "module") {
                moduleData = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
            } else {
                // The client's key (`saveAsset` with its default extension; decision 4).
                const key = await writeContentAsset(savePath, snapshots, bytes, signal);
                if (key === null) {
                    return;
                }
                assets[entry.name] = key;
            }
            if (entry.kind === "asset") {
                done += 1;
                const now = performance.now();
                if (done === total || now - lastLine >= PROGRESS_INTERVAL_MS) {
                    lastLine = now;
                    yield ndjsonLine({ done, total } satisfies CharxImportProgress);
                }
            }
        }
        const fields = { card, moduleData, assets, excluded } satisfies CharxImportResult;
        const result = ndjsonLine(options.kind ? { kind: options.kind, ...fields } : fields);
        recordSafely(diagnostics, { kind: "lifecycle", phase: options.phase ?? "charxImport" });
        await finalize();
        yield result;
    } catch (error) {
        const known = error instanceof MaintenanceError || error instanceof CharxFileError;
        if (!known) {
            console.error("[Server] CharX import failed:", error);
        }
        await finalize();
        const message =
            error instanceof MaintenanceError
                ? error.message
                : error instanceof CharxFileError
                  ? INVALID_CHARX_FILE
                  : "Import failed";
        yield ndjsonLine({ error: message } satisfies CharxImportFailure);
    } finally {
        await finalize();
    }
}

/**
 * Checks the zip's whole structure before anything is written (see the route comment), reading the
 * end records, the central directory, and each local header and data descriptor (never an entry's
 * bytes). Throws `CharxFileError` for a file the route refuses.
 */
export async function planCharxFile(handle: FileHandle): Promise<CharxFilePlan> {
    const size = (await handle.stat()).size;
    const tailLength = Math.min(size, ZIP_END_SEARCH_BYTES);
    const end = findZipEnd(await readAt(handle, new Uint8Array(tailLength), size - tailLength), size - tailLength);
    let { cdSize, cdOffset } = end;
    // Where the central directory ends: at the zip64 end record, or at the end record.
    let cdEnd = end.position;
    let wrapped = true;
    if (end.zip64 && end.position >= ZIP64_LOCATOR_BYTES) {
        const locatorStart = end.position - ZIP64_LOCATOR_BYTES;
        const recordOffset = readZip64Locator(await readAt(handle, new Uint8Array(ZIP64_LOCATOR_BYTES), locatorStart));
        if (recordOffset !== null) {
            // The record's offset counts from the zip's start; a prefixed zip has it just before the locator.
            let found = false;
            for (const position of [recordOffset, locatorStart - ZIP64_END_BYTES]) {
                if (position < 0 || position + ZIP64_END_BYTES > locatorStart) {
                    continue;
                }
                const record = readZip64End(await readAt(handle, new Uint8Array(ZIP64_END_BYTES), position));
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
    // Every offset is shifted by what precedes the zip (a `charxJpeg`'s JPEG). Without zip64 the
    // central directory's offset is a 32-bit field, wrapped past 4 GiB by fflate's writer.
    const prefix = wrapped ? positiveModulo(cdStart - cdOffset) : cdStart - cdOffset;
    if (prefix < 0 || prefix > cdStart) {
        throw new CharxFileError("The zip central directory's offset is wrong");
    }
    const central = readCentralDirectory(await readAt(handle, new Uint8Array(cdSize), cdStart));
    // The records by local header offset, mod 2^32 as the walk compares them. The walk starts at the
    // first entry: at the prefix for a zip written alone, past it for one whose offsets count it.
    const byOffset = new Map<number, ZipCentralEntry[]>();
    let firstOffset = Infinity;
    for (const entry of central) {
        firstOffset = Math.min(firstOffset, entry.offset);
        const key = entry.offset % ZIP_OFFSET_MODULUS;
        const list = byOffset.get(key);
        if (list) {
            list.push(entry);
        } else {
            byOffset.set(key, [entry]);
        }
    }

    const window = walkWindow(handle, cdStart);
    const entries: CharxPlanEntry[] = [];
    let total = 0;
    let position = prefix + (central.length > 0 ? firstOffset : 0);
    for (let index = 0; index < central.length; index++) {
        const local = readLocalHeader(
            await window(position, localHeaderLength(await window(position, ZIP_LOCAL_HEADER_BYTES))),
        );
        const candidates = byOffset.get((position - prefix) % ZIP_OFFSET_MODULUS);
        const match = candidates?.findIndex((entry) => sameZipName(entry.name, local.name)) ?? -1;
        if (match < 0) {
            throw new CharxFileError("A zip entry is not in the central directory");
        }
        const record = candidates!.splice(match, 1)[0];
        if (record.method !== local.method) {
            throw new CharxFileError("A zip entry's method differs from its central-directory record");
        }
        const compressedSize = entryCompressedSize(local, record);
        const dataStart = position + local.headerLength;
        position = dataStart + compressedSize;
        if (position > cdStart) {
            throw new CharxFileError("A zip entry runs into the central directory");
        }
        if (hasDataDescriptor(local)) {
            const head = await window(position, Math.min(ZIP_DESCRIPTOR_MAX_BYTES, cdStart - position));
            position += dataDescriptorLength(head, local.zip64 || record.zip64Sizes);
            if (position > cdStart) {
                throw new CharxFileError("A zip data descriptor runs into the central directory");
            }
        }
        const name = decodeZipName(local.name, local.flags);
        const kind = charxEntryKind(name);
        const excluded = excludedBeforeReading(local, record, compressedSize);
        if (!excluded && local.method !== ZIP_METHOD_STORED && local.method !== ZIP_METHOD_DEFLATED) {
            throw new CharxFileError("A zip entry uses an unsupported compression method");
        }
        if (!excluded && kind === "asset") {
            total += 1;
        }
        entries.push({ name, kind, method: local.method, dataStart, compressedSize, excluded });
    }
    if (!entries.some((entry) => entry.kind === "card")) {
        throw new CharxFileError("The file holds no card.json");
    }
    return { entries, total };
}

/**
 * An entry's decoded bytes, or null when they are over `MAX_CHARX_ENTRY_BYTES` (excluded). A corrupt
 * deflate stream throws `CharxFileError`.
 */
async function readEntry(handle: FileHandle, entry: CharxPlanEntry): Promise<Uint8Array | null> {
    if (entry.compressedSize === 0) {
        return new Uint8Array(0);
    }
    const stored = await readAt(handle, new Uint8Array(entry.compressedSize), entry.dataStart);
    if (entry.method === ZIP_METHOD_STORED) {
        return stored.length > MAX_CHARX_ENTRY_BYTES ? null : stored;
    }
    try {
        return await inflateRaw(stored, { maxOutputLength: MAX_CHARX_ENTRY_BYTES });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ERR_BUFFER_TOO_LARGE") {
            return null;
        }
        if (typeof code === "string" && code.startsWith("Z_")) {
            throw new CharxFileError(`A zip entry's deflate stream is corrupt (${code})`);
        }
        throw error;
    }
}

/**
 * A reader of short spans for the validation walk: one `WALK_WINDOW_BYTES` window moving forward
 * through the file, so the local headers and data descriptors of small entries take a read for
 * several. A span past `limit` (the central directory's start) is a malformed file. The bytes
 * returned are valid until the next call.
 */
function walkWindow(handle: FileHandle, limit: number) {
    const buffer = new Uint8Array(WALK_WINDOW_BYTES);
    let start = 0;
    let filled = 0;
    return async (position: number, length: number): Promise<Uint8Array> => {
        if (position < 0 || position + length > limit) {
            throw new CharxFileError("A zip record runs into the central directory");
        }
        if (position >= start && position + length <= start + filled) {
            return buffer.subarray(position - start, position - start + length);
        }
        if (length > buffer.length) {
            return readAt(handle, new Uint8Array(length), position);
        }
        start = position;
        filled = Math.min(buffer.length, limit - position);
        await readAt(handle, buffer.subarray(0, filled), position);
        return buffer.subarray(0, length);
    };
}

/** `value` mod 2^32, as a non-negative number. */
function positiveModulo(value: number): number {
    return ((value % ZIP_OFFSET_MODULUS) + ZIP_OFFSET_MODULUS) % ZIP_OFFSET_MODULUS;
}

/** Fills `buffer` from the file at `position`; a file that ends first is malformed. */
function readAt(handle: FileHandle, buffer: Uint8Array, position: number): Promise<Uint8Array> {
    return readFileAt(handle, buffer, position, () => new CharxFileError("The character file is truncated"));
}

/** The route's refusal before the stream started (maintenance and any other error are `serveFileImport`'s). */
function refusal(c: Context<AppEnv>, error: unknown): Response | null {
    if (error instanceof CharxFileError) {
        return c.json({ error: INVALID_CHARX_FILE }, 400);
    }
    return null;
}
