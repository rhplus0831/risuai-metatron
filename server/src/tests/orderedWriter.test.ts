// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOrderedWriter } from "../data/orderedWriter.ts";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("ordered writes", () => {
    it("runs one operation per key in FIFO order and continues after an operation rejects", async () => {
        const writer = createOrderedWriter();
        const held = deferred<void>();
        const entered = deferred<void>();
        const order: string[] = [];
        const error = new Error("write failed");
        const first = writer.run("file", async () => {
            order.push("first");
            entered.resolve();
            await held.promise;
            throw error;
        });
        const rejected = first.catch((reason) => reason);
        const second = writer.run("file", () => {
            order.push("second");
            return 2;
        });
        const third = writer.run("file", () => {
            order.push("third");
            return 3;
        });
        await entered.promise;
        try {
            expect(order).toEqual(["first"]);
        } finally {
            held.resolve();
            await Promise.all([rejected, second, third]);
        }
        expect(await rejected).toBe(error);
        expect(await Promise.all([second, third])).toEqual([2, 3]);
        await writer.settled("file");
        expect(order).toEqual(["first", "second", "third"]);
    });

    it("runs at most four keys concurrently and starts a waiting key when a slot frees", async () => {
        const writer = createOrderedWriter();
        const holds = Array.from({ length: 6 }, () => deferred<void>());
        const entered = holds.map(() => deferred<void>());
        const active = new Set<number>();
        let peak = 0;
        const operations = holds.map((hold, index) =>
            writer.run(String(index), async () => {
                active.add(index);
                peak = Math.max(peak, active.size);
                entered[index].resolve();
                await hold.promise;
                active.delete(index);
                return index;
            }),
        );
        await Promise.all(entered.slice(0, 4).map((entry) => entry.promise));
        try {
            expect([...active]).toEqual([0, 1, 2, 3]);
            holds[1].resolve();
            await entered[4].promise;
            expect([...active]).toEqual([0, 2, 3, 4]);
            expect(peak).toBe(4);
        } finally {
            holds.forEach((hold) => hold.resolve());
        }
        expect(await Promise.all(operations)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("gives another ready key a turn before a busy key starts its next operation", async () => {
        const writer = createOrderedWriter({ concurrency: 1 });
        const held = deferred<void>();
        const entered = deferred<void>();
        const order: string[] = [];
        const first = writer.run("busy", async () => {
            order.push("busy 1");
            entered.resolve();
            await held.promise;
        });
        await entered.promise;
        const second = writer.run("busy", () => {
            order.push("busy 2");
        });
        const third = writer.run("busy", () => {
            order.push("busy 3");
        });
        const other = writer.run("other", () => {
            order.push("other");
        });
        held.resolve();
        await Promise.all([first, second, third, other]);
        expect(order).toEqual(["busy 1", "other", "busy 2", "busy 3"]);
    });
});
