import {
    isRerollCarrier,
    selectCandidateChange,
    normalizeCandidateFields,
    withoutCandidateCheckpoints,
} from "../../../shared/rerollCandidates.ts";
import type { DatabaseSync } from "node:sqlite";
import type {
    ChatConflict,
    ChatGroupResult,
    ChatOrderConflict,
    ChatOrderRecord,
    ChatOrderResult,
    ChatRecord,
    ChatSummary,
    CheckpointOutcome,
    TargetOutcome,
    TranslationOutcome,
} from "../../../shared/chats.ts";
import { CHAT_META_MERGE_KEYS } from "../../../shared/chats.ts";
import type { Chat, Message, MessageTranslation } from "../../../shared/database.ts";
import {
    type ChangeSet,
    type ChatDeltaBody,
    type ChatMetaFields,
    type ChatPatchBody,
    type ChatRowDeltaBody,
    type ChatRowDiff,
    type ChatRowsReadResult,
    type ResourceReadEntries,
    MAX_FEED_PATCH_BYTES,
    SMALL_FEED_PATCH_BYTES,
    RESOURCE_KIND,
} from "../../../shared/resources.ts";
import { hypaV3DataHoldsSummaries, isSealedHypaV3Data, memorySourceSpeaker } from "../../../shared/structuredMemory.ts";
import { textHash } from "../../../shared/textHash.ts";
import { chatTranslationSummary } from "../../../shared/translation/chatSettings.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { isMessageTranslation } from "../../../shared/translation/messageTranslation.ts";
import type { MessageGuard } from "../jobs/generationLock.ts";
import {
    assertPatchableMetaKeys,
    CHAT_SCHEMA_VERSION,
    normalizeChatMeta,
    normalizeMessage,
    normalizeMessageList,
} from "./chats.ts";
import {
    isValidResourceId,
    nextRevision,
    NOT_A_RESOURCE_DATABASE,
    ResourceValidationError,
    serialize,
    snapshotRows,
} from "./resourceStore.ts";

/**
 * The chat tables of the resource database: chat metadata (`chats`), one row per message (`messages`,
 * keyed by the chat's incarnation `seq` and `Message.chatId`, ordered by `position`), each
 * character's chat order (`chatOrders`), and each chat's stored summary projection (`chatSummaries`).
 * The resource store owns the connection, the epoch, and the transactions; this module prepares,
 * applies, reads, and validates chat changes inside them. Candidate revisions and checkpoint retention
 * are store-owned: appends keep snapshots on the newest non-comment message and live job rows;
 * appended comments never keep them. By-id writes cannot restore absent snapshots unless admitted
 * by a generation fence or made by the row's lock owner. Reroll variable provenance is staged with
 * the same transaction.
 *
 * Positions: an insert shifts the rows after its anchor by the number of inserted messages; a
 * removal leaves a gap. Positions are distinct within a chat but not unique-constrained, because
 * SQLite checks a unique index row by row while an `UPDATE` shifts them.
 */

export const CHAT_TABLES_SQL = `
    CREATE TABLE chats (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        characterId TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        schemaVersion INTEGER NOT NULL,
        meta TEXT NOT NULL,
        UNIQUE (characterId, id)
    ) STRICT;
    CREATE TABLE messages (
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        generationId TEXT,
        generationSeq INTEGER,
        generationFinal INTEGER,
        generationHistory TEXT,
        PRIMARY KEY (chatSeq, id)
    ) STRICT;
    CREATE INDEX messages_position ON messages (chatSeq, position);
    CREATE TABLE chatOrders (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        characterId TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        ids TEXT NOT NULL
    ) STRICT;
`;

/** CROSS JOIN keeps the requested ids driving point lookups before sorting the selected rows. */
export const TOUCHED_ROWS_SQL = `
    SELECT m.id, m.data,
        (SELECT p.id FROM messages p WHERE p.chatSeq = m.chatSeq AND p.position < m.position
            ORDER BY p.position DESC LIMIT 1) AS after
    FROM json_each(?) r CROSS JOIN messages m ON m.chatSeq = ? AND m.id = r.value
    ORDER BY m.position
`;

/** Column names of the chat tables, in `PRAGMA table_info` order (snapshot layout check). */
export const CHAT_TABLE_COLUMNS: Record<string, readonly string[]> = {
    chats: ["seq", "characterId", "id", "revision", "schemaVersion", "meta"],
    messages: [
        "chatSeq",
        "id",
        "position",
        "data",
        "generationId",
        "generationSeq",
        "generationFinal",
        "generationHistory",
    ],
    chatOrders: ["seq", "characterId", "revision", "ids"],
};

/**
 * The ids of the client groups a chat applied, with their results, so a group resent after a lost
 * answer is answered as before instead of applied again. Keyed by the chat's incarnation
 * (`chats.seq`): deleting the chat (a `delete` op, its character's delete, a restore's `replaceAll`)
 * drops them by cascade. Created when missing, so a database from before the table gains it on open;
 * not part of the snapshot layout (`CHAT_TABLE_COLUMNS`), so snapshots with and without it restore
 * alike and a restore starts with none (its new epoch fences every earlier client anyway).
 * `revision` is the chat's revision counter after the group; `result` holds the rest of its answer
 * (`RememberedResult`).
 */
export const CHAT_GROUP_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS chatGroups (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        groupId TEXT NOT NULL,
        revision INTEGER NOT NULL,
        result TEXT NOT NULL,
        UNIQUE (chatSeq, groupId)
    ) STRICT;
`;

/**
 * Each chat's summary projection, so a summary read costs its stored text and not a parse of the
 * whole metadata. `text` is `summaryText` of the chat's stored metadata: without the last message's
 * time (memoized apart) and without the revision. `revision` is the chat's revision at the last write
 * by a server that maintains this table, and a row is fresh when it equals `chats.revision`: an older
 * server ignores the table and bumps revisions as it writes, so its edits leave rows behind, and a
 * stale or missing row is rebuilt at open (`openChatSchema`) or by the next reader
 * (`freshSummaryText`). Keyed by the chat's incarnation, so deleting the chat drops its row by
 * cascade. Created when missing; not part of the snapshot layout (`CHAT_TABLE_COLUMNS`): a snapshot's
 * copy is ignored and a restore writes its own rows.
 */
export const CHAT_SUMMARY_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS chatSummaries (
        chatSeq INTEGER PRIMARY KEY REFERENCES chats (seq) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        text TEXT NOT NULL
    ) STRICT;
`;

/**
 * `memory_state`'s column for a person's decline of adopting the chat's HypaV3 summaries, in the table's
 * `CREATE` and in what `openChatSchema` adds to a table from before it, so the two cannot differ.
 */
const MEMORY_DECLINE_COLUMN_SQL = "adoptionDeclined INTEGER NOT NULL DEFAULT 0";

/**
 * Each chat's structured memory (`memoryStore.ts`): a table each for pages, events, threads, and writer
 * runs, one row per record with the whole record as stored JSON in `data`, and `memory_state`, the one
 * revision over all of them and the chat's decline of adoption, which a chat has no row in until its
 * first memory write. `seq` is storage order, not message order. `data` is the last column, so a
 * table-of-contents read stops before it.
 * Keyed by the chat's incarnation (`chats.seq`): deleting the chat drops its rows by cascade, and the
 * prefix of `UNIQUE (chatSeq, id)` keeps that cascade from scanning a table. `memory_pages_scene` holds
 * a chat to one `scene` page; `memoryStore.ts` refuses a second one before it reaches this index. Created
 * when missing; not part of the required snapshot layout (`CHAT_TABLE_COLUMNS`), so a snapshot from
 * before them restores with none, but a snapshot with any of them has them all checked and restored
 * (`walkMemorySnapshot`). Event citations are derived separately by `MEMORY_EVENT_SOURCES_SQL`.
 */
