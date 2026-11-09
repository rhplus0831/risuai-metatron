/**
 * Render I/O boundaries mark retryable failures for the chat row: in `parser.svelte.ts`, the asset and inlay
 * passes' `getFileSrcCached`, `getFileSrc`, `getInlayMedia` and `getInlayObjectUrl` reads; in `translator.ts`,
 * `translateMain`'s direct Google `fetch` and `readLLMCacheEntry`. ChatBody opts into rejecting failed asset
 * reads; default reads and missing/empty files still resolve `""`. Aborts are never marked;
 * unmarked errors are deterministic. An HTTP error carrying a numeric `status` is retryable only
 * for 408, 429 and 5xx; permanent asset refusals retain their original error and stay unmarked.
 */
const transientErrors = new WeakSet<object>();

export function markTransient(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return error;
    if (
        error instanceof Error &&
        "status" in error &&
        typeof error.status === "number" &&
        error.status !== 408 &&
        error.status !== 429 &&
        (error.status < 500 || error.status >= 600)
    )
        return error;
    const marked =
        (typeof error === "object" && error !== null) || typeof error === "function"
            ? error
            : new Error(String(error), { cause: error });
    transientErrors.add(marked);
    return marked;
}

export function isTransient(error: unknown): boolean {
    return ((typeof error === "object" && error !== null) || typeof error === "function") && transientErrors.has(error);
}

/** Marks a read's retryable rejection; permanent HTTP errors and cancellation stay unmarked. */
export async function readRenderIO<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let result: T;
    try {
        result = await read();
    } catch (error) {
        throw markTransient(error, signal);
    }
    signal?.throwIfAborted();
    return result;
}
