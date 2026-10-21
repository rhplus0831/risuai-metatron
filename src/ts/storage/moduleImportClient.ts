import { MODULE_IMPORT_PATH, type ModuleImportResult } from "../../../shared/moduleImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { importFileOverServer, ServerImportAnswerError, type ServerImportOptions } from "./serverImportClient";

/**
 * The client of the server's `.risum` module import (`POST /api/import/module`,
 * `server/src/routes/importModule.ts`), the transport
 * only: `importModuleFile` (`src/ts/process/modules.ts`) owns the import. The request, its answer, and
 * its errors are the shared file import client's (`serverImportClient.ts`): the `File`/`Blob` itself
 * as the body, one request never retried, the NDJSON answer (`ModuleImportLine`) read as it streams.
 * The error classes keep their module-specific names here.
 */

export {
    ServerImportAnswerError as ModuleImportAnswerError,
    ServerImportFailedError as ModuleImportFailedError,
    ServerImportRequestError as ModuleImportRequestError,
} from "./serverImportClient";

export type ModuleImportOptions = ServerImportOptions;

/**
 * Uploads `file` (a `.risum`) and answers the server's result: the module as the file holds it, each
 * stored asset's key in `assets[i][1]`. Throws `ModuleImportRequestError` for a non-2xx answer,
 * `ModuleImportFailedError` for a failure line, `ModuleImportAnswerError` for a malformed answer, and
 * a network failure of the request or of the body read as it is (a `TypeError`).
 */
export function importModuleOverServer(file: Blob, options: ModuleImportOptions = {}): Promise<ModuleImportResult> {
    return importFileOverServer(MODULE_IMPORT_PATH, file, readModuleResult, options);
}

/** The result line, told apart by its `module`. */
function readModuleResult(line: Record<string, unknown>): ModuleImportResult | null {
    if (!("module" in line)) {
        return null;
    }
    if (!isPlainObject(line.module)) {
        throw new ServerImportAnswerError("The result line holds no module");
    }
    return line as unknown as ModuleImportResult;
}
