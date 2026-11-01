import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Message } from "../../../shared/database.ts";
import { MAX_READ_RESPONSE_BYTES } from "../../../shared/resources.ts";
import {
    MEMORY_EVENT_STATUSES,
    MEMORY_PAGE_TYPES,
    MEMORY_RUN_RESULTS,
    MEMORY_THREAD_STATES,
} from "../../../shared/structuredMemory.ts";
import type { MemoryEvent, MemoryPage, MemoryRun, MemoryThread } from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import {
    isValidResourceId,
    nextRevision,
    ResourceConflictError,
    ResourceValidationError,
    serialize,
} from "./resourceStore.ts";

/**
 * Structured memory's tables in the resource database (`MEMORY_TABLES_SQL` in `chatStore.ts`): a chat's
 * pages, events, threads, and writer runs, and `memory_state` with the one revision that covers them
 * all. Every row belongs to a chat's incarnation and goes with it by cascade. `data` holds the whole
 * record, so a page's sections stay embedded in its row.
 *
 * The resource store owns the connection, the epoch, and the transactions: the writers here join the
 * caller's open transaction and never begin or commit one, so a caller can compose them with its own
 * work.
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
export type MemoryRecordOf = {
    pages: MemoryPage;
    events: MemoryEvent;
    threads: MemoryThread;
    runs: MemoryRun;
};

export type MemoryRecordKind = keyof MemoryRecordOf;

/** An event as a writer hands it over: the store stamps `createdRevision`. */
export type MemoryEventWrite = Omit<MemoryEvent, "createdRevision">;

/** What one write changes: records to insert or update by id, and ids to remove. */
export type MemoryChanges = {
    pages?: MemoryPage[];
    events?: MemoryEventWrite[];
    threads?: MemoryThread[];
    runs?: MemoryRun[];
    remove?: { pages?: string[]; events?: string[]; threads?: string[]; runs?: string[] };
};

/** `wrote` is false when the change set named nothing, so the owner counts only real writes. */
export type MemoryWriteResult = { revision: string; wrote: boolean };

/** A table-of-contents row: the record's listed fields and the size of its stored text in bytes. */
type ContentsRow<T, Field extends keyof T> = Pick<T, Field> & { bytes: number };

/** A chat's table of contents, with the memory revision a write based on it names. */
export type MemoryContents = {
    revision: string;
    pages: ContentsRow<MemoryPage, "id" | "type" | "title">[];
    events: ContentsRow<MemoryEvent, "id" | "title" | "status">[];
    threads: ContentsRow<MemoryThread, "id" | "title" | "state">[];
    runs: ContentsRow<MemoryRun, "id" | "result">[];
};

/** A record's body, with the memory revision an edit of it names. */
export type MemoryRecordRead<K extends MemoryRecordKind> = { revision: string; data: MemoryRecordOf[K] };

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

const MEMORY_RECORD_KINDS = Object.keys(MEMORY_TABLES) as MemoryRecordKind[];

/** One record table's statements, built from its description. */
function prepareTable(db: DatabaseSync, { table, titled, statusColumn, stamped }: MemoryTable) {
    const listed = ["id", ...(titled ? ["title"] : []), statusColumn];
    const written = [...listed, ...(stamped ? ["createdRevision"] : []), "data"];
    // An update leaves `id` and `createdRevision` as the row has them.
    const updates = written
        .filter((column) => column !== "id" && column !== "createdRevision")
        .map((column) => `${column} = excluded.${column}`);
    return {
        // `octet_length` takes the size from the row's header, so a listing loads no record's text.
        selectContents: db.prepare(
            `SELECT ${listed.join(", ")}, octet_length(data) AS bytes FROM ${table} WHERE chatSeq = ? ORDER BY seq`,
        ),
        selectRecord: db.prepare(`SELECT data FROM ${table} WHERE chatSeq = ? AND id = ?`),
        remove: db.prepare(`DELETE FROM ${table} WHERE chatSeq = ? AND id = ?`),
        // Never `INSERT OR REPLACE`: an updated record keeps its `seq`.
        upsert: db.prepare(
            `INSERT INTO ${table} (chatSeq, ${written.join(", ")}) VALUES (?${", ?".repeat(written.length)}) ` +
                `ON CONFLICT (chatSeq, id) DO UPDATE SET ${updates.join(", ")}`,
        ),
    };
}

