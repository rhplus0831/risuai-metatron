import type { Message } from "../../../../../shared/database.ts";
import type { MemoryChatRef } from "../../../../../shared/jobs.ts";
import {
    type MemoryEvent,
    type MemoryThread,
    type MemoryThreadState,
    type MemoryTrustFlags,
    memoryThreadEnded,
    reconcileMemoryEvents,
    storedMemorySources,
} from "../../../../../shared/structuredMemory.ts";
import { type MemoryChanges, type MemoryEventWrite, messageSourceHash } from "../../../data/memoryStore.ts";
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
 * - A repair or confirmed delete also replays affected threads from surviving events, retiring an
 *   unsupported opening and preserving states the full history cannot explain (`withReconciledThreads`).
 * - A chat write reaches the records through `reconcileMessageChanges`: a delete a person confirmed
 *   retracts what cites the message, and an edit marks what cites it for a re-record when the message
 *   no longer hashes as the source stored it. The citation
 *   relation selects the events whose bodies the reaction reads. It runs in the write's own turn,
 *   holds up no send, and has no fence: a running writer sees `revisionConflict` and
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
 * Each named thread's state in event order: `close`, then `transitions`, the last naming winning.
 * An event cannot move a thread already ended before it, and an ended result names that event.
 * Threads never named start open, without a closing event, and have no entry here.
 */
function replayedThreads(events: readonly MemoryEventWrite[]): Map<string, Pick<MemoryThread, "state" | "closedBy">> {
    const replayed = new Map<string, Pick<MemoryThread, "state" | "closedBy">>();
    for (const { id, openThreads } of events) {
        const moved = new Map<string, MemoryThreadState>();
        for (const threadId of openThreads.close) {
            moved.set(threadId, "done");
        }
        for (const { threadId, to } of openThreads.transitions) {
            moved.set(threadId, to);
        }
        for (const [threadId, state] of moved) {
            const previous = replayed.get(threadId);
            if (!previous || !memoryThreadEnded(previous.state)) {
                replayed.set(threadId, memoryThreadEnded(state) ? { state, closedBy: id } : { state });
            }
        }
    }
    return replayed;
}

/**
 * `changes` with affected writer-owned threads replayed after an existing event becomes retracted.
 * It reads stored threads except those already written or removed by `changes`, selecting those opened,
 * closed, or named in `close` or `transitions` by a newly retracted event. Only then does it read event
 * bodies, in contents order, with `changes.events` taking precedence.
 *
 * The full replay uses stored non-retracted events. A thread whose state or closing event differs from
 * that replay is left alone, preserving user state edits and unexplained history. Otherwise the replay
 * of surviving events supplies its state and closing event; a retracted opening with no surviving event
 * naming the thread removes it instead. Other thread fields and changes are preserved.
 *
 * Without a newly retracted stored event it answers `changes` itself and reads no record body; without
 * affected threads it reads no event body. Call it in the write's synchronous step. Re-record retirement
 * uses `retireRerecorded` instead: it preserves thread state and transfers provenance and thread moves
 * to the replacement, so a later retraction of that replacement can reconcile the inherited threads.
 */
export function withReconciledThreads(
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
    const newlyRetracted = retracting.filter(({ id }) => statuses.has(id) && statuses.get(id) !== "retracted");
    if (newlyRetracted.length === 0) {
        return changes;
    }
    const retractedIds = new Set(newlyRetracted.map(({ id }) => id));
    const moved = new Set(
        newlyRetracted.flatMap(({ openThreads: { close, transitions } }) => [
            ...close,
            ...transitions.map(({ threadId }) => threadId),
        ]),
    );
    const written = new Set(changes.threads?.map(({ id }) => id));
    const removed = new Set(changes.remove?.threads);
    const affected = contents.threads.flatMap(({ id }) => {
        const thread =
            written.has(id) || removed.has(id)
                ? undefined
                : store.memory.readRecord(chaId, chatId, "threads", id)?.data;
        return thread &&
            ((thread.openedBy !== undefined && retractedIds.has(thread.openedBy)) ||
                (thread.closedBy !== undefined && retractedIds.has(thread.closedBy)) ||
                moved.has(id))
            ? [thread]
            : [];
    });
    if (affected.length === 0) {
        return changes;
    }
    const changedEvents = new Map(changes.events?.map((event) => [event.id, event]));
    const removedEvents = new Set(changes.remove?.events);
    const fullEvents: MemoryEventWrite[] = [];
    const survivingEvents: MemoryEventWrite[] = [];
    for (const { id, status } of contents.events) {
        const changed = changedEvents.get(id);
        const survives = !removedEvents.has(id) && (changed?.status ?? status) !== "retracted";
        if (status === "retracted" && !survives) {
            continue;
        }
        const event = changed ?? store.memory.readRecord(chaId, chatId, "events", id)?.data;
        if (event) {
            if (status !== "retracted") {
                fullEvents.push(event);
            }
            if (survives) {
                survivingEvents.push(event);
            }
        }
    }
    const full = replayedThreads(fullEvents);
    const surviving = replayedThreads(survivingEvents);
    const threads: MemoryThread[] = [];
    const retired: string[] = [];
    for (const thread of affected) {
        const before = full.get(thread.id) ?? { state: "open" };
        if (thread.state !== before.state || thread.closedBy !== before.closedBy) {
            continue;
        }
        if (thread.openedBy !== undefined && retractedIds.has(thread.openedBy) && !surviving.has(thread.id)) {
            retired.push(thread.id);
            continue;
        }
        const after = surviving.get(thread.id) ?? { state: "open" as const };
        if (thread.state !== after.state || thread.closedBy !== after.closedBy) {
            const { closedBy, ...open } = thread;
            threads.push({ ...open, ...after });
        }
    }
    if (threads.length === 0 && retired.length === 0) {
        return changes;
    }
    return {
        ...changes,
        ...(threads.length > 0 ? { threads: [...(changes.threads ?? []), ...threads] } : {}),
        ...(retired.length > 0 ? { remove: { ...changes.remove, threads: [...removed, ...retired] } } : {}),
    };
}

