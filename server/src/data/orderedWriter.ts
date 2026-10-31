const DEFAULT_CONCURRENCY = 4;

export type OrderedWriter = {
    /**
     * Queues `operation` on `key` and answers with its outcome. It never starts inside this call, so
     * the caller can note what it queued first. A failure rejects this promise only: the key's next
     * operation runs as usual.
     */
    run<T>(key: string, operation: () => Promise<T> | T): Promise<T>;
    /** Resolves once everything queued on `key` before this call has ended. Never rejects. */
    settled(key: string): Promise<void>;
};

/**
 * A scheduler for small auxiliary writes: operations (closures) run first in, first out per key, one
 * at a time per key, and at most `concurrency` at once across keys. A key goes to the back of the
 * ready line after each operation, so busy keys cannot starve another one. It knows nothing about
 * files: each consumer keeps its own file code, and an operation may hold a whole read, derive, write,
 * install transition.
 */
export function createOrderedWriter(options: { concurrency?: number } = {}): OrderedWriter {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    /** Each key with an operation queued or running. */
    const queues = new Map<string, (() => Promise<void>)[]>();
    /** The keys with an operation queued and none running, in the order they start. */
    const ready: string[] = [];
    let running = 0;

    function pump() {
        while (running < concurrency && ready.length > 0) {
            const key = ready.shift()!;
            const queue = queues.get(key)!;
            running++;
            void queue.shift()!().then(() => {
                running--;
                if (queue.length > 0) {
                    ready.push(key);
                } else {
                    queues.delete(key);
                }
                pump();
            });
        }
    }

    function run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const task = async () => {
                try {
                    resolve(await operation());
                } catch (error) {
                    reject(error);
                }
            };
            const queue = queues.get(key);
            if (queue) {
                queue.push(task);
                return;
            }
            queues.set(key, [task]);
            ready.push(key);
            queueMicrotask(pump);
        });
    }

    return { run, settled: (key) => run(key, () => {}) };
}
