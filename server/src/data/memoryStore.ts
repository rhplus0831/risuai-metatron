import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseContextReport } from "../../../shared/contextReport.ts";
import type { Message } from "../../../shared/database.ts";
import type { SerializableHypaV3Data } from "../../../shared/memory.ts";
import { MAX_READ_RESPONSE_BYTES } from "../../../shared/resources.ts";
import {
    MEMORY_EVENT_STATUSES,
    MEMORY_PAGE_TYPES,
    MEMORY_RECORD_KINDS,
    MEMORY_RUN_RESULTS,
    MEMORY_THREAD_STATES,
    projectHypaV3Data,
    reconcileMemoryEvents,
    storedMemorySources,
} from "../../../shared/structuredMemory.ts";
import type {
    MemoryEvent,
    MemoryManifest,
    MemoryPage,
    MemoryRun,
    MemoryThread,
    StructuredMemoryContents,
    StructuredMemoryRecordKind,
    StructuredMemoryRecordOf,
} from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { STAGED_CHAT_SEQS } from "./chatStore.ts";
import {
    isValidResourceId,
    nextRevision,
    ResourceConflictError,
    ResourceValidationError,
    serialize,
    snapshotRows,
} from "./resourceStore.ts";

/**
 * Structured memory's tables in the resource database (`MEMORY_TABLES_SQL` in `chatStore.ts`): a chat's
 * pages, events, threads, and writer runs, and `memory_state` with the one revision that covers them
 * all and whether a person declined adopting the chat's HypaV3 summaries. Every row belongs to a chat's
 * incarnation and goes with it by cascade. `data` holds the whole record, so a page's sections stay
 * embedded in its row.
 *
 * The resource store owns the connection, the epoch, and the transactions: the writers here join the
 * caller's open transaction and never begin or commit one, so a caller can compose them with its own
 * work. Past `createMemoryTables`, only a restore writes these tables: its staged writer
 * (`createMemoryStagingSink`) and the install's copy (`copyStagedMemory`).
 *
 * The revision is a counter in `memory_state` and a token (`tokens.token(chatSeq, revision)`) everywhere
 * else: a token carries the chat's incarnation, so a writer that read a deleted chat cannot match the
 * chat recreated under its ids. An existing chat with no `memory_state` row is at revision 0.
 *
 * A write checks a record's id, what it copies into columns, and its stored size. Full record shape is
 * not validated here: the callers own it.
 */

type TokenFunctions = {
    token(seq: number, revision: number): string;
    parse(value: string): { seq: number; revision: number } | null;
};

type ChatRow = { seq: number };

/** The record each kind holds. */
export type MemoryRecordOf = StructuredMemoryRecordOf;

export type MemoryRecordKind = StructuredMemoryRecordKind;

/** An event as a writer hands it over: the store stamps `createdRevision`. */
export type MemoryEventWrite = Omit<MemoryEvent, "createdRevision">;

/**
 * What one write changes: records to insert or update by id, ids to remove, and a person's decline of
 * adopting the chat's HypaV3 summaries, which is one-way, so nothing here clears it. A decline moves the
 * revision as a record does, on a chat that has not declined yet; on one that has it names nothing.
 */
export type MemoryChanges = {
    pages?: MemoryPage[];
    events?: MemoryEventWrite[];
    threads?: MemoryThread[];
    runs?: MemoryRun[];
    remove?: { pages?: string[]; events?: string[]; threads?: string[]; runs?: string[] };
    adoptionDeclined?: true;
};

/** `wrote` is false when the change set named nothing, so the owner counts only real writes. */
export type MemoryWriteResult = { revision: string; wrote: boolean };

/**
 * A chat's table of contents, with the memory revision a write based on it names. `adoptionDeclined` is
 * there only for a chat that declined.
 */
export type MemoryContents = StructuredMemoryContents & { adoptionDeclined?: true };

/** A chat as the revision check names it. */
export type MemoryChatRef = { characterId: string; chatId: string };

/** A record's body, with the memory revision an edit of it names. */
export type MemoryRecordRead<K extends MemoryRecordKind> = { revision: string; data: MemoryRecordOf[K] };

/** Each kind's records as their stored texts, in storage order: what `replace` makes a chat's memory. */
export type MemoryRowTexts = Readonly<Record<MemoryRecordKind, readonly string[]>>;

/**
 * Where `walkMemorySnapshot` hands what it checked, as it reads it: every `memory_state` row, then each
 * record table by `seq`. `row` is the record's columns after `chatSeq`, as `upsert` binds them.
 */
export type MemorySnapshotSink = {
    state(row: { chatSeq: number; revision: number; adoptionDeclined: number }): void;
    record(kind: MemoryRecordKind, chatSeq: number, row: readonly (string | number)[]): void;
};

