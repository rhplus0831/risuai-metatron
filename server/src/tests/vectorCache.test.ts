// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createVectorCache, MAX_ENTRY_BYTES, type VectorCache, vectorCacheKey } from "../data/vectorCache.ts";

// Phase 5 slice 10: the server's embedding vector cache (`server/src/data/vectorCache.ts`), the
// replacement of the browser's `hypaVector` LocalForage store. The rows: a local model's
// `Float32Array` back as one from its own bytes (a subview's bytes only, an independent copy), an
// API vector's float64 numbers kept exactly (`1 + 2^-40` would not survive float32), an overwrite
// accounted once, an oversize or empty vector skipped, the trim by `used_at` down to 90% of the
// bound, a hit touching `used_at` only after a minute. The lifecycle: a write of an earlier
// generation dropped after `clear` or `close`, a closed cache serving nothing, the rows kept across
// a reopen under the same epoch and removed under another one, an emptying that fails (the file
// locked) serving and storing nothing until the retry succeeds (at most once a second), a failed
// epoch read handled the same way, a failed sync followed by a restart exposing no old row. The key:
// the SHA-256 of the UTF-16 string, so two lone surrogates never share a row.

const dirs: string[] = [];
const caches: VectorCache[] = [];
function tempFile(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-vector-cache-"));
    dirs.push(dir);
    return path.join(dir, "vectors.sqlite");
}
function open(options: Omit<Parameters<typeof createVectorCache>[0], "file"> & { file?: string } = {}) {
    const cache = createVectorCache({ file: options.file ?? tempFile(), ...options });
    caches.push(cache);
    return cache;
}

beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    for (const cache of caches.splice(0)) {
        cache.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("the rows", () => {
    it("stores a Float32Array subview's own bytes and answers an independent Float32Array", () => {
        const cache = open();
        const backing = new Float32Array([99, 1.25, 2.5, 88]);
        const view = backing.subarray(1, 3);
        cache.set("a|MiniLM", view, cache.generation());
        // Neither the caller's later writes nor the answer's reach the stored bytes.
        backing[1] = 33;
        const first = cache.get("a|MiniLM");
        expect(first).toBeInstanceOf(Float32Array);
        expect(Array.from(first as Float32Array)).toEqual([1.25, 2.5]);
        (first as Float32Array)[0] = 77;
        expect(Array.from(cache.get("a|MiniLM") as Float32Array)).toEqual([1.25, 2.5]);
        expect(cache.stats()).toEqual({ bytes: 8, rows: 1 });
    });

    it("keeps an API vector's float64 numbers exactly and answers a plain array", () => {
        const cache = open();
        const precise = 1 + 2 ** -40;
        cache.set("b|ada", [precise, 3], cache.generation());
        const stored = cache.get("b|ada");
        expect(Array.isArray(stored)).toBe(true);
        expect(stored).toEqual([precise, 3]);
        expect((stored as number[])[0] === precise).toBe(true);
        // What float32 storage would have done to it.
        expect(new Float32Array([precise])[0] === precise).toBe(false);
        expect(cache.stats()).toEqual({ bytes: 16, rows: 1 });
    });

    it("accounts an overwrite once, skips an empty or oversize vector, and misses an unknown key", () => {
        const cache = open();
        cache.set("k", [1, 2], cache.generation());
        cache.set("k", [1, 2, 3, 4], cache.generation());
        expect(cache.stats()).toEqual({ bytes: 32, rows: 1 });
        expect(cache.get("k")).toEqual([1, 2, 3, 4]);
        cache.set("empty", new Float32Array(0), cache.generation());
        cache.set("huge", new Float32Array(MAX_ENTRY_BYTES / 4 + 1), cache.generation());
        expect(cache.get("empty")).toBeNull();
        expect(cache.get("huge")).toBeNull();
        expect(cache.get("never")).toBeNull();
        expect(cache.stats()).toEqual({ bytes: 32, rows: 1 });
        // Exactly the limit is stored.
        cache.set("limit", new Float32Array(MAX_ENTRY_BYTES / 4), cache.generation());
        expect(cache.stats()).toEqual({ bytes: 32 + MAX_ENTRY_BYTES, rows: 2 });
    });

    it("trims the rows used longest ago down to 90% of the bound, a hit moving a row's used_at only after a minute", () => {
        let now = 1_000_000;
        const cache = open({ maxBytes: 100, now: () => now });
        // Five 16-byte rows (80 bytes), written at distinct times.
        for (const key of ["a", "b", "c", "d", "e"]) {
            cache.set(key, [1, 2], cache.generation());
            now += 1000;
        }
        expect(cache.stats()).toEqual({ bytes: 80, rows: 5 });
        // A hit within a minute of the write does not move `a`; one later than that does.
        cache.get("a");
        now += 61_000;
        cache.get("a");
        now += 1000;
        // The sixth row (96 bytes) is within the bound; the seventh (112) passes it: the oldest by
        // `used_at` (b, then c) go until 90 is reached (80).
        cache.set("f", [1, 2], cache.generation());
        expect(cache.stats()).toEqual({ bytes: 96, rows: 6 });
        now += 1000;
        cache.set("g", [1, 2], cache.generation());
        expect(cache.get("b")).toBeNull();
        expect(cache.get("c")).toBeNull();
        expect(cache.get("a")).toEqual([1, 2]);
        expect(cache.get("d")).toEqual([1, 2]);
        expect(cache.get("e")).toEqual([1, 2]);
        expect(cache.get("f")).toEqual([1, 2]);
        expect(cache.get("g")).toEqual([1, 2]);
        expect(cache.stats()).toEqual({ bytes: 80, rows: 5 });
    });

    it("hashes the key as UTF-16, so lone surrogates that differ never share a row", () => {
        expect(vectorCacheKey("\ud800|custom")).not.toBe(vectorCacheKey("\ud801|custom"));
        expect(vectorCacheKey("same")).toBe(vectorCacheKey("same"));
        expect(vectorCacheKey("a")).toMatch(/^[0-9a-f]{64}$/);
        const cache = open();
        cache.set("\ud800|custom", [1], cache.generation());
        cache.set("\ud801|custom", [2], cache.generation());
        expect(cache.get("\ud800|custom")).toEqual([1]);
        expect(cache.get("\ud801|custom")).toEqual([2]);
        expect(cache.stats().rows).toBe(2);
    });
});

describe("the lifecycle", () => {
    it("drops a write of an earlier generation after a clear or the close, and a closed cache serves nothing", () => {
        const file = tempFile();
        const cache = open({ file });
        const before = cache.generation();
        cache.set("early", [1], before);
        cache.clear();
        expect(cache.generation()).toBe(before + 1);
        expect(cache.get("early")).toBeNull();
        // Work that began before the clear cannot repopulate it.
        cache.set("late", [2], before);
        expect(cache.get("late")).toBeNull();
        cache.set("fresh", [3], cache.generation());
        expect(cache.get("fresh")).toEqual([3]);
        const current = cache.generation();
        cache.close();
        expect(cache.generation()).toBe(current + 1);
        cache.set("after-close", [4], cache.generation());
        expect(cache.get("fresh")).toBeNull();
        expect(cache.stats()).toEqual({ bytes: 0, rows: 0 });
        // The file kept what was stored before the close.
        const again = open({ file });
        expect(again.get("fresh")).toEqual([3]);
        expect(again.get("after-close")).toBeNull();
    });

    it("keeps the rows across a reopen under the same epoch and removes them under another", () => {
        const file = tempFile();
        const first = open({ file });
        first.sync("epoch-a");
        first.set("v", [1, 2], first.generation());
        first.sync("epoch-a");
        expect(first.get("v")).toEqual([1, 2]);
        first.close();
        const second = open({ file });
        second.sync("epoch-a");
        expect(second.get("v")).toEqual([1, 2]);
        const generation = second.generation();
        second.sync("epoch-b");
        expect(second.generation()).toBe(generation + 1);
        expect(second.get("v")).toBeNull();
        expect(second.stats()).toEqual({ bytes: 0, rows: 0 });
        // A write of work that began under the old epoch is dropped.
        second.set("old-work", [3], generation);
        expect(second.get("old-work")).toBeNull();
        second.close();
        // A fresh file bound to an epoch for the first time starts empty and stays open.
        const third = open({ file });
        third.sync("epoch-b");
        third.set("w", [5], third.generation());
        expect(third.get("w")).toEqual([5]);
    });

    it("serves and stores nothing while an emptying has not succeeded, retrying at most once a second, and recovers", () => {
        let now = 50_000;
        const file = tempFile();
        const cache = open({ file, now: () => now });
        cache.sync("epoch-a");
        cache.set("old", [1, 2], cache.generation());
        const other = new DatabaseSync(file);
        other.exec("BEGIN IMMEDIATE");
        cache.sync("epoch-b");
        // The clear failed: nothing is served, and nothing is stored.
        expect(cache.get("old")).toBeNull();
        expect(cache.stats()).toEqual({ bytes: 0, rows: 0 });
        cache.set("during", [3], cache.generation());
        other.exec("ROLLBACK");
        other.close();
        // Within the second the retry has not happened yet: still nothing.
        now += 999;
        expect(cache.get("old")).toBeNull();
        now += 1;
        // The retry succeeds: the old rows are gone, the write made during the failure too.
        expect(cache.get("old")).toBeNull();
        expect(cache.get("during")).toBeNull();
        cache.set("fresh", [4], cache.generation());
        expect(cache.get("fresh")).toEqual([4]);
        expect(cache.stats()).toEqual({ bytes: 8, rows: 1 });
    });

    it("treats a failed epoch read as another database, serving nothing until a clear succeeds", () => {
        let now = 50_000;
        const file = tempFile();
        const cache = open({ file, now: () => now });
        cache.sync("epoch-a");
        cache.set("v", [1], cache.generation());
        const other = new DatabaseSync(file);
        other.exec("DROP TABLE meta");
        cache.sync("epoch-a");
        expect(cache.get("v")).toBeNull();
        expect(cache.stats()).toEqual({ bytes: 0, rows: 0 });
        other.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
        other.close();
        now += 1000;
        expect(cache.get("v")).toBeNull();
        cache.set("next", [6], cache.generation());
        expect(cache.get("next")).toEqual([6]);
    });

    it("exposes no old row after a sync that failed and a restart under the new epoch", () => {
        const file = tempFile();
        const cache = open({ file });
        cache.sync("epoch-a");
        cache.set("v", [1], cache.generation());
        const other = new DatabaseSync(file);
        other.exec("BEGIN IMMEDIATE");
        cache.sync("epoch-b");
        cache.close();
        other.exec("ROLLBACK");
        other.close();
        // The stored epoch is still `epoch-a`: the restart under `epoch-b` clears.
        const restarted = open({ file });
        restarted.sync("epoch-b");
        expect(restarted.get("v")).toBeNull();
        expect(restarted.stats()).toEqual({ bytes: 0, rows: 0 });
    });

    it("is a miss, never the caller's error, when the file cannot be opened", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-vector-cache-"));
        dirs.push(dir);
        // A directory where the file should be.
        const cache = open({ file: dir });
        cache.sync("epoch-a");
        cache.set("v", [1], cache.generation());
        expect(cache.get("v")).toBeNull();
        expect(cache.stats()).toEqual({ bytes: 0, rows: 0 });
        expect(console.warn).toHaveBeenCalled();
    });
});
