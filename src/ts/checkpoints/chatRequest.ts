import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { isChatGenerating, type ChatRef } from "../storage/chatStore.svelte";
import { readWithDeadline } from "../storage/readDeadline";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { waitForResourceFlush } from "../storage/resourceFlushWait";
import {
    assertSaveAdmission,
    flushResources,
    GenerationBlockedError,
    generatingNoticeCount,
    refusedItems,
} from "../storage/resourceSync.svelte";
import { authFetch, ensureAuth } from "../storage/serverAuth";

export type Answer =
    | { kind: "response"; status: number; body: Record<string, unknown> | null }
    | { kind: "failed"; dispatched: boolean };

/**
 * Checkpoints opt into a 30 s deadline for fetch and JSON after sign-in. A timeout is a transport
 * failure with the current dispatch flag, except that received 200 headers yield a null body.
 * The dispatch flag distinguishes admission failures. Epoch changes found in the body throw to the caller.
 */
export async function request(
    url: string,
    body?: Record<string, unknown>,
    {
        method = "POST",
        beforeDispatch,
        deadlineMs,
    }: { method?: string; beforeDispatch?: () => void; deadlineMs?: number } = {},
): Promise<Answer> {
    let dispatched = body === undefined;
    let received200 = false;
    let answer: { status: number; parsed: unknown };
    try {
        const init: RequestInit =
            body === undefined
                ? { cache: "no-store" }
                : {
                      method,
                      cache: "no-store",
                      headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
                      body: JSON.stringify(body),
                  };
        const read = async (signal?: AbortSignal) => {
            const response = await authFetch(
                url,
                signal ? { ...init, signal } : init,
                body === undefined
                    ? {}
                    : {
                          beforeDispatch: () => {
                              assertSaveAdmission();
                              beforeDispatch?.();
                              dispatched = true;
                          },
                      },
            );
            signal?.throwIfAborted();
            const { status } = response;
            received200 = status === 200;
            let parsed: unknown = null;
            try {
                parsed = await response.json();
            } catch {
                // A 200 load is committed even if its response body cannot be read.
            }
            return { status, parsed };
        };
        if (deadlineMs !== undefined) await ensureAuth();
        answer =
            deadlineMs === undefined
                ? await read()
                : await readWithDeadline(deadlineMs, "The checkpoint request timed out", read);
    } catch {
        if (received200) return { kind: "response", status: 200, body: null };
        return { kind: "failed", dispatched };
    }
    const { status, parsed } = answer;
    const result = isPlainObject(parsed) ? parsed : null;
    if (status === 412 && result?.error === "EpochMismatch" && typeof result.epoch === "string") {
        throw epochMismatch(result.epoch);
    }
    const epoch = getResourceEpoch();
    if (epoch && typeof result?.epoch === "string" && result.epoch !== epoch) {
        throw epochMismatch(result.epoch);
    }
    return { kind: "response", status, body: result };
}

export type PreparationFailure = {
    status: "not-sent";
    reason: "generating" | "refused" | "saveFailed" | "discarded";
    noticeShown?: boolean;
};

function localRefusal(ref: ChatRef): PreparationFailure | null {
    if (isChatGenerating(ref)) return { status: "not-sent", reason: "generating" };
    if (
        refusedItems().some(
            (item) =>
                (item.kind === "chat" && item.chaId === ref.chaId && item.chatId === ref.chatId) ||
                (item.kind === "order" && item.chaId === ref.chaId),
        )
    ) {
        return { status: "not-sent", reason: "refused" };
    }
    return null;
}

export async function prepare(ref: ChatRef): Promise<PreparationFailure | null> {
    const refused = localRefusal(ref);
    if (refused) return refused;
    const notices = generatingNoticeCount();
    try {
        const { discarded } = await waitForResourceFlush(flushResources());
        if (discarded.includes(`chats/${ref.chaId}/${ref.chatId}`) || discarded.includes(`chats/${ref.chaId}`)) {
            return { status: "not-sent", reason: "discarded" };
        }
    } catch (error) {
        return error instanceof GenerationBlockedError
            ? { status: "not-sent", reason: "generating", noticeShown: generatingNoticeCount() !== notices }
            : { status: "not-sent", reason: "saveFailed" };
    }
    return localRefusal(ref);
}
