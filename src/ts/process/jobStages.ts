import { get, writable, type Readable } from "svelte/store";
import type { GenerationStage } from "../../../shared/jobs.ts";
import type { ChatRef } from "../storage/chatStore.svelte";

/**
 * Presentation stages and retry counts per followed job, set by `applyGenerationEvent` and removed
 * on release or detach. Stages are seeded at creation; retry counts need no stage. Chat keys use the `chatStatusKey` format
 * (`${chaId}\u0000${chatId}`). Like `localSends.ts`, a separate module with no runes and type-only
 * imports keeps hand-written mocks of `stores.svelte` and `index.svelte` from reaching it.
 */

type JobStage = { chatKey: string; stage: GenerationStage };
const stages = writable<ReadonlyMap<string, JobStage>>(new Map());
const retries = writable<ReadonlyMap<string, number>>(new Map());

function jobStageKey(ref: ChatRef): string {
    return `${ref.chaId}\u0000${ref.chatId}`;
}

/** The latest stage per job, exposed read-only with a new Map for every change. */
export const jobStages: Readable<ReadonlyMap<string, JobStage>> = { subscribe: stages.subscribe };

/** Counts are independent of stage updates and cleared when a follow's socket opens, before snapshot replay. */
export const jobRetries: Readable<ReadonlyMap<string, number>> = { subscribe: retries.subscribe };

/** Sets a retry count from the server, or clears it on a live null event or before a socket's first events. */
export function setJobRetry(jobId: string, retry: number | null): void {
    const current = get(retries);
    if ((current.get(jobId) ?? null) === retry) {
        return;
    }
    const next = new Map(current);
    if (retry === null) next.delete(jobId);
    else next.set(jobId, retry);
    retries.set(next);
}

/** Sets a job's stage in its original Map position; an initial seed preserves any known stage. */
export function setJobStage(
    jobId: string,
    ref: ChatRef,
    stage: GenerationStage,
    { onlyIfMissing = false }: { onlyIfMissing?: boolean } = {},
): void {
    const chatKey = jobStageKey(ref);
    const current = get(stages);
    const entry = current.get(jobId);
    if ((onlyIfMissing && entry) || (entry?.chatKey === chatKey && entry.stage === stage)) {
        return;
    }
    stages.set(new Map(current).set(jobId, { chatKey, stage }));
}

/** Removes the named job's stage and retry count, notifying only stores with an entry. */
export function dropJobStage(jobId: string): void {
    setJobRetry(jobId, null);
    const current = get(stages);
    if (!current.has(jobId)) {
        return;
    }
    const next = new Map(current);
    next.delete(jobId);
    stages.set(next);
}

/** The chat's last matching stage in Map insertion order, or null when none exists. */
export function chatStageOf(map: ReadonlyMap<string, JobStage>, ref: ChatRef): GenerationStage | null {
    const chatKey = jobStageKey(ref);
    let stage: GenerationStage | null = null;
    for (const entry of map.values()) {
        if (entry.chatKey === chatKey) {
            stage = entry.stage;
        }
    }
    return stage;
}

/** Clears every job stage and retry count for test isolation. */
export function resetJobStagesForTests(): void {
    stages.set(new Map());
    retries.set(new Map());
}