/** One `memory_events` row of a snapshot, as `readSnapshotFile` collects it. */
export type MemoryEventRow = { readonly chatSeq: number; readonly data: string };

/** What sets one record table apart from the others; everything else is one code path. */
type MemoryTable = {
    table: string;
    /** Whether the kind has a `title` column. */
    titled: boolean;
    /** The column holding the kind's closed value, named as the record's own field. */
    statusColumn: string;
    /** The shared list of what that column allows, so a value added there follows. */
    statusValues: readonly string[];
    /** Whether the store stamps `createdRevision` on the record. */
    stamped: boolean;
};

const MEMORY_TABLES: Record<MemoryRecordKind, MemoryTable> = {
    pages: {
        table: "memory_pages",
        titled: true,
        statusColumn: "type",
        statusValues: MEMORY_PAGE_TYPES,
        stamped: false,
    },
    events: {
        table: "memory_events",
        titled: true,
        statusColumn: "status",
        statusValues: MEMORY_EVENT_STATUSES,
        stamped: true,
    },
    threads: {
        table: "memory_threads",
        titled: true,
        statusColumn: "state",
        statusValues: MEMORY_THREAD_STATES,
        stamped: false,
    },
    runs: {
        table: "memory_runs",
        titled: false,
        statusColumn: "result",
        statusValues: MEMORY_RUN_RESULTS,
        stamped: false,
    },
};

/** Column names of the memory tables, in `PRAGMA table_xinfo` order (snapshot layout check). */
const MEMORY_TABLE_COLUMNS: Record<string, readonly string[]> = {
    memory_state: ["chatSeq", "revision", "adoptionDeclined"],
    memory_pages: ["seq", "chatSeq", "id", "type", "title", "data"],
    memory_events: ["seq", "chatSeq", "id", "title", "status", "createdRevision", "data"],
    memory_threads: ["seq", "chatSeq", "id", "title", "state", "data"],
    memory_runs: ["seq", "chatSeq", "id", "result", "data"],
};

/** `memory_state` in a snapshot from before `adoptionDeclined`, whose chats read as not declined. */
const MEMORY_STATE_COLUMNS_BEFORE_DECLINE: readonly string[] = ["chatSeq", "revision"];

/** The columns a table of contents lists. */
function listedColumns({ titled, statusColumn }: MemoryTable): string[] {
    return ["id", ...(titled ? ["title"] : []), statusColumn];
}

/** The columns a write binds after `chatSeq`, in that order. */
function writtenColumns(description: MemoryTable): string[] {
    return [...listedColumns(description), ...(description.stamped ? ["createdRevision"] : []), "data"];
}

/** The insert of one record's row, which takes `seq` from the table. */
function insertRecordSql(description: MemoryTable): string {
    const written = writtenColumns(description);
    return `INSERT INTO ${description.table} (chatSeq, ${written.join(", ")}) VALUES (?${", ?".repeat(written.length)})`;
}

/** One record table's statements, built from its description. */
function prepareTable(db: DatabaseSync, description: MemoryTable) {
    const { table } = description;
    const listed = listedColumns(description);
    // An update leaves `id` and `createdRevision` as the row has them.
    const updates = writtenColumns(description)
        .filter((column) => column !== "id" && column !== "createdRevision")
        .map((column) => `${column} = excluded.${column}`);
    return {
        // `octet_length` takes the size from the row's header, so a listing loads no record's text.
        selectContents: db.prepare(
            `SELECT ${listed.join(", ")}, octet_length(data) AS bytes FROM ${table} WHERE chatSeq = ? ORDER BY seq`,
        ),
        selectRecord: db.prepare(`SELECT data FROM ${table} WHERE chatSeq = ? AND id = ?`),
        selectSeqs: db.prepare(`SELECT seq FROM ${table} WHERE chatSeq = ? ORDER BY seq`),
        selectRow: db.prepare(`SELECT id, data FROM ${table} WHERE seq = ?`),
        remove: db.prepare(`DELETE FROM ${table} WHERE chatSeq = ? AND id = ?`),
        removeAll: db.prepare(`DELETE FROM ${table} WHERE chatSeq = ?`),
        insert: db.prepare(insertRecordSql(description)),
        // Never `INSERT OR REPLACE`: an updated record keeps its `seq`.
        upsert: db.prepare(
            `${insertRecordSql(description)} ON CONFLICT (chatSeq, id) DO UPDATE SET ${updates.join(", ")}`,
        ),
    };
}

function refusal(kind: MemoryRecordKind, id: unknown, reason: string) {
    return new ResourceValidationError(`Memory ${kind} ${JSON.stringify(id)}: ${reason}`);
}

