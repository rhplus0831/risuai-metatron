import { language } from "src/lang";
import type { flushResources } from "./resourceSync.svelte";

/** A flush can span several batches and a 20 s save dependency. */
const SEND_FLUSH_DEADLINE_MS = 30_000;

export class ResourceFlushTimeoutError extends Error {}

/** Only this caller stops waiting. The shared write still needs its acknowledgement. */
export async function waitForResourceFlush(save: ReturnType<typeof flushResources>, signal?: AbortSignal) {
    let rejectWait: (error: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => {
        rejectWait = reject;
    });
    const stop = () => rejectWait(signal?.reason);
    const timer = setTimeout(
        () => rejectWait(new ResourceFlushTimeoutError(language.resourceSaveTimedOut)),
        SEND_FLUSH_DEADLINE_MS,
    );
    try {
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
        return await Promise.race([interrupted, save]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
    }
}
