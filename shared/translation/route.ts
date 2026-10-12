import type { MessageTranslation } from "../database.ts";
import { isMessageTranslation } from "./messageTranslation.ts";

/**
 * The stored-translation route (`docs/plan/translation.md` slices 1.3 and 1.4): the server runner
 * (`server/src/routes/translate.ts`) and the tab's caller (`src/ts/translator/storedTranslation.svelte.ts`).
 */
export const TRANSLATE_MESSAGE_PATH = "/api/translate/message";

/** The body: the message, and the ids the chat displays with (`chatDisplayIds`). */
export interface TranslateMessageBody {
    characterId: string;
    chatId: string;
    messageId: string;
    presetId: string;
    modelPresetId: string;
    personaId: string;
    force?: boolean;
}

/**
 * A 200 answer: `applied` (stored), `ignored` (the text changed during the run; nothing stored), or
 * `fresh` (not forced, and a fresh translation was already stored).
 */
export type TranslateMessageAnswer =
    { outcome: "applied" | "fresh"; translation: MessageTranslation } | { outcome: "ignored"; translation: null };

/** Whether `value` is a `TranslateMessageAnswer`. */
export function isTranslateMessageAnswer(value: unknown): value is TranslateMessageAnswer {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const answer = value as { outcome?: unknown; translation?: unknown };
    if (answer.outcome === "ignored") {
        return answer.translation === null;
    }
    return (answer.outcome === "applied" || answer.outcome === "fresh") && isMessageTranslation(answer.translation);
}
