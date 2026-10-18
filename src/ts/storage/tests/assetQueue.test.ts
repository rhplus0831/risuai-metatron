import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../globalApi.svelte", () => ({ saveAsset: vi.fn(), assetKey: vi.fn(), saveAssetBatch: vi.fn() }));

import { assetKey, saveAsset, saveAssetBatch } from "../../globalApi.svelte";
import { AssetSaveError, AssetSaveQueue, saveAssets, type AssetSaveItem } from "../assetQueue";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// A zero-time turn drains promise continuations without letting an upload complete or sleeping.
const drain = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetAllMocks();
});

describe("saveAssets", () => {
    it.each(["array", "iterable", "async iterable"])(
        "bounds load admission and writes the loaded items as one batch with ordered keys from an %s",
        async (kind) => {
            vi.useFakeTimers();
            const loads = Array.from({ length: 4 }, () => deferred<Uint8Array>());
            const items = loads.map((load, i) => ({
                load: vi.fn(() => load.promise),
                customId: `id-${i}`,
                fileName: `file-${i}.webp`,
            }));
            vi.mocked(assetKey).mockImplementation(async (_data, customId) => `key-${customId}`);
            const batch = deferred<void>();
            vi.mocked(saveAssetBatch).mockReturnValue(batch.promise);
            const source =
                kind === "array"
                    ? items
                    : kind === "iterable"
                      ? new Set(items)
                      : (async function* () {
                            yield* items;
                        })();
            const progress = vi.fn();
            const result = saveAssets(source, { concurrency: 2, onProgress: progress });
            await drain();
            expect(items.map((item) => item.load.mock.calls.length)).toEqual([1, 1, 0, 0]);

            loads[1].resolve(new Uint8Array([1]));
            await drain();
            expect(items.map((item) => item.load.mock.calls.length)).toEqual([1, 1, 1, 0]);
            expect(assetKey).toHaveBeenCalledWith(new Uint8Array([1]), "id-1", "file-1.webp");
            loads[2].resolve(new Uint8Array([2]));
            await drain();
            expect(items.map((item) => item.load.mock.calls.length)).toEqual([1, 1, 1, 1]);
            loads[3].resolve(new Uint8Array([3]));
            await drain();
            expect(saveAssetBatch).not.toHaveBeenCalled();
            loads[0].resolve(new Uint8Array([0]));
            await drain();
            expect(saveAssetBatch).toHaveBeenCalledTimes(1);
            expect(vi.mocked(saveAssetBatch).mock.calls[0][0]).toEqual(
                [1, 2, 3, 0].map((i) => ({
                    key: `key-id-${i}`,
                    bytes: new Uint8Array([i]),
                })),
            );
            expect(progress).not.toHaveBeenCalled();

            batch.resolve();
            await expect(result).resolves.toEqual(["key-id-0", "key-id-1", "key-id-2", "key-id-3"]);
            expect(progress.mock.calls).toEqual([
                [1, 4],
                [2, 4],
                [3, 4],
                [4, 4],
            ]);
        },
    );

    it("stops admission on the first failed load, waits for active loads, writes nothing, and reports the failure count and first cause", async () => {
        vi.useFakeTimers();
        const pending = Array.from({ length: 3 }, () => deferred<Uint8Array>());
        const loads = Array.from({ length: 5 }, (_, i) =>
            vi.fn(() => (i < 3 ? pending[i].promise : new Uint8Array([i]))),
        );
        vi.mocked(assetKey).mockImplementation(async (data) => `key-${data[0]}`);
        vi.mocked(saveAssetBatch).mockResolvedValue(undefined);
        const progress = vi.fn();
        const settled = vi.fn();
        const outcome = saveAssets(
            loads.map((load) => ({ load })),
            { concurrency: 3, onProgress: progress },
        ).then(
            (value) => ({ value }),
            (error) => ({ error }),
        );
        void outcome.then(settled);
        await drain();
        const first = new Error("unreadable");
        pending[1].reject(first);
        await drain();
        expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1, 1, 0, 0]);
        expect(progress.mock.calls).toEqual([[1, 5]]);
        expect(settled).not.toHaveBeenCalled();
        pending[0].resolve(new Uint8Array([0]));
        await drain();
        expect(settled).not.toHaveBeenCalled();
        const second = new Error("gone");
        pending[2].reject(second);
        const result = await outcome;
        expect(result).toHaveProperty("error");
        const error = (result as { error: AssetSaveError }).error;
        expect(error).toBeInstanceOf(AssetSaveError);
        expect(error.failed).toBe(2);
        expect(error.message).toMatch(/2 assets/);
        expect(error.cause).toBe(first);
        expect(error.errors).toEqual([first, second]);
        expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1, 1, 0, 0]);
        expect(saveAssetBatch).not.toHaveBeenCalled();
        expect(progress.mock.calls).toEqual([
            [1, 5],
            [2, 5],
        ]);
    });

    it("splits writes at the record cap, one request at a time, and sends a repeated hash key once", async () => {
        vi.mocked(assetKey).mockImplementation(async (data, customId) =>
            customId ? `assets/${customId}.png` : `assets/hash-${data[0]}.png`,
        );
        let inFlight = 0;
        let maxInFlight = 0;
        vi.mocked(saveAssetBatch).mockImplementation(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
        });
        // 501 distinct records, then a repeat of record 0's bytes and two items under one customId.
        const items: AssetSaveItem[] = Array.from({ length: 501 }, (_, i) => ({
            load: () => new Uint8Array([i % 256, Math.floor(i / 256)]),
            customId: i < 256 ? "" : `id-${i}`,
        }));
        items.push({ load: () => new Uint8Array([0, 0]) });
        items.push(
            { load: () => new Uint8Array([7]), customId: "same" },
            { load: () => new Uint8Array([8]), customId: "same" },
        );
        const keys = await saveAssets(items);

        const batches = vi.mocked(saveAssetBatch).mock.calls.map(([batch]) => batch);
        expect(batches.map((batch) => batch.length)).toEqual([500, 3]);
        expect(maxInFlight).toBe(1);
        expect(keys[501]).toBe(keys[0]);
        expect(batches.flat().filter((item) => item.key === keys[0])).toHaveLength(1);
        expect(
            batches
                .flat()
                .filter((item) => item.key === "assets/same.png")
                .map((item) => item.bytes),
        ).toEqual([new Uint8Array([7]), new Uint8Array([8])]);
        expect(keys).toHaveLength(504);
    });

    it("rejects with a throwing onProgress's error after settling the batch", async () => {
        vi.mocked(assetKey).mockImplementation(async (data) => `key-${data[0]}`);
        vi.mocked(saveAssetBatch).mockResolvedValue(undefined);
        const thrown = new Error("progress failed");
        const progress = vi.fn(() => {
            throw thrown;
        });
        await expect(
            saveAssets(
                [0, 1, 2].map((i) => ({ load: () => new Uint8Array([i]) })),
                { onProgress: progress },
            ),
        ).rejects.toBe(thrown);
        expect(progress).toHaveBeenCalledTimes(3);
    });

    it("fails every item of a failed batch with its error", async () => {
        vi.mocked(assetKey).mockImplementation(async (data) => `key-${data[0]}`);
        const failure = "setItem Error";
        vi.mocked(saveAssetBatch).mockRejectedValue(failure);
        const progress = vi.fn();
        const error = await saveAssets(
            [0, 1, 2].map((i) => ({ load: () => new Uint8Array([i]) })),
            { onProgress: progress },
        ).catch((reason) => reason);
        expect(error).toBeInstanceOf(AssetSaveError);
        expect(error.failed).toBe(3);
        expect(error.cause).toBe(failure);
        expect(saveAssetBatch).toHaveBeenCalledTimes(1);
        expect(progress.mock.calls).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ]);
    });
});

