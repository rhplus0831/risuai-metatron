import { afterEach, describe, expect, it, vi } from "vitest";

// A mock returning a promise observes its rejection to track settledResults. Return a
// container instead, so the public loadAssets promise is observed only by production code.
const { read } = vi.hoisted(() => ({
    read: vi.fn<
        (
            keys: readonly string[],
            options?: { signal?: AbortSignal },
        ) => {
            promise: Promise<(Uint8Array | null)[]>;
        }
    >(),
}));
vi.mock("../../globalApi.svelte", () => ({
    loadAssets: (keys: readonly string[], options?: { signal?: AbortSignal }) => read(keys, options).promise,
    saveAsset: vi.fn(),
}));
import { loadAssetsInBatches } from "../assetQueue";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(() => vi.resetAllMocks());

describe("loadAssetsInBatches", () => {
    it.each([
        { label: "default 200", batchSize: undefined, size: 200 },
        { label: "explicit 2", batchSize: 2, size: 2 },
        { label: "clamped 500", batchSize: 999, size: 500 },
    ])("prefetches one batch while yielding ordered positions: $label", async ({ batchSize, size }) => {
        const keys = Array.from({ length: size * 2 + 1 }, (_, i) => `assets/${i}.png`);
        keys[1] = keys[0]; // Duplicates are positions, not a set of keys.
        const values = keys.map((_, i) => (i === 1 ? null : new Uint8Array([i % 256])));
        const requests: ReturnType<typeof deferred<(Uint8Array | null)[]>>[] = [];
        let active = 0;
        let peak = 0;
        read.mockImplementation(() => {
            const request = deferred<(Uint8Array | null)[]>();
            requests.push(request);
            peak = Math.max(peak, ++active);
            return { promise: request.promise.finally(() => active--) };
        });
        const iterator = loadAssetsInBatches(keys, { batchSize });
        const first = iterator.next();
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0][0]).toEqual(keys.slice(0, size));
        requests[0].resolve(values.slice(0, size));
        const output = [(await first).value];
        // No second next() yet: resolving k must already have started k+1.
        expect(read).toHaveBeenCalledTimes(2);
        expect(active).toBe(1);
        for (let i = 1; i < size; i++) output.push((await iterator.next()).value);
        expect(read).toHaveBeenCalledTimes(2);
        requests[1].resolve(values.slice(size, 2 * size));
        output.push((await iterator.next()).value);
        expect(read).toHaveBeenCalledTimes(3);
        requests[2].resolve(values.slice(2 * size));
        for await (const record of iterator) output.push(record);
        expect(peak).toBe(1);
        expect(active).toBe(0);
        expect(read.mock.calls.map(([batch]) => batch)).toEqual([
            keys.slice(0, size),
            keys.slice(size, 2 * size),
            keys.slice(2 * size),
        ]);
        expect(output).toEqual(keys.map((key, index) => ({ index, key, bytes: values[index] })));
    });

    it.each(["return", "break", "throw", "signal"] as const)(
        "%s cancels and settles the prefetch before completing, without reading another batch",
        async (exit) => {
            const pending = deferred<(Uint8Array | null)[]>();
            const abortSeen = vi.fn();
            let signal!: AbortSignal;
            read.mockReturnValueOnce({ promise: Promise.resolve([new Uint8Array([1])]) }).mockImplementationOnce(
                (_keys, options) => {
                    signal = options!.signal!;
                    signal.addEventListener("abort", abortSeen, { once: true });
                    return { promise: pending.promise };
                },
            );
            const controller = new AbortController();
            const iterator = loadAssetsInBatches(["a", "b", "c"], { batchSize: 1, signal: controller.signal });
            const failure = new Error("consumer stopped");
            let stopping: Promise<unknown>;
            if (exit === "return" || exit === "signal") {
                await iterator.next();
                if (exit === "signal") {
                    controller.abort(failure);
                    stopping = iterator.next();
                } else stopping = iterator.return();
            } else {
                stopping = (async () => {
                    for await (const _record of iterator) {
                        if (exit === "throw") throw failure;
                        break;
                    }
                })();
            }
            let settled = false;
            const outcome = stopping.then(
                (value) => {
                    settled = true;
                    return value;
                },
                (error) => {
                    settled = true;
                    return error;
                },
            );
            // Let the consumer enter finally, without settling the pending network operation.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const beforeSettlement = {
                aborted: signal.aborted,
                settled,
                calls: read.mock.calls.length,
            };
            pending.reject(failure);
            const result = await outcome;
            expect(beforeSettlement).toEqual({ aborted: true, settled: false, calls: 2 });
            expect(abortSeen).toHaveBeenCalledOnce();
            expect(read).toHaveBeenCalledTimes(2);
            if (exit === "throw" || exit === "signal") expect(result).toBe(failure);
        },
    );

    it("observes a rejected prefetch immediately and throws it at the next batch await", async () => {
        const pending = deferred<(Uint8Array | null)[]>();
        const failure = new Error("prefetched read failed");
        read.mockReturnValueOnce({ promise: Promise.resolve([new Uint8Array([1]), null]) }).mockReturnValueOnce({
            promise: pending.promise,
        });
        const iterator = loadAssetsInBatches(["a", "b", "c", "d", "e"], { batchSize: 2 });
        await iterator.next();
        expect(read).toHaveBeenCalledTimes(2);
        pending.reject(failure);
        // Cross an event-loop turn before asking for more; Vitest reports an unhandled rejection
        // here if the prefetch has no rejection handler while its consumer is busy writing.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await iterator.next()).toEqual({ done: false, value: { index: 1, key: "b", bytes: null } });
        await expect(iterator.next()).rejects.toBe(failure);
        expect(read).toHaveBeenCalledTimes(2);
    });
});
