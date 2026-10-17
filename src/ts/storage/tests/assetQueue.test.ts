import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../globalApi.svelte", () => ({ saveAsset: vi.fn() }));

import { saveAsset } from "../../globalApi.svelte";
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
        "bounds load admission and returns ordered keys from an %s",
        async (kind) => {
            vi.useFakeTimers();
            const uploads = Array.from({ length: 4 }, () => deferred<string>());
            const items = uploads.map((_, i) => ({
                load: vi.fn(() => new Uint8Array([i])),
                customId: `id-${i}`,
                fileName: `file-${i}.webp`,
            }));
            vi.mocked(saveAsset).mockImplementation((data) => uploads[data[0]].promise);
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
            expect(saveAsset).toHaveBeenCalledTimes(2);
            expect(saveAsset).toHaveBeenNthCalledWith(1, new Uint8Array([0]), "id-0", "file-0.webp", undefined);
            expect(progress).not.toHaveBeenCalled();

            uploads[1].resolve("key-1");
            await drain();
            expect(items.map((item) => item.load.mock.calls.length)).toEqual([1, 1, 1, 0]);
            expect(progress.mock.calls.map(([done]) => done)).toEqual([1]);
            uploads[2].resolve("key-2");
            await drain();
            expect(items.map((item) => item.load.mock.calls.length)).toEqual([1, 1, 1, 1]);
            uploads[3].resolve("key-3");
            await drain();
            uploads[0].resolve("key-0");
            await expect(result).resolves.toEqual(["key-0", "key-1", "key-2", "key-3"]);
            expect(progress.mock.calls.map(([done]) => done)).toEqual([1, 2, 3, 4]);
            if (kind !== "async iterable")
                expect(progress.mock.calls).toEqual([
                    [1, 4],
                    [2, 4],
                    [3, 4],
                    [4, 4],
                ]);
        },
    );

    it("stops admission on the first failure, waits for active saves, and reports the failure count and first cause", async () => {
        vi.useFakeTimers();
        const uploads = Array.from({ length: 3 }, () => deferred<string>());
        const loads = Array.from({ length: 5 }, (_, i) => vi.fn(() => new Uint8Array([i])));
        vi.mocked(saveAsset).mockImplementation((data) => uploads[data[0]].promise);
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
        const first = new Error("disk full");
        uploads[1].reject(first);
        await drain();
        expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1, 1, 0, 0]);
        expect(progress.mock.calls).toEqual([[1, 5]]);
        expect(settled).not.toHaveBeenCalled();
        uploads[0].resolve("saved-0");
        await drain();
        expect(settled).not.toHaveBeenCalled();
        const second = new Error("connection lost");
        uploads[2].reject(second);
        const result = await outcome;
        expect(result).toHaveProperty("error");
        const error = (result as { error: AssetSaveError }).error;
        expect(error).toBeInstanceOf(AssetSaveError);
        expect(error.failed).toBe(2);
        expect(error.message).toMatch(/2 assets/);
        expect(error.cause).toBe(first);
        expect(error.errors).toEqual([first, second]);
        expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1, 1, 0, 0]);
        expect(progress.mock.calls).toEqual([
            [1, 5],
            [2, 5],
            [3, 5],
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
