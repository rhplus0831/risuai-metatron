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

/**
 * `PUT`: shares a job's requests to the diagnostics folder for support, or withdraws the share
 * (`docs/plan/request-history-diagnostics.md` slice 10). Body: `RequestHistoryShareBody`.
 */
export const REQUEST_HISTORY_SHARE_PATH = "/api/request-history/share";

/** `GET`: the shares the folder holds (`RequestHistoryShareList`), kept even when their rows are gone. */
export const REQUEST_HISTORY_SHARES_PATH = "/api/request-history/shares";

const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A request id the server issues (`randomUUID`). */
export const SHARE_REQUEST_ID = new RegExp(`^${UUID_TEXT}$`);

/** A job id the server issues: a generation job's `randomUUID`, or a translation run's `translate-<UUID>`. */
export const SHARE_JOB_ID = new RegExp(`^(?:translate-)?${UUID_TEXT}$`);

/**
 * What a share is of: a job (every request of it), or a request that ran without a job (a tab's own
 * request), shared alone.
 */
export type RequestHistoryShareTarget = { jobId: string; requestId: null } | { jobId: null; requestId: string };

/**
 * A share or a withdrawal. A `requestId` whose row has a job stands for that job (decision 4); a
 * withdrawal of a request whose row is gone withdraws that request's own share.
 */
export type RequestHistoryShareBody =
    | { jobId: string; requestId?: undefined; shared: boolean }
    | { requestId: string; jobId?: undefined; shared: boolean };

export type RequestHistoryShareResult = RequestHistoryShareTarget & {
    shared: boolean;
    /** The share's time, null after a withdrawal. */
    sharedAt: number | null;
    /** The rows marked (a share: every row in the shared copy) or unmarked (a withdrawal). */
    ids: string[];
};

export type RequestHistoryShareEntry = RequestHistoryShareTarget & { sharedAt: number };

/** `GET /api/request-history/shares`: newest first. */
export type RequestHistoryShareList = { items: RequestHistoryShareEntry[] };
