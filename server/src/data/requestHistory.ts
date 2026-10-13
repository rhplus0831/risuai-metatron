import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { FetchLogEntry } from "../llm/transport.ts";

/**
 * The durable LLM request history (`docs/plan/request-history-diagnostics.md`, slice 2): one row per
 * request (a `runInJob` or `start` call, so each retry is its own row), in a file of its own
 * (`save/data/request-history.sqlite`). It is diagnostic data: in no snapshot, backup, or export, and
 * a restore, an import, or a maintenance does not touch it. Only its caps and the user clear it.
 *
 * A row is begun `pending`, gets the transport's log entries as exchanges, and is finished once with
 * its outcome. Rows still `pending` when the store opens become `interrupted` (the server stopped
 * while they ran). With content off (`begin`'s `content: false`), the row is a summary: no prompt and
 * no exchanges, but the bounded error message is still kept.
 *
 * Bounds: the prompt (its JSON text) 2 MiB, an exchange's body 2 MiB, its response 4 MiB, its URL and
 * header 64 KiB each, the error 64 KiB, a display field (model, provider, provider code) 1 KiB, and 32
 * exchanges per request: the first 32 are kept and the later ones only counted, so a long tool
 * sequence can lose its last exchange (the outcome's HTTP status, provider code, and sizes come
 * from `finish`, not from the kept exchanges). Text is cut at a UTF-8 boundary, and every cut is
 * recorded in the row's truncation record with its original and stored bytes; a cut prompt is no
 * longer valid JSON and stays text. An id (job, character, chat, message, profile) is never cut: one
 * over 2 KiB is not stored (null, with its cut recorded).
 *
 * Caps: the row count (`limit`, read at every prune, clamped to 10–10,000) and the stored bytes
 * (`maxBytes`, 512 MiB by default). A row's bytes are the UTF-8 bytes of every text it stores plus a
 * fixed overhead per row and per exchange. Every write removes the oldest rows (by begin order)
 * while the history is over either cap, a pending one included: a later write to a removed row is
 * skipped. The file itself (pages, indexes, the WAL) is larger than that sum, and WAL with
 * `synchronous = NORMAL` can lose the last commits on a power failure.
 *
 * The store never throws to its caller: a failure to open leaves it inert (writes skipped, reads
 * empty, `available()` false), and a failed operation is skipped with one warning for the process
 * (`deleteAll` then answers null). A transaction that cannot be rolled back closes the store.
 */

export type RequestHistoryStatus = "pending" | "success" | "error" | "aborted" | "interrupted";
export type RequestHistoryEndStatus = "success" | "error" | "aborted";

export type RequestHistoryBegin = {
    /** The request id (`RequestBegin.requestId`); at most 256 bytes, else the row is not begun. */
    id: string;
    jobId: string | null;
    source: string;
    mode: string;
    chaId: string | null;
    chatId: string | null;
    messageId: string | null;
    startedAt?: number;
    /** Whether content (prompt, exchanges) is stored (the `requestHistoryContent` setting). */
    content: boolean;
    /** The `formated` the request layer received, stored as its JSON text. */
    prompt?: unknown;
} & RequestHistoryModel;

/** The model a request runs on; a tab's request knows it only after it began (`describe`). */
export type RequestHistoryModel = {
    modelId?: string | null;
    profileId?: string | null;
    profileName?: string | null;
    /** The `LLMFormat` name. */
    provider?: string | null;
};

/** The original bytes of exchange fields the caller already cut (a stream tee's bound). */
export type RequestHistoryExchangeCuts = Partial<Record<"url" | "header" | "body" | "response", number>>;

export type RequestHistoryOutcome = {
    status: RequestHistoryEndStatus;
    completedAt?: number;
    httpStatus?: number | null;
    providerCode?: string | null;
    /** The redacted error message. */
    error?: string | null;
    requestBytes?: number | null;
    responseBytes?: number | null;
};

export type RequestHistoryFieldCut = { originalBytes: number; storedBytes: number };

/** Every cut field: `prompt`, `error`, a short field by name, or `exchange.<index>.<field>`. */
export type RequestHistoryTruncation = Record<string, RequestHistoryFieldCut>;

export type RequestHistorySummary = {
    id: string;
    jobId: string | null;
    source: string;
    mode: string;
    chaId: string | null;
    chatId: string | null;
    messageId: string | null;
    modelId: string | null;
    profileId: string | null;
    profileName: string | null;
    provider: string | null;
    startedAt: number;
    firstByteAt: number | null;
    completedAt: number | null;
    status: RequestHistoryStatus;
    httpStatus: number | null;
    providerCode: string | null;
    hasError: boolean;
    requestBytes: number | null;
    responseBytes: number | null;
    content: boolean;
    /** Exchanges offered to the row, kept or not. */
    exchangeCount: number;
    /** Exchanges kept (at most 32). */
    storedExchanges: number;
    /** Whether a field was cut or an exchange dropped. */
    truncated: boolean;
    sharedAt: number | null;
    /** The bytes the row counts toward the byte cap. */
    bytes: number;
};

