import { assetKey, loadAssets, saveAsset, saveAssetBatch } from "../globalApi.svelte";
import { ASSET_BATCH_CLIENT_BYTES, ASSET_BATCH_CLIENT_RECORDS } from "./assetClient";

/**
 * Yields one completed batch in key order while prefetching the next (200 keys by default).
 * Only these two batches are retained. The asset client owns retries. Closing the iterator, a
 * consumer failure, or an external abort cancels and settles the pending read before returning.
 */
export async function* loadAssetsInBatches(
    keys: readonly string[],
    options: { batchSize?: number; signal?: AbortSignal } = {},
): AsyncGenerator<{ index: number; key: string; bytes: Uint8Array | null }, void> {
    const requestedSize = Math.floor(options.batchSize ?? 200);
    const batchSize =
        Number.isFinite(requestedSize) && requestedSize >= 1
            ? Math.min(requestedSize, ASSET_BATCH_CLIENT_RECORDS)
            : 200;
    const controller = new AbortController();
    const { signal } = controller;
    const onAbort = () => controller.abort(abortReason(options.signal!));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    let pending: Promise<(Uint8Array | null)[]> | undefined;
    const start = (index: number) => {
        signal.throwIfAborted();
        const read = loadAssets(keys.slice(index, index + batchSize), { signal });
        // A prefetched failure can arrive while the consumer is compressing or writing an asset.
        // Handle it immediately; awaiting the original promise still propagates that failure.
        void read.catch(() => {});
        return read;
    };
    try {
        signal.throwIfAborted();
        if (keys.length === 0) return;
        pending = start(0);
        for (let startIndex = 0; startIndex < keys.length; startIndex += batchSize) {
            const batch = await pending;
            signal.throwIfAborted();
            const nextIndex = startIndex + batchSize;
            pending = nextIndex < keys.length ? start(nextIndex) : undefined;
            for (let offset = 0; offset < batch.length; offset++) {
                signal.throwIfAborted();
                const index = startIndex + offset;
                yield { index, key: keys[index], bytes: batch[offset] };
            }
        }
    } finally {
        controller.abort();
        await pending?.catch(() => {});
        options.signal?.removeEventListener("abort", onAbort);
    }
}

/**
 * The bounded asset save queues. {@link saveAssets} serves the
 * bulk import paths (the CharX-embedded `.risum`, PNG card chunks, embedded base64 assets, picked
 * files, ONNX zips): an item's bytes are not produced (`load()`) until it has a slot, and the loaded
 * items are written in batches through the batch write route, one request at a time.
 * {@link AssetSaveQueue} writes one item per `saveAsset` (the in-tab CharX importer). The asset
 * client already retries a 429/503 or a network failure; the queues themselves never retry.
 */

/** Items saved at once when the caller does not say. */
export const DEFAULT_ASSET_CONCURRENCY = 10;

/** One asset to save: `saveAsset(await load(), customId, fileName)`. */
export type AssetSaveItem = {
    /** Produces the bytes. Called once, only when the item has a slot; a throw fails the item. */
    load: () => Promise<Uint8Array> | Uint8Array;
    /** Gives the stored key its extension (`saveAsset`'s `fileName`; default `png`). */
    fileName?: string;
    /** Stores under this id instead of the bytes' hash (`saveAsset`'s `customId`). */
    customId?: string;
};

export type SaveAssetsOptions = {
    /** Items loading at once (default {@link DEFAULT_ASSET_CONCURRENCY}). */
    concurrency?: number;
    /** Called after each item settles (saved or failed) with the settled count and the item count. */
    onProgress?: (done: number, total: number) => void;
    /** Stops admitting items and aborts the writes in flight; the call then throws the signal's reason. */
    signal?: AbortSignal;
};

/** `saveAssets`' rejection when items failed: `failed` of them, `errors` theirs, `cause` the first. */
export class AssetSaveError extends Error {
    readonly failed: number;
    readonly errors: unknown[];

