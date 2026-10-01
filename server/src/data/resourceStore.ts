import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import type { ChatGroupResult, ChatOrderRecord, ChatOrderResult, ChatRecord } from "../../../shared/chats.ts";
import { type BatchConflict, RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import {
    CHAT_TABLE_COLUMNS,
    CHAT_TABLES_SQL,
    type ChatSnapshotRows,
    countChatOperations,
    createChatTables,
    prepareChatGroups,
    prepareChatOrders,
    readChatSnapshotRows,
} from "./chatStore.ts";
import type { MessageGuard } from "../jobs/generationLock.ts";
import type { ResourceKind, ResourceKindRegistry } from "./kinds.ts";

/**
 * Version of the resource database, kept in `PRAGMA user_version`. Version 2 added the chat tables;
 * version 3 (Phase 3) has the same tables and holds the settings sections and collections instead of
 * a `root` record.
 */
const SCHEMA_VERSION = 3;
const BUSY_TIMEOUT_MS = 5000;
/** Deepest array/object nesting a stored value may have. */
const MAX_JSON_DEPTH = 256;

const MAX_RESOURCE_ID_LENGTH = 512;
const controlCharacterRegex = /[\u0000-\u001f\u007f]/;
const loneSurrogateRegex = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const integerPattern = "(0|[1-9][0-9]*)";
const revisionTokenRegex = new RegExp(`^(${uuidPattern}):${integerPattern}:${integerPattern}$`);

/** Shutdown has closed the database; clients may retry against the next server. */
export class ResourceStoreClosedError extends Error {
    constructor() {
        super("Resource store is closed");
        this.name = "ResourceStoreClosedError";
    }
}

/**
 * A write named a revision that is not the current one, or the record it addressed is gone. With
 * `reason: "generating"`: a character delete refused because a generation job owns one of its
 * messages.
 */
export class ResourceConflictError extends Error {
    /** The current revision token, or null when the record does not exist. */
    readonly current: string | null;
    readonly reason: "generating" | undefined;
    constructor(current: string | null, reason?: "generating") {
        super("Revision conflict");
        this.name = "ResourceConflictError";
        this.current = current;
        this.reason = reason;
    }
}

/** A job write named a job token that is not live: the job has ended. */
export class JobTokenError extends Error {
    constructor() {
        super("The generation job has ended");
        this.name = "JobTokenError";
    }
}

/** A batch named revisions that are not current (resources, chats, or chat orders); nothing in it was applied. */
export class ResourceBatchConflictError extends Error {
    readonly conflicts: BatchConflict[];
    constructor(conflicts: BatchConflict[]) {
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

/**
 * The revision counter after `increment` more writes. Every counter increment (resources, chats,
 * chat orders) goes through here: a counter at `Number.MAX_SAFE_INTEGER` (reachable only through a
 * crafted snapshot, whose counters a restore keeps) would otherwise commit a value SQLite stores but
 * `node:sqlite` cannot read back, making every later read fail. The write is refused instead, with a
 * `ResourceValidationError` that rolls the transaction back.
 */
export function nextRevision(current: number, increment: number): number {
    const next = current + increment;
    if (!Number.isSafeInteger(next)) {
        throw new ResourceValidationError("Revision counter exhausted");
    }
    return next;
}

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
} & ChatSnapshotRows;

/** What `applyChanges` wrote: resource tokens in op order, chat group results, and every changed chat order. */
export type AppliedChanges = {
    results: { kind: string; id: string; revision: string | null }[];
    chats: ChatGroupResult[];
    chatOrders: ChatOrderResult[];
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
 * Opening the store runs the normalization pass (`normalizeStoredRecords`), so every stored record is
 * its kind's normalized form and every `materialize` singleton exists before the first read.
 *
 * All methods except `backupTo` are synchronous; one server process owns the file. Every method takes
 * a kind object from `kinds` and rejects any other, so a write always runs that kind's normalizer.
 * Kinds that need rows of their own (chat messages) get their own tables behind this interface later.
 */
export function createResourceStore(options: { file: string; kinds: ResourceKindRegistry; guard?: MessageGuard }) {
    const { kinds, guard } = options;
    if (options.file !== ":memory:") {
        mkdirSync(path.dirname(options.file), { recursive: true });
    }
    const db = new DatabaseSync(options.file);
    let epoch: string;
    try {
        epoch = initialize(db, options.file);
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
    const rewrite = db.prepare("UPDATE resources SET revision = ?, schemaVersion = ?, data = ? WHERE seq = ?");
    const selectKindForPass = db.prepare(
        "SELECT id, seq, revision, schemaVersion, data FROM resources WHERE kind = ? ORDER BY seq",
    );

    /**
     * The normalization pass, inside the caller's transaction: every stored record of every
     * registered kind is normalized again and rewritten, with its revision counter advanced, when
     * the normalized text or the stored schema version differs (a record stored before its kind
     * gained a default, a migration, or a new version); every missing `materialize` singleton is
     * created. A record of a newer schema version than its kind stops the pass. Reads never normalize, so this
     * is how a new default reaches stored data, once, before any client reads it. Returns the
     * number of records written. A stored record its normalizer rejects stops the pass.
     */
    function normalizeStoredRecords(): number {
        let written = 0;
        for (const kind of kinds.values()) {
            const rows = selectKindForPass.all(kind.name) as {
                id: string;
                seq: number;
                revision: number;
                schemaVersion: number;
                data: string;
            }[];
            for (const row of rows) {
                let text: string;
                try {
                    if (row.schemaVersion > kind.schemaVersion) {
                        // Written by a newer server; rewriting it here would downgrade it silently.
                        throw new Error(`schema version ${row.schemaVersion} is newer than ${kind.schemaVersion}`);
                    }
                    text = serialize(normalizeInput(kind, JSON.parse(row.data), row.id)).text;
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    throw new Error(`Stored ${kind.name} record ${row.id} fails its normalizer: ${reason}`, {
                        cause: error,
                    });
                }
                if (text !== row.data || row.schemaVersion !== kind.schemaVersion) {
                    rewrite.run(nextRevision(row.revision, 1), kind.schemaVersion, text, row.seq);
                    written += 1;
                }
            }
            if (kind.materialize && rows.length === 0) {
                const { text } = serialize(normalizeInput(kind, undefined, SINGLETON_RESOURCE_ID));
                insert.run(kind.name, SINGLETON_RESOURCE_ID, kind.schemaVersion, text);
                written += 1;
            }
        }
        return written;
    }

    let closed = false;
    /** Committed writes since the store opened; the snapshot scheduler compares it. */
    let writeCount = 0;
    try {
        db.exec("BEGIN IMMEDIATE");
        writeCount = normalizeStoredRecords();
        db.exec("COMMIT");
    } catch (error) {
        if (db.isTransaction) {
            db.exec("ROLLBACK");
        }
        db.close();
        throw error;
    }
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

    const chatTables = createChatTables(db, { token, parse: parseToken }, guard);
    const isCharacterKind = (kind: ResourceKind) => kind.name === RESOURCE_KIND.characters;

    function assertOpen() {
        if (closed) {
            throw new ResourceStoreClosedError();
        }
    }

    function assertWritable() {
        assertOpen();
        if (transactionScope.getStore()?.ended) {
            throw new Error("Resource transaction already ended");
        }
    }

    /**
     * Runs a multi-statement write (a character with its chat order) as one unit: inside the caller's
     * transaction when there is one, otherwise in its own.
     */
    function atomically<T>(fn: () => T): T {
        if (db.isTransaction) {
            return fn();
        }
        db.exec("BEGIN IMMEDIATE");
        let committed = false;
        try {
            const result = fn();
            db.exec("COMMIT");
            committed = true;
            return result;
        } finally {
            if (!committed && db.isTransaction) {
                db.exec("ROLLBACK");
            }
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

    function conflict(kind: ResourceKind, id: string, reason?: "generating"): never {
        const error = new ResourceConflictError(currentToken(kind, id), reason);
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

    const store = {
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

        /**
         * Every record of several kinds, read in one synchronous call, so one committed state. With
         * `chats`, also every chat (metadata plus messages in order) and every chat order.
         */
        readKinds(
            kindList: readonly ResourceKind[],
            options: { chats?: boolean } = {},
        ): {
            epoch: string;
            kinds: Record<string, StoredResource<unknown>[]>;
            chats?: ChatRecord[];
            chatOrders?: ChatOrderRecord[];
        } {
            assertOpen();
            const result: Record<string, StoredResource<unknown>[]> = Object.create(null);
            for (const kind of kindList) {
                assertKind(kind);
                result[kind.name] = readKind(kind);
            }
            if (options.chats) {
                return { epoch, kinds: result, ...chatTables.readAll() };
            }
            return { epoch, kinds: result };
        },

        /**
         * Named records, read in one synchronous call; a missing one has revision and data null.
         * `chats` names single chats (missing: revision and data null); `chatCollections` names
         * characters whose order and every chat are read (no order: null).
         */
        readRefs(
            refs: readonly { kind: ResourceKind; id: string }[],
            options: {
                chats?: readonly { characterId: string; id: string }[];
                chatCollections?: readonly string[];
            } = {},
        ) {
            assertOpen();
            const items = refs.map(({ kind, id }) => {
                assertKind(kind);
                assertId(kind, id);
                const row = readOne(kind, id);
                return { kind: kind.name, id, revision: row?.revision ?? null, data: row?.data ?? null };
            });
            const chats = (options.chats ?? []).map(({ characterId, id }) => {
                const record = chatTables.readChat(characterId, id);
                return record ?? { characterId, id, revision: null, data: null };
            });
            const chatCollections = (options.chatCollections ?? []).map((characterId) => {
                const collection = chatTables.readCollection(characterId);
                return { characterId, order: collection?.order ?? null, chats: collection?.chats ?? [] };
            });
            return { epoch, items, chats, chatCollections };
        },

        /**
         * Normalizes `input` with the kind's normalizer and stores it. `baseRevision` null creates the
         * record and conflicts if it exists; a token updates it and conflicts unless it is current.
         * Returns the new token and the data as stored. Creating a character also creates its empty
         * chat order, in the same transaction.
         */
        put<T>(kind: ResourceKind<T>, id: string, input: unknown, baseRevision: string | null) {
            assertWritable();
            assertKind(kind);
            assertId(kind, id);
            const { text, stored } = serialize(normalizeInput(kind, input, id));
            return atomically(() => {
                let seq: number;
                let revision: number;
                if (baseRevision === null) {
                    const result = insert.run(kind.name, id, kind.schemaVersion, text);
                    if (result.changes === 0) {
                        conflict(kind, id);
                    }
                    seq = Number(result.lastInsertRowid);
                    revision = 1;
                    if (isCharacterKind(kind)) {
                        chatTables.createOrder(id);
                    }
                } else {
                    const base = parseToken(baseRevision);
                    if (!base) {
                        conflict(kind, id);
                    }
                    revision = nextRevision(base.revision, 1);
                    if (update.run(kind.schemaVersion, text, kind.name, id, base.seq, base.revision).changes === 0) {
                        conflict(kind, id);
                    }
                    seq = base.seq;
                }
                countWrite();
                return { revision: token(seq, revision), data: stored as T };
            });
        },

        /**
         * Deletes the record if `baseRevision` is current; a missing record is a conflict. Deleting a
         * character also deletes its chats, their messages, and its chat order, in the same transaction.
         */
        delete(kind: ResourceKind, id: string, baseRevision: string): void {
            assertWritable();
            assertKind(kind);
            assertId(kind, id);
            assertDeletable(kind);
            atomically(() => {
                // Before the revision check: a refusal for a generating message reads as "retry
                // after the job", not as a stale view.
                if (isCharacterKind(kind) && chatTables.characterLocked(id)) {
                    conflict(kind, id, "generating");
                }
                const base = parseToken(baseRevision);
                if (!base || remove.run(kind.name, id, base.seq, base.revision).changes === 0) {
                    conflict(kind, id);
                }
                if (isCharacterKind(kind)) {
                    chatTables.deleteCharacter(id);
                }
                countWrite();
            });
        },

        /** A chat's revision token, or null when it does not exist (its messages are not read). */
        chatRevision(characterId: string, id: string): string | null {
            assertOpen();
            return chatTables.chatRevision(characterId, id);
        },

        /** `applyChanges` with resource operations only; returns their tokens in operation order. */
        applyBatch(
            operations: readonly ResourceBatchOperation[],
        ): { kind: string; id: string; revision: string | null }[] {
            return store.applyChanges({ ops: operations }).results;
        },

        /**
         * Applies resource writes and deletions, chat groups, and chat reorders as one unit. Every
         * operation is validated and normalized first (a `ResourceValidationError` names the failing
         * entry; `chats` and `chatOrders` are the raw batch body entries, see `shared/chats.ts`).
         * Then, in one transaction: every resource base revision is compared; resource ops are
         * applied (creating a character creates its chat order, deleting one deletes its chats);
         * chat groups are applied in order, then reorders, each checked as `shared/chats.ts`
         * describes. If anything conflicts, nothing is written and `ResourceBatchConflictError`
         * lists every conflict. A batch that deletes a character and also names its chats is invalid.
         *
         * A change that rewrites or removes a message a generation job owns (the guard), or deletes
         * a character holding one, conflicts with `reason: "generating"` unless `options.jobToken`
         * is the owner's; that check precedes the revision checks. A generation job's own write
         * (`server/src/jobs/`) passes its `epoch` and `jobToken`: the epoch is asserted and the token
         * must be live (`JobTokenError` otherwise), in the same synchronous call as the write.
         */
        applyChanges(
            batch: {
                ops?: readonly ResourceBatchOperation[];
                chats?: unknown;
                chatOrders?: unknown;
            },
            options: { epoch?: string; jobToken?: string } = {},
        ): AppliedChanges {
            assertWritable();
            assertNotInTransaction();
            if (options.epoch !== undefined) {
                store.assertEpoch(options.epoch);
            }
            if (options.jobToken !== undefined && !guard?.isLive(options.jobToken)) {
                throw new JobTokenError();
            }
            const operations = batch.ops ?? [];
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
                    return { operation, text: serialize(normalizeInput(kind, operation.data, id)).text };
                } catch (error) {
                    if (error instanceof ResourceValidationError) {
                        throw new ResourceValidationError(`ops[${index}]: ${error.message}`);
                    }
                    throw error;
                }
            });
            const chatGroups = prepareChatGroups(batch.chats);
            const chatOrders = prepareChatOrders(batch.chatOrders);
            const deletedCharacters = new Set(
                prepared
                    .filter(({ operation, text }) => text === null && isCharacterKind(operation.kind))
                    .map(({ operation }) => operation.id),
            );
            for (const entry of [...chatGroups, ...chatOrders]) {
                if (deletedCharacters.has(entry.characterId)) {
                    throw new ResourceValidationError(
                        `the batch deletes character ${entry.characterId} and also changes its chats`,
                    );
                }
            }

            db.exec("BEGIN IMMEDIATE");
            let committed = false;
            try {
                const conflicts: BatchConflict[] = [];
                const bases = prepared.map(({ operation: { kind, id, baseRevision }, text }) => {
                    const row = selectOne.get(kind.name, id) as { seq: number; revision: number } | undefined;
                    const base = baseRevision === null ? null : parseToken(baseRevision);
                    if (text === null && isCharacterKind(kind) && chatTables.characterLocked(id, options.jobToken)) {
                        conflicts.push({
                            kind: kind.name,
                            id,
                            revision: row ? token(row.seq, row.revision) : null,
                            reason: "generating",
                        });
                        return base;
                    }
                    const current =
                        baseRevision === null
                            ? row === undefined
                            : !!row && !!base && base.seq === row.seq && base.revision === row.revision;
                    if (!current) {
                        conflicts.push({ kind: kind.name, id, revision: row ? token(row.seq, row.revision) : null });
                    }
                    return base;
                });
                // With a stale resource op nothing will be written, but chat entries are still
                // checked so the 409 lists every conflict.
                const orderBases = chatTables.orderBases(chatOrders);
                const results =
                    conflicts.length > 0
                        ? []
                        : prepared.map(({ operation: { kind, id }, text }, index) => {
                              const base = bases[index];
                              if (text === null) {
                                  remove.run(kind.name, id, base!.seq, base!.revision);
                                  if (isCharacterKind(kind)) {
                                      chatTables.deleteCharacter(id);
                                  }
                                  return { kind: kind.name, id, revision: null };
                              }
                              if (base === null) {
                                  const result = insert.run(kind.name, id, kind.schemaVersion, text);
                                  if (isCharacterKind(kind)) {
                                      chatTables.createOrder(id);
                                  }
                                  return { kind: kind.name, id, revision: token(Number(result.lastInsertRowid), 1) };
                              }
                              const revision = nextRevision(base.revision, 1);
                              update.run(kind.schemaVersion, text, kind.name, id, base.seq, base.revision);
                              return { kind: kind.name, id, revision: token(base.seq, revision) };
                          });
                const chatOutcome = chatTables.apply(
                    chatGroups,
                    chatOrders,
                    orderBases,
                    conflicts.length > 0,
                    options.jobToken,
                );
                conflicts.push(...chatOutcome.conflicts);
                if (conflicts.length > 0) {
                    throw new ResourceBatchConflictError(conflicts);
                }
                db.exec("COMMIT");
                committed = true;
                writeCount += prepared.length + chatOutcome.applied;
                return { results, chats: chatOutcome.results, chatOrders: chatOutcome.orders };
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
         * safe-integer `seq` and revision, and data the kind's normalizer and `serialize` accept), and
         * the chat tables (`readChatSnapshotRows`: chats of existing characters, messages of existing
         * chats, one exact order per character). Throws `ResourceValidationError` for anything else.
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
                        text = serialize(normalizeInput(kind, parsed, row.id)).text;
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
                const characterIds = new Set(
                    rows.filter((row) => row.kind === RESOURCE_KIND.characters).map((row) => row.id),
                );
                return { rows, ...readChatSnapshotRows(source, characterIds) };
            } finally {
                source.close();
            }
        },

        /**
         * Replaces every record with the rows of a validated snapshot, runs the normalization pass
         * (creating the `materialize` singletons the snapshot lacks), and gives the database a new
         * epoch, in one transaction; every token issued before is stale afterwards. Returns the epoch.
         * Revision counters are restored as stored (the new epoch already makes every old token
         * stale; `nextRevision` keeps a counter a crafted snapshot placed at the limit from
         * overflowing on the next write).
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
                chatTables.replaceAll(snapshot);
                // The rows are normalized already (`readSnapshot`); this materializes the kinds the
                // snapshot predates. A failure rolls the whole restore back.
                normalizeStoredRecords();
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
    return store;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Column names of the store's tables, in `PRAGMA table_info` order. */
function snapshotTableColumns(): Record<string, readonly string[]> {
    return {
        resources: ["seq", "kind", "id", "revision", "schemaVersion", "data"],
        meta: ["key", "value"],
        ...CHAT_TABLE_COLUMNS,
    };
}

/**
 * Requires the layout `initialize` creates: `resources`, `meta`, and the chat tables are ordinary
 * tables (a view or a virtual table could answer the row query with anything), with exactly these
 * columns, and `meta` holds an epoch string. Anything else is not a resource database.
 */
function assertSnapshotLayout(source: DatabaseSync) {
    for (const [table, columns] of Object.entries(snapshotTableColumns())) {
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
 * Runs the kind's normalizer on the stored form of `input` (`serialize`), so input the store would
 * refuse as output is refused before normalizing: the Phase 3 normalizers copy through JSON
 * (`plainClone`), which would turn an `Infinity` from `JSON.parse("1e400")` into `null` where
 * `serialize` could no longer see it. `undefined` (a record being materialized) passes as is.
 */
function normalizeInput(kind: ResourceKind, input: unknown, id: string): unknown {
    return kind.normalize(input === undefined ? undefined : serialize(input).stored, { id });
}

/**
 * Serializes normalized data the way it is stored: as `JSON.stringify` produces it, so `toJSON`
 * applies, `undefined` fields drop, and Dates become strings. Refuses data whose JSON form would turn
 * a non-finite number into `null`, that `JSON.stringify` cannot serialize (a bigint, a cycle, a
 * throwing getter, runaway nesting), or whose JSON form nests deeper than `MAX_JSON_DEPTH`. Returns
 * the text and the value parsed back from it, which is what a read returns.
 */
export function serialize(value: unknown): { text: string; stored: unknown } {
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

/**
 * Opens the connection settings and creates the schema and epoch on first use. Returns the epoch. A
 * version-1 database (Phase 1, characters with embedded chats) and a version-2 one (settings in a
 * `root` record, before Phase 3) are refused: no migration is owed.
 */
function initialize(db: DatabaseSync, file: string): string {
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
                ${CHAT_TABLES_SQL}
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
    } else if (version === 1) {
        throw new Error(
            `${file} holds resource database version 1 (characters with their chats inside), which this ` +
                "server no longer reads. It is disposable alpha data: move it away or delete it and restart " +
                "to begin with an empty database.",
        );
    } else if (version === 2) {
        throw new Error(
            `${file} holds resource database version 2 (settings in one root record, before Phase 3), which ` +
                "this server no longer reads. It is disposable alpha data: move it away or delete it and " +
                "restart to begin with an empty database.",
        );
    } else if (version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported resource database version ${version}`);
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string } | undefined;
    if (!row) {
        throw new Error("Resource database has no epoch");
    }
    return row.value;
}
