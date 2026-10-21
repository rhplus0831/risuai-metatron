import { CHARX_IMPORT_PATH, type CharxImportResult } from "../../../shared/charxImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { importFileOverServer, ServerImportAnswerError, type ServerImportOptions } from "./serverImportClient";

/**
 * The client of the server's CharX import (`POST /api/import/charx`, `server/src/routes/importCharx.ts`),
 * the transport only: `importCharacterProcess`
 * (`src/ts/characterCards.ts`) owns the import. The request, its answer, and its errors are the
 * shared file import client's (`serverImportClient.ts`): the `File`/`Blob` itself as the body, one
 * request never retried, the NDJSON answer (`CharxImportLine`) read as it streams.
 */

/**
 * Uploads `file` (a `.charx`, or a `charxJpeg`) and answers the server's result: the card's text, the
 * embedded module base64-encoded, each asset entry's stored key by entry name, and the excluded
 * entries. Throws `ServerImportRequestError` for a non-2xx answer, `ServerImportFailedError` for a
 * failure line, `ServerImportAnswerError` for a malformed answer, and a network failure of the
 * request or of the body read as it is (a `TypeError`).
 */
export function importCharxOverServer(file: Blob, options: ServerImportOptions = {}): Promise<CharxImportResult> {
    return importFileOverServer(CHARX_IMPORT_PATH, file, readCharxResult, options);
}

/** The result line, told apart by its `assets`, with the shape the importer reads. */
export function readCharxResult(line: Record<string, unknown>): CharxImportResult | null {
    if (!("assets" in line)) {
        return null;
    }
    const { card, moduleData, assets, excluded } = line;
    if (
        !isTextOrNull(card) ||
        !isTextOrNull(moduleData) ||
        !isPlainObject(assets) ||
        !Object.values(assets).every((key) => typeof key === "string") ||
        !Array.isArray(excluded) ||
        !excluded.every((name) => typeof name === "string")
    ) {
        throw new ServerImportAnswerError("The result line is not a CharX import result");
    }
    return { card, moduleData, assets: assets as Record<string, string>, excluded };
}

function isTextOrNull(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}
