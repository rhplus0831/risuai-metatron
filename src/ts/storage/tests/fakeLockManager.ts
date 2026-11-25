/**
 * A Web Locks manager for tests, with the semantics `draftJournal.ts` relies on:
 * - a lock is held from the callback's invocation until the promise it returns settles; `request`
 *   resolves with the callback's value (or rejects with its error) once the lock is released;
 * - the callback runs in a later task, never synchronously inside `request` (the real API does the
 *   same, and `claimOwner` reads `request`'s own result inside its callback);
 * - `ifAvailable`: a held name invokes the callback with `null` at once instead of waiting;
 * - `signal` aborts only a waiting request (rejecting with an `AbortError`); after the grant it
 *   changes nothing; `ifAvailable` together with `signal` is refused as the browser refuses it;
 * - requests for one name are granted in order; every lock is exclusive here (the journal takes no
 *   shared lock).
 */

type Callback = (lock: Lock | null) => unknown;
type Waiter = { callback: Callback; resolve: (value: unknown) => void; reject: (error: unknown) => void };

export type FakeLockManager = LockManager & {
    /** The names held right now. */
    held(): string[];
    /** The names with a request waiting right now. */
    waiting(): string[];
    /** Every `request` made, in order, with its options. */
    readonly requests: { name: string; options: LockOptions }[];
    /** Resolves when `name` is next granted, before its callback runs (a hook for interleavings). */
    whenHeld(name: string): Promise<void>;
};

export function createFakeLockManager(): FakeLockManager {
    const holders = new Map<string, true>();
    const queues = new Map<string, Waiter[]>();
    const requests: { name: string; options: LockOptions }[] = [];
    const heldWatchers = new Map<string, (() => void)[]>();

    function grant(name: string, waiter: Waiter): void {
        holders.set(name, true);
        for (const notify of heldWatchers.get(name) ?? []) {
            notify();
        }
        heldWatchers.delete(name);
        void (async () => {
            await null;
            let result: unknown;
            try {
                result = await waiter.callback({ name, mode: "exclusive" });
            } catch (error) {
                release(name);
                waiter.reject(error);
                return;
            }
            release(name);
            waiter.resolve(result);
        })();
    }

    function release(name: string): void {
        holders.delete(name);
        const queue = queues.get(name);
        const next = queue?.shift();
        if (!queue?.length) {
            queues.delete(name);
        }
        if (next) {
            grant(name, next);
        }
    }

    function request(name: string, options: LockOptions | Callback, callback?: Callback): Promise<unknown> {
        const opts: LockOptions = typeof options === "function" ? {} : options;
        const run: Callback = typeof options === "function" ? options : callback!;
        requests.push({ name, options: opts });
        if (opts.ifAvailable && opts.signal) {
            return Promise.reject(
                new DOMException("The 'signal' and 'ifAvailable' options cannot be used together", "NotSupportedError"),
            );
        }
        if (opts.signal?.aborted) {
            return Promise.reject(new DOMException("The request was aborted", "AbortError"));
        }
        return new Promise((resolve, reject) => {
            const waiter: Waiter = { callback: run, resolve, reject };
            if (!holders.has(name) && !queues.get(name)?.length) {
                grant(name, waiter);
                return;
            }
            if (opts.ifAvailable) {
                // Refused: the callback is told at once, in a later task like a grant.
                void (async () => {
                    await null;
                    try {
                        resolve(await run(null));
                    } catch (error) {
                        reject(error);
                    }
                })();
                return;
            }
            const queue = queues.get(name) ?? [];
            queue.push(waiter);
            queues.set(name, queue);
            opts.signal?.addEventListener(
                "abort",
                () => {
                    const index = queue.indexOf(waiter);
                    if (index === -1) {
                        return;
                    }
                    queue.splice(index, 1);
                    if (queue.length === 0) {
                        queues.delete(name);
                    }
                    reject(new DOMException("The request was aborted", "AbortError"));
                },
                { once: true },
            );
        });
    }

    return {
        request: request as LockManager["request"],
        query: async () => ({
            held: [...holders.keys()].map((name) => ({ name, mode: "exclusive" as const, clientId: "" })),
            pending: [...queues.entries()].flatMap(([name, queue]) =>
                queue.map(() => ({ name, mode: "exclusive" as const, clientId: "" })),
            ),
        }),
        held: () => [...holders.keys()],
        waiting: () => [...queues.entries()].filter(([, queue]) => queue.length > 0).map(([name]) => name),
        requests,
        whenHeld: (name) =>
            new Promise<void>((resolve) => {
                heldWatchers.set(name, [...(heldWatchers.get(name) ?? []), resolve]);
            }),
    };
}
