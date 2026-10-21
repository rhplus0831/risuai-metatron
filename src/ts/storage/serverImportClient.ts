import { isPlainObject } from "../../../shared/valueKinds.ts";
import { authFetch } from "./serverAuth";

/**
 * The client of the server's file imports that answer NDJSON: `POST /api/import/module` (`.risum`,
 * `moduleImportClient.ts`) and `POST /api/import/charx` (CharX, `charxImportClient.ts`), the transport
 * only. The request body is the
 * `File`/`Blob` itself, as `importBackup` (`resourceClient.ts`) sends its archive: the browser
 * streams it from disk with its `Content-Length` (the server checks that length against its cap
 * before reading the body), and the tab holds no copy. Never a `ReadableStream` body: Chrome streams
 * one only over HTTP/2, and without a `Content-Length`.
 *
 * One request, never retried: a retry would upload the whole file again, and a refusal the server
 * sends before it reads the body (another import running, a file too large, maintenance) can reach
 * the browser as a network failure instead of its status, since Node may reset the socket while the
 * upload still streams. That failure is the `TypeError` `fetch` throws, left to the caller as it is.
 * The answer's headers arrive only after the whole upload is spooled and validated; its NDJSON body
 * (`{ done, total }` lines, then one result line or one `{ error }` line) is read as it streams.
 */

/** A non-2xx answer: its status, and its `error` text when the body is JSON with one. */
export class ServerImportRequestError extends Error {
    readonly status: number;
    readonly serverError: string | null;
    constructor(status: number, serverError: string | null) {
        super(serverError ?? `Import failed (${status})`);
        this.name = "ServerImportRequestError";
        this.status = status;
        this.serverError = serverError;
    }
}

/** The answer's last line was `{ error }`: the server stopped, and nothing is to be added. */
export class ServerImportFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ServerImportFailedError";
    }
}

/**
 * A 2xx answer that is not the route's NDJSON: a line that is not one of its lines, a line after the
 * result, a body that ends inside a line, or no result line.
 */
export class ServerImportAnswerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ServerImportAnswerError";
    }
}

export type ServerImportOptions = {
    /** Each progress line: `done` of the file's `total` assets are stored (a file without assets sends none). */
    onProgress?: (done: number, total: number) => void;
};

/**
 * Uploads `file` as the body of `POST path` and answers the route's result line. Every line is a
 * JSON object: one with `error` is the failure line; otherwise `readResult` returns the result for
 * the route's result line, null for any other line (which must then be a `{ done, total }` progress
 * line), or throws `ServerImportAnswerError` for a malformed result line. Throws
 * `ServerImportRequestError` for a non-2xx answer, `ServerImportFailedError` for a failure line,
 * `ServerImportAnswerError` for a malformed answer, and a network failure of the request or of the
 * body read as it is (a `TypeError`).
 */
export function importFileOverServer<T>(
    path: string,
    file: Blob,
    readResult: (line: Record<string, unknown>) => T | null,
    options: ServerImportOptions = {},
): Promise<T> {
    return importOverServer(path, { body: file, contentType: "application/octet-stream" }, readResult, options);
}

/**
 * `importFileOverServer` with any request body: the Realm download (`realmImportClient.ts`) sends
 * `{ id }` as JSON, and the server fetches the file itself. Same answer and errors. `headers` are
 * added to the request (the upstream backup import's epoch, `upstreamBackupClient.ts`).
 */
export async function importOverServer<T>(
    path: string,
    request: { body: BodyInit; contentType: string; headers?: Record<string, string> },
    readResult: (line: Record<string, unknown>) => T | null,
    options: ServerImportOptions = {},
): Promise<T> {
    const res = await authFetch(path, {
        method: "POST",
        headers: { ...request.headers, "content-type": request.contentType },
        body: request.body,
    });
    if (!res.ok) {
        throw new ServerImportRequestError(res.status, await answerError(res));
    }
    let result = null as { value: T } | null;
    await forEachLine(res, (text) => {
        if (result) {
            throw new ServerImportAnswerError("The answer goes on after its result line");
        }
        const line = parseLine(text);
        if ("error" in line) {
            throw new ServerImportFailedError(String(line.error));
        }
        const value = readResult(line);
        if (value !== null) {
            result = { value };
            return;
        }
        if (Number.isFinite(line.done) && Number.isFinite(line.total)) {
            options.onProgress?.(line.done as number, line.total as number);
            return;
        }
        throw new ServerImportAnswerError("A line of the answer is not one of the import's lines");
    });
    if (!result) {
        throw new ServerImportAnswerError("The answer ends without a result line");
    }
    return result.value;
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
 * when it ends: a result line can be megabytes long. A throw from `take` or from the body read
 * cancels the body; a body that ends inside a line throws `ServerImportAnswerError`.
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
        throw new ServerImportAnswerError("The answer ends inside a line");
    }
}

/** One line of the answer as a JSON object. */
function parseLine(text: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ServerImportAnswerError("A line of the answer is not JSON");
    }
    if (!isPlainObject(value)) {
        throw new ServerImportAnswerError("A line of the answer is not an object");
    }
    return value;
}
