import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The asset client (`assetClient.ts`, the asset half of the removed storage client) against a fake
// of the server's `/api/read` and `/api/write` routes, reached through `authFetch` (mocked: the
// authentication is `serverAuth.test.ts`'s). The wire contract is the old one: the key travels
// hex-encoded in the `file-path` header, a write is an octet-stream `POST`, a non-2xx answer throws
// a status-bearing Error for reads or the old error string for writes, a 2xx answer carrying
// `error` throws it, and a missing or empty file reads as `null`.

const { calls, answer } = vi.hoisted(() => ({
    calls: [] as { path: string; init: RequestInit }[],
    answer: { current: null as null | ((path: string, init: RequestInit) => Response | Promise<Response>) },
}));

vi.mock("../serverAuth", async () =>
    (await import("./serverAuthMock")).createServerAuthMock({
        authFetch: vi.fn(async (path: string, init: RequestInit = {}, options?: { beforeDispatch?: () => void }) => {
            calls.push({ path, init });
            options?.beforeDispatch?.();
            return answer.current!(path, init);
        }),
    }),
);

import { AssetRecordParser, encodeAssetRecordHeader } from "../../../../shared/assetBatch.ts";
import {
    ASSET_BATCH_CLIENT_BYTES,
    MISSING_CHECK_DEADLINE_MS,
    missingAssets,
    readAsset,
    readAssets,
    writeAsset,
    writeAssets,
} from "../assetClient";
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
    vi.restoreAllMocks();
});

