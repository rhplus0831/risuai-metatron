import type { Chat, Message, MessageTranslation } from "./database.ts";
import type { ChatTranslationFields } from "./translation/chatSettings.ts";

/**
 * The chat wire contract. A chat is stored as its metadata plus one row per message, addressed by
 * `Message.chatId`; each character's chat order is a record of its own. Chat changes travel in the
 * resource batch (`POST /api/resources/batch`) beside resource ops.
 */

/** Chat fields a `meta` op may not set or unset: identity, the messages, and client-only state. */
export const CHAT_META_FORBIDDEN_KEYS = ["id", "message", "isStreaming", "activeStreamingDisplayOptimizationMode"];

/** The chat fields a `meta` op may `merge` entries into (and remove entries from with `mergeUnset`). */
export const CHAT_META_MERGE_KEYS = ["toolCalls", "GLGlobalVariables", "scriptstate"];

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
 * current revision; the others apply on a stale revision, except a `begin` that starts a generation
 * the message does not know yet: it needs the current revision unless the message was inserted by
 * the same group. A `begin` of the message's current or an earlier generation is a replay and
 * changes nothing.
 *
 * A `setText`, `setMessage`, `patchMessage`, or `setTranslation` whose message is gone when it runs
 * changes nothing and is reported `missing` (`ChatGroupResult.targets`); the rest of the group still
 * applies. A single-id `remove` of a missing message is a no-op. These still conflict (the whole
 * batch rolls back): an `append` whose `after` anchor is gone, a `remove` of several ids one of which
 * is missing, and a `begin` of a missing message (its writer, a generation job, takes the message's
 * lock before the write and needs the refusal to give it back).
 *
 * `setMessage` replaces the whole row, also on a stale revision: a sender whose copy is behind
 * reverts every field another writer changed meanwhile, so it needs the current revision for the
 * fields it does not own (not enforced). A change of some fields of a message is a `patchMessage`.
 */
export type ChatOp =
    | { op: "create"; chat: Chat; index?: number }
    | { op: "delete" }
    | { op: "replace"; chat: Chat }
    /**
     * `merge` adds entries to a field that is a map (`CHAT_META_MERGE_KEYS`): each named field keeps
     * its other entries as stored, so two writers adding different entries do not replace each
     * other's. `mergeUnset` removes entries from such a field as stored, before `merge` adds its
     * entries (an id in both ends up added); removals alone leave a field that is not a map as it is.
     * A field named by `merge` or `mergeUnset` may not also be in `set` or `unset`.
     */
    | {
          op: "meta";
          set?: Record<string, unknown>;
          unset?: string[];
          merge?: Record<string, Record<string, unknown>>;
          mergeUnset?: Record<string, string[]>;
      }
    | { op: "append"; messages: Message[]; anchor: MessageAnchor }
    | { op: "setMessage"; message: Message; generation?: MessageGeneration }
    | { op: "setText"; id: string; text: string; generation?: MessageGeneration }
    /**
     * Sets and unsets fields of one message on the row as stored: fields it does not name keep
     * another writer's values, also on a stale revision. A manual write, like a `setMessage` or
     * `setText` without a generation: it closes an open generation fence and carries no generation.
     * It never changes a stored translation (`translation` named in `set` or `unset` is ignored);
     * `chatId` cannot be named, `role` and `data` cannot be unset, and it must name another field.
     */
    | {
          op: "patchMessage";
          id: string;
          set?: Partial<Omit<Message, "chatId" | "translation">>;
          unset?: Exclude<keyof Message, "chatId" | "translation" | "role" | "data">[];
      }
    | { op: "remove"; ids: string[] }
    | { op: "begin"; id: string; generationId: string }
    /**
     * Sets or clears a message's stored translation. A translation lands only while its
     * `sourceHash` matches the message's current `data`, else the op is `ignored`
     * (`ChatGroupResult.translations`); `null` always clears. The only op besides `replace` that
     * changes a stored translation (`setMessage` keeps it).
     */
    | { op: "setTranslation"; id: string; translation: MessageTranslation | null };

/**
 * Every change to one chat in one batch. `baseRevision` is null only for a group starting with `create`.
 *
 * `groupId`: the client's id of the group, the same on a resend. The chat remembers the ids of the
 * last `MAX_CHAT_GROUP_IDS` (server) groups it applied, answered or not, so a resend of one of them
 * is answered with that group's result (`ChatGroupResult`) and changes nothing, before any lock,
 * revision, or anchor check. `retry`: this is a resend of a group whose answer was lost; when the
 * chat no longer remembers its id and may have dropped it (the group's base is not newer than the
 * oldest id it kept), the group conflicts with `reason: "expired"` instead of applying a second
 * time. The ids belong to a chat incarnation: a chat deleted and created again remembers none.
 */
