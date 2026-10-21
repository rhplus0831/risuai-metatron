import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The asset client (`assetClient.ts`, the asset half of the removed storage client) against a fake
// of the server's `/api/read` and `/api/write` routes, reached through `authFetch` (mocked: the
// authentication is `serverAuth.test.ts`'s). The wire contract is the old one: the key travels
// hex-encoded in the `file-path` header, a write is an octet-stream `POST`, a non-2xx answer throws
// the old error strings, a 2xx answer carrying `error` throws it, and a missing or empty file reads
// as `null`.

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

import { AssetRecordParser, encodeAssetRecordHeader } from "../../../../shared/assetBatch.ts";
import { ASSET_BATCH_CLIENT_BYTES, readAsset, readAssets, writeAsset, writeAssets } from "../assetClient";
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

// Batch transport stays at the authFetch boundary; the codec itself has independent wire fixtures
// in shared/tests/assetBatch.test.ts.
function batchBytes(records: { key: string; bytes: Uint8Array }[]) {
    return Buffer.concat(records.flatMap(({ key, bytes }) => [encodeAssetRecordHeader(key, bytes.length), bytes]));
}

function postedRecords(init: RequestInit) {
    const parser = new AssetRecordParser();
    const records = parser.push(init.body as Uint8Array);
    parser.end();
    return records.map(({ name, bytes }) => ({ key: name, bytes }));
}

function streamedBatch(bytes: Uint8Array) {
    let at = 0;
    return new Response(
        new ReadableStream<Uint8Array>({
            pull(controller) {
                if (at === bytes.length) controller.close();
                else {
                    const end = Math.min(at + 3, bytes.length);
                    controller.enqueue(bytes.subarray(at, end));
                    at = end;
                }
            },
        }),
    );
}