export const MEMORY_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS memory_state (
        chatSeq INTEGER PRIMARY KEY REFERENCES chats (seq) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        ${MEMORY_DECLINE_COLUMN_SQL}
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_pages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_pages_scene ON memory_pages (chatSeq) WHERE type = 'scene';
    CREATE TABLE IF NOT EXISTS memory_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        createdRevision INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_threads (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        result TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
`;

/**
 * A chat's rebuild (`memoryStore.ts`): `memory_rebuilds`, the run itself, and the staged tables holding what
 * it records until its swap: the same columns, uniqueness, and scene index as the record tables above, each
 * row going with its chat by cascade. `plan` is a JSON list of message ids per window, written once;
 * `cursor` counts the windows done and `revision` the staged set's writes, which is its own counter.
 * `sourceReplaced` is set in the commit of a whole-chat replace: the store's source generations live in
 * memory and start over with a process, and a run outlives one.
 * None of these is a record: they are in no snapshot walk, checkpoint, chat file, or inherit, and the
 * snapshot layout names none of them, so a restore leaves them behind with the chats it deletes.
 */
const MEMORY_REBUILD_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS memory_rebuilds (
        chatSeq INTEGER PRIMARY KEY REFERENCES chats (seq) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        revision INTEGER NOT NULL,
        sourceReplaced INTEGER NOT NULL DEFAULT 0,
        cursor INTEGER NOT NULL,
        total INTEGER NOT NULL,
        plan TEXT NOT NULL,
        reason TEXT,
        error TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_staged_pages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_staged_pages_scene ON memory_staged_pages (chatSeq) WHERE type = 'scene';
    CREATE TABLE IF NOT EXISTS memory_staged_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        createdRevision INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_staged_threads (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_staged_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        result TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
`;

const MEMORY_EVENT_SOURCE_TABLES = [
    { events: "memory_events", sources: "memory_event_sources" },
    { events: "memory_staged_events", sources: "memory_staged_event_sources" },
];

/**
 * Message-to-event citations for live and staged records, keyed by chat incarnation. Created at open,
 * outside the snapshot and checkpoint layouts: triggers derive them on every insert, update, and
 * delete, including restore copies and writes by an older build. The event index bounds replacement
 * and deletion; the primary key finds events citing a changed message without reading their bodies.
 * Guards leave text SQLite cannot parse untouched and unindexed. Object sources with a string
 * `messageId` count whether anchored or not, matching `storedMemorySources` for ordinary JSON.stringify
 * output; crafted duplicate or NUL-containing keys can make SQLite's paths differ from JSON.parse.
 */
const MEMORY_EVENT_SOURCES_SQL = MEMORY_EVENT_SOURCE_TABLES.map(({ events, sources }) => {
    // An outer upsert's DO UPDATE can override OR IGNORE, so duplicate citations are removed first.
    const insert = `
        INSERT OR IGNORE INTO ${sources} (chatSeq, messageId, eventId)
            SELECT DISTINCT NEW.chatSeq, json_extract(source.value, '$.messageId'), NEW.id
                FROM json_each(CASE WHEN json_valid(NEW.data) THEN NEW.data END, '$.sources') source
                WHERE json_type(CASE WHEN json_valid(NEW.data) THEN NEW.data END, '$.sources') = 'array'
                    AND source.type = 'object' AND json_type(source.value, '$.messageId') = 'text';`;
    const remove = `DELETE FROM ${sources} WHERE chatSeq = OLD.chatSeq AND eventId = OLD.id;`;
    return `
        CREATE TABLE IF NOT EXISTS ${sources} (
            chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
            messageId TEXT NOT NULL,
            eventId TEXT NOT NULL,
            PRIMARY KEY (chatSeq, messageId, eventId)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS ${sources}_event ON ${sources} (chatSeq, eventId);
        CREATE TRIGGER IF NOT EXISTS ${sources}_insert AFTER INSERT ON ${events}
        BEGIN
            ${insert}
        END;
        CREATE TRIGGER IF NOT EXISTS ${sources}_update AFTER UPDATE ON ${events}
        BEGIN
            ${remove}
            ${insert}
        END;
        CREATE TRIGGER IF NOT EXISTS ${sources}_delete AFTER DELETE ON ${events}
        BEGIN
            ${remove}
        END;
    `;
}).join("");

/**
 * A message's role as `messages_role` indexes it. A query reaches that index only through this exact
 * expression, so every statement that counts by role builds on this text.
 */
const MESSAGE_ROLE_SQL = "json_extract(data, '$.role')";

/**
 * Lets a count by role read no message row. Created when missing (`openChatSchema`), not part of the
 * snapshot layout (`CHAT_TABLE_COLUMNS`); SQLite maintains it on every write of a message's `data`.
 */
const MESSAGE_ROLE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS messages_role ON messages (chatSeq, ${MESSAGE_ROLE_SQL});`;

/**
 * Checkpoint keys in the server's canonical `JSON.stringify` text: whole-row preparation and snapshot
 * staging reserialize messages, so keys have this exact spelling and quotes inside string values are
 * escaped. A byte scan avoids parsing candidate arrays; the cleanup query repeats this exact predicate
 * so SQLite can use the partial index. Keys nested elsewhere are harmless false positives: the append
 * loop rechecks them with `withoutCandidateCheckpoints` and skips unchanged serialized text.
 */
const MESSAGE_CHECKPOINT_PREDICATE_SQL = `(instr(data, '"scriptstateCheckpoint":') > 0 OR instr(data, '"scriptstateAfter":') > 0)`;

/**
 * Messages that may need checkpoint cleanup after any fresh append, indexed by chat without pruning
 * candidate history. Retention follows the newest non-comment message's stored position. Created when
 * missing (`openChatSchema`), outside the snapshot layout (`CHAT_TABLE_COLUMNS`); SQLite maintains it
 * on every write of a message's `data`, including staged imports and restores.
 */
const MESSAGE_CHECKPOINT_INDEX_SQL = `CREATE INDEX IF NOT EXISTS messages_checkpoints ON messages (chatSeq) WHERE ${MESSAGE_CHECKPOINT_PREDICATE_SQL};`;

/**
 * Lets memory rounds seek within one chat in storage order without sorting. Created when missing at
 * open, including staged restores, and outside the snapshot layout; updates keep each record's `seq`.
 */
const MEMORY_ROUND_INDEXES_SQL = `
    CREATE INDEX IF NOT EXISTS memory_runs_chat_seq ON memory_runs (chatSeq, seq);
    CREATE INDEX IF NOT EXISTS memory_threads_chat_seq ON memory_threads (chatSeq, seq);
`;

/**
 * What `openChatSchema` adds to `CHAT_TABLES_SQL`, each created when missing, and a staged store's
 * writer too, so a staged file has the live schema.
 */
export const CHAT_OPEN_SCHEMA_SQL = `${CHAT_GROUP_TABLE_SQL}${CHAT_SUMMARY_TABLE_SQL}${MEMORY_TABLES_SQL}${MEMORY_REBUILD_TABLES_SQL}${MEMORY_EVENT_SOURCES_SQL}${MESSAGE_ROLE_INDEX_SQL}${MESSAGE_CHECKPOINT_INDEX_SQL}${MEMORY_ROUND_INDEXES_SQL}`;

/** A chat's user messages, answered from `messages_role` alone: no message row is read. */
export const COUNT_USER_TURNS_SQL = `SELECT COUNT(*) AS count FROM messages WHERE chatSeq = ? AND ${MESSAGE_ROLE_SQL} = 'user'`;

const UPSERT_CHAT_SUMMARY_SQL =
    "INSERT INTO chatSummaries (chatSeq, revision, text) VALUES (?, ?, ?) " +
    "ON CONFLICT (chatSeq) DO UPDATE SET revision = excluded.revision, text = excluded.text";

/**
 * How many group ids a chat remembers (the newest ones; the oldest is dropped). A lost answer is
 * resent on the client's next save cycle, so the ids need to outlive only the other writers' groups
 * on that chat until then. Past it, a resend whose base is not newer than the oldest remembered
 * group is refused as a conflict (`retry`), never applied twice.
 */
export const MAX_CHAT_GROUP_IDS = 100;
/** The longest accepted `ChatGroup.groupId`. */
export const MAX_CHAT_GROUP_ID_LENGTH = 128;

/** A remembered group's answer besides its ids and revision (`chatGroups.result`). */
type RememberedResult = {
    stale?: true;
    /** Only when the server gave a message a fresh id; otherwise rebuilt from the replayed group. */
    messageIds?: string[];
    /** How many `checkpoints` entries the answer had (a replay answers each `duplicate`). */
    checkpoints?: number;
    translations?: TranslationOutcome[];
    selections?: ChatGroupResult["selections"];
    candidateRows?: ChatGroupResult["candidateRows"];
    targets?: TargetOutcome[];
};

type Generation = { id: string; seq: number; final: boolean };

type PreparedOp =
    | {
          op: "create";
          meta: string;
          summary: string;
          messages: PreparedMessage[];
          renamed: boolean;
          index: number | null;
      }
    | { op: "delete" }
    | { op: "replace"; meta: string; summary: string; messages: PreparedMessage[]; renamed: boolean }
    | {
          op: "meta";
          set: Record<string, unknown>;
          unset: string[];
          merge: Record<string, Record<string, unknown>>;
          mergeUnset: Record<string, string[]>;
      }
    | { op: "append"; messages: PreparedMessage[]; anchor: { start: true } | { end: true } | { after: string } }
    | { op: "setMessage"; message: PreparedMessage; generation: Generation | null }
    | { op: "setText"; id: string; text: string; generation: Generation | null }
    | { op: "patchMessage"; id: string; set: Record<string, unknown>; unset: string[] }
    | { op: "remove"; ids: string[]; retract: boolean }
    | { op: "begin"; id: string; generationId: string }
    | { op: "setTranslation"; id: string; translation: MessageTranslation | null }
    | { op: "selectCandidate"; messageId: string; candidateId: string; expect: { candidatesRevision: number } };

type PreparedMessage = { id: string; text: string };

/**
 * What a by-id group did to the evidence in a chat's messages, once it commits: `retracted`, the messages
 * a `remove` with `retract` deleted, and `rewritten`, those a person's write gave another `role`, `data`,
 * or normalized group speaker (`saying`), which a current memory source's hash reads. A write of a job
 * or a generation reports nothing, nor does a change of any other field, nor an id the group inserted or removed.
 */
export type ChatMessageChanges = { characterId: string; id: string; retracted: string[]; rewritten: string[] };

export type PreparedChatGroup = {
    characterId: string;
    chatId: string;
    baseRevision: string | null;
    ops: PreparedOp[];
    /** Whether the group needs the chat's current revision (delete, replace, a multi-id remove). */
    needsCurrent: boolean;
    /** The client's id of the group (`ChatGroup.groupId`), or null (a server writer's group). */
    groupId: string | null;
    /** A resend of a group whose answer was lost (`ChatGroup.retry`). */
    retry: boolean;
};

export type PreparedChatOrder = { characterId: string; baseRevision: string; ids: string[] };

export type ChatSnapshotRows = {
    readonly chats: readonly {
        seq: number;
        characterId: string;
        id: string;
        revision: number;
        schemaVersion: number;
        meta: string;
    }[];
    readonly messages: readonly {
        chatSeq: number;
        id: string;
        position: number;
        data: string;
        generationId: string | null;
        generationSeq: number | null;
        generationFinal: number | null;
        generationHistory: string | null;
    }[];
    readonly chatOrders: readonly { characterId: string; revision: number; ids: string }[];
};

/**
 * Where `walkChatSnapshot` hands each row it checked, as it reads them. `meta` of a chat is the
 * row's metadata as its stored text reads back.
 */
export type ChatSnapshotSink = {
    chat(row: ChatSnapshotRows["chats"][number], meta: Record<string, unknown>): void;
    message(row: ChatSnapshotRows["messages"][number]): void;
    chatOrder(row: ChatSnapshotRows["chatOrders"][number]): void;
};

/**
 * What one by-id chat group changed, as stored right after it, for the writer that asked
 * (`applyChanges` with `changes: true`). Rows and metadata stay the stored JSON strings.
 */
export type ChatWriteChange = {
    /** The stored revision right before the group; for a stale group, newer than its requested base. */
    baseRevision: string;
    /** The revision after the group (advanced by its applied op count). */
    revision: string;
    /** The message count after the group. */
    count: number;
    /** The ids of the rows the group removed that were there before it, in removal order. */
    removed: string[];
    /**
     * Every row the group touched, as stored now (its `data` column), in position order; `after` is
     * the id of the row right before it by position, null at the start.
     */
    rows: { id: string; after: string | null; data: string }[];
    /** The stored metadata JSON (`meta`), only when the group changed the metadata. */
    meta?: string;
};

/**
 * What a group's feed entry carries beside its ref (`shared/resources.ts` `ChangeSet["chats"]`):
 * its by-id change, as a `patch`, `delta`, `rowDelta`, or `rows` manifest, and its summary knowledge.
 * Feed-only: never in HTTP results.
 *
 * An applied by-id group carries `summary` at its revision when the summary changed, otherwise
 * `summaryBase`, its stored base revision. The comparison ignores revisions: projection text before
 * the first metadata op and after the last is compared without parsing it (`freshSummaryText` may
 * rebuild a missing or stale projection from parsed metadata). Message ops also compare
 * `lastMessageAt` immediately before the first one, even when absent, and after the group, inside
 * the transaction without the memo. Thus a note edit with removal of the last row, or leaving an
 * undated last row, still detects a changed time. A changed summary without a message op reads the
 * time once to complete it.
 * Removing and reappending one id keeps summary knowledge but carries no body or row manifest.
 * Whole-chat writes, no-op groups and deletions carry neither summary field: unknown, preserving
 * the summary-list read in `src/ts/storage/chatStore.svelte.ts`. Remembered groups publish no feed
 * entry at all (`server/src/data/resourceStore.ts`).
 */
export type ChatFeedPayloads = Pick<
    ChangeSet["chats"][number],
    "patch" | "delta" | "rowDelta" | "rows" | "summary" | "summaryBase"
>;

/**
 * Where a by-id group's change leaves a chat's messages, from their ids at its base (`base`, in
 * position order): each entry is the id of a message the group left alone or the index of the
 * change row placed there (`change.rows[index]`). Null when the change does not fit the base: the
 * base ids are not unique strings, a removed id is not one of them exactly once, a row id repeats
 * or was removed, a row's anchor (`after`) is neither the start, a base message the group left
 * alone, nor an earlier row of the change, two rows share an anchor, or the result does not have
 * `change.count` messages.
 *
 * The messages the group left alone keep their order (a by-id group never moves one); each row
 * goes right after its anchor, so a row anchored on another row of the change follows that row,
 * and the rows come out in the change's order (final position order).
 */
export function messageOrderAfterChange(base: readonly unknown[], change: ChatWriteChange): (string | number)[] | null {
    const ids = new Set<string>();
    for (const id of base) {
        if (typeof id !== "string" || ids.has(id)) {
            return null;
        }
        ids.add(id);
    }
    const removed = new Set(change.removed);
    if (removed.size !== change.removed.length || change.removed.some((id) => !ids.has(id))) {
        return null;
    }
    const rowIndex = new Map<string, number>();
    change.rows.forEach((row, index) => rowIndex.set(row.id, index));
    if (rowIndex.size !== change.rows.length) {
        return null;
    }
    // The one row placed right after each anchor (null: the start).
    const following = new Map<string | null, number>();
    for (const [index, row] of change.rows.entries()) {
        const anchor = row.after;
        const anchorRow = anchor === null ? undefined : rowIndex.get(anchor);
        const anchored =
            anchor === null || (anchorRow !== undefined ? anchorRow < index : ids.has(anchor) && !removed.has(anchor));
        if (removed.has(row.id) || !anchored || following.has(anchor)) {
            return null;
        }
        following.set(anchor, index);
    }
    const order: (string | number)[] = [];
    let placed = 0;
    /** Places the rows chained after `anchor`; false when one comes out of the change's order. */
    const place = (anchor: string | null): boolean => {
        for (let index = following.get(anchor); index !== undefined; index = following.get(change.rows[index].id)) {
            if (index !== placed) {
                return false;
            }
            order.push(index);
            placed += 1;
        }
        return true;
    };
    if (!place(null)) {
        return null;
    }
    // Unique strings, checked above.
    for (const id of base as readonly string[]) {
        if (removed.has(id) || rowIndex.has(id)) {
            continue;
        }
        order.push(id);
        if (!place(id)) {
            return null;
        }
    }
    return placed === change.rows.length && order.length === change.count ? order : null;
}

type TokenFunctions = {
    token(seq: number, revision: number): string;
    parse(value: string): { seq: number; revision: number } | null;
};

/** JSON with object keys sorted, for comparing stored values whatever their key order. */
function sortedJson(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) =>
        isPlainObject(entry)
            ? Object.fromEntries(
                  Object.keys(entry)
                      .sort()
                      .map((key) => [key, entry[key]]),
              )
            : entry,
    );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether two stored JSON values are equal as JSON values, whatever their key order. */
function sameJson(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b) || sortedJson(a) === sortedJson(b);
}

type SummaryFields = Omit<ChatSummary, "characterId" | "id" | "revision">;
type SummaryProjection = Omit<SummaryFields, "lastMessageAt">;

/**
 * The shape of the stored projection (`summaryText`). Bump it whenever the projection's shape changes:
 * an open that finds another value in the `meta` table's `summaryProjectionVersion` rebuilds every row.
 */
export const SUMMARY_PROJECTION_VERSION = 1;

/**
 * A chat summary's listed fields: the projection of its stored metadata (the JSON copy, never a
 * normalizer's raw output), everything but its identity, its revision, and the time of its last
 * message, in the summary's key order.
 */
function summaryFields(meta: Record<string, unknown>): SummaryProjection {
    const fields: SummaryProjection = {
        name: typeof meta.name === "string" ? meta.name : "",
        fmIndex: typeof meta.fmIndex === "number" ? meta.fmIndex : -1,
    };
    if (typeof meta.folderId === "string") {
        fields.folderId = meta.folderId;
    }
    if (typeof meta.bindedPersona === "string") {
        fields.bindedPersona = meta.bindedPersona;
    }
    if (typeof meta.promptPresetId === "string") {
        fields.promptPresetId = meta.promptPresetId;
    }
    if (typeof meta.modelPresetId === "string") {
        fields.modelPresetId = meta.modelPresetId;
    }
    if (typeof meta.bindingReview === "boolean") {
        fields.bindingReview = meta.bindingReview;
    }
    if (meta.pinned === true) {
        fields.pinned = true;
    }
    // The translation settings: a new chat inherits them.
    Object.assign(fields, chatTranslationSummary(meta));
    return fields;
}

/**
 * The stored form of a chat's projection (`chatSummaries.text`). Its key order is fixed and every value
 * is a string, number, or boolean, so two projections are equal exactly when their texts are.
 */
function summaryText(meta: Record<string, unknown>): string {
    return JSON.stringify(summaryFields(meta));
}

/** A stored projection's fields with the time of the chat's last message, in the summary's key order. */
function summaryWithTime(text: string, lastMessageAt: number | undefined): SummaryFields {
    const { name, fmIndex, ...rest } = JSON.parse(text) as SummaryProjection;
    return { name, fmIndex, ...(lastMessageAt === undefined ? {} : { lastMessageAt }), ...rest };
}

/**
 * The field form (`ChatMetaFields`) of the change from one stored metadata value to another, or
 * null when they are equal as JSON values. Computed from the stored values, never from the ops that
 * led there (a stale group merges onto the stored base, and normalization rewrites the result).
 * Built from entries, so a map entry named like an `Object.prototype` member (`__proto__`) stays an
 * own key, and no value is `undefined`.
 */
function chatMetaFields(before: Record<string, unknown>, after: Record<string, unknown>): ChatMetaFields | null {
    const remove = Object.keys(before).filter((key) => !Object.hasOwn(after, key));
    const set: [string, unknown][] = [];
    const merge: [string, Record<string, unknown>][] = [];
    const mergeUnset: [string, string[]][] = [];
    for (const key of Object.keys(after)) {
        const had = Object.hasOwn(before, key);
        const old = had ? before[key] : undefined;
        const value = after[key];
        if (had && sameJson(old, value)) {
            continue;
        }
        if (had && CHAT_META_MERGE_KEYS.includes(key) && isPlainObject(old) && isPlainObject(value)) {
            // A map at both revisions: by entry.
            const gone = Object.keys(old).filter((id) => !Object.hasOwn(value, id));
            const entries = Object.keys(value)
                .filter((id) => !Object.hasOwn(old, id) || !sameJson(old[id], value[id]))
                .map((id): [string, unknown] => [id, value[id]]);
            if (entries.length > 0) {
                merge.push([key, Object.fromEntries(entries)]);
            }
            if (gone.length > 0) {
                mergeUnset.push([key, gone]);
            }
            continue;
        }
        set.push([key, value]);
    }
    if (remove.length === 0 && set.length === 0 && merge.length === 0 && mergeUnset.length === 0) {
        return null;
    }
    const fields: ChatMetaFields = { set: Object.fromEntries(set), remove };
    if (merge.length > 0) {
        fields.merge = Object.fromEntries(merge);
    }
    if (mergeUnset.length > 0) {
        fields.mergeUnset = Object.fromEntries(mergeUnset);
    }
    return fields;
}

type ChatRowDiffCandidate = { diff: ChatRowDiff; beforeText: string };

/**
 * An existing row's fields and text from its first stored read to its final value. A non-string
 * `data` or a changed own `__proto__` field needs a whole row. Equal JSON fields keep no diff even
 * when their object keys were stored in another order. A text hash uses a fixed-width placeholder
 * for size measurement; its captured old text is hashed only if the rowDelta is selected.
 */
function chatRowDiff(
    id: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
): ChatRowDiffCandidate | null {
    if (typeof before.data !== "string" || typeof after.data !== "string") {
        return null;
    }
    const unset = Object.keys(before).filter((key) => key !== "data" && !Object.hasOwn(after, key));
    const set = Object.keys(after)
        .filter((key) => key !== "data" && (!Object.hasOwn(before, key) || !sameJson(before[key], after[key])))
        .map((key): [string, unknown] => [key, after[key]]);
    if (unset.includes("__proto__") || set.some(([key]) => key === "__proto__")) {
        return null;
    }
    const diff: ChatRowDiff = { id };
    if (unset.length > 0 || set.length > 0) {
        diff.fields = { set: Object.fromEntries(set), unset };
    }
    if (before.data !== after.data) {
        let keep = before.data.length;
        if (!after.data.startsWith(before.data)) {
            keep = 0;
            while (keep < before.data.length && keep < after.data.length && before.data[keep] === after.data[keep]) {
                keep += 1;
            }
        }
        diff.text = {
            keep,
            text: after.data.slice(keep),
            base: { length: before.data.length, hash: "00000000000000" },
        };
    }
    return { diff, beforeText: before.data };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Normalizes the JSON copy of a message (what is stored), not the input: an in-process `toJSON` cannot change it after the check. */
function prepareMessage(input: unknown): PreparedMessage {
    const message = normalizeMessage(serialize(input).stored, true);
    return { id: message.chatId as string, text: serialize(message).text };
}

/**
 * `fields` without a sealed `hypaV3Data`: a projection a tab carried over from a read (a recovered
 * resend, a stale tab) is never stored. An unsealed value is a real HypaV3 write and stays here; one
 * written while the projection owns the field goes at apply time (`refusesHypaV3Data`).
 */
function withoutProjection(fields: Record<string, unknown>): Record<string, unknown> {
    if (!isSealedHypaV3Data(fields.hypaV3Data)) {
        return fields;
    }
    const { hypaV3Data: _projected, ...rest } = fields;
    return rest;
}

function prepareWholeChat(
    chat: unknown,
    chatId: string,
): { meta: string; summary: string; messages: PreparedMessage[]; renamed: boolean } {
    if (!isPlainObject(chat)) {
        throw new ResourceValidationError("chat must be an object");
    }
    const { text: meta, stored } = serialize(normalizeChatMeta(withoutProjection(chat), chatId));
    const summary = summaryText(stored as Record<string, unknown>);
    // Keep whole-array JSON semantics, but measure depth per message as `prepareMessage` does.
    const sent = chat.message === undefined ? undefined : serialize(chat.message, { arrayElementDepth: true }).stored;
    const messages = normalizeMessageList(sent, true).map((message) => ({
        id: message.chatId as string,
        text: serialize(message).text,
    }));
    // Whether an id was missing, invalid, or duplicate and was given a fresh one (a replayed group's
    // answer can rebuild `messageIds` from its own messages only when none was).
    const renamed = messages.some(
        (message, index) => (sent as { chatId?: unknown }[] | undefined)?.[index]?.chatId !== message.id,
    );
    return { meta, summary, messages, renamed };
}

function prepareGeneration(value: unknown): Generation | null {
    if (value === undefined) {
        return null;
    }
    if (
        !isPlainObject(value) ||
        !isValidResourceId(value.id) ||
        !isNonNegativeSafeInteger(value.seq) ||
        (value.final !== undefined && typeof value.final !== "boolean")
    ) {
        throw new ResourceValidationError("generation must be { id, seq, final? }");
    }
    return { id: value.id, seq: value.seq, final: value.final === true };
}

/** Whether `value` is an array whose every index holds a string (holes of an in-process array included). */
function isStringArray(value: unknown): value is string[] {
    if (!Array.isArray(value)) {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        if (typeof value[index] !== "string") {
            return false;
        }
    }
    return true;
}

/**
 * A `patchMessage`'s fields, checked as the JSON copy of `set` (what is stored): `chatId` and
 * `__proto__` are refused, `translation` is dropped (the stored one stays, as for `setMessage`),
 * `role` and `data` keep their message shape and cannot be unset, and a field left to change is
 * required.
 */
function preparePatchMessage(raw: Record<string, unknown>): PreparedOp {
    if (!isValidResourceId(raw.id)) {
        throw new ResourceValidationError("patchMessage must be { id, set?, unset? }");
    }
    if (raw.generation !== undefined) {
        throw new ResourceValidationError("patchMessage carries no generation");
    }
    const set = raw.set === undefined ? {} : serialize(raw.set).stored;
    const unset = raw.unset === undefined ? [] : raw.unset;
    if (!isPlainObject(set) || !isStringArray(unset)) {
        throw new ResourceValidationError("patchMessage must be { id, set?: object, unset?: string[] }");
    }
    for (const key of [...Object.keys(set), ...unset]) {
        if (key === "chatId" || key === "__proto__") {
            throw new ResourceValidationError(`patchMessage cannot change ${key}`);
        }
    }
    delete set.translation;
    const unsetKeys = [...new Set(unset.filter((key) => key !== "translation"))];
    if (unsetKeys.some((key) => key === "role" || key === "data")) {
        throw new ResourceValidationError("patchMessage cannot unset role or data");
    }
    if (unsetKeys.some((key) => Object.hasOwn(set, key))) {
        throw new ResourceValidationError("patchMessage sets and unsets the same field");
    }
    if (Object.keys(set).length === 0 && unsetKeys.length === 0) {
        throw new ResourceValidationError("patchMessage must set or unset a field");
    }
    if (Object.hasOwn(set, "role") && set.role !== "user" && set.role !== "char") {
        throw new ResourceValidationError("message.role must be user or char");
    }
    if (Object.hasOwn(set, "data") && typeof set.data !== "string") {
        throw new ResourceValidationError("message.data must be a string");
    }
    return { op: "patchMessage", id: raw.id, set, unset: unsetKeys };
}

function prepareIdList(value: unknown, what: string): string[] {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isValidResourceId)) {
        throw new ResourceValidationError(`${what} must be a non-empty array of ids`);
    }
    if (new Set(value).size !== value.length) {
        throw new ResourceValidationError(`${what} has duplicate ids`);
    }
    return value;
}

function prepareOp(raw: unknown, chatId: string): PreparedOp {
    if (!isPlainObject(raw) || typeof raw.op !== "string") {
        throw new ResourceValidationError("must be an object with an op");
    }
    switch (raw.op) {
        case "create": {
            if (raw.index !== undefined && !isNonNegativeSafeInteger(raw.index)) {
                throw new ResourceValidationError("create.index must be a non-negative integer");
            }
            return { op: "create", ...prepareWholeChat(raw.chat, chatId), index: raw.index ?? null };
        }
        case "delete":
            return { op: "delete" };
        case "replace":
            return { op: "replace", ...prepareWholeChat(raw.chat, chatId) };
        case "meta": {
            const set = raw.set === undefined ? {} : raw.set;
            const unset = raw.unset === undefined ? [] : raw.unset;
            if (!isPlainObject(set) || !Array.isArray(unset) || !unset.every((key) => typeof key === "string")) {
                throw new ResourceValidationError("meta must be { set?: object, unset?: string[] }");
            }
            assertPatchableMetaKeys([...Object.keys(set), ...unset]);
            if (unset.some((key) => Object.hasOwn(set, key))) {
                throw new ResourceValidationError("meta sets and unsets the same field");
            }
            // `merge`: entries added to a map field as stored (only the fields that are maps).
            const merge = raw.merge === undefined ? {} : raw.merge;
            if (
                !isPlainObject(merge) ||
                !Object.keys(merge).every((key) => CHAT_META_MERGE_KEYS.includes(key) && isPlainObject(merge[key]))
            ) {
                throw new ResourceValidationError(`meta.merge takes entries for ${CHAT_META_MERGE_KEYS.join(", ")}`);
            }
            // `mergeUnset`: entry ids removed from a map field as stored, before `merge` adds its entries.
            const mergeUnset = raw.mergeUnset === undefined ? {} : raw.mergeUnset;
            if (
                !isPlainObject(mergeUnset) ||
                !Object.keys(mergeUnset).every(
                    (key) => CHAT_META_MERGE_KEYS.includes(key) && isStringArray(mergeUnset[key]),
                )
            ) {
                throw new ResourceValidationError(
                    `meta.mergeUnset takes entry ids for ${CHAT_META_MERGE_KEYS.join(", ")}`,
                );
            }
            if (
                [...Object.keys(merge), ...Object.keys(mergeUnset)].some(
                    (key) => Object.hasOwn(set, key) || unset.includes(key),
                )
            ) {
                throw new ResourceValidationError("meta merges a field it also sets or unsets");
            }
            return {
                op: "meta",
                // A set this leaves empty still applies: the op moves the revision as sent.
                set: withoutProjection(set),
                unset,
                merge: merge as Record<string, Record<string, unknown>>,
                mergeUnset: mergeUnset as Record<string, string[]>,
            };
        }
        case "append": {
            if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
                throw new ResourceValidationError("append.messages must be a non-empty array");
            }
            const messages = raw.messages.map(prepareMessage);
            if (new Set(messages.map((message) => message.id)).size !== messages.length) {
                throw new ResourceValidationError("append.messages has duplicate ids");
            }
            const anchor = raw.anchor;
            if (
                !isPlainObject(anchor) ||
                !(
                    (anchor.start === true && Object.keys(anchor).length === 1) ||
                    (anchor.end === true && Object.keys(anchor).length === 1) ||
                    (isValidResourceId(anchor.after) && Object.keys(anchor).length === 1)
                )
            ) {
                throw new ResourceValidationError(
                    "append.anchor must be { start: true }, { end: true }, or { after: id }",
                );
            }
            return {
                op: "append",
                messages,
                anchor:
                    anchor.start === true
                        ? { start: true }
                        : anchor.end === true
                          ? { end: true }
                          : { after: anchor.after as string },
            };
        }
        case "setMessage":
            return {
                op: "setMessage",
                message: prepareMessage(raw.message),
                generation: prepareGeneration(raw.generation),
            };
        case "patchMessage":
            return preparePatchMessage(raw);
        case "setText":
            if (!isValidResourceId(raw.id) || typeof raw.text !== "string") {
                throw new ResourceValidationError("setText must be { id, text }");
            }
            return { op: "setText", id: raw.id, text: raw.text, generation: prepareGeneration(raw.generation) };
        case "remove":
            if (raw.retract !== undefined && raw.retract !== true) {
                throw new ResourceValidationError("remove.retract must be true");
            }
            return { op: "remove", ids: prepareIdList(raw.ids, "remove.ids"), retract: raw.retract === true };
        case "begin":
            if (!isValidResourceId(raw.id) || !isValidResourceId(raw.generationId)) {
                throw new ResourceValidationError("begin must be { id, generationId }");
            }
            return { op: "begin", id: raw.id, generationId: raw.generationId };
        case "selectCandidate":
            if (
                !isValidResourceId(raw.messageId) ||
                typeof raw.candidateId !== "string" ||
                raw.candidateId.length < 1 ||
                raw.candidateId.length > 32 ||
                !isPlainObject(raw.expect) ||
                !isNonNegativeSafeInteger(raw.expect.candidatesRevision)
            ) {
                throw new ResourceValidationError(
                    "selectCandidate must be { messageId, candidateId, expect: { candidatesRevision } }",
                );
            }
            return {
                op: "selectCandidate",
                messageId: raw.messageId,
                candidateId: raw.candidateId,
                expect: { candidatesRevision: raw.expect.candidatesRevision },
            };
        case "setTranslation": {
            // A non-null value is checked as its JSON copy (detached, what is stored), so an in-process
            // `toJSON` cannot turn a checked value into another one, or into a clear.
            // A value that is not JSON at all (undefined, a non-finite number) is refused like a wrong shape.
            let translation: unknown = null;
            if (raw.translation !== null) {
                try {
                    translation = serialize(raw.translation).stored;
                } catch (error) {
                    if (!(error instanceof ResourceValidationError)) {
                        throw error;
                    }
                    translation = undefined;
                }
            }
            if (!isValidResourceId(raw.id) || (translation !== null && !isMessageTranslation(translation))) {
                throw new ResourceValidationError(
                    "setTranslation must be { id, translation: MessageTranslation | null }",
                );
            }
            return { op: "setTranslation", id: raw.id, translation };
        }
        default:
            throw new ResourceValidationError(`unknown op ${raw.op}`);
    }
}

/**
 * Checks and normalizes the `chats` of a batch body before any transaction: envelope shapes, ids,
 * the legal combinations (a `create` only first, a `delete` only alone, one group per chat), and
 * every payload through the normalizers. Throws `ResourceValidationError` naming the failing entry.
 */
export function prepareChatGroups(raw: unknown): PreparedChatGroup[] {
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw)) {
        throw new ResourceValidationError("chats must be an array");
    }
    const seen = new Set<string>();
    return raw.map((entry, index) => {
        const where = `chats[${index}]`;
        if (!isPlainObject(entry) || !isValidResourceId(entry.characterId) || !isValidResourceId(entry.chatId)) {
            throw new ResourceValidationError(`${where}: must name a valid characterId and chatId`);
        }
        const key = `${entry.characterId}\u0000${entry.chatId}`;
        if (seen.has(key)) {
            throw new ResourceValidationError(`${where}: duplicate chat`);
        }
        seen.add(key);
        if (!Array.isArray(entry.ops) || entry.ops.length === 0) {
            throw new ResourceValidationError(`${where}: ops must be a non-empty array`);
        }
        const ops = entry.ops.map((op, opIndex) => {
            try {
                return prepareOp(op, entry.chatId as string);
            } catch (error) {
                if (error instanceof ResourceValidationError) {
                    throw new ResourceValidationError(`${where}.ops[${opIndex}]: ${error.message}`);
                }
                throw error;
            }
        });
        const creates = ops[0].op === "create";
        if (ops.some((op, opIndex) => op.op === "create" && opIndex > 0)) {
            throw new ResourceValidationError(`${where}: create must be the first op`);
        }
        if (ops.some((op) => op.op === "delete") && ops.length > 1) {
            throw new ResourceValidationError(`${where}: delete must be the only op`);
        }
        if (creates ? entry.baseRevision !== null : typeof entry.baseRevision !== "string") {
            throw new ResourceValidationError(
                `${where}: baseRevision must be null for a create and a revision string otherwise`,
            );
        }
        const needsCurrent =
            !creates &&
            ops.some((op) => op.op === "delete" || op.op === "replace" || (op.op === "remove" && op.ids.length > 1));
        if (
            entry.groupId !== undefined &&
            (typeof entry.groupId !== "string" ||
                entry.groupId.length === 0 ||
                entry.groupId.length > MAX_CHAT_GROUP_ID_LENGTH)
        ) {
            throw new ResourceValidationError(
                `${where}: groupId must be a string of 1 to ${MAX_CHAT_GROUP_ID_LENGTH} characters`,
            );
        }
        if (entry.retry !== undefined && (entry.retry !== true || entry.groupId === undefined)) {
            throw new ResourceValidationError(`${where}: retry must be true and needs a groupId`);
        }
        return {
            characterId: entry.characterId,
            chatId: entry.chatId,
            baseRevision: entry.baseRevision as string | null,
            ops,
            needsCurrent,
            groupId: (entry.groupId as string | undefined) ?? null,
            retry: entry.retry === true,
        };
    });
}

/** Checks the `chatOrders` of a batch body: one entry per character, ids a duplicate-free list. */
export function prepareChatOrders(raw: unknown): PreparedChatOrder[] {
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw)) {
        throw new ResourceValidationError("chatOrders must be an array");
    }
    const seen = new Set<string>();
    return raw.map((entry, index) => {
        const where = `chatOrders[${index}]`;
        if (!isPlainObject(entry) || !isValidResourceId(entry.characterId) || typeof entry.baseRevision !== "string") {
            throw new ResourceValidationError(`${where}: must be { characterId, baseRevision, ids }`);
        }
        if (seen.has(entry.characterId)) {
            throw new ResourceValidationError(`${where}: duplicate character`);
        }
        seen.add(entry.characterId);
        if (
            !Array.isArray(entry.ids) ||
            !entry.ids.every(isValidResourceId) ||
            new Set(entry.ids).size !== entry.ids.length
        ) {
            throw new ResourceValidationError(`${where}: ids must be a duplicate-free array of chat ids`);
        }
        return { characterId: entry.characterId, baseRevision: entry.baseRevision, ids: entry.ids };
    });
}

/** Number of operations a prepared chat change counts toward the batch cap. */
export function countChatOperations(
    groups: readonly PreparedChatGroup[],
    orders: readonly PreparedChatOrder[],
): number {
    return groups.reduce((total, group) => total + group.ops.length, 0) + orders.length;
}

type ChatRow = { seq: number; revision: number; meta: string };
/** A chat as a summary read selects it: no metadata, with its joined `chatSummaries` columns (null: no row). */
type ChatSummaryRow = {
    seq: number;
    characterId: string;
    id: string;
    revision: number;
    summaryRevision: number | null;
    summaryText: string | null;
};
/** A `chatSummaries` row's columns, as `freshSummaryText` compares them. */
type StoredSummary = { revision: number | null; text: string | null };
/**
 * One write of `chats.meta` (`writeChatMeta`): a new chat, whose revision starts at 0, or new metadata
 * on a stored chat, at its revision before the group's bump.
 */
type ChatMetaWrite =
    | { kind: "create"; characterId: string; id: string; meta: string }
    | { kind: "update"; seq: number; revision: number; meta: string };
type MessageRow = {
    position: number;
    data: string;
    generationId: string | null;
    generationSeq: number | null;
    generationFinal: number | null;
    generationHistory: string | null;
};

/** Earlier generation ids a message remembers, so a replayed `begin` of one never reopens it. */
export const MAX_GENERATION_HISTORY = 8;

/** Raised inside `applyChanges` for one group or order; the store collects them and rolls back. */
class ChatChangeConflict extends Error {
    readonly conflict: ChatConflict | ChatOrderConflict;
    constructor(conflict: ChatConflict | ChatOrderConflict) {
        super("Revision conflict");
        this.conflict = conflict;
    }
}

/**
 * The message ids of a group's ops that rewrite or remove a message, or "chat" for an op that
 * replaces or deletes the whole chat (the generation lock's preflight).
 */
function lockedTargets(group: PreparedChatGroup): { chat: boolean; messages: Set<string> } {
    const messages = new Set<string>();
    let chat = false;
    for (const op of group.ops) {
        switch (op.op) {
            case "delete":
            case "replace":
                chat = true;
                break;
            case "setMessage":
                messages.add(op.message.id);
                break;
            case "setText":
            case "patchMessage":
            case "begin":
            case "setTranslation":
                messages.add(op.id);
                break;
            case "selectCandidate":
                messages.add(op.messageId);
                break;
            case "remove":
                op.ids.forEach((id) => messages.add(id));
                break;
        }
    }
    return { chat, messages };
}

/**
 * The chat schema past the tables `initialize` creates, in its own transaction, before any statement
 * of `createChatTables` is prepared: creates `chatGroups`, `chatSummaries`, the memory and rebuild tables
 * with their citation relations and triggers, and the `messages_role` and `messages_checkpoints` indexes
 * when missing (on fresh and existing files alike; building the role index parses each message once,
 * while the checkpoint index scans its text), adds `memory_state`'s decline column to a table from before
 * it, where every existing row reads as not declined, and rebuilds the stored projections. `BEGIN IMMEDIATE` holds the
 * look at that column and its `ALTER` together, so a second start, at once or later, finds the column
 * and adds nothing. When the live citation relation was absent, both relations are backfilled from
 * stored event texts in this transaction, skipping text SQLite cannot parse. Rebuilds every chat's
 * projections when the `meta` table's `summaryProjectionVersion` is missing or differs from
 * `SUMMARY_PROJECTION_VERSION`, otherwise only
 * the chats with no row or a row at another revision, so an open with nothing to create or rebuild
 * writes nothing. The seqs come first and each chat's metadata is read alone, so a store with a large
 * chat never holds them all. The only pass that parses metadata for summaries at open; its rows are
 * derived data, not store writes. A metadata value that cannot be projected throws, naming the chat,
 * with the transaction left for the caller to roll back.
 */
export function openChatSchema(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE");
    const hadEventSources = db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_event_sources'")
        .get();
    db.exec(CHAT_OPEN_SCHEMA_SQL);
    if (!hadEventSources) {
        for (const { events, sources } of MEMORY_EVENT_SOURCE_TABLES) {
            db.exec(`
                INSERT OR IGNORE INTO ${sources} (chatSeq, messageId, eventId)
                    SELECT e.chatSeq, json_extract(source.value, '$.messageId'), e.id
                        FROM ${events} e,
                            json_each(CASE WHEN json_valid(e.data) THEN e.data END, '$.sources') source
                        WHERE json_type(CASE WHEN json_valid(e.data) THEN e.data END, '$.sources') = 'array'
                            AND source.type = 'object' AND json_type(source.value, '$.messageId') = 'text';
            `);
        }
    }
    const stateColumns = db.prepare("PRAGMA table_xinfo(memory_state)").all() as { name: string }[];
    if (!stateColumns.some(({ name }) => name === "adoptionDeclined")) {
        db.exec(`ALTER TABLE memory_state ADD COLUMN ${MEMORY_DECLINE_COLUMN_SQL}`);
    }
    const version = String(SUMMARY_PROJECTION_VERSION);
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'summaryProjectionVersion'").get() as
        { value: string } | undefined;
    const sameVersion = stored?.value === version;
    const rebuilt = db
        .prepare(
            sameVersion
                ? "SELECT c.seq FROM chats c LEFT JOIN chatSummaries s ON s.chatSeq = c.seq " +
                      "WHERE s.revision IS NOT c.revision ORDER BY c.seq"
                : "SELECT seq FROM chats ORDER BY seq",
        )
        .all() as { seq: number }[];
    const selectChat = db.prepare("SELECT characterId, id, revision, meta FROM chats WHERE seq = ?");
    const upsertSummary = db.prepare(UPSERT_CHAT_SUMMARY_SQL);
    for (const { seq } of rebuilt) {
        const chat = selectChat.get(seq) as { characterId: string; id: string; revision: number; meta: string };
        let text: string;
        try {
            text = summaryText(JSON.parse(chat.meta) as Record<string, unknown>);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Stored chat ${chat.characterId}/${chat.id} fails its summary projection: ${reason}`, {
                cause: error,
            });
        }
        upsertSummary.run(seq, chat.revision, text);
    }
    if (!sameVersion) {
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('summaryProjectionVersion', ?)").run(version);
    }
    db.exec("COMMIT");
}