// Run the shared transport contract through both public operations. All waits below are virtual.
const operations = [
    {
        run: (signal?: AbortSignal) => writeAsset(KEY, BYTES, { signal }),
        expectError: (error: unknown, _status: number) => expect(error).toBe("setItem Error"),
    },
    { run: (signal?: AbortSignal) => readAsset(KEY, { signal }), expectError: expectReadError },
];
function expectReadError(error: unknown, status: number) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "AssetReadError", message: "getItem Error", status });
}
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

    it("backs off 503 at 1, 2, 4, 8, 16, 30, 30 seconds and stops at eight attempts with the operation's error", async () => {
        for (const { run, expectError } of operations) {
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
            expectError(await failure, 503);
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
        for (const { run, expectError } of operations) {
            for (const status of [500, 403, 404]) {
                calls.length = 0;
                answer.current = () => new Response(null, { status });
                const rejected = run().catch((error: unknown) => error);
                await vi.runAllTimersAsync();
                expectError(await rejected, status);
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

    it('throws an AssetReadError with "getItem Error" and the HTTP status for a non-2xx answer', async () => {
        answer.current = () => new Response("nope", { status: 404 });
        expectReadError(await readAsset(KEY).catch((error: unknown) => error), 404);
        answer.current = () => new Response(BYTES, { status: 500 });
        expectReadError(await readAsset(KEY).catch((error: unknown) => error), 500);
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

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function content(text: string, inlay = false) {
    const bytes = new TextEncoder().encode(text);
    const sha256 = digest(bytes);
    return { key: `assets/${inlay ? "inlay_" : ""}${sha256}.png`, bytes, sha256 };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const uploads = () =>
    calls.filter(({ path }) => path === "/api/assets/write").flatMap(({ init }) => postedRecords(init));
const recordsOf = (items: readonly { key: string; bytes: Uint8Array }[]) =>
    items.map(({ key, bytes }) => ({ key, bytes }));

describe("missing asset transport", () => {
    beforeEach(() => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("checks 513 names in requests of 512 and one and combines their missing answers", async () => {
        const names = Array.from({ length: 513 }, (_, i) => content(`asset-${i}`).key);
        answer.current = (_path, init) => {
            const { names: batch } = JSON.parse(init.body as string);
            return Response.json({ missing: [batch[0], batch.at(-1)] });
        };
        expect(await missingAssets(names)).toEqual(new Set([names[0], names[511], names[512]]));
        expect(
            calls.map(({ path, init }) => ({ path, method: init.method, body: JSON.parse(init.body as string) })),
        ).toEqual([
            { path: "/api/assets/missing", method: "POST", body: { names: names.slice(0, 512) } },
            { path: "/api/assets/missing", method: "POST", body: { names: names.slice(512) } },
        ]);
    });

    it("rejects malformed missing answers including names it did not ask about", async () => {
        const name = content("asked").key;
        for (const value of [null, {}, { missing: "all" }, { missing: [42] }, { missing: [content("unasked").key] }]) {
            answer.current = () => Response.json(value);
            await expect(missingAssets([name])).rejects.toThrow();
        }
    });

    it("skips only present canonical items with matching digests and sends missing or unattested bytes", async () => {
        const present = content("present");
        const inlay = content("present inlay", true);
        const missing = content("missing");
        const mismatch = { ...content("claimed"), bytes: BYTES, sha256: digest(BYTES) };
        const raw = { key: content("raw claimed").key, bytes: BYTES };
        const custom = { key: "assets/custom.png", bytes: BYTES, sha256: digest(BYTES) };
        const items = [present, mismatch, inlay, missing, raw, custom];
        answer.current = (path) =>
            Response.json(path === "/api/assets/missing" ? { missing: [missing.key] } : { success: true });
        await writeAssets(items);
        expect(JSON.parse(calls[0].init.body as string)).toEqual({ names: [present.key, inlay.key, missing.key] });
        expect(uploads()).toEqual(recordsOf([mismatch, missing, raw, custom]));
    });

    it("keeps every write of a key in order when the call also contains a raw overwrite", async () => {
        const canonical = content("original");
        const raw = { key: canonical.key, bytes: BYTES };
        const unrelated = content("already present");
        answer.current = (path) => Response.json(path === "/api/assets/missing" ? { missing: [] } : { success: true });
        for (const pair of [
            [canonical, raw],
            [raw, canonical],
        ]) {
            calls.length = 0;
            await writeAssets([...pair, unrelated]);
            expect(JSON.parse(calls[0].init.body as string)).toEqual({ names: [unrelated.key] });
            expect(uploads()).toEqual(recordsOf(pair));
        }
    });

    it.each(["non-2xx", "network", "malformed"])("uploads everything when the check fails: %s", async (failure) => {
        vi.useFakeTimers();
        const items = [content("one"), content("two")];
        answer.current = (path) => {
            if (path !== "/api/assets/missing") return Response.json({ success: true });
            if (failure === "network") throw new TypeError("network unavailable");
            return failure === "non-2xx" ? new Response(null, { status: 500 }) : Response.json({ missing: "invalid" });
        };
        const pending = writeAssets(items).then(
            () => ({ ok: true }),
            (error) => ({ error }),
        );
        await vi.runAllTimersAsync();
        expect(await pending).toEqual({ ok: true });
        expect(uploads()).toEqual(recordsOf(items));
        // Network retries stop at the check's deadline: attempts at 0, 1, 3, 7, and 15 s, then a 16 s wait past it.
        expect(calls.filter(({ path }) => path === "/api/assets/missing")).toHaveLength(failure === "network" ? 5 : 1);
    });

    it("rejects an abort during the check with the signal reason and sends no upload", async () => {
        // Safari before 17.4 has no `AbortSignal.any`.
        vi.spyOn(AbortSignal, "any").mockImplementation(() => {
            throw new TypeError("AbortSignal.any is not a function");
        });
        const response = deferred<Response>();
        const started = deferred<void>();
        answer.current = () => {
            started.resolve();
            return response.promise;
        };
        const controller = new AbortController();
        const reason = new Error("cancel asset import");
        const pending = expect(writeAssets([content("present")], { signal: controller.signal })).rejects.toBe(reason);
        await started.promise;
        controller.abort(reason);
        response.resolve(Response.json({ missing: [] }));
        await pending;
        expect(calls.map(({ path }) => path)).toEqual(["/api/assets/missing"]);
        expect(calls[0].init.signal?.aborted).toBe(true);
        expect(calls[0].init.signal?.reason).toBe(reason);
    });

    it("uploads everything when the check has not answered by its deadline, and cancels the check", async () => {
        vi.useFakeTimers();
        const items = [content("one"), content("two")];
        const held = deferred<Response>();
        answer.current = (path) => (path === "/api/assets/missing" ? held.promise : Response.json({ success: true }));
        let settled = false;
        const pending = writeAssets(items).finally(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(MISSING_CHECK_DEADLINE_MS - 1);
        expect(settled).toBe(false);
        expect(uploads()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(uploads()).toEqual(recordsOf(items));
        expect(calls[0].init.signal?.aborted).toBe(true);
        // A late answer changes nothing.
        held.resolve(Response.json({ missing: [] }));
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.map(({ path }) => path)).toEqual(["/api/assets/missing", "/api/assets/write"]);
    });

    it("resolves without a write request when all items are present", async () => {
        answer.current = () => Response.json({ missing: [] });
        await expect(writeAssets([content("one"), content("two", true)])).resolves.toBeUndefined();
        expect(calls.map(({ path }) => path)).toEqual(["/api/assets/missing"]);
    });
});

describe("saving content-addressed assets", () => {
    let api: typeof import("../../globalApi.svelte");
    let queue: typeof import("../assetQueue");
    beforeAll(async () => {
        api = await import("../../globalApi.svelte");
        queue = await import("../assetQueue");
    });
    beforeEach(() => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it.each(["present", "missing", "failed"])(
        "saveAsset checks canonical content and handles a %s answer",
        async (state) => {
            const item = content("single portrait");
            answer.current = (path) => {
                if (path === "/api/assets/missing") {
                    return state === "failed"
                        ? new Response(null, { status: 500 })
                        : Response.json({ missing: state === "missing" ? [item.key] : [] });
                }
                return Response.json({ success: true });
            };
            await expect(api.saveAsset(item.bytes)).resolves.toBe(item.key);
            expect(calls.map(({ path }) => path)).toEqual(
                state === "present" ? ["/api/assets/missing"] : ["/api/assets/missing", "/api/write"],
            );
            expect(JSON.parse(calls[0].init.body as string)).toEqual({ names: [item.key] });
            if (state !== "present") {
                expect(calls[1].init.body).toEqual(item.bytes);
                expect(Buffer.from(new Headers(calls[1].init.headers).get("file-path")!, "hex").toString()).toBe(
                    item.key,
                );
            }
        },
    );

    it("saveAsset always writes a custom id without a check even when it equals the content digest", async () => {
        const item = content("custom portrait");
        answer.current = () => Response.json({ success: true });
        await expect(api.saveAsset(item.bytes, item.sha256)).resolves.toBe(item.key);
        expect(calls.map(({ path }) => path)).toEqual(["/api/write"]);
        expect(calls[0].init.body).toEqual(item.bytes);
    });

    it("saveAsset preserves an abort during the check without writing", async () => {
        const started = deferred<void>();
        const response = deferred<Response>();
        answer.current = () => {
            started.resolve();
            return response.promise;
        };
        const controller = new AbortController();
        const reason = new Error("cancel single save");
        const pending = expect(
            api.saveAsset(content("portrait").bytes, "", "", { signal: controller.signal }),
        ).rejects.toBe(reason);
        await started.promise;
        controller.abort(reason);
        response.resolve(Response.json({ missing: [] }));
        await pending;
        expect(calls.map(({ path }) => path)).toEqual(["/api/assets/missing"]);
    });

    it("saveAssets returns keys in input order while skipping present content and uploading digest-shaped custom ids", async () => {
        const present = content("present portrait");
        const missing = content("new portrait");
        const custom = content("custom portrait");
        // The server holds the missing key once its upload lands: the batch's check answers it
        // missing, the check after the queue drains answers it present.
        let checks = 0;
        answer.current = (path) =>
            Response.json(
                path === "/api/assets/missing" ? { missing: checks++ === 0 ? [missing.key] : [] } : { success: true },
            );
        const first = deferred<Uint8Array>();
        const secondLoaded = deferred<void>();
        const pending = queue.saveAssets([
            { load: () => first.promise },
            {
                load: () => {
                    secondLoaded.resolve();
                    return missing.bytes;
                },
            },
            { load: () => custom.bytes, customId: custom.sha256 },
        ]);
        await secondLoaded.promise;
        first.resolve(present.bytes);
        expect(await pending).toEqual([present.key, missing.key, custom.key]);
        const checked = calls
            .filter(({ path }) => path === "/api/assets/missing")
            .flatMap(({ init }) => JSON.parse(init.body as string).names);
        expect(new Set(checked)).toEqual(new Set([present.key, missing.key]));
        expect(uploads()).toHaveLength(2);
        expect(uploads()).toEqual(expect.arrayContaining(recordsOf([missing, custom])));
    });

    it("savePickedFiles reimports present files without uploading bytes and retains their ordered keys", async () => {
        const items = [content("picked one"), content("picked two")];
        answer.current = () => Response.json({ missing: [] });
        const files = items.map(({ bytes }, index) => new File([bytes], `${index}.png`));
        expect(await queue.savePickedFiles(files, (file) => file.name)).toEqual(items.map(({ key }) => key));
        // The batch's check, then the check after the queue drains; neither uploads a byte.
        expect(calls.map(({ path }) => path)).toEqual(["/api/assets/missing", "/api/assets/missing"]);
        for (const call of calls) {
            expect(new Set(JSON.parse(call.init.body as string).names)).toEqual(new Set(items.map(({ key }) => key)));
        }
    });
});

it("checks presence separately beside each of two write batches", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const items = Array.from({ length: 501 }, (_, i) => content(`lease-batch-${i}`));
    const events: { path: string; keys: string[] }[] = [];
    answer.current = (url, init) => {
        if (url === "/api/assets/missing") {
            const { names } = JSON.parse(init.body as string);
            events.push({ path: url, keys: names });
            return Response.json({ missing: names });
        }
        events.push({ path: url, keys: postedRecords(init).map((r) => r.key) });
        return Response.json({ success: true });
    };
    await writeAssets(items);
    expect(events).toEqual([
        { path: "/api/assets/missing", keys: items.slice(0, 500).map((x) => x.key) },
        { path: "/api/assets/write", keys: items.slice(0, 500).map((x) => x.key) },
        { path: "/api/assets/missing", keys: [items[500].key] },
        { path: "/api/assets/write", keys: [items[500].key] },
    ]);
    expect(uploads()).toEqual(recordsOf(items));
});
