import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * The server's embedding vectors: what the browser keeps in the `hypaVector` LocalForage store, in a
 * file of its own (`save/data/vectors.sqlite`). It is a cache: every row can be computed again, so
 * it is in no snapshot and no archive, and a read or write failure is a miss or a skipped write,
 * never the caller's error.
 *
 * The cache belongs to one resource database: it stores that database's epoch, and `sync(epoch)`
 * (at startup and when a restore or an import ends) empties it when the epoch is another one. While
 * an emptying has not succeeded, nothing is served and nothing is stored (it is tried again, at most
 * once a second).
 *
 * A row is one vector under the SHA-256 of the client's cache key (the text, the model, and the
 * model's suffix; hashed as UTF-16, so two JavaScript strings never share a row unless they are
 * equal), so a key is bounded whatever the text. Only vectors are stored: no provider body,
 * no header, no setting. A local model's `Float32Array` comes back as one; an API vector (JSON
 * numbers) is stored as float64 and comes back as a `number[]`, so a dot product is the one the
 * provider's numbers give.
 *
 * The size bound is on the vector bytes (`maxBytes`, 256 MiB by default): when a write passes it, the
 * rows used longest ago are removed until 90% of it is left. The file itself (pages, the index, the
 * WAL) is larger than that sum. A vector over `MAX_ENTRY_BYTES` is not stored.
 */
export type CachedVector = number[] | Float32Array;

export type VectorCache = {
    /** The vector under `key` (the client's cache key), or null. */
    get(key: string): CachedVector | null;
    /**
     * Stores `vector` under `key`. `generation` is the value of `generation()` the caller read when
     * its work began: a write of work that outlived a `clear` (a restore, an import) or the `close`
     * is dropped.
     */
    set(key: string, vector: CachedVector, generation: number): void;
    generation(): number;
    /**
     * Binds the cache to the resource database `epoch`: when it holds another epoch's vectors (a
     * restore or an import replaced the data, also while the server was down), they are removed and
     * writes that began before are dropped.
     */
    sync(epoch: string): void;
    /** Removes every row; writes that began before it are dropped. */
    clear(): void;
    close(): void;
    /** The vector bytes stored and the row count. */
    stats(): { bytes: number; rows: number };
};

export const VECTOR_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** A vector larger than this is not stored (a 3072-dimension float64 vector is 24.6 KiB). */
export const MAX_ENTRY_BYTES = 1024 * 1024;
/** A hit moves a row's `used_at` only when it is older than this, so reads rarely write. */
const TOUCH_AFTER_MS = 60 * 1000;
/** A failed emptying is tried again no sooner than this. */
const CLEAR_RETRY_MS = 1000;

const KIND_FLOAT32 = 0;
const KIND_FLOAT64 = 1;

export function vectorCacheKey(key: string): string {
    // UTF-16, not UTF-8: two different lone surrogates must not become the same replacement character.
    return createHash("sha256").update(Buffer.from(key, "utf16le")).digest("hex");
}

