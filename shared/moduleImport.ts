import type { RisuModule } from "./modules.ts";
import { decodeRPackInPlace } from "./rpack.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * The `.risum` module file (`docs/plan/large-asset-import.md` slice 2b), a cross-user format
 * (STRUCTURE D5): the client's `exportModuleLegacy` writes it and `readModule` reads it
 * (`src/ts/process/modules.ts`), and the self-host server reads it too (`POST /api/import/module`,
 * `server/src/routes/importModule.ts`), so every reader stays byte-compatible with that writer.
 *
 * - Byte `MODULE_FILE_MAGIC` (111), byte `MODULE_FILE_VERSION` (0), `u32le mainLength`, then
 *   `mainLength` bytes: the rpack-encoded (`shared/rpack.ts`) UTF-8 JSON
 *   `{ "module": RisuModule, "type": "risuModule" }`, each `module.assets[i]` being `[name, "", ext]`.
 * - One record per asset, in `module.assets` order: byte `MODULE_ASSET_MARK` (1), `u32le length`,
 *   then `length` bytes, the rpack-encoded asset (zero-length for one the exporter could not read).
 * - Byte `MODULE_END_MARK` (0) ends the file.
 *
 * A reader stops at the end mark and ignores any bytes after it, accepts fewer records than
 * `module.assets` (the entries past the last record keep the key `""`), and refuses more. Each
 * record's decoded bytes are stored under `assets/<SHA-256 hex of those bytes>.png`, the key the
 * client's `saveAsset` gives them (the extension is never sniffed).
 *
 * The helpers are pure (`Uint8Array`, `DataView`, `TextDecoder`), so the server route and the
 * client's local header read (slice 2c) share one reader.
 */

/** `POST`: a `.risum` file as the raw body; the answer is NDJSON `ModuleImportLine`s. */
export const MODULE_IMPORT_PATH = "/api/import/module";
export const MODULE_FILE_MAGIC = 111;
export const MODULE_FILE_VERSION = 0;
/** The magic, the version, and the main record's `u32le` length. */
export const MODULE_FILE_HEADER_BYTES = 6;
/** Most bytes of the main record (the module's rpack-encoded JSON). */
export const MAX_MODULE_MAIN_BYTES = 64 * 1024 * 1024;
/** Most bytes of one asset record: the server's body limit for one `/api/write`. */
export const MAX_MODULE_ASSET_BYTES = 100 * 1024 * 1024;
/** The mark before each asset record. */
export const MODULE_ASSET_MARK = 1;
/** The mark that ends the file. */
export const MODULE_END_MARK = 0;

/** A file that does not follow the `.risum` format. */
export class ModuleFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModuleFileError";
    }
}

/**
 * The file header, from the first `MODULE_FILE_HEADER_BYTES` bytes of `bytes` (the rest is not
 * read). Throws `ModuleFileError` for a shorter buffer, another magic or version, or a main record
 * over `MAX_MODULE_MAIN_BYTES`.
 */
export function readModuleFileHeader(bytes: Uint8Array): { mainLength: number } {
    if (bytes.length < MODULE_FILE_HEADER_BYTES) {
        throw new ModuleFileError("The module file is truncated");
    }
    if (bytes[0] !== MODULE_FILE_MAGIC) {
        throw new ModuleFileError("Not a module file");
    }
    if (bytes[1] !== MODULE_FILE_VERSION) {
        throw new ModuleFileError("Unsupported module file version");
    }
    const mainLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
    if (mainLength > MAX_MODULE_MAIN_BYTES) {
        throw new ModuleFileError("The module's main record is too large");
    }
    return { mainLength };
}

// Not `fatal`: an invalid sequence becomes U+FFFD, as the client's `Buffer.toString()` reads it.
// `ignoreBOM` keeps a leading U+FEFF as that read does too (so `JSON.parse` refuses it there and here).
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The module of a main record. `bytes` is the record as stored, in a buffer the caller owns: it is
 * rpack-decoded in place, read as UTF-8 the way the client reads it, and parsed as JSON. Throws
 * `ModuleFileError` unless that is an object whose `type` is `"risuModule"` and whose `module` is an
 * object with, when it has one (`null` counts as none, as the client reads it), an `assets` list of
 * lists, so each entry's `[1]` can take its stored key. The module is returned as parsed: the import
 * flow (`prepareModuleImport`, `normalizeModule`) owns the rest of its shape.
 */
export function decodeModuleMain(bytes: Uint8Array): RisuModule {
    const text = decoder.decode(decodeRPackInPlace(bytes));
    let main: unknown;
    try {
        main = JSON.parse(text);
    } catch {
        throw new ModuleFileError("The module's main record is not JSON");
    }
    if (!isPlainObject(main) || main.type !== "risuModule" || !isPlainObject(main.module)) {
        throw new ModuleFileError("The main record holds no module");
    }
    const assets = main.module.assets;
    if (
        assets !== undefined &&
        assets !== null &&
        !(Array.isArray(assets) && assets.every((entry) => Array.isArray(entry)))
    ) {
        throw new ModuleFileError("The module's asset list is not a list of lists");
    }
    return main.module as unknown as RisuModule;
}

/** A progress line: `done` of the file's `total` asset records are stored. */
export type ModuleImportProgress = { done: number; total: number };

/**
 * The last line of an import that stored every record: the module as the file holds it, each
 * `assets[i][1]` set to the key its record is stored under (`""` past the file's last record), and
 * how many records were written or found already stored.
 */
export type ModuleImportResult = { module: RisuModule; assetsWritten: number; assetsSkipped: number };

/**
 * The last line of an import that failed: nothing more is written, and the client adds no module
 * (the files stored before the failure stay, content-addressed).
 */
export type ModuleImportFailure = { error: string };

/** One line of the route's NDJSON answer: progress lines, then one result or one failure. */
export type ModuleImportLine = ModuleImportProgress | ModuleImportResult | ModuleImportFailure;