/** A record's row as `upsert` binds it, `id` first. */
type RecordRow = [id: string, ...columns: (string | number)[]];

/**
 * Checks the fields a record gives its columns and returns the row up to its status column, every value
 * taken from `stored`, the record as stored. A live write and a snapshot's walk both come through here,
 * so one code path decides what a row's columns hold. `claimId` takes the id once it is valid, before
 * any other field is looked at, so the caller can refuse one it already saw.
 */
function recordRow(kind: MemoryRecordKind, stored: Record<string, unknown>, claimId: (id: string) => void): RecordRow {
    const { titled, statusColumn, statusValues } = MEMORY_TABLES[kind];
    const { id, title } = stored;
    if (!isValidResourceId(id)) {
        throw refusal(kind, id, "invalid id");
    }
    claimId(id);
    const row: RecordRow = [id];
    if (titled) {
        if (typeof title !== "string") {
            throw refusal(kind, id, "title must be a string");
        }
        row.push(title);
    }
    const status = stored[statusColumn];
    if (typeof status !== "string" || !statusValues.includes(status)) {
        throw refusal(kind, id, `${statusColumn} must be one of ${statusValues.join(", ")}`);
    }
    row.push(status);
    return row;
}

/**
 * What `checkMemoryRow` reports of a row for the rules that span rows, each as soon as it is known: `id`
 * takes a valid id, `scene` a scene page.
 */
export type MemoryRowClaims = { id(id: string): void; scene(): void };

/** Claims that refuse a repeat, for one chat's rows of one kind: the same id in another kind is legal. */
export function memoryRowClaims(): MemoryRowClaims {
    const ids = new Set<string>();
    let scene = false;
    return {
        id(id) {
            if (ids.has(id)) {
                throw new ResourceValidationError("duplicate id in chat");
            }
            ids.add(id);
        },
        scene() {
            if (scene) {
                throw new ResourceValidationError("a second scene page in chat");
            }
            scene = true;
        },
    };
}

/**
 * Checks a record's stored text as a row of `kind` and returns the row as `insert` binds it, with `text`
 * verbatim as `data` and every other column taken from the record. A snapshot's rows, a checkpoint's
 * chunks, and `replace` all come through here, so a row one of them accepts the others accept. A refusal
 * is a `ResourceValidationError` that opens with `where`. An event's `createdRevision` must lie within
 * `maxCreatedRevision`.
 */
