import type { ChatMeta } from "./chats.ts";
import type { Message } from "./database.ts";
import { TOGGLE_VARIABLE_PREFIX } from "./prompt/toggles.ts";

/** Every persisted chat field's behavior when saving and composing a checkpoint. */
export const CHECKPOINT_CHAT_FIELDS: Record<keyof ChatMeta, "capture" | "keep" | "split"> = {
    note: "capture",
    localLore: "capture",
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
    modules: "keep",
};

export const MAX_CHECKPOINT_NAME = 200;
export const MAX_MANUAL_CHECKPOINTS = 100;
export const SAFETY_KEEP = 3;
export const MIN_AUTO_EVERY = 1;
export const MAX_AUTO_EVERY = 100;
export const MIN_AUTO_KEEP = 1;
export const MAX_AUTO_KEEP = 20;
export const CHECKPOINT_PREVIEW_TEXT_LENGTH = 280;

export type CheckpointKind = "manual" | "auto" | "safety";

/** Small stored preview, so listing checkpoints never reads their content pages. */
export type CheckpointPreview = {
    /** The last two messages in conversation order. */
    messages: { role: Message["role"]; text: string }[];
    summaries: number;
    loreEntries: number;
    variables: number;
};

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