export type ChatGroup = {
    characterId: string;
    chatId: string;
    baseRevision: string | null;
    ops: ChatOp[];
    groupId?: string;
    retry?: true;
};

/** A reorder: `ids` must be a permutation of the character's chats. */
export type ChatOrderChange = { characterId: string; baseRevision: string; ids: string[] };

/**
 * What a generation-carrying write did: `applied`; `duplicate` (a replay of a write of the message's
 * current generation, whose seq is not higher: that generation still owns the message; or a write of
 * a group the chat already applied, `ChatGroup.groupId`, whatever generation owns the message now);
 * or `ignored` (another generation took the message over, it was closed, or the message is gone).
 */
export type CheckpointOutcome = "applied" | "duplicate" | "ignored";

/**
 * What a `setTranslation` did: `applied` (stored, cleared, or already stored as given) or `ignored`
 * (the message's text no longer matches the translation's `sourceHash`, or the message is gone).
 */
export type TranslationOutcome = "applied" | "ignored";

/**
 * Whether the message a `setText`, `setMessage`, `patchMessage`, or `setTranslation` names was there
 * when the op ran: `applied` (it was; what the op then did is in `checkpoints` or `translations`) or
 * `missing` (it was gone: the op changed nothing, and the group's other ops still applied).
 */
export type TargetOutcome = "applied" | "missing";

/**
 * A group's answer. For a group whose `groupId` the chat already applied, the answer that group got:
 * `revision` as of that group (older than the chat's current one when others wrote since), its
 * `stale`, `messageIds`, `translations`, and `targets`, and every `checkpoints` entry `duplicate`.
 */
export type ChatGroupResult = {
    characterId: string;
    id: string;
    /** The chat's token after the group, or null when the group deleted it. */
    revision: string | null;
    /** For `create` and `replace` (the last one in the group): the stored message ids, by position of the sent list. */
    messageIds?: string[];
    /** One entry per op carrying a `generation`, in op order. */
    checkpoints?: CheckpointOutcome[];
    /** One entry per `setTranslation` op, in op order. */
    translations?: TranslationOutcome[];
    /**
     * One entry per `setText`, `setMessage`, `patchMessage`, and `setTranslation` op, in op order;
     * present only when one of them was `missing` (absent: every such op found its message).
     */
    targets?: TargetOutcome[];
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
 * A chat's summary: what a chat list shows, projected from the stored metadata without reading
 * message rows. It carries no messages, memory (`hypaV2Data`, `hypaV3Data`, `supaMemoryData`),
 * bookmarks, or `toolCalls`; it is never a `Chat`. `fmIndex` and `name` arrive defaulted (the
 * server's chat normalizer stores both); `pinned` is projected only when true.
 */
export type ChatSummary = {
    characterId: string;
    id: string;
    revision: string;
    name: string;
    pinned?: boolean;
    folderId?: string;
    bindedPersona?: string;
    promptPresetId?: string;
    modelPresetId?: string;
    bindingReview?: boolean;
    fmIndex: number;
} & ChatTranslationFields;

/**
 * A 409 entry for a chat group (revision null: the chat is gone). `reason: "generating"`: the group
 * touches a message a server generation job owns; discard by-id edits of the named locked messages
 * and reload the chat when idle, retrying retained work after the job ends. `reason: "expired"`:
 * the chat may have forgotten a retry's id; it may already have landed, so reload and discard with
 * the notice instead of repairing it or giving it a new identity.
 */
export type ChatConflict = {
    kind: "chat";
    characterId: string;
    id: string;
    revision: string | null;
    reason?: "generating" | "expired";
    /**
     * With `reason: "generating"`: the messages the group's ops rewrite or remove that a generation
     * job owns (the refusal's evidence, not every lock of the chat); absent when there is none (a
     * whole-chat `replace` or `delete` of a chat holding a lock). The client drops its edits of these
     * messages and retries the rest after the job.
     */
    messageIds?: string[];
};

/** A 409 entry for a reorder or a chat whose parent order is gone. */
export type ChatOrderConflict = { kind: "chatOrder"; characterId: string; revision: string | null };