/** Process-local attempt control, admitted only through the job write path; never a wire op. */
export type RerollAttemptWrite = {
    characterId: string;
    chatId: string;
    messageId: string;
    generationId: string;
    action: "begin" | "rollback";
};
type AttemptEntry = { before: unknown; foreign?: { value: unknown }; last: "job" | "foreign" };
type RerollAttempt = Omit<RerollAttemptWrite, "action"> & { token: string; entries: Map<string, AttemptEntry> };

/** Only the new optional fields are sanitized on legacy reads; unrelated message data stays as stored. */
function readMessage(text: string): Message {
    return normalizeCandidateFields(JSON.parse(text)) as Message;
}

function hasCandidateCheckpoints(message: Message): boolean {
    return (
        message.scriptstateCheckpoint !== undefined ||
        !!message.candidates?.some((candidate) => candidate.scriptstateAfter !== undefined)
    );
}

/** The counter is assigned after admission. Writers can neither reset it nor choose its next value. */
function withCandidateRevision(text: string, previous?: string): string {
    const message = JSON.parse(text) as Message;
    const before = previous === undefined ? undefined : (JSON.parse(previous) as Message);
    const revision = isNonNegativeSafeInteger(before?.candidatesRevision) ? before.candidatesRevision : undefined;
    const changed =
        sortedJson(message.candidates) !== sortedJson(before?.candidates) ||
        sortedJson(message.selected) !== sortedJson(before?.selected);
    delete message.candidatesRevision;
    if (changed || revision !== undefined) {
        message.candidatesRevision = nextRevision(revision ?? 0, changed ? 1 : 0);
    }
    return serialize(message).text;
}

/** Replay equality still compares the complete row's bytes, apart from the store-owned counter. */
function appendReplay(text: string, stored: string): boolean {
    const withoutRevision = (value: string) => {
        const message = JSON.parse(value);
        delete message.candidatesRevision;
        return JSON.stringify(message);
    };
    return withoutRevision(text) === withoutRevision(stored);
}

/**
 * Prepares the chat statements and returns the methods over them. The tables must exist:
 * `openChatSchema` and `createCheckpointTables` (`chatRestoreFloors`) run first.
 */
