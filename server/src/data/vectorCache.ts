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
 * The size bound is on the vector bytes (`maxBytes`, 256 MiB by default). A write that would exceed
 * it starts eviction toward 90%: each set removes at most 256 rows used longest ago in the same
 * transaction as its insert, continuing on later sets until the target is reached. An insert that
 * still cannot fit is skipped. Startup trims to 90% in bounded transactions before serving. The file
 * itself (pages, the index, the WAL) is larger than that sum. A vector over `MAX_ENTRY_BYTES` is not stored.
 *
 * The server opens one cache (`server/src/app.ts`), so every client and every job shares its rows.
 * Nothing reads a browser's `hypaVector` store: the vectors a tab computed are not migrated, and the
 * server computes its own on first use.
 */

/** A stored vector: a local model's `Float32Array` or an API's numbers. */
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
/** The maximum number of rows evicted in one write transaction. */
const TRIM_ROWS_PER_SET = 256;

const KIND_FLOAT32 = 0;
const KIND_FLOAT64 = 1;

/** A row's key: the SHA-256 of the client's cache key, read as UTF-16. */
export function vectorCacheKey(key: string): string {
    // UTF-16, not UTF-8: two different lone surrogates must not become the same replacement character.
    return createHash("sha256").update(Buffer.from(key, "utf16le")).digest("hex");
}

/**
 * Opens the cache in `options.file` (WAL mode). A file that cannot be opened leaves a cache that
 * serves and stores nothing, and the embeddings work without it; the first failure of any kind logs
 * one warning. `trimRowsPerSet` and `now` are for tests.
 */
export function createVectorCache(options: {
    file: string;
    maxBytes?: number;
    now?: () => number;
    trimRowsPerSet?: number;
}): VectorCache {
    const maxBytes = options.maxBytes ?? VECTOR_CACHE_MAX_BYTES;
    const trimRowsPerSet =
        Number.isSafeInteger(options.trimRowsPerSet) && options.trimRowsPerSet! > 0
            ? options.trimRowsPerSet!
            : TRIM_ROWS_PER_SET;
    const trimTarget = maxBytes * 0.9;
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
    let trimming = false;
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
            oldest: db.prepare("SELECT key, bytes FROM vectors ORDER BY used_at ASC LIMIT ?"),
            remove: db.prepare("DELETE FROM vectors WHERE key = ?"),
            clear: db.prepare("DELETE FROM vectors"),
            count: db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM vectors"),
            epoch: db.prepare("SELECT value FROM meta WHERE key = 'epoch'"),
            setEpoch: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('epoch', ?)"),
        };
        totalBytes = Number((statements.count.get() as { bytes: number }).bytes);
        trimAtStartup();
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
            trimming = false;
            dirty = false;
            return true;
        } catch (error) {
            warn(error);
            retryAt = now() + CLEAR_RETRY_MS;
            return false;
        }
    }

    /** Before serving, a lowered bound is reached in transactions of at most the row budget each. */
    function trimAtStartup(): void {
        if (!db || !statements || totalBytes <= maxBytes) {
            return;
        }
        while (totalBytes > trimTarget) {
            let nextBytes = totalBytes;
            let deletedRows = 0;
            db.exec("BEGIN IMMEDIATE");
            try {
                const rows = statements.oldest.all(trimRowsPerSet) as { key: string; bytes: number }[];
                if (rows.length === 0) {
                    nextBytes = 0;
                }
                for (const row of rows) {
                    const { changes } = statements.remove.run(row.key);
                    if (Number(changes) > 0) {
                        deletedRows++;
                        nextBytes -= Number(row.bytes);
                    }
                    if (nextBytes <= trimTarget) {
                        break;
                    }
                }
                db.exec("COMMIT");
            } catch (error) {
                try {
                    db.exec("ROLLBACK");
                } catch {}
                throw error;
            }
            totalBytes = nextBytes;
            if (deletedRows === 0) {
                return;
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
            if (!db || !statements || writeGeneration !== generation) {
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
                if (!usable()) {
                    return;
                }
                const hashed = vectorCacheKey(key);
                let nextBytes = totalBytes;
                let nextTrimming = trimming;
                db.exec("BEGIN IMMEDIATE");
                try {
                    const previous = statements.bytesOf.get(hashed) as { bytes: number } | undefined;
                    let projectedBytes = nextBytes + bytes.byteLength - Number(previous?.bytes ?? 0);
                    nextTrimming ||= projectedBytes > maxBytes;
                    if (nextTrimming && projectedBytes > trimTarget) {
                        const rows = statements.oldest.all(trimRowsPerSet) as { key: string; bytes: number }[];
                        if (rows.length === 0) {
                            nextBytes = 0;
                        }
                        for (const row of rows) {
                            statements.remove.run(row.key);
                            nextBytes -= Number(row.bytes);
                            // Replacing an evicted row no longer subtracts its old bytes from the insert.
                            if (row.key !== hashed) {
                                projectedBytes -= Number(row.bytes);
                            }
                            if (projectedBytes <= trimTarget) {
                                break;
                            }
                        }
                    }
                    const replaced = statements.bytesOf.get(hashed) as { bytes: number } | undefined;
                    const insertedBytes = nextBytes + bytes.byteLength - Number(replaced?.bytes ?? 0);
                    if (insertedBytes <= maxBytes) {
                        statements.put.run(hashed, kind, bytes, bytes.byteLength, now());
                        nextBytes = insertedBytes;
                    }
                    db.exec("COMMIT");
                } catch (error) {
                    try {
                        db.exec("ROLLBACK");
                    } catch {}
                    throw error;
                }
                totalBytes = nextBytes;
                trimming = nextTrimming && totalBytes > trimTarget;
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
