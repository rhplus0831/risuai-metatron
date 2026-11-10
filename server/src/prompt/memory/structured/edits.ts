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
 * - Adding a section marks it user-corrected with empty evidence and an `edit` entry with no prior text
 *   or event. Scene and character pages have fixed headings; other pages need a new heading and room.
 * - Keeping an unsupported section clears its flag and drops retracted provenance, retaining all text,
 *   sources, and other marks. It optionally sets `userCorrected` for a full rebuild and takes no history.
 * - Releasing a section removes `userCorrected` and nothing else: the text is the writer's to change,
 *   compact, and drop at a full rebuild again. The lock, the text, and the history stay as they are.
 * - The scene page stays `always`: it is the stage every send reads.
 * - A thread that moves from an ended state to a non-ended state loses `closedBy`; moving between
 *   ended states keeps it.
 * - An event text edit changes only its title, summary, and `userCorrected` mark. Retracted events
 *   refuse text edits. Releasing the mark keeps every other field, even on a retracted event.
 * - A repair settles what reconciliation found. Retract takes an event out for good, and no control
 *   brings it back. Keep accepts what the person saw (`keptState`), and only that: a chat that moved on
 *   since then is refused, and a later change shows again. Re-record only marks the event, because the
 *   old one stays until the new one commits, so it changes neither its `sources` nor its `status`.
 * - Flagging a section left with only retracted events behind it changes no body, history, or `updatedAt`.
 *   Confirmed tail deletes may rewind writer-only history before flagging; a person's repair does not.
 */