    constructor(errors: unknown[]) {
        const first = errors[0];
        const detail = first instanceof Error ? first.message : String(first);
        super(`Failed to save ${errors.length} asset${errors.length === 1 ? "" : "s"}: ${detail}`, { cause: first });
        this.name = "AssetSaveError";
        this.failed = errors.length;
        this.errors = errors;
    }
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

type Entry = {
    item: AssetSaveItem;
    resolve: (key: string) => void;
    reject: (error: unknown) => void;
};

/**
 * The queue under {@link saveAssets}, for a caller whose items arrive over time (the CharX importer's
 * zip entries): `add` resolves to the item's key or rejects with its error, and `whenReady` lets the
 * producer wait before producing more, so items do not pile up waiting for a slot. With a `signal`,
 * an abort rejects the waiting items with its reason and aborts the writes in flight.
 */
export class AssetSaveQueue {
    readonly concurrency: number;
    readonly #signal: AbortSignal | undefined;
    #waiting: Entry[] = [];
    #active = 0;
    #readyWaiters: (() => void)[] = [];

    constructor(options: { concurrency?: number; signal?: AbortSignal } = {}) {
        const concurrency = Math.floor(options.concurrency ?? DEFAULT_ASSET_CONCURRENCY);
        this.concurrency = Number.isFinite(concurrency) && concurrency >= 1 ? concurrency : DEFAULT_ASSET_CONCURRENCY;
        this.#signal = options.signal;
        this.#signal?.addEventListener("abort", () => this.#abort(), { once: true });
    }

    /** Items added that have no slot yet (their `load()` not called). */
    get waiting(): number {
        return this.#waiting.length;
    }

    /** Items loading or being written. */
    get active(): number {
        return this.#active;
    }

    /** Queues `item`; it starts as soon as a slot is free. */
    add(item: AssetSaveItem): Promise<string> {
        if (this.#signal?.aborted) {
            return Promise.reject(abortReason(this.#signal));
        }
        const promise = new Promise<string>((resolve, reject) => {
            this.#waiting.push({ item, resolve, reject });
        });
        this.#pump();
        return promise;
    }

    /** Resolves once no item is waiting and a slot is free (at once when that is already so, or after an abort). */
    whenReady(): Promise<void> {
        if (this.#isReady()) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.#readyWaiters.push(resolve);
        });
    }

    #isReady() {
        return this.#signal?.aborted || (this.#waiting.length === 0 && this.#active < this.concurrency);
    }

    #pump() {
        while (this.#active < this.concurrency && this.#waiting.length > 0) {
            const entry = this.#waiting.shift()!;
            this.#active += 1;
            void this.#run(entry);
        }
        if (this.#readyWaiters.length > 0 && this.#isReady()) {
            const waiters = this.#readyWaiters;
            this.#readyWaiters = [];
            for (const resolve of waiters) {
                resolve();
            }
        }
    }

    async #run(entry: Entry) {
        const signal = this.#signal;
        try {
            if (signal?.aborted) {
                throw abortReason(signal);
            }
            const data = await entry.item.load();
            if (signal?.aborted) {
                throw abortReason(signal);
            }
            const key = await saveAsset(
                data,
                entry.item.customId ?? "",
                entry.item.fileName ?? "",
                signal ? { signal } : undefined,
            );
            entry.resolve(key);
        } catch (error) {
            entry.reject(signal?.aborted ? abortReason(signal) : error);
        } finally {
            this.#active -= 1;
            this.#pump();
        }
    }

    #abort() {
        const reason = abortReason(this.#signal!);
        const waiting = this.#waiting;
        this.#waiting = [];
        for (const entry of waiting) {
            entry.reject(reason);
        }
        this.#pump();
    }
}

