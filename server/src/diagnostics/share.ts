import type { DiagnosticEvent } from "../../../shared/diagnostics.ts";
import type {
    RequestHistoryRecord,
    RequestHistoryShareEntry,
    RequestHistoryShareResult,
    RequestHistoryShareTarget,
} from "../../../shared/requestHistory.ts";
import type { RequestHistory, RequestHistoryShareQuery } from "../data/requestHistory.ts";
import { createRedactor, redactHeaderText, type Redactor } from "../llm/redact.ts";
import type { DiagnosticsJournal } from "./journal.ts";

/** The most stored bytes (the rows' `bytes`) one share may hold; a larger job is refused, never cut. */
export const SHARE_MAX_BYTES = 32 * 1024 * 1024;

/** The first field of a shared copy, so a reader knows what the file is. */
export const SHARE_FORMAT = "metatron-request-share";

export type ShareOutcome =
    { ok: true; result: RequestHistoryShareResult } | { ok: false; status: 404 | 413 | 500 | 503; error: string };

export type RequestShares = {
    share(query: RequestHistoryShareQuery): ShareOutcome;
    withdraw(query: RequestHistoryShareQuery): ShareOutcome;
    /** The shares the folder holds, newest first; null when `shared/` could not be read. */
    list(): RequestHistoryShareEntry[] | null;
    /** Removes every shared copy (before a "Delete all"); whether every one is gone. */
    removeAll(): boolean;
};

/**
 * Sharing for support (`docs/plan/request-history-diagnostics.md` decisions 3 and 4, slice 10): a
 * job's requests, with their content, as one file in the diagnostics folder's `shared/`, which the
 * developer pulls over sftp. A share is a snapshot: requests the job makes later, and rows the caps
 * already removed, are not in it; sharing again replaces it.
 *
 * - The copy: `{ format, version: 1, sharedAt, app: { version }, jobId, requestId, failure, eventsPartial,
 *   events, requests }`. `requests` are the rows oldest first, each built field by field: a row
 *   stored with content off is its summary only (no error text, prompt, or exchanges). `events` are
 *   the journal's server events of the job (its `jobId`) or of its requests (`requestId`), and
 *   `failure` the fields of the last `job` error among them (a translation run has no `job` events).
 * - Redaction, a second time: every string of the copy goes through a redactor built now from every
 *   LLM credential the store holds (`secrets`), the named header values of an exchange's header are
 *   masked first, and every captured response and every field the row records as cut lose a trailing
 *   start of a credential (`trimPartial`: a capture cut short could have split one). This repeats
 *   the capture's protection with today's credentials: a credential no longer stored, a transient
 *   token that expired, or a value the redactor does not recognize (another encoding, a free-form
 *   header that is not a stored credential) is not caught here either. When the credentials cannot
 *   be read, nothing is shared.
 * - Order: the copy is written as a new file beside the older ones, then the rows are marked
 *   (`sharedAt`); only then are the older copies removed. A mark that fails removes the new copy, so
 *   the files and the marks agree as they did before. Failed removal of an older copy keeps the new
 *   copy and marks but answers an error. A withdrawal removes the files first (they are
 *   what the developer can read), then clears the marks.
 * - Everything is synchronous (`SHARE_MAX_BYTES` bounds the work), so two shares never interleave.
 */
export function createRequestShares(options: {
    history: RequestHistory;
    journal: DiagnosticsJournal;
    /** Every stored LLM credential (`loadStoredSecrets`); throws when they cannot be read. */
    secrets: () => string[];
    now?: () => number;
}): RequestShares {
    const { history, journal, secrets } = options;
    const now = options.now ?? Date.now;
    const failed = (status: 404 | 413 | 500 | 503, error: string): ShareOutcome => ({ ok: false, status, error });
    const unavailable = () => failed(503, "The request history is unavailable");

    function share(query: RequestHistoryShareQuery): ShareOutcome {
        let redactor: Redactor;
        try {
            redactor = createRedactor(secrets());
        } catch {
            return failed(500, "The stored credentials could not be read, so nothing was shared");
        }
        const read = history.readShare(query, SHARE_MAX_BYTES);
        switch (read.status) {
            case "missing":
                return failed(404, "No such request");
            case "tooLarge":
                return failed(
                    413,
                    `These requests are too large to share (${(read.bytes / 1024 / 1024).toFixed(1)} MiB stored, at most ${SHARE_MAX_BYTES / 1024 / 1024} MiB)`,
                );
            case "failed":
                return history.available()
                    ? failed(500, "The request history could not be read, so nothing was shared")
                    : unavailable();
        }
        const { target, records } = read;
        const ids = records.map((record) => record.id);
        const from = Math.min(...records.map((record) => record.startedAt));
        const own = new Set(ids);
        const { events, partial } = journal.eventsFor(
            (event) =>
                (target.jobId !== null && event.jobId === target.jobId) ||
                (typeof event.requestId === "string" && own.has(event.requestId)),
            from,
        );
        const at = now();
        const app = { version: journal.state().app.version };
        const saved = journal.saveShare(
            target,
            shareChunks({ target, records, events, partial, at, app, redactor }),
            at,
        );
        if (!saved.ok) {
            return failed(500, "The shared copy could not be written");
        }
        if (history.setShared(ids, at) !== own.size) {
            const removed = journal.discardShare(saved.name);
            return failed(
                500,
                removed
                    ? "The share could not be recorded, so its copy was removed"
                    : "The share could not be recorded, and its copy could not be removed: withdraw it again",
            );
        }
        // An older copy that cannot be removed now stays as part of this share: a withdrawal removes it.
        if (!journal.commitShare(target, saved.name)) {
            return failed(
                500,
                "The share was updated, but an older copy could not be removed. Withdraw the share to remove every copy.",
            );
        }
        return { ok: true, result: { ...target, shared: true, sharedAt: at, ids } };
    }

    function withdraw(query: RequestHistoryShareQuery): ShareOutcome {
        const target: RequestHistoryShareTarget | null =
            "jobId" in query ? { jobId: query.jobId, requestId: null } : history.shareTargetOf(query.requestId);
        if (!target) {
            return history.available()
                ? failed(500, "The request history could not be read, so nothing was withdrawn")
                : unavailable();
        }
        if (!journal.removeShares(target)) {
            return failed(500, "The shared copy could not be removed");
        }
        const ids = history.clearShared(target);
        if (ids === null) {
            return failed(500, "The shared copy was removed, but the request history could not be updated");
        }
        return { ok: true, result: { ...target, shared: false, sharedAt: null, ids } };
    }

    return { share, withdraw, list: () => journal.listShares(), removeAll: () => journal.removeAllShares() };
}

