import { vi } from "vitest";

/**
 * Fires the fake clock's timers one at a time until `done` holds, for a test that acts between a
 * flush's retries (`flushResources` waits out a backoff after a retryable failure). Each step first
 * drains a real task turn, so the work a timer started settles before `done` is checked, and a
 * condition that already holds fires no timer. Fake timers must be installed; gives up after
 * `maxTimers` timers, leaving the caller's assertion to fail.
 */
export async function advanceUntil(done: () => boolean, maxTimers = 500): Promise<void> {
    for (let fired = 0; fired < maxTimers; fired += 1) {
        await vi.advanceTimersByTimeAsync(0);
        if (done()) {
            return;
        }
        await vi.advanceTimersToNextTimerAsync();
    }
}

/**
 * Settles a promise that waits on `flushResources` while the flush retries: fires timers (its
 * backoff waits among them) until the promise settles, then returns it, so the caller awaits its
 * value or asserts its rejection. The flush's ten attempts need at most a few dozen timers.
 */
export async function settleFlush<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    promise.then(
        () => (settled = true),
        () => (settled = true),
    );
    await advanceUntil(() => settled);
    return promise;
}