function isAsyncIterable<T>(value: Iterable<T> | AsyncIterable<T>): value is AsyncIterable<T> {
    return typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

const keyEncoder = new TextEncoder();

/** A loaded item waiting for its batch: `bytes` null for a repeat of a hash key already batched. */
type LoadedAsset = { index: number; key: string; bytes: Uint8Array | null; size: number };

/**
 * Saves `items` and resolves to their keys in item order (the key `saveAsset` would give each). An
 * item is taken from `items` (and its `load()` called) only when fewer than `concurrency` items are
 * loading and the loaded items waiting to be written are under one write request's worth
 * ({@link ASSET_BATCH_CLIENT_RECORDS} records or {@link ASSET_BATCH_CLIENT_BYTES} record bytes); an
 * async iterable is pulled the same way, so a producer that decodes as it yields is held back too.
 * The loaded items are written one request at a time, each request a batch of them that fits those
 * caps (a larger single item alone), while the next batch loads. An item whose hash key (no
 * `customId`) another item of this call already carries is not sent again.
 *
 * `onProgress(done, total)` runs for each item once it settles: when its batch is written or fails,
 * or when its `load()` throws; `total` is the item count, or for an async iterable the items taken
 * so far. A throw from it halts the call as a failure does and the call rejects with that error.
 *
 * When an item's `load()` throws or a batch fails (after the asset client's own retries), no further
 * item is started and nothing more is written; the call waits for the loads and the write in flight
 * to settle and rejects with an {@link AssetSaveError} naming how many items failed (every item of a
 * failed batch) and carrying the first error as `cause`. Batches written before stay written. An
 * async iterable that throws rejects the call with its error, also after the work in flight settles;
 * one left unfinished is closed (`return()`). When `signal` fires, the write in flight is aborted
 * and the call rejects with the signal's reason once the work in flight has stopped.
 */
export async function saveAssets(
    items: Iterable<AssetSaveItem> | AsyncIterable<AssetSaveItem>,
    options: SaveAssetsOptions = {},
): Promise<string[]> {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
        throw abortReason(signal);
    }
    const requested = Math.floor(options.concurrency ?? DEFAULT_ASSET_CONCURRENCY);
    const concurrency = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_ASSET_CONCURRENCY;
    const list = isAsyncIterable(items) ? null : Array.isArray(items) ? items : Array.from(items);
    const keys: string[] = [];
    const errors: unknown[] = [];
    // Hash keys already in a batch of this call (written, being written, or waiting).
    const batchedKeys = new Set<string>();
    let open: LoadedAsset[] = [];
    let openRecords = 0;
    let openBytes = 0;
    let writing: Promise<void> | null = null;
    let loading = 0;
    let taken = 0;
    let done = 0;
    let sourceDone = false;
    let sourceError: { error: unknown } | null = null;

    let wake: (() => void) | null = null;
    const notify = () => {
        const resolve = wake;
        wake = null;
        resolve?.();
    };
    const changed = () =>
        new Promise<void>((resolve) => {
            wake = resolve;
        });

    // A throwing `onProgress` stops the call like a failure and becomes its rejection, but never
    // interrupts the settlement of the other items of a batch.
    let progressError: { error: unknown } | null = null;
    const total = () => (list ? list.length : taken);
    const settle = () => {
        done += 1;
        try {
            onProgress?.(done, total());
        } catch (error) {
            progressError ??= { error };
        }
    };
    const halted = () => errors.length > 0 || signal?.aborted || sourceError !== null || progressError !== null;
    const full = () => openRecords >= ASSET_BATCH_CLIENT_RECORDS || openBytes >= ASSET_BATCH_CLIENT_BYTES;

    // Starts the next write when none is in flight: once the waiting items fill a request, or for the
    // rest once every item is loaded.
    const flush = () => {
        if (writing || halted() || open.length === 0) {
            return;
        }
        if (!full() && !(sourceDone && loading === 0)) {
            return;
        }
        let count = 0;
        let records = 0;
        let bytes = 0;
        for (; count < open.length; count++) {
            const entry = open[count];
            if (entry.bytes) {
                if (
                    records > 0 &&
                    (records >= ASSET_BATCH_CLIENT_RECORDS || bytes + entry.size > ASSET_BATCH_CLIENT_BYTES)
                ) {
                    break;
                }
                records += 1;
                bytes += entry.size;
            }
        }
        const batch = open.slice(0, count);
        open = open.slice(count);
        openRecords -= records;
        openBytes -= bytes;
        const writes = batch.flatMap((entry) => (entry.bytes ? [{ key: entry.key, bytes: entry.bytes }] : []));
        writing = (writes.length > 0 ? saveAssetBatch(writes, signal ? { signal } : undefined) : Promise.resolve())
            .then(
                () => {
                    for (const entry of batch) {
                        keys[entry.index] = entry.key;
                        settle();
                    }
                },
                (error) => {
                    for (const _ of batch) {
                        errors.push(error);
                        settle();
                    }
                },
            )
            .finally(() => {
                writing = null;
                flush();
                notify();
            });
    };

    const startLoad = (item: AssetSaveItem) => {
        const index = taken++;
        loading += 1;
        void (async () => {
            try {
                const data = await item.load();
                if (halted()) {
                    return;
                }
                const key = await assetKey(data, item.customId ?? "", item.fileName ?? "");
                if (halted()) {
                    return;
                }
                if (!item.customId && batchedKeys.has(key)) {
                    open.push({ index, key, bytes: null, size: 0 });
                } else {
                    if (!item.customId) {
                        batchedKeys.add(key);
                    }
                    // The record's framing: u32 name length, the UTF-8 name, u32 data length.
                    const size = 8 + keyEncoder.encode(key).byteLength + data.byteLength;
                    open.push({ index, key, bytes: data, size });
                    openRecords += 1;
                    openBytes += size;
                }
            } catch (error) {
                errors.push(error);
                settle();
            } finally {
                loading -= 1;
                flush();
                notify();
            }
        })();
    };

    const iterator = list ? null : (items as AsyncIterable<AssetSaveItem>)[Symbol.asyncIterator]();
    let finished = false;
    while (!halted()) {
        if (loading >= concurrency || full()) {
            await changed();
            continue;
        }
        let item: AssetSaveItem;
        if (list) {
            if (taken >= list.length) {
                finished = true;
                break;
            }
            item = list[taken];
        } else {
            try {
                const next = await iterator!.next();
                if (next.done) {
                    finished = true;
                    break;
                }
                item = next.value;
            } catch (error) {
                finished = true;
                sourceError = { error };
                break;
            }
            if (halted()) {
                break;
            }
        }
        startLoad(item);
    }
    sourceDone = true;
    if (iterator && !finished) {
        try {
            await iterator.return?.();
        } catch {}
    }
    flush();
    while (loading > 0 || writing !== null || (!halted() && open.length > 0)) {
        await changed();
    }

    if (signal?.aborted) {
        throw abortReason(signal);
    }
    if (sourceError) {
        throw sourceError.error;
    }
    if (progressError) {
        throw progressError.error;
    }
    if (errors.length > 0) {
        throw new AssetSaveError(errors);
    }
    return keys;
}

/**
 * Saves picked files (`selectMultipleFileHandles`) through {@link saveAssets}: each file is read only
 * when its slot is free, the files are written in batches, and the keys come back in file order.
 * `fileName(file)` gives a key its extension (`saveAsset`'s `fileName`; default `png`).
 */
export function savePickedFiles(
    files: readonly File[],
    fileName?: (file: File) => string,
    options: SaveAssetsOptions = {},
): Promise<string[]> {
    return saveAssets(
        files.map((file) => ({
            load: async () => new Uint8Array(await file.arrayBuffer()),
            fileName: fileName?.(file),
        })),
        options,
    );
}
