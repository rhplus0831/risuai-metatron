// @vitest-environment node
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildArchive,
    createResourceTestClient,
    hex,
    parseArchive,
    type ResourceTestClient,
    waitFor,
} from "./testSupport.ts";

let s: ResourceTestClient;
beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    s = await createResourceTestClient();
});
afterEach(async () => {
    await s?.close();
    vi.restoreAllMocks();
});

const file = (name: string) => path.join(s.savePath, "assets", name);
const stagedFiles = () => readdirSync(path.join(s.savePath, ".tmp"));
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const write = (key: string, body: string) =>
    s.request("/api/write", { method: "POST", headers: { "file-path": hex(key) }, body });
const read = (key: string) => s.request("/api/read", { headers: { "file-path": hex(key) } });
const writeBatch = (body: Uint8Array | ReadableStream<Uint8Array>, length?: number) =>
    s.request("/api/assets/write", {
        method: "POST",
        headers: {
            "content-type": "application/octet-stream",
            ...(length === undefined ? {} : { "content-length": String(length) }),
        },
        body: body as RequestInit["body"],
        duplex: "half",
    } as RequestInit);

async function observePublication() {
    // Pre-create the target: directory creation has its own durability cost.
    const directory = path.join(s.savePath, "assets");
    mkdirSync(directory, { recursive: true });
    const probe = await fs.open(directory, "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const events: string[] = [];
    const temporaries: string[] = [];
    const files: FileHandle[] = [];
    const sync = prototype.sync;
    vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
        const kind = (await this.stat()).isDirectory() ? "directory" : "file";
        if (kind === "file") {
            files.push(this);
        } else {
            const close = this.close.bind(this);
            vi.spyOn(this, "close").mockImplementation(async () => {
                await close();
                events.push("directory close");
            });
        }
        await sync.call(this);
        events.push(`${kind} sync`);
    });
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        expect(path.dirname(String(from))).toBe(path.join(s.savePath, ".tmp"));
        expect(path.dirname(String(to))).toBe(directory);
        // Node's writeFile captures close before calling sync; the closed fd is observable in both writers.
        expect(files.at(-1)?.fd, "staged file is synced and closed before rename").toBe(-1);
        temporaries.push(String(from));
        await rename(from, to);
        events.push("rename");
    });
    return { events, temporaries };
}

