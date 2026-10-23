import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { STORAGE_READ_FLAGS } from "./recordStream.ts";

type AssetStat = Pick<BigIntStats, "size" | "mtimeNs" | "ino" | "dev">;
type Verification = AssetStat & { ok: boolean };
type AssetHasher = (handle: FileHandle) => Promise<string>;

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
        // Only pending paths need a counter: no asynchronous result outlives its queue entry.
        const pending = this.pending.get(file);
        if (pending) {
            pending.generation += 1;
        }
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