describe("batch assets", () => {
    it("posts records that round trip to the supplied keys and bytes", async () => {
        const items = [
            { key: KEY, bytes: BYTES },
            { key: "assets/한글.bin", bytes: new Uint8Array([0, 255, 13]) },
            { key: "assets/empty.bin", bytes: new Uint8Array() },
        ];
        const controller = new AbortController();
        answer.current = () => Response.json({ success: true, written: 3 });
        await expect(writeAssets(items, { signal: controller.signal })).resolves.toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(calls[0].path).toBe("/api/assets/write");
        expect(calls[0].init.method).toBe("POST");
        expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/octet-stream");
        expect(calls[0].init.signal).toBe(controller.signal);
        expect(postedRecords(calls[0].init)).toEqual(items);
    });

    it("splits 501 writes and reads into sequential requests of 500 and 1", async () => {
        const items = Array.from({ length: 501 }, (_, index) => ({
            key: `assets/${index}.bin`,
            bytes: new Uint8Array([index % 256]),
        }));
        for (const mode of ["write", "read"] as const) {
            calls.length = 0;
            let release!: (response: Response) => void;
            const first = new Promise<Response>((resolve) => {
                release = resolve;
            });
            answer.current = () =>
                calls.length === 1
                    ? first
                    : mode === "write"
                      ? Response.json({ success: true, written: 1 })
                      : new Response(batchBytes(items.slice(500)));
            const pending = mode === "write" ? writeAssets(items) : readAssets(items.map(({ key }) => key));
            // The next request must wait for the previous response, even though all items are ready.
            await Promise.resolve();
            expect(calls).toHaveLength(1);
            release(
                mode === "write"
                    ? Response.json({ success: true, written: 500 })
                    : new Response(batchBytes(items.slice(0, 500))),
            );
            const result = await pending;
            expect(calls).toHaveLength(2);
            for (const [index, { path, init }] of calls.entries()) {
                expect(path).toBe(`/api/assets/${mode}`);
                const expected = index === 0 ? items.slice(0, 500) : items.slice(500);
                if (mode === "write") expect(postedRecords(init)).toEqual(expected);
                else expect(JSON.parse(init.body as string)).toEqual({ keys: expected.map(({ key }) => key) });
            }
            if (mode === "read") expect(result).toEqual(items.map(({ bytes }) => Buffer.from(bytes)));
        }
    });

    it("counts headers toward the 64 MiB write limit", async () => {
        expect(ASSET_BATCH_CLIENT_BYTES).toBe(64 * 1024 * 1024);
        // Both items share 32 MiB of input. Two request bodies add 64 MiB; no decoding copy.
        const bytes = new Uint8Array(32 * 1024 * 1024);
        answer.current = () => Response.json({ success: true, written: 1 });
        await writeAssets([
            { key: "assets/a", bytes },
            { key: "assets/b", bytes },
        ]);
        expect(calls).toHaveLength(2);
        for (const { init } of calls) expect((init.body as Uint8Array).byteLength).toBe(bytes.length + 8 + 8);
    });

    it("sends a 70 MiB item alone between smaller batches", async () => {
        // One 70 MiB input plus its request body: about 140 MiB, with no parsing/Response copy.
        const bytes = new Uint8Array(70 * 1024 * 1024);
        answer.current = () => Response.json({ success: true });
        await writeAssets([
            { key: "assets/a", bytes: new Uint8Array([1]) },
            { key: "assets/b", bytes },
            { key: "assets/c", bytes: new Uint8Array([2]) },
        ]);
        expect(calls.map(({ init }) => (init.body as Uint8Array).byteLength)).toEqual([17, 70 * 1024 * 1024 + 16, 17]);
    });

    it("reads a chunked response as Buffers and null in requested duplicate order", async () => {
        const items = [
            { key: "assets/b", bytes: new Uint8Array([9, 0, 255]) },
            { key: "assets/missing", bytes: new Uint8Array() },
            { key: "assets/a", bytes: BYTES },
            { key: "assets/b", bytes: new Uint8Array([9, 0, 255]) },
        ];
        const controller = new AbortController();
        answer.current = () => streamedBatch(batchBytes(items));
        const keys = items.map(({ key }) => key);
        const results = await readAssets(keys, { signal: controller.signal });
        expect(results).toEqual([Buffer.from([9, 0, 255]), null, Buffer.from(BYTES), Buffer.from([9, 0, 255])]);
        for (const value of results) if (value !== null) expect(Buffer.isBuffer(value)).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].path).toBe("/api/assets/read");
        expect(calls[0].init.method).toBe("POST");
        expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
        expect(calls[0].init.signal).toBe(controller.signal);
        expect(JSON.parse(calls[0].init.body as string)).toEqual({ keys });
    });

    it('throws "getItem Error" for truncated, malformed, missing, extra, or reordered response records', async () => {
        const items = [
            { key: "assets/a", bytes: BYTES },
            { key: "assets/b", bytes: BYTES },
        ];
        const valid = batchBytes(items);
        for (const bytes of [
            valid.subarray(0, valid.length - 1),
            new Uint8Array([0, 0, 0, 0]),
            batchBytes(items.slice(0, 1)),
            batchBytes([...items, items[0]]),
            batchBytes([...items].reverse()),
            batchBytes([items[0], { ...items[1], key: "assets/wrong" }]),
        ]) {
            answer.current = () => streamedBatch(bytes);
            await expect(readAssets(["assets/a", "assets/b"])).rejects.toBe("getItem Error");
        }
    });

    it("preserves non-2xx errors and a refused write's error without sending later batches", async () => {
        const items = Array.from({ length: 501 }, () => ({ key: KEY, bytes: BYTES }));
        for (const response of [
            () => new Response("not JSON", { status: 500 }),
            () => Response.json({ error: "write refused" }),
        ]) {
            calls.length = 0;
            answer.current = response;
            await expect(writeAssets(items)).rejects.toBe(response().ok ? "write refused" : "setItem Error");
            expect(calls).toHaveLength(1);
        }
        calls.length = 0;
        answer.current = () => new Response("not a batch", { status: 404 });
        await expect(readAssets(Array(501).fill(KEY))).rejects.toBe("getItem Error");
        expect(calls).toHaveLength(1);
    });

    it("sends nothing for empty write and read lists", async () => {
        answer.current = () => Response.json({ success: true });
        await expect(writeAssets([])).resolves.toBeUndefined();
        await expect(readAssets([])).resolves.toEqual([]);
        expect(authFetch).not.toHaveBeenCalled();
    });

    it("retries batch requests through authFetch and aborts their retry waits", async () => {
        vi.useFakeTimers();
        for (const mode of ["write", "read"] as const) {
            const run = (signal?: AbortSignal) =>
                mode === "write"
                    ? writeAssets([{ key: KEY, bytes: BYTES }], { signal })
                    : readAssets([KEY], { signal });
            for (const failure of [429, 503, "network"] as const) {
                calls.length = 0;
                answer.current = () => {
                    if (calls.length === 1) {
                        if (failure === "network") throw new TypeError("network failure");
                        return new Response(null, { status: failure, headers: { "Retry-After": "1" } });
                    }
                    return mode === "write"
                        ? Response.json({ success: true })
                        : streamedBatch(batchBytes([{ key: KEY, bytes: BYTES }]));
                };
                const pending = run().then(
                    () => ({ ok: true }),
                    (error) => ({ error }),
                );
                await vi.advanceTimersByTimeAsync(999);
                expect(calls).toHaveLength(1);
                await vi.advanceTimersByTimeAsync(1);
                expect(await pending).toEqual({ ok: true });
                expect(calls).toHaveLength(2);
                expect(calls[1].init.body).toEqual(calls[0].init.body);
            }
            calls.length = 0;
            answer.current = () => new Response(null, { status: 503, headers: { "Retry-After": "5" } });
            const controller = new AbortController();
            const reason = new Error("batch cancelled");
            const rejected = expect(run(controller.signal)).rejects.toBe(reason);
            await vi.advanceTimersByTimeAsync(0);
            controller.abort(reason);
            await rejected;
            await vi.runAllTimersAsync();
            expect(calls).toHaveLength(1);
        }
    });
});
