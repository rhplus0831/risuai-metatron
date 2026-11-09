/**
 * Render I/O boundaries mark retryable failures for the chat row: in `parser.svelte.ts`, the asset and inlay
 * passes' `getFileSrcCached`, `getFileSrc`, `getInlayMedia` and `getInlayObjectUrl` reads; in `translator.ts`,
 * `translateMain`'s direct Google `fetch` and `readLLMCacheEntry`. ChatBody opts into rejecting failed asset
 * reads; default reads and missing/empty files still resolve `""`. Aborts are never marked;
 * unmarked errors are deterministic.
 */
const transientErrors = new WeakSet<object>();

export function markTransient(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return error;
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

/** Only the read's rejection is transient; cancellation at either checkpoint stays unmarked. */
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
