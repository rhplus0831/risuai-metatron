import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import type { ResourceKind, ResourceKindRegistry } from "./kinds.ts";

/** Version of the table layout below, kept in `PRAGMA user_version`. */
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;
/** Deepest array/object nesting a stored value may have. */
const MAX_JSON_DEPTH = 256;

const resourceIdRegex = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const integerPattern = "(0|[1-9][0-9]*)";
const revisionTokenRegex = new RegExp(`^(${uuidPattern}):${integerPattern}:${integerPattern}$`);

/** A write named a revision that is not the current one, or the record it addressed is gone. */
export class ResourceConflictError extends Error {
    /** The current revision token, or null when the record does not exist. */
    readonly current: string | null;
    constructor(current: string | null) {
        super("Revision conflict");
        this.name = "ResourceConflictError";
        this.current = current;
    }
}

/**
 * A write the store refuses: an invalid id, a normalizer rejection, or normalized data `serialize`
 * refuses (a non-finite number, a value `JSON.stringify` cannot serialize, or nesting deeper than
 * `MAX_JSON_DEPTH`).
 */
export class ResourceValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ResourceValidationError";
    }
}

export type StoredResource<T> = { id: string; revision: string; data: T };

export type ResourceStore = ReturnType<typeof createResourceStore>;

/**
 * A synchronous transaction body. A body whose return type can be a promise does not type-check.
 * This is best-effort and the runtime check in `transaction` is the guarantee: a body returning
 * `any` passes, an async function typed `() => void` gets through, and an overloaded function
 * reference is judged by its last overload (wrap it in a zero-argument arrow).
 */
export type TransactionBody<F extends () => unknown> = F &
    (0 extends 1 & ReturnType<F>
        ? unknown
        : [Extract<ReturnType<F>, PromiseLike<unknown>>] extends [never]
          ? unknown
          : never);

export function isValidResourceId(id: string): boolean {
    return resourceIdRegex.test(id);
}

/**
 * Typed resource documents in one `node:sqlite` database. Every record carries an opaque revision
 * token `<epoch>:<seq>:<revision>`: the epoch is random per database (a restore replaces it), `seq`
 * is the record's incarnation (a deleted and recreated record gets a new one), and `revision` counts
 * writes. A write must name the current token and fails with `ResourceConflictError` otherwise.
 *
 * All methods are synchronous; one server process owns the file. Every method takes a kind object
 * from `kinds` and rejects any other, so a write always runs that kind's normalizer. Kinds that need
 * rows of their own (chat messages) get their own tables behind this interface later.
 */