describe("AssetSaveQueue", () => {
    it("admits ten items by default and wakes a waiting producer only when a slot is free", async () => {
        vi.useFakeTimers();
        const uploads = Array.from({ length: 11 }, () => deferred<string>());
        const items: AssetSaveItem[] = uploads.map((_, i) => ({ load: vi.fn(() => new Uint8Array([i])) }));
        vi.mocked(saveAsset).mockImplementation((data) => uploads[data[0]].promise);
        const queue = new AssetSaveQueue();
        const results = items.map((item) => queue.add(item));
        const ready = vi.fn();
        void queue.whenReady().then(ready);
        await drain();
        expect(queue.active).toBe(10);
        expect(queue.waiting).toBe(1);
        expect(items[10].load).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        uploads[0].resolve("key-0");
        await drain();
        expect(items[10].load).toHaveBeenCalledTimes(1);
        expect(queue.active).toBe(10);
        expect(queue.waiting).toBe(0);
        expect(ready).not.toHaveBeenCalled();
        uploads[1].resolve("key-1");
        await drain();
        expect(ready).toHaveBeenCalledTimes(1);
        expect(queue.active).toBe(9);
        uploads.forEach((upload, i) => upload.resolve(`key-${i}`));
        await expect(Promise.all(results)).resolves.toEqual(uploads.map((_, i) => `key-${i}`));
        expect(queue.active).toBe(0);
        expect(queue.waiting).toBe(0);
    });
});