export function createChatTables(
    db: DatabaseSync,
    tokens: TokenFunctions,
    guard?: MessageGuard,
    /** Whether the memory projection answers for the chat with this `seq`: the algorithm is selected and it has event rows. */
    memory?: { projectsChat(chatSeq: number): boolean },
) {
    let attempts = new Map<string, RerollAttempt>();
    /**
     * Whether a write's unsealed `hypaV3Data` is refused because the projection owns the chat's field:
     * the projection answers for the chat (`memory.projectsChat`) and the value stored in `meta` does not
     * hold summaries, the one thing that means HypaV3 owns it (`hypaV3DataHoldsSummaries`). A boot replay,
     * a quarantine retry, or a tab from before the switch sends its ops as they were, so the field goes
     * here and the rest of the write applies, as a stale tab's sealed value does in `withoutProjection`;
     * otherwise a replayed value would stand the projection aside with no choice offered, since the
     * adoption hold is for a chat with no records. A chat with no event rows takes the value: it is what
     * the adoption choice is about, and a create is a new chat with none. A checkpoint load restores the
     * chat's fields as captured, with the captured memory rows after them (`restoredFields`), so it is
     * no write of a tab's and keeps the field.
     */
    const refusesHypaV3Data = (chatSeq: number, meta: Record<string, unknown>, restored: boolean) =>
        !restored && memory?.projectsChat(chatSeq) === true && !hypaV3DataHoldsSummaries(meta.hypaV3Data);
    let stagedAttempts: Map<string, RerollAttempt> | null = null;
    const attemptKey = (characterId: string, chatId: string) => `${characterId}\u0000${chatId}`;
    const liveAttempt = (characterId: string, chatId: string) => {
        const map = stagedAttempts ?? attempts;
        const key = attemptKey(characterId, chatId);
        const attempt = map.get(key);
        if (
            attempt &&
            (!guard?.isLive(attempt.token) || guard.holder(characterId, chatId, attempt.messageId) !== attempt.token)
        ) {
            map.delete(key);
            return undefined;
        }
        return attempt;
    };
    const mapOf = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});
    const entryOf = (map: Record<string, unknown>, key: string) => (Object.hasOwn(map, key) ? map[key] : undefined);
    function recordVariable(
        attempt: RerollAttempt | undefined,
        token: string | undefined,
        key: string,
        before: unknown,
        after: unknown,
    ) {
        if (!attempt) return;
        const own = token === attempt.token;
        let entry = attempt.entries.get(key);
        if (!entry) {
            if (!own) return;
            entry = { before, last: "job" };
            attempt.entries.set(key, entry);
        }
        entry.last = own ? "job" : "foreign";
        if (!own) entry.foreign = { value: after };
    }
    function recordMap(attempt: RerollAttempt | undefined, token: string | undefined, before: unknown, after: unknown) {
        if (!attempt || before === after) return;
        const was = mapOf(before),
            now = mapOf(after);
        for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
            if (sortedJson(entryOf(was, key)) !== sortedJson(entryOf(now, key))) {
                recordVariable(attempt, token, key, entryOf(was, key), entryOf(now, key));
            }
        }
    }

    const selectGroup = db.prepare("SELECT revision, result FROM chatGroups WHERE chatSeq = ? AND groupId = ?");
    const insertGroup = db.prepare("INSERT INTO chatGroups (chatSeq, groupId, revision, result) VALUES (?, ?, ?, ?)");
    const trimGroups = db.prepare(
        "DELETE FROM chatGroups WHERE chatSeq = ? AND seq <= " +
            "(SELECT seq FROM chatGroups WHERE chatSeq = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    );
    const groupWindow = db.prepare(
        "SELECT COUNT(*) AS count, (SELECT revision FROM chatGroups WHERE chatSeq = ?1 ORDER BY seq LIMIT 1) " +
            "AS oldest FROM chatGroups WHERE chatSeq = ?1",
    );
    const characterExists = db.prepare("SELECT 1 AS found FROM resources WHERE kind = ? AND id = ?");
    const selectChat = db.prepare("SELECT seq, revision, meta FROM chats WHERE characterId = ? AND id = ?");
    const selectChatRevision = db.prepare("SELECT seq, revision FROM chats WHERE characterId = ? AND id = ?");
    const selectRestoreFloor = db.prepare("SELECT revision FROM chatRestoreFloors WHERE chatSeq = ?");
    const insertChat = db.prepare(
        "INSERT INTO chats (characterId, id, revision, schemaVersion, meta) VALUES (?, ?, 0, ?, ?)",
    );
    const setChatMeta = db.prepare("UPDATE chats SET meta = ?, schemaVersion = ? WHERE seq = ?");
    const bumpChat = db.prepare("UPDATE chats SET revision = revision + ? WHERE seq = ?");
    // Compare-and-set: a row an older writer left behind stays stale and never turns fresh with old text.
    const advanceSummary = db.prepare("UPDATE chatSummaries SET revision = ? WHERE chatSeq = ? AND revision = ?");
    const upsertSummary = db.prepare(UPSERT_CHAT_SUMMARY_SQL);
    const selectSummary = db.prepare("SELECT revision, text FROM chatSummaries WHERE chatSeq = ?");
    const selectChatMeta = db.prepare("SELECT meta FROM chats WHERE seq = ?");
    const deleteChat = db.prepare("DELETE FROM chats WHERE seq = ?");
    const deleteCharacterChats = db.prepare("DELETE FROM chats WHERE characterId = ?");
    const selectMessage = db.prepare(
        "SELECT position, data, generationId, generationSeq, generationFinal, generationHistory FROM messages " +
            "WHERE chatSeq = ? AND id = ?",
    );
    const selectCarrierMessages = db.prepare(
        "SELECT id AS chatId, json_extract(data, '$.role') AS role, json_extract(data, '$.isComment') AS isComment " +
            "FROM messages WHERE chatSeq = ? ORDER BY position DESC",
    );
    const selectLastMessage = db.prepare("SELECT data FROM messages WHERE chatSeq = ? ORDER BY position DESC LIMIT 1");
    /**
     * Keyed by the chat incarnation. `undefined` is cached too (empty or undated last message).
     * The value is the finite numeric time of the last message by position, never MAX(time) or an
     * earlier dated message; a miss reads one row through messages_position. Metadata-only changes
     * keep it. Creation/replacement, append/insert, setMessage, setText, patchMessage, removal and
     * translation writes invalidate it, as do chat/character deletion. `data/resourceStore.ts`
     * replaceAll clears it only after commit. While db.isTransaction, lastMessageAt bypasses both
     * reading and filling this memo, so a rollback cannot leave uncommitted activity cached.
     */
    const lastMessageTimes = new Map<number, number | undefined>();
    /**
     * Counts keyed by chat incarnation. Creation/replacement seed zero, inserts/removals adjust
     * known counts, and chat/character deletion evicts them. Hooked transactions stage reads and
     * changes (undefined marks eviction), merge only after commit, and discard on rollback.
     * Without hooks, membership writes invalidate committed entries; raw transactions read COUNT
     * without consulting or filling the memo. replaceAll clears it only after commit.
     */
    const messageCounts = new Map<number, number>();
    let stagedMessageCounts: Map<number, number | undefined> | null = null;
    const maxPosition = db.prepare("SELECT MAX(position) AS position FROM messages WHERE chatSeq = ?");
    const shiftAfter = db.prepare("UPDATE messages SET position = position + ? WHERE chatSeq = ? AND position > ?");
    const insertMessage = db.prepare("INSERT INTO messages (chatSeq, id, position, data) VALUES (?, ?, ?, ?)");
    const setMessageData = db.prepare("UPDATE messages SET data = ? WHERE chatSeq = ? AND id = ?");
    const setFence = db.prepare(
        "UPDATE messages SET generationSeq = ?, generationFinal = ? WHERE chatSeq = ? AND id = ?",
    );
    const startFence = db.prepare(
        "UPDATE messages SET generationId = ?, generationSeq = 0, generationFinal = 0, generationHistory = ? " +
            "WHERE chatSeq = ? AND id = ?",
    );
    const deleteMessage = db.prepare("DELETE FROM messages WHERE chatSeq = ? AND id = ?");
    const deleteMessages = db.prepare("DELETE FROM messages WHERE chatSeq = ?");
    const selectFences = db.prepare(
        "SELECT id, generationId, generationSeq, generationHistory FROM messages " +
            "WHERE chatSeq = ? AND generationId IS NOT NULL",
    );
    const restoreClosedFence = db.prepare(
        "UPDATE messages SET generationId = ?, generationSeq = ?, generationFinal = 1, generationHistory = ? " +
            "WHERE chatSeq = ? AND id = ?",
    );
    const selectOrder = db.prepare("SELECT seq, revision, ids FROM chatOrders WHERE characterId = ?");
    const insertOrder = db.prepare("INSERT INTO chatOrders (characterId, revision, ids) VALUES (?, 1, '[]')");
    const updateOrder = db.prepare("UPDATE chatOrders SET revision = revision + 1, ids = ? WHERE seq = ?");
    const deleteOrder = db.prepare("DELETE FROM chatOrders WHERE characterId = ?");
    const selectAllChats = db.prepare("SELECT seq, characterId, id, revision, meta FROM chats ORDER BY seq");
    // Summary reads take the stored projection and never select the potentially large metadata.
    const summaryRead =
        "SELECT c.seq, c.characterId, c.id, c.revision, s.revision AS summaryRevision, s.text AS summaryText " +
        "FROM chats c LEFT JOIN chatSummaries s ON s.chatSeq = c.seq";
    const selectChatSummary = db.prepare(`${summaryRead} WHERE c.characterId = ? AND c.id = ?`);
    const selectAllSummaries = db.prepare(`${summaryRead} ORDER BY c.seq`);
    // Filter in SQL so a cached character's rows never leave SQLite.
    const selectUncachedSummaries = db.prepare(
        `${summaryRead} WHERE c.characterId NOT IN (SELECT value FROM json_each(?)) ORDER BY c.seq`,
    );
    const selectCharacterSummaries = db.prepare(`${summaryRead} WHERE c.characterId = ? ORDER BY c.seq`);
    const selectAllMessages = db.prepare("SELECT chatSeq, data FROM messages ORDER BY chatSeq, position");
    const selectChatMessages = db.prepare("SELECT data FROM messages WHERE chatSeq = ? ORDER BY position");
    // Only rows with candidate state need their previous revision carried through a replacement.
    const selectCandidateRows = db.prepare(`SELECT id, data FROM messages WHERE chatSeq = ? AND (
        json_type(data, '$.candidates') IS NOT NULL OR json_type(data, '$.selected') IS NOT NULL OR
        json_type(data, '$.candidatesRevision') IS NOT NULL)`);
    // The partial index finds possible checkpoints outside the newest non-comment row (null if none)
    // without traversing historical candidate arrays. After any fresh append, skip unchanged false
    // positives and rows a live job owns; an open generation fence with no live owner is cleaned.
    const selectCheckpointRows = db.prepare(`SELECT id, data FROM messages WHERE chatSeq = ? AND id IS NOT ?
        AND ${MESSAGE_CHECKPOINT_PREDICATE_SQL}`);
    const countMessages = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chatSeq = ?");
    const countUserTurns = db.prepare(COUNT_USER_TURNS_SQL);
    const selectPatchMessages = db.prepare(TOUCHED_ROWS_SQL);
    const selectCharacterChats = db.prepare(
        "SELECT seq, id, revision, meta FROM chats WHERE characterId = ? ORDER BY seq",
    );
    const selectAllOrders = db.prepare("SELECT seq, characterId, revision, ids FROM chatOrders ORDER BY seq");
    const selectUncachedOrders = db.prepare(
        "SELECT seq, characterId, revision, ids FROM chatOrders WHERE characterId NOT IN (SELECT value FROM json_each(?)) ORDER BY seq",
    );
    const selectChatRevisions = db.prepare("SELECT seq, characterId, id, revision FROM chats ORDER BY seq");
    const selectOrderRevisions = db.prepare("SELECT seq, characterId, revision FROM chatOrders ORDER BY seq");
    // Message search (`searchBatch`).
    const searchChatBySeq = db.prepare("SELECT seq, characterId, id FROM chats WHERE seq = ?");
    const searchNextChat = db.prepare("SELECT seq, characterId, id FROM chats WHERE seq < ? ORDER BY seq DESC LIMIT 1");
    // Unary + keeps SQLite on the descending rowid scan instead of sorting the character/id index.
    const searchNextCharacterChat = db.prepare(
        "SELECT seq, characterId, id FROM chats WHERE +characterId = ? AND seq < ? ORDER BY seq DESC LIMIT 1",
    );
    const searchChatName = db.prepare("SELECT json_extract(meta, '$.name') AS name FROM chats WHERE seq = ?");
    const searchAnchor = db.prepare("SELECT position FROM messages WHERE chatSeq = ? AND id = ?");
    // `octet_length` is the stored text's UTF-8 size (`length` on TEXT counts characters).
    const searchMessages = db.prepare(
        "SELECT id, position, octet_length(data) AS bytes, " +
            "CASE WHEN json_extract(data, '$.data') LIKE ? ESCAPE '\\' THEN data END AS hit " +
            "FROM messages WHERE chatSeq = ? AND position < ? ORDER BY position DESC LIMIT ?",
    );
    // A budgeted read's charges: stored sizes only, so no row text leaves SQLite for an entry left out.
    const selectChatBytes = db.prepare(
        "SELECT seq, revision, octet_length(meta) AS bytes FROM chats WHERE characterId = ? AND id = ?",
    );
    const sumNamedMessageBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(data)), 0) AS bytes FROM messages " +
            "WHERE chatSeq = ? AND id IN (SELECT value FROM json_each(?))",
    );
    const sumMessageBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(data)), 0) AS bytes FROM messages WHERE chatSeq = ?",
    );
    /** Point lookups of the named messages of one chat, driven by the id list (`TOUCHED_ROWS_SQL`). */
    const selectNamedMessages = db.prepare(
        "SELECT m.id, m.data FROM json_each(?) r CROSS JOIN messages m ON m.chatSeq = ? AND m.id = r.value",
    );
    const selectOrderBytes = db.prepare("SELECT octet_length(ids) AS bytes FROM chatOrders WHERE characterId = ?");
    const sumCharacterMetaBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(meta)), 0) AS bytes FROM chats WHERE characterId = ?",
    );
    const sumCharacterMessageBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(m.data)), 0) AS bytes FROM messages m " +
            "JOIN chats c ON c.seq = m.chatSeq WHERE c.characterId = ?",
    );
    const sumCharacterSummaryBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(s.text)), 0) AS bytes FROM chatSummaries s " +
            "JOIN chats c ON c.seq = s.chatSeq WHERE c.characterId = ?",
    );

    function chatRecord(
        characterId: string,
        row: { seq: number; id: string; revision: number; meta: string },
        messages: unknown[],
    ): ChatRecord {
        const data = JSON.parse(row.meta) as Chat;
        data.message = messages as Chat["message"];
        return { characterId, id: row.id, revision: tokens.token(row.seq, row.revision), data };
    }

    /** One indexed row read on a miss; metadata-only changes keep the memo. */
    function lastMessageAt(chatSeq: number): number | undefined {
        // An in-transaction reader may be followed by a rollback. Never read or fill the memo
        // there: a later metadata-only commit can reuse the rolled-back chat revision.
        if (!db.isTransaction && lastMessageTimes.has(chatSeq)) {
            return lastMessageTimes.get(chatSeq);
        }
        const row = selectLastMessage.get(chatSeq) as { data: string } | undefined;
        const time: unknown = row ? JSON.parse(row.data).time : undefined;
        const value = typeof time === "number" && Number.isFinite(time) ? time : undefined;
        if (!db.isTransaction) {
            lastMessageTimes.set(chatSeq, value);
        }
        return value;
    }

    function cachedMessageCount(chatSeq: number): number | undefined {
        return stagedMessageCounts?.has(chatSeq) ? stagedMessageCounts.get(chatSeq) : messageCounts.get(chatSeq);
    }

    function messageCount(chatSeq: number): number {
        if (stagedMessageCounts || !db.isTransaction) {
            const cached = cachedMessageCount(chatSeq);
            if (cached !== undefined) return cached;
        }
        const { count } = countMessages.get(chatSeq) as { count: number };
        if (stagedMessageCounts) stagedMessageCounts.set(chatSeq, count);
        else if (!db.isTransaction) messageCounts.set(chatSeq, count);
        return count;
    }

    function setMessageCount(chatSeq: number, count: number | undefined) {
        if (stagedMessageCounts) stagedMessageCounts.set(chatSeq, count);
        else messageCounts.delete(chatSeq);
    }

    function changeMessageCount(chatSeq: number, delta: number) {
        const count = cachedMessageCount(chatSeq);
        setMessageCount(chatSeq, count === undefined ? undefined : count + delta);
    }

    /**
     * The one writer of `chats.meta` on a live write: the only caller of the statements that write it.
     * Stores the metadata and its projection together in the caller's transaction, so no write leaves
     * the projection behind. `summary` is the metadata's `summaryText`, from the caller; nothing is
     * parsed here. Returns the chat's seq. A restore writes both tables its own way: the staged store's
     * writer (`createChatStagingSink`) and the install's copy (`copyStagedChats`).
     */
    function writeChatMeta(write: ChatMetaWrite, summary: string): number {
        let seq: number;
        let revision = 0;
        if (write.kind === "create") {
            seq = Number(insertChat.run(write.characterId, write.id, CHAT_SCHEMA_VERSION, write.meta).lastInsertRowid);
            setMessageCount(seq, 0);
        } else {
            setChatMeta.run(write.meta, CHAT_SCHEMA_VERSION, write.seq);
            ({ seq, revision } = write);
        }
        upsertSummary.run(seq, revision, summary);
        return seq;
    }

    /**
     * A chat's projection at `revision`, the revision its row must match: the stored text when the row
     * is there, otherwise computed from the stored metadata (one parse) with the row rewritten.
     * `known` is the row's columns when the caller's read joined them (its metadata is then read here
     * by seq, on a miss only), or the metadata the caller holds (the row is then read here). Call it
     * after the caller's read statement ended.
     *
     * The rewrite is derived data: it counts as no store write and publishes nothing. It never runs
     * inside a transaction: a failure there (a full disk) can make SQLite roll the whole transaction
     * back, and going on past it would let the rest of the batch autocommit. Outside one it is
     * best-effort, since a read must not fail because a derived row could not be written.
     */
    function freshSummaryText(seq: number, revision: number, known: StoredSummary | { meta: string }): string {
        const stored = "meta" in known ? (selectSummary.get(seq) as StoredSummary | undefined) : known;
        if (stored && stored.revision === revision && stored.text !== null) {
            return stored.text;
        }
        const meta = "meta" in known ? known.meta : (selectChatMeta.get(seq) as { meta: string }).meta;
        const text = summaryText(JSON.parse(meta) as Record<string, unknown>);
        if (!db.isTransaction) {
            try {
                upsertSummary.run(seq, revision, text);
            } catch {
                // The row stays stale and the next read computes it again.
            }
        }
        return text;
    }

    /**
     * A chat's summary: its stored projection and the memoized time of its last message by position.
     * Shared by full listings, collection summaries and single-chat binding reads. Feed entries use
     * the same summary fields (summaryWithTime) with the write's projection. Fresh projection reads
     * never select or parse meta; a stale/missing projection falls back to freshSummaryText, which
     * parses meta once and repairs the row best-effort outside a transaction.
     */
    function chatSummary(row: ChatSummaryRow): ChatSummary {
        return {
            characterId: row.characterId,
            id: row.id,
            revision: tokens.token(row.seq, row.revision),
            ...summaryWithTime(
                freshSummaryText(row.seq, row.revision, { revision: row.summaryRevision, text: row.summaryText }),
                lastMessageAt(row.seq),
            ),
        };
    }

    function readOrder(characterId: string): { seq: number; revision: number; ids: string[] } | null {
        const row = selectOrder.get(characterId) as { seq: number; revision: number; ids: string } | undefined;
        return row ? { seq: row.seq, revision: row.revision, ids: JSON.parse(row.ids) as string[] } : null;
    }

    /** The character's order row, created (empty) when a legacy path left it missing. */
    function ensureOrder(characterId: string) {
        const order = readOrder(characterId);
        if (order) {
            return order;
        }
        insertOrder.run(characterId);
        return readOrder(characterId)!;
    }

    /** Stores a new id list on an order row and advances its revision (guarded, see `nextRevision`). */
    function writeOrder(order: { seq: number; revision: number }, ids: readonly string[]) {
        nextRevision(order.revision, 1);
        updateOrder.run(JSON.stringify(ids), order.seq);
    }

    function insertAt(chatSeq: number, after: number, messages: readonly PreparedMessage[]) {
        lastMessageTimes.delete(chatSeq);
        shiftAfter.run(messages.length, chatSeq, after);
        messages.forEach((message, index) => {
            insertMessage.run(chatSeq, message.id, after + 1 + index, message.text);
            changeMessageCount(chatSeq, 1);
        });
    }

    function lastPosition(chatSeq: number): number {
        const row = maxPosition.get(chatSeq) as { position: number | null };
        return row.position ?? -1;
    }

    /**
     * The generation fence of a message: the current generation (`generationId`), whether it is
     * closed (`generationFinal`), its last admitted checkpoint (`generationSeq`), and the earlier
     * generation ids (`generationHistory`). A generation write lands only while its generation is the
     * current, open one and its seq is higher than the last, and updates the fence when it lands. A
     * write of the current generation whose seq is not higher is a `duplicate` (a replay; its
     * generation still owns the message); anything else is `ignored` (another generation took the
     * message over, or it was closed).
     */
    function admitGeneration(chatSeq: number, id: string, row: MessageRow, generation: Generation): CheckpointOutcome {
        if (row.generationId === generation.id && generation.seq <= (row.generationSeq ?? -1)) {
            return "duplicate";
        }
        if (row.generationId !== generation.id || row.generationFinal === 1) {
            return "ignored";
        }
        setFence.run(generation.seq, generation.final ? 1 : 0, chatSeq, id);
        return "applied";
    }

    /** A write without a generation closes an open fence: a later write of that generation is ignored. */
    function closeFence(chatSeq: number, id: string, row: MessageRow) {
        if (row.generationId !== null && row.generationFinal !== 1) {
            setFence.run(row.generationSeq, 1, chatSeq, id);
        }
    }

    /** Whether `generationId` is the message's current or a remembered earlier generation (a replay). */
    function isKnownGeneration(row: MessageRow, generationId: string): boolean {
        const history = row.generationHistory === null ? [] : (JSON.parse(row.generationHistory) as string[]);
        return row.generationId === generationId || history.includes(generationId);
    }

    /**
     * Starts a generation that `isKnownGeneration` does not know on a message: it takes the message
     * over, even from an open generation of a tab that died, whose late writes then no longer match.
     * The caller admits it only on the current chat revision or for a message appended in the same
     * group, so a delayed or replayed `begin` whose generation was forgotten cannot reopen it.
     */
    function beginGeneration(chatSeq: number, id: string, row: MessageRow, generationId: string) {
        const history = row.generationHistory === null ? [] : (JSON.parse(row.generationHistory) as string[]);
        if (row.generationId !== null) {
            history.push(row.generationId);
        }
        const kept = history.slice(-MAX_GENERATION_HISTORY);
        startFence.run(generationId, kept.length > 0 ? JSON.stringify(kept) : null, chatSeq, id);
    }

    /**
     * Applies one group inside the caller's transaction. Returns the result and the number of
     * applied operations, or throws `ChatChangeConflict`. Records every order it changed.
     */
    /** The index of the op `applyGroup` is applying, so a refusal can name it. */
    let applyingOp = -1;

    /**
     * Whether a group touches a message a generation job other than `jobToken` owns: an op that
     * rewrites or removes it, or a whole-chat replace or delete of a chat holding one. Null when it
     * does not; otherwise the messages the group's ops target that such a job owns (from the lock
     * table, in op order; empty for a whole-chat refusal that targets none of them).
     */
    function refusedByLock(group: PreparedChatGroup, jobToken: string | undefined): string[] | null {
        if (!guard) {
            return null;
        }
        const foreign = (token: string | null) => token !== null && token !== jobToken;
        const targets = lockedTargets(group);
        const locked = [...targets.messages].filter((id) => foreign(guard.holder(group.characterId, group.chatId, id)));
        if (locked.length > 0) {
            return locked;
        }
        return targets.chat && [...guard.chatHolders(group.characterId, group.chatId)].some(foreign) ? [] : null;
    }

    /**
     * The touched rows as stored now, in position order, each with the id of the row right before it
     * by position. Invalid optional candidate fields are omitted from the returned row text.
     * Lazy: nothing is read before the first row is asked for, and a caller that stops early ends the read.
     */
    function* touchedRows(chatSeq: number, touched: ReadonlySet<string>): Generator<ChatWriteChange["rows"][number]> {
        for (const stored of selectPatchMessages.iterate(JSON.stringify([...touched]), chatSeq)) {
            const row = stored as ChatWriteChange["rows"][number];
            yield { ...row, data: JSON.stringify(readMessage(row.data)) };
        }
    }

    /**
     * One optional feed body, selected by its UTF-8 JSON size: the whole-row patch below
     * `SMALL_FEED_PATCH_BYTES`, else a fitting rowDelta with at least one diff smaller than the
     * patch, else a fitting patch, else a fitting delta, else a fitting row manifest. Metadata is
     * whole in a patch and by field in both deltas. Inserted rows and rows that cannot be diffed
     * keep their whole values and anchors.
     *
     * One pass over the stored row iterator, with separate running sizes. Small patches defer the
     * alternatives; crossing the selection threshold considers the rows already read. Once a size
     * passes the cap its exact value is unnecessary. The iterator stops when all three forms exceed
     * the cap. Stored rows are parsed only for a live diff candidate or the selected whole-row body,
     * with each after value reused if the diff loses the size comparison. The manifest takes ids
     * from `touched`, never the iterator that may have stopped before reading them all.
     */
    function chatFeedChange(
        baseRevision: string,
        count: number,
        meta: { stored: string; fields: () => ChatMetaFields | null } | undefined,
        removed: ReadonlySet<string>,
        touched: ReadonlySet<string>,
        rows: Iterable<{ id: string; after: string | null; data: string }> | null,
        before: ReadonlyMap<string, string>,
        insertedHere: ReadonlySet<string>,
    ): Pick<ChatFeedPayloads, "patch" | "delta" | "rowDelta" | "rows"> {
        const removedIds = [...removed].filter((id) => !insertedHere.has(id));
        const head = Buffer.byteLength(JSON.stringify({ baseRevision, count }));
        const capped = (size: number) => Math.min(size, MAX_FEED_PATCH_BYTES + 1);
        let patchBytes = capped(head + (meta === undefined ? 0 : Buffer.byteLength(meta.stored) + ',"meta":'.length));
        let deltaBytes = head;
        let rowDeltaBytes = head + ',"rowDiffs":[]'.length;
        let fields: ChatMetaFields | null | undefined;
        const readFields = () => {
            if (fields !== undefined) return;
            fields = meta?.fields() ?? null;
            const size = fields === null ? 0 : Buffer.byteLength(JSON.stringify(fields)) + ',"metaFields":'.length;
            deltaBytes = capped(deltaBytes + size);
            rowDeltaBytes = capped(rowDeltaBytes + size);
        };
        const manifest = (): Pick<ChatFeedPayloads, "rows"> => {
            readFields();
            const rows = {
                baseRevision,
                changed: [...touched],
                removed: removedIds,
                count,
                meta: fields
                    ? [
                          ...new Set([
                              ...Object.keys(fields.set),
                              ...fields.remove,
                              ...Object.keys(fields.merge ?? {}),
                              ...Object.keys(fields.mergeUnset ?? {}),
                          ]),
                      ]
                    : [],
            };
            return Buffer.byteLength(JSON.stringify(rows)) <= MAX_FEED_PATCH_BYTES ? { rows } : {};
        };
        // Without a captured row, only an over-cap patch can make the metadata field form useful.
        const considerAlternatives = () =>
            patchBytes > MAX_FEED_PATCH_BYTES ||
            (rows !== null && before.size > 0 && patchBytes >= SMALL_FEED_PATCH_BYTES);
        const allOver = () =>
            patchBytes > MAX_FEED_PATCH_BYTES &&
            deltaBytes > MAX_FEED_PATCH_BYTES &&
            rowDeltaBytes > MAX_FEED_PATCH_BYTES;
        if (considerAlternatives()) readFields();
        if (allOver()) return manifest();
        if (removedIds.length > 0) {
            let index = 0;
            for (const id of removedIds) {
                const size = Buffer.byteLength(JSON.stringify(id)) + (index++ > 0 ? 1 : ',"removed":[]'.length);
                patchBytes = capped(patchBytes + size);
                deltaBytes = capped(deltaBytes + size);
                rowDeltaBytes = capped(rowDeltaBytes + size);
                if (considerAlternatives()) readFields();
                if (allOver()) return manifest();
            }
        }
        type FeedRow = {
            id: string;
            after: string | null;
            data: string;
            message?: Record<string, unknown>;
            bytes: number;
        };
        const kept: FeedRow[] = [];
        const whole: FeedRow[] = [];
        const rowDiffCandidates: ChatRowDiffCandidate[] = [];
        const parsed = (row: FeedRow) => (row.message ??= JSON.parse(row.data) as Record<string, unknown>);
        let considered = 0;
        const diffRows = () => {
            while (considered < kept.length && rowDeltaBytes <= MAX_FEED_PATCH_BYTES) {
                const row = kept[considered++];
                const old = insertedHere.has(row.id) ? undefined : before.get(row.id);
                const candidate = old === undefined ? null : chatRowDiff(row.id, JSON.parse(old), parsed(row));
                if (candidate) {
                    rowDeltaBytes = capped(
                        rowDeltaBytes +
                            Buffer.byteLength(JSON.stringify(candidate.diff)) +
                            (rowDiffCandidates.length > 0 ? 1 : 0),
                    );
                    rowDiffCandidates.push(candidate);
                } else {
                    rowDeltaBytes = capped(
                        rowDeltaBytes + row.bytes + (whole.length > 0 ? 1 : ',"messages":[]'.length),
                    );
                    whole.push(row);
                }
            }
        };
        if (rows) {
            patchBytes = capped(patchBytes + ',"messages":[]'.length);
            deltaBytes = capped(deltaBytes + ',"messages":[]'.length);
            if (considerAlternatives()) readFields();
            if (allOver()) return manifest();
            for (const row of rows) {
                const size =
                    Buffer.byteLength(JSON.stringify(row.after)) +
                    Buffer.byteLength(row.data) +
                    '{"after":,"message":}'.length;
                patchBytes = capped(patchBytes + size + (kept.length > 0 ? 1 : 0));
                deltaBytes = capped(deltaBytes + size + (kept.length > 0 ? 1 : 0));
                kept.push({ ...row, bytes: size });
                if (considerAlternatives()) {
                    readFields();
                    diffRows();
                }
                if (allOver()) return manifest();
            }
        }
        const useRowDelta =
            patchBytes >= SMALL_FEED_PATCH_BYTES &&
            rowDiffCandidates.length > 0 &&
            rowDeltaBytes <= MAX_FEED_PATCH_BYTES &&
            rowDeltaBytes < patchBytes;
        const usePatch = !useRowDelta && patchBytes <= MAX_FEED_PATCH_BYTES;
        if (!useRowDelta && !usePatch && deltaBytes > MAX_FEED_PATCH_BYTES) return manifest();
        const body: ChatPatchBody & ChatDeltaBody = { baseRevision, count };
        if (usePatch && meta !== undefined) {
            body.meta = JSON.parse(meta.stored) as Record<string, unknown>;
        } else if (!usePatch && fields) {
            body.metaFields = fields;
        }
        if (removedIds.length > 0) body.removed = removedIds;
        const selected = useRowDelta ? whole : kept;
        if (useRowDelta ? selected.length > 0 : rows !== null) {
            body.messages = selected.map((row) => ({ after: row.after, message: parsed(row) }));
        }
        if (useRowDelta) {
            const rowDelta: ChatRowDeltaBody = {
                ...body,
                rowDiffs: rowDiffCandidates.map(({ diff, beforeText }) => {
                    if (diff.text) {
                        diff.text.base = { length: beforeText.length, hash: textHash(beforeText) };
                    }
                    return diff;
                }),
            };
            return { rowDelta };
        }
        return usePatch ? { patch: body } : { delta: body };
    }

    /**
     * A by-id group's change as stored now (`ChatWriteChange`), uncapped: the count and one read of
     * the touched rows, with the metadata as its stored string.
     */
    function chatWriteChange(
        row: ChatRow,
        baseRevision: string,
        revision: string,
        touched: ReadonlySet<string>,
        removed: ReadonlySet<string>,
        insertedHere: ReadonlySet<string>,
        metaChanged: boolean,
    ): ChatWriteChange {
        const count = messageCount(row.seq);
        const change: ChatWriteChange = {
            baseRevision,
            revision,
            count,
            // An id the group appended and removed again was never in the base.
            removed: [...removed].filter((id) => !insertedHere.has(id)),
            rows:
                touched.size > 0
                    ? Array.from(touchedRows(row.seq, touched), ({ id, after, data }) => ({ id, after, data }))
                    : [],
        };
        if (metaChanged) {
            change.meta = row.meta;
        }
        return change;
    }

    /**
     * The answer to a group this chat incarnation already applied (`chatGroups`), or null: the
     * revision as of that group and its outcomes, every checkpoint `duplicate` (the write was made).
     * `messageIds` is rebuilt from the group's own last `create` or `replace` when the server kept
     * every sent id (the same input gives the same ids again).
     */
    function rememberedResult(group: PreparedChatGroup, row: ChatRow): ChatGroupResult | null {
        const stored = selectGroup.get(row.seq, group.groupId) as { revision: number; result: string } | undefined;
        if (!stored) {
            return null;
        }
        const remembered = JSON.parse(stored.result) as RememberedResult;
        const result: ChatGroupResult = {
            characterId: group.characterId,
            id: group.chatId,
            revision: tokens.token(row.seq, stored.revision),
        };
        if (remembered.stale) {
            result.stale = true;
        }
        const whole = [...group.ops].reverse().find((op) => op.op === "create" || op.op === "replace");
        if (remembered.messageIds) {
            result.messageIds = remembered.messageIds;
        } else if (whole) {
            result.messageIds = whole.messages.map((message) => message.id);
        }
        if (remembered.checkpoints) {
            result.checkpoints = Array.from({ length: remembered.checkpoints }, () => "duplicate" as const);
        }
        if (remembered.translations) {
            result.translations = remembered.translations;
        }
        if (remembered.selections) result.selections = remembered.selections;
        if (remembered.candidateRows) result.candidateRows = remembered.candidateRows;
        if (remembered.targets) {
            result.targets = remembered.targets;
        }
        return result;
    }

    /**
     * Whether a resent group whose id this chat does not remember may still have landed: the chat
     * dropped ids (it holds `MAX_CHAT_GROUP_IDS`) and the group's base is not newer than the oldest one
     * it kept. Groups are remembered in commit order, at non-decreasing revisions, and a group lands
     * at a revision not older than its base; so a base newer than the oldest kept group's revision
     * means the group, had it landed, would still be remembered.
     */
    function mayHaveForgotten(group: PreparedChatGroup, row: ChatRow): boolean {
        const window = groupWindow.get(row.seq) as { count: number; oldest: number | null };
        if (window.count < MAX_CHAT_GROUP_IDS || window.oldest === null) {
            return false;
        }
        const base = group.baseRevision === null ? null : tokens.parse(group.baseRevision);
        return !base || base.seq !== row.seq || base.revision <= window.oldest;
    }

    /** Remembers an applied group's id and answer, dropping the chat's oldest beyond `MAX_CHAT_GROUP_IDS`. */
    function rememberGroup(
        chatSeq: number,
        groupId: string,
        revision: number,
        result: ChatGroupResult,
        messageIdsRenamed: boolean,
    ) {
        const remembered: RememberedResult = {};
        if (result.stale) {
            remembered.stale = true;
        }
        if (result.messageIds && messageIdsRenamed) {
            remembered.messageIds = result.messageIds;
        }
        if (result.checkpoints) {
            remembered.checkpoints = result.checkpoints.length;
        }
        if (result.translations) {
            remembered.translations = result.translations;
        }
        if (result.selections) remembered.selections = result.selections;
        if (result.candidateRows) remembered.candidateRows = result.candidateRows;
        if (result.targets) {
            remembered.targets = result.targets;
        }
        // New to this incarnation: a remembered id was answered before anything applied.
        insertGroup.run(chatSeq, groupId, revision, JSON.stringify(remembered));
        trimGroups.run(chatSeq, chatSeq, MAX_CHAT_GROUP_IDS);
    }

    /**
     * A remembered groupId is answered before lock/revision checks, without reapplying it or producing
     * a feed ref; duplicate tracking is internal and adds no field to the HTTP ChatGroupResult.
     * Otherwise selectRestoreFloor refuses a base below a checkpoint load's barrier even for by-id
     * operations that may use an older revision. `data/checkpointService.ts` load sets that floor in
     * the replacement's transaction. `data/resourceStore.ts` suppresses feed refs for remembered
     * duplicate groups; other successful groups may publish a ref even when no operation changes the chat.
     */
    function applyGroup(
        group: PreparedChatGroup,
        changedOrders: Set<string>,
        jobToken: string | undefined,
        changes: boolean,
        attemptWrite?: RerollAttemptWrite,
        restoredFields = false,
    ): {
        result: ChatGroupResult;
        applied: number;
        feed?: ChatFeedPayloads;
        change?: ChatWriteChange;
        invalidated?: true;
        duplicate?: true;
        messageChanges?: ChatMessageChanges;
    } {
        const { characterId, chatId } = group;
        const conflictHere = (row: ChatRow | undefined, reason?: ChatConflict["reason"]): never => {
            throw new ChatChangeConflict({
                kind: "chat",
                characterId,
                id: chatId,
                revision: row ? tokens.token(row.seq, row.revision) : null,
                ...(reason ? { reason } : {}),
            });
        };
        let row = selectChat.get(characterId, chatId) as ChatRow | undefined;
        if (row && group.groupId !== null) {
            // Before every other check: a group this chat already applied (its answer was lost) is
            // answered as it was then, even if a job locked a message or a removed anchor would
            // refuse it now.
            const remembered = rememberedResult(group, row);
            if (remembered) {
                return { result: remembered, applied: 0, duplicate: true };
            }
            if (group.retry && mayHaveForgotten(group, row)) {
                // It may have landed before the oldest remembered group: refused, never applied twice.
                conflictHere(row, "expired");
            }
        }
        // Before the revision checks: a refused edit of a generating message must read as
        // "retry after the job", not as a stale view to reload. The locked messages it targets
        // are named, so the client can drop its edits of them and retry the rest.
        const lockedIds = refusedByLock(group, jobToken);
        if (lockedIds) {
            throw new ChatChangeConflict({
                kind: "chat",
                characterId,
                id: chatId,
                revision: row ? tokens.token(row.seq, row.revision) : null,
                reason: "generating",
                ...(lockedIds.length > 0 ? { messageIds: lockedIds } : {}),
            });
        }
        /** Whether the group names an older revision of this chat (allowed for by-id ops). */
        let stale = false;
        if (group.baseRevision === null) {
            if (row || !characterExists.get(RESOURCE_KIND.characters, characterId)) {
                conflictHere(row);
            }
        } else {
            const base = tokens.parse(group.baseRevision);
            if (
                !row ||
                !base ||
                base.seq !== row.seq ||
                base.revision <
                    ((selectRestoreFloor.get(row.seq) as { revision: number } | undefined)?.revision ?? 0) ||
                (group.needsCurrent && base.revision !== row.revision)
            ) {
                conflictHere(row);
            }
            stale = base!.revision !== row!.revision;
        }
        let attempt = liveAttempt(characterId, chatId);
        const control =
            attemptWrite?.characterId === characterId && attemptWrite.chatId === chatId ? attemptWrite : undefined;
        if (control?.action === "begin") {
            if (
                !jobToken ||
                !guard?.isLive(jobToken) ||
                guard.holder(characterId, chatId, control.messageId) !== jobToken ||
                !group.ops.some(
                    (op) =>
                        op.op === "begin" && op.id === control.messageId && op.generationId === control.generationId,
                )
            ) {
                throw new ResourceValidationError("A reroll attempt must begin with its owned generation");
            }
            attempt = { ...control, token: jobToken, entries: new Map() };
            (stagedAttempts ?? attempts).set(attemptKey(characterId, chatId), attempt);
        }
        let finishedAttempt = false;
        /** Messages this group inserted; a new generation may begin on them without the current revision. */
        const insertedHere = new Set<string>();
        // The actual stored base, which can be newer than a stale group's requested base.
        const patchBase =
            row && group.ops.every((op) => op.op !== "create" && op.op !== "replace" && op.op !== "delete")
                ? tokens.token(row.seq, row.revision)
                : null;
        // The stored metadata before the group, for the field form of its change (by-id groups).
        const metaBefore = patchBase ? row!.meta : undefined;
        /** The first stored read of each mutable row, retained only for a possible feed body. */
        const rowsBefore = new Map<string, string>();
        /** The projection right before the group's first `meta` op (by-id groups). */
        let summaryBefore: string | undefined;
        /** The projection the group's last `meta` op wrote. */
        let summaryAfter: string | undefined;
        /** Taken right before the group's first op that can change its messages, even when absent. */
        let timeBefore: { time: number | undefined } | undefined;
        const touched = new Set<string>();
        const removedIds = new Set<string>();
        /** The messages a `remove` with `retract` deleted. */
        const retractedIds = new Set<string>();
        /** The messages a person's write gave another role, data, or normalized speaker (`ChatMessageChanges`). */
        const rewrittenIds = new Set<string>();
        let reappended = false;
        let metaChanged = false;
        let applied = 0;
        let messageIds: string[] | undefined;
        let messageIdsRenamed = false;
        const checkpoints: CheckpointOutcome[] = [];
        const translations: TranslationOutcome[] = [];
        const selections: NonNullable<ChatGroupResult["selections"]> = [];
        // Keep the writer's expected counter; cleanup survives later row writes.
        const candidateWrites = new Map<string, { revision: number | null; cleaned: boolean }>();
        const expectCandidateRevision = (id: string, revision: number | null) => {
            const previous = candidateWrites.get(id);
            if (previous) previous.revision = revision;
            else candidateWrites.set(id, { revision, cleaned: false });
        };
        // Per message-editing op: whether its message was there (reported only when one was not).
        const targets: TargetOutcome[] = [];
        let deleted = false;
        /** A `delete` or `replace` applied: the chat's source changed as a whole (its source generation). */
        let invalidated = false;
        for (const [opIndex, op] of group.ops.entries()) {
            applyingOp = opIndex;
            const chatSeq = row?.seq ?? -1;
            if (op.op !== "meta" && op.op !== "begin") {
                if (patchBase && !timeBefore) {
                    timeBefore = { time: lastMessageAt(chatSeq) };
                }
                lastMessageTimes.delete(chatSeq);
            }
            switch (op.op) {
                case "create": {
                    const seq = writeChatMeta({ kind: "create", characterId, id: chatId, meta: op.meta }, op.summary);
                    insertAt(
                        seq,
                        -1,
                        op.messages.map((message) => ({ ...message, text: withCandidateRevision(message.text) })),
                    );
                    const order = ensureOrder(characterId);
                    const ids = order.ids.filter((id) => id !== chatId);
                    ids.splice(Math.min(op.index ?? ids.length, ids.length), 0, chatId);
                    writeOrder(order, ids);
                    changedOrders.add(characterId);
                    messageIds = op.messages.map((message) => message.id);
                    messageIdsRenamed = op.renamed;
                    messageIds.forEach((id) => insertedHere.add(id));
                    row = { seq, revision: 0, meta: op.meta };
                    applied += 1;
                    break;
                }
                case "delete": {
                    (stagedAttempts ?? attempts).delete(attemptKey(characterId, chatId));
                    deleteChat.run(chatSeq);
                    setMessageCount(chatSeq, undefined);
                    const order = readOrder(characterId);
                    if (order) {
                        writeOrder(
                            order,
                            order.ids.filter((id) => id !== chatId),
                        );
                        changedOrders.add(characterId);
                    }
                    deleted = true;
                    invalidated = true;
                    applied += 1;
                    break;
                }
                case "replace": {
                    // Messages that survive the replacement keep their fences, closed (a whole-chat
                    // write is a manual write), so no earlier generation can reopen them.
                    const fences = selectFences.all(chatSeq) as {
                        id: string;
                        generationId: string;
                        generationSeq: number;
                        generationHistory: string | null;
                    }[];
                    const stored = JSON.parse(row!.meta) as Record<string, unknown>;
                    const incoming = JSON.parse(op.meta) as Record<string, unknown>;
                    recordMap(attempt, jobToken, stored.scriptstate, incoming.scriptstate);
                    let { meta, summary } = op;
                    if (Object.hasOwn(incoming, "hypaV3Data") && refusesHypaV3Data(chatSeq, stored, restoredFields)) {
                        const { hypaV3Data: _refused, ...kept } = incoming;
                        meta = serialize(kept).text;
                        summary = summaryText(kept);
                    }
                    const previous = new Map(
                        (selectCandidateRows.all(chatSeq) as { id: string; data: string }[]).map(({ id, data }) => [
                            id,
                            data,
                        ]),
                    );
                    writeChatMeta({ kind: "update", seq: chatSeq, revision: row!.revision, meta }, summary);
                    deleteMessages.run(chatSeq);
                    setMessageCount(chatSeq, 0);
                    insertAt(
                        chatSeq,
                        -1,
                        op.messages.map((message) => ({
                            ...message,
                            text: withCandidateRevision(message.text, previous.get(message.id)),
                        })),
                    );
                    const kept = new Set(op.messages.map((message) => message.id));
                    for (const fence of fences) {
                        if (kept.has(fence.id)) {
                            restoreClosedFence.run(
                                fence.generationId,
                                fence.generationSeq,
                                fence.generationHistory,
                                chatSeq,
                                fence.id,
                            );
                        }
                    }
                    row = { ...row!, meta };
                    messageIds = op.messages.map((message) => message.id);
                    messageIdsRenamed = op.renamed;
                    invalidated = true;
                    applied += 1;
                    break;
                }
                case "meta": {
                    if (patchBase && summaryBefore === undefined) {
                        summaryBefore = freshSummaryText(row!.seq, row!.revision, { meta: row!.meta });
                    }
                    const current = JSON.parse(row!.meta) as Record<string, unknown>;
                    const previousVariables = current.scriptstate;
                    const { hypaV3Data: _refused, ...kept } = op.set;
                    const set =
                        Object.hasOwn(op.set, "hypaV3Data") && refusesHypaV3Data(chatSeq, current, restoredFields)
                            ? kept
                            : op.set;
                    for (const key of op.unset) {
                        delete current[key];
                    }
                    Object.assign(current, set);
                    recordMap(attempt, jobToken, previousVariables, current.scriptstate);
                    for (const key of new Set([...Object.keys(op.mergeUnset), ...Object.keys(op.merge)])) {
                        // Onto the entries as stored now: another writer's entries stay.
                        const stored = current[key];
                        const isMap = isPlainObject(stored);
                        const entries = Object.hasOwn(op.merge, key) ? op.merge[key] : undefined;
                        if (!isMap && !entries) {
                            // An explicit removal still has an origin, even when already absent.
                            if (key === "scriptstate")
                                for (const id of op.mergeUnset[key] ?? [])
                                    recordVariable(attempt, jobToken, id, undefined, undefined);
                            continue;
                        }
                        const map: Record<string, unknown> = Object.create(null);
                        if (isMap) {
                            for (const id of Object.keys(stored)) {
                                map[id] = stored[id];
                            }
                        }
                        for (const id of Object.hasOwn(op.mergeUnset, key) ? op.mergeUnset[key] : []) {
                            if (key === "scriptstate")
                                recordVariable(attempt, jobToken, id, entryOf(map, id), undefined);
                            delete map[id];
                        }
                        for (const id of Object.keys(entries ?? {})) {
                            if (key === "scriptstate")
                                recordVariable(attempt, jobToken, id, entryOf(map, id), entries![id]);
                            map[id] = entries![id];
                        }
                        current[key] = { ...map };
                    }
                    const { text: meta, stored: copy } = serialize(normalizeChatMeta(current, chatId));
                    summaryAfter = summaryText(copy as Record<string, unknown>);
                    writeChatMeta({ kind: "update", seq: chatSeq, revision: row!.revision, meta }, summaryAfter);
                    row = { ...row!, meta };
                    metaChanged = true;
                    applied += 1;
                    break;
                }
                case "append": {
                    let after: number;
                    if ("start" in op.anchor) {
                        after = -1;
                    } else if ("end" in op.anchor) {
                        after = lastPosition(chatSeq);
                    } else {
                        const anchor = selectMessage.get(chatSeq, op.anchor.after) as MessageRow | undefined;
                        if (!anchor) {
                            // The client re-anchors it after reading the chat back (`recoverChatConflicts`).
                            conflictHere(row);
                        }
                        after = anchor!.position;
                    }
                    // A replay of an append that already landed is a no-op; a different message
                    // under an existing id is a conflict.
                    const fresh: PreparedMessage[] = [];
                    for (const message of op.messages) {
                        const existing = selectMessage.get(chatSeq, message.id) as MessageRow | undefined;
                        if (!existing) {
                            const incoming = JSON.parse(message.text) as Message;
                            expectCandidateRevision(message.id, incoming.candidatesRevision ?? null);
                            let text = message.text;
                            // Comments never carry snapshots, even when a job owns their new ids.
                            if (incoming.isComment && hasCandidateCheckpoints(incoming)) {
                                text = serialize(withoutCandidateCheckpoints(incoming)).text;
                                candidateWrites.get(message.id)!.cleaned = true;
                            }
                            fresh.push({ ...message, text: withCandidateRevision(text) });
                        } else if (!appendReplay(message.text, existing.data)) {
                            conflictHere(row);
                        }
                    }
                    if (fresh.length > 0) {
                        for (const message of fresh) {
                            touched.add(message.id);
                            reappended ||= removedIds.has(message.id);
                        }
                        fresh.forEach((message) => insertedHere.add(message.id));
                        insertAt(chatSeq, after, fresh);
                        // Match isLatestReply: stop at the first non-comment, regardless of role.
                        // Read the current order so earlier ops and insertions before the tail count.
                        let newest: string | null = null;
                        for (const message of selectCarrierMessages.iterate(chatSeq)) {
                            if (message.isComment) continue;
                            newest = message.chatId as string;
                            break;
                        }
                        for (const { data } of selectCheckpointRows.all(chatSeq, newest) as { data: string }[]) {
                            const message = readMessage(data);
                            // A job may already own a row whose begin comes later in this group.
                            if (guard && guard.holder(characterId, chatId, message.chatId!) !== null) continue;
                            const cleaned = withoutCandidateCheckpoints(message);
                            if (data === JSON.stringify(cleaned)) continue;
                            const candidateWrite = candidateWrites.get(message.chatId!) ?? {
                                revision: message.candidatesRevision ?? null,
                                cleaned: false,
                            };
                            candidateWrite.cleaned = true;
                            candidateWrites.set(message.chatId!, candidateWrite);
                            if (patchBase !== null && !rowsBefore.has(message.chatId!)) {
                                rowsBefore.set(message.chatId!, data);
                            }
                            setMessageData.run(
                                withCandidateRevision(serialize(cleaned).text, data),
                                chatSeq,
                                message.chatId!,
                            );
                            touched.add(message.chatId!);
                        }
                        applied += 1;
                    }
                    break;
                }
                case "setMessage":
                case "setText":
                case "patchMessage": {
                    const id = op.op === "setMessage" ? op.message.id : op.id;
                    const existing = selectMessage.get(chatSeq, id) as MessageRow | undefined;
                    if (!existing) {
                        // Another writer removed it: this op changes nothing, the group's others apply.
                        targets.push("missing");
                        if (op.op !== "patchMessage" && op.generation) {
                            checkpoints.push("ignored");
                        }
                        break;
                    }
                    if (patchBase !== null && !rowsBefore.has(id)) {
                        rowsBefore.set(id, existing.data);
                    }
                    targets.push("applied");
                    let admittedGeneration = false;
                    if (op.op !== "patchMessage" && op.generation) {
                        const outcome = admitGeneration(chatSeq, id, existing!, op.generation);
                        checkpoints.push(outcome);
                        if (outcome !== "applied") {
                            break;
                        }
                        admittedGeneration = true;
                        if (
                            op.generation.final &&
                            attempt &&
                            attempt.token === jobToken &&
                            attempt.messageId === id &&
                            attempt.generationId === op.generation.id
                        )
                            finishedAttempt = true;
                    } else {
                        closeFence(chatSeq, id, existing!);
                    }
                    let text: string;
                    /** Whether the op changes role, data, or normalized speaker in the message's memory evidence. */
                    let rewrites: boolean;
                    if (op.op === "setMessage") {
                        // The whole row, also on a stale revision: fields the sender has not seen are
                        // replaced (`patchMessage` changes only the fields it names).
                        // A stored translation is the `setTranslation` op's: the sent message's own (an
                        // older copy, or none) never replaces or removes it.
                        const stored = JSON.parse(existing!.data) as Record<string, unknown>;
                        const message = JSON.parse(op.message.text) as Record<string, unknown>;
                        rewrites =
                            message.role !== stored.role ||
                            message.data !== stored.data ||
                            memorySourceSpeaker(message) !== memorySourceSpeaker(stored);
                        if (Object.hasOwn(message, "translation") || Object.hasOwn(stored, "translation")) {
                            delete message.translation;
                            if (Object.hasOwn(stored, "translation")) {
                                message.translation = stored.translation;
                            }
                            text = serialize(message).text;
                        } else {
                            text = op.message.text;
                        }
                    } else if (op.op === "patchMessage") {
                        // Onto the row as stored: the fields it does not name (`data` another tab
                        // wrote, the stored translation) stay. Checked again as a whole message.
                        const message = JSON.parse(existing!.data) as Record<string, unknown>;
                        const { role, data } = message;
                        const speaker = memorySourceSpeaker(message);
                        for (const key of op.unset) {
                            delete message[key];
                        }
                        for (const key of Object.keys(op.set)) {
                            message[key] = op.set[key];
                        }
                        rewrites =
                            message.role !== role || message.data !== data || memorySourceSpeaker(message) !== speaker;
                        text = serialize(normalizeMessage(message, true)).text;
                    } else {
                        const message = JSON.parse(existing!.data) as Record<string, unknown>;
                        rewrites = message.data !== op.text;
                        message.data = op.text;
                        text = serialize(message).text;
                    }
                    if (op.op !== "setText") {
                        // A field patch retains the counter the writer already holds from earlier ops.
                        if (op.op === "setMessage" || !candidateWrites.has(id)) {
                            expectCandidateRevision(
                                id,
                                (JSON.parse(op.op === "setMessage" ? op.message.text : existing!.data) as Message)
                                    .candidatesRevision ?? null,
                            );
                        }
                        if (
                            !admittedGeneration &&
                            !(jobToken !== undefined && guard?.holder(characterId, chatId, id) === jobToken) &&
                            !hasCandidateCheckpoints(JSON.parse(existing.data) as Message)
                        ) {
                            const message = JSON.parse(text) as Message;
                            if (hasCandidateCheckpoints(message)) {
                                text = serialize(withoutCandidateCheckpoints(message)).text;
                                // A stale whole-row write or journal replay must clear the writer's
                                // copies even when stripping leaves the stored bytes unchanged.
                                candidateWrites.get(id)!.cleaned = true;
                            }
                        }
                        text = withCandidateRevision(text, existing!.data);
                    }
                    setMessageData.run(text, chatSeq, id);
                    if (text !== existing!.data) {
                        touched.add(id);
                    }
                    if (rewrites && jobToken === undefined && (op.op === "patchMessage" || !op.generation)) {
                        rewrittenIds.add(id);
                    }
                    applied += 1;
                    break;
                }
                case "remove": {
                    // A single missing id is a replay or a message another tab removed: a no-op.
                    // Several are removed only under the current revision, where a missing id is a
                    // stale client view.
                    let removed = 0;
                    for (const id of op.ids) {
                        const { changes } = deleteMessage.run(chatSeq, id);
                        if (changes > 0) {
                            changeMessageCount(chatSeq, -Number(changes));
                            removedIds.add(id);
                            if (op.retract) {
                                retractedIds.add(id);
                            }
                            touched.delete(id);
                            removed += 1;
                        } else if (op.ids.length > 1) {
                            conflictHere(row);
                        }
                    }
                    if (removed > 0) {
                        applied += 1;
                    }
                    break;
                }
                case "begin": {
                    const existing = selectMessage.get(chatSeq, op.id) as MessageRow | undefined;
                    if (!existing) {
                        // Still a conflict, not a `missing` target: the job took the message's lock
                        // before this write, and only the refusal gives it back.
                        conflictHere(row);
                    }
                    if (isKnownGeneration(existing!, op.generationId)) {
                        // A replay: never reopens a finished or displaced generation.
                        break;
                    }
                    if (stale && !insertedHere.has(op.id)) {
                        // Taking over an existing message needs the current revision, so an old
                        // batch replayed after later generations cannot reopen a forgotten one.
                        conflictHere(row);
                    }
                    beginGeneration(chatSeq, op.id, existing!, op.generationId);
                    applied += 1;
                    break;
                }
                case "selectCandidate": {
                    const existing = selectMessage.get(chatSeq, op.messageId) as MessageRow | undefined;
                    const stored = existing ? (JSON.parse(existing.data) as Message) : undefined;
                    const current = JSON.parse(row!.meta) as Chat;
                    const carrierMessages: Pick<Message, "chatId" | "role" | "isComment">[] = [];
                    // Walk backward through comments, stopping at the two rows the carrier check needs.
                    for (const row of selectCarrierMessages.iterate(chatSeq)) {
                        const message = {
                            chatId: row.chatId as string,
                            role: row.role as Message["role"],
                            isComment: !!row.isComment,
                        };
                        if (message.isComment) continue;
                        carrierMessages.push(message);
                        if (carrierMessages.length === 2) break;
                    }
                    const carrierChat = { message: carrierMessages.reverse() };
                    const change =
                        stored &&
                        isRerollCarrier(carrierChat, op.messageId) &&
                        (stored.candidatesRevision ?? 0) === op.expect.candidatesRevision
                            ? selectCandidateChange(stored, op.candidateId, current.scriptstate)
                            : null;
                    if (!change) {
                        selections.push("refused");
                        break;
                    }
                    selections.push("applied");
                    expectCandidateRevision(op.messageId, op.expect.candidatesRevision);
                    if (stored!.candidates?.[stored!.selected ?? 0]?.id === op.candidateId) break;
                    expectCandidateRevision(op.messageId, op.expect.candidatesRevision + 1);
                    if (patchBase !== null && !rowsBefore.has(op.messageId)) {
                        rowsBefore.set(op.messageId, existing!.data);
                    }
                    const text = withCandidateRevision(serialize(change.message).text, existing!.data);
                    closeFence(chatSeq, op.messageId, existing!);
                    setMessageData.run(text, chatSeq, op.messageId);
                    touched.add(op.messageId);
                    if (change.message.data !== stored!.data && jobToken === undefined) rewrittenIds.add(op.messageId);
                    if (Object.keys(change.merge).length || change.mergeUnset.length) {
                        if (patchBase && summaryBefore === undefined)
                            summaryBefore = freshSummaryText(row!.seq, row!.revision, { meta: row!.meta });
                        const map = Object.assign(Object.create(null), mapOf(current.scriptstate));
                        for (const key of change.mergeUnset) {
                            recordVariable(attempt, jobToken, key, entryOf(map, key), undefined);
                            delete map[key];
                        }
                        for (const [key, value] of Object.entries(change.merge)) {
                            recordVariable(attempt, jobToken, key, entryOf(map, key), value);
                            map[key] = value;
                        }
                        // As with a meta merge, removals alone do not create an absent map.
                        if (isPlainObject(current.scriptstate) || Object.keys(change.merge).length)
                            current.scriptstate = { ...map };
                        const { text: meta, stored: copy } = serialize(normalizeChatMeta(current, chatId));
                        summaryAfter = summaryText(copy as Record<string, unknown>);
                        writeChatMeta({ kind: "update", seq: chatSeq, revision: row!.revision, meta }, summaryAfter);
                        row = { ...row!, meta };
                        metaChanged = true;
                    }
                    applied += 1;
                    break;
                }
                case "setTranslation": {
                    // Not a text write: the generation fence is left as it is.
                    const existing = selectMessage.get(chatSeq, op.id) as MessageRow | undefined;
                    if (!existing) {
                        targets.push("missing");
                        translations.push("ignored");
                        break;
                    }
                    if (patchBase !== null && !rowsBefore.has(op.id)) {
                        rowsBefore.set(op.id, existing.data);
                    }
                    targets.push("applied");
                    const message = JSON.parse(existing!.data) as Record<string, unknown>;
                    if (
                        op.translation !== null &&
                        (typeof message.data !== "string" ||
                            translationSourceHash(message.data) !== op.translation.sourceHash)
                    ) {
                        // A translation of a text the message no longer holds.
                        translations.push("ignored");
                        break;
                    }
                    translations.push("applied");
                    const had = Object.hasOwn(message, "translation");
                    if (op.translation === null) {
                        if (!had) {
                            break;
                        }
                        delete message.translation;
                    } else {
                        if (had && sortedJson(message.translation) === sortedJson(op.translation)) {
                            // The same value in any key order: no write, no revision.
                            break;
                        }
                        message.translation = op.translation;
                    }
                    setMessageData.run(serialize(message).text, chatSeq, op.id);
                    touched.add(op.id);
                    applied += 1;
                    break;
                }
            }
        }
        if (finishedAttempt && attempt) {
            if (
                control?.action === "rollback" &&
                control.generationId === attempt.generationId &&
                control.messageId === attempt.messageId &&
                row &&
                !deleted
            ) {
                if (patchBase && summaryBefore === undefined)
                    summaryBefore = freshSummaryText(row.seq, row.revision, { meta: row.meta });
                const current = JSON.parse(row.meta) as Record<string, unknown>;
                const variables = { ...mapOf(current.scriptstate) };
                for (const [key, entry] of attempt.entries) {
                    if (entry.last === "foreign") continue;
                    const value = entry.foreign ? entry.foreign.value : entry.before;
                    if (value === undefined) delete variables[key];
                    else
                        Object.defineProperty(variables, key, {
                            value,
                            enumerable: true,
                            configurable: true,
                            writable: true,
                        });
                }
                if (attempt.entries.size > 0) current.scriptstate = variables;
                const meta = serialize(normalizeChatMeta(current, chatId)).text;
                if (meta !== row.meta) {
                    summaryAfter = summaryText(current);
                    writeChatMeta({ kind: "update", seq: row.seq, revision: row.revision, meta }, summaryAfter);
                    row = { ...row, meta };
                    metaChanged = true;
                    applied += 1;
                }
            }
            (stagedAttempts ?? attempts).delete(attemptKey(characterId, chatId));
        }
        let revision: string | null = null;
        let next = 0;
        if (!deleted && row) {
            next = nextRevision(row.revision, applied);
            if (applied > 0) {
                bumpChat.run(applied, row.seq);
                // Also carries a row this group's own metadata write left at `row.revision`.
                advanceSummary.run(next, row.seq, row.revision);
            }
            revision = tokens.token(row.seq, next);
        }
        const result: ChatGroupResult = { characterId, id: chatId, revision };
        if (stale) {
            // Applied on an older revision: the client has not seen every change up to `revision`.
            result.stale = true;
        }
        if (messageIds) {
            result.messageIds = messageIds;
        }
        if (checkpoints.length > 0) {
            result.checkpoints = checkpoints;
        }
        if (translations.length > 0) {
            result.translations = translations;
        }
        if (selections.length) result.selections = selections;
        if (!deleted && row) {
            const candidateRows: NonNullable<ChatGroupResult["candidateRows"]> = [];
            for (const [id, expected] of candidateWrites) {
                const stored = selectMessage.get(row.seq, id) as MessageRow | undefined;
                if (!stored) continue;
                const message = JSON.parse(stored.data) as Message;
                const candidatesRevision = message.candidatesRevision ?? null;
                if (!expected.cleaned && candidatesRevision === expected.revision) continue;
                const cleared = expected.cleaned && !hasCandidateCheckpoints(message);
                candidateRows.push({ id, candidatesRevision, ...(cleared ? { cleared: true as const } : {}) });
            }
            if (candidateRows.length) result.candidateRows = candidateRows;
        }
        if (targets.includes("missing")) {
            result.targets = targets;
        }
        if (group.groupId !== null && !deleted && row) {
            // Every answered group, also one that changed nothing: a resend of it must not apply
            // after another writer recreated its target or changed its text. Rolled back with the
            // batch when anything conflicts.
            rememberGroup(row.seq, group.groupId, next, result, messageIdsRenamed);
        }
        let change: ChatWriteChange | undefined;
        let feed: ChatFeedPayloads | undefined;
        if (patchBase && applied > 0) {
            // Both stored metadata values, parsed at most once and only for the field form.
            let metaValues: { before: Record<string, unknown>; after: Record<string, unknown> } | undefined;
            const storedMeta = () =>
                (metaValues ??= {
                    before: JSON.parse(metaBefore!) as Record<string, unknown>,
                    after: JSON.parse(row!.meta) as Record<string, unknown>,
                });
            feed = {};
            if (!reappended) {
                const meta = metaChanged
                    ? { stored: row!.meta, fields: () => chatMetaFields(storedMeta().before, storedMeta().after) }
                    : undefined;
                if (changes) {
                    // The feed's change from the same rows, so nothing is read twice.
                    change = chatWriteChange(
                        row!,
                        patchBase,
                        revision!,
                        touched,
                        removedIds,
                        insertedHere,
                        metaChanged,
                    );
                    feed = chatFeedChange(
                        patchBase,
                        change.count,
                        meta,
                        removedIds,
                        touched,
                        touched.size > 0 ? change.rows : null,
                        rowsBefore,
                        insertedHere,
                    );
                } else {
                    // Without a change to build, the rows are read only while a form of the feed's change still fits.
                    const count = messageCount(row!.seq);
                    feed = chatFeedChange(
                        patchBase,
                        count,
                        meta,
                        removedIds,
                        touched,
                        touched.size > 0 ? touchedRows(row!.seq, touched) : null,
                        rowsBefore,
                        insertedHere,
                    );
                }
            }
            // The summary without its revision: the stored projection (equal texts are equal
            // projections) and the last message's time, which a message op can change without a
            // metadata change (a removal of the last row) or make absent.
            const time = timeBefore ? lastMessageAt(row!.seq) : undefined;
            const summaryChanged =
                (timeBefore !== undefined && time !== timeBefore.time) ||
                (metaChanged && summaryBefore !== summaryAfter);
            if (summaryChanged) {
                feed.summary = {
                    characterId,
                    id: chatId,
                    // The group's revision: `row` still holds the one before it (`bumpChat` writes only the table).
                    revision: revision!,
                    ...summaryWithTime(
                        // Checked against the group's revision: a row left stale must not publish old text at it.
                        summaryAfter ?? freshSummaryText(row!.seq, next, { meta: row!.meta }),
                        timeBefore ? time : lastMessageAt(row!.seq),
                    ),
                };
            } else {
                feed.summaryBase = patchBase;
            }
        }
        // By-id groups only: a whole-chat write says nothing of its messages one by one.
        const retracted = patchBase ? [...retractedIds].filter((id) => !insertedHere.has(id)) : [];
        const rewritten = patchBase
            ? [...rewrittenIds].filter((id) => !insertedHere.has(id) && !removedIds.has(id))
            : [];
        return {
            result,
            applied,
            change,
            feed,
            ...(invalidated ? { invalidated } : {}),
            ...(retracted.length > 0 || rewritten.length > 0
                ? { messageChanges: { characterId, id: chatId, retracted, rewritten } }
                : {}),
        };
    }

    return {
        /**
         * Creates a new character's empty chat order (inside the character's create). Returns the new
         * order's revision, or null when the character already had one.
         */
        createOrder(characterId: string): string | null {
            if (readOrder(characterId)) {
                return null;
            }
            insertOrder.run(characterId);
            const order = readOrder(characterId)!;
            return tokens.token(order.seq, order.revision);
        },

        /** Whether a generation job other than `jobToken` owns a message of the character's chats. */
        characterLocked(characterId: string, jobToken?: string): boolean {
            return !!guard && [...guard.characterHolders(characterId)].some((token) => token !== jobToken);
        },

        /** Whether a generation job owns any of the chat's `messageIds` (what `refusedByLock` reads). */
        messagesLocked(characterId: string, chatId: string, messageIds: readonly string[]): boolean {
            return !!guard && messageIds.some((id) => guard.holder(characterId, chatId, id) !== null);
        },

        /** Stage provenance and counts alongside SQLite, including later callbacks in the transaction. */
        beginTransaction() {
            for (const attempt of attempts.values()) liveAttempt(attempt.characterId, attempt.chatId);
            stagedAttempts = structuredClone(attempts);
            stagedMessageCounts = new Map();
        },
        commitTransaction() {
            if (stagedAttempts) attempts = stagedAttempts;
            stagedAttempts = null;
            for (const [chatSeq, count] of stagedMessageCounts ?? []) {
                if (count === undefined) messageCounts.delete(chatSeq);
                else messageCounts.set(chatSeq, count);
            }
            stagedMessageCounts = null;
        },
        rollbackTransaction() {
            stagedAttempts = null;
            stagedMessageCounts = null;
        },
        dropRerollAttempts(token?: string) {
            const map = stagedAttempts ?? attempts;
            for (const [key, attempt] of map) if (token === undefined || attempt.token === token) map.delete(key);
        },

        /** The chat's revision token, or null when it does not exist (no metadata or messages read). */
        chatRevision(characterId: string, id: string): string | null {
            const row = selectChatRevision.get(characterId, id) as Pick<ChatRow, "seq" | "revision"> | undefined;
            return row ? tokens.token(row.seq, row.revision) : null;
        },

        /**
         * The named rows in position order, with their immediate predecessors and named metadata
         * fields as stored. A different revision (including incarnation) or deletion answers moved;
         * no projection is overlaid, so the client's patch installer can keep its sealed projection.
         */
        readRows(request: ResourceReadEntries["chatRows"][number]): ChatRowsReadResult {
            const { characterId, id, revision, messageIds, meta } = request;
            const current = selectChatRevision.get(characterId, id) as Pick<ChatRow, "seq" | "revision"> | undefined;
            const token = current ? tokens.token(current.seq, current.revision) : null;
            if (!current || token !== revision) {
                return { characterId, id, revision: token, moved: true };
            }
            const rows = Array.from(touchedRows(current.seq, new Set(messageIds)), ({ id, after, data }) => ({
                id,
                after,
                message: JSON.parse(data) as Record<string, unknown>,
            }));
            if (meta.length === 0) return { characterId, id, revision, rows };
            const stored = JSON.parse((selectChat.get(characterId, id) as ChatRow).meta) as Record<string, unknown>;
            const metaFields: ChatMetaFields = {
                set: Object.fromEntries(
                    meta.filter((name) => Object.hasOwn(stored, name)).map((name) => [name, stored[name]]),
                ),
                remove: meta.filter((name) => !Object.hasOwn(stored, name)),
            };
            return { characterId, id, revision, rows, metaFields };
        },

        /**
         * Named rows' stored UTF-8 bytes, plus conservative whole metadata bytes when fields are named, before parsing.
         */
        rowsBytes({ characterId, id, revision, messageIds, meta }: ResourceReadEntries["chatRows"][number]): number {
            const row = selectChatBytes.get(characterId, id) as
                { seq: number; revision: number; bytes: number } | undefined;
            if (!row || tokens.token(row.seq, row.revision) !== revision) return 0;
            const messages = sumNamedMessageBytes.get(row.seq, JSON.stringify(messageIds)) as { bytes: number };
            return messages.bytes + (meta.length > 0 ? row.bytes : 0);
        },

        /**
         * The chat's stored messages among `messageIds`, by id: one point lookup each, and no other row is
         * read. An id the chat does not hold, or a chat that does not exist, is left out.
         */
        readMessagesById(characterId: string, chatId: string, messageIds: readonly string[]): Map<string, Message> {
            const found = new Map<string, Message>();
            const row = selectChatRevision.get(characterId, chatId) as Pick<ChatRow, "seq"> | undefined;
            if (!row || messageIds.length === 0) return found;
            const rows = selectNamedMessages.all(JSON.stringify([...new Set(messageIds)]), row.seq) as {
                id: string;
                data: string;
            }[];
            for (const { id, data } of rows) found.set(id, readMessage(data));
            return found;
        },

        /** How many of the chat's messages have the user role, or null when it does not exist (no message row read). */
        countUserTurns(characterId: string, id: string): number | null {
            const row = selectChatRevision.get(characterId, id) as Pick<ChatRow, "seq"> | undefined;
            return row ? (countUserTurns.get(row.seq) as { count: number }).count : null;
        },

        /** A chat's summary (listed fields and memoized last-message time), or null when it does not exist. */
        readChatSummary(characterId: string, id: string): ChatSummary | null {
            const row = selectChatSummary.get(characterId, id) as ChatSummaryRow | undefined;
            return row ? chatSummary(row) : null;
        },

        /** A chat's metadata with an empty `message` list (its messages are not read), or null when it does not exist. */
        readChatMeta(characterId: string, id: string): ChatRecord | null {
            const row = selectChat.get(characterId, id) as ChatRow | undefined;
            return row ? chatRecord(characterId, { ...row, id }, []) : null;
        },

        /** A chat's incarnation (`chats.seq`), or null when it does not exist. */
        chatSeq(characterId: string, id: string): number | null {
            const row = selectChatRevision.get(characterId, id) as Pick<ChatRow, "seq"> | undefined;
            return row ? row.seq : null;
        },

        /** A chat's metadata `name` for a search hit ("" when it has none or the chat is gone). */
        searchChatName(seq: number): string {
            const row = searchChatName.get(seq) as { name: unknown } | undefined;
            return typeof row?.name === "string" ? row.name : "";
        },

        /**
         * One synchronous batch of a message search: the scope's chats by `seq` descending, each
         * chat's messages by `position` descending, every message charged and handed to `visit` (with
         * its JSON only when its text matches the `LIKE` pattern), until `visit` ends the request
         * (`stopped`), the batch is full, or the scope is exhausted (`end`). A batch is full at
         * `maxRows` units (one per message row and one per chat looked at, so empty or skipped chats
         * cannot keep it running) or `maxBytes` (the messages' UTF-8 bytes plus what `scope.eligible`
         * charged); the limits are checked after each unit, so a batch always advances. `resume` is
         * where the next batch starts: a resumed message's chat continues below that message's
         * current position (found again by id, so inserts before it neither repeat nor skip rows; its
         * stored position when it is gone), and a chat that is gone or out of scope continues with
         * the next lower `seq`. Rows are read lazily and the scan statement is reset before
         * returning, so nothing stays open across the caller's yield.
         */
        searchBatch(args: {
            scope: MessageSearchScope;
            pattern: string;
            from: MessageSearchResume;
            maxRows: number;
            maxBytes: number;
            visit: (chat: MessageSearchChat, row: MessageSearchRow) => boolean;
        }): { resume: MessageSearchResume; stopped: boolean; end: boolean } {
            const { scope, pattern, maxRows, maxBytes, visit } = args;
            let rows = 0;
            let bytes = 0;
            let scanned = 0;
            const full = () => rows >= maxRows || bytes >= maxBytes;
            const inScope = (chat: MessageSearchChat) => {
                if (scope.kind === "chat") {
                    return chat.seq === scope.seq;
                }
                if (scope.kind === "character") {
                    return chat.characterId === scope.characterId;
                }
                const verdict = scope.eligible(chat.characterId);
                bytes += verdict.bytes;
                return verdict.eligible;
            };
            /** The next in-scope chat below `belowSeq`, or where the batch filled up while skipping. */
            const nextChat = (belowSeq: number): { chat: MessageSearchChat } | { end: true } | { full: number } => {
                for (;;) {
                    if (full()) {
                        return { full: belowSeq };
                    }
                    rows += 1;
                    const row = (
                        scope.kind === "chat"
                            ? scope.seq < belowSeq
                                ? searchChatBySeq.get(scope.seq)
                                : undefined
                            : scope.kind === "character"
                              ? searchNextCharacterChat.get(scope.characterId, belowSeq)
                              : searchNextChat.get(belowSeq)
                    ) as MessageSearchChat | undefined;
                    if (!row) {
                        return { end: true };
                    }
                    if (scope.kind !== "all" || inScope(row)) {
                        return { chat: row };
                    }
                    belowSeq = row.seq;
                }
            };

            let resume = args.from;
            let chat: MessageSearchChat | null = null;
            let below = Number.MAX_SAFE_INTEGER;
            if (resume && "message" in resume) {
                const anchor = resume.message;
                const head = searchChatBySeq.get(anchor.chatSeq) as MessageSearchChat | undefined;
                if (head && inScope(head)) {
                    chat = head;
                    const found = searchAnchor.get(anchor.chatSeq, anchor.messageId) as
                        { position: number } | undefined;
                    below = found ? found.position : anchor.position;
                } else {
                    resume = { belowSeq: anchor.chatSeq };
                }
            }
            for (;;) {
                if (!chat) {
                    const next = nextChat(resume && "belowSeq" in resume ? resume.belowSeq : Number.MAX_SAFE_INTEGER);
                    if ("end" in next) {
                        return { resume, stopped: false, end: true };
                    }
                    if ("full" in next) {
                        return { resume: { belowSeq: next.full }, stopped: false, end: false };
                    }
                    chat = next.chat;
                    below = Number.MAX_SAFE_INTEGER;
                    // Nothing of it scanned yet: a batch that ends here starts the next one at it.
                    resume = { belowSeq: chat.seq + 1 };
                }
                // A batch scans at least one row of the chat it reached (or finds it empty), so it
                // always advances even when skipping chats or a character's eligibility filled it.
                if (scanned > 0 && full()) {
                    return { resume, stopped: false, end: false };
                }
                let stopped = false;
                let filled = false;
                const rowLimit = Math.max(1, maxRows - rows);
                for (const row of searchMessages.iterate(
                    pattern,
                    chat.seq,
                    below,
                    rowLimit,
                ) as Iterable<MessageSearchRow>) {
                    rows += 1;
                    scanned += 1;
                    bytes += row.bytes;
                    resume = { message: { chatSeq: chat.seq, messageId: row.id, position: row.position } };
                    if (visit(chat, row)) {
                        stopped = true;
                        break;
                    }
                    if (full()) {
                        filled = true;
                        break;
                    }
                }
                if (stopped) {
                    return { resume, stopped: true, end: false };
                }
                if (filled) {
                    // The chat may hold more rows below the last one.
                    return { resume, stopped: false, end: false };
                }
                // The rows ran out before the limit (the full check above ends a batch at the limit):
                // every row of this chat is scanned.
                resume = { belowSeq: chat.seq };
                chat = null;
            }
        },

        /**
         * Deletes a character's chats, their messages, and its order (inside the character's delete).
         * Returns the ids of the chats it deleted (the store advances each one's source generation)
         * and whether an order existed.
         */
        deleteCharacter(characterId: string): { chatIds: string[]; order: boolean } {
            const rows = selectCharacterChats.all(characterId) as { seq: number; id: string }[];
            const chatIds = rows.map((row) => row.id);
            for (const row of rows) {
                lastMessageTimes.delete(row.seq);
                setMessageCount(row.seq, undefined);
            }
            const order = readOrder(characterId) !== null;
            deleteCharacterChats.run(characterId);
            deleteOrder.run(characterId);
            return { chatIds, order };
        },

        /**
         * Applies prepared chat groups, then reorders, inside the caller's transaction. A reorder is
         * compared with the order revision from before this batch (`orderBases`) and must be a
         * permutation of the list after this batch's creates and deletes; that check is skipped once
         * anything conflicted (`priorConflicts`: a resource op did), since the batch rolls back and a
         * conflicting change is missing from the list. Returns every conflict found (the caller rolls
         * back when there is one), the results, the applied count, each applied by-id group's feed
         * payloads (`feed`, by result), the chats a `delete` or `replace` applied to (`invalidated`,
         * once each, in group order), and what the groups did to messages (`messageChanges`, a group
         * with nothing to report left out). With `changes`, also each group's own change (`changes`,
         * aligned with the results; undefined for a group without one).
         */
        apply(
            groups: readonly PreparedChatGroup[],
            orders: readonly PreparedChatOrder[],
            orderBases: ReadonlyMap<string, { seq: number; revision: number } | null>,
            priorConflicts: boolean,
            jobToken?: string,
            changes = false,
            attemptWrite?: RerollAttemptWrite,
            /** A checkpoint load: the groups restore a chat's fields as captured (`refusesHypaV3Data`). */
            restoredFields = false,
        ) {
            const conflicts: (ChatConflict | ChatOrderConflict)[] = [];
            const results: ChatGroupResult[] = [];
            // Feed-only data: kept outside the HTTP batch's ChatGroupResult entries.
            const feed = new Map<ChatGroupResult, ChatFeedPayloads>();
            const duplicates = new Set<ChatGroupResult>();
            // Only for a writer that asked; kept outside the results like the feed's payloads.
            const written: (ChatWriteChange | undefined)[] | undefined = changes ? [] : undefined;
            const changedOrders = new Set<string>();
            const invalidated: { characterId: string; id: string }[] = [];
            const messageChanges: ChatMessageChanges[] = [];
            let applied = 0;
            for (const [index, group] of groups.entries()) {
                applyingOp = -1;
                try {
                    const outcome = applyGroup(group, changedOrders, jobToken, changes, attemptWrite, restoredFields);
                    results.push(outcome.result);
                    written?.push(outcome.change);
                    if (outcome.duplicate) {
                        duplicates.add(outcome.result);
                    }
                    if (outcome.feed) {
                        feed.set(outcome.result, outcome.feed);
                    }
                    if (outcome.invalidated) {
                        invalidated.push({ characterId: group.characterId, id: group.chatId });
                    }
                    if (outcome.messageChanges) {
                        messageChanges.push(outcome.messageChanges);
                    }
                    applied += outcome.applied;
                } catch (error) {
                    if (error instanceof ResourceValidationError) {
                        // Data refused only once merged (a metadata patch): name the group like the
                        // up-front checks do, so the client can quarantine just this chat.
                        const where = applyingOp >= 0 ? `chats[${index}].ops[${applyingOp}]` : `chats[${index}]`;
                        throw new ResourceValidationError(`${where}: ${error.message}`);
                    }
                    if (!(error instanceof ChatChangeConflict)) {
                        throw error;
                    }
                    conflicts.push(error.conflict);
                }
            }
            for (const change of orders) {
                const before = orderBases.get(change.characterId) ?? null;
                const current = readOrder(change.characterId);
                const base = tokens.parse(change.baseRevision);
                if (!current || !before || !base || base.seq !== before.seq || base.revision !== before.revision) {
                    // The committed revision, which survives the rollback (not the tentative one).
                    conflicts.push({
                        kind: "chatOrder",
                        characterId: change.characterId,
                        revision: before ? tokens.token(before.seq, before.revision) : null,
                    });
                    continue;
                }
                if (priorConflicts || conflicts.length > 0) {
                    // The batch rolls back; the membership seen here may miss a change that
                    // conflicted, so a permutation check would misreport a conflict as invalid.
                    continue;
                }
                const expected = new Set(current.ids);
                if (change.ids.length !== expected.size || !change.ids.every((id) => expected.has(id))) {
                    throw new ResourceValidationError(
                        `chatOrders for ${change.characterId}: ids must be a permutation of the character's chats`,
                    );
                }
                writeOrder(current, change.ids);
                changedOrders.add(change.characterId);
                applied += 1;
            }
            const orderResults: ChatOrderResult[] = [];
            for (const characterId of changedOrders) {
                const order = readOrder(characterId);
                if (order) {
                    orderResults.push({
                        characterId,
                        revision: tokens.token(order.seq, order.revision),
                        ids: order.ids,
                    });
                }
            }
            return {
                conflicts,
                results,
                orders: orderResults,
                applied,
                feed,
                duplicates,
                invalidated,
                messageChanges,
                changes: written,
            };
        },

        /** The order rows the given reorders name, as they are before the batch writes anything. */
        orderBases(orders: readonly PreparedChatOrder[]): Map<string, { seq: number; revision: number } | null> {
            return new Map(
                orders.map((change) => {
                    const order = readOrder(change.characterId);
                    return [change.characterId, order ? { seq: order.seq, revision: order.revision } : null];
                }),
            );
        },

        /** Every chat's and every chat order's revision, without their data. */
        listRevisions(): {
            chats: { characterId: string; id: string; revision: string }[];
            chatOrders: { characterId: string; revision: string }[];
        } {
            const chats = (
                selectChatRevisions.all() as { seq: number; characterId: string; id: string; revision: number }[]
            ).map((row) => ({
                characterId: row.characterId,
                id: row.id,
                revision: tokens.token(row.seq, row.revision),
            }));
            const chatOrders = (
                selectOrderRevisions.all() as { seq: number; characterId: string; revision: number }[]
            ).map((row) => ({ characterId: row.characterId, revision: tokens.token(row.seq, row.revision) }));
            return { chats, chatOrders };
        },

        /** Every chat (metadata plus messages in order) and every chat order, in one read. */
        readAll(): { chats: ChatRecord[]; chatOrders: ChatOrderRecord[] } {
            const messagesBySeq = new Map<number, unknown[]>();
            for (const row of selectAllMessages.all() as { chatSeq: number; data: string }[]) {
                let list = messagesBySeq.get(row.chatSeq);
                if (!list) {
                    list = [];
                    messagesBySeq.set(row.chatSeq, list);
                }
                list.push(readMessage(row.data));
            }
            const chats = (
                selectAllChats.all() as {
                    seq: number;
                    characterId: string;
                    id: string;
                    revision: number;
                    meta: string;
                }[]
            ).map((row) => chatRecord(row.characterId, row, messagesBySeq.get(row.seq) ?? []));
            const chatOrders = (
                selectAllOrders.all() as { seq: number; characterId: string; revision: number; ids: string }[]
            ).map((row) => ({
                characterId: row.characterId,
                revision: tokens.token(row.seq, row.revision),
                ids: JSON.parse(row.ids) as string[],
            }));
            return { chats, chatOrders };
        },

        /** Summaries and orders in seq order, without reading any skipped character's rows or order ids. */
        readSummaries(skip?: ReadonlySet<string>): { chatSummaries: ChatSummary[]; chatOrders: ChatOrderRecord[] } {
            const skipped = skip?.size ? JSON.stringify([...skip]) : null;
            const chatSummaries = (
                (skipped === null ? selectAllSummaries.all() : selectUncachedSummaries.all(skipped)) as ChatSummaryRow[]
            ).map((row) => chatSummary(row));
            const chatOrders = (
                (skipped === null ? selectAllOrders.all() : selectUncachedOrders.all(skipped)) as {
                    seq: number;
                    characterId: string;
                    revision: number;
                    ids: string;
                }[]
            ).map((row) => ({
                characterId: row.characterId,
                revision: tokens.token(row.seq, row.revision),
                ids: JSON.parse(row.ids) as string[],
            }));
            return { chatSummaries, chatOrders };
        },

        /** A character's order and its chats' summaries (with memoized last-message times), or null when it has no order. */
        readCollectionSummaries(characterId: string): { order: ChatOrderRecord; chats: ChatSummary[] } | null {
            const order = readOrder(characterId);
            if (!order) {
                return null;
            }
            const chats = (selectCharacterSummaries.all(characterId) as ChatSummaryRow[]).map((row) =>
                chatSummary(row),
            );
            return {
                order: { characterId, revision: tokens.token(order.seq, order.revision), ids: order.ids },
                chats,
            };
        },

        /** One chat, or null when it does not exist. */
        readChat(characterId: string, id: string): ChatRecord | null {
            const row = selectChat.get(characterId, id) as ChatRow | undefined;
            if (!row) {
                return null;
            }
            const messages = (selectChatMessages.all(row.seq) as { data: string }[]).map((entry) =>
                readMessage(entry.data),
            );
            return chatRecord(characterId, { ...row, id }, messages);
        },

        /** A character's order and every chat of it, or null when the character has no order. */
        readCollection(characterId: string): { order: ChatOrderRecord; chats: ChatRecord[] } | null {
            const order = readOrder(characterId);
            if (!order) {
                return null;
            }
            const chats = (
                selectCharacterChats.all(characterId) as { seq: number; id: string; revision: number; meta: string }[]
            ).map((row) => {
                const messages = (selectChatMessages.all(row.seq) as { data: string }[]).map((entry) =>
                    readMessage(entry.data),
                );
                return chatRecord(characterId, row, messages);
            });
            return {
                order: { characterId, revision: tokens.token(order.seq, order.revision), ids: order.ids },
                chats,
            };
        },

        /** A chat's stored bytes, its metadata and message rows, or 0 when it does not exist. */
        chatBytes(characterId: string, id: string): number {
            const chat = selectChatBytes.get(characterId, id) as { seq: number; bytes: number } | undefined;
            if (!chat) {
                return 0;
            }
            return chat.bytes + (sumMessageBytes.get(chat.seq) as { bytes: number }).bytes;
        },

        /**
         * What `readCollection` reads, in stored bytes: the order and every chat of the character, also one
         * the order does not list, since it reads them all. 0 without an order, when it reads no chat.
         */
        collectionBytes(characterId: string): number {
            const order = selectOrderBytes.get(characterId) as { bytes: number } | undefined;
            if (!order) {
                return 0;
            }
            return (
                order.bytes +
                (sumCharacterMetaBytes.get(characterId) as { bytes: number }).bytes +
                (sumCharacterMessageBytes.get(characterId) as { bytes: number }).bytes
            );
        },

        /**
         * What `readCollectionSummaries` reads, in stored bytes: the order and the stored projections as
         * they stand, since charging rebuilds no row and reads no last-message time. 0 without an order.
         */
        collectionSummaryBytes(characterId: string): number {
            const order = selectOrderBytes.get(characterId) as { bytes: number } | undefined;
            if (!order) {
                return 0;
            }
            return order.bytes + (sumCharacterSummaryBytes.get(characterId) as { bytes: number }).bytes;
        },

        /** Drops the chat memos: an install's commit gave every chat a new seq. */
        forgetChatMemos() {
            lastMessageTimes.clear();
            messageCounts.clear();
        },
    };
}

