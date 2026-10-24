import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import type {
    ChatGroupResult,
    ChatOrderRecord,
    ChatOrderResult,
    ChatRecord,
    ChatSummary,
} from "../../../shared/chats.ts";
import { HIDDEN_HYDRATION_KINDS } from "../../../shared/jobs.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import {
    applyItemPatch,
    type CheckedFields,
    type CheckedItemPatch,
    checkFields,
    checkItemPatch,
    diffFields,
    diffItems,
    RecordPatchError,
    withFields,
} from "../../../shared/recordPatch.ts";
import {
    type BatchConflict,
    type ChangeSet,
    type ChatPatchBody,
    MAX_FEED_PATCH_BYTES,
    RESOURCE_KIND,
    type RecordPatch,
    type ResourceRevisionListing,
    SINGLETON_RESOURCE_ID,
} from "../../../shared/resources.ts";
import type { ChatStreaming } from "../../../shared/events.ts";
import type { MessageSearchHit } from "../../../shared/messageSearch.ts";
import type { ChangeFeed } from "./changeFeed.ts";
import { type CheckpointSnapshotRows, createCheckpointTables, readCheckpointSnapshotRows } from "./checkpointStore.ts";
import { diffRecordText } from "./recordPatchText.ts";
import {
    CHAT_TABLE_COLUMNS,
    CHAT_TABLES_SQL,
    type ChatSnapshotRows,
    countChatOperations,
    createChatTables,
    type MessageSearchChat,
    type MessageSearchPosition,
    type MessageSearchResume,
    type MessageSearchRow,
    type MessageSearchScope,
    messageSearchSnippet,
    prepareChatGroups,
    prepareChatOrders,
    readChatSnapshotRows,
} from "./chatStore.ts";
import type { MessageGuard } from "../jobs/generationLock.ts";
import type { ResourceKind, ResourceKindRegistry } from "./kinds.ts";

/**
 * Version of the resource database, kept in `PRAGMA user_version`. Version 2 added the chat tables;
 * version 3 has the same tables and holds the settings sections and collections instead of
 * a `root` record.
 */
const SCHEMA_VERSION = 3;
/**
 * Kinds an earlier server stored and this one no longer registers: the normalization pass deletes
 * their records, and a snapshot's rows of them are skipped, so a database or backup written before
 * a kind was removed still opens and restores.
 */
const RETIRED_KINDS: ReadonlySet<string> = new Set(["customSidebarItems"]);
const BUSY_TIMEOUT_MS = 5000;
/** Deepest array/object nesting a stored value may have. */
const MAX_JSON_DEPTH = 256;
/**
 * `writePatch`'s cache of the last patched records cut into parts (`PatchBase`): at most this many, and
 * this many estimated UTF-16 units: 2x text.length for text/parts plus 2x for the parsed graph.
 * Node 24.21.0, 2026-10-17, --expose-gc, heapUsed deltas (7 samples, GC before/after): a
 * 10,017,827-unit character with 20,000 lore entries retained 30.997 MB cut (ASCII), 59.832 MB
 * with two-byte text; the parsed value alone was 10.960/19.760 MB (1.094/1.973 bytes per unit).
 * The 4x charge rounds up with graph overhead headroom; an estimate, not a hard heap bound for
 * every JSON shape. A record over the budget alone is not kept.
 */
const PATCH_BASES_MAX = 4;
const PATCH_BASES_MAX_UNITS = 64 * 1024 * 1024;
const PATCH_BASE_UNITS_PER_CHAR = 4;

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

/**
 * A write committed (and was published), but the work its caller ran after the commit
 * (`applyChanges`' `committed`) threw: `cause`. Nothing of the write is undone.
 */
