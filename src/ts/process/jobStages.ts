import { get, writable, type Readable } from "svelte/store";
import type { GenerationStage } from "../../../shared/jobs.ts";
import type { ChatRef } from "../storage/chatStore.svelte";

/**
 * The latest presentation stage per followed job, set by `applyGenerationEvent` and removed by
 * `releaseGenerationJob`. Chat keys use the `chatStatusKey` format (`${chaId}\u0000${chatId}`). Like
 * `localSends.ts`, a separate module with no runes and type-only imports keeps hand-written mocks
 * of `stores.svelte` and `index.svelte` from reaching it.
 */
type JobStage = { chatKey: string; stage: GenerationStage };
const stages = writable<ReadonlyMap<string, JobStage>>(new Map());

function jobStageKey(ref: ChatRef): string {
    return `${ref.chaId}\u0000${ref.chatId}`;
}

/** The latest stage per job, exposed read-only with a new Map for every change. */
export const jobStages: Readable<ReadonlyMap<string, JobStage>> = { subscribe: stages.subscribe };

/** Sets a job's stage in its original Map position, without notifying for an unchanged entry. */
export function setJobStage(jobId: string, ref: ChatRef, stage: GenerationStage): void {
    const chatKey = jobStageKey(ref);
    const current = get(stages);
    const entry = current.get(jobId);
    if (entry?.chatKey === chatKey && entry.stage === stage) {
        return;
    }
    stages.set(new Map(current).set(jobId, { chatKey, stage }));
}

/** Removes only the named job's stage, without notifying when it has no entry. */
export function dropJobStage(jobId: string): void {
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

/** Clears every job stage for test isolation. */
export function resetJobStagesForTests(): void {
    stages.set(new Map());
}
