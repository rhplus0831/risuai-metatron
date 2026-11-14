// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutputMeter, OUTPUT_COUNT_INTERVAL_MS } from "../prompt/outputMeter.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("local output metering", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(10_000);
    });
    afterEach(() => vi.useRealTimers());

    function setup(count = vi.fn(async (text: string) => text.length)) {
        const report = vi.fn();
        const log = vi.fn();
        const meter = createOutputMeter({ count, report, log, now: Date.now, setTimeout, clearTimeout });
        return { meter, count, report, log };
    }

    it("coalesces pending text at 500 ms, adds only extensions and replaces the total on a rewrite", async () => {
        const { meter, count, report } = setup();
        expect(OUTPUT_COUNT_INTERVAL_MS).toBe(500);
        try {
            meter.note("ab");
            await vi.advanceTimersByTimeAsync(100);
            meter.note("abc");
            await vi.advanceTimersByTimeAsync(100);
            meter.note("abcde");
            await vi.advanceTimersByTimeAsync(299);
            expect(count.mock.calls).toEqual([["ab"]]);
            expect(report.mock.calls).toEqual([[{ tokens: 2, since: 10_000, at: 10_000 }]]);
            await vi.advanceTimersByTimeAsync(1);
            expect(count.mock.calls).toEqual([["ab"], ["cde"]]);
            expect(report.mock.calls).toEqual([
                [{ tokens: 2, since: 10_000, at: 10_000 }],
                [{ tokens: 5, since: 10_000, at: 10_500 }],
            ]);
            meter.note("x");
            await vi.advanceTimersByTimeAsync(500);
            expect(count.mock.calls).toEqual([["ab"], ["cde"], ["x"]]);
            expect(report.mock.calls.at(-1)).toEqual([{ tokens: 1, since: 10_000, at: 11_000 }]);
        } finally {
            meter.stop();
        }
    });

    it("waits for an in-flight count and starts the newest suffix once the start interval has elapsed", async () => {
        const first = deferred<number>();
        const { meter, count, report } = setup(
            vi.fn(async (text: string) => text.length).mockImplementationOnce(() => first.promise),
        );
        try {
            meter.note("ab");
            await vi.advanceTimersByTimeAsync(100);
            meter.note("abc");
            await vi.advanceTimersByTimeAsync(600);
            meter.note("abcde");
            expect(count.mock.calls).toEqual([["ab"]]);
            expect(report).not.toHaveBeenCalled();
            first.resolve(2);
            await vi.advanceTimersByTimeAsync(0);
            expect(count.mock.calls).toEqual([["ab"], ["cde"]]);
            expect(report.mock.calls).toEqual([
                [{ tokens: 2, since: 10_000, at: 10_700 }],
                [{ tokens: 5, since: 10_000, at: 10_700 }],
            ]);
        } finally {
            first.resolve(2);
            meter.stop();
        }
    });

    it.each(["throws", "rejects"] as const)(
        "logs once and stops without escaping when counting %s",
        async (failure) => {
            const error = new Error("tokenizer unavailable");
            const count = vi.fn((_text: string): Promise<number> => {
                if (failure === "throws") throw error;
                return Promise.reject(error);
            });
            const { meter, report, log } = setup(count);
            await expect(Promise.resolve().then(() => meter.note("abc"))).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(500);
            meter.note("abcdef");
            await vi.advanceTimersByTimeAsync(1000);
            expect(count).toHaveBeenCalledTimes(1);
            expect(log.mock.calls).toEqual([[error]]);
            expect(report).not.toHaveBeenCalled();
            meter.stop();
        },
    );

    it("discards a scheduled count and a result still in flight when stopped", async () => {
        const pending = setup();
        const unresolved = deferred<number>();
        const active = setup(vi.fn((_text: string) => unresolved.promise));
        pending.meter.note("ab");
        active.meter.note("ab");
        await vi.advanceTimersByTimeAsync(100);
        pending.meter.note("abc");
        active.meter.note("abc");
        pending.meter.stop();
        active.meter.stop();
        unresolved.resolve(2);
        pending.meter.note("abcd");
        active.meter.note("abcd");
        await vi.advanceTimersByTimeAsync(1000);
        expect(pending.count.mock.calls).toEqual([["ab"]]);
        expect(active.count.mock.calls).toEqual([["ab"]]);
        expect(pending.report.mock.calls).toEqual([[{ tokens: 2, since: 10_000, at: 10_000 }]]);
        expect(active.report).not.toHaveBeenCalled();
    });
});
