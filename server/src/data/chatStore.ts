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
import { type ChatPatchBody, MAX_FEED_PATCH_BYTES, RESOURCE_KIND } from "../../../shared/resources.ts";
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
import { isValidResourceId, nextRevision, ResourceValidationError, serialize } from "./resourceStore.ts";

/**
 * The chat tables of the resource database: chat metadata (`chats`), one row per message (`messages`,
 * keyed by the chat's incarnation `seq` and `Message.chatId`, ordered by `position`), and each
 * character's chat order (`chatOrders`). The resource store owns the connection, the epoch, and the
 * transactions; this module prepares, applies, reads, and validates chat changes inside them.
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
    | { op: "create"; meta: string; messages: PreparedMessage[]; renamed: boolean; index: number | null }
    | { op: "delete" }
    | { op: "replace"; meta: string; messages: PreparedMessage[]; renamed: boolean }
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
): { meta: string; messages: PreparedMessage[]; renamed: boolean } {
    if (!isPlainObject(chat)) {
        throw new ResourceValidationError("chat must be an object");
    }
    const meta = serialize(normalizeChatMeta(chat, chatId)).text;
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
    return { meta, messages, renamed };
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

export function createChatTables(db: DatabaseSync, tokens: TokenFunctions, guard?: MessageGuard) {
    db.exec(CHAT_GROUP_TABLE_SQL);
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
    const deleteChat = db.prepare("DELETE FROM chats WHERE seq = ?");
    const deleteCharacterChats = db.prepare("DELETE FROM chats WHERE characterId = ?");
    const selectMessage = db.prepare(
        "SELECT position, data, generationId, generationSeq, generationFinal, generationHistory FROM messages " +
            "WHERE chatSeq = ? AND id = ?",
    );
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
    const selectAllMessages = db.prepare("SELECT chatSeq, data FROM messages ORDER BY chatSeq, position");
    const selectChatMessages = db.prepare("SELECT data FROM messages WHERE chatSeq = ? ORDER BY position");
    const countMessages = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chatSeq = ?");
    const selectPatchMessages = db.prepare(
        "SELECT m.data, (SELECT p.id FROM messages p WHERE p.chatSeq = m.chatSeq AND p.position < m.position " +
            "ORDER BY p.position DESC LIMIT 1) AS after FROM messages m " +
            "WHERE m.chatSeq = ? AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.position",
    );
    const selectCharacterChats = db.prepare(
        "SELECT seq, id, revision, meta FROM chats WHERE characterId = ? ORDER BY seq",
    );
    const selectAllOrders = db.prepare("SELECT seq, characterId, revision, ids FROM chatOrders ORDER BY seq");
    const selectChatRevisions = db.prepare("SELECT seq, characterId, id, revision FROM chats ORDER BY seq");
    const selectOrderRevisions = db.prepare("SELECT seq, characterId, revision FROM chatOrders ORDER BY seq");
    const insertRestoredChat = db.prepare(
        "INSERT INTO chats (characterId, id, revision, schemaVersion, meta) VALUES (?, ?, ?, ?, ?)",
    );
    const insertRestoredMessage = db.prepare(
        "INSERT INTO messages (chatSeq, id, position, data, generationId, generationSeq, generationFinal, " +
            "generationHistory) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertRestoredOrder = db.prepare("INSERT INTO chatOrders (characterId, revision, ids) VALUES (?, ?, ?)");
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

    function chatRecord(
        characterId: string,
        row: { seq: number; id: string; revision: number; meta: string },
        messages: unknown[],
    ): ChatRecord {
        const data = JSON.parse(row.meta) as Chat;
        data.message = messages as Chat["message"];
        return { characterId, id: row.id, revision: tokens.token(row.seq, row.revision), data };
    }

    /** A chat's summary from its row: the listed fields picked from its metadata (no message rows read). */
    function chatSummary(characterId: string, row: { seq: number; id: string; revision: number; meta: string }) {
        const meta = JSON.parse(row.meta) as Record<string, unknown>;
        const summary: ChatSummary = {
            characterId,
            id: row.id,
            revision: tokens.token(row.seq, row.revision),
            name: typeof meta.name === "string" ? meta.name : "",
            fmIndex: typeof meta.fmIndex === "number" ? meta.fmIndex : -1,
        };
        if (typeof meta.folderId === "string") {
            summary.folderId = meta.folderId;
        }
        if (typeof meta.bindedPersona === "string") {
            summary.bindedPersona = meta.bindedPersona;
        }
        if (typeof meta.promptPresetId === "string") {
            summary.promptPresetId = meta.promptPresetId;
        }
        if (typeof meta.modelPresetId === "string") {
            summary.modelPresetId = meta.modelPresetId;
        }
        if (typeof meta.bindingReview === "boolean") {
            summary.bindingReview = meta.bindingReview;
        }
        if (meta.pinned === true) {
            summary.pinned = true;
        }
        // The translation settings: a new chat inherits them.
        Object.assign(summary, chatTranslationSummary(meta));
        return summary;
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

    /** Reads only touched rows and their final anchors, stopping once the feed's byte cap is exceeded. */
    function chatFeedPatch(
        row: ChatRow,
        baseRevision: string,
        touched: ReadonlySet<string>,
        removed: ReadonlySet<string>,
        metaChanged: boolean,
    ): ChatPatchBody | undefined {
        const { count } = countMessages.get(row.seq) as { count: number };
        const patch: ChatPatchBody = { baseRevision, count };
        let bytes = Buffer.byteLength(JSON.stringify(patch));
        if (metaChanged) {
            bytes += Buffer.byteLength(row.meta) + ',"meta":'.length;
            if (bytes > MAX_FEED_PATCH_BYTES) {
                return undefined;
            }
            patch.meta = JSON.parse(row.meta) as Record<string, unknown>;
        }
        if (removed.size > 0) {
            const ids: string[] = [];
            patch.removed = ids;
            bytes += ',"removed":[]'.length;
            for (const id of removed) {
                bytes += Buffer.byteLength(JSON.stringify(id)) + (ids.length > 0 ? 1 : 0);
                if (bytes > MAX_FEED_PATCH_BYTES) {
                    return undefined;
                }
                ids.push(id);
            }
        }
        if (touched.size > 0) {
            const messages: { after: string | null; message: unknown }[] = [];
            patch.messages = messages;
            bytes += ',"messages":[]'.length;
            for (const stored of selectPatchMessages.iterate(row.seq, JSON.stringify([...touched]))) {
                const { after, data } = stored as { after: string | null; data: string };
                bytes +=
                    Buffer.byteLength(JSON.stringify(after)) +
                    Buffer.byteLength(data) +
                    '{"after":,"message":}'.length +
                    (messages.length > 0 ? 1 : 0);
                if (bytes > MAX_FEED_PATCH_BYTES) {
                    return undefined;
                }
                messages.push({ after, message: JSON.parse(data) });
            }
        }
        return patch;
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
    ): { result: ChatGroupResult; applied: number; patch?: ChatPatchBody; invalidated?: true; duplicate?: true } {
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
            switch (op.op) {
                case "create": {
                    const created = insertChat.run(characterId, chatId, CHAT_SCHEMA_VERSION, op.meta);
                    const seq = Number(created.lastInsertRowid);
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
                    setChatMeta.run(op.meta, CHAT_SCHEMA_VERSION, chatSeq);
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
                    const meta = serialize(normalizeChatMeta(current, chatId)).text;
                    setChatMeta.run(meta, CHAT_SCHEMA_VERSION, chatSeq);
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
        const patch =
            patchBase && applied > 0 && !reappended
                ? chatFeedPatch(row!, patchBase, touched, removedIds, metaChanged)
                : undefined;
        return { result, applied, patch, ...(invalidated ? { invalidated } : {}) };
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

        /** The chat's revision token, or null when it does not exist (no metadata or messages read). */
        chatRevision(characterId: string, id: string): string | null {
            const row = selectChatRevision.get(characterId, id) as Pick<ChatRow, "seq" | "revision"> | undefined;
            return row ? tokens.token(row.seq, row.revision) : null;
        },

        /** A chat's summary (its listed fields; its messages are not read), or null when it does not exist. */
        readChatSummary(characterId: string, id: string): ChatSummary | null {
            const row = selectChat.get(characterId, id) as ChatRow | undefined;
            return row ? chatSummary(characterId, { ...row, id }) : null;
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
            const chatIds = (selectCharacterChats.all(characterId) as { id: string }[]).map((row) => row.id);
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
         * back when there is one), the results, the applied count, and the chats a `delete` or
         * `replace` applied to (`invalidated`, once each, in group order).
         */
        apply(
            groups: readonly PreparedChatGroup[],
            orders: readonly PreparedChatOrder[],
            orderBases: ReadonlyMap<string, { seq: number; revision: number } | null>,
            priorConflicts: boolean,
            jobToken?: string,
        ) {
            const conflicts: (ChatConflict | ChatOrderConflict)[] = [];
            const results: ChatGroupResult[] = [];
            // Feed-only data: kept outside the HTTP batch's ChatGroupResult entries.
            const patches = new Map<ChatGroupResult, ChatPatchBody>();
            const duplicates = new Set<ChatGroupResult>();
            const changedOrders = new Set<string>();
            const invalidated: { characterId: string; id: string }[] = [];
            let applied = 0;
            for (const [index, group] of groups.entries()) {
                applyingOp = -1;
                try {
                    const outcome = applyGroup(group, changedOrders, jobToken);
                    results.push(outcome.result);
                    if (outcome.duplicate) {
                        duplicates.add(outcome.result);
                    }
                    if (outcome.patch) {
                        patches.set(outcome.result, outcome.patch);
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
            return { conflicts, results, orders: orderResults, applied, patches, duplicates, invalidated };
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

        /** Every chat's summary (no message rows read) and every chat order, in one read. */
        readSummaries(): { chatSummaries: ChatSummary[]; chatOrders: ChatOrderRecord[] } {
            const chatSummaries = (
                selectAllChats.all() as {
                    seq: number;
                    characterId: string;
                    id: string;
                    revision: number;
                    meta: string;
                }[]
            ).map((row) => chatSummary(row.characterId, row));
            const chatOrders = (
                selectAllOrders.all() as { seq: number; characterId: string; revision: number; ids: string }[]
            ).map((row) => ({
                characterId: row.characterId,
                revision: tokens.token(row.seq, row.revision),
                ids: JSON.parse(row.ids) as string[],
            }));
            return { chatSummaries, chatOrders };
        },

        /** A character's order and its chats' summaries (no message rows read), or null when it has no order. */
        readCollectionSummaries(characterId: string): { order: ChatOrderRecord; chats: ChatSummary[] } | null {
            const order = readOrder(characterId);
            if (!order) {
                return null;
            }
            const chats = (
                selectCharacterChats.all(characterId) as { seq: number; id: string; revision: number; meta: string }[]
            ).map((row) => chatSummary(characterId, row));
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

        /** Restores validated chat rows in the caller's transaction and returns the old-to-new chat seq map. */
        replaceAll(rows: ChatSnapshotRows) {
            db.exec("DELETE FROM messages; DELETE FROM chats; DELETE FROM chatOrders;");
            for (const order of rows.chatOrders) {
                insertRestoredOrder.run(order.characterId, order.revision, order.ids);
            }
            const seqs = new Map<number, number>();
            for (const chat of rows.chats) {
                const result = insertRestoredChat.run(
                    chat.characterId,
                    chat.id,
                    chat.revision,
                    chat.schemaVersion,
                    chat.meta,
                );
                seqs.set(chat.seq, Number(result.lastInsertRowid));
            }
            for (const message of rows.messages) {
                insertRestoredMessage.run(
                    seqs.get(message.chatSeq)!,
                    message.id,
                    message.position,
                    message.data,
                    message.generationId,
                    message.generationSeq,
                    message.generationFinal,
                    message.generationHistory,
                );
            }
            return seqs;
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
 * Reads and checks the chat tables of a snapshot file for `readSnapshot`: every chat belongs to a
 * character of the snapshot, is unique, and has metadata the normalizer accepts; every message
 * belongs to a chat, has a unique id equal to its JSON `chatId`, a distinct integer position, a
 * valid message, and a well-formed fence; every character has exactly one order with a positive
 * unique `seq`, and each order is a duplicate-free permutation of that character's chats. Throws
 * `ResourceValidationError`.
 *
 * Message positions are returned compacted to `0..n-1` in stored order: positions are internal, and
 * the insertion arithmetic assumes they start at or above 0 and leave room to grow (a crafted
 * snapshot could otherwise place one below the `start` anchor or at the safe-integer limit).
 */
export function readChatSnapshotRows(source: DatabaseSync, characterIds: ReadonlySet<string>): ChatSnapshotRows {
    let rawChats: Record<string, unknown>[];
    let rawMessages: Record<string, unknown>[];
    let rawOrders: Record<string, unknown>[];
    try {
        rawChats = source
            .prepare("SELECT seq, characterId, id, revision, schemaVersion, meta FROM chats ORDER BY seq")
            .all() as Record<string, unknown>[];
        rawMessages = source
            .prepare(
                "SELECT chatSeq, id, position, data, generationId, generationSeq, generationFinal, generationHistory " +
                    "FROM messages ORDER BY chatSeq, position",
            )
            .all() as Record<string, unknown>[];
        rawOrders = source
            .prepare("SELECT seq, characterId, revision, ids FROM chatOrders ORDER BY seq")
            .all() as Record<string, unknown>[];
    } catch {
        throw new ResourceValidationError("Not a resource database");
    }

    const chatKeys = new Set<string>();
    const chatSeqs = new Map<number, { characterId: string; id: string }>();
    const chatsByCharacter = new Map<string, Set<string>>();
    const chats = rawChats.map((row, index) => {
        const where = `chat row ${index + 1}`;
        if (!isPositiveSafeInteger(row.seq) || !isPositiveSafeInteger(row.revision) || chatSeqs.has(row.seq)) {
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
        let meta: string;
        try {
            meta = serialize(normalizeChatMeta(JSON.parse(String(row.meta)), row.id)).text;
        } catch (error) {
            throw new ResourceValidationError(
                `${where}: ${error instanceof ResourceValidationError ? error.message : "meta is not JSON"}`,
            );
        }
        chatSeqs.set(row.seq, { characterId: row.characterId, id: row.id });
        let list = chatsByCharacter.get(row.characterId);
        if (!list) {
            list = new Set();
            chatsByCharacter.set(row.characterId, list);
        }
        list.add(row.id);
        return {
            seq: row.seq,
            characterId: row.characterId,
            id: row.id,
            revision: row.revision,
            schemaVersion: CHAT_SCHEMA_VERSION,
            meta,
        };
    });

    const messageKeys = new Set<string>();
    const positionKeys = new Set<string>();
    /** Next compacted position per chat (rows arrive ordered by chat and stored position). */
    const nextPosition = new Map<number, number>();
    const messages = rawMessages.map((row, index) => {
        const where = `message row ${index + 1}`;
        if (typeof row.chatSeq !== "number" || !chatSeqs.has(row.chatSeq)) {
            throw new ResourceValidationError(`${where}: no such chat`);
        }
        if (!isValidResourceId(row.id)) {
            throw new ResourceValidationError(`${where}: invalid id`);
        }
        const key = `${row.chatSeq}\u0000${row.id}`;
        const positionKey = `${row.chatSeq}\u0000${String(row.position)}`;
        if (messageKeys.has(key)) {
            throw new ResourceValidationError(`${where}: duplicate message id`);
        }
        if (!Number.isSafeInteger(row.position) || positionKeys.has(positionKey)) {
            throw new ResourceValidationError(`${where}: invalid or duplicate position`);
        }
        messageKeys.add(key);
        positionKeys.add(positionKey);
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
        const position = nextPosition.get(row.chatSeq) ?? 0;
        nextPosition.set(row.chatSeq, position + 1);
        return {
            chatSeq: row.chatSeq,
            id: row.id,
            position,
            data,
            generationId: (row.generationId as string | null) ?? null,
            generationSeq: (row.generationSeq as number | null) ?? null,
            generationFinal: (row.generationFinal as number | null) ?? null,
            generationHistory: (row.generationHistory as string | null) ?? null,
        };
    });

    const ordered = new Set<string>();
    const orderSeqs = new Set<number>();
    const chatOrders = rawOrders.map((row, index) => {
        const where = `chat order row ${index + 1}`;
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
        return { characterId: row.characterId, revision: row.revision, ids: JSON.stringify(ids) };
    });
    for (const characterId of characterIds) {
        if (!ordered.has(characterId)) {
            throw new ResourceValidationError(`character ${characterId} has no chat order`);
        }
    }
    return { chats, messages, chatOrders };
}