export type ChatTables = ReturnType<typeof createChatTables>;

/**
 * Which chats a message search scans: one chat incarnation, one character's chats, or every chat
 * whose character `eligible` admits (`bytes`: what deciding cost, charged to the batch).
 */
export type MessageSearchScope =
    | { kind: "chat"; seq: number }
    | { kind: "character"; characterId: string }
    | { kind: "all"; eligible(characterId: string): { eligible: boolean; bytes: number } };

/** The last message a search scanned: its chat incarnation (`chats.seq`), `Message.chatId`, and position then. */
export type MessageSearchPosition = { chatSeq: number; messageId: string; position: number };

/**
 * Where a search batch starts: below a scanned message (in its chat, then the lower chats), with the
 * chats below `belowSeq`, or (null) at the newest chat.
 */
export type MessageSearchResume = { message: MessageSearchPosition } | { belowSeq: number } | null;

export type MessageSearchChat = { seq: number; characterId: string; id: string };
/** A scanned message row: `bytes` is its stored JSON's UTF-8 size; `hit` that JSON when its text matched. */
export type MessageSearchRow = { id: string; position: number; bytes: number; hit: string | null };

/** Context kept around a search hit's match, in UTF-16 code units. */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;

/** ASCII-only case folding, as SQLite's `LIKE` compares; keeps every index in place. */
function foldAscii(text: string): string {
    return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text.slice(start, end)` widened or narrowed so neither edge splits a surrogate pair. */
function sliceWhole(text: string, start: number, end: number): { text: string; start: number } {
    if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
        start += 1;
    }
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
        end -= 1;
    }
    return { text: text.slice(start, Math.max(start, end)), start };
}

/**
 * A search hit's snippet: up to 60 code units before the first match of `query` in `text` and 120
 * after it, found with the ASCII-only case folding `LIKE` used (not `toLowerCase`, which folds more
 * than `LIKE` matched). `matchStart` and `matchLength` are UTF-16 offsets into the snippet. When the
 * match cannot be found again (the text changed meaning between SQLite and JavaScript), returns null.
 */
export function messageSearchSnippet(
    text: string,
    query: string,
): { snippet: string; matchStart: number; matchLength: number } | null {
    const index = foldAscii(text).indexOf(foldAscii(query));
    if (index < 0) {
        return null;
    }
    const cut = sliceWhole(
        text,
        Math.max(0, index - SNIPPET_BEFORE),
        Math.min(text.length, index + query.length + SNIPPET_AFTER),
    );
    return { snippet: cut.text, matchStart: index - cut.start, matchLength: query.length };
}

/**
 * Reads and checks the chat tables of a snapshot file, one row at a time: every chat belongs to a
 * character of the snapshot, is unique, and has metadata the normalizer accepts; every message
 * belongs to a chat, has a unique id equal to its JSON `chatId`, a distinct integer position, a
 * valid message, and a well-formed fence; every character has exactly one order with a positive
 * unique `seq`, and each order is a duplicate-free permutation of that character's chats. Each row
 * goes to `sink` once it passed, chats by seq, messages by chat and position, orders by seq. Throws
 * `ResourceValidationError`. Returns each chat's id by its seq, for the checkpoint and memory tables.
 *
 * Message positions are handed on compacted to `0..n-1` in stored order: positions are internal, and
 * the insertion arithmetic assumes they start at or above 0 and leave room to grow (a crafted
 * snapshot could otherwise place one below the `start` anchor or at the safe-integer limit). Messages
 * arrive ordered by chat, so the sets that find a duplicate hold one chat's ids at a time.
 */
export function walkChatSnapshot(
    source: DatabaseSync,
    characterIds: ReadonlySet<string>,
    sink: ChatSnapshotSink,
    signal?: AbortSignal,
): ReadonlyMap<number, string> {
    const chatKeys = new Set<string>();
    const chatIds = new Map<number, string>();
    const chatsByCharacter = new Map<string, Set<string>>();
    for (const [row, number] of snapshotRows(
        source,
        "SELECT seq, characterId, id, revision, schemaVersion, meta FROM chats ORDER BY seq",
        NOT_A_RESOURCE_DATABASE,
        signal,
    )) {
        const where = `chat row ${number}`;
        if (!isPositiveSafeInteger(row.seq) || !isPositiveSafeInteger(row.revision) || chatIds.has(row.seq)) {
            throw new ResourceValidationError(`${where}: invalid seq or revision`);
        }
        if (typeof row.characterId !== "string" || !characterIds.has(row.characterId)) {
            throw new ResourceValidationError(`${where}: no such character`);
        }
        if (!isValidResourceId(row.id)) {
            throw new ResourceValidationError(`${where}: invalid id`);
        }
        const key = `${row.characterId}\u0000${row.id}`;
        if (chatKeys.has(key)) {
            throw new ResourceValidationError(`${where}: duplicate chat`);
        }
        chatKeys.add(key);
        if (row.schemaVersion !== CHAT_SCHEMA_VERSION) {
            throw new ResourceValidationError(`${where}: unsupported schema version`);
        }
        let meta: { text: string; stored: unknown };
        try {
            meta = serialize(normalizeChatMeta(JSON.parse(String(row.meta)), row.id));
        } catch (error) {
            throw new ResourceValidationError(
                `${where}: ${error instanceof ResourceValidationError ? error.message : "meta is not JSON"}`,
            );
        }
        chatIds.set(row.seq, row.id);
        let list = chatsByCharacter.get(row.characterId);
        if (!list) {
            list = new Set();
            chatsByCharacter.set(row.characterId, list);
        }
        list.add(row.id);
        sink.chat(
            {
                seq: row.seq,
                characterId: row.characterId,
                id: row.id,
                revision: row.revision,
                schemaVersion: CHAT_SCHEMA_VERSION,
                meta: meta.text,
            },
            meta.stored as Record<string, unknown>,
        );
    }

    let currentChat: number | null = null;
    const messageIds = new Set<string>();
    const positions = new Set<unknown>();
    for (const [row, number] of snapshotRows(
        source,
        "SELECT chatSeq, id, position, data, generationId, generationSeq, generationFinal, generationHistory " +
            "FROM messages ORDER BY chatSeq, position",
        NOT_A_RESOURCE_DATABASE,
        signal,
    )) {
        const where = `message row ${number}`;
        if (typeof row.chatSeq !== "number" || !chatIds.has(row.chatSeq)) {
            throw new ResourceValidationError(`${where}: no such chat`);
        }
        if (row.chatSeq !== currentChat) {
            currentChat = row.chatSeq;
            messageIds.clear();
            positions.clear();
        }
        if (!isValidResourceId(row.id)) {
            throw new ResourceValidationError(`${where}: invalid id`);
        }
        if (messageIds.has(row.id)) {
            throw new ResourceValidationError(`${where}: duplicate message id`);
        }
        if (!Number.isSafeInteger(row.position) || positions.has(row.position)) {
            throw new ResourceValidationError(`${where}: invalid or duplicate position`);
        }
        messageIds.add(row.id);
        positions.add(row.position);
        let data: string;
        try {
            const message = normalizeMessage(JSON.parse(String(row.data)));
            if (message.chatId !== row.id) {
                throw new ResourceValidationError("message.chatId must equal the row id");
            }
            data = serialize(message).text;
        } catch (error) {
            throw new ResourceValidationError(
                `${where}: ${error instanceof ResourceValidationError ? error.message : "data is not JSON"}`,
            );
        }
        const fenced = row.generationId !== null;
        let historyValid = row.generationHistory === null;
        if (fenced && typeof row.generationHistory === "string") {
            try {
                const history = JSON.parse(row.generationHistory) as unknown;
                historyValid =
                    Array.isArray(history) &&
                    history.length >= 1 &&
                    history.length <= MAX_GENERATION_HISTORY &&
                    history.every(isValidResourceId) &&
                    new Set(history).size === history.length &&
                    !history.includes(row.generationId as string);
            } catch {
                historyValid = false;
            }
        }
        if (
            !historyValid ||
            (fenced
                ? !isValidResourceId(row.generationId) ||
                  !isNonNegativeSafeInteger(row.generationSeq) ||
                  (row.generationFinal !== 0 && row.generationFinal !== 1)
                : row.generationSeq !== null || row.generationFinal !== null || row.generationHistory !== null)
        ) {
            throw new ResourceValidationError(`${where}: invalid generation`);
        }
        sink.message({
            chatSeq: row.chatSeq,
            id: row.id,
            position: messageIds.size - 1,
            data,
            generationId: (row.generationId as string | null) ?? null,
            generationSeq: (row.generationSeq as number | null) ?? null,
            generationFinal: (row.generationFinal as number | null) ?? null,
            generationHistory: (row.generationHistory as string | null) ?? null,
        });
    }

    const ordered = new Set<string>();
    const orderSeqs = new Set<number>();
    for (const [row, number] of snapshotRows(
        source,
        "SELECT seq, characterId, revision, ids FROM chatOrders ORDER BY seq",
        NOT_A_RESOURCE_DATABASE,
        signal,
    )) {
        const where = `chat order row ${number}`;
        if (typeof row.characterId !== "string" || !characterIds.has(row.characterId) || ordered.has(row.characterId)) {
            throw new ResourceValidationError(`${where}: no such character or a duplicate order`);
        }
        ordered.add(row.characterId);
        if (!isPositiveSafeInteger(row.seq) || orderSeqs.has(row.seq) || !isPositiveSafeInteger(row.revision)) {
            throw new ResourceValidationError(`${where}: invalid seq or revision`);
        }
        orderSeqs.add(row.seq);
        let ids: unknown;
        try {
            ids = JSON.parse(String(row.ids));
        } catch {
            throw new ResourceValidationError(`${where}: ids is not JSON`);
        }
        const expected = chatsByCharacter.get(row.characterId) ?? new Set<string>();
        if (
            !Array.isArray(ids) ||
            ids.length !== expected.size ||
            new Set(ids).size !== ids.length ||
            !ids.every((id) => typeof id === "string" && expected.has(id))
        ) {
            throw new ResourceValidationError(`${where}: ids must list exactly the character's chats`);
        }
        sink.chatOrder({ characterId: row.characterId, revision: row.revision, ids: JSON.stringify(ids) });
    }
    for (const characterId of characterIds) {
        if (!ordered.has(characterId)) {
            throw new ResourceValidationError(`character ${characterId} has no chat order`);
        }
    }
    return chatIds;
}

