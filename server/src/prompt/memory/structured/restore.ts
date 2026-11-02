import {
    MEMORY_CONTEXT_MODES,
    MEMORY_EVENT_STATUSES,
    MEMORY_HISTORY_CHANGE_KINDS,
    MEMORY_KNOWLEDGE_STANCES,
    MEMORY_PAGE_TYPES,
    MEMORY_STALE_REASONS,
    MEMORY_THREAD_STATES,
    type MemoryAxes,
    type MemoryEvent,
    type MemoryEventDraft,
    type MemoryKnowledge,
    type MemoryPage,
    type MemoryPageHistoryEntry,
    type MemorySection,
    type MemorySectionContent,
    type MemoryThread,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import type { MemoryChanges, MemoryEventWrite } from "../../../data/memoryStore.ts";

/**
 * What the restore route keeps of a chat file's records, without any I/O. The route owns the fence and
 * the write.
 *
 * A file can come from anyone, the store checks only what its columns and rows need, and readers
 * dereference nested fields unguarded (`coveredMessages`, `retrieve.ts`, `card.ts`, `inherit.ts`, the
 * panel's tabs), so this checks a record's whole shape: every object, list, element, closed value, and
 * source the record types name.
 *
 * - `STRUCTURED_MEMORY_LIMITS` refuse nothing here, because genuine records pass them: 16 `close` ids after
 *   admission, 33 sections after an inherit, a person's 4,000-character scene section, and an event's
 *   `sources`, which have no limit. Nothing is cut either: a file restores as written, or not at all.
 * - No reference has to resolve. `writerRun` names a run no file holds, and an inherited record keeps ids
 *   of what stayed behind. Sources are not compared with the chat's messages: reconciliation answers for
 *   that.
 * - Fields the types do not name stay, unread, so a newer file loses nothing.
 * - Two fields of an event stay behind: `createdRevision`, which the store stamps, and `rerecord`, a
 *   request about the source chat that would spend a call nobody asked for, as on a copy. `keptState` stays.
 */

/** The records a request holds, ready for `store.memory.write`: no run and no removal. */
export type RestoredRecords = Required<Pick<MemoryChanges, "pages" | "events" | "threads">>;

/** Whether a value has the shape of one field. */
type Check = (value: unknown) => boolean;

/** A check for every field of `T`, so a field added to a record type cannot go unchecked. */
type FieldChecks<T> = { [K in keyof T]-?: Check };

const isText: Check = (value) => typeof value === "string";

const isFlag: Check = (value) => typeof value === "boolean";

const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);

const oneOf =
    (list: readonly string[]): Check =>
    (value) =>
        typeof value === "string" && list.includes(value);

const listOf =
    (check: Check): Check =>
    (value) =>
        Array.isArray(value) && value.every(check);

const optional =
    (check: Check): Check =>
    (value) =>
        value === undefined || check(value);

const nullable =
    (check: Check): Check =>
    (value) =>
        value === null || check(value);

/** An object with each field of `fields` in shape. Any other field it holds is left alone. */
const shaped =
    <T>(fields: FieldChecks<T>): Check =>
    (value) =>
        isPlainObject(value) && Object.entries<Check>(fields).every(([field, check]) => check(value[field]));

const isTexts = listOf(isText);

/** A string `messageId` with a whole anchor or none: a string hash with a position, or both null. */
const isSource: Check = (value) => {
    if (!isPlainObject(value) || typeof value.messageId !== "string") {
        return false;
    }
    const { hash, index } = value;
    return typeof hash === "string" ? Number.isSafeInteger(index) : hash === null && index === null;
};

const isAxes = shaped<MemoryAxes>({ persistence: isNumber, change: isNumber, reach: isNumber });

const contentChecks: FieldChecks<MemorySectionContent> = {
    body: isText,
    provenance: isTexts,
    sources: listOf(isSource),
};

const isSection = shaped<MemorySection>({
    ...contentChecks,
    heading: isText,
    locked: isFlag,
    updatedAt: isNumber,
    unsupported: optional(isFlag),
    disputed: optional(isFlag),
    pinned: optional(isFlag),
    suppressed: optional(isFlag),
    userCorrected: optional(isFlag),
});