/** The copy's text, a row at a time (each redacted as it is written). */
function* shareChunks(arg: {
    target: RequestHistoryShareTarget;
    records: RequestHistoryRecord[];
    events: DiagnosticEvent[];
    partial: boolean;
    at: number;
    app: { version: string | null };
    redactor: Redactor;
}): Generator<string> {
    const { target, records, events, partial, at, app, redactor } = arg;
    let failure: Record<string, unknown> | null = null;
    for (const event of events) {
        if (event.kind === "job" && event.phase === "error") {
            failure = {};
            for (const field of ["stage", "reason", "status", "requestId", "providerCode"]) {
                if (event[field] !== undefined) {
                    failure[field] = event[field];
                }
            }
        }
    }
    const head = redactor.apply({
        format: SHARE_FORMAT,
        version: 1,
        sharedAt: new Date(at).toISOString(),
        app,
        jobId: target.jobId,
        requestId: target.requestId,
        failure,
        eventsPartial: partial,
        events,
    });
    const text = JSON.stringify(head);
    // `{...}` without its closing brace, then the rows.
    yield `${text.slice(0, -1)},"requests":[`;
    for (let i = 0; i < records.length; i++) {
        yield `${i > 0 ? "," : ""}${JSON.stringify(sharedRecord(records[i], redactor))}`;
    }
    yield "]}\n";
}

/** A row as a shared copy holds it: built field by field, every string redacted again. */
function sharedRecord(record: RequestHistoryRecord, redactor: Redactor): Record<string, unknown> {
    const trimFields = <T extends Record<string, unknown>>(fields: T, prefix = ""): T =>
        Object.fromEntries(
            Object.entries(fields).map(([name, value]) => [
                name,
                typeof value === "string" && Object.hasOwn(record.truncation, `${prefix}${name}`)
                    ? redactor.trimPartial(value)
                    : value,
            ]),
        ) as T;
    const summary = {
        id: record.id,
        jobId: record.jobId,
        source: record.source,
        mode: record.mode,
        chaId: record.chaId,
        chatId: record.chatId,
        messageId: record.messageId,
        modelId: record.modelId,
        profileId: record.profileId,
        profileName: record.profileName,
        provider: record.provider,
        startedAt: record.startedAt,
        firstByteAt: record.firstByteAt,
        completedAt: record.completedAt,
        status: record.status,
        httpStatus: record.httpStatus,
        providerCode: record.providerCode,
        hasError: record.hasError,
        requestBytes: record.requestBytes,
        responseBytes: record.responseBytes,
        content: record.content,
        exchangeCount: record.exchangeCount,
        storedExchanges: record.storedExchanges,
        truncated: record.truncated,
    };
    if (!record.content) {
        return trimFields(redactor.apply(summary));
    }
    const full = redactor.apply({
        ...summary,
        error: record.error,
        prompt: record.prompt,
        truncation: record.truncation,
        exchanges: (record.exchanges ?? []).map((exchange) => ({
            url: exchange.url,
            header: redactHeaderText(exchange.header),
            body: exchange.body,
            response: exchange.response,
            success: exchange.success,
            status: exchange.status,
            date: exchange.date,
            responseType: exchange.responseType,
        })),
    });
    return {
        ...trimFields(full),
        exchanges: full.exchanges.map((exchange, index) => ({
            ...trimFields(exchange, `exchange.${index}.`),
            // Any capture may have ended early (an abort, a read error), not only one the bound cut.
            response: exchange.response === null ? null : redactor.trimPartial(exchange.response),
        })),
    };
}
