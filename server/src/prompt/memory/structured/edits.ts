import {
    MEMORY_CONTEXT_MODES,
    MEMORY_THREAD_STATES,
    type MemoryPage,
    type MemoryPageHistoryEntry,
    type MemorySection,
    type MemoryThread,
    memoryThreadEnded,
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
 */

/** A page edit, which every kind but `thread` is. */
type PageEdit = Exclude<StructuredMemoryEdit, { kind: "thread" }>;

type ThreadEdit = Extract<StructuredMemoryEdit, { kind: "thread" }>;

/** What one edit stamps on what it changes. */
export type EditStamp = {
    /** `Date.now()` of the edit. */
    now: number;
    newId(): string;
};

/** Why a well-formed edit does not fit the record: the section is gone, or the page refuses the change. */
export class MemoryEditRefusal extends Error {
    readonly reason: "sectionGone" | "invalid";

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
 * a section's body must have text and fit `sectionBodyChars`, because nothing is cut to fit.
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
