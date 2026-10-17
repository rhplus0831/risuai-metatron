import { MODULE_IMPORT_PATH, type ModuleImportLine, type ModuleImportResult } from "../../../shared/moduleImport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { authFetch } from "./serverAuth";

/**
 * The client of the server's `.risum` module import (`POST /api/import/module`,
 * `server/src/routes/importModule.ts`; `docs/plan/large-asset-import.md` slice 2c), the transport
 * only: `importModuleFile` (`src/ts/process/modules.ts`) owns the import. The request body is the
 * `File`/`Blob` itself, as `importBackup` (`resourceClient.ts`) sends its archive: the browser
 * streams it from disk with its `Content-Length` (the server checks that length against its cap
 * before reading the body), and the tab holds no copy. Never a `ReadableStream` body: Chrome
 * streams one only over HTTP/2, and without a `Content-Length`.
 *
 * One request, never retried: a retry would upload the whole file again, and a refusal the server
 * sends before it reads the body (another import running, a file too large, maintenance) can reach
 * the browser as a network failure instead of its status, since Node may reset the socket while the
 * upload still streams. That failure is the `TypeError` `fetch` throws, left to the caller as it is.
 * The answer's headers arrive only after the whole upload is spooled and validated; its NDJSON body
 * (`ModuleImportLine`) is read as it streams.
 */

/** A non-2xx answer: its status, and its `error` text when the body is JSON with one. */
export class ModuleImportRequestError extends Error {
    readonly status: number;
    readonly serverError: string | null;
    constructor(status: number, serverError: string | null) {
        super(serverError ?? `Module import failed (${status})`);
        this.name = "ModuleImportRequestError";
        this.status = status;
        this.serverError = serverError;
    }
}

/** The answer's last line was `{ error }`: the server stopped, and no module is to be added. */
export class ModuleImportFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModuleImportFailedError";
    }
}

/**
 * A 2xx answer that is not the route's NDJSON: a line that is not one of its lines, a line after the
 * result, a body that ends inside a line, or no result line.
 */
export class ModuleImportAnswerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModuleImportAnswerError";
    }
}

export type ModuleImportOptions = {
    /** Each progress line: `done` of the file's `total` asset records are stored (a file without assets sends none). */
    onProgress?: (done: number, total: number) => void;
};

/**
 * Uploads `file` (a `.risum`) and answers the server's result: the module as the file holds it, each
 * stored asset's key in `assets[i][1]`. Throws `ModuleImportRequestError` for a non-2xx answer,
 * `ModuleImportFailedError` for a failure line, `ModuleImportAnswerError` for a malformed answer, and
 * a network failure of the request or of the body read as it is (a `TypeError`).
 */
export async function importModuleOverServer(
    file: Blob,
    options: ModuleImportOptions = {},
): Promise<ModuleImportResult> {
    const res = await authFetch(MODULE_IMPORT_PATH, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
    });
    if (!res.ok) {
        throw new ModuleImportRequestError(res.status, await answerError(res));
    }
    let result = null as ModuleImportResult | null;
    await forEachLine(res, (text) => {
        if (result) {
            throw new ModuleImportAnswerError("The answer goes on after its result line");
        }
        const line = parseLine(text);
        if ("error" in line) {
            throw new ModuleImportFailedError(line.error);
        }
        if ("module" in line) {
            result = line;
            return;
        }
        options.onProgress?.(line.done, line.total);
    });
    if (!result) {
        throw new ModuleImportAnswerError("The answer ends without a result line");
    }
    return result;
}

/** The `error` text of a refusal's JSON body; null when it has none (a reverse proxy may answer HTML). */
async function answerError(res: Response): Promise<string | null> {
    try {
        const body: unknown = await res.json();
        return isPlainObject(body) && typeof body.error === "string" ? body.error : null;
    } catch {
        return null;
    }
}

/**
 * Calls `take` with each nonblank line of the answer as the body arrives (all at once when the answer
 * has no body stream). Each chunk is searched for newlines once, and a line's pieces are joined only
 * when it ends: the result line can be megabytes long. A throw from `take` or from the body read
 * cancels the body; a body that ends inside a line throws `ModuleImportAnswerError`.
 */
async function forEachLine(res: Response, take: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let pieces: string[] = [];
    const push = (text: string) => {
        let start = 0;
        let newline = text.indexOf("\n");
        while (newline !== -1) {
            pieces.push(text.slice(start, newline));
            const line = pieces.join("");
            pieces = [];
            if (line.trim() !== "") {
                take(line);
            }
            start = newline + 1;
            newline = text.indexOf("\n", start);
        }
        if (start < text.length) {
            pieces.push(text.slice(start));
        }
    };
    const reader = res.body?.getReader();
    if (reader) {
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                push(decoder.decode(value, { stream: true }));
            }
        } catch (error) {
            void reader.cancel().catch(() => {});
            throw error;
        }
    } else {
        push(await res.text());
    }
    push(decoder.decode());
    if (pieces.join("").trim() !== "") {
        throw new ModuleImportAnswerError("The answer ends inside a line");
    }
}

/** One line of the answer, classified by its `error`, then its `module`, then its `done` and `total`. */
function parseLine(text: string): ModuleImportLine {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ModuleImportAnswerError("A line of the answer is not JSON");
    }
    if (!isPlainObject(value)) {
        throw new ModuleImportAnswerError("A line of the answer is not an object");
    }
    if ("error" in value) {
        return { error: String(value.error) };
    }
    if ("module" in value) {
        if (!isPlainObject(value.module)) {
            throw new ModuleImportAnswerError("The result line holds no module");
        }
        return value as unknown as ModuleImportResult;
    }
    if (Number.isFinite(value.done) && Number.isFinite(value.total)) {
        return { done: value.done as number, total: value.total as number };
    }
    throw new ModuleImportAnswerError("A line of the answer is not a module import line");
}
