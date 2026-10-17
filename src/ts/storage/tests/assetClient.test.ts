import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The asset client (`assetClient.ts`, Phase 6 slice 10: the asset half of the removed storage
// client) against a fake of the server's `/api/read` and `/api/write` routes, reached through
// `authFetch` (mocked: the authentication is `serverAuth.test.ts`'s). The wire contract is the old
// one: the key travels hex-encoded in the `file-path` header, a write is an octet-stream `POST`, a
// non-2xx answer throws the old error strings, a 2xx answer carrying `error` throws it, and a
// missing or empty file reads as `null`.

const { calls, answer } = vi.hoisted(() => ({
    calls: [] as { path: string; init: RequestInit }[],
    answer: { current: null as null | ((path: string, init: RequestInit) => Response | Promise<Response>) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: vi.fn(async (path: string, init: RequestInit = {}, options?: { beforeDispatch?: () => void }) => {
        calls.push({ path, init });
        options?.beforeDispatch?.();
        return answer.current!(path, init);
    }),
}));

import { readAsset, writeAsset } from "../assetClient";
import { authFetch } from "../serverAuth";

const KEY = "assets/abc.png";
const HEX = Buffer.from(KEY, "utf-8").toString("hex");
const BYTES = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);

beforeEach(() => {
    calls.length = 0;
    answer.current = null;
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
});

// Run the shared transport contract through both public operations. All waits below are virtual.
const operations = [
    { run: (signal?: AbortSignal) => writeAsset(KEY, BYTES, { signal }), error: "setItem Error" },
    { run: (signal?: AbortSignal) => readAsset(KEY, { signal }), error: "getItem Error" },
];
const success = () => new Response("{}", { status: 200 });

describe("asset request retries", () => {
    beforeEach(() => vi.useFakeTimers());

    it("retries 429 through authFetch after Retry-After seconds, capped at 60 seconds", async () => {
        for (const { run } of operations) {
            for (const [header, wait] of [
                ["3", 3_000],
                ["120", 60_000],
            ] as const) {
                calls.length = 0;
                answer.current = () =>
                    calls.length === 1
                        ? new Response(null, { status: 429, headers: { "Retry-After": header } })
                        : success();
                const result = run().then(
                    () => ({ ok: true }),
                    (error) => ({ error }),
                );
                await vi.advanceTimersByTimeAsync(wait - 1);
                expect(calls).toHaveLength(1);
                await vi.advanceTimersByTimeAsync(1);
                expect(await result).toEqual({ ok: true });
                expect(calls).toHaveLength(2);
            }
        }
    });

    it("backs off 503 at 1, 2, 4, 8, 16, 30, 30 seconds and stops at eight attempts with the old error", async () => {
        for (const { run, error } of operations) {
            calls.length = 0;
            answer.current = () => new Response(null, { status: 503 });
            const failure = run().then(
                () => undefined,
                (error) => error,
            );
            for (const [index, wait] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
                await vi.advanceTimersByTimeAsync(wait - 1);
                expect(calls).toHaveLength(index + 1);
                await vi.advanceTimersByTimeAsync(1);
                expect(calls).toHaveLength(index + 2);
            }
            expect(await failure).toBe(error);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(calls).toHaveLength(8);
        }
    });

    it("retries thrown network failures with the same backoff and rethrows the eighth network error", async () => {
        for (const { run } of operations) {
            calls.length = 0;
            const failures = Array.from({ length: 8 }, (_, i) => new TypeError(`network failure ${i + 1}`));
            answer.current = () => {
                throw failures[calls.length - 1];
            };
            const failure = run().then(
                () => undefined,
                (error) => error,
            );
            for (const [index, wait] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
                await vi.advanceTimersByTimeAsync(wait - 1);
                expect(calls).toHaveLength(index + 1);
                await vi.advanceTimersByTimeAsync(1);
                expect(calls).toHaveLength(index + 2);
            }
            expect(await failure).toBe(failures[7]);
            expect(calls).toHaveLength(8);
        }
    });

    it("does not retry 500, 403, or 404", async () => {
        for (const { run, error } of operations) {
            for (const status of [500, 403, 404]) {
                calls.length = 0;
                answer.current = () => new Response(null, { status });
                const rejected = expect(run()).rejects.toBe(error);
                await vi.runAllTimersAsync();
                await rejected;
                expect(calls).toHaveLength(1);
            }
        }
    });

    it("aborts the retry wait with the signal's reason and makes no further request", async () => {
        for (const { run } of operations) {
            calls.length = 0;
            const controller = new AbortController();
            const reason = new Error("import cancelled");
            answer.current = () => new Response(null, { status: 429, headers: { "Retry-After": "60" } });
            let rejection: unknown;
            const result = run(controller.signal).catch((error) => {
                rejection = error;
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(calls).toHaveLength(1);
            controller.abort(reason);
            await vi.advanceTimersByTimeAsync(0);
            expect(rejection).toBe(reason);
            await result;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(calls).toHaveLength(1);
        }
    });

    it("passes the signal to the in-flight fetch and throws AbortError when aborted without a reason", async () => {
        for (const { run } of operations) {
            calls.length = 0;
            const controller = new AbortController();
            answer.current = (_path, init) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
                });
            const result = run(controller.signal);
            const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
            expect(calls[0].init.signal).toBe(controller.signal);
            controller.abort();
            await rejected;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(calls).toHaveLength(1);
        }
    });
});

describe("writeAsset", () => {
    it("posts the bytes as an octet stream under the hex-encoded key and resolves to void", async () => {
        answer.current = () => Response.json({ success: true });
        await expect(writeAsset(KEY, BYTES)).resolves.toBeUndefined();
        expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
        const [{ path, init }] = calls;
        expect(path).toBe("/api/write");
        expect(init.method).toBe("POST");
        const headers = new Headers(init.headers);
        expect(headers.get("content-type")).toBe("application/octet-stream");
        expect(headers.get("file-path")).toBe(HEX);
        expect(Buffer.from(headers.get("file-path")!, "hex").toString("utf-8")).toBe(KEY);
        expect(init.body).toBe(BYTES);
    });

    it('throws "setItem Error" for a non-2xx answer, before reading its body', async () => {
        answer.current = () => new Response("nope", { status: 500 });
        await expect(writeAsset(KEY, BYTES)).rejects.toBe("setItem Error");
        answer.current = () => Response.json({ error: "ignored" }, { status: 403 });
        await expect(writeAsset(KEY, BYTES)).rejects.toBe("setItem Error");
    });

    it("throws the answer's `error` for a refused 2xx write", async () => {
        answer.current = () => Response.json({ error: "Invalid path" });
        await expect(writeAsset(KEY, BYTES)).rejects.toBe("Invalid path");
    });
});

describe("readAsset", () => {
    it("gets the bytes under the hex-encoded key as a Buffer", async () => {
        answer.current = () => new Response(BYTES, { status: 200 });
        const data = await readAsset(KEY);
        expect(Buffer.isBuffer(data)).toBe(true);
        expect([...data!]).toEqual([...BYTES]);
        const [{ path, init }] = calls;
        expect(path).toBe("/api/read");
        expect(init.method).toBe("GET");
        expect(new Headers(init.headers).get("file-path")).toBe(HEX);
    });

    it("reads a missing or empty file as null", async () => {
        answer.current = () => new Response(new Uint8Array(0), { status: 200 });
        await expect(readAsset(KEY)).resolves.toBeNull();
        answer.current = () => new Response(null, { status: 204 });
        await expect(readAsset("assets/missing.png")).resolves.toBeNull();
    });

    it('throws "getItem Error" for a non-2xx answer', async () => {
        answer.current = () => new Response("nope", { status: 404 });
        await expect(readAsset(KEY)).rejects.toBe("getItem Error");
        answer.current = () => new Response(BYTES, { status: 500 });
        await expect(readAsset(KEY)).rejects.toBe("getItem Error");
    });
});
