import {
    ASSET_BATCH_READ_PATH,
    ASSET_BATCH_WRITE_PATH,
    type AssetRecord,
    AssetRecordParser,
    encodeAssetRecordHeader,
} from "../../../shared/assetBatch.ts";
import { authFetch } from "./serverAuth";

/**
 * The asset files on the self-host server (split out of the old storage client):
 * bytes under a logical key (`assets/<id>.<ext>`), read with `GET /api/read` and written with `POST /api/write`.
 * The key travels hex-encoded (UTF-8) in the `file-path` header; the request is authenticated
 * (`authFetch`). The routes are the server's (`server/src/routes/storage.ts`). `writeAssets` and
 * `readAssets` move many assets per request through the batch routes (`/api/assets/write`,
 * `/api/assets/read`) in the backup archive's record framing (`shared/assetBatch.ts`), each record
 * named by its key.
 *
 * Every call retries an answer of 429 or 503 and a network failure (`fetch` throwing): the wait is the
 * answer's `Retry-After` (capped at {@link MAX_RETRY_AFTER_MS}) when it has one, else
 * {@link BASE_RETRY_DELAY_MS} doubling to {@link MAX_BACKOFF_MS}, for at most
 * {@link MAX_ASSET_ATTEMPTS} attempts in all; the last answer or error then decides as without a
 * retry. Every attempt goes through `authFetch` again (a fresh `risu-auth` token). Any other non-2xx
 * answer is not retried. An optional `signal` aborts both the wait and the request: the call then
 * throws the signal's reason (an `AbortError` when it has none).
 */

/** Attempts per call, the first included. */
export const MAX_ASSET_ATTEMPTS = 8;
/** The first backoff wait without a `Retry-After`; it doubles per attempt. */
export const BASE_RETRY_DELAY_MS = 1_000;
/** The cap of the doubling backoff. */
export const MAX_BACKOFF_MS = 30_000;
/** The cap of a server-sent `Retry-After`. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** Most record bytes (headers included) of one `writeAssets` request; a single larger asset goes alone. */
export const ASSET_BATCH_CLIENT_BYTES = 64 * 1024 * 1024;
/** Most records of one `writeAssets` or `readAssets` request (the server takes up to `MAX_ASSET_BATCH_RECORDS`). */
export const ASSET_BATCH_CLIENT_RECORDS = 500;

export type AssetRequestOptions = {
    /** Aborts the pending wait and the request in flight. */
    signal?: AbortSignal;
};

/** One asset for `writeAssets`. */
export type AssetWriteItem = { key: string; bytes: Uint8Array };

function encodedPath(key: string) {
    return Buffer.from(key, "utf-8").toString("hex");
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw abortReason(signal);
    }
}

