import { untrack } from "svelte";
import { isPageVisible, pageRecoveryVersion } from "../pageVisibility.svelte";
import type { ChatRef } from "../storage/chatStore.svelte";

const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
/** What a row shows: its display text and, with bilingual display, the pairs' source side. */
export interface DisplayTransformSource {
    display: string;
    bilingual: string | undefined;
}
/** A pending failure, with what its row showed when it failed (undefined: no row had shown it). */
const failures = new Map<string, { generation: number; shown: DisplayTransformSource | undefined }>();
/** What each mounted row of a message shows, by the row that last showed it. */
const shownSources = new Map<string, { owner: object; shown: DisplayTransformSource }>();
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
    const key = displayTransformMessageKey(ref, messageId);
    failures.set(key, { generation, shown: shownSources.get(key)?.shown });
    scheduleRetry();
}

/**
 * A success (or a permanent failure, which is not retried) supersedes older failures, but not another
 * target's failure in the same generation.
 */
export function markDisplayTransformSucceeded(ref: ChatRef, messageId: string, generation: number): void {
    const key = displayTransformMessageKey(ref, messageId);
    const failure = failures.get(key);
    if (failure === undefined || failure.generation >= generation) return;
    dropFailure(key);
}

function dropFailure(key: string): void {
    failures.delete(key);
    if (failures.size === 0) clearRetryTimer();
}

/**
 * A row shows a message's source. A pending failure recorded while the message showed another source
 * (an edit, which remounts a transcript row, or a saved edit from another tab) is dropped: the new
 * source renders and records its own failure, and the old one's retry would only replace that render.
 */
export function showDisplayTransformSource(
    ref: ChatRef,
    messageId: string,
    owner: object,
    shown: DisplayTransformSource,
): void {
    const key = displayTransformMessageKey(ref, messageId);
    shownSources.set(key, { owner, shown });
    const failed = failures.get(key)?.shown;
    if (failed && (failed.display !== shown.display || failed.bilingual !== shown.bilingual)) dropFailure(key);
}

/** The row unmounted; another row showing the message since keeps its entry. */
export function releaseDisplayTransformSource(ref: ChatRef, messageId: string, owner: object): void {
    const key = displayTransformMessageKey(ref, messageId);
    if (shownSources.get(key)?.owner === owner) shownSources.delete(key);
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
