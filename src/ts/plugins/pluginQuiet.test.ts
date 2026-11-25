import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForPluginsQuiet, type PluginQuietTarget } from "./pluginQuiet";

function wait(targets: PluginQuietTarget[], capMs = 20000, signal?: AbortSignal) {
    const inFlight = new Set<string>();
    const busy = vi.fn((name: string) => inFlight.has(name));
    const listeners = new Set<(name: string) => void>();
    const settled = vi.fn();
    const result = waitForPluginsQuiet(targets, {
        capMs,
        signal,
        busy,
        onActivity: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    });
    void result.then(settled);
    return {
        result,
        settled,
        busy,
        inFlight,
        report: (name: string) => {
            for (const listener of listeners) listener(name);
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(100000);
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("waitForPluginsQuiet", () => {
    it("starts the quiet clock at the wait and resolves exactly after the quiet time", async () => {
        const waiting = wait([{ name: "a", quietMs: 3000 }]);
        await vi.advanceTimersByTimeAsync(2999);
        expect(waiting.settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waiting.settled).toHaveBeenCalledExactlyOnceWith("quiet");
    });

    it("restarts only the reporting plugin's clock", async () => {
        const waiting = wait([
            { name: "a", quietMs: 1000 },
            { name: "b", quietMs: 3000 },
        ]);
        await vi.advanceTimersByTimeAsync(2500);
        waiting.report("a");
        await vi.advanceTimersByTimeAsync(999);
        expect(waiting.settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waiting.settled).toHaveBeenCalledExactlyOnceWith("quiet");
    });

    it("waits without polling a busy plugin until its settle report starts another quiet period", async () => {
        const waiting = wait([{ name: "a", quietMs: 1000 }]);
        waiting.inFlight.add("a");
        await vi.advanceTimersByTimeAsync(1000);
        expect(waiting.settled).not.toHaveBeenCalled();
        // The cap is the only remaining timer while this work is in flight.
        expect(vi.getTimerCount()).toBe(1);
        waiting.busy.mockClear();
        await vi.advanceTimersByTimeAsync(4000);
        expect(waiting.busy).not.toHaveBeenCalled();
        expect(waiting.settled).not.toHaveBeenCalled();

        waiting.inFlight.delete("a");
        waiting.report("a");
        await vi.advanceTimersByTimeAsync(999);
        expect(waiting.settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waiting.settled).toHaveBeenCalledExactlyOnceWith("quiet");
    });

    it("caps a wait even when a plugin never settles", async () => {
        const waiting = wait([{ name: "a", quietMs: 1000 }], 5000);
        waiting.inFlight.add("a");
        await vi.advanceTimersByTimeAsync(4999);
        expect(waiting.settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waiting.settled).toHaveBeenCalledExactlyOnceWith("cap");
    });

    it("caps an idle plugin when the cap is shorter than its quiet time", async () => {
        const waiting = wait([{ name: "a", quietMs: 3000 }], 1000);
        await vi.advanceTimersByTimeAsync(999);
        expect(waiting.settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waiting.settled).toHaveBeenCalledExactlyOnceWith("cap");
    });

    it("aborts on the signal, including a signal already aborted at the start", async () => {
        const controller = new AbortController();
        const waiting = wait([{ name: "a", quietMs: 3000 }], 20000, controller.signal);
        await vi.advanceTimersByTimeAsync(500);
        expect(waiting.settled).not.toHaveBeenCalled();
        controller.abort();
        await expect(waiting.result).resolves.toBe("aborted");
        await expect(wait([{ name: "a", quietMs: 3000 }], 20000, controller.signal).result).resolves.toBe("aborted");
    });

    it("waits for both targets with different quiet times", async () => {
        const waiting = wait([
            { name: "a", quietMs: 1000 },
            { name: "b", quietMs: 4000 },
        ]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(waiting.settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2999);
        expect(waiting.settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waiting.settled).toHaveBeenCalledExactlyOnceWith("quiet");
    });

    it("resolves an empty target list immediately without waiting for a timer", async () => {
        await expect(wait([]).result).resolves.toBe("quiet");
    });
});
