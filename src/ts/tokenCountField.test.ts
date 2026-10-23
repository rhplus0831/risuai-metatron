import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenCountField } from "./tokenCountField";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createTokenCountField", () => {
    it("counts immediately, waits 400 ms after the last edit, and counts immediately again after reset", async () => {
        const count = vi.fn(async (_text: string, _signal: AbortSignal) => 17);
        const apply = vi.fn();
        const field = createTokenCountField({ count, apply });

        field.update("initial");
        expect(count).toHaveBeenCalledExactlyOnceWith("initial", expect.any(AbortSignal));
        await vi.advanceTimersByTimeAsync(0);
        expect(apply).toHaveBeenLastCalledWith(17);

        field.update("first edit");
        await vi.advanceTimersByTimeAsync(200);
        field.update("last edit");
        await vi.advanceTimersByTimeAsync(399);
        expect(count).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(count).toHaveBeenCalledTimes(2);
        expect(count).toHaveBeenLastCalledWith("last edit", expect.any(AbortSignal));

        field.reset();
        field.update("reopened");
        expect(count).toHaveBeenCalledTimes(3);
        expect(count).toHaveBeenLastCalledWith("reopened", expect.any(AbortSignal));
        field.dispose();
    });

    it("aborts a superseded request as soon as an edit arrives and never applies its late answer", async () => {
        let finishOld!: (count: number) => void;
        const count = vi.fn(async (_text: string, _signal: AbortSignal) => 29);
        count.mockImplementationOnce(() => new Promise<number>((resolve) => (finishOld = resolve)));
        const apply = vi.fn();
        const field = createTokenCountField({ count, apply });

        field.update("old");
        const signal = count.mock.calls[0][1];
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
        field.update("latest");
        expect(signal.aborted).toBe(true);
        expect(count).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(400);
        expect(count).toHaveBeenLastCalledWith("latest", expect.any(AbortSignal));
        expect(apply).toHaveBeenCalledExactlyOnceWith(29);
        finishOld(91);
        await vi.advanceTimersByTimeAsync(0);
        expect(apply).toHaveBeenCalledExactlyOnceWith(29);
        field.dispose();
    });

    it("keeps the last count on rejection and calls the optional error handler", async () => {
        const error = new Error("count failed");
        for (const onError of [undefined, vi.fn()]) {
            const count = vi.fn(async (_text: string, _signal: AbortSignal) => 17);
            const apply = vi.fn();
            const field = createTokenCountField({ count, apply, onError });
            field.update("initial");
            await vi.advanceTimersByTimeAsync(0);
            expect(apply).toHaveBeenCalledExactlyOnceWith(17);

            count.mockRejectedValueOnce(error);
            field.update("failing edit");
            await vi.advanceTimersByTimeAsync(400);
            expect(count).toHaveBeenCalledTimes(2);
            expect(apply).toHaveBeenCalledExactlyOnceWith(17);
            if (onError) expect(onError).toHaveBeenCalledExactlyOnceWith(error);
            field.dispose();
        }
    });

    it("cancels a pending count on dispose and sends nothing for later updates", async () => {
        const count = vi.fn(async (_text: string, _signal: AbortSignal) => 17);
        const field = createTokenCountField({ count, apply: vi.fn() });
        field.update("initial");
        await vi.advanceTimersByTimeAsync(0);
        field.update("pending edit");
        await vi.advanceTimersByTimeAsync(399);

        field.dispose();
        await vi.advanceTimersByTimeAsync(1);
        expect(count).toHaveBeenCalledTimes(1);
        field.update("after teardown");
        await vi.advanceTimersByTimeAsync(400);
        expect(count).toHaveBeenCalledTimes(1);
    });
});
