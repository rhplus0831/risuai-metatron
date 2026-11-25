import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { originalPositionFor, destroy, MockSourceMapConsumer } = vi.hoisted(() => {
    const originalPositionFor = vi.fn();
    const destroy = vi.fn();
    const MockSourceMapConsumer = Object.assign(
        vi.fn(function MockSourceMapConsumer() {
            return {
                originalPositionFor,
                destroy,
            };
        }),
        {
            initialize: vi.fn(),
        },
    );

    return {
        originalPositionFor,
        destroy,
        MockSourceMapConsumer,
    };
});

vi.mock("source-map", () => ({
    SourceMapConsumer: MockSourceMapConsumer,
}));

import { translateStackTrace } from "./sourcemap";

describe("translateStackTrace", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        originalPositionFor.mockReset();
        destroy.mockReset();
        MockSourceMapConsumer.mockClear();
        MockSourceMapConsumer.initialize.mockClear();
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns translated stack frames when sourcemaps resolve", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });
        originalPositionFor.mockReturnValue({
            source: "src/lib/Others/AlertComp.svelte",
            line: 214,
            column: 15,
            name: "loadTranslatedTrace",
        });

        const result = await translateStackTrace(`Error: boom
    at loadTranslatedTrace (http://localhost:4173/assets/index-abc123.js:10:15)`);

        expect(result).toEqual({
            stackTrace: `Error: boom
    at loadTranslatedTrace (src/lib/Others/AlertComp.svelte:214:15)`,
            didTranslate: true,
        });
        expect(fetchMock).toHaveBeenCalledWith("http://localhost:4173/assets/index-abc123.js.map", expect.any(Object));
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it("falls back to the original stack trace when sourcemap fetch fails", async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 404,
            statusText: "Not Found",
        });

        const stackTrace = `Error: boom
    at loadTranslatedTrace (http://localhost:4173/assets/index-abc123.js:10:15)`;
        const result = await translateStackTrace(stackTrace);

        expect(result).toEqual({
            stackTrace,
            didTranslate: false,
        });
    });

    it("resolves unchanged frames with a timeout failure at 10 seconds when the sourcemap body never settles", async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const json = vi.fn(() => new Promise<never>(() => {}));
            fetchMock.mockResolvedValue({ ok: true, json });
            const stackTrace = `Error: boom
    at loadTranslatedTrace (http://localhost:4173/assets/index-stalled.js:10:15)`;
            const onTranslated = vi.fn();
            const translation = translateStackTrace(stackTrace).then(onTranslated);

            await vi.advanceTimersByTimeAsync(9_999);
            expect(json).toHaveBeenCalledOnce();
            expect(onTranslated).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(onTranslated).toHaveBeenCalledExactlyOnceWith({ stackTrace, didTranslate: false });
            expect(errorSpy).toHaveBeenCalledWith("Sourcemap fetch timed out: index-stalled.js.map");
            await translation;
        } finally {
            errorSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it("falls back immediately when the stack trace has no sourcemap-backed frames", async () => {
        const stackTrace = `Error: boom
    at loadTranslatedTrace (webpack-internal://src/lib/Others/AlertComp.svelte:10:15)`;
        const result = await translateStackTrace(stackTrace);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result).toEqual({
            stackTrace,
            didTranslate: false,
        });
    });
});
