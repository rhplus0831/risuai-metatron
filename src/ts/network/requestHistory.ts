import {
    REQUEST_HISTORY_PATH,
    REQUEST_HISTORY_SHARE_PATH,
    REQUEST_HISTORY_SHARES_PATH,
    type RequestHistoryPage,
    type RequestHistoryRecord,
    type RequestHistoryShareBody,
    type RequestHistoryShareList,
    type RequestHistoryShareResult,
    type RequestHistoryStatus,
} from "../../../shared/requestHistory.ts";
import { authFetch } from "../storage/serverAuth";

/**
 * The server's LLM request history: the viewer's reads, its "Delete all", and sharing for support.
 * Each call throws `RequestHistoryError` for an answer that is not a success, with the server's
 * message when it sent one.
 */

export type RequestHistoryQuery = {
    cursor?: string | null;
    limit?: number;
    chaId?: string | null;
    chatId?: string | null;
    jobId?: string | null;
    status?: RequestHistoryStatus | null;
};

export class RequestHistoryError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "RequestHistoryError";
    }
}

async function failure(response: Response): Promise<RequestHistoryError> {
    let message = `HTTP ${response.status}`;
    try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body?.error === "string" && body.error !== "") {
            message = body.error;
        }
    } catch {}
    return new RequestHistoryError(message, response.status);
}

/** A page of summaries, newest first. */
export async function listRequestHistory(query: RequestHistoryQuery = {}): Promise<RequestHistoryPage> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
            params.set(name, String(value));
        }
    }
    const search = params.toString();
    const response = await authFetch(search ? `${REQUEST_HISTORY_PATH}?${search}` : REQUEST_HISTORY_PATH, {
        cache: "no-store",
    });
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as RequestHistoryPage;
}

/** One request with its content, or null when the history no longer has it. */
export async function readRequestHistory(id: string): Promise<RequestHistoryRecord | null> {
    const response = await authFetch(`${REQUEST_HISTORY_PATH}/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as RequestHistoryRecord;
}

/** Removes every request of the history. */
export async function deleteRequestHistory(): Promise<void> {
    const response = await authFetch(REQUEST_HISTORY_PATH, { method: "DELETE" });
    if (!response.ok) {
        throw await failure(response);
    }
}

/** Shares a job's requests to the server's diagnostics folder, or withdraws the share. */
export async function shareRequestHistory(body: RequestHistoryShareBody): Promise<RequestHistoryShareResult> {
    const response = await authFetch(REQUEST_HISTORY_SHARE_PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as RequestHistoryShareResult;
}

/** The shares the diagnostics folder holds, newest first. */
export async function listRequestHistoryShares(): Promise<RequestHistoryShareList> {
    const response = await authFetch(REQUEST_HISTORY_SHARES_PATH, { cache: "no-store" });
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as RequestHistoryShareList;
}
