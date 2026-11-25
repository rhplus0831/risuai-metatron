import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
    decodeModuleMain,
    MAX_MODULE_ASSET_BYTES,
    MODULE_ASSET_MARK,
    MODULE_END_MARK,
    MODULE_FILE_HEADER_BYTES,
    MODULE_IMPORT_PATH,
    ModuleFileError,
    type ModuleImportFailure,
    type ModuleImportProgress,
    type ModuleImportResult,
    readModuleFileHeader,
} from "../../../shared/moduleImport.ts";
import type { RisuModule } from "../../../shared/modules.ts";
import { decodeRPackInPlace } from "../../../shared/rpack.ts";
import { MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import {
    createImportSlot,
    type FileImportStream,
    type ImportSlot,
    readFileAt,
    serveFileImport,
} from "../http/fileImport.ts";
import { ASSET_LEASE_MS } from "../../../shared/assetLifecycle.ts";
import { contentNameHash, holdsVerifiedAsset } from "../http/assetVerification.ts";
import { ndjsonLine } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { claimAssetKey, isAssetStorageKey, storageFileExists } from "./storage.ts";

export { MODULE_IMPORT_PATH };

/** A record's mark and its `u32le` length. */
const RECORD_HEADER_BYTES = 5;
/** Least time between two progress lines; the last record always has one. */
const PROGRESS_INTERVAL_MS = 200;

/** An asset record over `MAX_MODULE_ASSET_BYTES`; the route answers 413. */
class AssetTooLargeError extends Error {}

/** A validated file: its module, where its asset records start, and how many there are. */
type ModuleFilePlan = { module: RisuModule; recordsStart: number; records: number };

/**
 * `POST /api/import/module`: a `.risum` module file as the raw body (`shared/moduleImport.ts`), so
 * the tab neither parses the file nor sends one request per asset. Authenticated before the body is
 * read; no epoch (only content-addressed files are written, and the client adds the module record
 * itself). The request lifecycle is `serveFileImport`'s (`http/fileImport.ts`): refused before the
 * body is read for a declared length over `maxImportBytes` (413), another import holding the shared
 * slot (409; the CharX import shares it), maintenance (503 with `Retry-After: 5`), no body (400); the
 * body spooled to `save/.tmp/module-<uuid>/` under `maxImportBytes` (exempt from the global body
 * limit). The whole file is validated from the file before anything is written: a malformed or
 * truncated file is a 400 `Invalid module file`, a record over `MAX_MODULE_ASSET_BYTES` a 413. Then
 * the answer is NDJSON (`ModuleImportLine`): each record is read, rpack-decoded, and stored under
 * `assets/<sha256 hex>.png` (skipped when that file already holds those bytes, replaced when it does not; each write
 * under the maintenance gate),
 * with throttled `{ done, total }` lines, then `{ module, assetsWritten, assetsSkipped }` with each
 * imported key in `module.assets[i][1]`, or one `{ error }` line at the first failure (nothing more
 * is written). Before the result every filled asset key is claimed again, replaying its source
 * record when missing. Metadata-only keys renew a lease when present and remain unchanged when
 * missing. Memory holds one asset at a time.
 */
export function registerModuleImportRoutes(
    app: Hono<AppEnv>,
    arg: {
        savePath: string;
        snapshots: SnapshotManager;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maxImportBytes: number;
        /** The diagnostics journal: a `lifecycle` event after an import stored every record. */
        diagnostics?: DiagnosticsRecorder;
        /** The import slot shared with the CharX import (`createServerContext`); a slot of its own without one. */
        slot?: ImportSlot;
    },
) {
    const { savePath, snapshots, auth, limiter, maxImportBytes, diagnostics } = arg;
    const deps = { savePath, snapshots, auth, maxImportBytes, slot: arg.slot ?? createImportSlot() };

    app.post(MODULE_IMPORT_PATH, limiter, (c) =>
        serveFileImport(c, deps, {
            stagingPrefix: "module",
            fileName: "module.risum",
            missingBody: "Module body required",
            prepare: planModuleFile,
            refusal,
            lines,
        }),
    );

    // Never throws once the stream has started (`iteratorStream` would error it, and the client
    // would see a network failure instead of the line): a failure is the last line. That last
    // line, a result or a failure, is sent once `finalize` has run, so an import the client
    // starts when it reads the line is admitted.
    async function* lines(
        { module, recordsStart, records: total }: ModuleFilePlan,
        { handle: file, signal, finalize }: FileImportStream,
    ): AsyncGenerator<Uint8Array> {
        try {
            let assetsWritten = 0;
            let assetsSkipped = 0;
            let lastLine = performance.now();
            const header = new Uint8Array(RECORD_HEADER_BYTES);
            const view = new DataView(header.buffer);
            let position = recordsStart;
            const replay = new Map<string, { position: number; length: number; hashHex: string }>();
            // A writable copy filled as the records stream, assigned once (the module type is readonly);
            // an absent or null list stays as it was.
            const filled = Array.isArray(module.assets)
                ? module.assets.map((asset) => [...asset] as [string, string, string])
                : null;
            for (let index = 0; index < total; index++) {
                if (signal.aborted) {
                    return;
                }
                await readAt(file, header, position);
                const length = view.getUint32(1, true);
                const assetPosition = position + RECORD_HEADER_BYTES;
                const bytes = await readAt(file, new Uint8Array(length), assetPosition);
                position += RECORD_HEADER_BYTES + length;
                decodeRPackInPlace(bytes);
                // The client's key (`saveAsset` with its default extension). A file there that does
                // not hold these bytes (empty, truncated, wrong) is replaced.
                const hashHex = createHash("sha256").update(bytes).digest("hex");
                const key = `assets/${hashHex}.png`;
                const leave = snapshots.gate.enter();
                try {
                    const claimed = await claimAssetKey(savePath, key, {
                        verify: (fullPath) => holdsVerifiedAsset(fullPath, hashHex),
                        bytes,
                        hashHex,
                        signal,
                    });
                    if (claimed === "present") assetsSkipped++;
                    else assetsWritten++;
                } finally {
                    leave();
                }
                replay.set(key, { position: assetPosition, length, hashHex });
                filled![index][1] = key;
                const now = performance.now();
                if (index + 1 === total || now - lastLine >= PROGRESS_INTERVAL_MS) {
                    lastLine = now;
                    yield ndjsonLine({ done: index + 1, total } satisfies ModuleImportProgress);
                }
            }
            // Replay offsets retain no asset bytes. Only supplied records are required here;
            // metadata-only keys remain portable when absent, and renew their lease when present.
            const claimStart = performance.now();
            for (const key of new Set(filled?.map((asset) => asset[1]).filter(isAssetStorageKey) ?? [])) {
                const source = replay.get(key);
                const hashHex = source?.hashHex ?? contentNameHash(key);
                const leave = snapshots.gate.enter();
                try {
                    const status = await claimAssetKey(savePath, key, {
                        signal,
                        verify: (fullPath) =>
                            hashHex ? holdsVerifiedAsset(fullPath, hashHex) : storageFileExists(savePath, key),
                        hashHex: hashHex ?? undefined,
                        bytes: source
                            ? async () => {
                                  const bytes = await readAt(file, new Uint8Array(source.length), source.position);
                                  decodeRPackInPlace(bytes);
                                  if (createHash("sha256").update(bytes).digest("hex") !== source.hashHex)
                                      throw new Error("Module asset changed during replay");
                                  return bytes;
                              }
                            : undefined,
                    });
                    if (source && status === "missing") throw new Error(`Module asset is missing: ${key}`);
                } finally {
                    leave();
                }
            }
            if (performance.now() - claimStart >= ASSET_LEASE_MS)
                throw new Error("Module asset claims expired before completion");
            if (filled) {
                module.assets = filled;
            }
            const result = ndjsonLine({ module, assetsWritten, assetsSkipped } satisfies ModuleImportResult);
            recordSafely(diagnostics, { kind: "lifecycle", phase: "moduleImport" });
            await finalize();
            if (performance.now() - claimStart >= ASSET_LEASE_MS)
                throw new Error("Module asset claims expired before completion");
            yield result;
        } catch (error) {
            if (!(error instanceof MaintenanceError)) {
                console.error("[Server] Module import failed:", error);
            }
            await finalize();
            const message = error instanceof MaintenanceError ? error.message : "Import failed";
            yield ndjsonLine({ error: message } satisfies ModuleImportFailure);
        } finally {
            await finalize();
        }
    }
}

/**
 * Checks the whole file before anything is written, reading its header, its main record, and each
 * asset record's header (never a record's bytes). The walk stops at the end mark, ignoring any
 * bytes after it (the client's reader does), and refuses a record past `module.assets`, so a main
 * record naming many assets cannot make it long; fewer records than assets is fine.
 */
async function planModuleFile(handle: FileHandle): Promise<ModuleFilePlan> {
    const size = (await handle.stat()).size;
    const { mainLength } = readModuleFileHeader(await readAt(handle, new Uint8Array(MODULE_FILE_HEADER_BYTES), 0));
    const recordsStart = MODULE_FILE_HEADER_BYTES + mainLength;
    if (recordsStart > size) {
        throw new ModuleFileError("The module file is truncated");
    }
    const module = decodeModuleMain(await readAt(handle, new Uint8Array(mainLength), MODULE_FILE_HEADER_BYTES));
    const assets = module.assets?.length ?? 0;
    const header = new Uint8Array(RECORD_HEADER_BYTES);
    const view = new DataView(header.buffer);
    let position = recordsStart;
    let records = 0;
    while (true) {
        if (position >= size) {
            throw new ModuleFileError("The module file has no end mark");
        }
        // The end mark may be the file's last byte.
        const available = Math.min(RECORD_HEADER_BYTES, size - position);
        await readAt(handle, header.subarray(0, available), position);
        if (header[0] === MODULE_END_MARK) {
            return { module, recordsStart, records };
        }
        if (header[0] !== MODULE_ASSET_MARK) {
            throw new ModuleFileError("The module file holds an unknown record");
        }
        if (records === assets) {
            throw new ModuleFileError("The module file holds more records than assets");
        }
        if (available < RECORD_HEADER_BYTES) {
            throw new ModuleFileError("The module file is truncated");
        }
        const length = view.getUint32(1, true);
        if (length > MAX_MODULE_ASSET_BYTES) {
            throw new AssetTooLargeError();
        }
        position += RECORD_HEADER_BYTES + length;
        records += 1;
    }
}

/** Fills `buffer` from the file at `position`; a file that ends first is truncated. */
function readAt(handle: FileHandle, buffer: Uint8Array, position: number): Promise<Uint8Array> {
    return readFileAt(handle, buffer, position, () => new ModuleFileError("The module file is truncated"));
}

/** The route's refusals before the stream started (maintenance and any other error are `serveFileImport`'s). */
function refusal(c: Context<AppEnv>, error: unknown): Response | null {
    if (error instanceof ModuleFileError) {
        return c.json({ error: "Invalid module file" }, 400);
    }
    if (error instanceof AssetTooLargeError) {
        return c.json({ error: "Asset too large" }, 413);
    }
    return null;
}
