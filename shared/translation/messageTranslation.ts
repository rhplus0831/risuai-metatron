import type { MessageTranslation } from "../database.ts";
import { translationSourceHash } from "./hash.ts";

/**
 * The stored translation of a message: its shape, its freshness, and the rule both runtimes apply
 * to a message they take in.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` has the shape of a `MessageTranslation`. */
export function isMessageTranslation(value: unknown): value is MessageTranslation {
    return (
        isPlainObject(value) &&
        typeof value.text === "string" &&
        typeof value.sourceHash === "string" &&
        value.sourceHash !== "" &&
        typeof value.targetLanguage === "string" &&
        typeof value.translatedAt === "number" &&
        Number.isFinite(value.translatedAt) &&
        (value.presetId === undefined || typeof value.presetId === "string") &&
        (value.edited === undefined || typeof value.edited === "boolean")
    );
}

/**
 * The text of a message's stored translation while it is fresh (its `sourceHash` matches the current
 * `data`), else null. This is the only freshness rule: no edit path clears a translation.
 */
export function storedTranslation(message: { readonly data: string; readonly translation?: unknown }): string | null {
    const translation = message.translation;
    if (!isMessageTranslation(translation) || translation.sourceHash !== translationSourceHash(message.data)) {
        return null;
    }
    return translation.text;
}

/**
 * Removes a `translation` that is not a `MessageTranslation` (null included) from a message the
 * caller owns, as the server's `normalizeMessage` stores it: an imported chat with an unsupported
 * translation keeps its messages. Returns whether it removed one.
 */
export function dropInvalidTranslation(message: { translation?: unknown }): boolean {
    if (Object.hasOwn(message, "translation") && !isMessageTranslation(message.translation)) {
        delete message.translation;
        return true;
    }
    return false;
}