export function createResourceStore(options: { file: string; kinds: ResourceKindRegistry }) {
    const { kinds } = options;
    if (options.file !== ":memory:") {
        mkdirSync(path.dirname(options.file), { recursive: true });
    }
    const db = new DatabaseSync(options.file);
    let epoch: string;
    try {
        epoch = initialize(db);
    } catch (error) {
        db.close();
        throw error;
    }

    const selectOne = db.prepare("SELECT seq, revision, data FROM resources WHERE kind = ? AND id = ?");
    const selectKind = db.prepare("SELECT id, seq, revision, data FROM resources WHERE kind = ? ORDER BY seq");
    const insert = db.prepare(
        "INSERT INTO resources (kind, id, revision, schemaVersion, data) VALUES (?, ?, 1, ?, ?) " +
            "ON CONFLICT (kind, id) DO NOTHING",
    );
    const update = db.prepare(
        "UPDATE resources SET revision = revision + 1, schemaVersion = ?, data = ? " +
            "WHERE kind = ? AND id = ? AND seq = ? AND revision = ?",
    );
    const remove = db.prepare("DELETE FROM resources WHERE kind = ? AND id = ? AND seq = ? AND revision = ?");

    let closed = false;
    /** Set while `transaction` runs; the first conflict inside it makes the whole unit roll back. */
    let transactionState: { conflict: ResourceConflictError | null } | null = null;
    /**
     * Follows the asynchronous work a transaction body starts. Once the body returns, that work can
     * no longer write, so a body that awaited cannot autocommit writes after the rollback.
     */
    const transactionScope = new AsyncLocalStorage<{ ended: boolean }>();

    const token = (seq: number, revision: number) => `${epoch}:${seq}:${revision}`;

    function parseToken(value: string): { seq: number; revision: number } | null {
        const match = revisionTokenRegex.exec(value);
        if (!match || match[1] !== epoch) {
            return null;
        }
        const seq = Number(match[2]);
        const revision = Number(match[3]);
        return Number.isSafeInteger(seq) && Number.isSafeInteger(revision) ? { seq, revision } : null;
    }

    function assertOpen() {
        if (closed) {
            throw new Error("Resource store is closed");
        }
    }

    function assertWritable() {
        assertOpen();
        if (transactionScope.getStore()?.ended) {
            throw new Error("Resource transaction already ended");
        }
    }

    function assertKind(kind: ResourceKind) {
        if (kinds.get(kind.name) !== kind) {
            throw new Error(`Unregistered resource kind: ${kind.name}`);
        }
    }

    function assertId(id: string) {
        if (!isValidResourceId(id)) {
            throw new ResourceValidationError("Invalid resource id");
        }
    }

    function currentToken(kind: ResourceKind, id: string): string | null {
        const row = selectOne.get(kind.name, id) as { seq: number; revision: number } | undefined;
        return row ? token(row.seq, row.revision) : null;
    }

    function conflict(kind: ResourceKind, id: string): never {
        const error = new ResourceConflictError(currentToken(kind, id));
        if (transactionState && !transactionState.conflict) {
            transactionState.conflict = error;
        }
        throw error;
    }

    return {
        get<T>(kind: ResourceKind<T>, id: string): { revision: string; data: T } | null {
            assertOpen();
            assertKind(kind);
            assertId(id);
            const row = selectOne.get(kind.name, id) as { seq: number; revision: number; data: string } | undefined;
            return row ? { revision: token(row.seq, row.revision), data: JSON.parse(row.data) as T } : null;
        },

        /** Records of one kind in creation order. The order is not a client-facing sort contract. */
        list<T>(kind: ResourceKind<T>): StoredResource<T>[] {
            assertOpen();
            assertKind(kind);
            const rows = selectKind.all(kind.name) as { id: string; seq: number; revision: number; data: string }[];
            return rows.map((row) => ({
                id: row.id,
                revision: token(row.seq, row.revision),
                data: JSON.parse(row.data) as T,
            }));
        },

        /**
         * Normalizes `input` with the kind's normalizer and stores it. `baseRevision` null creates the
         * record and conflicts if it exists; a token updates it and conflicts unless it is current.
         * Returns the new token and the data as stored.
         */
        put<T>(kind: ResourceKind<T>, id: string, input: unknown, baseRevision: string | null) {
            assertWritable();
            assertKind(kind);
            assertId(id);
            const { text, stored } = serialize(kind.normalize(input));
            let seq: number;
            let revision: number;
            if (baseRevision === null) {
                const result = insert.run(kind.name, id, kind.schemaVersion, text);
                if (result.changes === 0) {
                    conflict(kind, id);
                }
                seq = Number(result.lastInsertRowid);
                revision = 1;
            } else {
                const base = parseToken(baseRevision);
                if (
                    !base ||
                    update.run(kind.schemaVersion, text, kind.name, id, base.seq, base.revision).changes === 0
                ) {
                    conflict(kind, id);
                }
                seq = base.seq;
                revision = base.revision + 1;
            }
            return { revision: token(seq, revision), data: stored as T };
        },

        /** Deletes the record if `baseRevision` is current; a missing record is a conflict. */
        delete(kind: ResourceKind, id: string, baseRevision: string): void {
            assertWritable();
            assertKind(kind);
            assertId(id);
            const base = parseToken(baseRevision);
            if (!base || remove.run(kind.name, id, base.seq, base.revision).changes === 0) {
                conflict(kind, id);
            }
        },

        /**
         * Runs `fn` in one `BEGIN IMMEDIATE` transaction and commits when it returns. A throw, or any
         * conflict inside it (even one `fn` caught), rolls back every write. `fn` must be synchronous:
         * the transaction is never held across an await, and a returned promise or thenable rolls back
         * and throws. Once `fn` returns, a store write from work it started through awaits, promise
         * continuations, or timers throws, so that work cannot autocommit after a rollback. Callbacks
         * `fn` registers on an event emitter do not carry that scope and are not covered.
         */
        transaction<F extends () => unknown>(fn: TransactionBody<F>): ReturnType<F> {
            assertWritable();
            if (transactionState) {
                throw new Error("Nested resource transactions are not supported");
            }
            db.exec("BEGIN IMMEDIATE");
            const state: { conflict: ResourceConflictError | null } = { conflict: null };
            transactionState = state;
            const scope = { ended: false };
            let committed = false;
            try {
                // The thenable check runs inside the scope too, so continuations a custom `then`
                // schedules are covered.
                const result = transactionScope.run(scope, () => {
                    const value = fn();
                    if (isThenable(value)) {
                        try {
                            value.then(undefined, () => {});
                        } catch {
                            // The body already failed the synchronous contract; report that instead.
                        }
                        throw new Error("Resource transactions must be synchronous");
                    }
                    return value;
                }) as ReturnType<F>;
                if (state.conflict) {
                    throw state.conflict;
                }
                db.exec("COMMIT");
                committed = true;
                return result;
            } finally {
                scope.ended = true;
                transactionState = null;
                if (!committed && db.isTransaction) {
                    db.exec("ROLLBACK");
                }
            }
        },

        close() {
            if (closed) {
                return;
            }
            closed = true;
            db.close();
        },
    };
}

