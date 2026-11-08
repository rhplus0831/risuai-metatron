import type { ChatMeta } from "./chats.ts";
import type { Message } from "./database.ts";
import { TOGGLE_VARIABLE_PREFIX } from "./prompt/toggles.ts";
import type { StructuredMemoryRecordKind } from "./structuredMemory.ts";

/**
 * Shared checkpoint types, field ownership, and limits for `server/src/data/checkpointStore.ts`
 * and `src/ts/checkpoints/chatCheckpoints.svelte.ts`. A checkpoint saves messages and captured story
 * fields; composing it uses the current chat's kept fields. `GLGlobalVariables` is split so prompt
 * toggles stay current while its other entries come from the checkpoint. Structured memory uses a
 * separate manifest of ordered content-page hashes, even when it has no records.
 * `server/src/data/checkpointService.ts` applies automatic retention and saves a safety checkpoint
 * before loading one; this module performs no storage or scheduling itself.
 */

/** Every persisted chat field's behavior when saving and composing a checkpoint. */
export const CHECKPOINT_CHAT_FIELDS: Record<keyof ChatMeta, "capture" | "keep" | "split"> = {
    note: "capture",
    localLore: "capture",
    loreOverrides: "capture",
    scriptstate: "capture",
    supaMemoryData: "capture",
    hypaV2Data: "capture",
    hypaV3Data: "capture",
    lastMemory: "capture",
    fmIndex: "capture",
    bookmarks: "capture",
    bookmarkNames: "capture",
    toolCalls: "capture",
    suggestMessages: "capture",
    sdData: "capture",
    GLGlobalVariables: "split",
    id: "keep",
    name: "keep",
    pinned: "keep",
    folderId: "keep",
    lastDate: "keep",
    bindedPersona: "keep",
    promptPresetId: "keep",
    modelPresetId: "keep",
    bindingReview: "keep",
    togglePresetId: "keep",
    translatorPresetId: "keep",
    autoTranslate: "keep",
    translateBotOnly: "keep",
    bilingualDisplay: "keep",
    bilingualEmphasis: "keep",
    bilingualSentences: "keep",
    memoryTrimAck: "keep",
    loreBudgetWarnOff: "keep",
    structuredMemoryLanguage: "keep",
    structuredMemoryHighlight: "keep",
    modules: "keep",
};

/**
 * The `chatCheckpoints.fields` key that names a checkpoint's `CheckpointMemoryManifest` page. Reserved:
 * never a key of `ChatMeta`. Every saved checkpoint has it, also for a chat with no records, so a
 * checkpoint without it comes from before checkpoints held structured memory.
 */
export const CHECKPOINT_MEMORY_FIELD = "structuredMemoryRecords";

/** A checkpoint's memory: each record kind's chunk page hashes, in order. */
export type CheckpointMemoryManifest = Record<StructuredMemoryRecordKind, string[]>;

/** Maximum checkpoint name length in UTF-16 units; truncation preserves surrogate pairs. */
export const MAX_CHECKPOINT_NAME = 200;
/** Maximum manual checkpoints stored per chat; saving another is refused. */
export const MAX_MANUAL_CHECKPOINTS = 100;
/** Number of newest safety checkpoints retained after loading a checkpoint. */
export const SAFETY_KEEP = 3;
/** Minimum automatic checkpoint interval, in user turns. */
export const MIN_AUTO_EVERY = 1;
/** Maximum automatic checkpoint interval, in user turns. */
export const MAX_AUTO_EVERY = 100;
/** Minimum number of automatic checkpoints a policy may retain. */
export const MIN_AUTO_KEEP = 1;
/** Maximum number of automatic checkpoints a policy may retain. */
export const MAX_AUTO_KEEP = 20;
/** Maximum UTF-16 units of text stored for each preview message. */
export const CHECKPOINT_PREVIEW_TEXT_LENGTH = 280;

/** How a checkpoint was created: by the user, automatically, or for safety before loading another. */
export type CheckpointKind = "manual" | "auto" | "safety";

/** Small stored preview, so listing checkpoints never reads their content pages. */
export type CheckpointPreview = {
    /** The last two messages in conversation order. */
    messages: { role: Message["role"]; text: string }[];
    summaries: number;
    loreEntries: number;
    variables: number;
};

/**
 * Stored checkpoint listing metadata and preview, exposed by `server/src/data/checkpointStore.ts`
 * without reading content pages. `revision` identifies the checkpoint, not the captured chat.
 */
export type CheckpointSummary = {
    id: string;
    kind: CheckpointKind;
    name: string;
    createdAt: number;
    revision: string;
    userTurns: number;
    messageCount: number;
    preview: CheckpointPreview;
};

/**
 * Per-chat automatic checkpoint policy persisted by `server/src/data/checkpointStore.ts`: the
 * user-turn interval and retained count must be integers within their respective MIN/MAX limits.
 */
export type CheckpointPolicy = { autoEvery: number; autoKeep: number };

/** The policy together with its last automatic checkpoint's user-turn baseline. */
export type CheckpointPolicyState = CheckpointPolicy & { lastAutoTurns: number | null };

/** Prompt toggles stay with the current chat when a checkpoint is composed. */
export function isToggleKey(key: string): boolean {
    return key.startsWith(TOGGLE_VARIABLE_PREFIX);
}

/** Takes at most `units` UTF-16 units, dropping a trailing high surrogate rather than splitting a pair. */
export function truncateCheckpointText(text: string, units: number): string {
    const truncated = text.slice(0, units);
    const last = truncated.charCodeAt(truncated.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}