export type RequestHistoryExchange = {
    url: string;
    header: string;
    body: string;
    response: string;
    success: boolean;
    status: number | null;
    date: string;
    responseType: string | null;
};

export type RequestHistoryRecord = RequestHistorySummary & {
    error: string | null;
    /** The prompt's JSON text (it may be cut), or null (content off, none given, or unserializable). */
    prompt: string | null;
    /** In order; null when content is off. */
    exchanges: RequestHistoryExchange[] | null;
    truncation: RequestHistoryTruncation;
};

export type RequestHistoryListQuery = {
    /** The `next` of the previous page. */
    cursor?: string | null;
    /** The page size, default 50, clamped to 1–200. */
    limit?: number;
    chaId?: string | null;
    chatId?: string | null;
    jobId?: string | null;
    status?: RequestHistoryStatus | null;
};

export type RequestHistory = {
    begin(summary: RequestHistoryBegin): void;
    /**
     * Sets the prompt of a pending row with content on and no prompt yet, as the given text (the
     * request layer's redacted JSON text), bounded like `begin`'s.
     */
    setPrompt(id: string, text: string): void;
    /** Fills the model of a pending row (fields given only). */
    describe(id: string, model: RequestHistoryModel): void;
    /** The first byte of a pending row; the first one wins. */
    firstByte(id: string, at?: number): void;
    /** Appends a transport log entry (content on only), whatever the row's status. */
    exchange(id: string, entry: FetchLogEntry, cuts?: RequestHistoryExchangeCuts): void;
    /** Ends a pending row; the first finish wins. */
    finish(id: string, outcome: RequestHistoryOutcome): void;
    /** Summaries, newest first. */
    list(query?: RequestHistoryListQuery): { items: RequestHistorySummary[]; next: string | null };
    get(id: string): RequestHistoryRecord | null;
    /**
     * Removes every row, pending ones included; returns the count, or null when nothing was removed
     * because the store is unavailable or the delete failed.
     */
    deleteAll(): number | null;
    /** Sets or clears `sharedAt` on the rows; returns how many changed. */
    setShared(ids: readonly string[], at: number | null): number;
    /** Removes the oldest rows until both caps hold (`limit` defaults to the `limit` option). */
    prune(limit?: number): void;
    stats(): { rows: number; bytes: number };
    /** Whether the database is open (false when it failed to open, after a failed rollback, or once closed). */
    available(): boolean;
    close(): void;
};

const KIB = 1024;
const MIB = 1024 * KIB;

export const REQUEST_HISTORY_MAX_BYTES = 512 * MIB;
export const REQUEST_HISTORY_DEFAULT_LIMIT = 1000;
export const REQUEST_HISTORY_MIN_LIMIT = 10;
export const REQUEST_HISTORY_MAX_LIMIT = 10_000;
export const REQUEST_HISTORY_BOUNDS = {
    prompt: 2 * MIB,
    body: 2 * MIB,
    response: 4 * MIB,
    url: 64 * KIB,
    header: 64 * KIB,
    error: 64 * KIB,
    short: KIB,
    /** An id a resource store holds (at most 512 UTF-16 units, so at most 1,536 UTF-8 bytes). */
    identity: 2 * KIB,
    id: 256,
    exchanges: 32,
} as const;
/** The bytes a row and an exchange count for their fixed columns. */
export const REQUEST_HISTORY_ROW_OVERHEAD = 256;
export const REQUEST_HISTORY_EXCHANGE_OVERHEAD = 64;

const SCHEMA_VERSION = "1";
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const STATUSES: readonly RequestHistoryStatus[] = ["pending", "success", "error", "aborted", "interrupted"];
const END_STATUSES: readonly RequestHistoryEndStatus[] = ["success", "error", "aborted"];

/** The count cap: a non-number is the default; otherwise rounded and clamped to 10–10,000. */
export function clampRequestHistoryLimit(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return REQUEST_HISTORY_DEFAULT_LIMIT;
    }
    return Math.min(REQUEST_HISTORY_MAX_LIMIT, Math.max(REQUEST_HISTORY_MIN_LIMIT, Math.round(value)));
}

type Bounded = { text: string; bytes: number; cut: RequestHistoryFieldCut | null };