function refusal(kind: MemoryRecordKind, id: unknown, reason: string) {
    return new ResourceValidationError(`Memory ${kind} ${JSON.stringify(id)}: ${reason}`);
}

/**
 * Prepares the memory statements and returns the methods over them; the tables must exist
 * (`openChatSchema` runs first). `write` joins the caller's open transaction.
 */
export function createMemoryTables(db: DatabaseSync, tokens: TokenFunctions) {
    const selectChat = db.prepare("SELECT seq FROM chats WHERE characterId = ? AND id = ?");
    const selectRevision = db.prepare("SELECT revision FROM memory_state WHERE chatSeq = ?");
    const upsertRevision = db.prepare(
        "INSERT INTO memory_state (chatSeq, revision) VALUES (?, ?) " +
            "ON CONFLICT (chatSeq) DO UPDATE SET revision = excluded.revision",
    );
    const selectCreatedRevision = db.prepare("SELECT createdRevision FROM memory_events WHERE chatSeq = ? AND id = ?");
    const tables = {
        pages: prepareTable(db, MEMORY_TABLES.pages),
        events: prepareTable(db, MEMORY_TABLES.events),
        threads: prepareTable(db, MEMORY_TABLES.threads),
        runs: prepareTable(db, MEMORY_TABLES.runs),
    };

    function revisionOf(seq: number): number {
        return (selectRevision.get(seq) as { revision: number } | undefined)?.revision ?? 0;
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
        const { titled, statusColumn, statusValues, stamped } = MEMORY_TABLES[kind];
        const writtenIds = new Set<string>();
        const rows = records.map((record) => {
            const serialized = serialize(record);
            const stored = isPlainObject(serialized.stored) ? serialized.stored : {};
            const { id, title } = stored;
            if (!isValidResourceId(id)) {
                throw refusal(kind, id, "invalid id");
            }
            if (writtenIds.has(id)) {
                throw refusal(kind, id, "written twice");
            }
            writtenIds.add(id);
            const row: (string | number)[] = [id];
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
        return rows;
    }

    return {
        /**
         * The table of contents, read without any record's body. Missing chat: null. Each list is in
         * `seq` order, which is storage order, not message order: an updated record keeps its place.
         */
        readContents(characterId: string, chatId: string): MemoryContents | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return null;
            }
            return {
                revision: tokens.token(chat.seq, revisionOf(chat.seq)),
                pages: tables.pages.selectContents.all(chat.seq) as MemoryContents["pages"],
                events: tables.events.selectContents.all(chat.seq) as MemoryContents["events"],
                threads: tables.threads.selectContents.all(chat.seq) as MemoryContents["threads"],
                runs: tables.runs.selectContents.all(chat.seq) as MemoryContents["runs"],
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
         * Applies `changes` at exactly `baseRevision`: removals, then upserts, then the revision moves up
         * by one, however much changed. A missing chat is a `ResourceConflictError` with no current
         * revision, a base that is not the current token one naming the current token, and every other
         * refusal a `ResourceValidationError`. All of them come before the first statement that writes,
         * so a stale or refused write changes nothing and is never merged. Removing an id that does
         * not exist is no refusal and still moves the revision. A change set that names nothing, once
         * the base is checked, answers the current token and writes nothing, not even a `memory_state`
         * row.
         */
        write(characterId: string, chatId: string, baseRevision: string, changes: MemoryChanges): MemoryWriteResult {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                throw new ResourceConflictError(null);
            }
            const current = revisionOf(chat.seq);
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
            if (lists.every(({ records, removed }) => records.length === 0 && removed.length === 0)) {
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
            return { revision: tokens.token(chat.seq, revision), wrote: true };
        },
    };
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