/** An edit addressed to a page, including section additions, excluding thread and event controls. */
type PageEdit = Exclude<StructuredMemoryEdit, { kind: "thread" | "event" | "eventText" | "eventRelease" }>;

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
 * a section's body must have text and fit `sectionBodyChars`, because nothing is cut to fit. A new
 * section heading is trimmed, non-blank, and fits `labelChars`. Event
 * titles are trimmed and summaries keep their whitespace; both must have text and fit their limits.
 * A `keep` must name a state, the one repair that has any.
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
    if (kind === "eventText" || kind === "eventRelease") {
        const { eventId, title, summary } = value;
        if (typeof eventId !== "string") {
            return null;
        }
        if (kind === "eventRelease") {
            return { kind, eventId };
        }
        return typeof title === "string" &&
            title.trim() !== "" &&
            title.trim().length <= LIMITS.eventTitleChars &&
            typeof summary === "string" &&
            summary.trim() !== "" &&
            summary.length <= LIMITS.eventSummaryChars
            ? { kind, eventId, title: title.trim(), summary }
            : null;
    }
    if (typeof pageId !== "string") {
        return null;
    }
    if ((kind === "section" || kind === "sectionAdd") && typeof heading === "string") {
        if (kind === "sectionAdd" && (heading.trim() === "" || heading.trim().length > LIMITS.labelChars)) {
            return null;
        }
        const { body } = value;
        return typeof body === "string" && body.trim() !== "" && body.length <= LIMITS.sectionBodyChars
            ? { kind, pageId, heading: kind === "sectionAdd" ? heading.trim() : heading, body }
            : null;
    }
    if (kind === "sectionLock" && typeof heading === "string") {
        const { locked } = value;
        return typeof locked === "boolean" ? { kind, pageId, heading, locked } : null;
    }
    if (kind === "sectionKeep" && typeof heading === "string") {
        const { preserve } = value;
        return typeof preserve === "boolean" ? { kind, pageId, heading, preserve } : null;
    }
    if (kind === "sectionRelease" && typeof heading === "string") {
        return { kind, pageId, heading };
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

function addSection(page: MemoryPage, heading: string, body: string, stamp: EditStamp): MemoryPage {
    if (page.type === "scene" || page.type === "character") {
        throw new MemoryEditRefusal("invalid", "Scene and character pages cannot add sections");
    }
    if (page.sections.some((section) => section.heading === heading)) {
        throw new MemoryEditRefusal("invalid", "The page already has a section with that heading");
    }
    if (page.sections.length >= LIMITS.sectionsPerPage) {
        throw new MemoryEditRefusal("invalid", "The page has no room for another section");
    }
    const section: MemorySection = {
        heading,
        body,
        provenance: [],
        sources: [],
        locked: false,
        userCorrected: true,
        updatedAt: stamp.now,
    };
    const entry: MemoryPageHistoryEntry = {
        id: stamp.newId(),
        heading,
        before: null,
        kind: "edit",
        highlighted: false,
        at: stamp.now,
    };
    return {
        ...page,
        sections: [...page.sections, section],
        history: [...page.history, entry].slice(-LIMITS.pageHistoryEntries),
    };
}

/** No history entry and no `updatedAt`: the body did not change. */
function editLock(page: MemoryPage, heading: string, locked: boolean): MemoryPage | null {
    const section = sectionOf(page, heading);
    return section.locked === locked ? null : { ...page, sections: withSection(page, section, { ...section, locked }) };
}

/** A person's evidence review, with no body change, timestamp, or history entry. */
function keepSection(
    page: MemoryPage,
    heading: string,
    preserve: boolean,
    events: readonly Pick<MemoryEvent, "id" | "status">[],
): MemoryPage | null {
    const section = sectionOf(page, heading);
    if (!section.unsupported) {
        return null;
    }
    const retracted = new Set(events.filter(({ status }) => status === "retracted").map(({ id }) => id));
    const { unsupported, ...kept } = section;
    return {
        ...page,
        sections: withSection(page, section, {
            ...kept,
            provenance: section.provenance.filter((id) => !retracted.has(id)),
            ...(preserve ? { userCorrected: true } : {}),
        }),
    };
}

/** No history entry and no `updatedAt`: the body did not change, only who answers for it. */
function releaseSection(page: MemoryPage, heading: string): MemoryPage | null {
    const section = sectionOf(page, heading);
    if (!section.userCorrected) {
        return null;
    }
    const { userCorrected, ...released } = section;
    return { ...page, sections: withSection(page, section, released) };
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
 * bounded by `pageHistoryEntries`, with no `eventId`: it is a person's change, not a writer's.
 * An added section takes the same kind of entry with `before: null` and no evidence.
 * A section keep reads the events' stored statuses and writes no history, and neither does a release. A
 * page's grade edit sets `gradeByUser`; a null grade clears both fields. The route refuses pages in the
 * trash before applying.
 */
export function applyPageEdit(
    page: MemoryPage,
    edit: PageEdit,
    stamp: EditStamp,
    events: readonly Pick<MemoryEvent, "id" | "status">[] = [],
): MemoryPage | null {
    switch (edit.kind) {
        case "section":
            return editBody(page, edit.heading, edit.body, stamp);
        case "sectionAdd":
            return addSection(page, edit.heading, edit.body, stamp);
        case "sectionLock":
            return editLock(page, edit.heading, edit.locked);
        case "sectionKeep":
            return keepSection(page, edit.heading, edit.preserve, events);
        case "sectionRelease":
            return releaseSection(page, edit.heading);
        case "page":
            return editFields(page, edit);
    }
}

/**
 * `edit` over `thread`, the thread as stored: the thread to store, or null for no change. A person can
 * choose any state, including reopening an ended thread. Only an ended-to-non-ended transition clears
 * `closedBy`; switching between `done` and `cancelled` keeps it.
 */
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
 *
 * A keep acknowledges the message state the person saw, not just the memory revision: another tab can
 * change messages without changing that revision. It retains the recorded sources, since a missing
 * message has no new anchor. An already-active reconciled event needs no keep and returns null, even
 * with a `rerecord` mark; only a keep that writes a repair clears that mark and `staleReason`.
 */
export function applyEventRepair<M extends Pick<Message, "chatId" | "role" | "saying" | "disabled">>(
    event: MemoryEvent,
    edit: EventEdit,
    messages: readonly M[],
    hashOf: (message: M, like?: string) => string,
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

/** Changes only the text and its mark; equal text is a no-op, and retracted events refuse the edit. */
export function applyEventText(
    event: MemoryEvent,
    { title, summary }: Extract<StructuredMemoryEdit, { kind: "eventText" }>,
): MemoryEvent | null {
    if (event.status === "retracted") {
        throw new MemoryEditRefusal("invalid", "A retracted event cannot be edited");
    }
    return event.title === title && event.summary === summary
        ? null
        : { ...event, title, summary, userCorrected: true };
}

/** Removes only `userCorrected`, even from a retracted event; an unmarked event needs no write. */
export function applyEventRelease(event: MemoryEvent): MemoryEvent | null {
    if (!event.userCorrected) {
        return null;
    }
    const { userCorrected, ...released } = event;
    return released;
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
