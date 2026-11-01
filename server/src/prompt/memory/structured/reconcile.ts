import type { Message } from "../../../../../shared/database.ts";
import type { MemoryChatRef } from "../../../../../shared/jobs.ts";
import {
    type MemoryEvent,
    type MemoryTrustFlags,
    reconcileMemoryEvents,
} from "../../../../../shared/structuredMemory.ts";
import { type MemoryChanges, messageSourceHash } from "../../../data/memoryStore.ts";
import type { ResourceStore } from "../../../data/resourceStore.ts";
import type { WriterWindow } from "./window.ts";

/**
 * The server's side of keeping events honest about the messages they cite. The rules are in `shared/`,
 * because the tab runs the same ones over the messages it holds.
 *
 * - Reconciliation is a reading, never a write: it answers a copy, a send takes that copy, and nothing
 *   stored changes. So a message put back as it was makes its event whole again, and nothing is deleted.
 * - A re-record replaces its event only as the new one commits: until then the old event stays as it is,
 *   and a failed run leaves it and its mark in place for the next press.
 * - The new event takes on what a person set on the old one: the marks are theirs, not the writer's.
 * - The old event is retracted, not removed, so what it cited stays recorded and its history stays.
 */

/** `events` as the chat's stored `messages` leave them (`reconcileMemoryEvents`). */
export function reconcileEvents(events: readonly MemoryEvent[], messages: readonly Message[]): MemoryEvent[] {
    return reconcileMemoryEvents(events, messages, messageSourceHash);
}

/**
 * What `changes` commits for `window`. A window that re-records an event, in the writer's final commit,
 * the one with an event in it, retires the event it replaces in the same write: the new event carries
 * the old one's `pinned`, `suppressed`, and `userCorrected` when set, and the old one is written
 * `retracted`, without its mark or `staleReason`. Anything else answers `changes` itself, as does an
 * old event that is gone, no longer marked, or the very event being written.
 *
 * It reads the old event in the commit's synchronous step, so each retry of a commit works it out again.
 */
export function retireRerecorded(
    store: Pick<ResourceStore, "memory">,
    { chaId, chatId }: MemoryChatRef,
    { rerecords }: Pick<WriterWindow, "rerecords">,
    changes: MemoryChanges,
): MemoryChanges {
    const [recorded, ...others] = changes.events ?? [];
    if (rerecords === undefined || recorded === undefined) {
        return changes;
    }
    const old = store.memory.readRecord(chaId, chatId, "events", rerecords)?.data;
    if (!old?.rerecord || old.id === recorded.id) {
        return changes;
    }
    const { rerecord, staleReason, ...retired } = old;
    const marks: MemoryTrustFlags = {
        ...(old.pinned ? { pinned: true } : {}),
        ...(old.suppressed ? { suppressed: true } : {}),
        ...(old.userCorrected ? { userCorrected: true } : {}),
    };
    return { ...changes, events: [{ ...recorded, ...marks }, ...others, { ...retired, status: "retracted" }] };
}