/** `text` cut to `max` UTF-8 bytes at a character boundary. */
function bound(text: string, max: number, originalBytes?: number): Bounded {
    const buffer = Buffer.from(text, "utf8");
    let stored = text;
    let bytes = buffer.byteLength;
    if (bytes > max) {
        let end = max;
        // Back up over continuation bytes (10xxxxxx) to the start of the cut character.
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
            end--;
        }
        stored = buffer.subarray(0, end).toString("utf8");
        bytes = end;
    }
    const original = Math.max(originalBytes ?? 0, buffer.byteLength);
    return { text: stored, bytes, cut: original > bytes ? { originalBytes: original, storedBytes: bytes } : null };
}

/** A log field as text: the transport types it as a string, but an absent body arrives `undefined`. */
function asText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value === undefined || value === null) {
        return "";
    }
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/** A whole number SQLite and JavaScript both hold exactly, or null. */
function int(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    const whole = Math.trunc(value);
    return Number.isSafeInteger(whole) ? whole : null;
}

/** A byte count: a whole, nonnegative number, or null. */
function size(value: unknown): number | null {
    const whole = int(value);
    return whole !== null && whole >= 0 ? whole : null;
}

function utf8(value: string | null): number {
    return value === null ? 0 : Buffer.byteLength(value, "utf8");
}

type SummaryRow = {
    seq: number | bigint;
    id: string;
    job_id: string | null;
    source: string;
    mode: string;
    cha_id: string | null;
    chat_id: string | null;
    message_id: string | null;
    model_id: string | null;
    profile_id: string | null;
    profile_name: string | null;
    provider: string | null;
    started_at: number | bigint;
    first_byte_at: number | bigint | null;
    completed_at: number | bigint | null;
    status: string;
    http_status: number | bigint | null;
    provider_code: string | null;
    has_error: number | bigint;
    request_bytes: number | bigint | null;
    response_bytes: number | bigint | null;
    content: number | bigint;
    exchange_count: number | bigint;
    exchanges_stored: number | bigint;
    truncation: string | null;
    shared_at: number | bigint | null;
    bytes: number | bigint;
};

const SUMMARY_COLUMNS =
    "seq, id, job_id, source, mode, cha_id, chat_id, message_id, model_id, profile_id, profile_name, provider, " +
    "started_at, first_byte_at, completed_at, status, http_status, provider_code, error IS NOT NULL AS has_error, " +
    "request_bytes, response_bytes, content, exchange_count, exchanges_stored, truncation, shared_at, bytes";

function nullableNumber(value: number | bigint | null): number | null {
    return value === null ? null : Number(value);
}

function toSummary(row: SummaryRow): RequestHistorySummary {
    const status = STATUSES.includes(row.status as RequestHistoryStatus)
        ? (row.status as RequestHistoryStatus)
        : "interrupted";
    const exchangeCount = Number(row.exchange_count);
    const storedExchanges = Number(row.exchanges_stored);
    return {
        id: row.id,
        jobId: row.job_id,
        source: row.source,
        mode: row.mode,
        chaId: row.cha_id,
        chatId: row.chat_id,
        messageId: row.message_id,
        modelId: row.model_id,
        profileId: row.profile_id,
        profileName: row.profile_name,
        provider: row.provider,
        startedAt: Number(row.started_at),
        firstByteAt: nullableNumber(row.first_byte_at),
        completedAt: nullableNumber(row.completed_at),
        status,
        httpStatus: nullableNumber(row.http_status),
        providerCode: row.provider_code,
        hasError: Number(row.has_error) === 1,
        requestBytes: nullableNumber(row.request_bytes),
        responseBytes: nullableNumber(row.response_bytes),
        content: Number(row.content) === 1,
        exchangeCount,
        storedExchanges,
        truncated: row.truncation !== null || exchangeCount > storedExchanges,
        sharedAt: nullableNumber(row.shared_at),
        bytes: Number(row.bytes),
    };
}

function parseTruncation(text: string | null): RequestHistoryTruncation {
    if (text === null) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as RequestHistoryTruncation)
            : {};
    } catch {
        return {};
    }
}

function truncationText(truncation: RequestHistoryTruncation): string | null {
    return Object.keys(truncation).length === 0 ? null : JSON.stringify(truncation);
}

