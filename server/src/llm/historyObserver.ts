import { diagnosticModel } from "../../../shared/diagnostics.ts";
import type { RequestHistory } from "../data/requestHistory.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";
import type { RequestObserver } from "./requests.ts";

/**
 * The request layer's observer that writes the request history (`docs/plan/request-history-diagnostics.md`
 * slice 3): a row at admission, its prompt and model, every exchange, the first byte, and its end
 * with the error text, the provider's error code, the last exchange's HTTP status, and the bytes sent and received (counted
 * before any redaction or cut, also when content is off). `content` is read at admission: with it
 * off, the store keeps a summary row (no prompt, no exchanges). A `content` that throws counts as
 * off, so the row is still written.
 *
 * What the layer hands over is already redacted. The per-request totals live only while the
 * request does: they are dropped at its end, so a late exchange (a body flushed after the end)
 * reaches the store but not the totals.
 *
 * With `diagnostics`, every end is also a content-free `request` event (slice 7): its ids, source,
 * outcome, provider (the `LLMFormat` name), model (a catalog id, else `custom`: `diagnosticModel`),
 * the last HTTP status, the provider code, its duration, and its bytes.
 */
export function createHistoryObserver(
    history: RequestHistory,
    options: { content: () => boolean; diagnostics?: DiagnosticsRecorder },
): RequestObserver {
    type Live = {
        requestBytes: number;
        responseBytes: number;
        httpStatus: number | null;
        jobId: string | null;
        source: string;
        startedAt: number;
        modelId: string | null;
        provider: string | null;
    };
    const totals = new Map<string, Live>();
    return {
        begin(request) {
            totals.set(request.requestId, {
                requestBytes: 0,
                responseBytes: 0,
                httpStatus: null,
                jobId: request.jobId,
                source: request.source,
                startedAt: request.startedAt,
                modelId: null,
                provider: null,
            });
            let content = false;
            try {
                content = options.content();
            } catch (error) {
                console.warn("[RequestHistory] Could not read the content setting:", error);
            }
            history.begin({
                id: request.requestId,
                jobId: request.jobId,
                source: request.source,
                mode: request.mode,
                chaId: request.chatRef?.chaId ?? null,
                chatId: request.chatRef?.chatId ?? null,
                messageId: request.messageId,
                startedAt: request.startedAt,
                content,
            });
        },
        prompt(requestId, text) {
            history.setPrompt(requestId, text);
        },
        describe(requestId, model) {
            const total = totals.get(requestId);
            if (total) {
                total.modelId = model.modelId;
                total.provider = model.provider;
            }
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
                providerCode: detail?.providerCode ?? null,
                httpStatus: total?.httpStatus ?? null,
                requestBytes: total?.requestBytes ?? null,
                responseBytes: total?.responseBytes ?? null,
            });
            recordSafely(options.diagnostics, {
                kind: "request",
                requestId,
                jobId: total?.jobId,
                source: total?.source,
                status: end.status,
                provider: total?.provider,
                model: diagnosticModel(total?.modelId),
                httpStatus: total?.httpStatus,
                providerCode: detail?.providerCode,
                durationMs: total ? Math.max(0, end.completedAt - total.startedAt) : undefined,
                requestBytes: total?.requestBytes,
                responseBytes: total?.responseBytes,
            });
        },
    };
}
