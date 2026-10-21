import type { Chat } from "../database.ts";
import type { TranslatorPreset } from "../settings.ts";
import { createTranslatorPreset, isTranslatorPreset } from "../translatorPresets.ts";

/**
 * A chat's translation settings. They are stored on the chat as sent, like the binding fields, and
 * are list fields (the chat summary carries them, so a new chat inherits them from a chat that is
 * not loaded). A missing or malformed field reads as unset: translation off.
 */

/** The stored translation fields of a chat, a chat summary, or a chat list entry. */
export type ChatTranslationFields = Pick<
    Chat,
    | "translatorPresetId"
    | "autoTranslate"
    | "translateBotOnly"
    | "bilingualDisplay"
    | "bilingualEmphasis"
    | "bilingualSentences"
>;

/** Each translation field's stored type: a summary keeps a field only when it has this type. */
export const CHAT_TRANSLATION_FIELD_TYPES = {
    translatorPresetId: "string",
    autoTranslate: "boolean",
    translateBotOnly: "boolean",
    bilingualDisplay: "boolean",
    bilingualEmphasis: "string",
    bilingualSentences: "number",
} as const satisfies Record<keyof ChatTranslationFields, "string" | "number" | "boolean">;

export const CHAT_TRANSLATION_FIELDS = Object.keys(CHAT_TRANSLATION_FIELD_TYPES) as (keyof ChatTranslationFields)[];

/** The most sentences a bilingual pair holds (`bilingualSentences`; 0 pairs by line). */
export const MAX_BILINGUAL_SENTENCES = 10;

/** A chat's translation settings as read: every field defaulted. */
export type ChatTranslationSettings = {
    /** The chat's own translator preset id as stored (non-blank), whether or not it exists; else null. */
    translatorPresetId: string | null;
    autoTranslate: boolean;
    translateBotOnly: boolean;
    bilingualDisplay: boolean;
    bilingualEmphasis: "original" | "translation";
    /** 0: pair by line; 1–10: pair every N sentences. */
    bilingualSentences: number;
};

export function readChatTranslationSettings(
    chat: Readonly<ChatTranslationFields> | null | undefined,
): ChatTranslationSettings {
    const sentences = chat?.bilingualSentences;
    return {
        translatorPresetId:
            typeof chat?.translatorPresetId === "string" && chat.translatorPresetId.trim() !== ""
                ? chat.translatorPresetId
                : null,
        autoTranslate: chat?.autoTranslate === true,
        translateBotOnly: chat?.translateBotOnly === true,
        bilingualDisplay: chat?.bilingualDisplay === true,
        bilingualEmphasis: chat?.bilingualEmphasis === "translation" ? "translation" : "original",
        bilingualSentences:
            typeof sentences === "number" &&
            Number.isInteger(sentences) &&
            sentences >= 1 &&
            sentences <= MAX_BILINGUAL_SENTENCES
                ? sentences
                : 0,
    };
}

/**
 * The global translator preset: the valid preset whose id is `selectedId`, else the first valid one,
 * else a default. It never writes the state.
 */
export function selectedTranslatorPreset(presets: unknown, selectedId: unknown): TranslatorPreset {
    const valid = Array.isArray(presets) ? presets.filter(isTranslatorPreset) : [];
    return valid.find((preset) => preset.id === selectedId) ?? valid[0] ?? createTranslatorPreset("Default");
}

export type ResolvedTranslatorPreset = {
    preset: TranslatorPreset;
    /** `chat`: the chat's own preset; `global`: the global selection. */
    source: "chat" | "global";
    /** The chat names a preset that does not exist (the global selection is used). */
    missing: boolean;
};

/**
 * The translator preset a chat translates with: the chat's own when it names a valid preset that
 * exists, else the global selection. Not the binding's fail-closed rule: translation is optional,
 * and a deleted preset rewrites nothing.
 */
export function resolveTranslatorPreset(
    chat: Readonly<ChatTranslationFields> | null | undefined,
    presets: unknown,
    selectedId: unknown,
): ResolvedTranslatorPreset {
    const id = readChatTranslationSettings(chat).translatorPresetId;
    if (id !== null) {
        const own = Array.isArray(presets)
            ? presets.find((preset) => isTranslatorPreset(preset) && preset.id === id)
            : undefined;
        if (own) {
            return { preset: own as TranslatorPreset, source: "chat", missing: false };
        }
    }
    return { preset: selectedTranslatorPreset(presets, selectedId), source: "global", missing: id !== null };
}

/**
 * The translation fields a chat summary carries: each stored field of its type, nothing defaulted
 * (the server's `chatSummary` and the tab's list entry use the same rule).
 */
export function chatTranslationSummary(meta: Readonly<Record<string, unknown>>): ChatTranslationFields {
    const summary: Record<string, unknown> = {};
    for (const field of CHAT_TRANSLATION_FIELDS) {
        if (typeof meta[field] === CHAT_TRANSLATION_FIELD_TYPES[field]) {
            summary[field] = meta[field];
        }
    }
    return summary as ChatTranslationFields;
}
