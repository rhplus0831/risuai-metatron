import type { Message } from "../../../../../shared/database.ts";
import type { MemoryChatRef } from "../../../../../shared/jobs.ts";
import {
    type MemoryEvent,
    type MemoryTrustFlags,
    reconcileMemoryEvents,
    storedMemorySources,
} from "../../../../../shared/structuredMemory.ts";
import { type MemoryChanges, messageSourceHash } from "../../../data/memoryStore.ts";
import type { MessagesChanged, ResourceStore } from "../../../data/resourceStore.ts";
import { applyEventRepair, flagUnsupportedSections } from "./edits.ts";
import type { WriterCadence, WriterWindow } from "./window.ts";
import type { WriterMemory } from "./writer.ts";

/**
 * The server's side of keeping events honest about the messages they cite. The rules are in `shared/`,
 * because the tab runs the same ones over the messages it holds.
 *
 * - Reconciliation is a reading, never a write: it answers a copy, a send takes that copy, and nothing
 *   stored changes. So a message put back as it was makes its event whole again, and nothing is deleted.
 * - A re-record replaces its event only as the new one commits: until then the old event stays as it is,
 *   and a failed run leaves it and its mark in place for the next run.
 * - The new event takes on what a person set on the old one: the marks are theirs, not the writer's.
 * - The old event is retracted, not removed, so what it cited stays recorded and its history stays.
 * - Every retraction, a person's repair, a confirmed delete, or a re-record's retire, also flags the
 *   sections it leaves with nothing but retracted events behind them (`withUnsupportedSections`).
 * - A chat write reaches the records through `reconcileMessageChanges`: a delete a person confirmed
 *   retracts what cites the message, and an edit marks what cites it for a re-record. It runs in the
 *   write's own turn, holds up no send, and has no fence: a running writer sees `revisionConflict` and
 *   admits its answer again from fresh records, or `windowChanged` when its source moved. A rebuild's
 *   staged records take the same reaction, so the swap loses neither.
 * - An automatic task re-records only what an edit explains (`automaticRerecords`). Any other mark stays
 *   for the panel, because a message that is gone or moved may be a mistake only a person can read.
 */

/** `events` as the chat's stored `messages` leave them (`reconcileMemoryEvents`). */
export function reconcileEvents(events: readonly MemoryEvent[], messages: readonly Message[]): MemoryEvent[] {
    return reconcileMemoryEvents(events, messages, messageSourceHash);
}

/**
 * The events of `events` an automatic task re-records: marked, and read `stale` because a source's text
 * changed. None under the `manual` cadence. A mark left on an event whose text was put back, or whose
 * message went unasked, reads otherwise and waits for a person, so it spends no call and retires nothing.
 */
export function automaticRerecords(
    events: readonly MemoryEvent[],
    messages: readonly Message[],
    { cadence }: Pick<WriterCadence, "cadence">,
): MemoryEvent[] {
    if (cadence === "manual") {
        return [];
    }
    const marked = events.filter(({ rerecord }) => rerecord);
    const read = reconcileEvents(marked, messages);
    return marked.filter((_, index) => read[index].status === "stale" && read[index].staleReason === "changed");
}

/**
 * `changes` with the sections it leaves unsupported flagged (`flagUnsupportedSections`), the flagged
 * pages replacing any the change set already holds. It reads the events and pages as they will stand:
 * the stored statuses, which the contents list so no event body is parsed, under `changes.events`, and
 * the stored pages under `changes.pages` and `changes.remove.pages`.
 *
 * It works only when `changes` turns an event `retracted` that is not retracted as stored; otherwise it
 * answers `changes` itself and reads no page. Call it in the write's synchronous step.
 */
export function withUnsupportedSections(
    store: { memory: Pick<WriterMemory, "readContents" | "readRecord"> },
    { chaId, chatId }: MemoryChatRef,
    changes: MemoryChanges,
): MemoryChanges {
    const retracting = changes.events?.filter(({ status }) => status === "retracted") ?? [];
    const contents = retracting.length > 0 ? store.memory.readContents(chaId, chatId) : null;
    if (!contents) {
        return changes;
    }
    const statuses = new Map(contents.events.map(({ id, status }) => [id, status]));
    if (retracting.every(({ id }) => statuses.get(id) === "retracted")) {
        return changes;
    }
    for (const id of changes.remove?.events ?? []) {
        statuses.delete(id);
    }
    for (const { id, status } of changes.events ?? []) {
        statuses.set(id, status);
    }
    const events = [...statuses].map(([id, status]) => ({ id, status }));
    const written = new Map((changes.pages ?? []).map((page) => [page.id, page]));
    const removed = new Set(changes.remove?.pages);
    const stored = contents.pages.flatMap(({ id }) =>
        written.has(id) || removed.has(id) ? [] : (store.memory.readRecord(chaId, chatId, "pages", id)?.data ?? []),
    );
    const flagged = flagUnsupportedSections([...stored, ...written.values()], events);
    if (flagged.length === 0) {
        return changes;
    }
    for (const page of flagged) {
        written.set(page.id, page);
    }
    return { ...changes, pages: [...written.values()] };
}

