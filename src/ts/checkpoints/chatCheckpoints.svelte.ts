import { get, writable } from "svelte/store";
import {
    MAX_AUTO_EVERY,
    MAX_AUTO_KEEP,
    MIN_AUTO_EVERY,
    MIN_AUTO_KEEP,
    type CheckpointPolicy,
    type CheckpointSummary,
} from "../../../shared/chatCheckpoints.ts";
import { compareRevision, RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { heldChatRevision, isChatGenerating, loadChat, type ChatRef } from "../storage/chatStore.svelte";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import {
    assertSaveAdmission,
    flushResources,
    GenerationBlockedError,
    generatingNoticeCount,
    refusedItems,
} from "../storage/resourceSync.svelte";
import { authFetch } from "../storage/serverAuth";

export const chatCheckpointsDialog = writable<ChatRef | null>(null);
const loading = writable(false);
/** Shared modal guard, held from before the flush until the load's refresh finishes. */
export const checkpointLoadBusy = { subscribe: loading.subscribe };

export type CheckpointFailure = {
    /** `not-sent` guarantees that no checkpoint mutation was dispatched. */
    status: "not-sent" | "error";
    reason:
        | "generating"
        | "refused"
        | "saveFailed"
        | "discarded"
        | "unsaved"
        | "admission"
        | "busy"
        | "missing"
        | "invalid"
        | "conflict"
        | "maintenance"
        | "tooLarge"
        | "request";
    /** The flush already showed the generation notice; the caller must not show it again. */
    noticeShown?: boolean;
};

export type CheckpointResult<T = object> = ({ status: "ok" } & T) | CheckpointFailure;
export type CheckpointPolicyResult =
    { status: "available"; policy: CheckpointPolicy | null } | { status: "unavailable" };
export type CheckpointLoadResult =
    | { status: "loaded"; chatRevision: string; safety: CheckpointSummary | null }
    | { status: "refresh-pending"; chatRevision: string | null; safety: CheckpointSummary | null }
    | { status: "unknown" }
    | CheckpointFailure;

type Answer =
    | { kind: "response"; status: number; body: Record<string, unknown> | null }
    | { kind: "failed"; dispatched: boolean };

const path = "/api/chat-checkpoints";
const address = (ref: ChatRef) => ({ characterId: ref.chaId, chatId: ref.chatId });

/** Transport failures stay distinct from admission failures; epoch changes always throw to the caller. */
async function request(url: string, body?: Record<string, unknown>, method = "POST"): Promise<Answer> {
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

function failure(answer: Answer): CheckpointFailure {
    if (answer.kind === "failed") {
        return answer.dispatched ? { status: "error", reason: "request" } : { status: "not-sent", reason: "admission" };
    }
    const reason =
        answer.status === 409
            ? answer.body?.reason === "generating"
                ? "generating"
                : "conflict"
            : answer.status === 404
              ? "missing"
              : answer.status === 400
                ? "invalid"
                : answer.status === 413
                  ? "tooLarge"
                  : answer.status === 503
                    ? "maintenance"
                    : "request";
    return { status: "error", reason };
}

function summary(value: unknown): value is CheckpointSummary {
    if (!isPlainObject(value) || !isPlainObject(value.preview)) return false;
    const preview = value.preview;
    return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        typeof value.revision === "string" &&
        ["manual", "auto", "safety"].includes(value.kind as string) &&
        [
            value.createdAt,
            value.userTurns,
            value.messageCount,
            preview.summaries,
            preview.loreEntries,
            preview.variables,
        ].every((count) => Number.isSafeInteger(count) && (count as number) >= 0) &&
        Array.isArray(preview.messages) &&
        preview.messages.length <= 2 &&
        preview.messages.every(
            (message) =>
                isPlainObject(message) &&
                (message.role === "user" || message.role === "char") &&
                typeof message.text === "string",
        )
    );
}

function policy(value: unknown): value is CheckpointPolicy | null {
    return (
        value === null ||
        (isPlainObject(value) &&
            Number.isInteger(value.autoEvery) &&
            (value.autoEvery as number) >= MIN_AUTO_EVERY &&
            (value.autoEvery as number) <= MAX_AUTO_EVERY &&
            Number.isInteger(value.autoKeep) &&
            (value.autoKeep as number) >= MIN_AUTO_KEEP &&
            (value.autoKeep as number) <= MAX_AUTO_KEEP)
    );
}

export async function listCheckpoints(ref: ChatRef): Promise<CheckpointResult<{ checkpoints: CheckpointSummary[] }>> {
    const answer = await request(`${path}?${new URLSearchParams(address(ref))}`);
    if (
        answer.kind === "response" &&
        answer.status === 200 &&
        typeof answer.body?.epoch === "string" &&
        Array.isArray(answer.body.checkpoints) &&
        answer.body.checkpoints.every(summary)
    ) {
        return { status: "ok", checkpoints: answer.body.checkpoints };
    }
    return failure(answer);
}

function localRefusal(ref: ChatRef): CheckpointFailure | null {
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

async function prepare(ref: ChatRef): Promise<CheckpointFailure | null> {
    const refused = localRefusal(ref);
    if (refused) return refused;
    const notices = generatingNoticeCount();
    try {
        const { discarded } = await flushResources();
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

export async function saveCheckpoint(
    ref: ChatRef,
    name: string,
): Promise<CheckpointResult<{ checkpoint: CheckpointSummary }>> {
    if (get(loading)) return { status: "not-sent", reason: "busy" };
    const refused = await prepare(ref);
    if (refused) return refused;
    return await writeSummary("save", { ...address(ref), name });
}

async function writeSummary(
    operation: string,
    body: Record<string, unknown>,
): Promise<CheckpointResult<{ checkpoint: CheckpointSummary }>> {
    const answer = await request(`${path}/${operation}`, body);
    return answer.kind === "response" && answer.status === 200 && summary(answer.body?.checkpoint)
        ? { status: "ok", checkpoint: answer.body.checkpoint }
        : failure(answer);
}

/** The row's revision is captured with its id, even when a name prompt is open meanwhile. */
export async function renameCheckpoint(
    ref: ChatRef,
    checkpoint: Pick<CheckpointSummary, "id" | "revision">,
    name: string,
) {
    return await writeSummary("rename", {
        ...address(ref),
        id: checkpoint.id,
        baseRevision: checkpoint.revision,
        name,
    });
}

export async function deleteCheckpoint(
    ref: ChatRef,
    checkpoint: Pick<CheckpointSummary, "id" | "revision">,
): Promise<CheckpointResult> {
    const answer = await request(`${path}/delete`, {
        ...address(ref),
        id: checkpoint.id,
        baseRevision: checkpoint.revision,
    });
    return answer.kind === "response" && answer.status === 200 && answer.body?.ok === true
        ? { status: "ok" }
        : failure(answer);
}

async function refresh(ref: ChatRef): Promise<boolean> {
    try {
        await loadChat(ref);
        return true;
    } catch {
        // A refresh failure must not hide a committed load, a conflict, or an unknown outcome.
        return false;
    }
}

/** One load attempt only. A lost answer is reconciled by a read, never by resending the load. */
export async function loadCheckpoint(ref: ChatRef, id: string): Promise<CheckpointLoadResult> {
    if (get(loading)) return { status: "not-sent", reason: "busy" };
    loading.set(true);
    try {
        const refused = await prepare(ref);
        if (refused) return refused;
        const chatBaseRevision = heldChatRevision(ref);
        if (chatBaseRevision === null) return { status: "not-sent", reason: "unsaved" };
        const answer = await request(`${path}/load`, { ...address(ref), id, chatBaseRevision });
        if (answer.kind === "failed" && !answer.dispatched) return failure(answer);
        if (answer.kind === "response") {
            if (answer.status === 200) {
                const chatRevision = typeof answer.body?.chatRevision === "string" ? answer.body.chatRevision : null;
                const safety = summary(answer.body?.safety) ? answer.body.safety : null;
                const refreshed = await refresh(ref);
                const order = compareRevision(heldChatRevision(ref), chatRevision);
                return refreshed && chatRevision !== null && order !== null && order >= 0
                    ? { status: "loaded", chatRevision, safety }
                    : { status: "refresh-pending", chatRevision, safety };
            }
            if (answer.status === 409 && answer.body?.reason === "generating") return failure(answer);
            if (
                answer.status === 409 &&
                typeof answer.body?.error === "string" &&
                (answer.body.revision === null || typeof answer.body.revision === "string")
            ) {
                await refresh(ref);
                return failure(answer);
            }
            if ([400, 404, 413].includes(answer.status)) return failure(answer);
        }
        await refresh(ref);
        return { status: "unknown" };
    } finally {
        loading.set(false);
    }
}

/** An absent route, non-JSON answer, or invalid policy is unavailable, never an off policy. */
export async function readCheckpointPolicy(ref: ChatRef): Promise<CheckpointPolicyResult> {
    const answer = await request(`${path}/policy?${new URLSearchParams(address(ref))}`);
    return answer.kind === "response" &&
        answer.status === 200 &&
        typeof answer.body?.epoch === "string" &&
        policy(answer.body.policy)
        ? { status: "available", policy: answer.body.policy }
        : { status: "unavailable" };
}

export async function writeCheckpointPolicy(
    ref: ChatRef,
    value: CheckpointPolicy | null,
): Promise<CheckpointResult<{ policy: CheckpointPolicy | null }>> {
    const answer = await request(
        `${path}/policy`,
        {
            ...address(ref),
            ...(value === null ? { off: true } : { autoEvery: value.autoEvery, autoKeep: value.autoKeep }),
        },
        "PUT",
    );
    return answer.kind === "response" && answer.status === 200 && policy(answer.body?.policy)
        ? { status: "ok", policy: answer.body.policy }
        : failure(answer);
}