/** The wait after failed attempt `attempt` (1-based) without a `Retry-After`: 1 s, 2 s, 4 s, … capped at 30 s. */
function backoffMs(attempt: number): number {
    return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** The answer's `Retry-After` in milliseconds (delta seconds, or an HTTP date), capped; `null` when absent or unreadable. */
function retryAfterMs(res: Response): number | null {
    const value = res.headers?.get("retry-after")?.trim();
    if (!value) {
        return null;
    }
    if (/^\d+(\.\d+)?$/.test(value)) {
        return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
    }
    const at = Date.parse(value);
    if (Number.isNaN(at)) {
        return null;
    }
    return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReason(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortReason(signal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Drops a retried answer's body so its connection is released. */
function discardBody(res: Response) {
    try {
        void res.body?.cancel().catch(() => {});
    } catch {}
}

/**
 * Sends `init()` to `path` through `authFetch` until the answer is neither 429 nor 503 and `fetch` did
 * not throw, or the attempts run out; returns the last answer, or throws the last network error.
 * An error thrown before the request was dispatched (the auth check, the password prompt) is not
 * retried unless it is a `TypeError`, which is what `fetch` throws for a network failure.
 */
async function requestWithRetry(path: string, init: () => RequestInit, signal: AbortSignal | undefined) {
    for (let attempt = 1; ; attempt++) {
        throwIfAborted(signal);
        let dispatched = false;
        let res: Response;
        try {
            res = await authFetch(path, signal ? { ...init(), signal } : init(), {
                beforeDispatch: () => {
                    dispatched = true;
                },
            });
        } catch (error) {
            throwIfAborted(signal);
            if ((!dispatched && !(error instanceof TypeError)) || attempt >= MAX_ASSET_ATTEMPTS) {
                throw error;
            }
            await delay(backoffMs(attempt), signal);
            continue;
        }
        if ((res.status === 429 || res.status === 503) && attempt < MAX_ASSET_ATTEMPTS) {
            const wait = retryAfterMs(res) ?? backoffMs(attempt);
            discardBody(res);
            await delay(wait, signal);
            continue;
        }
        return res;
    }
}

/** Rethrows `error`, or the signal's reason when the signal has fired (a body read cut by the abort). */
function rethrow(error: unknown, signal: AbortSignal | undefined): never {
    throwIfAborted(signal);
    throw error;
}

/**
 * Writes `value` under `key`, retrying as described above. Throws `"setItem Error"` for a non-2xx
 * answer and the answer's `error` for a refused one.
 */
export async function writeAsset(key: string, value: Uint8Array, options: AssetRequestOptions = {}): Promise<void> {
    const { signal } = options;
    const da = await requestWithRetry(
        "/api/write",
        () => ({
            method: "POST",
            body: value as any,
            headers: {
                "content-type": "application/octet-stream",
                "file-path": encodedPath(key),
            },
        }),
        signal,
    );
    if (da.status < 200 || da.status >= 300) {
        throw "setItem Error";
    }
    let data: any;
    try {
        data = await da.json();
    } catch (error) {
        rethrow(error, signal);
    }
    if (data.error) {
        throw data.error;
    }
}

/**
 * Reads the bytes under `key`, retrying as described above: `null` when there are none (a missing or
 * empty file). Throws `"getItem Error"` for a non-2xx answer.
 */
export async function readAsset(key: string, options: AssetRequestOptions = {}): Promise<Buffer | null> {
    const { signal } = options;
    const da = await requestWithRetry(
        "/api/read",
        () => ({
            method: "GET",
            headers: {
                "file-path": encodedPath(key),
            },
        }),
        signal,
    );
    if (da.status < 200 || da.status >= 300) {
        throw "getItem Error";
    }

    let data: Buffer;
    try {
        data = Buffer.from(await da.arrayBuffer());
    } catch (error) {
        rethrow(error, signal);
    }
    if (data.length == 0) {
        return null;
    }
    return data;
}

/** A record of a write batch: its encoded header and its bytes. */
type WriteRecord = { header: Uint8Array; bytes: Uint8Array };

/**
 * Splits the items into request batches of at most {@link ASSET_BATCH_CLIENT_RECORDS} records and
 * {@link ASSET_BATCH_CLIENT_BYTES} record bytes, a larger single record alone. Every header is
 * encoded first, so an item the framing cannot carry throws before anything is sent.
 */
function writeBatches(items: readonly AssetWriteItem[]): WriteRecord[][] {
    const batches: WriteRecord[][] = [];
    let batch: WriteRecord[] = [];
    let size = 0;
    for (const { key, bytes } of items) {
        const header = encodeAssetRecordHeader(key, bytes.byteLength);
        const recordSize = header.byteLength + bytes.byteLength;
        if (
            batch.length > 0 &&
            (batch.length >= ASSET_BATCH_CLIENT_RECORDS || size + recordSize > ASSET_BATCH_CLIENT_BYTES)
        ) {
            batches.push(batch);
            batch = [];
            size = 0;
        }
        batch.push({ header, bytes });
        size += recordSize;
    }
    if (batch.length > 0) {
        batches.push(batch);
    }
    return batches;
}

/** A write batch's request body: its records back to back. */
function joinRecords(batch: readonly WriteRecord[]): Uint8Array {
    let total = 0;
    for (const { header, bytes } of batch) {
        total += header.byteLength + bytes.byteLength;
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const { header, bytes } of batch) {
        body.set(header, at);
        at += header.byteLength;
        body.set(bytes, at);
        at += bytes.byteLength;
    }
    return body;
}

/**
 * Writes every item under its key with `POST /api/assets/write`, one batch at a time (see
 * {@link writeBatches}), each request retried as described above; the server always overwrites, and
 * a zero-length item is an empty file. Nothing is sent for an empty list. Throws `"setItem Error"`
 * for a non-2xx answer and the answer's `error` for a refused one, as `writeAsset` does; the
 * batches before the failing one, and possibly some of its records, stay written.
 */
export async function writeAssets(items: readonly AssetWriteItem[], options: AssetRequestOptions = {}): Promise<void> {
    const { signal } = options;
    for (const batch of writeBatches(items)) {
        const body = joinRecords(batch);
        const da = await requestWithRetry(
            ASSET_BATCH_WRITE_PATH,
            () => ({
                method: "POST",
                body: body as any,
                headers: {
                    "content-type": "application/octet-stream",
                },
            }),
            signal,
        );
        if (da.status < 200 || da.status >= 300) {
            throw "setItem Error";
        }
        let data: any;
        try {
            data = await da.json();
        } catch (error) {
            rethrow(error, signal);
        }
        if (data.error) {
            throw data.error;
        }
    }
}

/**
 * The records of a batch read answer, parsed as the body arrives (all at once when the answer has no
 * body stream). Throws `"getItem Error"` when the body breaks off or is malformed, or the signal's
 * reason when the signal fired.
 */
async function readRecords(res: Response, signal: AbortSignal | undefined): Promise<AssetRecord[]> {
    const parser = new AssetRecordParser();
    const records: AssetRecord[] = [];
    const reader = res.body?.getReader();
    try {
        if (reader) {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                records.push(...parser.push(value));
            }
        } else {
            records.push(...parser.push(new Uint8Array(await res.arrayBuffer())));
        }
        parser.end();
    } catch {
        void reader?.cancel().catch(() => {});
        throwIfAborted(signal);
        throw "getItem Error";
    }
    return records;
}

/**
 * Reads the bytes under every key with `POST /api/assets/read`, one batch of at most
 * {@link ASSET_BATCH_CLIENT_RECORDS} keys at a time, each request retried as described above: one
 * entry per key in the order asked (duplicates included), `null` when there are none (a missing or
 * empty file, or a key with no storage location). Nothing is sent for an empty list. Throws
 * `"getItem Error"` for a non-2xx answer or one that is not exactly the records asked for.
 */
export async function readAssets(
    keys: readonly string[],
    options: AssetRequestOptions = {},
): Promise<(Buffer | null)[]> {
    const { signal } = options;
    const results: (Buffer | null)[] = [];
    for (let start = 0; start < keys.length; start += ASSET_BATCH_CLIENT_RECORDS) {
        const batch = keys.slice(start, start + ASSET_BATCH_CLIENT_RECORDS);
        const da = await requestWithRetry(
            ASSET_BATCH_READ_PATH,
            () => ({
                method: "POST",
                body: JSON.stringify({ keys: batch }),
                headers: {
                    "content-type": "application/json",
                },
            }),
            signal,
        );
        if (da.status < 200 || da.status >= 300) {
            throw "getItem Error";
        }
        const records = await readRecords(da, signal);
        if (records.length !== batch.length || records.some((record, index) => record.name !== batch[index])) {
            throw "getItem Error";
        }
        for (const { bytes } of records) {
            results.push(bytes.byteLength === 0 ? null : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        }
    }
    return results;
}
