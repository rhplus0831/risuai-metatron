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
import type { Chat, MessageTranslation } from "../../../shared/database.ts";
import {
    type ChangeSet,
    type ChatDeltaBody,
    type ChatMetaFields,
    type ChatPatchBody,
    MAX_FEED_PATCH_BYTES,
    RESOURCE_KIND,
} from "../../../shared/resources.ts";
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
 * applies, reads, and validates chat changes inside them.
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
 * Each chat's structured memory (`memoryStore.ts`): a table each for pages, events, threads, and writer
 * runs, one row per record with the whole record as stored JSON in `data`, and `memory_state`, the one
 * revision over all of them, which a chat has no row in until its first memory write. `seq` is storage
 * order, not message order. `data` is the last column, so a table-of-contents read stops before it.
 * Keyed by the chat's incarnation (`chats.seq`): deleting the chat drops its rows by cascade, and the
 * prefix of `UNIQUE (chatSeq, id)` keeps that cascade from scanning a table. Created when missing; not
 * part of the required snapshot layout (`CHAT_TABLE_COLUMNS`), so a snapshot from before them restores
 * with none, but a snapshot with any of them has them all checked and restored (`walkMemorySnapshot`).
 */
export const MEMORY_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS memory_state (
        chatSeq INTEGER PRIMARY KEY REFERENCES chats (seq) ON DELETE CASCADE,
        revision INTEGER NOT NULL
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
 * What `openChatSchema` adds to `CHAT_TABLES_SQL`, each created when missing, and a staged store's
 * writer too, so a staged file has the live schema.
 */
export const CHAT_OPEN_SCHEMA_SQL = `${CHAT_GROUP_TABLE_SQL}${CHAT_SUMMARY_TABLE_SQL}${MEMORY_TABLES_SQL}${MESSAGE_ROLE_INDEX_SQL}`;

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
    | { op: "remove"; ids: string[] }
    | { op: "begin"; id: string; generationId: string }
    | { op: "setTranslation"; id: string; translation: MessageTranslation | null };

type PreparedMessage = { id: string; text: string };

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
 * What a group's feed entry carries beside its ref (`ChangeSet["chats"]`): its by-id change, as a
 * `patch` or a `delta`, and its summary knowledge. Feed-only: never in the HTTP results.
 */
export type ChatFeedPayloads = Pick<ChangeSet["chats"][number], "patch" | "delta" | "summary" | "summaryBase">;

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

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Normalizes the JSON copy of a message (what is stored), not the input: an in-process `toJSON` cannot change it after the check. */
function prepareMessage(input: unknown): PreparedMessage {
    const message = normalizeMessage(serialize(input).stored);
    return { id: message.chatId as string, text: serialize(message).text };
}

function prepareWholeChat(
    chat: unknown,
    chatId: string,
): { meta: string; summary: string; messages: PreparedMessage[]; renamed: boolean } {
    if (!isPlainObject(chat)) {
        throw new ResourceValidationError("chat must be an object");
    }
    const { text: meta, stored } = serialize(normalizeChatMeta(chat, chatId));
    const summary = summaryText(stored as Record<string, unknown>);
    // Keep whole-array JSON semantics, but measure depth per message as `prepareMessage` does.
    const sent = chat.message === undefined ? undefined : serialize(chat.message, { arrayElementDepth: true }).stored;
    const messages = normalizeMessageList(sent).map((message) => ({
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
                set,
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
            return { op: "remove", ids: prepareIdList(raw.ids, "remove.ids") };
        case "begin":
            if (!isValidResourceId(raw.id) || !isValidResourceId(raw.generationId)) {
                throw new ResourceValidationError("begin must be { id, generationId }");
            }
            return { op: "begin", id: raw.id, generationId: raw.generationId };
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
            case "remove":
                op.ids.forEach((id) => messages.add(id));
                break;
        }
    }
    return { chat, messages };
}

/**
 * The chat schema past the tables `initialize` creates, in its own transaction, before any statement
 * of `createChatTables` is prepared: creates `chatGroups`, `chatSummaries`, the memory tables, and the
 * `messages_role` index when missing (on a fresh and an existing file alike; building the index parses
 * every message row once) and rebuilds the stored projections. Every chat's when the `meta` table's
 * `summaryProjectionVersion` is missing or differs from `SUMMARY_PROJECTION_VERSION`, otherwise only
 * the chats with no row or a row at another revision, so an open with nothing to create or rebuild
 * writes nothing. The seqs come first and each chat's metadata is read alone, so a store with a large
 * chat never holds them all. The only pass that parses metadata for summaries at open; its rows are
 * derived data, not store writes. A metadata value that cannot be projected throws, naming the chat,
 * with the transaction left for the caller to roll back.
 */
export function openChatSchema(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE");
    db.exec(CHAT_OPEN_SCHEMA_SQL);
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

/**
 * Prepares the chat statements and returns the methods over them. The tables must exist:
 * `openChatSchema` and `createCheckpointTables` (`chatRestoreFloors`) run first.
 */
export function createChatTables(db: DatabaseSync, tokens: TokenFunctions, guard?: MessageGuard) {
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
    const selectLastMessage = db.prepare("SELECT data FROM messages WHERE chatSeq = ? ORDER BY position DESC LIMIT 1");
    // Keyed by the chat incarnation. `undefined` is cached too (empty or undated last message).
    const lastMessageTimes = new Map<number, number | undefined>();
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
    const countMessages = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chatSeq = ?");
    const countUserTurns = db.prepare(COUNT_USER_TURNS_SQL);
    const selectPatchMessages = db.prepare(
        "SELECT m.id, m.data, (SELECT p.id FROM messages p WHERE p.chatSeq = m.chatSeq AND p.position < m.position " +
            "ORDER BY p.position DESC LIMIT 1) AS after FROM messages m " +
            "WHERE m.chatSeq = ? AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.position",
    );
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
        "SELECT seq, octet_length(meta) AS bytes FROM chats WHERE characterId = ? AND id = ?",
    );
    const sumMessageBytes = db.prepare(
        "SELECT COALESCE(SUM(octet_length(data)), 0) AS bytes FROM messages WHERE chatSeq = ?",
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

    /** A chat's summary: its stored projection and the memoized time of its last message by position. */
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
     * by position. Lazy: nothing is read before the first row is asked for, and a caller that stops
     * early ends the read.
     */
    function* touchedRows(chatSeq: number, touched: ReadonlySet<string>): Generator<ChatWriteChange["rows"][number]> {
        for (const stored of selectPatchMessages.iterate(chatSeq, JSON.stringify([...touched]))) {
            yield stored as ChatWriteChange["rows"][number];
        }
    }

    /**
     * The feed's by-id change of a group from its stored parts: a `patch` with the metadata whole
     * (`{baseRevision,count,meta?,removed?,messages?}`, in that key order) when its JSON fits
     * `MAX_FEED_PATCH_BYTES`, else a `delta` with the metadata by field (`metaFields` in place of
     * `meta`) when that fits, else neither. One pass, measured part by part on the stored strings:
     * the whole metadata first, then the removals, then the rows. At the first byte over, a group
     * that changed the metadata takes its field form (`meta.fields`, which parses both stored
     * metadata values: an over-cap metadata is parsed, a cost the whole form alone never had) and goes
     * on from there with the rows already read and the same row iterator; any other group, or one
     * whose field form does not fit either, gives up there. `rows` is iterated only once the metadata
     * and removals fit, and only while a form still fits; no row is parsed until all of it fits.
     */
    function chatFeedChange(
        baseRevision: string,
        count: number,
        meta: { stored: string; fields: () => ChatMetaFields | null } | undefined,
        removed: ReadonlySet<string>,
        rows: Iterable<{ after: string | null; data: string }> | null,
    ): Pick<ChatFeedPayloads, "patch" | "delta"> {
        const head = Buffer.byteLength(JSON.stringify({ baseRevision, count }));
        let metaBytes = meta === undefined ? 0 : Buffer.byteLength(meta.stored) + ',"meta":'.length;
        // Undefined while the metadata goes whole; null: by field, unchanged as JSON values.
        let fields: ChatMetaFields | null | undefined;
        let rest = 0;
        /** Whether the body fits, taking the field form at the first byte over when there is one. */
        const fits = (): boolean => {
            if (head + metaBytes + rest <= MAX_FEED_PATCH_BYTES) {
                return true;
            }
            if (meta === undefined || fields !== undefined) {
                return false;
            }
            fields = meta.fields();
            metaBytes = fields === null ? 0 : Buffer.byteLength(JSON.stringify(fields)) + ',"metaFields":'.length;
            return head + metaBytes + rest <= MAX_FEED_PATCH_BYTES;
        };
        if (!fits()) {
            return {};
        }
        if (removed.size > 0) {
            rest += ',"removed":[]'.length;
            let index = 0;
            for (const id of removed) {
                rest += Buffer.byteLength(JSON.stringify(id)) + (index > 0 ? 1 : 0);
                if (!fits()) {
                    return {};
                }
                index += 1;
            }
        }
        const kept: { after: string | null; data: string }[] = [];
        if (rows) {
            rest += ',"messages":[]'.length;
            for (const row of rows) {
                rest +=
                    Buffer.byteLength(JSON.stringify(row.after)) +
                    Buffer.byteLength(row.data) +
                    '{"after":,"message":}'.length +
                    (kept.length > 0 ? 1 : 0);
                // The row counts in either form: kept before the check, so the field form goes on with it.
                kept.push(row);
                if (!fits()) {
                    return {};
                }
            }
        }
        const body: ChatPatchBody & ChatDeltaBody = { baseRevision, count };
        if (meta !== undefined && fields === undefined) {
            body.meta = JSON.parse(meta.stored) as Record<string, unknown>;
        } else if (fields) {
            body.metaFields = fields;
        }
        if (removed.size > 0) {
            body.removed = [...removed];
        }
        if (rows) {
            body.messages = kept.map(({ after, data }) => ({ after, message: JSON.parse(data) }));
        }
        return fields === undefined ? { patch: body } : { delta: body };
    }

    /**
     * A by-id group's change as stored now (`ChatWriteChange`), uncapped: one count and one read of
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
        const { count } = countMessages.get(row.seq) as { count: number };
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
        if (result.targets) {
            remembered.targets = result.targets;
        }
        // New to this incarnation: a remembered id was answered before anything applied.
        insertGroup.run(chatSeq, groupId, revision, JSON.stringify(remembered));
        trimGroups.run(chatSeq, chatSeq, MAX_CHAT_GROUP_IDS);
    }

    function applyGroup(
        group: PreparedChatGroup,
        changedOrders: Set<string>,
        jobToken: string | undefined,
        changes: boolean,
    ): {
        result: ChatGroupResult;
        applied: number;
        feed?: ChatFeedPayloads;
        change?: ChatWriteChange;
        invalidated?: true;
        duplicate?: true;
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
        /** Messages this group inserted; a new generation may begin on them without the current revision. */
        const insertedHere = new Set<string>();
        // The actual stored base, which can be newer than a stale group's requested base.
        const patchBase =
            row && group.ops.every((op) => op.op !== "create" && op.op !== "replace" && op.op !== "delete")
                ? tokens.token(row.seq, row.revision)
                : null;
        // The stored metadata before the group, for the field form of its change (by-id groups).
        const metaBefore = patchBase ? row!.meta : undefined;
        /** The projection right before the group's first `meta` op (by-id groups). */
        let summaryBefore: string | undefined;
        /** The projection the group's last `meta` op wrote. */
        let summaryAfter: string | undefined;
        /** Taken right before the group's first op that can change its messages, even when absent. */
        let timeBefore: { time: number | undefined } | undefined;
        const touched = new Set<string>();
        const removedIds = new Set<string>();
        let reappended = false;
        let metaChanged = false;
        let applied = 0;
        let messageIds: string[] | undefined;
        let messageIdsRenamed = false;
        const checkpoints: CheckpointOutcome[] = [];
        const translations: TranslationOutcome[] = [];
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
                    insertAt(seq, -1, op.messages);
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
                    deleteChat.run(chatSeq);
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
                    writeChatMeta({ kind: "update", seq: chatSeq, revision: row!.revision, meta: op.meta }, op.summary);
                    deleteMessages.run(chatSeq);
                    insertAt(chatSeq, -1, op.messages);
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
                    row = { ...row!, meta: op.meta };
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
                    for (const key of op.unset) {
                        delete current[key];
                    }
                    Object.assign(current, op.set);
                    for (const key of new Set([...Object.keys(op.mergeUnset), ...Object.keys(op.merge)])) {
                        // Onto the entries as stored now: another writer's entries stay.
                        const stored = current[key];
                        const isMap = isPlainObject(stored);
                        const entries = Object.hasOwn(op.merge, key) ? op.merge[key] : undefined;
                        if (!isMap && !entries) {
                            // Removals alone from a field that is not a map: nothing to remove.
                            continue;
                        }
                        const map: Record<string, unknown> = Object.create(null);
                        if (isMap) {
                            for (const id of Object.keys(stored)) {
                                map[id] = stored[id];
                            }
                        }
                        for (const id of Object.hasOwn(op.mergeUnset, key) ? op.mergeUnset[key] : []) {
                            delete map[id];
                        }
                        for (const id of Object.keys(entries ?? {})) {
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
                            fresh.push(message);
                        } else if (existing.data !== message.text) {
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
                    targets.push("applied");
                    if (op.op !== "patchMessage" && op.generation) {
                        const outcome = admitGeneration(chatSeq, id, existing!, op.generation);
                        checkpoints.push(outcome);
                        if (outcome !== "applied") {
                            break;
                        }
                    } else {
                        closeFence(chatSeq, id, existing!);
                    }
                    let text: string;
                    if (op.op === "setMessage") {
                        // The whole row, also on a stale revision: fields the sender has not seen are
                        // replaced (`patchMessage` changes only the fields it names).
                        // A stored translation is the `setTranslation` op's: the sent message's own (an
                        // older copy, or none) never replaces or removes it.
                        const stored = JSON.parse(existing!.data) as Record<string, unknown>;
                        const message = JSON.parse(op.message.text) as Record<string, unknown>;
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
                        for (const key of op.unset) {
                            delete message[key];
                        }
                        for (const key of Object.keys(op.set)) {
                            message[key] = op.set[key];
                        }
                        text = serialize(normalizeMessage(message)).text;
                    } else {
                        const message = JSON.parse(existing!.data) as Record<string, unknown>;
                        message.data = op.text;
                        text = serialize(message).text;
                    }
                    setMessageData.run(text, chatSeq, id);
                    if (text !== existing!.data) {
                        touched.add(id);
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
                        if (deleteMessage.run(chatSeq, id).changes > 0) {
                            removedIds.add(id);
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
                case "setTranslation": {
                    // Not a text write: the generation fence is left as it is.
                    const existing = selectMessage.get(chatSeq, op.id) as MessageRow | undefined;
                    if (!existing) {
                        targets.push("missing");
                        translations.push("ignored");
                        break;
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
                        touched.size > 0 ? change.rows : null,
                    );
                } else {
                    // Without a change to build, the rows are read only while a form of the feed's change still fits.
                    const { count } = countMessages.get(row!.seq) as { count: number };
                    feed = chatFeedChange(
                        patchBase,
                        count,
                        meta,
                        removedIds,
                        touched.size > 0 ? touchedRows(row!.seq, touched) : null,
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
        return { result, applied, change, feed, ...(invalidated ? { invalidated } : {}) };
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

        /** The chat's revision token, or null when it does not exist (no metadata or messages read). */
        chatRevision(characterId: string, id: string): string | null {
            const row = selectChatRevision.get(characterId, id) as Pick<ChatRow, "seq" | "revision"> | undefined;
            return row ? tokens.token(row.seq, row.revision) : null;
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
         * payloads (`feed`, by result), and the chats a `delete` or `replace` applied to
         * (`invalidated`, once each, in group order). With `changes`, also each group's own change
         * (`changes`, aligned with the results; undefined for a group without one).
         */
        apply(
            groups: readonly PreparedChatGroup[],
            orders: readonly PreparedChatOrder[],
            orderBases: ReadonlyMap<string, { seq: number; revision: number } | null>,
            priorConflicts: boolean,
            jobToken?: string,
            changes = false,
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
            let applied = 0;
            for (const [index, group] of groups.entries()) {
                applyingOp = -1;
                try {
                    const outcome = applyGroup(group, changedOrders, jobToken, changes);
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
                list.push(JSON.parse(row.data));
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
                JSON.parse(entry.data),
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
                    JSON.parse(entry.data),
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

        /** Drops the last-message memo: an install's commit gave every chat a new seq. */
        forgetLastMessageTimes() {
            lastMessageTimes.clear();
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
