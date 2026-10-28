import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { STORAGE_READ_FLAGS } from "./recordStream.ts";

type AssetStat = Pick<BigIntStats, "size" | "mtimeNs" | "ino" | "dev">;
type Verification = AssetStat & { ok: boolean };
type AssetHasher = (handle: FileHandle) => Promise<string>;
type BoundedAssetHasher = (handle: FileHandle, size: number, signal?: AbortSignal) => Promise<string | null>;

export type AssetVerificationOptions = {
    hasher?: BoundedAssetHasher;
    concurrency?: number;
    readBudgetBytes?: number;
    signal?: AbortSignal;
};

/** Reads at most the reserved bytes, even if the open file grows while it is being hashed. */
async function hashBoundedHandle(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string | null> {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
    let offset = 0;
    while (offset < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (bytesRead === 0) {
            return null;
        }
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
    }
    return hash.digest("hex");
}

/** Only canonical SHA-256 content names with an alphanumeric extension can become immutable. */
export function contentNameHash(key: string): string | null {
    return /^assets\/(?:inlay_)?([0-9a-f]{64})\.[A-Za-z0-9]+$/.exec(key)?.[1] ?? null;
}

function sameFile(left: AssetStat, right: AssetStat): boolean {
    return (
        left.size === right.size && left.mtimeNs === right.mtimeNs && left.ino === right.ino && left.dev === right.dev
    );
}

async function hashHandle(handle: FileHandle): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

/** Hashes one regular file through one handle; a file whose stat changes during the read is unknown. */
export async function hashAssetFile(
    fullPath: string,
    hasher: AssetHasher = hashHandle,
): Promise<{ stat: AssetStat; hashHex: string } | null> {
    const handle = await fs.open(fullPath, STORAGE_READ_FLAGS);
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) {
            return null;
        }
        const hashHex = await hasher(handle);
        const after = await handle.stat({ bigint: true });
        return sameFile(before, after) ? { stat: after, hashHex } : null;
    } finally {
        await handle.close();
    }
}

/** Bounded verification results and a single background reader, shared by writers and the asset route. */
export class AssetVerification {
    private readonly entries = new Map<string, Verification>();
    private readonly pending = new Map<string, { expectedHex: string; generation: number }>();
    private readonly awaited = new Map<string, { generation: number; users: number }>();
    private readonly hasher: AssetHasher;
    private readonly maxPending: number;
    private readonly maxEntries: number;
    private running: Promise<void> | null = null;

    constructor(options: { hasher?: AssetHasher; maxPending?: number; maxEntries?: number } = {}) {
        this.hasher = options.hasher ?? hashHandle;
        this.maxPending = options.maxPending ?? 256;
        this.maxEntries = options.maxEntries ?? 65536;
    }

    lookupVerification(fullPath: string, stat: AssetStat): "verified" | "mismatch" | "unknown" {
        const entry = this.entries.get(path.resolve(fullPath));
        return entry && sameFile(entry, stat) ? (entry.ok ? "verified" : "mismatch") : "unknown";
    }

