/**
 * Bounds a resource read made outside the save adapter (`resourceSync.svelte.ts` bounds its own reads
 * with `deadlineRead`): `read` gets a signal that aborts at `ms`, and the returned promise rejects
 * then with an `Error` carrying `message` even when the read ignores the signal. A read that answers
 * in time leaves no timer. The bound suits the caller's payload: a chat or boot read can be large
 * on a slow link, so each caller picks its own.
 */
export async function readWithDeadline<T>(
    ms: number,
    message: string,
    read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(message);
            controller.abort(error);
            reject(error);
        }, ms);
    });
    try {
        return await Promise.race([read(controller.signal), expired]);
    } finally {
        clearTimeout(timer);
    }
}
