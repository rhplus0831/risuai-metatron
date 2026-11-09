/**
 * Displayed chat message counts and their normalization, shared with
 * `server/src/data/normalize/ui.ts` and re-exported by `src/ts/chatLoadPages.ts` for chat screens.
 * The persisted settings call these counts "pages"; they size the rendered message window rather
 * than a server fetch. Counts are positive integers with no upper cap; `CHAT_ROW_CAP` is a separate
 * trimming target for appends at the bottom.
 */

/** Maximum steady-state row window after an append at the bottom (plus any visible overflow). */
export const CHAT_ROW_CAP = 150;

/** Default number of messages displayed when opening a chat. */
export const DEFAULT_CHAT_LOAD_INITIAL_PAGES = 30;
/** Default number of older messages revealed by each load-more increment. */
export const DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES = 15;

/**
 * Coerces `value` with `Number` and floors finite values at least 1, without an upper cap. Otherwise
 * floors a finite fallback at least 1, or uses 1. A Symbol yields the fallback; other numeric
 * coercion errors propagate.
 */
export function normalizeChatLoadPages(value: unknown, fallback: number): number {
    const fallbackValue = Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 1;
    if (typeof value === "symbol") {
        return fallbackValue;
    }
    const numberValue = typeof value === "number" ? value : Number(value);

    if (!Number.isFinite(numberValue) || numberValue < 1) {
        return fallbackValue;
    }

    return Math.floor(numberValue);
}

/** Reads the normalized initial message count, using its default for missing or invalid values. */
export function getInitialChatLoadPages(db: { chatLoadInitialPages?: number }): number {
    return normalizeChatLoadPages(db.chatLoadInitialPages, DEFAULT_CHAT_LOAD_INITIAL_PAGES);
}

/** Reads the normalized load-more message count, using its default for missing or invalid values. */
export function getAdditionalChatLoadPages(db: { chatLoadAdditionalPages?: number }): number {
    return normalizeChatLoadPages(db.chatLoadAdditionalPages, DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES);
}