export function checkMemoryRow(
    where: string,
    kind: MemoryRecordKind,
    text: string,
    claims: MemoryRowClaims,
    maxCreatedRevision: number,
): RecordRow {
    try {
        if (Buffer.byteLength(text, "utf8") > MAX_READ_RESPONSE_BYTES) {
            throw new ResourceValidationError(`data is longer than ${MAX_READ_RESPONSE_BYTES} bytes`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new ResourceValidationError("data is not JSON");
        }
        const { stored } = serialize(parsed);
        const record = isPlainObject(stored) ? stored : {};
        const row = recordRow(kind, record, (id) => claims.id(id));
        if (kind === "pages" && record.type === "scene") {
            claims.scene();
        }
        if (MEMORY_TABLES[kind].stamped) {
            const { createdRevision } = record;
            if (!isPositiveSafeInteger(createdRevision) || createdRevision > maxCreatedRevision) {
                throw new ResourceValidationError("invalid createdRevision");
            }
            row.push(createdRevision);
        }
        row.push(text);
        return row;
    } catch (error) {
        if (error instanceof ResourceValidationError) {
            throw new ResourceValidationError(`${where}: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Prepares the memory statements and returns the methods over them; the tables must exist
 * (`openChatSchema` runs first). `write` and `replace` join the caller's open transaction.
 */
export function createMemoryTables(db: DatabaseSync, tokens: TokenFunctions) {
    const selectChat = db.prepare("SELECT seq FROM chats WHERE characterId = ? AND id = ?");
    const selectState = db.prepare("SELECT revision, adoptionDeclined FROM memory_state WHERE chatSeq = ?");
    // Only the revision: a record's write and a checkpoint load both leave a decline as it is.
    const upsertRevision = db.prepare(
        "INSERT INTO memory_state (chatSeq, revision) VALUES (?, ?) " +
            "ON CONFLICT (chatSeq) DO UPDATE SET revision = excluded.revision",
    );
    const setDeclined = db.prepare("UPDATE memory_state SET adoptionDeclined = 1 WHERE chatSeq = ?");
    const selectCreatedRevision = db.prepare("SELECT createdRevision FROM memory_events WHERE chatSeq = ? AND id = ?");
    const selectScenePage = db.prepare("SELECT id FROM memory_pages WHERE chatSeq = ? AND type = 'scene'");
    // A budgeted read's charges for the events a projection answers: stored sizes only.
    const sumChatEventBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(e.data)), 0) AS bytes FROM memory_events e " +
            "JOIN chats c ON c.seq = e.chatSeq WHERE c.characterId = ? AND c.id = ?",
    );
    const sumCharacterEventBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(e.data)), 0) AS bytes FROM memory_events e " +
            "JOIN chats c ON c.seq = e.chatSeq WHERE c.characterId = ?",
    );
    // The revision of a chat a whole read projects, with no message read. `json_array_length` mirrors
    // `hypaV3DataHoldsSummaries` on the stored metadata: NULL for a value without the list, 0 for a
    // `summaries` that is no list, so both own nothing.
    const selectProjectionRevision = db.prepare(
        "SELECT c.seq AS seq, COALESCE(s.revision, 0) AS revision FROM chats c " +
            "LEFT JOIN memory_state s ON s.chatSeq = c.seq " +
            "WHERE c.characterId = ? AND c.id = ? " +
            "AND EXISTS (SELECT 1 FROM memory_events e WHERE e.chatSeq = c.seq) " +
            "AND COALESCE(json_array_length(c.meta, '$.hypaV3Data.summaries'), 0) = 0",
    );
    const tables = {
        pages: prepareTable(db, MEMORY_TABLES.pages),
        events: prepareTable(db, MEMORY_TABLES.events),
        threads: prepareTable(db, MEMORY_TABLES.threads),
        runs: prepareTable(db, MEMORY_TABLES.runs),
    };

    /** The chat's `memory_state` row, or what a chat with none reads as. */
    function stateOf(seq: number): { revision: number; adoptionDeclined: number } {
        return (
            (selectState.get(seq) as { revision: number; adoptionDeclined: number } | undefined) ?? {
                revision: 0,
                adoptionDeclined: 0,
            }
        );
    }

    function revisionOf(seq: number): number {
        return stateOf(seq).revision;
    }

    /**
     * Refuses a change set that would leave a chat with anything but the scene page it has. A second
     * one is refused: two in the set, or one while the chat keeps another. The existing page must be the
     * same id or among `removed`, since removals run first; rewriting it to another type in the same set
     * is refused too, so the order of the upserts can never reach `memory_pages_scene`. Losing it is
     * refused as well: `removed` naming it with no scene row in the set, or a row retyping it. Replacing
     * it in one set is fine. A chat with no scene page yet has none to lose: the writer makes it. `rows`
     * are as `prepareKind` builds them: `id`, `title`, `type`.
     */
    function assertOneScene(seq: number, rows: readonly (string | number)[][], removed: ReadonlySet<string>) {
        if (rows.length === 0 && removed.size === 0) {
            return;
        }
        const [scene, second] = rows.filter(([, , type]) => type === "scene").map(([id]) => id);
        const kept = selectScenePage.get(seq) as { id: string } | undefined;
        if (second !== undefined || (scene !== undefined && kept && kept.id !== scene && !removed.has(kept.id))) {
            throw refusal("pages", second ?? scene, "a chat holds one scene page");
        }
        if (scene === undefined && kept) {
            if (removed.has(kept.id)) {
                throw refusal("pages", kept.id, "the scene page can only be replaced in one write");
            }
            if (rows.some(([id]) => id === kept.id)) {
                throw refusal("pages", kept.id, "the scene page keeps its type");
            }
        }
    }

    /**
     * Checks one kind's records and removals and returns the records as `upsert` binds them, every
     * value taken from the record as stored (`toJSON` applies). Reads only. `revision` is the one the
     * write moves to, which a new event is stamped with; an existing event keeps its own, in the column
     * and in the stored record alike, whatever the input held. The size is the final text's: `data`
     * embeds a page's sections and `STRUCTURED_MEMORY_LIMITS` bounds no body, so this is what keeps
     * every row within the read budget.
     */
    function prepareKind(
        kind: MemoryRecordKind,
        seq: number,
        revision: number,
        records: readonly unknown[],
        removed: readonly string[],
    ): (string | number)[][] {
        const { stamped } = MEMORY_TABLES[kind];
        const writtenIds = new Set<string>();
        const rows = records.map((record) => {
            const serialized = serialize(record);
            const stored = isPlainObject(serialized.stored) ? serialized.stored : {};
            const row = recordRow(kind, stored, (id) => {
                if (writtenIds.has(id)) {
                    throw refusal(kind, id, "written twice");
                }
                writtenIds.add(id);
            });
            const [id] = row;
            let { text } = serialized;
            if (stamped) {
                const existing = selectCreatedRevision.get(seq, id) as { createdRevision: number } | undefined;
                const createdRevision = existing?.createdRevision ?? revision;
                ({ text } = serialize({ ...stored, createdRevision }));
                row.push(createdRevision);
            }
            if (Buffer.byteLength(text, "utf8") > MAX_READ_RESPONSE_BYTES) {
                throw refusal(kind, id, `stored text is longer than ${MAX_READ_RESPONSE_BYTES} bytes`);
            }
            row.push(text);
            return row;
        });
        const removedIds = new Set<string>();
        for (const id of removed) {
            if (!isValidResourceId(id)) {
                throw refusal(kind, id, "invalid id");
            }
            if (writtenIds.has(id)) {
                throw refusal(kind, id, "both written and removed");
            }
            if (removedIds.has(id)) {
                throw refusal(kind, id, "removed twice");
            }
            removedIds.add(id);
        }
        if (kind === "pages") {
            assertOneScene(seq, rows, removedIds);
        }
        return rows;
    }

    return {
        /**
         * The table of contents, read without any record's body. Missing chat: null. Each list is in
         * `seq` order, which is storage order, not message order: an updated record keeps its place.
         * It says whether the chat declined adoption, and nothing else of its HypaV3 summaries.
         */
        readContents(characterId: string, chatId: string): MemoryContents | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return null;
            }
            const { revision, adoptionDeclined } = stateOf(chat.seq);
            return {
                revision: tokens.token(chat.seq, revision),
                pages: tables.pages.selectContents.all(chat.seq) as MemoryContents["pages"],
                events: tables.events.selectContents.all(chat.seq) as MemoryContents["events"],
                threads: tables.threads.selectContents.all(chat.seq) as MemoryContents["threads"],
                runs: tables.runs.selectContents.all(chat.seq) as MemoryContents["runs"],
                ...(adoptionDeclined === 1 ? { adoptionDeclined: true as const } : {}),
            };
        },

        /** One record by id, as stored. Missing chat or record: null. */
        readRecord<K extends MemoryRecordKind>(
            characterId: string,
            chatId: string,
            kind: K,
            id: string,
        ): MemoryRecordRead<K> | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return null;
            }
            const row = tables[kind].selectRecord.get(chat.seq, id) as { data: string } | undefined;
            if (!row) {
                return null;
            }
            return {
                revision: tokens.token(chat.seq, revisionOf(chat.seq)),
                data: JSON.parse(row.data) as MemoryRecordOf[K],
            };
        },

        /**
         * One kind's rows of the chat with this `seq`, in `seq` order and one at a time, each `id` and
         * `data` as stored. The order comes from a statement of its own: `ORDER BY seq` over `data`
         * would have SQLite sort every row's text before it answers the first.
         */
        *rows(chatSeq: number, kind: MemoryRecordKind): Generator<{ id: string; data: string }, void, undefined> {
            const { selectSeqs, selectRow } = tables[kind];
            for (const { seq } of selectSeqs.iterate(chatSeq) as Iterable<{ seq: number }>) {
                yield selectRow.get(seq) as { id: string; data: string };
            }
        },

        /** The events of the chat with this `seq` in `seq` order, parsed: none costs one statement. */
        readEvents(chatSeq: number): MemoryEvent[] {
            const { selectSeqs, selectRow } = tables.events;
            return (selectSeqs.all(chatSeq) as { seq: number }[]).map(({ seq }) => {
                const { data } = selectRow.get(seq) as { data: string };
                return JSON.parse(data) as MemoryEvent;
            });
        },

        /** The memory revision of the chat with this `seq`, one row: what a projection is sealed with. */
        revisionToken(chatSeq: number): string {
            return tokens.token(chatSeq, revisionOf(chatSeq));
        },

        /**
         * Per ref, in order, the memory revision of a chat a whole read projects, one statement each and
         * no message read: a missing chat, one whose stored `hypaV3Data` holds summaries, and one with no
         * event row answer null.
         */
        readProjectionRevisions(refs: readonly MemoryChatRef[]): (string | null)[] {
            return refs.map(({ characterId, chatId }) => {
                const row = selectProjectionRevision.get(characterId, chatId) as
                    { seq: number; revision: number } | undefined;
                return row ? tokens.token(row.seq, row.revision) : null;
            });
        },

        /** The stored bytes of a chat's events, 0 without any. */
        chatEventBytes(characterId: string, chatId: string): number {
            return (sumChatEventBytes.get(characterId, chatId) as { bytes: number }).bytes;
        },

        /** The stored bytes of the events of all a character's chats, 0 without any. */
        characterEventBytes(characterId: string): number {
            return (sumCharacterEventBytes.get(characterId) as { bytes: number }).bytes;
        },

        /**
         * Applies `changes` at exactly `baseRevision`: removals, then upserts, then the revision moves up
         * by one, however much changed. A missing chat is a `ResourceConflictError` with no current
         * revision, a base that is not the current token one naming the current token, and every other
         * refusal a `ResourceValidationError`. All of them come before the first statement that writes,
         * so a stale or refused write changes nothing and is never merged. Removing an id that does
         * not exist is no refusal and still moves the revision. A change set that names nothing, once
         * the base is checked, answers the current token and writes nothing, not even a `memory_state`
         * row; a decline of a chat that already declined names nothing. Any other decline is a real
         * write, so a chat with no `memory_state` row gets one at revision 1.
         */
        write(characterId: string, chatId: string, baseRevision: string, changes: MemoryChanges): MemoryWriteResult {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                throw new ResourceConflictError(null);
            }
            const { revision: current, adoptionDeclined } = stateOf(chat.seq);
            const currentToken = tokens.token(chat.seq, current);
            const base = tokens.parse(baseRevision);
            if (!base || base.seq !== chat.seq || base.revision !== current) {
                throw new ResourceConflictError(currentToken);
            }
            const lists = MEMORY_RECORD_KINDS.map((kind) => ({
                kind,
                records: changes[kind] ?? [],
                removed: changes.remove?.[kind] ?? [],
            }));
            const declines = changes.adoptionDeclined === true && adoptionDeclined !== 1;
            if (!declines && lists.every(({ records, removed }) => records.length === 0 && removed.length === 0)) {
                return { revision: currentToken, wrote: false };
            }
            const revision = nextRevision(current, 1);
            const prepared = lists.map(({ kind, records, removed }) => ({
                kind,
                removed,
                rows: prepareKind(kind, chat.seq, revision, records, removed),
            }));
            for (const { kind, removed } of prepared) {
                for (const id of removed) {
                    tables[kind].remove.run(chat.seq, id);
                }
            }
            for (const { kind, rows } of prepared) {
                for (const row of rows) {
                    tables[kind].upsert.run(chat.seq, ...row);
                }
            }
            upsertRevision.run(chat.seq, revision);
            if (declines) {
                setDeclined.run(chat.seq);
            }
            return { revision: tokens.token(chat.seq, revision), wrote: true };
        },

        /**
         * Makes `texts` the chat's whole memory: every row of the four kinds is deleted, each text goes in
         * verbatim with a fresh `seq` in the given order, and the revision moves up by one, also with no
         * records. Not `write`: a record in `texts` can be one the chat holds, and an event keeps the
         * `createdRevision` of its text. Every row is checked before the first statement that writes
         * (`checkMemoryRow`), so a `ResourceValidationError` changes nothing; a `createdRevision` past the
         * new revision is refused too, since a snapshot of such a chat would be. A missing chat is a
         * `ResourceConflictError` with no current revision. A decline is no row of `texts`, so it stays.
         */
        replace(characterId: string, chatId: string, texts: MemoryRowTexts): void {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                throw new ResourceConflictError(null);
            }
            const revision = nextRevision(revisionOf(chat.seq), 1);
            const prepared = MEMORY_RECORD_KINDS.map((kind) => {
                const claims = memoryRowClaims();
                const rows = texts[kind].map((text, index) =>
                    checkMemoryRow(`${MEMORY_TABLES[kind].table} row ${index + 1}`, kind, text, claims, revision),
                );
                return { kind, rows };
            });
            for (const { kind, rows } of prepared) {
                tables[kind].removeAll.run(chat.seq);
                for (const row of rows) {
                    tables[kind].insert.run(chat.seq, ...row);
                }
            }
            upsertRevision.run(chat.seq, revision);
        },
    };
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The columns of `memory_state` in the snapshot `source`, null when it has no memory tables: it has all
 * of them or none, each an ordinary table with this store's exact columns, or `memory_state` with those
 * of a snapshot from before `adoptionDeclined`. A partial group, or anything else under one of their
 * names, is a `ResourceValidationError`.
 */
function memoryStateLayout(source: DatabaseSync): readonly string[] | null {
    const tables = Object.entries(MEMORY_TABLE_COLUMNS);
    let present = 0;
    let stateColumns: readonly string[] | null = null;
    for (const [table, columns] of tables) {
        try {
            const objects = source
                .prepare("SELECT name, type, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE")
                .all(table) as { name: string; type: string; sql: string | null }[];
            if (objects.length === 0) {
                continue;
            }
            if (
                objects.length !== 1 ||
                objects[0].name !== table ||
                objects[0].type !== "table" ||
                !/^CREATE TABLE\b/i.test(objects[0].sql ?? "")
            ) {
                throw new ResourceValidationError(`${table}: not an ordinary memory table`);
            }
            const info = source.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[];
            const layouts = table === "memory_state" ? [columns, MEMORY_STATE_COLUMNS_BEFORE_DECLINE] : [columns];
            const layout = layouts.find(
                (expected) =>
                    info.length === expected.length &&
                    info.every((column, index) => column.name === expected[index] && column.hidden === 0),
            );
            if (!layout) {
                throw new ResourceValidationError(`${table}: invalid memory table columns`);
            }
            if (table === "memory_state") {
                stateColumns = layout;
            }
            present += 1;
        } catch (error) {
            if (error instanceof ResourceValidationError) {
                throw error;
            }
            throw new ResourceValidationError(`${table}: cannot read memory table layout`);
        }
    }
    if (present !== 0 && present !== tables.length) {
        throw new ResourceValidationError("Incomplete memory tables in resource database");
    }
    return stateColumns;
}

/**
 * Reads the optional memory table group, `memory_state` first and then each record table by `seq`, one
 * row at a time, checking each so that a crafted file is a refusal and never a constraint failure of the
 * staged store. An absent group calls nothing on `sink`; a partial group or a refused row is a
 * `ResourceValidationError`. `chatIds` holds each chat's id by its seq (`walkChatSnapshot`).
 *
 * A record passes what a live write checks and what a live write leaves true (`checkMemoryRow`): its
 * chat has a `memory_state` row, though a state row needs no records, an event's `createdRevision` is
 * within that revision, and a chat holds one `scene` page. Its shape past that is unchecked here as
 * there. A state row's decline is exactly 0 or 1, and a snapshot from before that column reads as 0.
 *
 * Only `seq`, `chatSeq`, and `data` are read. The columns a record decides come from the record, as in a
 * live write, and are never compared with the source's: a live write can leave the two unequal (a
 * title with a lone surrogate binds as U+FFFD and stays an escape in `data`), and a column that drifted
 * is healed.
 *
 * `data` goes on as the source's text. Chats and messages are written back because a normalizer can
 * change them; a record has no normalizer, and serializing it again can lengthen it, since `serialize`
 * keeps the spelling a `JSON.rawJSON` stored (`1e21` would come back as `1e+21`), which could carry a
 * record at the size limit past it.
 */
export function walkMemorySnapshot(
    source: DatabaseSync,
    chatIds: ReadonlyMap<number, string>,
    sink: MemorySnapshotSink,
    signal?: AbortSignal,
): void {
    const stateColumns = memoryStateLayout(source);
    if (!stateColumns) {
        return;
    }
    const declined = stateColumns.includes("adoptionDeclined") ? "adoptionDeclined" : "0 AS adoptionDeclined";

    const revisions = new Map<number, number>();
    for (const [row, number] of snapshotRows(
        source,
        `SELECT chatSeq, revision, ${declined} FROM memory_state ORDER BY chatSeq`,
        "memory_state: cannot read memory rows",
        signal,
    )) {
        const where = `memory_state row ${number}`;
        const { chatSeq, revision, adoptionDeclined } = row;
        if (typeof chatSeq !== "number" || !chatIds.has(chatSeq) || revisions.has(chatSeq)) {
            throw new ResourceValidationError(`${where}: no such chat or a duplicate state`);
        }
        if (!isPositiveSafeInteger(revision)) {
            throw new ResourceValidationError(`${where}: invalid revision`);
        }
        if (adoptionDeclined !== 0 && adoptionDeclined !== 1) {
            throw new ResourceValidationError(`${where}: invalid adoptionDeclined`);
        }
        revisions.set(chatSeq, revision);
        sink.state({ chatSeq, revision, adoptionDeclined });
    }

    for (const kind of MEMORY_RECORD_KINDS) {
        const { table } = MEMORY_TABLES[kind];
        const claimsByChat = new Map<number, MemoryRowClaims>();
        let lastSeq = 0;
        for (const [row, number] of snapshotRows(
            source,
            `SELECT seq, chatSeq, data FROM ${table} ORDER BY seq`,
            `${table}: cannot read memory rows`,
            signal,
        )) {
            const where = `${table} row ${number}`;
            const { seq, chatSeq, data } = row;
            if (!isPositiveSafeInteger(seq) || seq <= lastSeq) {
                throw new ResourceValidationError(`${where}: invalid or duplicate seq`);
            }
            lastSeq = seq;
            if (typeof chatSeq !== "number" || !chatIds.has(chatSeq)) {
                throw new ResourceValidationError(`${where}: no such chat`);
            }
            const revision = revisions.get(chatSeq);
            if (revision === undefined) {
                throw new ResourceValidationError(`${where}: its chat has no memory_state row`);
            }
            if (typeof data !== "string") {
                throw new ResourceValidationError(`${where}: data is not text`);
            }
            let claims = claimsByChat.get(chatSeq);
            if (!claims) {
                claims = memoryRowClaims();
                claimsByChat.set(chatSeq, claims);
            }
            sink.record(kind, chatSeq, checkMemoryRow(where, kind, data, claims, revision));
        }
    }
}

/**
 * The memory half of a staged store's writer (`writeValidatedStore`). A row keeps the source's numeric
 * `chatSeq`, since a staged chat keeps its seq, and a record takes a seq of the staged table's, in source
 * order. Revisions and declines stay as stored: the new epoch and the new chat seq make every old token
 * stale, and no record holds a token or a chat seq.
 */
export function createMemoryStagingSink(db: DatabaseSync): MemorySnapshotSink {
    const insertState = db.prepare("INSERT INTO memory_state (chatSeq, revision, adoptionDeclined) VALUES (?, ?, ?)");
    const insertRecord = {
        pages: db.prepare(insertRecordSql(MEMORY_TABLES.pages)),
        events: db.prepare(insertRecordSql(MEMORY_TABLES.events)),
        threads: db.prepare(insertRecordSql(MEMORY_TABLES.threads)),
        runs: db.prepare(insertRecordSql(MEMORY_TABLES.runs)),
    };
    return {
        state(row) {
            insertState.run(row.chatSeq, row.revision, row.adoptionDeclined);
        },
        record(kind, chatSeq, row) {
            insertRecord[kind].run(chatSeq, ...row);
        },
    };
}

/**
 * Copies the staged memory tables into the emptied live ones inside the caller's transaction, after
 * `copyStagedChats` and before `copyStagedCheckpoints`, whose policy copy stays the install's last,
 * with the staged store attached as `staged`: onto the live chats through `STAGED_CHAT_SEQS`, each
 * record table by staged seq with fresh live seqs, so every chat's storage order holds. Every row here
 * was checked by the staging walk, and nothing is parsed.
 */
export function copyStagedMemory(db: DatabaseSync): void {
    const records = Object.values(MEMORY_TABLES).map((description) => {
        const columns = writtenColumns(description);
        return `
            INSERT INTO main.${description.table} (chatSeq, ${columns.join(", ")})
                SELECT seqs.liveSeq, ${columns.map((column) => `r.${column}`).join(", ")}
                    FROM staged.${description.table} r JOIN ${STAGED_CHAT_SEQS} seqs ON seqs.stagedSeq = r.chatSeq
                    ORDER BY r.seq;`;
    });
    db.exec(`
        INSERT INTO main.memory_state (chatSeq, revision, adoptionDeclined)
            SELECT seqs.liveSeq, s.revision, s.adoptionDeclined
                FROM staged.memory_state s JOIN ${STAGED_CHAT_SEQS} seqs ON seqs.stagedSeq = s.chatSeq;
        ${records.join("")}
    `);
}

/**
 * What a `MemoryAnchoredSource` keeps as its `hash`: the SHA-256 of the message's role and `data`. JSON
 * keeps the boundary between the two unambiguous, and keeps a lone surrogate distinct where UTF-8 would
 * replace it. `generationInfo` stays outside: it is stored in the same row, and a receipt write that
 * changes it must keep the hash.
 */
export function messageSourceHash(message: Pick<Message, "role" | "data">): string {
    return createHash("sha256")
        .update(JSON.stringify([message.role, message.data]), "utf8")
        .digest("hex");
}

/** The last send's manifest: the newest context report with an `items` list, empty when that send included nothing. */
function lastMemoryManifest(messages: readonly Message[]): MemoryManifest | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const items = parseContextReport(messages[index].generationInfo?.context)?.memory?.items;
        if (items) {
            return { items };
        }
    }
    return null;
}

/**
 * A chat's `hypaV3Data` as its stored `events` and `messages` make it, unsealed: reconciled first, so a
 * source that changed never reads as active, then in the order of each event's earliest source by
 * current position, because every HypaV3 reader takes `summaries` as chronological while `seq` is
 * storage order and a re-record lands last. An event with no source in `messages` goes last, and ties
 * keep `seq` order. A malformed stored event can throw; the callers each decide what that means.
 */
export function projectChatMemory(
    events: readonly MemoryEvent[],
    messages: readonly Message[],
): SerializableHypaV3Data {
    const positions = new Map<string, number>();
    messages.forEach(({ chatId }, index) => {
        if (chatId !== undefined) {
            positions.set(chatId, index);
        }
    });
    const placed = reconcileMemoryEvents(events, messages, messageSourceHash).map((event) => {
        let position = Infinity;
        for (const { messageId } of storedMemorySources(event.sources)) {
            position = Math.min(position, positions.get(messageId) ?? Infinity);
        }
        return { event, position };
    });
    placed.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return projectHypaV3Data(
        placed.map(({ event }) => event),
        lastMemoryManifest(messages),
    );
}
