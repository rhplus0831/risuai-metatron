import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { isChatGenerating, type ChatRef } from "../storage/chatStore.svelte";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { waitForResourceFlush } from "../storage/resourceFlushWait";
import {
    assertSaveAdmission,
    flushResources,
    GenerationBlockedError,
    generatingNoticeCount,
    refusedItems,
} from "../storage/resourceSync.svelte";
import { authFetch } from "../storage/serverAuth";

export type Answer =
    | { kind: "response"; status: number; body: Record<string, unknown> | null }
    | { kind: "failed"; dispatched: boolean };

/** Transport failures stay distinct from admission failures; epoch changes always throw to the caller. */
export async function request(
    url: string,
    body?: Record<string, unknown>,
    method = "POST",
    beforeDispatch?: () => void,
): Promise<Answer> {
    let dispatched = body === undefined;
    let response: Response;
    try {
        response = await authFetch(
            url,
            body === undefined
                ? { cache: "no-store" }
                : {
                      method,
                      cache: "no-store",
                      headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
                      body: JSON.stringify(body),
                  },
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
    } catch {
        return { kind: "failed", dispatched };
    }
    let parsed: unknown = null;
    try {
        parsed = await response.json();
    } catch {
        // A 200 load is committed even if its response body cannot be read.
    }
    const result = isPlainObject(parsed) ? parsed : null;
    if (response.status === 412 && result?.error === "EpochMismatch" && typeof result.epoch === "string") {
        throw epochMismatch(result.epoch);
    }
    const epoch = getResourceEpoch();
    if (epoch && typeof result?.epoch === "string" && result.epoch !== epoch) {
        throw epochMismatch(result.epoch);
    }
    return { kind: "response", status: response.status, body: result };
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