/**
 * `changes` with threads reconciled from surviving evidence and unsupported page sections flagged.
 * Use for repairs and confirmed deletes in the write's synchronous step; re-record retirement keeps
 * its thread effects and calls `withUnsupportedSections` alone.
 */
export function withRetractedEvidence(
    store: { memory: Pick<WriterMemory, "readContents" | "readRecord"> },
    chatRef: MemoryChatRef,
    changes: MemoryChanges,
): MemoryChanges {
    return withUnsupportedSections(store, chatRef, withReconciledThreads(store, chatRef, changes));
}

/**
 * What `changes` commits for `window`, or null when `window` re-records an event that no longer wants
 * it. A window that re-records an event, in the writer's final commit, the one with an event in it,
 * retires the event it replaces in the same write: the new event carries the old one's `pinned`,
 * `suppressed`, and `userCorrected` when set, the old one is written `retracted`, without its mark or
 * `staleReason`, and the sections that leaves unsupported are flagged. Threads keep their state, with
 * `openedBy` and `closedBy` naming the replacement wherever they named the old event, including threads
 * already written by `changes`. The replacement also carries the old event's `close` and ended `transitions`
 * for threads it does not move itself, so its later retraction can replay those effects. Display-only
 * `add` entries stay as recorded; opening ownership comes from `openedBy`. An old event that is gone, no
 * longer marked, or retracted answers null, because committing would leave a second event over the same
 * messages. Anything else answers `changes` itself, as does the very event being written.
 *
 * It reads the old event and stored threads in the commit's synchronous step, skipping threads already
 * written or removed by `changes`, so each retry of a commit works it out again.
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
    const moved = new Set([
        ...recorded.openThreads.close,
        ...recorded.openThreads.transitions.map(({ threadId }) => threadId),
    ]);
    const openThreads = {
        ...recorded.openThreads,
        close: [...recorded.openThreads.close, ...old.openThreads.close.filter((id) => !moved.has(id))],
        transitions: [
            ...recorded.openThreads.transitions,
            ...old.openThreads.transitions.filter(({ threadId, to }) => !moved.has(threadId) && memoryThreadEnded(to)),
        ],
    };
    const written = new Map((changes.threads ?? []).map((thread) => [thread.id, thread]));
    const removed = new Set(changes.remove?.threads);
    const contents = store.memory.readContents(chatRef.chaId, chatRef.chatId);
    for (const { id } of contents?.threads ?? []) {
        if (written.has(id) || removed.has(id)) {
            continue;
        }
        const thread = store.memory.readRecord(chatRef.chaId, chatRef.chatId, "threads", id)?.data;
        if (thread && (thread.openedBy === old.id || thread.closedBy === old.id)) {
            written.set(id, thread);
        }
    }
    const threads = [...written.values()].map((thread) => ({
        ...thread,
        ...(thread.openedBy === old.id ? { openedBy: recorded.id } : {}),
        ...(thread.closedBy === old.id ? { closedBy: recorded.id } : {}),
    }));
    return withUnsupportedSections(store, chatRef, {
        ...changes,
        events: [{ ...recorded, ...marks, openThreads }, ...others, { ...retired, status: "retracted" }],
        ...(threads.length > 0 ? { threads } : {}),
    });
}

/** The stored messages among a notice's `rewritten` ids, by id, read once on first use. */
type RewrittenMessages = () => ReadonlyMap<string, Message>;

