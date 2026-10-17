import { saveAsset } from "../globalApi.svelte";

/**
 * The bounded asset save queue (large-asset-import slice 1a) for the bulk import paths (`.risum`,
 * CharX, PNG card chunks, embedded base64 assets, ONNX zips): at most `concurrency` items at once, and
 * an item's bytes are not produced (`load()`) until it has a slot, so a caller that decodes or reads
 * inside `load()` never holds more than `concurrency` decoded assets. Each item is written with
 * `saveAsset`, whose asset client already retries a 429/503 or a network failure; the queue itself
 * never retries.
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
    /** Items in flight at once (default {@link DEFAULT_ASSET_CONCURRENCY}). */
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

/**
 * Saves `items` at most `concurrency` at a time and resolves to their keys in item order. An item is
 * taken from `items` (and its `load()` called) only when a slot is free; an async iterable is pulled
 * the same way, so a producer that decodes as it yields is held back too.
 *
 * `onProgress(done, total)` runs after each item settles; `total` is the item count, or for an async
 * iterable the items taken so far.
 *
 * When an item fails (after the asset client's own retries), no further item is started; the call
 * waits for the items in flight to settle and rejects with an {@link AssetSaveError} naming how many
 * failed and carrying the first error as `cause`. An async iterable that throws rejects the call
 * with its error, also after the items in flight settle; one left unfinished is closed (`return()`).
 * When `signal` fires, the call rejects with its reason once the writes in flight have stopped.
 */
export async function saveAssets(
    items: Iterable<AssetSaveItem> | AsyncIterable<AssetSaveItem>,
    options: SaveAssetsOptions = {},
): Promise<string[]> {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
        throw abortReason(signal);
    }
    const queue = new AssetSaveQueue({ concurrency: options.concurrency, signal });
    const list = isAsyncIterable(items) ? null : Array.isArray(items) ? items : Array.from(items);
    const keys: string[] = [];
    const errors: unknown[] = [];
    const settles: Promise<void>[] = [];
    let taken = 0;
    let done = 0;

    const stopped = () => errors.length > 0 || signal?.aborted;
    const start = (item: AssetSaveItem) => {
        const index = taken++;
        settles.push(
            queue.add(item).then(
                (key) => {
                    keys[index] = key;
                    done += 1;
                    onProgress?.(done, list ? list.length : taken);
                },
                (error) => {
                    errors.push(error);
                    done += 1;
                    onProgress?.(done, list ? list.length : taken);
                },
            ),
        );
    };

    let sourceError: { error: unknown } | null = null;
    if (list) {
        for (const item of list) {
            await queue.whenReady();
            if (stopped()) {
                break;
            }
            start(item);
        }
    } else {
        const iterator = (items as AsyncIterable<AssetSaveItem>)[Symbol.asyncIterator]();
        let finished = false;
        try {
            while (true) {
                await queue.whenReady();
                if (stopped()) {
                    break;
                }
                const next = await iterator.next();
                if (next.done) {
                    finished = true;
                    break;
                }
                start(next.value);
            }
        } catch (error) {
            finished = true;
            sourceError = { error };
        }
        if (!finished) {
            try {
                await iterator.return?.();
            } catch {}
        }
    }

    await Promise.all(settles);
    if (signal?.aborted) {
        throw abortReason(signal);
    }
    if (sourceError) {
        throw sourceError.error;
    }
    if (errors.length > 0) {
        throw new AssetSaveError(errors);
    }
    return keys;
}
