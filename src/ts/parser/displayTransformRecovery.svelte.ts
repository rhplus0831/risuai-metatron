import { untrack } from "svelte";
import { isPageVisible, pageRecoveryVersion } from "../pageVisibility.svelte";
import type { ChatRef } from "../storage/chatStore.svelte";

const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const failures = new Map<string, number>();
let retryDelay = INITIAL_RETRY_DELAY_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Only rows mounted for this round retry; a later mount renders fresh. */
export const displayTransformRetryRound = $state<{ version: number; keys: ReadonlySet<string> }>({
    version: 0,
    keys: new Set(),
});

export const displayTransformMessageKey = (ref: ChatRef, messageId: string) =>
    JSON.stringify([ref.chaId, ref.chatId, messageId]);

function clearRetryTimer(): void {
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
}

function publishRetryRound(): void {
    if (!untrack(isPageVisible) || failures.size === 0) return;
    const keys = new Set(failures.keys());
    failures.clear();
    displayTransformRetryRound.keys = keys;
    displayTransformRetryRound.version += 1;
}

function scheduleRetry(): void {
    if (retryTimer !== null || failures.size === 0 || !untrack(isPageVisible)) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        publishRetryRound();
    }, retryDelay);
}

export function markDisplayTransformFailed(ref: ChatRef, messageId: string, generation: number): void {
    failures.set(displayTransformMessageKey(ref, messageId), generation);
    scheduleRetry();
}

/** A success supersedes older failures, but not another target's failure in the same generation. */
export function markDisplayTransformSucceeded(ref: ChatRef, messageId: string, generation: number): void {
    const key = displayTransformMessageKey(ref, messageId);
    const failedGeneration = failures.get(key);
    if (failedGeneration === undefined || failedGeneration >= generation) return;
    failures.delete(key);
    if (failures.size === 0) clearRetryTimer();
}

let seenRecovery = untrack(pageRecoveryVersion);
$effect.root(() => {
    $effect(() => {
        const visible = isPageVisible();
        const version = pageRecoveryVersion();
        untrack(() => {
            if (!visible) clearRetryTimer();
            if (version === seenRecovery) return;
            seenRecovery = version;
            retryDelay = INITIAL_RETRY_DELAY_MS;
            clearRetryTimer();
            if (visible) publishRetryRound();
        });
    });
});
