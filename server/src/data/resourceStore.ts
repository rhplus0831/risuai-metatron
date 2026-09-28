import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import type { ResourceKind, ResourceKindRegistry } from "./kinds.ts";

/** Version of the table layout below, kept in `PRAGMA user_version`. */
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;
/** Deepest array/object nesting a stored value may have. */
const MAX_JSON_DEPTH = 256;

const MAX_RESOURCE_ID_LENGTH = 512;
const controlCharacterRegex = /[\u0000-\u001f\u007f]/;
const loneSurrogateRegex = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
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

/** A batch named revisions that are not current; nothing in it was applied. */
export class ResourceBatchConflictError extends Error {
    readonly conflicts: { kind: string; id: string; revision: string | null }[];
    constructor(conflicts: { kind: string; id: string; revision: string | null }[]) {
        super("Revision conflict");
        this.name = "ResourceBatchConflictError";
        this.conflicts = conflicts;
    }
}

/** A mutation named another database epoch (or none): a restore replaced the data it was based on. */
export class ResourceEpochError extends Error {
    readonly epoch: string;
    constructor(epoch: string) {
        super("EpochMismatch");
        this.name = "ResourceEpochError";
        this.epoch = epoch;
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

/** One operation of `applyBatch`: a write (`data`) or, with `delete: true`, a deletion. */
export type ResourceBatchOperation = {
    kind: ResourceKind;
    id: string;
    baseRevision: string | null;
    data?: unknown;
    delete?: boolean;
};

/** Rows of a snapshot file that passed every check of `readSnapshot`, ready for `replaceAll`. */
export type ValidatedSnapshot = {
    readonly rows: readonly { kind: string; id: string; revision: number; schemaVersion: number; text: string }[];
};

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

/**
 * A resource id is 1 to 512 UTF-16 code units of well-formed Unicode with no control character, and
 * not `.` or `..` (URL parsers resolve those away). Clients put it in the path through
 * `encodeURIComponent`, so `/`, `%`, and non-ASCII characters are allowed.
 */
export function isValidResourceId(id: unknown): id is string {
    return (
        typeof id === "string" &&
        id.length >= 1 &&
        id.length <= MAX_RESOURCE_ID_LENGTH &&
        id !== "." &&
        id !== ".." &&
        !controlCharacterRegex.test(id) &&
        !loneSurrogateRegex.test(id)
    );
}

/**
 * Typed resource documents in one `node:sqlite` database. Every record carries an opaque revision
 * token `<epoch>:<seq>:<revision>`: the epoch is random per database (a restore replaces it), `seq`
 * is the record's incarnation (a deleted and recreated record gets a new one), and `revision` counts
 * writes. A write must name the current token and fails with `ResourceConflictError` otherwise.
 *
 * All methods except `backupTo` are synchronous; one server process owns the file. Every method takes
 * a kind object from `kinds` and rejects any other, so a write always runs that kind's normalizer.
 * Kinds that need rows of their own (chat messages) get their own tables behind this interface later.
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
    const insertRestored = db.prepare(
        "INSERT INTO resources (kind, id, revision, schemaVersion, data) VALUES (?, ?, ?, ?, ?)",
    );
    const setEpoch = db.prepare("UPDATE meta SET value = ? WHERE key = 'epoch'");

    let closed = false;
    /** Committed writes since the store opened; the snapshot scheduler compares it. */
    let writeCount = 0;
    /** Set while `transaction` runs; the first conflict inside it makes the whole unit roll back. */
    let transactionState: { conflict: ResourceConflictError | null; writes: number } | null = null;
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

    function assertNotInTransaction() {
        if (transactionState) {
            throw new Error("Nested resource transactions are not supported");
        }
    }

    function assertKind(kind: ResourceKind) {
        if (kinds.get(kind.name) !== kind) {
            throw new Error(`Unregistered resource kind: ${kind.name}`);
        }
    }

    function assertId(kind: ResourceKind, id: string) {
        if (!isValidResourceId(id)) {
            throw new ResourceValidationError("Invalid resource id");
        }
        if (kind.singleton && id !== SINGLETON_RESOURCE_ID) {
            throw new ResourceValidationError(`${kind.name} has only the record ${SINGLETON_RESOURCE_ID}`);
        }
    }

    function assertDeletable(kind: ResourceKind) {
        if (kind.singleton) {
            throw new ResourceValidationError(`${kind.name} cannot be deleted`);
        }
    }

    function countWrite() {
        if (transactionState) {
            transactionState.writes += 1;
        } else {
            writeCount += 1;
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

    function readOne(kind: ResourceKind, id: string) {
        const row = selectOne.get(kind.name, id) as { seq: number; revision: number; data: string } | undefined;
        return row ? { revision: token(row.seq, row.revision), data: JSON.parse(row.data) as unknown } : null;
    }

    function readKind(kind: ResourceKind): StoredResource<unknown>[] {
        const rows = selectKind.all(kind.name) as { id: string; seq: number; revision: number; data: string }[];
        return rows.map((row) => ({ id: row.id, revision: token(row.seq, row.revision), data: JSON.parse(row.data) }));
    }

    return {
        /** The current database epoch. A restore replaces it. */
        epoch(): string {
            return epoch;
        },

        /** Committed writes since the store opened. */
        writeCount(): number {
            return writeCount;
        },

        /**
         * Throws `ResourceEpochError` unless `expected` is the current epoch. Call it in the same
         * synchronous block as the write it guards, with no await in between.
         */
        assertEpoch(expected: string | undefined): void {
            if (expected !== epoch) {
                throw new ResourceEpochError(epoch);
            }
        },

        get<T>(kind: ResourceKind<T>, id: string): { revision: string; data: T } | null {
            assertOpen();
            assertKind(kind);
            assertId(kind, id);
            return readOne(kind, id) as { revision: string; data: T } | null;
        },

        /**
         * Records of one kind in creation order (`seq`). The client keeps `characters` in this order,
         * which is the order the old save file kept them in.
         */
        list<T>(kind: ResourceKind<T>): StoredResource<T>[] {
            assertOpen();
            assertKind(kind);
            return readKind(kind) as StoredResource<T>[];
        },

        /** Every record of several kinds, read in one synchronous call, so one committed state. */
        readKinds(kindList: readonly ResourceKind[]): {
            epoch: string;
            kinds: Record<string, StoredResource<unknown>[]>;
        } {
            assertOpen();
            const result: Record<string, StoredResource<unknown>[]> = Object.create(null);
            for (const kind of kindList) {
                assertKind(kind);
                result[kind.name] = readKind(kind);
            }
            return { epoch, kinds: result };
        },

        /** Named records, read in one synchronous call; a missing one has revision and data null. */
        readRefs(refs: readonly { kind: ResourceKind; id: string }[]) {
            assertOpen();
            const items = refs.map(({ kind, id }) => {
                assertKind(kind);
                assertId(kind, id);
                const row = readOne(kind, id);
                return { kind: kind.name, id, revision: row?.revision ?? null, data: row?.data ?? null };
            });
            return { epoch, items };
        },

        /**
         * Normalizes `input` with the kind's normalizer and stores it. `baseRevision` null creates the
         * record and conflicts if it exists; a token updates it and conflicts unless it is current.
         * Returns the new token and the data as stored.
         */
        put<T>(kind: ResourceKind<T>, id: string, input: unknown, baseRevision: string | null) {
            assertWritable();
            assertKind(kind);
            assertId(kind, id);
            const { text, stored } = serialize(kind.normalize(input, { id }));
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
            countWrite();
            return { revision: token(seq, revision), data: stored as T };
        },

        /** Deletes the record if `baseRevision` is current; a missing record is a conflict. */
        delete(kind: ResourceKind, id: string, baseRevision: string): void {
            assertWritable();
            assertKind(kind);
            assertId(kind, id);
            assertDeletable(kind);
            const base = parseToken(baseRevision);
            if (!base || remove.run(kind.name, id, base.seq, base.revision).changes === 0) {
                conflict(kind, id);
            }
            countWrite();
        },

        /**
         * Applies several writes and deletions as one unit. Every operation is validated and
         * normalized first (a `ResourceValidationError` names the failing index); then, in one
         * transaction, every base revision is compared, and if any is stale nothing is written and
         * `ResourceBatchConflictError` lists all of them. Returns the new tokens in operation order
         * (null for a deletion).
         */
        applyBatch(
            operations: readonly ResourceBatchOperation[],
        ): { kind: string; id: string; revision: string | null }[] {
            assertWritable();
            assertNotInTransaction();
            const seen = new Set<string>();
            const prepared = operations.map((operation, index) => {
                try {
                    const { kind, id } = operation;
                    assertKind(kind);
                    assertId(kind, id);
                    const key = `${kind.name}\u0000${id}`;
                    if (seen.has(key)) {
                        throw new ResourceValidationError("duplicate kind and id");
                    }
                    seen.add(key);
                    if (operation.delete) {
                        assertDeletable(kind);
                        if (typeof operation.baseRevision !== "string") {
                            throw new ResourceValidationError("a deletion needs a base revision");
                        }
                        return { operation, text: null };
                    }
                    return { operation, text: serialize(kind.normalize(operation.data, { id })).text };
                } catch (error) {
                    if (error instanceof ResourceValidationError) {
                        throw new ResourceValidationError(`ops[${index}]: ${error.message}`);
                    }
                    throw error;
                }
            });

            db.exec("BEGIN IMMEDIATE");
            let committed = false;
            try {
                const conflicts: { kind: string; id: string; revision: string | null }[] = [];
                const bases = prepared.map(({ operation: { kind, id, baseRevision } }) => {
                    const row = selectOne.get(kind.name, id) as { seq: number; revision: number } | undefined;
                    const base = baseRevision === null ? null : parseToken(baseRevision);
                    const current =
                        baseRevision === null
                            ? row === undefined
                            : !!row && !!base && base.seq === row.seq && base.revision === row.revision;
                    if (!current) {
                        conflicts.push({ kind: kind.name, id, revision: row ? token(row.seq, row.revision) : null });
                    }
                    return base;
                });
                if (conflicts.length > 0) {
                    throw new ResourceBatchConflictError(conflicts);
                }
                const results = prepared.map(({ operation: { kind, id }, text }, index) => {
                    const base = bases[index];
                    if (text === null) {
                        remove.run(kind.name, id, base!.seq, base!.revision);
                        return { kind: kind.name, id, revision: null };
                    }
                    if (base === null) {
                        const result = insert.run(kind.name, id, kind.schemaVersion, text);
                        return { kind: kind.name, id, revision: token(Number(result.lastInsertRowid), 1) };
                    }
                    update.run(kind.schemaVersion, text, kind.name, id, base.seq, base.revision);
                    return { kind: kind.name, id, revision: token(base.seq, base.revision + 1) };
                });
                db.exec("COMMIT");
                committed = true;
                writeCount += prepared.length;
                return results;
            } finally {
                if (!committed && db.isTransaction) {
                    db.exec("ROLLBACK");
                }
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
            assertNotInTransaction();
            db.exec("BEGIN IMMEDIATE");
            const state: { conflict: ResourceConflictError | null; writes: number } = { conflict: null, writes: 0 };
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
                writeCount += state.writes;
                return result;
            } finally {
                scope.ended = true;
                transactionState = null;
                if (!committed && db.isTransaction) {
                    db.exec("ROLLBACK");
                }
            }
        },

        /**
         * Copies the live database to `file` with SQLite's online backup, outside any transaction.
         * Writes made while it runs may or may not be included. The copy is left in rollback-journal
         * mode, so it is one self-contained file.
         */
        async backupTo(file: string): Promise<void> {
            assertOpen();
            await backup(db, file);
            const copy = new DatabaseSync(file);
            try {
                copy.exec("PRAGMA journal_mode = DELETE");
            } finally {
                copy.close();
            }
        },

        /**
         * Reads and checks a snapshot file (read-only; nothing in it is executed beyond reading):
         * `integrity_check`, the schema version, the layout (`resources` and `meta` are real tables
         * with this store's columns, and `meta` holds an epoch), and every row (a registered kind at
         * its current schema version, a valid id, singleton rules, unique kind and id, positive
         * safe-integer `seq` and revision, and data the kind's normalizer and `serialize` accept).
         * Throws `ResourceValidationError` for anything else.
         */
        readSnapshot(file: string): ValidatedSnapshot {
            let source: DatabaseSync;
            try {
                source = new DatabaseSync(file, { readOnly: true });
            } catch {
                throw new ResourceValidationError("Not a resource database");
            }
            try {
                let rawRows: Record<string, unknown>[];
                try {
                    const integrity = source.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
                    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
                        throw new ResourceValidationError("The resource database is damaged");
                    }
                    const { user_version: version } = source.prepare("PRAGMA user_version").get() as {
                        user_version: number;
                    };
                    if (version !== SCHEMA_VERSION) {
                        throw new ResourceValidationError(`Unsupported resource database version ${version}`);
                    }
                    assertSnapshotLayout(source);
                    rawRows = source
                        .prepare("SELECT seq, kind, id, revision, schemaVersion, data FROM resources ORDER BY seq")
                        .all() as Record<string, unknown>[];
                } catch (error) {
                    if (error instanceof ResourceValidationError) {
                        throw error;
                    }
                    throw new ResourceValidationError("Not a resource database");
                }
                const seen = new Set<string>();
                const rows = rawRows.map((row, index) => {
                    const where = `row ${index + 1}`;
                    const kind = typeof row.kind === "string" ? kinds.get(row.kind) : undefined;
                    if (!kind) {
                        throw new ResourceValidationError(`${where}: unknown kind`);
                    }
                    if (!isPositiveSafeInteger(row.seq) || !isPositiveSafeInteger(row.revision)) {
                        throw new ResourceValidationError(`${where}: invalid seq or revision`);
                    }
                    if (row.schemaVersion !== kind.schemaVersion) {
                        throw new ResourceValidationError(`${where}: unsupported schema version`);
                    }
                    if (!isValidResourceId(row.id) || (kind.singleton && row.id !== SINGLETON_RESOURCE_ID)) {
                        throw new ResourceValidationError(`${where}: invalid id`);
                    }
                    const key = `${kind.name}\u0000${row.id}`;
                    if (seen.has(key)) {
                        throw new ResourceValidationError(`${where}: duplicate kind and id`);
                    }
                    seen.add(key);
                    if (typeof row.data !== "string") {
                        throw new ResourceValidationError(`${where}: data is not text`);
                    }
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(row.data);
                    } catch {
                        throw new ResourceValidationError(`${where}: data is not JSON`);
                    }
                    let text: string;
                    try {
                        text = serialize(kind.normalize(parsed, { id: row.id })).text;
                    } catch (error) {
                        if (error instanceof ResourceValidationError) {
                            throw new ResourceValidationError(`${where}: ${error.message}`);
                        }
                        throw error;
                    }
                    return {
                        kind: kind.name,
                        id: row.id,
                        revision: row.revision,
                        schemaVersion: kind.schemaVersion,
                        text,
                    };
                });
                return { rows };
            } finally {
                source.close();
            }
        },

        /**
         * Replaces every record with the rows of a validated snapshot and gives the database a new
         * epoch, in one transaction; every token issued before is stale afterwards. Returns the epoch.
         */
        replaceAll(snapshot: ValidatedSnapshot): string {
            assertWritable();
            assertNotInTransaction();
            const nextEpoch = randomUUID();
            db.exec("BEGIN IMMEDIATE");
            let committed = false;
            try {
                db.exec("DELETE FROM resources");
                for (const row of snapshot.rows) {
                    insertRestored.run(row.kind, row.id, row.revision, row.schemaVersion, row.text);
                }
                setEpoch.run(nextEpoch);
                db.exec("COMMIT");
                committed = true;
            } finally {
                if (!committed && db.isTransaction) {
                    db.exec("ROLLBACK");
                }
            }
            epoch = nextEpoch;
            writeCount += 1;
            return nextEpoch;
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

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Column names of the store's tables, in `PRAGMA table_info` order. */
const SNAPSHOT_TABLE_COLUMNS: Record<string, readonly string[]> = {
    resources: ["seq", "kind", "id", "revision", "schemaVersion", "data"],
    meta: ["key", "value"],
};

/**
 * Requires the layout `initialize` creates: `resources` and `meta` are ordinary tables (a view or a
 * virtual table could answer the row query with anything), with exactly these columns, and `meta`
 * holds an epoch string. Anything else is not a resource database.
 */
function assertSnapshotLayout(source: DatabaseSync) {
    for (const [table, columns] of Object.entries(SNAPSHOT_TABLE_COLUMNS)) {
        const objects = source.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ?").all(table) as {
            type: string;
            sql: string | null;
        }[];
        if (objects.length !== 1 || objects[0].type !== "table" || !/^CREATE TABLE\b/i.test(objects[0].sql ?? "")) {
            throw new ResourceValidationError("Not a resource database");
        }
        const info = source.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (info.length !== columns.length || !info.every((column, index) => column.name === columns[index])) {
            throw new ResourceValidationError("Not a resource database");
        }
    }
    const epoch = source.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: unknown } | undefined;
    if (typeof epoch?.value !== "string") {
        throw new ResourceValidationError("Not a resource database");
    }
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
