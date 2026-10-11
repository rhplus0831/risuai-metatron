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
    TranslationOutcome,
} from "../../../shared/chats.ts";
import { CHAT_META_MERGE_KEYS } from "../../../shared/chats.ts";
import type { Chat, MessageTranslation } from "../../../shared/database.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
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
 * The chat tables of the resource database (Phase 2): chat metadata (`chats`), one row per message
 * (`messages`, keyed by the chat's incarnation `seq` and `Message.chatId`, ordered by `position`), and
 * each character's chat order (`chatOrders`). The resource store owns the connection, the epoch, and
 * the transactions; this module prepares, applies, reads, and validates chat changes inside them.
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

type Generation = { id: string; seq: number; final: boolean };

type PreparedOp =
    | { op: "create"; meta: string; messages: PreparedMessage[]; index: number | null }
    | { op: "delete" }
    | { op: "replace"; meta: string; messages: PreparedMessage[] }
    | { op: "meta"; set: Record<string, unknown>; unset: string[]; merge: Record<string, Record<string, unknown>> }
    | { op: "append"; messages: PreparedMessage[]; anchor: { start: true } | { end: true } | { after: string } }
    | { op: "setMessage"; message: PreparedMessage; generation: Generation | null }
    | { op: "setText"; id: string; text: string; generation: Generation | null }
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

function prepareWholeChat(chat: unknown, chatId: string): { meta: string; messages: PreparedMessage[] } {
    if (!isPlainObject(chat)) {
        throw new ResourceValidationError("chat must be an object");
    }
    const meta = serialize(normalizeChatMeta(chat, chatId)).text;
    // The JSON copy of the messages, as `prepareMessage` checks it.
    const sent = chat.message === undefined ? undefined : serialize(chat.message).stored;
    const messages = normalizeMessageList(sent).map((message) => ({
        id: message.chatId as string,
        text: serialize(message).text,
    }));
    return { meta, messages };
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
            if (Object.keys(merge).some((key) => Object.hasOwn(set, key) || unset.includes(key))) {
                throw new ResourceValidationError("meta merges a field it also sets or unsets");
            }
            return { op: "meta", set, unset, merge: merge as Record<string, Record<string, unknown>> };
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
        return {
            characterId: entry.characterId,
            chatId: entry.chatId,
            baseRevision: entry.baseRevision as string | null,
            ops,
            needsCurrent,
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
    const characterExists = db.prepare("SELECT 1 AS found FROM resources WHERE kind = ? AND id = ?");
    const selectChat = db.prepare("SELECT seq, revision, meta FROM chats WHERE characterId = ? AND id = ?");
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
     * rewrites or removes it, or a whole-chat replace or delete of a chat holding one.
     */
    function refusedByLock(group: PreparedChatGroup, jobToken: string | undefined): boolean {
        if (!guard) {
            return false;
        }
        const foreign = (token: string | null) => token !== null && token !== jobToken;
        const targets = lockedTargets(group);
        if (targets.chat && [...guard.chatHolders(group.characterId, group.chatId)].some(foreign)) {
            return true;
        }
        return [...targets.messages].some((id) => foreign(guard.holder(group.characterId, group.chatId, id)));
    }

    function applyGroup(
        group: PreparedChatGroup,
        changedOrders: Set<string>,
        jobToken: string | undefined,
    ): { result: ChatGroupResult; applied: number } {
        const { characterId, chatId } = group;
        const conflictHere = (row: ChatRow | undefined): never => {
            throw new ChatChangeConflict({
                kind: "chat",
                characterId,
                id: chatId,
                revision: row ? tokens.token(row.seq, row.revision) : null,
            });
        };
        let row = selectChat.get(characterId, chatId) as ChatRow | undefined;
        // Before the revision checks: a refused edit of a generating message must read as
        // "retry after the job", not as a stale view to reload.
        if (refusedByLock(group, jobToken)) {
            throw new ChatChangeConflict({
                kind: "chat",
                characterId,
                id: chatId,
                revision: row ? tokens.token(row.seq, row.revision) : null,
                reason: "generating",
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
            if (!row || !base || base.seq !== row.seq || (group.needsCurrent && base.revision !== row.revision)) {
                conflictHere(row);
            }
            stale = base!.revision !== row!.revision;
        }
        /** Messages this group inserted; a new generation may begin on them without the current revision. */
        const insertedHere = new Set<string>();
        let applied = 0;
        let messageIds: string[] | undefined;
        const checkpoints: CheckpointOutcome[] = [];
        const translations: TranslationOutcome[] = [];
        let deleted = false;
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
                    applied += 1;
                    break;
                }
                case "meta": {
                    const current = JSON.parse(row!.meta) as Record<string, unknown>;
                    for (const key of op.unset) {
                        delete current[key];
                    }
                    Object.assign(current, op.set);
                    for (const [key, entries] of Object.entries(op.merge)) {
                        // Onto the entries as stored now: another writer's entries stay.
                        const stored = current[key];
                        const map: Record<string, unknown> = Object.create(null);
                        if (stored && typeof stored === "object" && !Array.isArray(stored)) {
                            for (const id of Object.keys(stored)) {
                                map[id] = (stored as Record<string, unknown>)[id];
                            }
                        }
                        for (const id of Object.keys(entries)) {
                            map[id] = entries[id];
                        }
                        current[key] = { ...map };
                    }
                    const meta = serialize(normalizeChatMeta(current, chatId)).text;
                    setChatMeta.run(meta, CHAT_SCHEMA_VERSION, chatSeq);
                    row = { ...row!, meta };
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
                        fresh.forEach((message) => insertedHere.add(message.id));
                        insertAt(chatSeq, after, fresh);
                        applied += 1;
                    }
                    break;
                }
                case "setMessage":
                case "setText": {
                    const id = op.op === "setMessage" ? op.message.id : op.id;
                    const existing = selectMessage.get(chatSeq, id) as MessageRow | undefined;
                    if (!existing) {
                        conflictHere(row);
                    }
                    if (op.generation) {
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
                    } else {
                        const message = JSON.parse(existing!.data) as Record<string, unknown>;
                        message.data = op.text;
                        text = serialize(message).text;
                    }
                    setMessageData.run(text, chatSeq, id);
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
                        conflictHere(row);
                    }
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
                    applied += 1;
                    break;
                }
            }
        }
        let revision: string | null = null;
        if (!deleted && row) {
            const next = nextRevision(row.revision, applied);
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
        return { result, applied };
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

        /** The chat's revision token, or null when it does not exist (its messages are not read). */
        chatRevision(characterId: string, id: string): string | null {
            const row = selectChat.get(characterId, id) as ChatRow | undefined;
            return row ? tokens.token(row.seq, row.revision) : null;
        },

        /** A chat's summary (its listed fields; its messages are not read), or null when it does not exist. */
        readChatSummary(characterId: string, id: string): ChatSummary | null {
            const row = selectChat.get(characterId, id) as ChatRow | undefined;
            return row ? chatSummary(characterId, { ...row, id }) : null;
        },

        /**
         * Deletes a character's chats, their messages, and its order (inside the character's delete).
         * Returns the ids of the chats it deleted and whether an order existed.
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
         * back when there is one), the results, and the applied count.
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
            const changedOrders = new Set<string>();
            let applied = 0;
            for (const [index, group] of groups.entries()) {
                applyingOp = -1;
                try {
                    const outcome = applyGroup(group, changedOrders, jobToken);
                    results.push(outcome.result);
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
            return { conflicts, results, orders: orderResults, applied };
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

        /** Clears the chat tables and inserts validated snapshot rows (inside `replaceAll`'s transaction). */
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
        },
    };
}

export type ChatTables = ReturnType<typeof createChatTables>;

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