const isHistoryEntry = shaped<MemoryPageHistoryEntry>({
    id: isText,
    heading: nullable(isText),
    before: nullable(shaped<MemorySectionContent>(contentChecks)),
    kind: oneOf(MEMORY_HISTORY_CHANGE_KINDS),
    highlighted: isFlag,
    revertedBy: optional(oneOf(["user"])),
    eventId: optional(isText),
    at: isNumber,
});

const isPage = shaped<MemoryPage>({
    id: isText,
    type: oneOf(MEMORY_PAGE_TYPES),
    title: isText,
    aliases: isTexts,
    contextMode: oneOf(MEMORY_CONTEXT_MODES),
    sections: listOf(isSection),
    links: isTexts,
    grade: optional(isNumber),
    gradeByUser: optional(isFlag),
    retrieval: shaped<MemoryPage["retrieval"]>({ keywords: isTexts, lastUsed: optional(isNumber) }),
    history: listOf(isHistoryEntry),
    participants: optional(isTexts),
});

const isKnowledge = shaped<MemoryKnowledge>({
    pageId: isText,
    fact: isText,
    stance: oneOf(MEMORY_KNOWLEDGE_STANCES),
    quote: isText,
    knowers: optional(isTexts),
    axes: optional(isAxes),
    grade: optional(isNumber),
});

const isOpenThreads = shaped<MemoryEventDraft["openThreads"]>({
    add: listOf(shaped<MemoryEventDraft["openThreads"]["add"][number]>({ title: isText, who: isTexts })),
    close: isTexts,
    transitions: listOf(
        shaped<MemoryEventDraft["openThreads"]["transitions"][number]>({
            threadId: isText,
            to: oneOf(MEMORY_THREAD_STATES),
        }),
    ),
});

const isEvent = shaped<Omit<MemoryEventWrite, "rerecord">>({
    id: isText,
    title: isText,
    summary: isText,
    participants: isTexts,
    storyTime: shaped<MemoryEvent["storyTime"]>({ text: isText, ordinal: optional(isNumber) }),
    keyLines: listOf(shaped<MemoryEvent["keyLines"][number]>({ speaker: isText, text: isText })),
    stateChanges: listOf(
        shaped<MemoryEvent["stateChanges"][number]>({
            pageId: isText,
            section: isText,
            before: isText,
            after: isText,
            quote: isText,
        }),
    ),
    knowledge: listOf(isKnowledge),
    relationshipShifts: listOf(
        shaped<MemoryEvent["relationshipShifts"][number]>({
            from: isText,
            to: isText,
            direction: isText,
            note: isText,
        }),
    ),
    openThreads: isOpenThreads,
    axes: optional(isAxes),
    sources: listOf(isSource),
    status: oneOf(MEMORY_EVENT_STATUSES),
    staleReason: optional(oneOf(MEMORY_STALE_REASONS)),
    keptState: optional(isText),
    writerRun: isText,
    grade: optional(isNumber),
    speakerId: optional(isText),
    repeatCount: optional(isNumber),
    adoptedSummaries: optional(isFlag),
    pinned: optional(isFlag),
    suppressed: optional(isFlag),
    userCorrected: optional(isFlag),
});

const isThread = shaped<MemoryThread>({
    id: isText,
    title: isText,
    who: isTexts,
    state: oneOf(MEMORY_THREAD_STATES),
    openedBy: optional(isText),
    closedBy: optional(isText),
});

/**
 * The records a request's `body` holds, or null for anything of the wrong shape. The three lists are the
 * body's, each record as sent but for the two event fields above, so nothing else of the body reaches the
 * store.
 */
export function parseRestoredRecords(body: unknown): RestoredRecords | null {
    if (!isPlainObject(body)) {
        return null;
    }
    const { pages, events, threads } = body;
    if (!listOf(isPage)(pages) || !listOf(isEvent)(events) || !listOf(isThread)(threads)) {
        return null;
    }
    return {
        pages: pages as MemoryPage[],
        events: (events as MemoryEvent[]).map(({ createdRevision, rerecord, ...event }): MemoryEventWrite => event),
        threads: threads as MemoryThread[],
    };
}
