import { isPlainObject } from "../../../shared/valueKinds.ts";
import { alertClear, alertError, alertWait, type alertData } from "../alert";
import { authFetch } from "./serverAuth";

/**
 * The shared NDJSON transport for module and CharX uploads, Realm prepare and commit, and upstream
 * backup prepare. `withServerImportWait` gives a tab action a Cancel button until its result is handed
 * to the importer. A signal stops the wait for headers or the body, including a silent server.
 * File uploads send the `File`/`Blob` itself, as `importBackup` (`resourceClient.ts`) sends its archive.
 * The browser streams it from disk with its `Content-Length` (the server checks that length against its cap
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
    /** Aborting stops the upload and the wait for a complete answer. */
    signal?: AbortSignal;
    /** Each progress line: `done` of the file's `total` assets are stored (a file without assets sends none). */
    onProgress?: (done: number, total: number) => void;
};

export class ServerImportCancelledError extends Error {
    constructor() {
        super("Import cancelled");
        this.name = "ServerImportCancelledError";
    }
}

/** Shows the import's failure dialog. User cancellation needs no error log. */
export function alertServerImportError(error: unknown, message: string) {
    if (error instanceof ServerImportCancelledError) alertError(message, { log: false });
    else alertError(message);
}

/** Owns the cancellable wait through the request and all its progress updates. An omitted message starts quietly. */
export async function withServerImportWait<T>(
    message: string | undefined,
    request: (signal: AbortSignal, showWait: (message: string) => void) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    let status: alertData | undefined;
    let active = true;
    const cancel = () => {
        if (active) controller.abort(new ServerImportCancelledError());
    };
    const showWait = (msg: string) => {
        if (active && !controller.signal.aborted) alertWait(msg, (installed) => (status = installed), cancel);
    };
    try {
        if (message !== undefined) showWait(message);
        const result = await request(controller.signal, showWait);
        controller.signal.throwIfAborted();
        return result;
    } catch (error) {
        controller.signal.throwIfAborted();
        throw error;
    } finally {
        active = false;
        if (status) alertClear(status);
    }
}

/**
 * Uploads `file` as the body of `POST path` and answers the route's result line. Every line is a
 * JSON object: one with `error` is the failure line; otherwise `readResult` returns the result for
 * the route's result line, null for any other line (which must then be a `{ done, total }` progress
 * line), or throws `ServerImportAnswerError` for a malformed result line. Throws
 * `ServerImportRequestError` for a non-2xx answer, `ServerImportFailedError` for a failure line,
 * `ServerImportAnswerError` for a malformed answer, and a network failure of the request or of the
 * body read as it is (a `TypeError`). An aborted signal rejects with `ServerImportCancelledError`.
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
    const { signal } = options;
    if (signal?.aborted) throw new ServerImportCancelledError();
    try {
        const res = await waitForAnswer(
            authFetch(path, {
                method: "POST",
                headers: { ...request.headers, "content-type": request.contentType },
                body: request.body,
                signal,
            }),
            signal,
        );
        signal?.throwIfAborted();
        const result = await waitForAnswer(readAnswer(res, readResult, options), signal);
        signal?.throwIfAborted();
        return result;
    } catch (error) {
        if (signal?.aborted) throw new ServerImportCancelledError();
        throw error;
    }
}

async function readAnswer<T>(
    res: Response,
    readResult: (line: Record<string, unknown>) => T | null,
    { signal, onProgress }: ServerImportOptions,
): Promise<T> {
    if (!res.ok) {
        throw new ServerImportRequestError(res.status, await answerError(res, signal));
    }
    let result = null as { value: T } | null;
    await forEachLine(res, signal, (text) => {
        signal?.throwIfAborted();
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
            signal?.throwIfAborted();
            onProgress?.(line.done as number, line.total as number);
            return;
        }
        throw new ServerImportAnswerError("A line of the answer is not one of the import's lines");
    });
    if (!result) {
        throw new ServerImportAnswerError("The answer ends without a result line");
    }
    return result.value;
}

/** Ends a pending header or body wait even when the underlying operation ignores the signal. */
function waitForAnswer<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
}

/** The `error` text of a refusal's JSON body; null when it has none (a reverse proxy may answer HTML). */
async function answerError(res: Response, signal?: AbortSignal): Promise<string | null> {
    try {
        let body: unknown;
        if (res.body && signal) {
            // Keep the refusal's reader available to Cancel while the server is sending its JSON.
            const chunks: string[] = [];
            await readTextChunks(res, (chunk) => chunks.push(chunk), signal);
            signal.throwIfAborted();
            body = JSON.parse(chunks.join(""));
        } else {
            body = await res.json();
        }
        return isPlainObject(body) && typeof body.error === "string" ? body.error : null;
    } catch {
        signal?.throwIfAborted();
        return null;
    }
}

/**
 * Calls `take` with each nonblank line of the answer as the body arrives (all at once when the answer
 * has no body stream). Each chunk is searched for newlines once, and a line's pieces are joined only
 * when it ends: a result line can be megabytes long. A throw from `take` or from the body read
 * cancels the body; a body that ends inside a line throws `ServerImportAnswerError`.
 */
async function forEachLine(
    res: Response,
    signal: AbortSignal | undefined,
    take: (line: string) => void,
): Promise<void> {
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
    await readTextChunks(res, push, signal);
    if (pieces.join("").trim() !== "") {
        throw new ServerImportAnswerError("The answer ends inside a line");
    }
}

/** Decodes text as it arrives. Cancel wakes a pending read even if the response ignores the fetch signal. */
async function readTextChunks(res: Response, take: (text: string) => void, signal?: AbortSignal): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
        const text = await res.text();
        signal?.throwIfAborted();
        take(text);
        return;
    }
    const decoder = new TextDecoder();
    const cancel = () => {
        void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
        while (true) {
            const { value, done } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            take(decoder.decode(value, { stream: true }));
        }
        take(decoder.decode());
    } catch (error) {
        if (!signal?.aborted) cancel();
        throw error;
    } finally {
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
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