/** The hash a person's keep recorded for each message id (`keptState`), or none when it is not one. */
function keptHashes(keptState: string | undefined): Map<string, string> {
    const kept = new Map<string, string>();
    if (keptState === undefined) {
        return kept;
    }
    try {
        const parts: unknown = JSON.parse(keptState);
        for (const part of Array.isArray(parts) ? parts : []) {
            if (Array.isArray(part) && typeof part[0] === "string" && typeof part[1] === "string") {
                kept.set(part[0], part[1]);
            }
        }
    } catch {
        // A keep this build cannot read accepts nothing: the source's own hash decides.
    }
    return kept;
}

/**
 * Whether `event` cites a `rewritten` message whose evidence the write changed, under each source's stored
 * hash version: the message is gone, the source is unanchored, or the message now hashes (`messageSourceHash`
 * with the stored hash) to neither the source's hash nor the hash a person's keep recorded for it. So a
 * write that changes only display markup leaves a version 3 source unchanged, while a version 1 or 2
 * source, which reads raw `data`, still changes.
 */
function rewritesEvidence(event: MemoryEvent, rewritten: ReadonlySet<string>, messages: RewrittenMessages): boolean {
    let kept: Map<string, string> | undefined;
    return storedMemorySources(event.sources).some(({ messageId, hash }) => {
        if (!rewritten.has(messageId)) {
            return false;
        }
        const message = messages().get(messageId);
        if (message === undefined || hash === null) {
            return true;
        }
        const current = messageSourceHash(message, hash);
        kept ??= keptHashes(event.keptState);
        return current !== hash && current !== kept.get(messageId);
    });
}

/**
 * What a chat write leaves of the records `memory` holds, in one synchronous step: see
 * `reconcileMessageChanges`. An empty notice reads nothing; otherwise the citation relation selects
 * the event bodies to check. Without citing events it stops here. Retractions then reconcile their evidence.
 */
function reactToMessageChanges(
    { memory }: { memory: WriterMemory },
    notice: MessagesChanged,
    messages: RewrittenMessages,
): void {
    const { epoch, characterId: chaId, id: chatId } = notice;
    const retracted = new Set(notice.retracted);
    const rewritten = new Set(notice.rewritten);
    if (retracted.size === 0 && rewritten.size === 0) {
        return;
    }
    const contents = memory.readContents(chaId, chatId, { citing: [...new Set([...retracted, ...rewritten])] });
    if (!contents || contents.events.length === 0) {
        return;
    }
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
        } else if (!event.rerecord && rewritesEvidence(event, rewritten, messages)) {
            events.push({ ...event, rerecord: true });
        }
    }
    if (events.length > 0) {
        const changes = withRetractedEvidence({ memory }, { chaId, chatId }, { events });
        memory.write(chaId, chatId, { epoch, baseRevision: contents.revision }, changes);
    }
}

/**
 * What a chat write leaves of the records, from `notice` (`onMessagesChanged`): an event that cites a
 * `retracted` id is retracted, the same write as the panel's, and an event that cites a `rewritten` id
 * whose evidence changed under its stored hash version (`rewritesEvidence`), is not retracted here, and
 * has no mark yet is marked `rerecord` and nothing else, so it stays until a re-record commits. The
 * notice reports any raw change; a version 3 source ignores display markup, so a markup-only write marks
 * none of its events. A retraction reconciles the affected threads and flags unsupported sections.
 * Nothing affected writes nothing. A chat's rebuild takes the same reaction on its staged records,
 * after the live ones.
 *
 * The citation relation limits the reaction's event body reads to those citing changed ids, and the
 * `rewritten` messages are read by id once (`readMessagesById`), only when a citing event is unmarked.
 * Retraction's evidence reconciliation can read further records. Whether a marked event can be
 * re-recorded is the windows' to say. A notice from before an epoch change stops here.
 */
export function reconcileMessageChanges(
    store: Pick<ResourceStore, "epoch" | "memory" | "readMessagesById">,
    notice: MessagesChanged,
): void {
    if (store.epoch() !== notice.epoch) {
        return;
    }
    let read: ReadonlyMap<string, Message> | undefined;
    const messages = () => (read ??= store.readMessagesById(notice.characterId, notice.id, notice.rewritten));
    reactToMessageChanges(store, notice, messages);
    if (store.memory.rebuild.status(notice.characterId, notice.id)) {
        reactToMessageChanges({ memory: store.memory.rebuild.staged }, notice, messages);
    }
}