export function createVectorCache(options: { file: string; maxBytes?: number; now?: () => number }): VectorCache {
    const maxBytes = options.maxBytes ?? VECTOR_CACHE_MAX_BYTES;
    const now = options.now ?? Date.now;
    let db: DatabaseSync | null = null;
    let statements: {
        get: StatementSync;
        touch: StatementSync;
        bytesOf: StatementSync;
        put: StatementSync;
        oldest: StatementSync;
        remove: StatementSync;
        clear: StatementSync;
        count: StatementSync;
        epoch: StatementSync;
        setEpoch: StatementSync;
    } | null = null;
    let totalBytes = 0;
    let generation = 0;
    let warned = false;
    /** The rows must be removed before anything is served or stored (a clear that has not succeeded yet). */
    let dirty = false;
    let retryAt = 0;
    /** The resource database the cache belongs to (`sync`), once known. */
    let boundEpoch: string | null = null;

    const warn = (error: unknown) => {
        if (!warned) {
            warned = true;
            console.warn(
                "[VectorCache] The vector cache failed; embeddings are computed without it:",
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    try {
        mkdirSync(path.dirname(options.file), { recursive: true });
        db = new DatabaseSync(options.file);
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        db.exec(
            "CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, kind INTEGER NOT NULL, vector BLOB NOT NULL, bytes INTEGER NOT NULL, used_at INTEGER NOT NULL) WITHOUT ROWID",
        );
        db.exec("CREATE INDEX IF NOT EXISTS vectors_used_at ON vectors (used_at)");
        db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
        statements = {
            get: db.prepare("SELECT kind, vector, used_at FROM vectors WHERE key = ?"),
            touch: db.prepare("UPDATE vectors SET used_at = ? WHERE key = ?"),
            bytesOf: db.prepare("SELECT bytes FROM vectors WHERE key = ?"),
            put: db.prepare(
                "INSERT OR REPLACE INTO vectors (key, kind, vector, bytes, used_at) VALUES (?, ?, ?, ?, ?)",
            ),
            oldest: db.prepare("SELECT key, bytes FROM vectors ORDER BY used_at ASC LIMIT 256"),
            remove: db.prepare("DELETE FROM vectors WHERE key = ?"),
            clear: db.prepare("DELETE FROM vectors"),
            count: db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM vectors"),
            epoch: db.prepare("SELECT value FROM meta WHERE key = 'epoch'"),
            setEpoch: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('epoch', ?)"),
        };
        totalBytes = Number((statements.count.get() as { bytes: number }).bytes);
        trim();
    } catch (error) {
        warn(error);
        try {
            db?.close();
        } catch {}
        db = null;
        statements = null;
    }

    /**
     * Whether the cache may be served. A pending emptying is done first (the rows and the stored epoch
     * in one transaction); until it succeeds the cache answers nothing.
     */
    function usable(): boolean {
        if (!db || !statements) {
            return false;
        }
        if (!dirty) {
            return true;
        }
        if (now() < retryAt) {
            return false;
        }
        try {
            db.exec("BEGIN IMMEDIATE");
            try {
                statements.clear.run();
                if (boundEpoch !== null) {
                    statements.setEpoch.run(boundEpoch);
                }
                db.exec("COMMIT");
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
            totalBytes = 0;
            dirty = false;
            return true;
        } catch (error) {
            warn(error);
            retryAt = now() + CLEAR_RETRY_MS;
            return false;
        }
    }

    /** Removes the rows used longest ago until the vector bytes are within 90% of the bound. */
    function trim(): void {
        if (!statements || totalBytes <= maxBytes) {
            return;
        }
        const target = maxBytes * 0.9;
        while (totalBytes > target) {
            const rows = statements.oldest.all() as { key: string; bytes: number }[];
            if (rows.length === 0) {
                totalBytes = 0;
                return;
            }
            for (const row of rows) {
                statements.remove.run(row.key);
                totalBytes -= Number(row.bytes);
                if (totalBytes <= target) {
                    break;
                }
            }
        }
    }

    return {
        get(key) {
            if (!statements || !usable()) {
                return null;
            }
            try {
                const hashed = vectorCacheKey(key);
                const row = statements.get.get(hashed) as
                    { kind: number; vector: Uint8Array; used_at: number } | undefined;
                if (!row) {
                    return null;
                }
                const at = now();
                if (at - Number(row.used_at) > TOUCH_AFTER_MS) {
                    statements.touch.run(at, hashed);
                }
                // A copy of the bytes: the caller's vector shares no buffer with the driver's or another caller's.
                const bytes = row.vector;
                const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
                if (Number(row.kind) === KIND_FLOAT32) {
                    return new Float32Array(buffer);
                }
                return Array.from(new Float64Array(buffer));
            } catch (error) {
                warn(error);
                return null;
            }
        },
        set(key, vector, writeGeneration) {
            if (!statements || writeGeneration !== generation || !usable()) {
                return;
            }
            try {
                const kind = vector instanceof Float32Array ? KIND_FLOAT32 : KIND_FLOAT64;
                const typed = vector instanceof Float32Array ? vector : Float64Array.from(vector);
                // The view's own bytes (a `subarray` shares a larger buffer).
                const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
                if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENTRY_BYTES) {
                    return;
                }
                const hashed = vectorCacheKey(key);
                const previous = statements.bytesOf.get(hashed) as { bytes: number } | undefined;
                statements.put.run(hashed, kind, bytes, bytes.byteLength, now());
                totalBytes += bytes.byteLength - Number(previous?.bytes ?? 0);
                trim();
            } catch (error) {
                warn(error);
            }
        },
        generation: () => generation,
        sync(epoch) {
            boundEpoch = epoch;
            if (!statements) {
                return;
            }
            let stored: unknown;
            try {
                stored = (statements.epoch.get() as { value: unknown } | undefined)?.value;
            } catch (error) {
                warn(error);
            }
            if (stored !== epoch) {
                generation++;
                dirty = true;
                retryAt = 0;
                usable();
            }
        },
        clear() {
            generation++;
            dirty = true;
            retryAt = 0;
            usable();
        },
        close() {
            generation++;
            const open = db;
            db = null;
            statements = null;
            try {
                open?.close();
            } catch {}
        },
        stats() {
            if (!statements || !usable()) {
                return { bytes: 0, rows: 0 };
            }
            const row = statements.count.get() as { rows: number; bytes: number };
            return { bytes: Number(row.bytes), rows: Number(row.rows) };
        },
    };
}
