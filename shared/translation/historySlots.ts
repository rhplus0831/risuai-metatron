import type { Message } from "../database.ts";
import { storedTranslation } from "./messageTranslation.ts";

/**
 * The translator's history slots: `{{slot::history::N}}` (the source text of the N messages before
 * the translated one) and `{{slot::historytrans::N}}` (their fresh stored translations). Pure: the
 * server runner counts the tokens (`buildTranslatorHistory`'s `countTokens`); the pipeline fills
 * the slots from the result (`TranslatorSlotValues.history`). Anywhere without one (the tab), they
 * fill in empty.
 */

export const TRANSLATOR_HISTORY_MAX_COUNT = 50;
export const DEFAULT_TRANSLATOR_HISTORY_MAX_TOKENS = 2048;

export type TranslatorHistorySlot = "history" | "historytrans";

/** A history slot's text by its slot and its count; `""` for a count it was not built for. */
export type TranslatorHistory = (slot: TranslatorHistorySlot, count: number) => string;

/** The count of a history slot (`{{slot::history::N}}`'s `N`): all digits, 1 to 50; else null. */
export function translatorHistoryCount(raw: string): number | null {
    if (!/^\d+$/.test(raw)) {
        return null;
    }
    const count = Number(raw);
    return count >= 1 && count <= TRANSLATOR_HISTORY_MAX_COUNT ? count : null;
}

/** The history budget in use: `translatorHistoryMaxTokens` when it is a finite number above 0, else 2048. */
export function translatorHistoryMaxTokens(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_TRANSLATOR_HISTORY_MAX_TOKENS;
}

export interface TranslatorHistoryEntry {
    role: "user" | "char";
    /** The message's `data`, as it is stored (no CBS). */
    source: string;
    /** Its fresh stored translation (`storedTranslation`), an empty one included; absent when none. */
    translated?: string;
}

/**
 * Up to `count` entries before `messages[messageIndex]`, oldest first: walking back from the
 * message before it, a row with `disabled: "allBefore"` ends the walk (it is not taken, comment or
 * not), and a disabled row (`disabled: true`) or a comment row (`isComment`) is skipped.
 * `transformText` (Exclude Chain-of-Thought) is applied to each entry's source and to its
 * translation, after the translation's freshness is read from the stored message.
 */
export function collectTranslatorHistory(
    messages: readonly Message[],
    messageIndex: number,
    count: number,
    transformText: (text: string) => string = (text) => text,
): TranslatorHistoryEntry[] {
    const newestFirst: TranslatorHistoryEntry[] = [];
    for (let index = Math.min(messageIndex, messages.length) - 1; index >= 0; index--) {
        if (newestFirst.length >= count) {
            break;
        }
        const message = messages[index];
        if (message.disabled === "allBefore") {
            break;
        }
        if (message.disabled === true || message.isComment === true) {
            continue;
        }
        const translated = storedTranslation(message);
        newestFirst.push({
            role: message.role === "user" ? "user" : "char",
            source: transformText(message.data),
            ...(translated !== null ? { translated: transformText(translated) } : {}),
        });
    }
    return newestFirst.reverse();
}

/** One entry as a history slot shows it. */
export function translatorHistoryBlock(role: TranslatorHistoryEntry["role"], body: string): string {
    return `${role}: ${body}\n\n---\n\n`;
}

/**
 * The history slots of `counts` (invalid ones and repeats ignored) for `messages[messageIndex]`.
 * For each count, the newest entries of `collectTranslatorHistory`, then the oldest whole entries
 * dropped while their tokens pass `maxTokens` (`translatorHistoryMaxTokens`): an entry costs its
 * source block plus its translation block, an empty one when it has no translation (the block
 * `{{slot::historytrans::N}}` shows for it), so both slots list the same entries. The budget is per
 * count and covers these blocks only, not the rest of the request. Each entry's tokens are counted
 * once, one after another; an error from `countTokens` ends the build. `transformText` goes to
 * `collectTranslatorHistory`, so the blocks are counted as they are shown.
 */
export async function buildTranslatorHistory(input: {
    messages: readonly Message[];
    messageIndex: number;
    counts: readonly number[];
    maxTokens: unknown;
    countTokens: (text: string) => Promise<number>;
    transformText?: (text: string) => string;
}): Promise<TranslatorHistory> {
    const counts = [...new Set(input.counts.filter((count) => translatorHistoryCount(String(count)) === count))];
    if (counts.length === 0) {
        return () => "";
    }
    const maxTokens = translatorHistoryMaxTokens(input.maxTokens);
    const entries = collectTranslatorHistory(
        input.messages,
        input.messageIndex,
        Math.max(...counts),
        input.transformText,
    );
    const tokens: number[] = [];
    for (const entry of entries) {
        tokens.push(
            (await input.countTokens(translatorHistoryBlock(entry.role, entry.source))) +
                (await input.countTokens(translatorHistoryBlock(entry.role, entry.translated ?? ""))),
        );
    }

    const rendered = new Map<number, Record<TranslatorHistorySlot, string>>();
    for (const count of counts) {
        let first = Math.max(0, entries.length - count);
        let total = tokens.slice(first).reduce((sum, value) => sum + value, 0);
        while (first < entries.length && total > maxTokens) {
            total -= tokens[first];
            first += 1;
        }
        const kept = entries.slice(first);
        rendered.set(count, {
            history: kept.map((entry) => translatorHistoryBlock(entry.role, entry.source)).join(""),
            historytrans: kept.map((entry) => translatorHistoryBlock(entry.role, entry.translated ?? "")).join(""),
        });
    }
    return (slot, count) => rendered.get(count)?.[slot] ?? "";
}
