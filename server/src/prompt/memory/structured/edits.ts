import type { Message } from "../../../../../shared/database.ts";
import {
    MEMORY_CONTEXT_MODES,
    MEMORY_THREAD_STATES,
    memoryAnchorState,
    type MemoryEvent,
    type MemoryPage,
    type MemoryPageHistoryEntry,
    memoryRerecordTarget,
    type MemorySection,
    type MemoryThread,
    memoryThreadEnded,
    reconcileMemoryEvents,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    type StructuredMemoryEdit,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";

/**
 * What a person's edit does to a record, without any I/O: what is kept of a request's edit, and what
 * that makes of the record as stored. The route owns the fence, the revision, and the write.
 *
 * - An edit is a closed shape and a stored record's other fields stay as they are, so a request can
 *   set no history, evidence, type, or id. An answer of null is an edit that changes nothing.
 * - A locked section can be edited: the lock binds the writer, not the person.
 * - A section's edit changes its body and nothing that says where it came from: `provenance` and
 *   `sources` stay, and so does `unsupported`, which states a fact about them. `disputed` goes, because a
 *   person's edit is the review a dispute waits for, and `userCorrected` says who wrote the text.
 * - The scene page stays `always`: it is the stage every send reads.
 * - A thread that leaves an ended state loses `closedBy`, which only an ended thread can have.
 * - A repair settles what reconciliation found. Retract takes an event out for good, and no control
 *   brings it back. Keep accepts what the person saw (`keptState`), and only that: a chat that moved on
 *   since then is refused, and a later change shows again. Re-record only marks the event, because the
 *   old one stays until the new one commits, so it changes neither its `sources` nor its `status`.
 * - A section left with only retracted events behind it is flagged for review, never reverted, because
 *   the page may still be right. The flag says nothing of the body, so like a lock it takes no history
 *   entry and no `updatedAt`.
 */

/** A page edit, which every kind but `thread` and `event` is. */
type PageEdit = Exclude<StructuredMemoryEdit, { kind: "thread" | "event" }>;

type ThreadEdit = Extract<StructuredMemoryEdit, { kind: "thread" }>;

type EventEdit = Extract<StructuredMemoryEdit, { kind: "event" }>;

/** What one edit stamps on what it changes. */
export type EditStamp = {
    /** `Date.now()` of the edit. */
    now: number;
    newId(): string;
};

/**
 * Why a well-formed edit does not fit the record: the section is gone, the record refuses the change,
 * or the chat is no longer what the person saw.
 */
export class MemoryEditRefusal extends Error {
    readonly reason: "sectionGone" | "invalid" | "changed";

    constructor(reason: MemoryEditRefusal["reason"], message: string) {
        super(message);
        this.reason = reason;
    }
}

/** Whether `value` is what a `page` edit can set as a grade: an integer in range, or null to clear it. */
function validGrade(value: unknown): value is number | null {
    return (
        value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= LIMITS.gradeMax)
    );
}

/**
 * The edit a request's `value` holds, or null for one that is malformed: unknown fields are dropped, and
 * a section's body must have text and fit `sectionBodyChars`, because nothing is cut to fit. A `keep`
 * must name a state, the one repair that has any.
 */
export function parseMemoryEdit(value: unknown): StructuredMemoryEdit | null {
    if (!isPlainObject(value)) {
        return null;
    }
    const { kind, pageId, heading } = value;
    if (kind === "thread") {
        const { threadId } = value;
        const state = MEMORY_THREAD_STATES.find((entry) => entry === value.state);
        return typeof threadId === "string" && state ? { kind, threadId, state } : null;
    }
    if (kind === "event") {
        const { eventId, repair, state } = value;
        if (typeof eventId !== "string") {
            return null;
        }
        if (repair === "keep") {
            return typeof state === "string" ? { kind, eventId, repair, state } : null;
        }
        return repair === "rerecord" || repair === "retract" ? { kind, eventId, repair } : null;
    }
    if (typeof pageId !== "string") {
        return null;
    }
    if (kind === "section" && typeof heading === "string") {
        const { body } = value;
        return typeof body === "string" && body.trim() !== "" && body.length <= LIMITS.sectionBodyChars
            ? { kind, pageId, heading, body }
            : null;
    }
    if (kind === "sectionLock" && typeof heading === "string") {
        const { locked } = value;
        return typeof locked === "boolean" ? { kind, pageId, heading, locked } : null;
    }
    if (kind === "page") {
        const { grade } = value;
        const contextMode = MEMORY_CONTEXT_MODES.find((entry) => entry === value.contextMode);
        const fields = { ...(contextMode ? { contextMode } : {}), ...(validGrade(grade) ? { grade } : {}) };
        // Every field given must be kept, and at least one must be given.
        const given = [value.contextMode, grade].filter((field) => field !== undefined).length;
        return given > 0 && given === Object.keys(fields).length ? { kind, pageId, ...fields } : null;
    }
    return null;
}

/** The section of `page` under `heading`; a heading the page lacks is `sectionGone`. */
function sectionOf(page: MemoryPage, heading: string): MemorySection {
    const section = page.sections.find((entry) => entry.heading === heading);
    if (!section) {
        throw new MemoryEditRefusal("sectionGone", "The page has no such section");
    }
    return section;
}

const withSection = (page: MemoryPage, section: MemorySection, written: MemorySection): MemorySection[] =>
    page.sections.map((entry) => (entry === section ? written : entry));