    recordVerification(fullPath: string, stat: AssetStat, ok: boolean): void {
        const file = path.resolve(fullPath);
        this.bumpGeneration(file);
        this.entries.delete(file);
        this.entries.set(file, { size: stat.size, mtimeNs: stat.mtimeNs, ino: stat.ino, dev: stat.dev, ok });
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value!);
        }
    }

    forgetVerification(fullPath: string): void {
        const file = path.resolve(fullPath);
        this.bumpGeneration(file);
        this.entries.delete(file);
    }

    private bumpGeneration(file: string): void {
        // Keep counters only while an asynchronous result can still be used.
        const pending = this.pending.get(file);
        if (pending) {
            pending.generation += 1;
        }
        const awaited = this.awaited.get(file);
        if (awaited) {
            awaited.generation += 1;
        }
    }

    /** Fresh-stat verification, reserving unknown files' read budgets in input order. */
    async verifyFiles(
        files: readonly { fullPath: string; expectedHex: string }[],
        options: AssetVerificationOptions = {},
    ): Promise<Set<string>> {
        const { concurrency = 4, readBudgetBytes = 256 * 1024 * 1024, hasher = hashBoundedHandle, signal } = options;
        if (
            !Number.isSafeInteger(concurrency) ||
            concurrency < 1 ||
            !Number.isSafeInteger(readBudgetBytes) ||
            readBudgetBytes < 0
        ) {
            throw new TypeError("Invalid asset verification limits");
        }
        let remaining = BigInt(readBudgetBytes);
        const active = new Set<Promise<void>>();
        const results = new Map<
            string,
            { tracker: { generation: number; users: number }; verifiedGeneration?: number }
        >();
        try {
            for (const { fullPath, expectedHex } of files) {
                signal?.throwIfAborted();
                if (active.size >= concurrency) {
                    await Promise.race(active);
                    signal?.throwIfAborted();
                }
                const file = path.resolve(fullPath);
                if (results.has(file)) {
                    continue;
                }
                const tracker = this.awaited.get(file) ?? { generation: 0, users: 0 };
                tracker.users += 1;
                this.awaited.set(file, tracker);
                const result: { tracker: typeof tracker; verifiedGeneration?: number } = { tracker };
                results.set(file, result);
                const generation = tracker.generation;
                let handle: FileHandle | null = null;
                try {
                    handle = await fs.open(file, STORAGE_READ_FLAGS);
                    const stat = await handle.stat({ bigint: true });
                    if (!stat.isFile() || stat.size === 0n || generation !== tracker.generation) {
                        continue;
                    }
                    const known = this.lookupVerification(file, stat);
                    if (known === "mismatch") {
                        continue;
                    }
                    if (known === "verified") {
                        const current = await fs.lstat(file, { bigint: true });
                        if (current.isFile() && sameFile(stat, current) && generation === tracker.generation) {
                            result.verifiedGeneration = generation;
                        }
                        continue;
                    }
                    if (stat.size > remaining) {
                        continue;
                    }
                    remaining -= stat.size;
                    signal?.throwIfAborted();
                    const opened = handle;
                    handle = null;
                    const task = (async () => {
                        try {
                            const hashHex = await hasher(opened, Number(stat.size), signal);
                            const after = await opened.stat({ bigint: true });
                            const current = await fs.lstat(file, { bigint: true });
                            if (
                                hashHex === null ||
                                !sameFile(stat, after) ||
                                !current.isFile() ||
                                !sameFile(stat, current) ||
                                generation !== tracker.generation ||
                                signal?.aborted
                            ) {
                                return;
                            }
                            const ok = hashHex === expectedHex;
                            this.recordVerification(file, stat, ok);
                            if (ok) {
                                result.verifiedGeneration = tracker.generation;
                            }
                        } catch {
                            // An unreadable or changing file is missing; its upload can repair it.
                        } finally {
                            await opened.close().catch(() => {});
                        }
                    })();
                    active.add(task);
                    void task.then(() => active.delete(task));
                } catch {
                    // Missing or unopenable files are missing, including symlinks.
                } finally {
                    await handle?.close().catch(() => {});
                }
            }
        } finally {
            await Promise.all(active);
            for (const [file, { tracker }] of results) {
                if (--tracker.users === 0) {
                    this.awaited.delete(file);
                }
            }
        }
        signal?.throwIfAborted();
        return new Set(
            [...results]
                .filter(([, result]) => result.verifiedGeneration === result.tracker.generation)
                .map(([file]) => file),
        );
    }

    /** False means the queue is full; the next request can try again. Accepted paths are deduplicated. */
    request(fullPath: string, expectedHex: string): boolean {
        const file = path.resolve(fullPath);
        if (this.pending.has(file)) {
            return true;
        }
        if (this.pending.size >= this.maxPending) {
            return false;
        }
        this.pending.set(file, { expectedHex, generation: 0 });
        if (!this.running) {
            this.running = this.drain();
        }
        return true;
    }

    /** Waits for accepted work without a timer, including work added while the reader is running. */
    async idle(): Promise<void> {
        while (this.running) {
            await this.running;
        }
    }

    private async drain(): Promise<void> {
        for (const [file, pending] of this.pending) {
            const generation = pending.generation;
            try {
                const result = await hashAssetFile(file, this.hasher);
                if (result && generation === pending.generation) {
                    this.recordVerification(file, result.stat, result.hashHex === pending.expectedHex);
                }
            } catch {
                // Missing or unreadable files stay unknown; later requests may retry them.
            } finally {
                this.pending.delete(file);
            }
        }
        this.running = null;
    }
}

/** Absolute paths isolate save directories even when several server contexts share the process. */
export const assetVerification = new AssetVerification();
