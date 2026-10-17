import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
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
import { iteratorStream } from "../http/recordStream.ts";
import { makeStaging, ndjsonLine, spool } from "../http/spool.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { storageFileExists, writeStorageFile } from "./storage.ts";

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
 * `POST /api/import/module` (`docs/plan/large-asset-import.md` slice 2b): a `.risum` module file as
 * the raw body (`shared/moduleImport.ts`), so the tab neither parses the file nor sends one request
 * per asset. Authenticated before the body is read; no epoch (only content-addressed files are
 * written, and the client adds the module record itself). Refused before the body is read: a
 * declared length over `maxImportBytes` (413), another module import running (409), maintenance
 * (503 with `Retry-After`), no body (400). The body is spooled to `save/.tmp/module-<uuid>/` under
 * `maxImportBytes` (exempt from the global body limit), and the whole file is validated from the
 * file before anything is written: a malformed or truncated file is a 400 `Invalid module file`, a
 * record over `MAX_MODULE_ASSET_BYTES` a 413. Then the answer is NDJSON (`ModuleImportLine`): each
 * record is read, rpack-decoded, and stored under `assets/<sha256 hex>.png` (skipped when that file
 * exists; each write under the maintenance gate), with throttled `{ done, total }` lines, then
 * `{ module, assetsWritten, assetsSkipped }`, or one `{ error }` line at the first failure (nothing
 * more is written). Memory holds the main record and one asset record at a time.
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
    },
) {
    const { savePath, snapshots, auth, limiter, maxImportBytes, diagnostics } = arg;
    const tmpPath = path.join(savePath, ".tmp");
    let importing = false;

    app.post(MODULE_IMPORT_PATH, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const declared = Number(c.req.header("content-length") ?? "0");
        if (declared > maxImportBytes) {
            return c.json({ error: "File too large" }, 413);
        }
        if (importing) {
            return c.json({ error: "Another import is running" }, 409);
        }
        if (snapshots.gate.active) {
            return refusal(c, new MaintenanceError());
        }
        const body = c.req.raw.body;
        if (!body) {
            return c.json({ error: "Module body required" }, 400);
        }

        // The import's lifetime (spool, validation, and stream) is tracked, so shutdown waits for it.
        // One finalizer closes the file, removes the staging folder, clears the flag, and releases
        // the lifetime: when a step before the stream fails, when the stream has its last line or
        // is cancelled, or when the client is gone.
        const signal = c.req.raw.signal;
        let release!: () => void;
        const lifetime = new Promise<void>((resolve) => (release = resolve));
        try {
            snapshots.track(() => lifetime);
        } catch (error) {
            return refusal(c, error);
        }
        importing = true;
        let staging: string | null = null;
        let handle: FileHandle | null = null;
        let finalized: Promise<void> | null = null;
        const finalize = () =>
            (finalized ??= (async () => {
                await handle?.close().catch(() => {});
                if (staging) {
                    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
                }
                importing = false;
                release();
            })());

        let file: FileHandle;
        let plan: ModuleFilePlan;
        try {
            staging = await makeStaging(tmpPath, "module");
            const spooled = path.join(staging, "module.risum");
            if (!(await spool(body, spooled, maxImportBytes))) {
                await finalize();
                return c.json({ error: "File too large" }, 413);
            }
            file = await fs.open(spooled, "r");
            handle = file;
            plan = await planModuleFile(file);
        } catch (error) {
            await finalize();
            return refusal(c, error);
        }
        if (signal.aborted) {
            await finalize();
            return c.json({ error: "Request aborted" }, 400);
        }

        const { module, recordsStart, records: total } = plan;
        // Never throws once the stream has started (`iteratorStream` would error it, and the client
        // would see a network failure instead of the line): a failure is the last line. That last
        // line, a result or a failure, is sent once `finalize` has run, so an import the client
        // starts when it reads the line is admitted.
        async function* lines(): AsyncGenerator<Uint8Array> {
            try {
                let assetsWritten = 0;
                let assetsSkipped = 0;
                let lastLine = performance.now();
                const header = new Uint8Array(RECORD_HEADER_BYTES);
                const view = new DataView(header.buffer);
                let position = recordsStart;
                for (let index = 0; index < total; index++) {
                    if (signal.aborted) {
                        return;
                    }
                    await readAt(file, header, position);
                    const length = view.getUint32(1, true);
                    const bytes = await readAt(file, new Uint8Array(length), position + RECORD_HEADER_BYTES);
                    position += RECORD_HEADER_BYTES + length;
                    decodeRPackInPlace(bytes);
                    // The client's key (`saveAsset` with its default extension; decision 4).
                    const key = `assets/${createHash("sha256").update(bytes).digest("hex")}.png`;
                    if (await storageFileExists(savePath, key)) {
                        assetsSkipped += 1;
                    } else {
                        const leave = snapshots.gate.enter();
                        try {
                            await writeStorageFile(savePath, key, bytes);
                        } finally {
                            leave();
                        }
                        assetsWritten += 1;
                    }
                    module.assets![index][1] = key;
                    const now = performance.now();
                    if (index + 1 === total || now - lastLine >= PROGRESS_INTERVAL_MS) {
                        lastLine = now;
                        yield ndjsonLine({ done: index + 1, total } satisfies ModuleImportProgress);
                    }
                }
                const result = ndjsonLine({ module, assetsWritten, assetsSkipped } satisfies ModuleImportResult);
                recordSafely(diagnostics, { kind: "lifecycle", phase: "moduleImport" });
                await finalize();
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

        const iterator = lines();
        // The adapter attaches its own close listeners only once it writes the headers, so a client
        // gone before then would leave the generator suspended at a `yield` (the flag set, shutdown
        // waiting on the lifetime). The request signal is aborted whenever the connection closes
        // early: end the generator then, whether it never started, waits at a `yield`, or is inside
        // a step (that step ends first; the per-record check stops it).
        signal.addEventListener(
            "abort",
            () => {
                void iterator
                    .return(undefined)
                    .catch(() => {})
                    .finally(finalize);
            },
            { once: true },
        );
        c.header("Content-Type", "application/x-ndjson");
        c.header("Cache-Control", "no-store");
        return c.body(iteratorStream(iterator, finalize), 200);
    });
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
async function readAt(handle: FileHandle, buffer: Uint8Array, position: number): Promise<Uint8Array> {
    let done = 0;
    while (done < buffer.length) {
        const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done);
        if (bytesRead === 0) {
            throw new ModuleFileError("The module file is truncated");
        }
        done += bytesRead;
    }
    return buffer;
}

/** The answer to a refusal before the stream started; any other error is the app's 500. */
function refusal(c: Context<AppEnv>, error: unknown): Response {
    if (error instanceof ModuleFileError) {
        return c.json({ error: "Invalid module file" }, 400);
    }
    if (error instanceof AssetTooLargeError) {
        return c.json({ error: "Asset too large" }, 413);
    }
    if (error instanceof MaintenanceError) {
        c.header("Retry-After", "5");
        return c.json({ error: error.message }, 503);
    }
    throw error;
}