function editBody(page: MemoryPage, heading: string, body: string, stamp: EditStamp): MemoryPage | null {
    const section = sectionOf(page, heading);
    if (section.body === body) {
        return null;
    }
    const written: MemorySection = { ...section, body, userCorrected: true, updatedAt: stamp.now };
    delete written.disputed;
    const { provenance, sources } = section;
    const entry: MemoryPageHistoryEntry = {
        id: stamp.newId(),
        heading,
        before: { body: section.body, provenance, sources },
        kind: "edit",
        highlighted: false,
        at: stamp.now,
    };
    return {
        ...page,
        sections: withSection(page, section, written),
        history: [...page.history, entry].slice(-LIMITS.pageHistoryEntries),
    };
}

/** No history entry and no `updatedAt`: the body did not change. */
function editLock(page: MemoryPage, heading: string, locked: boolean): MemoryPage | null {
    const section = sectionOf(page, heading);
    return section.locked === locked ? null : { ...page, sections: withSection(page, section, { ...section, locked }) };
}

function editFields(page: MemoryPage, { contextMode, grade }: Extract<PageEdit, { kind: "page" }>): MemoryPage | null {
    const edited: MemoryPage = { ...page };
    if (contextMode !== undefined && contextMode !== page.contextMode) {
        if (page.type === "scene") {
            throw new MemoryEditRefusal("invalid", "The scene page stays in every send");
        }
        edited.contextMode = contextMode;
    }
    if (typeof grade === "number") {
        edited.grade = grade;
        edited.gradeByUser = true;
    } else if (grade === null) {
        delete edited.grade;
        delete edited.gradeByUser;
    }
    const unchanged =
        edited.contextMode === page.contextMode &&
        edited.grade === page.grade &&
        edited.gradeByUser === page.gradeByUser;
    return unchanged ? null : edited;
}

/**
 * `edit` over `page`, the page as stored: the page to store, or null for no change. A `MemoryEditRefusal`
 * says why it does not fit. A section body's change is kept in the page's history as one `edit` entry,
 * bounded by `pageHistoryEntries`.
 */
export function applyPageEdit(page: MemoryPage, edit: PageEdit, stamp: EditStamp): MemoryPage | null {
    switch (edit.kind) {
        case "section":
            return editBody(page, edit.heading, edit.body, stamp);
        case "sectionLock":
            return editLock(page, edit.heading, edit.locked);
        case "page":
            return editFields(page, edit);
    }
}

/** `edit` over `thread`, the thread as stored: the thread to store, or null for no change. */
export function applyThreadEdit(thread: MemoryThread, { state }: ThreadEdit): MemoryThread | null {
    if (thread.state === state) {
        return null;
    }
    const edited: MemoryThread = { ...thread, state };
    if (memoryThreadEnded(thread.state) && !memoryThreadEnded(state)) {
        delete edited.closedBy;
    }
    return edited;
}

/**
 * `edit` over `event`, the event as stored: the event to store, or null for no change. A
 * `MemoryEditRefusal` says why it does not fit, `changed` when a `keep` names a state the chat has left.
 * `messages` are the chat as stored, which a `retract` does not read, and `hashOf` hashes one of them.
 */
export function applyEventRepair<M extends Pick<Message, "chatId" | "role" | "disabled">>(
    event: MemoryEvent,
    edit: EventEdit,
    messages: readonly M[],
    hashOf: (message: M) => string,
): MemoryEvent | null {
    const { staleReason, rerecord, ...settled } = event;
    if (edit.repair === "retract") {
        return event.status === "retracted" ? null : { ...settled, status: "retracted" };
    }
    if (event.status === "retracted") {
        throw new MemoryEditRefusal("invalid", "A retracted event cannot be repaired");
    }
    if (edit.repair === "keep") {
        if (memoryAnchorState(event.sources, messages, hashOf) !== edit.state) {
            throw new MemoryEditRefusal("changed", "The chat changed after this event was shown");
        }
        const [now] = reconcileMemoryEvents([event], messages, hashOf);
        return now.status === "active" ? null : { ...settled, status: "active", keptState: edit.state };
    }
    if (memoryRerecordTarget(event.sources, messages) === null) {
        throw new MemoryEditRefusal("invalid", "This event has no reply left to record from");
    }
    return rerecord ? null : { ...event, rerecord: true };
}

/**
 * The pages of `pages` that change when `events` are the chat's events: a section with `provenance`
 * whose every id names a `retracted` event gains `unsupported`. An empty `provenance` does not count, an
 * id naming no event is not retracted, and a section already flagged changes nothing. Only the flag is
 * added.
 */
export function flagUnsupportedSections(
    pages: readonly MemoryPage[],
    events: readonly Pick<MemoryEvent, "id" | "status">[],
): MemoryPage[] {
    const retracted = new Set(events.flatMap(({ id, status }) => (status === "retracted" ? [id] : [])));
    const unsupported = ({ provenance, unsupported: flagged }: MemorySection) =>
        !flagged && provenance.length > 0 && provenance.every((id) => retracted.has(id));
    return pages.flatMap((page) =>
        page.sections.some(unsupported)
            ? [
                  {
                      ...page,
                      sections: page.sections.map((section) =>
                          unsupported(section) ? { ...section, unsupported: true } : section,
                      ),
                  },
              ]
            : [],
    );
}
