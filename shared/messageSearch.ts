import type { Message } from "./database.ts";

/**
 * Message search across chats: the server scans the stored messages' text (`Message.data`, not
 * translations) with a case-insensitive substring match (ASCII letters only fold, as SQLite `LIKE`
 * does), newest chat incarnation first and newest message first within a chat.
 */
export const MESSAGE_SEARCH_PATH = "/api/chats/search";

/** Fewest and most code points of a query after NFC normalization and trimming. */
export const MESSAGE_SEARCH_MIN_QUERY = 2;
export const MESSAGE_SEARCH_MAX_QUERY = 200;
/** Hits per page when `limit` is absent, and the most a page holds (a larger `limit` is clamped). */
export const MESSAGE_SEARCH_DEFAULT_LIMIT = 30;
export const MESSAGE_SEARCH_MAX_LIMIT = 100;

/**
 * The request body. No ids: every character except trashed ones and the playground; `characterId`:
 * that character's chats (even when trashed); `characterId` and `chatId`: that one chat. `cursor` is
 * a previous page's `next`, sent with the same query and scope; paging is best effort, so the client
 * drops hits it already shows (by chat ref and message id).
 */
export type MessageSearchQuery = {
    query: string;
    characterId?: string;
    chatId?: string;
    cursor?: string;
    limit?: number;
};

/**
 * One matching message. `snippet` is plain text cut around the first match (up to 60 UTF-16 code
 * units before it and 120 after it); `matchStart` and `matchLength` are UTF-16 offsets into
 * `snippet`. `chatName` and `characterName` are "" when the record has none.
 */
export type MessageSearchHit = {
    characterId: string;
    chatId: string;
    messageId: string;
    chatName: string;
    characterName: string;
    role: Message["role"];
    time?: number;
    snippet: string;
    matchStart: number;
    matchLength: number;
};

/**
 * One page. `next` is set when the scan stopped before the end (at `limit` hits or at the request's
 * byte budget), so a page may hold fewer hits than `limit`, or none, and still have a `next`.
 * `scannedBytes` counts the stored message JSON the page scanned (UTF-8 bytes).
 */
export type MessageSearchPage = {
    hits: MessageSearchHit[];
    next: string | null;
    scannedBytes: number;
};

/** The 409 body when the database was replaced (a restore or import) during the scan: search again. */
export type MessageSearchEpochConflict = { error: string; reason: "epoch" };
