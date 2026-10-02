import type { Chat, Message } from "./database.ts";

/**
 * The chat wire contract (Phase 2 of `docs/plan/PLAN.md`). A chat is stored as its metadata plus
 * one row per message, addressed by `Message.chatId`; each character's chat order is a record of its
 * own. Chat changes travel in the resource batch (`POST /api/resources/batch`) beside resource ops.
 */

/** Chat fields a `meta` op may not set or unset: identity, the messages, and client-only state. */
export const CHAT_META_FORBIDDEN_KEYS = ["id", "message", "isStreaming", "activeStreamingDisplayOptimizationMode"];

/** The chat fields a `meta` op may `merge` entries into. */
export const CHAT_META_MERGE_KEYS = ["toolCalls"];

/** The largest remembered tool call (`toolCalls[id]`), as serialized JSON, in UTF-8 bytes. */
export const MAX_TOOL_CALL_RECORD_BYTES = 1024 * 1024;

/** A chat as stored, without its messages and the client-only streaming flags. */
export type ChatMeta = Omit<Chat, "message" | "isStreaming" | "activeStreamingDisplayOptimizationMode">;

/** Where `append` inserts: before the first message, after the last, or after a message id. */
export type MessageAnchor = { start: true } | { end: true } | { after: string };

/**
 * A write made by a running generation. `seq` increases with every checkpoint of that generation;
 * `final` closes it, after which no write of that generation applies.
 */
export type MessageGeneration = { id: string; seq: number; final?: boolean };

/**
 * One chat operation. `create`, `delete`, `replace`, and a `remove` of several ids need the chat's
 * current revision; the others apply on a stale revision as long as their target exists (Decision 4),
 * except a `begin` that starts a generation the message does not know yet: it needs the current
 * revision unless the message was inserted by the same group. A `begin` of the message's current or
 * an earlier generation is a replay and changes nothing.
 */
export type ChatOp =
    | { op: "create"; chat: Chat; index?: number }
    | { op: "delete" }
    | { op: "replace"; chat: Chat }
    /**
     * `merge` adds entries to a field that is a map (`toolCalls`): each named field keeps its other
     * entries as stored, so two writers adding different entries do not replace each other's.
     */
    | {
          op: "meta";
          set?: Record<string, unknown>;
          unset?: string[];
          merge?: Record<string, Record<string, unknown>>;
      }
    | { op: "append"; messages: Message[]; anchor: MessageAnchor }
    | { op: "setMessage"; message: Message; generation?: MessageGeneration }
    | { op: "setText"; id: string; text: string; generation?: MessageGeneration }
    | { op: "remove"; ids: string[] }
    | { op: "begin"; id: string; generationId: string };

/** Every change to one chat in one batch. `baseRevision` is null only for a group starting with `create`. */
export type ChatGroup = { characterId: string; chatId: string; baseRevision: string | null; ops: ChatOp[] };

/** A reorder: `ids` must be a permutation of the character's chats. */
export type ChatOrderChange = { characterId: string; baseRevision: string; ids: string[] };

/**
 * What a generation-carrying write did: `applied`; `duplicate` (a replay of a write of the message's
 * current generation, whose seq is not higher: that generation still owns the message); or `ignored`
 * (another generation took the message over, or it was closed).
 */
export type CheckpointOutcome = "applied" | "duplicate" | "ignored";

export type ChatGroupResult = {
    characterId: string;
    id: string;
    /** The chat's token after the group, or null when the group deleted it. */
    revision: string | null;
    /** For `create` and `replace` (the last one in the group): the stored message ids, by position of the sent list. */
    messageIds?: string[];
    /** One entry per op carrying a `generation`, in op order. */
    checkpoints?: CheckpointOutcome[];
    /**
     * The group was applied on an older revision (by-id ops allow that): the chat holds changes the
     * client has not seen. The client keeps its older base until an idle read refreshes the mirror
     * and revision together; revision-bound work can still conflict before that refresh.
     */
    stale?: true;
};

export type ChatOrderResult = { characterId: string; revision: string; ids: string[] };

/** A chat as read: metadata plus `message` in order. */
export type ChatRecord = { characterId: string; id: string; revision: string; data: Chat };

export type ChatOrderRecord = { characterId: string; revision: string; ids: string[] };

/**
 * A 409 entry for a chat group (revision null: the chat is gone). `reason: "generating"`: the group
 * touches a message a server generation job owns (Phase 5); retry after the job ends instead of
 * reloading.
 */
export type ChatConflict = {
    kind: "chat";
    characterId: string;
    id: string;
    revision: string | null;
    reason?: "generating";
};

/** A 409 entry for a reorder or a chat whose parent order is gone. */
export type ChatOrderConflict = { kind: "chatOrder"; characterId: string; revision: string | null };
