import type { RequestHistory } from "../data/requestHistory.ts";
import type { RequestObserver } from "./requests.ts";

/**
 * The request layer's observer that writes the request history (`docs/plan/request-history-diagnostics.md`
 * slice 3): a row at admission, its prompt and model, every exchange, the first byte, and its end
 * with the error text, the last exchange's HTTP status, and the bytes sent and received (counted
 * before any redaction or cut, also when content is off). `content` is read at admission: with it
 * off, the store keeps a summary row (no prompt, no exchanges).
 *
 * What the layer hands over is already redacted. The per-request totals live only while the
 * request does: they are dropped at its end, so a late exchange (a body flushed after the end)
 * reaches the store but not the totals.
 */
export function createHistoryObserver(history: RequestHistory, options: { content: () => boolean }): RequestObserver {
    const totals = new Map<string, { requestBytes: number; responseBytes: number; httpStatus: number | null }>();
    return {
        begin(request) {
            totals.set(request.requestId, { requestBytes: 0, responseBytes: 0, httpStatus: null });
            history.begin({
                id: request.requestId,
                jobId: request.jobId,
                source: request.source,
                mode: request.mode,
                chaId: request.chatRef?.chaId ?? null,
                chatId: request.chatRef?.chatId ?? null,
                messageId: request.messageId,
                startedAt: request.startedAt,
                content: options.content(),
            });
        },
        prompt(requestId, text) {
            history.setPrompt(requestId, text);
        },
        describe(requestId, model) {
            history.describe(requestId, model);
        },
        firstByte(requestId, at) {
            history.firstByte(requestId, at);
        },
        exchange(requestId, entry, detail) {
            const total = totals.get(requestId);
            if (total) {
                total.requestBytes += detail.requestBytes;
                total.responseBytes += detail.responseBytes ?? 0;
                // The last exchange's status: none when it got no answer.
                total.httpStatus = typeof entry.status === "number" ? entry.status : null;
            }
            history.exchange(requestId, entry, detail.cuts);
        },
        finish(requestId, end, detail) {
            const total = totals.get(requestId);
            totals.delete(requestId);
            history.finish(requestId, {
                status: end.status,
                completedAt: end.completedAt,
                error: detail?.error ?? null,
                httpStatus: total?.httpStatus ?? null,
                requestBytes: total?.requestBytes ?? null,
                responseBytes: total?.responseBytes ?? null,
            });
        },
    };
}