/**
 * The chat half of a staged store's writer (`writeValidatedStore`): writes each checked row into the
 * staged tables. A chat keeps the source's numeric `seq`, so its messages need no mapping, with the
 * projection of its normalized metadata beside it (a snapshot's own `chatSummaries` are never read);
 * an order takes a seq of the staged table's in source order.
 */
export function createChatStagingSink(db: DatabaseSync): ChatSnapshotSink {
    const insertChat = db.prepare(
        "INSERT INTO chats (seq, characterId, id, revision, schemaVersion, meta) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const upsertSummary = db.prepare(UPSERT_CHAT_SUMMARY_SQL);
    const insertMessage = db.prepare(
        "INSERT INTO messages (chatSeq, id, position, data, generationId, generationSeq, generationFinal, " +
            "generationHistory) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertOrder = db.prepare("INSERT INTO chatOrders (characterId, revision, ids) VALUES (?, ?, ?)");
    return {
        chat(row, meta) {
            insertChat.run(row.seq, row.characterId, row.id, row.revision, row.schemaVersion, row.meta);
            upsertSummary.run(row.seq, row.revision, summaryText(meta));
        },
        message(row) {
            insertMessage.run(
                row.chatSeq,
                row.id,
                row.position,
                row.data,
                row.generationId,
                row.generationSeq,
                row.generationFinal,
                row.generationHistory,
            );
        },
        chatOrder(row) {
            insertOrder.run(row.characterId, row.revision, row.ids);
        },
    };
}

/** A staged chat's live seq while an install runs: from `copyStagedChats` until the install drops it. */
export const STAGED_CHAT_SEQS = "temp.stagedChatSeqs";

/**
 * Copies the staged chat tables into the emptied live ones inside the caller's transaction, with the
 * staged store attached as `staged` (`replaceAll`): chats by staged seq, so the live `AUTOINCREMENT`
 * gives each a fresh seq and a later delete and recreate cannot reuse an incarnation; then, through
 * `STAGED_CHAT_SEQS`, their messages, orders, and projections. With the staged writer, this is the one
 * place `chats.meta` is written past `writeChatMeta`: every row here was checked by the staging walk,
 * and nothing is parsed.
 */
export function copyStagedChats(db: DatabaseSync): void {
    db.exec(`
        INSERT INTO main.chats (characterId, id, revision, schemaVersion, meta)
            SELECT characterId, id, revision, schemaVersion, meta FROM staged.chats ORDER BY seq;
        CREATE TABLE ${STAGED_CHAT_SEQS} (stagedSeq INTEGER PRIMARY KEY, liveSeq INTEGER NOT NULL) STRICT;
        INSERT INTO ${STAGED_CHAT_SEQS} (stagedSeq, liveSeq)
            SELECT s.seq, l.seq FROM staged.chats s
                JOIN main.chats l ON l.characterId = s.characterId AND l.id = s.id;
        INSERT INTO main.messages (chatSeq, id, position, data, generationId, generationSeq, generationFinal,
                generationHistory)
            SELECT seqs.liveSeq, m.id, m.position, m.data, m.generationId, m.generationSeq, m.generationFinal,
                    m.generationHistory
                FROM staged.messages m JOIN ${STAGED_CHAT_SEQS} seqs ON seqs.stagedSeq = m.chatSeq
                ORDER BY m.chatSeq, m.position;
        INSERT INTO main.chatOrders (characterId, revision, ids)
            SELECT characterId, revision, ids FROM staged.chatOrders ORDER BY seq;
        INSERT INTO main.chatSummaries (chatSeq, revision, text)
            SELECT seqs.liveSeq, s.revision, s.text
                FROM staged.chatSummaries s JOIN ${STAGED_CHAT_SEQS} seqs ON seqs.stagedSeq = s.chatSeq;
    `);
}