export class CommittedWriteError extends Error {
    constructor(cause: unknown) {
        super("The write committed, but its follow-up failed", { cause });
        this.name = "CommittedWriteError";
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

/** The database was replaced (a restore or an import) while a message search ran: search again. */
export class MessageSearchEpochError extends Error {
    constructor() {
        super("The data was replaced during the search");
        this.name = "MessageSearchEpochError";
    }
}

/**
 * A message search's bounds (`searchMessages`): `budgetBytes` of message JSON per request, at most
 * `batchRows` units (message rows and chats looked at) and `batchBytes` per synchronous batch, and
 * `yieldTurn` between batches (`setImmediate` in production; tests inject a latch).
 */
export type MessageSearchLimits = {
    budgetBytes: number;
    batchRows: number;
    batchBytes: number;
    yieldTurn: () => Promise<void>;
};

/** One page of a message search, or the named character or chat that does not exist. */
export type MessageSearchOutcome =
    | { notFound: "character" | "chat" }
    | { hits: MessageSearchHit[]; next: MessageSearchPosition | null; scannedBytes: number };

/** The playground's character (`PlaygroundMenu.svelte`): an ordinary persisted character the all-characters search skips. */
const PLAYGROUND_CHARACTER_ID = "§playground";

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

/**
 * One operation of `applyBatch`: a write (`data`), with `delete: true` a deletion, or with `patch` a
 * record patch applied to the record as stored at `baseRevision` (a string), whose result is normalized
 * and stored like any write: a field patch of an object record (`{ set?, remove? }`, see
 * `RecordFieldPatch`) or an item patch of an array record with unique item ids (`{ items?, changes?,
 * order? }`, see `RecordItemPatch`). A kind with `project` or `prepareWrite` takes no patch.
 */
export type ResourceBatchOperation = {
    kind: ResourceKind;
    id: string;
    baseRevision: string | null;
    data?: unknown;
    delete?: boolean;
    patch?: unknown;
};

/** Validated snapshot rows ready for restore; absent checkpoint rows restore no checkpoints or policies. */
export type ValidatedSnapshot = {
    readonly rows: readonly { kind: string; id: string; revision: number; schemaVersion: number; text: string }[];
    readonly checkpoints?: CheckpointSnapshotRows;
} & ChatSnapshotRows;

/** What `applyChanges` wrote: resource tokens in op order, chat group results, and every changed chat order. */
export type AppliedChanges = {
    results: { kind: string; id: string; revision: string | null }[];
    chats: ChatGroupResult[];
    chatOrders: ChatOrderResult[];
};

/** Checkpoint access valid only inside one `applyChanges` transaction callback. */
export type CheckpointTransaction = Pick<
    ReturnType<typeof createCheckpointTables>,
    "save" | "prune" | "setFloor" | "readPolicy" | "writePolicy"
>;

export type ApplyChangesTransaction = {
    before?: (tx: CheckpointTransaction) => unknown;
    after?: (applied: AppliedChanges, tx: CheckpointTransaction) => unknown;
};

export type ResourceStore = ReturnType<typeof createResourceStore>;

/**
 * The notice `onChatInvalidated` delivers once a write that deleted a chat, replaced it whole, or
 * deleted its character committed: the chat's new source generation in that epoch. Captured at the
 * commit, so a later write never changes it.
 */
export type ChatInvalidation = { epoch: string; characterId: string; id: string; sourceGeneration: number };

/** A `readRefs` chat entry; a missing chat has revision and data null. */
type ChatRead = ChatRecord | { characterId: string; id: string; revision: null; data: null };

/** A patch op, checked before the transaction (`preparePatch`). */
type PreparedPatch = ({ type: "fields" } & CheckedFields) | ({ type: "items" } & CheckedItemPatch);

/**
 * A record's stored text cut into its top-level parts for `writePatch`'s fast path: the value read from
 * it and the text of each field (an object record) or of each item (an array record, by the item). Only
 * made when the text is exactly its parts joined as `JSON.stringify` joins them (`cutRecord`).
 */
type PatchBase =
    | { text: string; value: Record<string, unknown>; fields: Map<string, string> }
    | { text: string; value: unknown[]; items: Map<unknown, string> };

/** A batch op after the checks that need no stored row; a `patch` op is applied inside the transaction. */
type PreparedOperation =
    | { operation: ResourceBatchOperation; mode: "write"; text: string }
    | { operation: ResourceBatchOperation; mode: "delete" }
    | { operation: ResourceBatchOperation; mode: "patch"; patch: PreparedPatch; index: number };

type ChangeAccumulator = {
    resources: Map<string, ChangeSet["resources"][number]>;
    chats: Map<string, ChangeSet["chats"][number]>;
    chatOrders: Map<string, ChangeSet["chatOrders"][number]>;
    /** Generation locks per chat (`characterId\0id`); the last list given for a chat wins. */
    streaming: Map<string, ChatStreaming>;
};

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
 * Reads and checks a snapshot file (read-only; nothing in it is executed beyond reading):
 * `integrity_check`, the schema version, the layout (`resources` and `meta` are real tables
 * with this store's columns, and `meta` holds an epoch), and every row (a registered kind at
 * its current schema version (rows of a `RETIRED_KINDS` kind are skipped), a valid id, singleton rules, unique kind and id, positive
 * safe-integer `seq` and revision, and data the kind's normalizer and `serialize` accept), and
 * the chat tables (`readChatSnapshotRows`: chats of existing characters, messages of existing
 * chats, one exact order per character). The optional checkpoint tables must be all present or all
 * absent; their rows, references, content hashes, messages, fields, and policies are checked without
 * changing stored text. With `checkpoints: false`, checkpoint tables are neither read nor validated
 * and the result omits `checkpoints`. Throws `ResourceValidationError` for anything else.
 */
export function readSnapshotFile(
    file: string,
    kinds: ResourceKindRegistry,
    options?: { checkpoints?: boolean },
): ValidatedSnapshot {
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
        const rows = rawRows.flatMap((row, index) => {
            if (typeof row.kind === "string" && RETIRED_KINDS.has(row.kind)) {
                return [];
            }
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
            return [
                {
                    kind: kind.name,
                    id: row.id,
                    revision: row.revision,
                    schemaVersion: kind.schemaVersion,
                    text,
                },
            ];
        });
        const characterIds = new Set(rows.filter((row) => row.kind === RESOURCE_KIND.characters).map((row) => row.id));
        const chats = readChatSnapshotRows(source, characterIds);
        const checkpoints =
            options?.checkpoints === false ? undefined : readCheckpointSnapshotRows(source, chats.chats);
        return { rows, ...chats, ...(checkpoints ? { checkpoints } : {}) };
    } finally {
        source.close();
    }
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
export function createResourceStore(options: {
    file: string;
    kinds: ResourceKindRegistry;
    guard?: MessageGuard;
    /** Where committed changes are published (the live updates). */
    feed?: ChangeFeed;
    /** The `patchBases` cache's budget in estimated units (default `PATCH_BASES_MAX_UNITS`; tests lower it). */
    patchBaseMaxUnits?: number;
    /**
     * Tests: called once with a reader of a record's stored JSON text, as the database holds it (an
     * in-memory store has no file another connection could read).
     */
    inspectStoredText?: (read: (kind: ResourceKind, id: string) => string | undefined) => void;
}) {
    const { kinds, guard, feed } = options;
    const patchBaseMaxUnits = options.patchBaseMaxUnits ?? PATCH_BASES_MAX_UNITS;
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
    const selectRevisions = db.prepare("SELECT kind, id, seq, revision FROM resources ORDER BY seq");
    const selectKindRevisions = db.prepare("SELECT id, seq, revision FROM resources WHERE kind = ? ORDER BY seq");
    const selectRevision = db.prepare("SELECT seq, revision FROM resources WHERE kind = ? AND id = ?");
    // A character's name and trash state for the message search, without parsing the record in JavaScript.
    const selectSearchCharacter = db.prepare(
        "SELECT json_extract(data, '$.name') AS name, json_extract(data, '$.trashTime') AS trashTime, " +
            "octet_length(data) AS bytes FROM resources WHERE kind = ? AND id = ?",
    );
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
    const deleteKind = db.prepare("DELETE FROM resources WHERE kind = ?");
    options.inspectStoredText?.((kind, id) => {
        assertKind(kind);
        return (selectOne.get(kind.name, id) as { data: string } | undefined)?.data;
    });

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
        for (const name of RETIRED_KINDS) {
            written += Number(deleteKind.run(name).changes);
        }
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
    // Public writes, including async continuations, cannot escape a checkpoint callback's writer.
    const checkpointCallbackScope = new AsyncLocalStorage<boolean>();

    const token = (seq: number, revision: number) => `${epoch}:${seq}:${revision}`;

    /**
     * Source generations: per chat (`characterId\0id`), an in-memory value that changes once in the
     * commit of every write that deletes the chat, replaces it whole, or deletes its character, and
     * in no other write. Values come from one counter and are never issued twice while the store is
     * open, so an entry stays after its chat is deleted (a recreated chat under the same ids must
     * not read an earlier value again); `replaceAll` clears the map and moves `baseSourceGeneration`,
     * the value of a chat without an entry, past every value issued before.
     */
    const sourceGenerations = new Map<string, number>();
    let lastSourceGeneration = 0;
    let baseSourceGeneration = 0;
    /**
     * The chats the open SQL transaction deletes or replaces whole, advanced at its COMMIT and
     * dropped at its rollback. Null outside a transaction; transactions never nest (a write inside
     * `transaction` or `atomically` joins the open one).
     */
    let transactionInvalidations: Map<string, { characterId: string; id: string }> | null = null;
    const invalidationListeners = new Set<(notice: ChatInvalidation) => void>();
    /** Notices of committed writes not delivered yet, oldest first. */
    const pendingInvalidations: ChatInvalidation[] = [];
    let deliveringInvalidations = false;
    /**
     * Publishing scopes still running, their feed publication included (a feed listener's
     * own write opens another): notices wait until every one has published.
     */
    let publishingDepth = 0;

    function readChatOrMissing(characterId: string, id: string): ChatRead {
        return chatTables.readChat(characterId, id) ?? { characterId, id, revision: null, data: null };
    }

    function sourceGenerationOf(characterId: string, id: string): number {
        return sourceGenerations.get(`${characterId}\u0000${id}`) ?? baseSourceGeneration;
    }

    function recordInvalidation(characterId: string, id: string) {
        transactionInvalidations?.set(`${characterId}\u0000${id}`, { characterId, id });
    }

    function beginTransaction() {
        db.exec("BEGIN IMMEDIATE");
        transactionInvalidations = new Map();
    }

    /**
     * Commits the open transaction and, in the same synchronous step, advances the source
     * generation of every chat it invalidated and queues their notices (`deliverInvalidations`).
     */
    function commitTransaction() {
        db.exec("COMMIT");
        const invalidated = transactionInvalidations;
        transactionInvalidations = null;
        for (const [key, { characterId, id }] of invalidated ?? []) {
            lastSourceGeneration += 1;
            sourceGenerations.set(key, lastSourceGeneration);
            pendingInvalidations.push({ epoch, characterId, id, sourceGeneration: lastSourceGeneration });
        }
    }

    /** Rolls back the open transaction, if any, with the invalidations it recorded. */
    function rollbackTransaction() {
        transactionInvalidations = null;
        if (db.isTransaction) {
            db.exec("ROLLBACK");
        }
    }

    /**
     * Delivers the queued notices in commit order, once no publishing scope is running. A listener's
     * own write queues its notices behind the ones being delivered (no nested delivery); a listener
     * that throws is logged and never fails the write that committed. A listener can see a state
     * newer than its notice (a later write ran before it), so consumers compare the notice's
     * generation with what they hold.
     */
    function deliverInvalidations() {
        if (deliveringInvalidations || publishingDepth > 0) {
            return;
        }
        deliveringInvalidations = true;
        try {
            while (pendingInvalidations.length > 0) {
                const notice = pendingInvalidations.shift()!;
                for (const listener of [...invalidationListeners]) {
                    try {
                        listener(notice);
                    } catch (error) {
                        console.error("[ChatInvalidation]", error);
                    }
                }
            }
        } finally {
            deliveringInvalidations = false;
        }
    }

    /**
     * The current write's refs and the independently committed nested writes it must preserve if it
     * throws. Writes inside an open transaction share its scope. Null outside a write.
     */
    let publishingScope: { changes: ChangeAccumulator; committed: ChangeAccumulator[] } | null = null;

    function changeAccumulator(): ChangeAccumulator {
        return { resources: new Map(), chats: new Map(), chatOrders: new Map(), streaming: new Map() };
    }

    /** Coalesces refs in write order; a second write loses the patch of an unannounced base. */
    function mergeChanges(target: ChangeAccumulator, source: ChangeAccumulator) {
        for (const [key, entry] of source.resources) {
            const { kind, id, revision } = entry;
            target.resources.set(key, target.resources.has(key) ? { kind, id, revision } : entry);
        }
        for (const [key, entry] of source.chats) {
            const { characterId, id, revision } = entry;
            target.chats.set(key, target.chats.has(key) ? { characterId, id, revision } : entry);
        }
        for (const [key, entry] of source.chatOrders) {
            target.chatOrders.set(key, entry);
        }
        for (const [key, entry] of source.streaming) {
            target.streaming.set(key, entry);
        }
    }

    /**
     * `patch`: the write was a field patch whose changes the feed may carry. A record already written
     * in this scope loses it: its base would be a revision no client was told about.
     */
    function recordResource(kind: string, id: string, revision: string | null, patch?: RecordPatch) {
        const changes = publishingScope?.changes;
        const key = `${kind}\u0000${id}`;
        changes?.resources.set(
            key,
            patch && !changes.resources.has(key) ? { kind, id, revision, patch } : { kind, id, revision },
        );
    }

    function recordChat(characterId: string, id: string, revision: string | null, patch?: ChatPatchBody) {
        const changes = publishingScope?.changes;
        const key = `${characterId}\u0000${id}`;
        changes?.chats.set(
            key,
            patch && !changes.chats.has(key) ? { characterId, id, revision, patch } : { characterId, id, revision },
        );
    }

    function recordStreaming(entry: ChatStreaming) {
        publishingScope?.changes.streaming.set(`${entry.characterId}\u0000${entry.id}`, entry);
    }

    function recordOrder(characterId: string, revision: string | null) {
        publishingScope?.changes.chatOrders.set(characterId, { characterId, revision });
    }

    /** A character's chats and order deleted with it, recorded as deletions and invalidations. */
    function recordCharacterCascade(characterId: string, removed: { chatIds: string[]; order: boolean }) {
        for (const chatId of removed.chatIds) {
            recordChat(characterId, chatId, null);
            recordInvalidation(characterId, chatId);
        }
        if (removed.order) {
            recordOrder(characterId, null);
        }
    }

    /**
     * Runs a write and publishes its refs only after commit, with `transactionState` cleared. Writes
     * inside an open transaction share its scope. An independently committed write nested in input
     * evaluation merges into the enclosing scope on success; if that scope throws, only its nested
     * commits' refs are published. The invalidation notices of every committed transaction are
     * delivered after publication, once all publishing scopes (including a feed listener's writes)
     * have ended, even when an enclosing write throws.
     */
    function publishing<T>(fn: () => T): T {
        if (publishingScope && db.isTransaction) {
            return fn();
        }
        const parent = publishingScope;
        const scope = { changes: changeAccumulator(), committed: [] as ChangeAccumulator[] };
        publishingScope = scope;
        publishingDepth += 1;
        let succeeded = false;
        try {
            const result = fn();
            succeeded = true;
            return result;
        } finally {
            publishingScope = parent;
            try {
                const changes = succeeded ? scope.changes : changeAccumulator();
                if (!succeeded) {
                    for (const committed of scope.committed) {
                        mergeChanges(changes, committed);
                    }
                }
                if (parent) {
                    mergeChanges(parent.changes, changes);
                    parent.committed.push(changes);
                } else if (
                    feed &&
                    (changes.resources.size > 0 ||
                        changes.chats.size > 0 ||
                        changes.chatOrders.size > 0 ||
                        changes.streaming.size > 0)
                ) {
                    feed.publish({
                        type: "change",
                        epoch,
                        changes: {
                            resources: [...changes.resources.values()],
                            chats: [...changes.chats.values()],
                            chatOrders: [...changes.chatOrders.values()],
                        },
                        ...(changes.streaming.size > 0 ? { streaming: [...changes.streaming.values()] } : {}),
                    });
                }
            } finally {
                publishingDepth -= 1;
                deliverInvalidations();
            }
        }
    }

    function parseToken(value: string): { seq: number; revision: number } | null {
        const match = revisionTokenRegex.exec(value);
        if (!match || match[1] !== epoch) {
            return null;
        }
        const seq = Number(match[2]);
        const revision = Number(match[3]);
        return Number.isSafeInteger(seq) && Number.isSafeInteger(revision) ? { seq, revision } : null;
    }

    const checkpointTables = createCheckpointTables(db, { token, parse: parseToken });
    const chatTables = createChatTables(db, { token, parse: parseToken }, guard);
    if (checkpointTables.sweep() > 0) {
        countWrite();
    }
    const isCharacterKind = (kind: ResourceKind) => kind.name === RESOURCE_KIND.characters;

    function assertOpen() {
        if (closed) {
            throw new ResourceStoreClosedError();
        }
    }

    function assertWritable() {
        assertOpen();
        if (checkpointCallbackScope.getStore()) {
            throw new Error("Use the transaction-bound checkpoint writer inside applyChanges callbacks");
        }
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
        beginTransaction();
        let committed = false;
        try {
            const result = fn();
            commitTransaction();
            committed = true;
            return result;
        } finally {
            if (!committed) {
                rollbackTransaction();
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

    /**
     * Applies a patch op inside the batch transaction, at its base revision (checked current), and
     * returns the change feed's record patch (`feedPatch`). A field patch of a record that is not an
     * object, an item patch that does not fit the stored list (`applyItemPatch`), or a result the kind
     * refuses throws `ResourceValidationError` (the batch rolls back).
     */
    function writePatch(
        entry: Extract<PreparedOperation, { mode: "patch" }>,
        base: { seq: number; revision: number },
    ): RecordPatch | undefined {
        const { kind, id } = entry.operation;
        try {
            const row = selectOne.get(kind.name, id) as { data: string };
            const { patch } = entry;
            if (kind.shallowNormalize) {
                const cut = patchBase(kind, id, row.data);
                const written = cut && patchParts(kind, id, cut, patch);
                if (written) {
                    update.run(kind.schemaVersion, written.text, kind.name, id, base.seq, base.revision);
                    rememberPatchBase(kind, id, written);
                    return feedPatch(kind, token(base.seq, base.revision), cut.value, written.value);
                }
            }
            const old: unknown = JSON.parse(row.data);
            let next: unknown;
            if (patch.type === "fields") {
                if (!isPlainObject(old)) {
                    throw new ResourceValidationError("a field patch needs an object record");
                }
                next = withFields(old, patch.set, patch.remove);
            } else {
                next = applyItemPatch(old, patch);
            }
            const { text, stored } = serialize(normalizeInput(kind, next, id));
            update.run(kind.schemaVersion, text, kind.name, id, base.seq, base.revision);
            return feedPatch(kind, token(base.seq, base.revision), old, stored, { old: row.data, next: text });
        } catch (error) {
            if (error instanceof ResourceValidationError || error instanceof RecordPatchError) {
                throw new ResourceValidationError(`ops[${entry.index}]: ${error.message}`);
            }
            throw error;
        }
    }

    /** `writePatch`'s cut records by kind and id (`PatchBase`), least recently used first. */
    const patchBases = new Map<string, PatchBase>();

    /**
     * The record `text` cut into parts: the cached cut when it was made from this very text (a write
     * the transaction rolled back, a restore, or any other write leaves a different text), else a new
     * one (`cutRecord`). Null when the text cannot be cut.
     */
    function patchBase(kind: ResourceKind, id: string, text: string): PatchBase | null {
        const key = `${kind.name}\u0000${id}`;
        const cached = patchBases.get(key);
        patchBases.delete(key);
        return cached && cached.text === text ? cached : cutRecord(text);
    }

    function rememberPatchBase(kind: ResourceKind, id: string, cut: PatchBase) {
        const key = `${kind.name}\u0000${id}`;
        patchBases.delete(key);
        patchBases.set(key, cut);
        let units = 0;
        for (const entry of patchBases.values()) {
            units += entry.text.length * PATCH_BASE_UNITS_PER_CHAR;
        }
        for (const [oldest, entry] of patchBases) {
            if (patchBases.size <= PATCH_BASES_MAX && units <= patchBaseMaxUnits) {
                break;
            }
            patchBases.delete(oldest);
            units -= entry.text.length * PATCH_BASE_UNITS_PER_CHAR;
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
        const row = selectRevision.get(kind.name, id) as { seq: number; revision: number } | undefined;
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

    /** `applyChanges` inside the publishing scope (see there). */
    function applyChangesInScope(
        batch: {
            ops?: readonly ResourceBatchOperation[];
            chats?: unknown;
            chatOrders?: unknown;
        },
        options: { epoch?: string; jobToken?: string; inTransaction?: ApplyChangesTransaction },
    ): AppliedChanges {
        assertNotInTransaction();
        if (options.epoch !== undefined) {
            assertEpochNow(options.epoch);
        }
        if (options.jobToken !== undefined && !guard?.isLive(options.jobToken)) {
            throw new JobTokenError();
        }
        const operations = batch.ops ?? [];
        const seen = new Set<string>();
        const prepared = operations.map((operation, index): PreparedOperation => {
            try {
                const { kind, id } = operation;
                assertKind(kind);
                assertId(kind, id);
                const key = `${kind.name}\u0000${id}`;
                if (seen.has(key)) {
                    throw new ResourceValidationError("duplicate kind and id");
                }
                seen.add(key);
                if (Object.hasOwn(operation, "patch")) {
                    if (Object.hasOwn(operation, "delete") || Object.hasOwn(operation, "data")) {
                        throw new ResourceValidationError("a patch has no data and no deletion");
                    }
                    if (typeof operation.baseRevision !== "string") {
                        throw new ResourceValidationError("a patch needs a base revision");
                    }
                    return { operation, mode: "patch", patch: preparePatch(kind, operation.patch), index };
                }
                if (operation.delete) {
                    assertDeletable(kind);
                    if (typeof operation.baseRevision !== "string") {
                        throw new ResourceValidationError("a deletion needs a base revision");
                    }
                    return { operation, mode: "delete" };
                }
                return { operation, mode: "write", text: serialize(normalizeInput(kind, operation.data, id)).text };
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
                .filter((entry) => entry.mode === "delete" && isCharacterKind(entry.operation.kind))
                .map(({ operation }) => operation.id),
        );
        for (const entry of [...chatGroups, ...chatOrders]) {
            if (deletedCharacters.has(entry.characterId)) {
                throw new ResourceValidationError(
                    `the batch deletes character ${entry.characterId} and also changes its chats`,
                );
            }
        }

        beginTransaction();
        let committed = false;
        let checkpointWrites = 0;
        function runCheckpointCallback(callback: (tx: CheckpointTransaction) => unknown) {
            let active = true;
            const transaction = transactionInvalidations;
            function check() {
                assertOpen();
                if (!active || !db.isTransaction || transactionInvalidations !== transaction) {
                    throw new Error("Checkpoint transaction callback already ended");
                }
            }
            const tx: CheckpointTransaction = {
                save(...args) {
                    check();
                    const result = checkpointTables.save(...args);
                    checkpointWrites += result ? 1 : 0;
                    return result;
                },
                prune(...args) {
                    check();
                    const result = checkpointTables.prune(...args);
                    checkpointWrites += Number(result.deleted > 0) + Number(result.pagesRemoved > 0);
                    return result;
                },
                setFloor(...args) {
                    check();
                    const changed = checkpointTables.setFloor(...args);
                    checkpointWrites += Number(changed);
                    return changed;
                },
                readPolicy(...args) {
                    check();
                    return checkpointTables.readPolicy(...args);
                },
                writePolicy(...args) {
                    check();
                    const changed = checkpointTables.writePolicy(...args);
                    checkpointWrites += Number(changed);
                    return changed;
                },
            };
            try {
                checkpointCallbackScope.run(true, () => {
                    let value: unknown;
                    try {
                        value = callback(tx);
                    } finally {
                        active = false;
                    }
                    if (isThenable(value)) {
                        try {
                            value.then(undefined, () => {});
                        } catch {
                            // Report the synchronous contract, not a rejected continuation.
                        }
                        throw new Error("applyChanges transaction callbacks must be synchronous");
                    }
                });
            } finally {
                active = false;
            }
        }
        try {
            if (options.inTransaction?.before) {
                runCheckpointCallback(options.inTransaction.before);
            }
            const conflicts: BatchConflict[] = [];
            const bases = prepared.map(({ operation: { kind, id, baseRevision }, mode }) => {
                const row = selectRevision.get(kind.name, id) as { seq: number; revision: number } | undefined;
                const base = baseRevision === null ? null : parseToken(baseRevision);
                if (mode === "delete" && isCharacterKind(kind) && chatTables.characterLocked(id, options.jobToken)) {
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
            const patches = new Map<number, RecordPatch>();
            const results =
                conflicts.length > 0
                    ? []
                    : prepared.map((entry, index) => {
                          const { kind, id } = entry.operation;
                          const base = bases[index];
                          if (entry.mode === "delete") {
                              remove.run(kind.name, id, base!.seq, base!.revision);
                              if (isCharacterKind(kind)) {
                                  recordCharacterCascade(id, chatTables.deleteCharacter(id));
                              }
                              return { kind: kind.name, id, revision: null };
                          }
                          if (entry.mode === "patch") {
                              const revision = nextRevision(base!.revision, 1);
                              const patch = writePatch(entry, base!);
                              if (patch) {
                                  patches.set(index, patch);
                              }
                              return { kind: kind.name, id, revision: token(base!.seq, revision) };
                          }
                          const { text } = entry;
                          if (base === null) {
                              const result = insert.run(kind.name, id, kind.schemaVersion, text);
                              if (isCharacterKind(kind)) {
                                  const order = chatTables.createOrder(id);
                                  if (order !== null) {
                                      recordOrder(id, order);
                                  }
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
            for (const chat of chatOutcome.invalidated) {
                recordInvalidation(chat.characterId, chat.id);
            }
            const applied = { results, chats: chatOutcome.results, chatOrders: chatOutcome.orders };
            if (options.inTransaction?.after) {
                runCheckpointCallback((tx) => options.inTransaction!.after!(applied, tx));
            }
            commitTransaction();
            committed = true;
            writeCount += prepared.length + chatOutcome.applied + checkpointWrites;
            for (const [index, result] of results.entries()) {
                recordResource(result.kind, result.id, result.revision, patches.get(index));
            }
            for (const chat of chatOutcome.results) {
                if (!chatOutcome.duplicates.has(chat)) {
                    recordChat(chat.characterId, chat.id, chat.revision, chatOutcome.patches.get(chat));
                }
            }
            for (const order of chatOutcome.orders) {
                recordOrder(order.characterId, order.revision);
            }
            return applied;
        } finally {
            if (!committed) {
                rollbackTransaction();
            }
        }
    }

    /** `transaction` inside the publishing scope (see there). */
    function transactionInScope<F extends () => unknown>(fn: TransactionBody<F>): ReturnType<F> {
        assertWritable();
        assertNotInTransaction();
        beginTransaction();
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
            commitTransaction();
            committed = true;
            writeCount += state.writes;
            return result;
        } finally {
            scope.ended = true;
            transactionState = null;
            if (!committed) {
                rollbackTransaction();
            }
        }
    }

    function assertEpochNow(expected: string | undefined): void {
        if (expected !== epoch) {
            throw new ResourceEpochError(epoch);
        }
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

        /** Cold checkpoint data: writes count toward snapshots without publishing chat changes. */
        checkpoints: {
            readFloor(...args: Parameters<typeof checkpointTables.readFloor>) {
                assertOpen();
                return checkpointTables.readFloor(...args);
            },
            save(...args: Parameters<typeof checkpointTables.save>) {
                assertWritable();
                return transactionInScope(() => {
                    const result = checkpointTables.save(...args);
                    if (result) {
                        countWrite();
                    }
                    return result;
                });
            },
            prune(...args: Parameters<typeof checkpointTables.prune>) {
                assertWritable();
                return transactionInScope(() => {
                    const result = checkpointTables.prune(...args);
                    if (result.deleted > 0) {
                        countWrite();
                    }
                    if (result.pagesRemoved > 0) {
                        countWrite();
                    }
                    return result;
                });
            },
            list(...args: Parameters<typeof checkpointTables.list>) {
                assertOpen();
                return checkpointTables.list(...args);
            },
            rename(...args: Parameters<typeof checkpointTables.rename>) {
                assertWritable();
                return transactionInScope(() => {
                    const result = checkpointTables.rename(...args);
                    if (result) {
                        countWrite();
                    }
                    return result;
                });
            },
            delete(...args: Parameters<typeof checkpointTables.delete>) {
                assertWritable();
                return transactionInScope(() => {
                    const result = checkpointTables.delete(...args);
                    if (result) {
                        countWrite();
                        if (result.pagesRemoved > 0) {
                            countWrite();
                        }
                    }
                    return result;
                });
            },
            compose(...args: Parameters<typeof checkpointTables.compose>) {
                assertOpen();
                return checkpointTables.compose(...args);
            },
            readPolicy(...args: Parameters<typeof checkpointTables.readPolicy>) {
                assertOpen();
                return checkpointTables.readPolicy(...args);
            },
            writePolicy(...args: Parameters<typeof checkpointTables.writePolicy>) {
                assertWritable();
                return transactionInScope(() => {
                    const changed = checkpointTables.writePolicy(...args);
                    if (changed) {
                        countWrite();
                    }
                    return changed;
                });
            },
            sweep() {
                assertWritable();
                return transactionInScope(() => {
                    const removed = checkpointTables.sweep();
                    if (removed > 0) {
                        countWrite();
                    }
                    return removed;
                });
            },
        },

        /**
         * Throws `ResourceEpochError` unless `expected` is the current epoch. Call it in the same
         * synchronous block as the write it guards, with no await in between.
         */
        assertEpoch(expected: string | undefined): void {
            assertEpochNow(expected);
        },

        /** A record's current revision token, or null when it does not exist; its data is not read. */
        revisionOf(kind: ResourceKind, id: string): string | null {
            assertOpen();
            assertKind(kind);
            assertId(kind, id);
            const row = selectRevision.get(kind.name, id) as { seq: number; revision: number } | undefined;
            return row ? token(row.seq, row.revision) : null;
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
         * `chats`, also every chat (metadata plus messages in order) and every chat order; with
         * `chatSummaries` (not together with `chats`), every chat's summary (no message rows read)
         * and every chat order.
         */
        readKinds(
            kindList: readonly ResourceKind[],
            options: { chats?: boolean; chatSummaries?: boolean } = {},
        ): {
            epoch: string;
            kinds: Record<string, StoredResource<unknown>[]>;
            chats?: ChatRecord[];
            chatSummaries?: ChatSummary[];
            chatOrders?: ChatOrderRecord[];
        } {
            assertOpen();
            const result: Record<string, StoredResource<unknown>[]> = Object.create(null);
            for (const kind of kindList) {
                assertKind(kind);
                result[kind.name] = readKind(kind);
            }
            if (options.chats && options.chatSummaries) {
                throw new TypeError("readKinds: chats and chatSummaries are exclusive");
            }
            if (options.chats) {
                return { epoch, kinds: result, ...chatTables.readAll() };
            }
            if (options.chatSummaries) {
                return { epoch, kinds: result, ...chatTables.readSummaries() };
            }
            return { epoch, kinds: result };
        },

        /**
         * Named records, read in one synchronous call; a missing one has revision and data null.
         * `chats` names single chats (missing: revision and data null); `chatCollections` names
         * characters whose order and every chat are read (no order: null); `chatSummaryCollections`
         * names characters whose order and every chat's summary are read (no message rows).
         */
        readRefs(
            refs: readonly { kind: ResourceKind; id: string }[],
            options: {
                chats?: readonly { characterId: string; id: string }[];
                chatCollections?: readonly string[];
                chatSummaryCollections?: readonly string[];
            } = {},
        ) {
            assertOpen();
            const items = refs.map(({ kind, id }) => {
                assertKind(kind);
                assertId(kind, id);
                const row = readOne(kind, id);
                return { kind: kind.name, id, revision: row?.revision ?? null, data: row?.data ?? null };
            });
            const chats = (options.chats ?? []).map(({ characterId, id }) => readChatOrMissing(characterId, id));
            const chatCollections = (options.chatCollections ?? []).map((characterId) => {
                const collection = chatTables.readCollection(characterId);
                return { characterId, order: collection?.order ?? null, chats: collection?.chats ?? [] };
            });
            if (!options.chatSummaryCollections || options.chatSummaryCollections.length === 0) {
                return { epoch, items, chats, chatCollections };
            }
            const chatSummaryCollections = options.chatSummaryCollections.map((characterId) => {
                const collection = chatTables.readCollectionSummaries(characterId);
                return { characterId, order: collection?.order ?? null, chats: collection?.chats ?? [] };
            });
            return { epoch, items, chats, chatCollections, chatSummaryCollections };
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
            return publishing(() =>
                atomically(() => {
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
                            const order = chatTables.createOrder(id);
                            if (order !== null) {
                                recordOrder(id, order);
                            }
                        }
                    } else {
                        const base = parseToken(baseRevision);
                        if (!base) {
                            conflict(kind, id);
                        }
                        revision = nextRevision(base.revision, 1);
                        if (
                            update.run(kind.schemaVersion, text, kind.name, id, base.seq, base.revision).changes === 0
                        ) {
                            conflict(kind, id);
                        }
                        seq = base.seq;
                    }
                    countWrite();
                    recordResource(kind.name, id, token(seq, revision));
                    return { revision: token(seq, revision), data: stored as T };
                }),
            );
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
            publishing(() =>
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
                        recordCharacterCascade(id, chatTables.deleteCharacter(id));
                    }
                    countWrite();
                    recordResource(kind.name, id, null);
                }),
            );
        },

        /**
         * Every record's, chat's, and chat order's revision, without data, in one synchronous read:
         * what a client reconciles against after it (re)connects to the live-update socket.
         */
        listRevisions(): ResourceRevisionListing {
            assertOpen();
            const resources = (selectRevisions.all() as { kind: string; id: string; seq: number; revision: number }[])
                .filter((row) => kinds.has(row.kind))
                .map((row) => ({ kind: row.kind, id: row.id, revision: token(row.seq, row.revision) }));
            return { epoch, resources, ...chatTables.listRevisions() };
        },

        /**
         * One chat (missing: revision and data null, as in `readRefs`) with its source generation,
         * read in one synchronous call: a snapshot of the chat and the generation it belongs to.
         */
        readChatSource(characterId: string, id: string): ChatRead & { sourceGeneration: number } {
            assertOpen();
            return { ...readChatOrMissing(characterId, id), sourceGeneration: sourceGenerationOf(characterId, id) };
        },

        /**
         * A chat's source generation (no row is read; a missing chat has one too): equal values in
         * one epoch mean no write deleted the chat, replaced it whole, or deleted its character in
         * between. Process memory, compared only for equality; `replaceAll` gives every chat a new
         * one, without a notice (the `epoch` feed event is that signal).
         */
        chatSourceGeneration(characterId: string, id: string): number {
            assertOpen();
            return sourceGenerationOf(characterId, id);
        },

        /**
         * Calls `listener` with a `ChatInvalidation` for every chat a committed write deleted,
         * replaced whole, or deleted with its character: once per chat and transaction, after the
         * transaction committed and its change was published, never for a rolled-back one (see
         * `deliverInvalidations`). Returns the removal.
         */
        onChatInvalidated(listener: (notice: ChatInvalidation) => void): () => void {
            assertOpen();
            invalidationListeners.add(listener);
            return () => {
                invalidationListeners.delete(listener);
            };
        },

        /** A chat's revision token, or null when it does not exist (its messages are not read). */
        chatRevision(characterId: string, id: string): string | null {
            assertOpen();
            return chatTables.chatRevision(characterId, id);
        },

        /** A chat's summary (its listed fields and revision; its messages are not read), or null when it does not exist. */
        chatSummary(characterId: string, id: string): ChatSummary | null {
            assertOpen();
            return chatTables.readChatSummary(characterId, id);
        },

        /** A chat's metadata and revision with an empty `message` list (its messages are not read), or null when it does not exist. */
        chatMeta(characterId: string, id: string): ChatRecord | null {
            assertOpen();
            return chatTables.readChatMeta(characterId, id);
        },

        /**
         * One page of a message search (`shared/messageSearch.ts`): `LIKE` over each message's text
         * (`$.data`), chats by `seq` descending and messages by position descending, in synchronous
         * batches (`chatTables.searchBatch`) with `yieldTurn` between them, on this store's one
         * connection. Without ids it scans every character except trashed ones (`trashTime`) and the
         * playground; a named character or chat is scanned even when trashed (`notFound` when it does
         * not exist). The page ends after the row that reaches `limit` hits or `budgetBytes` (its
         * `next` is that row) or at the end (`next` null). Before the first batch and after every
         * yield it checks, in order: `signal` (throws its reason), the store being open
         * (`ResourceStoreClosedError`), the epoch (`MessageSearchEpochError` once a restore replaced
         * the data), and `between` (the route's maintenance gate). A character's eligibility and name
         * are read once per page, so trashing one mid-page takes effect on the next page. Refuses to
         * start inside a store transaction.
         */
        async searchMessages(
            request: {
                query: string;
                characterId?: string;
                chatId?: string;
                cursor: MessageSearchPosition | null;
                limit: number;
            },
            options: MessageSearchLimits & { signal?: AbortSignal; between?: () => void },
        ): Promise<MessageSearchOutcome> {
            if (db.isTransaction) {
                throw new Error("A message search cannot run inside a transaction");
            }
            const check = () => {
                options.signal?.throwIfAborted();
                assertOpen();
            };
            check();
            options.between?.();
            const startEpoch = epoch;
            const characters = new Map<string, { name: string; trashed: boolean } | null>();
            /** The character's search fields and what reading them cost (0 once cached). */
            const character = (id: string) => {
                const cached = characters.get(id);
                if (cached !== undefined) {
                    return { info: cached, bytes: 0 };
                }
                const row = selectSearchCharacter.get(RESOURCE_KIND.characters, id) as
                    { name: unknown; trashTime: unknown; bytes: number } | undefined;
                const info = row
                    ? { name: typeof row.name === "string" ? row.name : "", trashed: !!row.trashTime }
                    : null;
                characters.set(id, info);
                return { info, bytes: row?.bytes ?? 0 };
            };
            let scope: MessageSearchScope;
            if (request.characterId === undefined) {
                scope = {
                    kind: "all",
                    eligible: (id) => {
                        if (id === PLAYGROUND_CHARACTER_ID) {
                            return { eligible: false, bytes: 0 };
                        }
                        const { info, bytes } = character(id);
                        return { eligible: !!info && !info.trashed, bytes };
                    },
                };
            } else {
                if (!character(request.characterId).info) {
                    return { notFound: "character" };
                }
                if (request.chatId === undefined) {
                    scope = { kind: "character", characterId: request.characterId };
                } else {
                    const seq = chatTables.chatSeq(request.characterId, request.chatId);
                    if (seq === null) {
                        return { notFound: "chat" };
                    }
                    scope = { kind: "chat", seq };
                }
            }
            // Escaped, so `\`, `%` and `_` in the query match themselves.
            const pattern = `%${request.query.replace(/[\\%_]/g, "\\$&")}%`;
            const hits: MessageSearchHit[] = [];
            const chatNames = new Map<number, string>();
            let scannedBytes = 0;
            const visit = (chat: MessageSearchChat, row: MessageSearchRow) => {
                scannedBytes += row.bytes;
                if (row.hit !== null) {
                    const message = JSON.parse(row.hit) as { role?: unknown; data?: unknown; time?: unknown };
                    const match = messageSearchSnippet(
                        typeof message.data === "string" ? message.data : "",
                        request.query,
                    );
                    if (!match) {
                        return scannedBytes >= options.budgetBytes;
                    }
                    let chatName = chatNames.get(chat.seq);
                    if (chatName === undefined) {
                        chatName = chatTables.searchChatName(chat.seq);
                        chatNames.set(chat.seq, chatName);
                    }
                    const { snippet, matchStart, matchLength } = match;
                    hits.push({
                        characterId: chat.characterId,
                        chatId: chat.id,
                        messageId: row.id,
                        chatName,
                        characterName: character(chat.characterId).info?.name ?? "",
                        role: message.role === "user" ? "user" : "char",
                        ...(typeof message.time === "number" && Number.isFinite(message.time)
                            ? { time: message.time }
                            : {}),
                        snippet,
                        matchStart,
                        matchLength,
                    });
                }
                return hits.length >= request.limit || scannedBytes >= options.budgetBytes;
            };
            let resume: MessageSearchResume = request.cursor ? { message: request.cursor } : null;
            for (;;) {
                const batch = chatTables.searchBatch({
                    scope,
                    pattern,
                    from: resume,
                    maxRows: options.batchRows,
                    maxBytes: options.batchBytes,
                    visit,
                });
                resume = batch.resume;
                if (batch.stopped && resume && "message" in resume) {
                    return { hits, next: resume.message, scannedBytes };
                }
                if (batch.end) {
                    return { hits, next: null, scannedBytes };
                }
                await options.yieldTurn();
                check();
                if (epoch !== startEpoch) {
                    throw new MessageSearchEpochError();
                }
                options.between?.();
            }
        },

        /**
         * The revision of every record of several kinds, without data (nothing is parsed), in one
         * synchronous read: the same tokens `readKinds` returns for them, in creation order.
         */
        readKindRevisions(kindList: readonly ResourceKind[]): {
            epoch: string;
            kinds: Record<string, { id: string; revision: string }[]>;
        } {
            assertOpen();
            const result: Record<string, { id: string; revision: string }[]> = Object.create(null);
            for (const kind of kindList) {
                assertKind(kind);
                const rows = selectKindRevisions.all(kind.name) as { id: string; seq: number; revision: number }[];
                result[kind.name] = rows.map((row) => ({ id: row.id, revision: token(row.seq, row.revision) }));
            }
            return { epoch, kinds: result };
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
         *
         * `options.inTransaction`: `before(tx)` runs after BEGIN, before any batch writes;
         * `after(applied, tx)` runs only with no conflicts, before COMMIT. Both must be synchronous:
         * a throw or returned thenable rolls back the entire batch, including checkpoint writes.
         * `tx` exposes only save/prune/setFloor/readPolicy/writePolicy, joins this transaction, and
         * expires when its callback returns. Public store writes from a callback or its asynchronous
         * continuations throw. Callback writes count toward `writeCount` only after COMMIT.
         *
         * `options.committed` (a generation job's write): runs once the write has committed, before
         * its change is published, and returns the generation locks of the chats it touched, which
         * the published change carries (`streaming`). It runs whether or not a feed is attached and
         * must not write to the store. If it throws, the committed change is still published (without
         * its lists) and the error is rethrown as `CommittedWriteError`: the write is not undone.
         */
        applyChanges(
            batch: {
                ops?: readonly ResourceBatchOperation[];
                chats?: unknown;
                chatOrders?: unknown;
            },
            options: {
                epoch?: string;
                jobToken?: string;
                inTransaction?: ApplyChangesTransaction;
                committed?: (applied: AppliedChanges) => readonly ChatStreaming[];
            } = {},
        ): AppliedChanges {
            assertWritable();
            const { committed } = options;
            if (!committed) {
                return publishing(() => applyChangesInScope(batch, options));
            }
            const failure: { error?: unknown } = {};
            const applied = publishing(() => {
                const result = applyChangesInScope(batch, options);
                try {
                    for (const entry of committed(result)) {
                        recordStreaming(entry);
                    }
                } catch (error) {
                    failure.error = error;
                }
                return result;
            });
            if ("error" in failure) {
                throw new CommittedWriteError(failure.error);
            }
            return applied;
        },

        /**
         * Publishes generation locks without a write (`streaming` of a change with no refs): a
         * generation job's end released them. Inside a publishing write it goes with that write.
         */
        publishStreaming(entries: readonly ChatStreaming[]) {
            if (entries.length === 0) {
                return;
            }
            publishing(() => {
                for (const entry of entries) {
                    recordStreaming(entry);
                }
            });
        },

        /**
         * Runs `fn` in one `BEGIN IMMEDIATE` transaction and commits when it returns. A throw, or any
         * conflict inside it (even one `fn` caught), rolls back every write. `fn` must be synchronous:
         * the transaction is never held across an await, and a returned promise or thenable rolls back
         * and throws. Once `fn` returns, a store write from work it started through awaits, promise
         * continuations, or timers throws, so that work cannot autocommit after a rollback. Callbacks
         * `fn` registers on an event emitter do not carry that scope and are not covered. What the
         * writes inside it changed is published once, after the commit.
         */
        transaction<F extends () => unknown>(fn: TransactionBody<F>): ReturnType<F> {
            return publishing(() => transactionInScope(fn));
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

        /** Reads and checks a snapshot file with this store's registered kinds. */
        readSnapshot(file: string): ValidatedSnapshot {
            return readSnapshotFile(file, kinds);
        },

        /**
         * Replaces every record with the rows of a validated snapshot, runs the normalization pass
         * (creating the `materialize` singletons the snapshot lacks), and gives the database a new
         * epoch, in one transaction; every token issued before is stale afterwards. Returns the epoch.
         * Revision counters are restored as stored (the new epoch already makes every old token
         * stale; `nextRevision` keeps a counter a crafted snapshot placed at the limit from
         * overflowing on the next write). Replaces checkpoints, their content pages, and policies
         * with the snapshot's, attached to the restored chats with their text unchanged; a snapshot
         * without checkpoint rows clears them.
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
                const chatSeqs = chatTables.replaceAll(snapshot);
                checkpointTables.replaceAll(snapshot.checkpoints, chatSeqs);
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
            patchBases.clear();
            sourceGenerations.clear();
            lastSourceGeneration += 1;
            baseSourceGeneration = lastSourceGeneration;
            // Every client reloads: their tokens are of the old epoch. An epoch listener's write
            // delivers its notices after every listener had the epoch.
            publishingDepth += 1;
            try {
                feed?.publish({ type: "epoch", epoch: nextEpoch });
            } finally {
                publishingDepth -= 1;
                deliverInvalidations();
            }
            return nextEpoch;
        },

        close() {
            if (closed) {
                return;
            }
            closed = true;
            patchBases.clear();
            sourceGenerations.clear();
            invalidationListeners.clear();
            db.close();
        },
    };
    return store;
}

/**
 * Checks a patch op's patch before the transaction: a field patch (`{ set?, remove? }`) or an item
 * patch (`{ items?, changes?, order? }`, never mixed), for a kind whose data reaches clients as stored
 * and is not prepared from the stored record (`project`, `prepareWrite`: write-only `llmSecrets`).
 */
function preparePatch(kind: ResourceKind, patch: unknown): PreparedPatch {
    if (kind.project || kind.prepareWrite) {
        throw new ResourceValidationError(`${kind.name} takes no patch`);
    }
    if (!isPlainObject(patch)) {
        throw new ResourceValidationError("a patch is { set?, remove? } or { items?, changes?, order? }");
    }
    const itemForm = ["items", "changes", "order"].some((field) => Object.hasOwn(patch, field));
    try {
        if (itemForm) {
            if (Object.hasOwn(patch, "set") || Object.hasOwn(patch, "remove")) {
                throw new RecordPatchError("a patch is either a field patch or an item patch");
            }
            return { type: "items", ...checkItemPatch(patch) };
        }
        return { type: "fields", ...checkFields(patch.set, patch.remove, "a patch") };
    } catch (error) {
        if (error instanceof RecordPatchError) {
            throw new ResourceValidationError(error.message);
        }
        throw error;
    }
}

/**
 * `text` (a stored record) cut into its top-level parts, or null when it is neither an object nor an
 * array, or when its parts joined as `JSON.stringify` joins them are not exactly `text`.
 */
function cutRecord(text: string): PatchBase | null {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) {
        const items = new Map<unknown, string>();
        const parts = value.map((item) => {
            const part = JSON.stringify(item);
            items.set(item, part);
            return part;
        });
        return `[${parts.join(",")}]` === text ? { text, value, items } : null;
    }
    if (isPlainObject(value)) {
        const fields = new Map<string, string>();
        const parts: string[] = [];
        for (const field of Object.keys(value)) {
            const part = JSON.stringify(value[field]);
            fields.set(field, part);
            parts.push(`${JSON.stringify(field)}:${part}`);
        }
        return `{${parts.join(",")}}` === text ? { text, value, fields } : null;
    }
    return null;
}

/**
 * A patch applied to a cut record for a `shallowNormalize` kind, serializing only the parts the patch or
 * the normalizer replaced: the stored text, value, and parts that `serialize(normalizeInput(...))` of
 * the whole patched record would give. As there, the patched parts are serialized and read back in the
 * record's order before the normalizer gets the record (`storedParts`), their final text and value are
 * those of the value read back (`canonicalPart`), and the parts the normalizer replaced are serialized
 * in the result's order. Null when the patch does not fit this path (the record's shape, a field named
 * `toJSON`, a result of another shape); the caller then takes the whole-record path, which also reports
 * the errors of a patch that does not fit the record.
 */
function patchParts(kind: ResourceKind, id: string, cut: PatchBase, patch: PreparedPatch): PatchBase | null {
    if (patch.type === "fields") {
        if (!("fields" in cut) || patch.set.some(([field]) => field === "toJSON")) {
            return null;
        }
        const input = withFields(cut.value, patch.set, patch.remove);
        const named = new Set(patch.set.map(([field]) => field));
        const order = Object.keys(input).filter((field) => named.has(field));
        const read = storedParts(order.map((field) => [field, input[field]]));
        const patched = new Map<string, { text: string; stored: unknown }>();
        order.forEach((field, index) => {
            const part = read[index];
            if (part) {
                defineField(input, field, part.stored);
                patched.set(field, canonicalPart(part));
            } else {
                delete input[field];
            }
        });
        const normalized = kind.normalize(input, { id });
        if (!isPlainObject(normalized) || typeof normalized.toJSON === "function") {
            return null;
        }
        const keys = Object.keys(normalized);
        const members = keys.map((field) => normalized[field]);
        const texts = keys.map((field, index) => {
            const member = members[index];
            const part = patched.get(field);
            if (part) {
                if (!Object.is(member, input[field])) {
                    return undefined;
                }
                members[index] = part.stored;
                return part.text;
            }
            return Object.hasOwn(cut.value, field) && Object.is(member, cut.value[field])
                ? cut.fields.get(field)
                : undefined;
        });
        const replaced = keys.flatMap((field, index) =>
            texts[index] === undefined ? [[field, members[index]] as const] : [],
        );
        const replacedRead = storedParts(replaced);
        const replacedParts = new Map(replaced.map(([field], index) => [field, replacedRead[index]]));
        const value: Record<string, unknown> = {};
        const fields = new Map<string, string>();
        const parts: string[] = [];
        keys.forEach((field, index) => {
            let text = texts[index];
            let stored = members[index];
            if (text === undefined) {
                const part = replacedParts.get(field);
                if (!part) {
                    return;
                }
                ({ text, stored } = part);
            }
            defineField(value, field, stored);
            fields.set(field, text);
            parts.push(`${JSON.stringify(field)}:${text}`);
        });
        return { text: `{${parts.join(",")}}`, value, fields };
    }
    if (!("items" in cut)) {
        return null;
    }
    const input: unknown[] = applyItemPatch(cut.value, patch);
    const fresh = input.flatMap((item, index) => (cut.items.has(item) ? [] : [[String(index), item] as const]));
    const read = storedParts(fresh);
    const patched = new Map<unknown, { text: string; stored: unknown }>();
    fresh.forEach(([key], index) => {
        const part = read[index] ?? { text: "null", stored: null };
        input[Number(key)] = part.stored;
        patched.set(part.stored, canonicalPart(part));
    });
    const normalized = kind.normalize(input, { id });
    if (!Array.isArray(normalized) || typeof (normalized as { toJSON?: unknown }).toJSON === "function") {
        return null;
    }
    const list = normalized as unknown[];
    const members = Array.from({ length: list.length }, (_, index) => list[index]);
    const texts = members.map((item, index) => {
        const part = patched.get(item);
        if (part) {
            members[index] = part.stored;
            return part.text;
        }
        return cut.items.get(item);
    });
    const replaced = members.flatMap((item, index) =>
        texts[index] === undefined ? [[String(index), item] as const] : [],
    );
    const replacedParts = storedParts(replaced);
    replaced.forEach(([key], index) => {
        const part = replacedParts[index];
        texts[Number(key)] = part ? part.text : "null";
        members[Number(key)] = part ? part.stored : null;
    });
    const items = new Map<unknown, string>();
    members.forEach((item, index) => items.set(item, texts[index]!));
    return { text: `[${texts.join(",")}]`, value: members, items };
}

/**
 * A patched part as the old path's second serialization stores it: the text of the value read back
 * (`JSON.stringify` of it), and that text read again when it differs (a `JSON.rawJSON` such as `-0` or
 * `1e2` reads back as a number whose own text is another), so the cached value is the stored text's.
 */
function canonicalPart(part: { text: string; stored: unknown }): { text: string; stored: unknown } {
    const text = JSON.stringify(part.stored);
    return text === part.text ? part : { text, stored: JSON.parse(text) };
}

/**
 * Parts of a record (fields by name, items by index, in the record's order) as `serialize` of the whole
 * record treats them: each stringified as its key's member of a holder (the replacer; a `toJSON` gets its
 * own key), all of them before any is read back and checked from the record's root (`readStored`), so
 * hooks run and refusals come in the whole record's order. Per part its text and the value read back,
 * or null for a part `JSON.stringify` leaves out (an item that has no JSON is `null`, as in a list).
 */
function storedParts(parts: readonly (readonly [string, unknown])[]): ({ text: string; stored: unknown } | null)[] {
    const texts = parts.map(([key, value]) => stringifyStored({ [key]: value }));
    return texts.map((text, index) => {
        const key = parts[index][0];
        const holder = readStored(text) as Record<string, unknown>;
        return Object.hasOwn(holder, key)
            ? { text: text.slice(JSON.stringify(key).length + 2, -1), stored: holder[key] }
            : null;
    });
}

function defineField(target: Record<string, unknown>, field: string, value: unknown) {
    Object.defineProperty(target, field, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * What the change feed carries for a patch op that stored `stored` over `old`: for an object record
 * every top-level field whose stored JSON value differs (`diffFields`, normalization included), for
 * an item list the changed items (`diffItems`). The slow path compares stored texts (`diffRecordText`),
 * since its normalizer clones even unchanged values. None (a plain ref) for a kind whose data does not
 * reach clients as stored, for a changed `__proto__` field, for a record that is neither shape before
 * and after, or for a patch over `MAX_FEED_PATCH_BYTES`.
 */
function feedPatch(
    kind: ResourceKind,
    baseRevision: string,
    old: unknown,
    stored: unknown,
    texts?: { old: string; next: string },
): RecordPatch | undefined {
    if (kind.project || HIDDEN_HYDRATION_KINDS.includes(kind.name)) {
        return undefined;
    }
    let patch: RecordPatch | undefined;
    if (texts) {
        const diff = diffRecordText(texts.old, texts.next, old, stored);
        patch = diff ? { baseRevision, ...diff } : undefined;
    } else if (isPlainObject(old) && isPlainObject(stored)) {
        const fields = diffFields(old, stored);
        patch = fields ? { baseRevision, ...fields } : undefined;
    } else if (Array.isArray(old) && Array.isArray(stored)) {
        const items = diffItems(old, stored);
        patch = items ? { baseRevision, ...items } : undefined;
    }
    if (!patch) {
        return undefined;
    }
    // A copy: the values it names are the store's own (`patchBases`), which a listener must not reach.
    const text = JSON.stringify(patch);
    return Buffer.byteLength(text) <= MAX_FEED_PATCH_BYTES ? (JSON.parse(text) as RecordPatch) : undefined;
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
 * refuse as output is refused before normalizing: the settings normalizers copy through JSON
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
 * the text and the value parsed back from it, which is what a read returns. `arrayElementDepth`
 * measures a root array's elements separately, for a whole chat's independently stored messages;
 * serialization still uses the whole array's toJSON and element keys.
 */
export function serialize(
    value: unknown,
    options: { arrayElementDepth?: boolean } = {},
): { text: string; stored: unknown } {
    const text = stringifyStored(value);
    return { text, stored: readStored(text, options.arrayElementDepth) };
}

/** `serialize`'s first half: the text, or the refusal of a value `JSON.stringify` cannot store. */
function stringifyStored(value: unknown): string {
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
    return text;
}

/** `serialize`'s second half: the value read back from the text, checked (`assertStoredJson`). */
function readStored(text: string, arrayElementDepth = false): unknown {
    const stored: unknown = JSON.parse(text);
    assertStoredJson(stored, arrayElementDepth && Array.isArray(stored) ? -1 : 0);
    return stored;
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
 * version-1 database (characters with embedded chats) and a version-2 one (settings in a `root`
 * record) are refused: no migration is owed (formats the server read during development, the
 * compatibility rule in `docs/structure/persistence.md`).
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
            `${file} holds resource database version 2 (settings in one root record), which ` +
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