export function createRequestHistory(options: {
    file: string;
    maxBytes?: number;
    now?: () => number;
    /** The count cap, read at every prune (the `requestHistoryLimit` setting). */
    limit?: () => number;
}): RequestHistory {
    const maxBytes =
        Number.isSafeInteger(options.maxBytes) && options.maxBytes! > 0 ? options.maxBytes! : REQUEST_HISTORY_MAX_BYTES;
    const now = options.now ?? Date.now;
    const limitOf = options.limit ?? (() => REQUEST_HISTORY_DEFAULT_LIMIT);
    let db: DatabaseSync | null = null;
    let statements: ReturnType<typeof prepare> | null = null;
    let totalRows = 0;
    let totalBytes = 0;
    let warned = false;

    // Never throws: it runs in the catch blocks that keep the store from throwing.
    const warn = (error: unknown) => {
        if (warned) {
            return;
        }
        warned = true;
        let message = "unknown error";
        try {
            message = error instanceof Error ? String(error.message) : String(error);
        } catch {}
        try {
            console.warn("[RequestHistory] The request history failed; requests run without it:", message);
        } catch {}
    };

    function shutdown(): void {
        const open = db;
        db = null;
        statements = null;
        try {
            open?.close();
        } catch {}
    }

    /**
     * Runs `work` in one write transaction. A failed rollback leaves the connection in an unknown
     * state, so the store closes.
     */
    function transaction<T>(work: (s: NonNullable<typeof statements>) => T): T {
        const open = db!;
        open.exec("BEGIN IMMEDIATE");
        try {
            const result = work(statements!);
            open.exec("COMMIT");
            return result;
        } catch (error) {
            try {
                open.exec("ROLLBACK");
            } catch {
                shutdown();
            }
            throw error;
        }
    }

    /** Runs a public operation: inert without a database, and never throwing. */
    function guard<T>(fallback: T, work: () => T): T {
        if (!db || !statements) {
            return fallback;
        }
        try {
            return work();
        } catch (error) {
            warn(error);
            return fallback;
        }
    }

    function prepare(open: DatabaseSync) {
        return {
            insert: open.prepare(
                "INSERT INTO requests (id, job_id, source, mode, cha_id, chat_id, message_id, model_id, profile_id, profile_name, provider, " +
                    "started_at, status, content, prompt, truncation, bytes) " +
                    "VALUES (:id, :jobId, :source, :mode, :chaId, :chatId, :messageId, :modelId, :profileId, :profileName, :provider, " +
                    ":startedAt, 'pending', :content, :prompt, :truncation, :bytes) ON CONFLICT(id) DO NOTHING",
            ),
            row: open.prepare(
                "SELECT seq, status, content, exchange_count, exchanges_stored, truncation, bytes, " +
                    "model_id, profile_id, profile_name, provider, prompt IS NULL AS no_prompt FROM requests WHERE id = ?",
            ),
            describe: open.prepare(
                "UPDATE requests SET model_id = :modelId, profile_id = :profileId, profile_name = :profileName, provider = :provider, " +
                    "truncation = :truncation, bytes = :bytes WHERE seq = :seq",
            ),
            setPrompt: open.prepare("UPDATE requests SET prompt = ?, truncation = ?, bytes = ? WHERE seq = ?"),
            firstByte: open.prepare(
                "UPDATE requests SET first_byte_at = ? WHERE id = ? AND status = 'pending' AND first_byte_at IS NULL",
            ),
            insertExchange: open.prepare(
                "INSERT INTO exchanges (request_seq, idx, url, header, body, response, success, status, date, response_type) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
            countExchange: open.prepare(
                "UPDATE requests SET exchange_count = ?, exchanges_stored = ?, truncation = ?, bytes = ? WHERE seq = ?",
            ),
            finish: open.prepare(
                "UPDATE requests SET status = :status, completed_at = :completedAt, http_status = :httpStatus, " +
                    "provider_code = :providerCode, error = :error, request_bytes = :requestBytes, response_bytes = :responseBytes, " +
                    "truncation = :truncation, bytes = :bytes WHERE seq = :seq",
            ),
            list: open.prepare(
                `SELECT ${SUMMARY_COLUMNS} FROM requests WHERE (:cursor IS NULL OR seq < :cursor) ` +
                    "AND (:chaId IS NULL OR cha_id = :chaId) AND (:chatId IS NULL OR chat_id = :chatId) " +
                    "AND (:jobId IS NULL OR job_id = :jobId) AND (:status IS NULL OR status = :status) " +
                    "ORDER BY seq DESC LIMIT :limit",
            ),
            get: open.prepare(`SELECT ${SUMMARY_COLUMNS}, error, prompt FROM requests WHERE id = ?`),
            exchanges: open.prepare(
                "SELECT url, header, body, response, success, status, date, response_type FROM exchanges WHERE request_seq = ? ORDER BY idx",
            ),
            deleteAll: open.prepare("DELETE FROM requests"),
            share: open.prepare("UPDATE requests SET shared_at = ? WHERE id = ?"),
            oldest: open.prepare("SELECT seq, bytes FROM requests ORDER BY seq ASC LIMIT 64"),
            remove: open.prepare("DELETE FROM requests WHERE seq = ?"),
            totals: open.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM requests"),
        };
    }

    try {
        mkdirSync(path.dirname(options.file), { recursive: true });
        db = new DatabaseSync(options.file);
        const open = db;
        // A newer server's file is left as it is (no pragma that rewrites it), and this one runs
        // without a history. The check runs again inside the transaction below.
        const versionOf = () => {
            const meta = open.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'").get();
            return meta
                ? (open.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined)
                      ?.value
                : undefined;
        };
        const unsupported = (version: string | undefined) =>
            version !== undefined && version !== SCHEMA_VERSION
                ? new Error(`Unsupported request history version ${version}`)
                : null;
        const early = unsupported(versionOf());
        if (early) {
            throw early;
        }
        open.exec("PRAGMA journal_mode = WAL");
        open.exec("PRAGMA synchronous = NORMAL");
        // Outside a transaction: the pragma has no effect inside one.
        open.exec("PRAGMA foreign_keys = ON");
        open.exec("BEGIN IMMEDIATE");
        try {
            const late = unsupported(versionOf());
            if (late) {
                throw late;
            }
            open.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
            open.exec(
                "CREATE TABLE IF NOT EXISTS requests (" +
                    "seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT, source TEXT NOT NULL, mode TEXT NOT NULL, " +
                    "cha_id TEXT, chat_id TEXT, message_id TEXT, model_id TEXT, profile_id TEXT, profile_name TEXT, provider TEXT, " +
                    "started_at INTEGER NOT NULL, first_byte_at INTEGER, completed_at INTEGER, status TEXT NOT NULL, " +
                    "http_status INTEGER, provider_code TEXT, error TEXT, request_bytes INTEGER, response_bytes INTEGER, " +
                    "content INTEGER NOT NULL, prompt TEXT, exchange_count INTEGER NOT NULL DEFAULT 0, " +
                    "exchanges_stored INTEGER NOT NULL DEFAULT 0, truncation TEXT, shared_at INTEGER, bytes INTEGER NOT NULL)",
            );
            open.exec("CREATE INDEX IF NOT EXISTS requests_job ON requests (job_id, seq)");
            open.exec("CREATE INDEX IF NOT EXISTS requests_chat ON requests (cha_id, chat_id, seq)");
            open.exec(
                "CREATE TABLE IF NOT EXISTS exchanges (" +
                    "request_seq INTEGER NOT NULL REFERENCES requests (seq) ON DELETE CASCADE, idx INTEGER NOT NULL, " +
                    "url TEXT NOT NULL, header TEXT NOT NULL, body TEXT NOT NULL, response TEXT NOT NULL, " +
                    "success INTEGER NOT NULL, status INTEGER, date TEXT NOT NULL, response_type TEXT, " +
                    "PRIMARY KEY (request_seq, idx)) WITHOUT ROWID",
            );
            open.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('version', ?)").run(SCHEMA_VERSION);
            // The server stopped while these ran.
            open.exec("UPDATE requests SET status = 'interrupted' WHERE status = 'pending'");
            open.exec("COMMIT");
        } catch (error) {
            try {
                open.exec("ROLLBACK");
            } catch {}
            throw error;
        }
        statements = prepare(open);
        const totals = statements.totals.get() as { rows: number | bigint; bytes: number | bigint };
        totalRows = Number(totals.rows);
        totalBytes = Number(totals.bytes);
    } catch (error) {
        shutdown();
        warn(error);
    }

    /** A short field, bounded and its cut recorded under `name`. */
    function short(value: string | null | undefined, name: string, truncation: RequestHistoryTruncation) {
        if (value === null || value === undefined) {
            delete truncation[name];
            return null;
        }
        const bounded = bound(String(value), REQUEST_HISTORY_BOUNDS.short);
        if (bounded.cut) {
            truncation[name] = bounded.cut;
        } else {
            delete truncation[name];
        }
        return bounded.text;
    }

    /** An id: kept whole, or not stored (null, its cut recorded under `name`) when over the bound. */
    function identity(value: string | null | undefined, name: string, truncation: RequestHistoryTruncation) {
        delete truncation[name];
        if (value === null || value === undefined) {
            return null;
        }
        const text = String(value);
        const bytes = utf8(text);
        if (bytes > REQUEST_HISTORY_BOUNDS.identity) {
            truncation[name] = { originalBytes: bytes, storedBytes: 0 };
            return null;
        }
        return text;
    }

    /** Removes the oldest rows until both caps hold; the totals change only once it committed. */
    function pruneTo(limit: number): void {
        if (!db || (totalRows <= limit && totalBytes <= maxBytes)) {
            return;
        }
        const after = transaction((s) => {
            let rows = totalRows;
            let bytes = totalBytes;
            while (rows > limit || bytes > maxBytes) {
                const oldest = s.oldest.all() as { seq: number | bigint; bytes: number | bigint }[];
                if (oldest.length === 0) {
                    return { rows: 0, bytes: 0 };
                }
                for (const row of oldest) {
                    s.remove.run(row.seq);
                    rows--;
                    bytes -= Number(row.bytes);
                    if (rows <= limit && bytes <= maxBytes) {
                        break;
                    }
                }
            }
            return { rows, bytes };
        });
        totalRows = after.rows;
        totalBytes = after.bytes;
    }

    /** Prunes after a write, with its own failure: the write itself already committed. */
    function pruneAfterWrite(): void {
        try {
            pruneTo(clampRequestHistoryLimit(limitOf()));
        } catch (error) {
            warn(error);
        }
    }

    type StateRow = {
        seq: number | bigint;
        status: string;
        content: number | bigint;
        exchange_count: number | bigint;
        exchanges_stored: number | bigint;
        truncation: string | null;
        bytes: number | bigint;
        model_id: string | null;
        profile_id: string | null;
        profile_name: string | null;
        provider: string | null;
        no_prompt: number | bigint;
    };

    return {
        begin(summary) {
            const inserted = guard(false, () => {
                const id = String(summary.id);
                if (id === "" || Buffer.byteLength(id, "utf8") > REQUEST_HISTORY_BOUNDS.id) {
                    return false;
                }
                const truncation: RequestHistoryTruncation = {};
                const fields = {
                    jobId: identity(summary.jobId, "jobId", truncation),
                    source: short(summary.source, "source", truncation) ?? "",
                    mode: short(summary.mode, "mode", truncation) ?? "",
                    chaId: identity(summary.chaId, "chaId", truncation),
                    chatId: identity(summary.chatId, "chatId", truncation),
                    messageId: identity(summary.messageId, "messageId", truncation),
                    modelId: short(summary.modelId, "modelId", truncation),
                    profileId: identity(summary.profileId, "profileId", truncation),
                    profileName: short(summary.profileName, "profileName", truncation),
                    provider: short(summary.provider, "provider", truncation),
                };
                let prompt: string | null = null;
                if (summary.content && summary.prompt !== undefined) {
                    let json: string | undefined;
                    try {
                        json = JSON.stringify(summary.prompt);
                    } catch {
                        json = undefined;
                    }
                    if (json !== undefined) {
                        const bounded = bound(json, REQUEST_HISTORY_BOUNDS.prompt);
                        prompt = bounded.text;
                        if (bounded.cut) {
                            truncation.prompt = bounded.cut;
                        }
                    }
                }
                const truncationJson = truncationText(truncation);
                let bytes = REQUEST_HISTORY_ROW_OVERHEAD + utf8(id) + utf8(prompt) + utf8(truncationJson);
                for (const value of Object.values(fields)) {
                    bytes += utf8(value);
                }
                const startedAt = int(summary.startedAt) ?? int(now()) ?? 0;
                const changes = transaction(
                    (s) =>
                        s.insert.run({
                            id,
                            ...fields,
                            startedAt,
                            content: summary.content ? 1 : 0,
                            prompt,
                            truncation: truncationJson,
                            bytes,
                        }).changes,
                );
                if (Number(changes) !== 1) {
                    return false;
                }
                totalRows++;
                totalBytes += bytes;
                return true;
            });
            if (inserted) {
                pruneAfterWrite();
            }
        },
        setPrompt(id, text) {
            const added = guard(null as number | null, () =>
                transaction((s) => {
                    const row = s.row.get(id) as StateRow | undefined;
                    if (
                        !row ||
                        row.status !== "pending" ||
                        Number(row.content) !== 1 ||
                        Number(row.no_prompt) !== 1 ||
                        typeof text !== "string"
                    ) {
                        return null;
                    }
                    const truncation = parseTruncation(row.truncation);
                    const bounded = bound(text, REQUEST_HISTORY_BOUNDS.prompt);
                    if (bounded.cut) {
                        truncation.prompt = bounded.cut;
                    }
                    const truncationJson = truncationText(truncation);
                    const added = bounded.bytes + utf8(truncationJson) - utf8(row.truncation);
                    s.setPrompt.run(bounded.text, truncationJson, Number(row.bytes) + added, row.seq);
                    return added;
                }),
            );
            if (added !== null) {
                totalBytes += added;
                pruneAfterWrite();
            }
        },
        describe(id, model) {
            const changed = guard(false, () =>
                transaction((s) => {
                    const row = s.row.get(id) as StateRow | undefined;
                    if (!row || row.status !== "pending") {
                        return false;
                    }
                    const truncation = parseTruncation(row.truncation);
                    const previous = utf8(row.truncation);
                    const next = {
                        modelId:
                            model.modelId === undefined ? row.model_id : short(model.modelId, "modelId", truncation),
                        profileId:
                            model.profileId === undefined
                                ? row.profile_id
                                : identity(model.profileId, "profileId", truncation),
                        profileName:
                            model.profileName === undefined
                                ? row.profile_name
                                : short(model.profileName, "profileName", truncation),
                        provider:
                            model.provider === undefined ? row.provider : short(model.provider, "provider", truncation),
                    };
                    const truncationJson = truncationText(truncation);
                    const delta =
                        utf8(next.modelId) +
                        utf8(next.profileId) +
                        utf8(next.profileName) +
                        utf8(next.provider) +
                        utf8(truncationJson) -
                        (utf8(row.model_id) +
                            utf8(row.profile_id) +
                            utf8(row.profile_name) +
                            utf8(row.provider) +
                            previous);
                    s.describe.run({
                        ...next,
                        truncation: truncationJson,
                        bytes: Number(row.bytes) + delta,
                        seq: row.seq,
                    });
                    return delta;
                }),
            );
            if (typeof changed === "number") {
                totalBytes += changed;
                pruneAfterWrite();
            }
        },
        firstByte(id, at) {
            const changed = guard(false, () => {
                const time = int(at) ?? int(now());
                return time !== null && Number(statements!.firstByte.run(time, id).changes) > 0;
            });
            if (changed) {
                pruneAfterWrite();
            }
        },
        exchange(id, entry, cuts) {
            const added = guard(null as number | null, () =>
                transaction((s) => {
                    const row = s.row.get(id) as StateRow | undefined;
                    if (!row || Number(row.content) !== 1) {
                        return null;
                    }
                    const offered = Number(row.exchange_count) + 1;
                    let stored = Number(row.exchanges_stored);
                    let added = 0;
                    const truncation = parseTruncation(row.truncation);
                    if (stored < REQUEST_HISTORY_BOUNDS.exchanges) {
                        const index = stored;
                        const fields = {
                            url: bound(asText(entry.url), REQUEST_HISTORY_BOUNDS.url, int(cuts?.url) ?? undefined),
                            header: bound(
                                asText(entry.header),
                                REQUEST_HISTORY_BOUNDS.header,
                                int(cuts?.header) ?? undefined,
                            ),
                            body: bound(asText(entry.body), REQUEST_HISTORY_BOUNDS.body, int(cuts?.body) ?? undefined),
                            response: bound(
                                asText(entry.response),
                                REQUEST_HISTORY_BOUNDS.response,
                                int(cuts?.response) ?? undefined,
                            ),
                        };
                        const dateField = bound(asText(entry.date), REQUEST_HISTORY_BOUNDS.short);
                        const typeField =
                            entry.responseType === undefined || entry.responseType === null
                                ? null
                                : bound(asText(entry.responseType), REQUEST_HISTORY_BOUNDS.short);
                        const date = dateField.text;
                        const responseType = typeField?.text ?? null;
                        const cut: Record<string, Bounded> = { ...fields, date: dateField };
                        if (typeField) {
                            cut.responseType = typeField;
                        }
                        for (const [name, field] of Object.entries(cut)) {
                            if (field.cut) {
                                truncation[`exchange.${index}.${name}`] = field.cut;
                            }
                        }
                        s.insertExchange.run(
                            row.seq,
                            index,
                            fields.url.text,
                            fields.header.text,
                            fields.body.text,
                            fields.response.text,
                            entry.success ? 1 : 0,
                            int(entry.status),
                            date,
                            responseType,
                        );
                        stored++;
                        added =
                            REQUEST_HISTORY_EXCHANGE_OVERHEAD +
                            fields.url.bytes +
                            fields.header.bytes +
                            fields.body.bytes +
                            fields.response.bytes +
                            utf8(date) +
                            utf8(responseType);
                    }
                    const truncationJson = truncationText(truncation);
                    added += utf8(truncationJson) - utf8(row.truncation);
                    s.countExchange.run(offered, stored, truncationJson, Number(row.bytes) + added, row.seq);
                    return added;
                }),
            );
            if (added !== null) {
                totalBytes += added;
                pruneAfterWrite();
            }
        },
        finish(id, outcome) {
            const added = guard(null as number | null, () => {
                if (!END_STATUSES.includes(outcome.status)) {
                    return null;
                }
                return transaction((s) => {
                    const row = s.row.get(id) as StateRow | undefined;
                    if (!row || row.status !== "pending") {
                        return null;
                    }
                    const truncation = parseTruncation(row.truncation);
                    const providerCode = short(outcome.providerCode, "providerCode", truncation);
                    let error: string | null = null;
                    if (outcome.error !== undefined && outcome.error !== null) {
                        const bounded = bound(asText(outcome.error), REQUEST_HISTORY_BOUNDS.error);
                        error = bounded.text;
                        if (bounded.cut) {
                            truncation.error = bounded.cut;
                        }
                    }
                    const truncationJson = truncationText(truncation);
                    const added = utf8(providerCode) + utf8(error) + utf8(truncationJson) - utf8(row.truncation);
                    s.finish.run({
                        status: outcome.status,
                        completedAt: int(outcome.completedAt) ?? int(now()),
                        httpStatus: int(outcome.httpStatus),
                        providerCode,
                        error,
                        requestBytes: size(outcome.requestBytes),
                        responseBytes: size(outcome.responseBytes),
                        truncation: truncationJson,
                        bytes: Number(row.bytes) + added,
                        seq: row.seq,
                    });
                    return added;
                });
            });
            if (added !== null) {
                totalBytes += added;
                pruneAfterWrite();
            }
        },
        list(query = {}) {
            return guard({ items: [], next: null }, () => {
                const pageSize = Math.min(LIST_MAX, Math.max(1, int(query.limit) ?? LIST_DEFAULT));
                let cursor: number | null = null;
                if (typeof query.cursor === "string" && /^[1-9][0-9]{0,15}$/.test(query.cursor)) {
                    const value = Number(query.cursor);
                    if (Number.isSafeInteger(value)) {
                        cursor = value;
                    }
                }
                const rows = statements!.list.all({
                    cursor,
                    chaId: query.chaId ?? null,
                    chatId: query.chatId ?? null,
                    jobId: query.jobId ?? null,
                    status: query.status ?? null,
                    limit: pageSize + 1,
                }) as SummaryRow[];
                const more = rows.length > pageSize;
                const page = more ? rows.slice(0, pageSize) : rows;
                return {
                    items: page.map(toSummary),
                    next: more ? String(page[page.length - 1].seq) : null,
                };
            });
        },
        get(id) {
            return guard(null, () => {
                const row = statements!.get.get(id) as
                    (SummaryRow & { error: string | null; prompt: string | null }) | undefined;
                if (!row) {
                    return null;
                }
                const summary = toSummary(row);
                const exchanges = summary.content
                    ? (
                          statements!.exchanges.all(row.seq) as {
                              url: string;
                              header: string;
                              body: string;
                              response: string;
                              success: number | bigint;
                              status: number | bigint | null;
                              date: string;
                              response_type: string | null;
                          }[]
                      ).map((exchange) => ({
                          url: exchange.url,
                          header: exchange.header,
                          body: exchange.body,
                          response: exchange.response,
                          success: Number(exchange.success) === 1,
                          status: nullableNumber(exchange.status),
                          date: exchange.date,
                          responseType: exchange.response_type,
                      }))
                    : null;
                return {
                    ...summary,
                    error: row.error,
                    prompt: summary.content ? row.prompt : null,
                    exchanges,
                    truncation: parseTruncation(row.truncation),
                };
            });
        },
        deleteAll() {
            return guard<number | null>(null, () => {
                // The sequence is not reset: a cursor from before stays past every new row.
                const changes = Number(transaction((s) => s.deleteAll.run().changes));
                totalRows = 0;
                totalBytes = 0;
                return changes;
            });
        },
        setShared(ids, at) {
            const changed = guard(0, () => {
                const time = at === null ? null : int(at);
                if (at !== null && time === null) {
                    return 0;
                }
                return transaction((s) => {
                    let changed = 0;
                    for (const id of new Set(ids)) {
                        changed += Number(s.share.run(time, id).changes);
                    }
                    return changed;
                });
            });
            if (changed > 0) {
                pruneAfterWrite();
            }
            return changed;
        },
        prune(limit) {
            guard(undefined, () => pruneTo(clampRequestHistoryLimit(limit ?? limitOf())));
        },
        stats() {
            return guard({ rows: 0, bytes: 0 }, () => ({ rows: totalRows, bytes: totalBytes }));
        },
        available() {
            return db !== null && statements !== null;
        },
        close() {
            shutdown();
        },
    };
}
