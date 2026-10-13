/**
 * The LLM request history's wire shapes (`docs/plan/request-history-diagnostics.md`): what the
 * server's store (`server/src/data/requestHistory.ts`) answers and its routes
 * (`server/src/routes/requestHistory.ts`) send to the app's viewer.
 */

export const REQUEST_HISTORY_PATH = "/api/request-history";

export const REQUEST_HISTORY_STATUSES = ["pending", "success", "error", "aborted", "interrupted"] as const;

export type RequestHistoryStatus = (typeof REQUEST_HISTORY_STATUSES)[number];

/**
 * A provider's error code (OpenAI `error.code`, Anthropic `error.type`, Google `error.status`): the
 * only provider text a content-free record may carry (decision 9).
 */
export const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function isProviderCode(value: unknown): value is string {
    return typeof value === "string" && PROVIDER_CODE_PATTERN.test(value);
}

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

/** `GET /api/request-history`: a page of summaries, newest first. */
export type RequestHistoryPage = {
    items: RequestHistorySummary[];
    /** The cursor of the next page, null on the last. */
    next: string | null;
};