/**
 * What `changes` commits for `window`, or null when `window` re-records an event that no longer wants
 * it. A window that re-records an event, in the writer's final commit, the one with an event in it,
 * retires the event it replaces in the same write: the new event carries the old one's `pinned`,
 * `suppressed`, and `userCorrected` when set, the old one is written `retracted`, without its mark or
 * `staleReason`, and the sections that leaves unsupported are flagged. An old event that is gone, no
 * longer marked, or retracted answers null, because committing would leave a second event over the same
 * messages. Anything else answers `changes` itself, as does the very event being written.
 *
 * It reads the old event in the commit's synchronous step, so each retry of a commit works it out again.
 */
export function retireRerecorded(
    store: Pick<ResourceStore, "memory">,
    chatRef: MemoryChatRef,
    { rerecords }: Pick<WriterWindow, "rerecords">,
    changes: MemoryChanges,
): MemoryChanges | null {
    const [recorded, ...others] = changes.events ?? [];
    if (rerecords === undefined || recorded === undefined) {
        return changes;
    }
    const old = store.memory.readRecord(chatRef.chaId, chatRef.chatId, "events", rerecords)?.data;
    if (old?.id === recorded.id) {
        return changes;
    }
    if (!old?.rerecord || old.status === "retracted") {
        return null;
    }
    const { rerecord, staleReason, ...retired } = old;
    const marks: MemoryTrustFlags = {
        ...(old.pinned ? { pinned: true } : {}),
        ...(old.suppressed ? { suppressed: true } : {}),
        ...(old.userCorrected ? { userCorrected: true } : {}),
    };
    return withUnsupportedSections(store, chatRef, {
        ...changes,
        events: [{ ...recorded, ...marks }, ...others, { ...retired, status: "retracted" }],
    });
}

/**
 * What a chat write leaves of the records `memory` holds, in one synchronous step: see
 * `reconcileMessageChanges`. A chat with no records there stops here.
 */
function reactToMessageChanges({ memory }: { memory: WriterMemory }, notice: MessagesChanged): void {
    const { epoch, characterId: chaId, id: chatId } = notice;
    const contents = memory.readContents(chaId, chatId);
    if (!contents || contents.events.length === 0) {
        return;
    }
    const retracted = new Set(notice.retracted);
    const rewritten = new Set(notice.rewritten);
    const events: MemoryEvent[] = [];
    for (const { id, status } of contents.events) {
        const event = status === "retracted" ? undefined : memory.readRecord(chaId, chatId, "events", id)?.data;
        if (!event) {
            continue;
        }
        const cited = storedMemorySources(event.sources).map(({ messageId }) => messageId);
        if (cited.some((messageId) => retracted.has(messageId))) {
            const repair = { kind: "event", eventId: id, repair: "retract" } as const;
            events.push(applyEventRepair<Message>(event, repair, [], messageSourceHash)!);
        } else if (!event.rerecord && cited.some((messageId) => rewritten.has(messageId))) {
            events.push({ ...event, rerecord: true });
        }
    }
    if (events.length > 0) {
        const changes = withUnsupportedSections({ memory }, { chaId, chatId }, { events });
        memory.write(chaId, chatId, { epoch, baseRevision: contents.revision }, changes);
    }
}

/**
 * What a chat write leaves of the records, from `notice` (`onMessagesChanged`): an event that cites a
 * `retracted` id is retracted, the same write as the panel's, and an event that cites a `rewritten` id, is
 * not retracted here, and has no mark yet is marked `rerecord` and nothing else, so it stays until a
 * re-record commits. The sections a retraction leaves unsupported are flagged. Nothing affected writes
 * nothing. A chat's rebuild takes the same reaction on its staged records, after the live ones.
 *
 * It reads no message: `notice` says what changed, and whether a marked event can be re-recorded is the
 * windows' to say. A notice from before an epoch change stops here.
 */
export function reconcileMessageChanges(store: Pick<ResourceStore, "epoch" | "memory">, notice: MessagesChanged): void {
    if (store.epoch() !== notice.epoch) {
        return;
    }
    reactToMessageChanges(store, notice);
    if (store.memory.rebuild.status(notice.characterId, notice.id)) {
        reactToMessageChanges({ memory: store.memory.rebuild.staged }, notice);
    }
}