/**
 * Serializes normalized data the way it is stored: as `JSON.stringify` produces it, so `toJSON`
 * applies, `undefined` fields drop, and Dates become strings. Refuses data whose JSON form would turn
 * a non-finite number into `null`, that `JSON.stringify` cannot serialize (a bigint, a cycle, a
 * throwing getter, runaway nesting), or whose JSON form nests deeper than `MAX_JSON_DEPTH`. Returns
 * the text and the value parsed back from it, which is what a read returns.
 */
function serialize(value: unknown): { text: string; stored: unknown } {
    let text: string | undefined;
    try {
        text = JSON.stringify(value, rejectNonFiniteNumber);
    } catch (error) {
        if (error instanceof ResourceValidationError) {
            throw error;
        }
        throw new ResourceValidationError("Resource data is not serializable as JSON");
    }
    if (typeof text !== "string") {
        throw new ResourceValidationError("Resource data is not JSON");
    }
    const stored: unknown = JSON.parse(text);
    assertStoredJson(stored, 0);
    return { text, stored };
}

/**
 * `JSON.stringify` replacer; it sees each value after `toJSON`. A `Number` object is converted once,
 * as `JSON.stringify` would, and its primitive is checked and serialized. Unary plus is that
 * conversion (`ToNumber`): a conversion hook returning a bigint throws, where `Number()` would round.
 */
function rejectNonFiniteNumber(_key: string, value: unknown): unknown {
    const primitive = types.isNumberObject(value) ? +(value as number) : value;
    if (typeof primitive === "number" && !Number.isFinite(primitive)) {
        throw new ResourceValidationError("Resource data contains a non-finite number");
    }
    return primitive;
}

/**
 * Walks the parsed JSON form, which has no hooks or cycles, for its depth and for a non-finite number
 * the replacer could not see (`JSON.rawJSON("1e400")` parses to `Infinity`).
 */
function assertStoredJson(value: unknown, depth: number) {
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new ResourceValidationError("Resource data contains a non-finite number");
    }
    if (typeof value !== "object" || value === null) {
        return;
    }
    if (depth >= MAX_JSON_DEPTH) {
        throw new ResourceValidationError(`Resource data is nested deeper than ${MAX_JSON_DEPTH} levels`);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
        assertStoredJson(child, depth + 1);
    }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

/** Opens the connection settings and creates the schema and epoch on first use. Returns the epoch. */
function initialize(db: DatabaseSync): string {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version === 0) {
        db.exec("BEGIN IMMEDIATE");
        try {
            db.exec(`
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
                CREATE TABLE resources (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    schemaVersion INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    UNIQUE (kind, id)
                ) STRICT;
                PRAGMA user_version = ${SCHEMA_VERSION};
            `);
            db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?)").run(randomUUID());
            db.exec("COMMIT");
        } catch (error) {
            if (db.isTransaction) {
                db.exec("ROLLBACK");
            }
            throw error;
        }
    } else if (version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported resource database version ${version}`);
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string } | undefined;
    if (!row) {
        throw new Error("Resource database has no epoch");
    }
    return row.value;
}