describe("batch asset routes", () => {
    it("flushes a single /api/write file before rename and its directory before answering", async () => {
        const { events } = await observePublication();
        const response = await write("assets/single.bin", "complete bytes");
        events.push("response");
        expect(response.status).toBe(200);
        expect(events).toEqual(["file sync", "rename", "directory sync", "directory close", "response"]);
        expect(readFileSync(file("single.bin"), "utf8")).toBe("complete bytes");
    });

    it("flushes every batch file and syncs the assets directory once after the last rename before answering", async () => {
        const { events, temporaries } = await observePublication();
        const records: [string, string][] = [
            ["assets/one.bin", "one"],
            ["assets/two.bin", "two"],
            ["assets/empty.bin", ""],
        ];
        const response = await writeBatch(buildArchive(records));
        events.push("response");
        expect(response.status).toBe(200);
        expect(events).toEqual([
            "file sync",
            "rename",
            "file sync",
            "rename",
            "file sync",
            "rename",
            "directory sync",
            "directory close",
            "response",
        ]);
        expect(new Set(temporaries).size).toBe(3);
        for (const [key, content] of records) {
            expect(readFileSync(file(key.slice("assets/".length)), "utf8")).toBe(content);
        }
    });

    it("requires a JWT for both batch routes before accessing assets", async () => {
        for (const [url, body, contentType] of [
            ["/api/assets/write", buildArchive([["assets/private.bin", "secret"]]), "application/octet-stream"],
            ["/api/assets/read", JSON.stringify({ keys: ["assets/private.bin"] }), "application/json"],
        ] as const) {
            const res = await s.app.request(url, {
                method: "POST",
                headers: { "content-type": contentType },
                body: body as RequestInit["body"],
            });
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        }
        expect(existsSync(file("private.bin"))).toBe(false);
        expect(stagedFiles()).toEqual([]);
    });

    it("writes exact bytes readable by /api/read, overwrites, and creates empty files", async () => {
        expect((await write("assets/existing.bin", "old and longer")).status).toBe(200);
        const records: [string, Uint8Array | string][] = [
            ["assets/a.bin", new Uint8Array([0, 255, 128, 13, 10])],
            ["assets/existing.bin", "new"],
            ["assets/empty.bin", ""],
        ];
        const res = await writeBatch(buildArchive(records));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, written: 3 });
        for (const [key, bytes] of records) {
            const response = await read(key);
            expect(response.status).toBe(200);
            const expected = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
            expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
            expect(readFileSync(file(key.slice("assets/".length)))).toEqual(expected);
        }
        expect(stagedFiles()).toEqual([]);
    });

    it("drains an invalid mid-batch key, returns its index, and keeps only earlier records", async () => {
        const chunks = [
            buildArchive([["assets/before.bin", "kept"]]),
            buildArchive([["nope/x", "invalid"]]),
            buildArchive([["assets/after.bin", "not written"]]),
            buildArchive([["assets/last.bin", "also not written"]]),
        ];
        let pulled = 0;
        let cancelled = false;
        let drained = false;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (pulled < chunks.length) controller.enqueue(chunks[pulled++]);
                    else {
                        drained = true;
                        controller.close();
                    }
                },
                cancel() {
                    cancelled = true;
                },
            },
            { highWaterMark: 0 },
        );
        // Content-Length bypasses Hono's buffering, so the route must drain these chunks itself.
        const response = writeBatch(
            body,
            chunks.reduce((size, chunk) => size + chunk.length, 0),
        );
        await expect(response).resolves.toMatchObject({ status: 400 });
        expect(await (await response).json()).toEqual({ error: "Invaild Path", index: 1 });
        expect(pulled).toBe(chunks.length);
        expect(drained).toBe(true);
        expect(cancelled).toBe(false);
        expect(readFileSync(file("before.bin"), "utf8")).toBe("kept");
        expect(readdirSync(path.join(s.savePath, "assets"))).toEqual(["before.bin"]);
        expect(stagedFiles()).toEqual([]);
    });

    it("returns 400 for malformed or truncated framing and removes unfinished staged files", async () => {
        const valid = buildArchive([["assets/partial.bin", "unfinished"]]);
        for (const body of [
            valid.subarray(0, valid.length - 1),
            valid.subarray(0, 2),
            new Uint8Array([0, 0, 0, 0]),
            new Uint8Array([1, 16, 0, 0]),
            new Uint8Array([2, 0, 0, 0, 0xc3, 0x28, 0, 0, 0, 0]),
        ]) {
            const res = await writeBatch(body);
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: "Invalid asset batch" });
            expect(existsSync(file("partial.bin"))).toBe(false);
            expect(stagedFiles()).toEqual([]);
        }
    });

    it("refuses writes with 503 and Retry-After 5 during maintenance while batch reads stay open", async () => {
        await write("assets/existing.bin", "kept");
        const inside = deferred();
        const release = deferred();
        const maintenance = s.context.snapshots.withMaintenance(async () => {
            inside.resolve();
            await release.promise;
        });
        try {
            await inside.promise;
            const res = await writeBatch(
                buildArchive([
                    ["assets/existing.bin", "lost"],
                    ["assets/later.bin", "lost"],
                ]),
            );
            expect(res.status).toBe(503);
            expect(res.headers.get("retry-after")).toBe("5");
            expect(readFileSync(file("existing.bin"), "utf8")).toBe("kept");
            expect(existsSync(file("later.bin"))).toBe(false);
            expect(stagedFiles()).toEqual([]);
            const read = await s.json("/api/assets/read", { keys: ["assets/existing.bin"] });
            expect(read.status).toBe(200);
            expect(parseArchive(new Uint8Array(await read.arrayBuffer()))).toEqual([
                { name: "assets/existing.bin", data: Buffer.from("kept") },
            ]);
        } finally {
            release.resolve();
            await maintenance;
        }
    });

    it("stages incoming bytes and lets maintenance begin while the next record body is paused", async () => {
        const first = buildArchive([["assets/first.bin", "first"]]);
        const second = buildArchive([["assets/second.bin", "second"]]);
        const cut = second.length - 3;
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
            start(value) {
                controller = value;
            },
        });
        const pending = writeBatch(stream, first.length + second.length);
        controller.enqueue(first);
        controller.enqueue(second.subarray(0, cut));
        const release = deferred();
        let entered = false;
        let maintenance: Promise<unknown> | undefined;
        try {
            await waitFor(() => {
                const names = stagedFiles();
                return (
                    existsSync(file("first.bin")) &&
                    names.length === 1 &&
                    readFileSync(path.join(s.savePath, ".tmp", names[0])).toString() === "sec"
                );
            });
            expect(existsSync(file("second.bin"))).toBe(false);
            maintenance = s.context.snapshots.withMaintenance(async () => {
                entered = true;
                await release.promise;
            });
            await waitFor(() => entered);
            expect(readFileSync(file("first.bin"), "utf8")).toBe("first");
        } finally {
            release.resolve();
            if (entered) await maintenance;
            // Finish the body even on an assertion failure, so a gate regression cannot hang cleanup.
            controller.enqueue(second.subarray(cut));
            controller.close();
            await maintenance;
            await pending;
        }
        const res = await pending;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, written: 2 });
        expect(readFileSync(file("second.bin"), "utf8")).toBe("second");
        expect(stagedFiles()).toEqual([]);
    });

    it("applies the global 100 MiB body limit to both batch routes without a large allocation", async () => {
        for (const route of ["write", "read"]) {
            const res = await s.request(`/api/assets/${route}`, {
                method: "POST",
                headers: { "content-length": String(100 * 1024 * 1024 + 1) },
                body: "x",
            });
            expect(res.status).toBe(413);
        }
        expect(stagedFiles()).toEqual([]);
    });

    it("keeps a batch of exactly the cap, and rejects the record past it with 400 after keeping the earlier writes", async () => {
        // A three-record cap; the production 2000 is the slow case below and the parser's own test.
        await s.close();
        s = await createResourceTestClient({ routeLimits: { assetBatchRecords: 3 } });
        const records: [string, string][] = [
            ["assets/one.bin", "one"],
            ["assets/two.bin", "two"],
            ["assets/three.bin", "three"],
        ];
        const full = await writeBatch(buildArchive(records));
        expect(full.status).toBe(200);
        expect(await full.json()).toEqual({ success: true, written: 3 });

        const again = records.map(([key, body]): [string, string] => [key, `${body} again`]);
        const res = await writeBatch(buildArchive([...again, ["assets/overflow.bin", "refused"]]));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid asset batch" });
        for (const [key, body] of again) {
            expect(readFileSync(file(key.slice("assets/".length)), "utf8"), key).toBe(body);
        }
        expect(existsSync(file("overflow.bin"))).toBe(false);
        expect(stagedFiles()).toEqual([]);
    });

    it(
        "rejects record 2001 with 400 after keeping the first 2000 writes",
        { tags: ["slow"], timeout: 60_000 },
        async () => {
            const records: [string, string][] = Array.from({ length: 2000 }, () => ["assets/kept.bin", ""]);
            records.push(["assets/overflow.bin", "refused"]);
            const res = await writeBatch(buildArchive(records));
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: "Invalid asset batch" });
            expect(readFileSync(file("kept.bin"))).toEqual(Buffer.alloc(0));
            expect(existsSync(file("overflow.bin"))).toBe(false);
            expect(stagedFiles()).toEqual([]);
        },
    );

    it("reads stored bytes and empty missing/invalid/symlink/directory records in requested duplicate order", async () => {
        await write("assets/real.bin", "real bytes");
        await write("assets/other.bin", "other bytes");
        symlinkSync(file("real.bin"), file("link.bin"));
        mkdirSync(file("directory"));
        const keys = [
            "assets/other.bin",
            "assets/missing.bin",
            "nope/x",
            "assets/link.bin",
            "assets/directory",
            "assets/real.bin",
            "assets/other.bin",
        ];
        const res = await s.json("/api/assets/read", { keys });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(parseArchive(new Uint8Array(await res.arrayBuffer()))).toEqual(
            keys.map((name, index) => ({
                name,
                data: Buffer.from(["other bytes", "", "", "", "", "real bytes", "other bytes"][index]),
            })),
        );
    });

    it("accepts 2000 read keys and refuses non-array, empty, over-cap, or non-string key lists", async () => {
        for (const keys of [undefined, "assets/a", [], Array(2001).fill("assets/a"), [42], [""], ["assets/a", null]]) {
            const res = await s.json("/api/assets/read", { keys });
            expect(res.status).toBe(400);
        }
        const res = await s.json("/api/assets/read", { keys: Array(2000).fill("nope/x") });
        expect(res.status).toBe(200);
        expect(parseArchive(new Uint8Array(await res.arrayBuffer()))).toEqual(
            Array.from({ length: 2000 }, () => ({ name: "nope/x", data: Buffer.alloc(0) })),
        );
    });
});
