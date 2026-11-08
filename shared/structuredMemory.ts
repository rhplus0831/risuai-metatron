import type { Message } from "./database.ts";
import { eligibleHistory } from "./eligibleHistory.ts";
import type { SerializableHypaV3Data, SerializableSummary } from "./memory.ts";
import { MAX_READ_RESPONSE_BYTES } from "./resources.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * Structured memory's records, kept per chat beside the chat's messages: events (what happened, one
 * per recorded window), pages (what is currently true of a character, place, or other subject),
 * threads (open promises and questions), and the writer's runs and receipts. The chat's messages stay
 * the evidence: records point at them through sources and copy no more of them than the bounded key
 * lines.
 *
 * The writer returns drafts (`MemoryAnalysisResult`); the fields only code decides, such as ids, grades,
 * and status, exist on the stored records alone, so a model's output can never set them.
 */

/** The value `memoryAlgorithmType` stores for this algorithm. Persisted: never rename it. */
export const STRUCTURED_MEMORY_ALGORITHM = "structuredMemory" as const;

/** The per-chat routes (`server/src/routes/structuredMemory.ts`). */
export const STRUCTURED_MEMORY_PATH = "/api/memory/structured";

/**
 * The `writerRun` of an event adopted from a chat's HypaV3 summaries. It names no run: adoption calls no
 * model and writes no run row. Persisted: never rename it.
 */
export const ADOPTED_WRITER_RUN = "adopted-hypav3";

/**
 * How a chat's records are made again from its transcript: `rebuild` takes every confirmed turn and
 * replaces what the transcript can reproduce, `backfill` only the turns no event cites and adds to the
 * records. Persisted: never rename one.
 */
export const STRUCTURED_MEMORY_REBUILD_MODES = ["rebuild", "backfill"] as const;
export type StructuredMemoryRebuildMode = (typeof STRUCTURED_MEMORY_REBUILD_MODES)[number];

/** What a page describes. A chat has exactly one `scene` page, rewritten rather than appended to. */
export const MEMORY_PAGE_TYPES = ["character", "location", "faction", "item", "concept", "scene", "note"] as const;
export type MemoryPageType = (typeof MEMORY_PAGE_TYPES)[number];

/** When a page reaches the prompt: on every send, when retrieval picks it, or not at all. */
export const MEMORY_CONTEXT_MODES = ["always", "auto", "never"] as const;
export type MemoryContextMode = (typeof MEMORY_CONTEXT_MODES)[number];

/**
 * A committed event's standing. Work not done yet is not a status: a failed first recording commits no
 * event, and a failed re-record leaves the committed event in place until its replacement succeeds, so
 * "pending" lives on the run and the receipt.
 */
export const MEMORY_EVENT_STATUSES = ["active", "retracted", "stale"] as const;
export type MemoryEventStatus = (typeof MEMORY_EVENT_STATUSES)[number];

/** A thread's lifecycle; the writer names transitions by the thread's id. */
export const MEMORY_THREAD_STATES = ["open", "progress", "partial", "done", "cancelled", "paused"] as const;
export type MemoryThreadState = (typeof MEMORY_THREAD_STATES)[number];

/** How firmly a knowledge item is held: `believes` may be wrong in the story. */
export const MEMORY_KNOWLEDGE_STANCES = ["knows", "believes"] as const;
export type MemoryKnowledgeStance = (typeof MEMORY_KNOWLEDGE_STANCES)[number];

/** Why an event's sources no longer match the chat. */
export const MEMORY_STALE_REASONS = ["changed", "missing", "inserted", "moved"] as const;
export type MemoryStaleReason = (typeof MEMORY_STALE_REASONS)[number];

/**
 * What a page history entry records; code derives "important" highlighting from it, never a model score.
 * `edit`, `revert`, `merge`, and `split` are a person's: a `revert` is what undid a writer's change, and
 * its `before` is the text it took back. A `merge` entry stands on each heading a merge touched on the
 * target, and a `split` on each heading that left the old page, so no older entry of that heading can be
 * reverted over what was reshaped.
 */
export const MEMORY_HISTORY_CHANGE_KINDS = [
    "create",
    "change",
    "contradiction",
    "delete",
    "compact",
    "edit",
    "revert",
    "merge",
    "split",
] as const;
export type MemoryHistoryChangeKind = (typeof MEMORY_HISTORY_CHANGE_KINDS)[number];

/** What a page patch does to its section. */
export const MEMORY_PATCH_OPS = ["upsert", "delete"] as const;
export type MemoryPatchOp = (typeof MEMORY_PATCH_OPS)[number];

/** How a patch's new value stands to the old one: the story moved on, or the two cannot both be true. */
export const MEMORY_PATCH_CONFLICTS = ["change", "contradiction"] as const;
export type MemoryPatchConflict = (typeof MEMORY_PATCH_CONFLICTS)[number];

/** How a writer run ended; `pending` while it has not. */
export const MEMORY_RUN_RESULTS = ["pending", "recorded", "failed", "skipped"] as const;
export type MemoryRunResult = (typeof MEMORY_RUN_RESULTS)[number];

/**
 * The outcome of one turn's recording, stored with its message. `pending` is never stored: only a tab
 * can tell a turn the writer has not reached yet, from the chat's live task.
 */
export const MEMORY_RECEIPT_STATES = ["recorded", "pending", "failed", "skipped", "notAutomatic"] as const;
export type MemoryReceiptState = (typeof MEMORY_RECEIPT_STATES)[number];

/** The read path's lanes, one per way a send selects memory for the prompt. */
export const MEMORY_MANIFEST_LANES = ["required", "flow", "pages", "events", "evidence", "threads"] as const;
export type MemoryManifestLane = (typeof MEMORY_MANIFEST_LANES)[number];

/** The kinds of record a send can include. */
export const MEMORY_MANIFEST_ITEM_KINDS = ["page", "event", "thread", "evidence"] as const;
export type MemoryManifestItemKind = (typeof MEMORY_MANIFEST_ITEM_KINDS)[number];

/**
 * When the writer records: after every confirmed turn, every `cadenceTurns` confirmed turns, once the
 * uncovered raw history reaches a token threshold, or only when the user asks.
 */
export const STRUCTURED_MEMORY_CADENCES = ["everyTurn", "everyK", "tokens", "manual"] as const;
export type StructuredMemoryCadence = (typeof STRUCTURED_MEMORY_CADENCES)[number];

/**
 * Which recorded changes are highlighted: none, the kinds the preset lists, or every one. A change that
 * replaces a person's correction is highlighted in all three.
 */
export const STRUCTURED_MEMORY_HIGHLIGHT_MODES = ["none", "important", "all"] as const;
export type StructuredMemoryHighlightMode = (typeof STRUCTURED_MEMORY_HIGHLIGHT_MODES)[number];

/** The change kinds the `important` highlight mode can list; a `change` counts from a grade up. */
export const STRUCTURED_MEMORY_HIGHLIGHT_KINDS = [
    "create",
    "contradiction",
    "delete",
    "change",
] as const satisfies readonly MemoryHistoryChangeKind[];
export type StructuredMemoryHighlightKind = (typeof STRUCTURED_MEMORY_HIGHLIGHT_KINDS)[number];

/**
 * The fixed slots of a character page, so retrieval and compaction can address them. On a character
 * page a section's `heading` holds the slot key; other page types use free headings.
 */
export const CHARACTER_SECTION_SLOTS = [
    "identity",
    "currentState",
    "relationships",
    "knowledge",
    "goals",
    "inventory",
    "openContinuity",
] as const;
export type CharacterSectionSlot = (typeof CHARACTER_SECTION_SLOTS)[number];

/** Bounds on stored records and the writer's prompt. Axes and grades are inclusive integers from 0. */
export const STRUCTURED_MEMORY_LIMITS = {
    keyLinesPerEvent: 5,
    stateChangesPerEvent: 8,
    knowledgePerEvent: 8,
    relationshipShiftsPerEvent: 8,
    /** Each of an event's thread lists: added, closed, and moved. */
    threadsPerEvent: 8,
    /** Page ids in one list: an event's participants, a thread's `who`, a knowledge item's `knowers`. */
    pageRefsPerItem: 16,
    pageCandidates: 8,
    /** The confidence a new page needs; anything less stays an unresolved mention. */
    createConfidence: 0.75,
    /** The confidence from which a contradiction supersedes; anything less keeps both values as disputed. */
    contradictionConfidence: 0.75,
    aliasesPerPage: 16,
    sectionsPerPage: 32,
    sectionBodyChars: 4000,
    /** The newest events and messages a section's `provenance` and `sources` each keep. */
    sectionEvidence: 32,
    /** Patches one call may return. */
    patchesPerCall: 32,
    /** One field of the scene: its place, time, or state. */
    sceneFieldChars: 800,
    /** Failed runs in a row after which automatic recording pauses until the user resumes it. */
    consecutiveFailures: 5,
    axisMax: 3,
    gradeMax: 9,
    /** The grade from which an event counts as important (`projectHypaV3Data`). */
    importantEventGrade: 6,
    /** Near-identical summaries: the character-bigram Jaccard index from which an event merges into the last one. */
    dedupeSimilarity: 0.8,
    eventTitleChars: 120,
    eventSummaryChars: 800,
    keyLineChars: 300,
    /** A fact, a state's values, or a relationship's note. */
    factChars: 300,
    threadTitleChars: 120,
    /** A short label: a speaker, a section heading, a relationship's direction, the story time. */
    labelChars: 120,
    /** The longest id a record can hold (`isValidResourceId`). */
    idChars: 512,
    /** A failed run's stored error. */
    runErrorChars: 2000,
    /** The model's answer a failed run keeps when it could not read that answer. */
    runAnswerChars: 20000,
    /** Entries each page keeps; the oldest go first. */
    pageHistoryEntries: 60,
    /** Pages the writer's prompt lists. */
    promptPages: 40,
    /** A listed page's last state in the writer's prompt, and what it shows of each section. */
    promptPageStateChars: 200,
    promptSectionSummaryChars: 120,
    /** What the writer's prompt shows of a character's `identity`, so a stale lasting fact stays in view. */
    promptIdentitySummaryChars: 400,
    /** Section bodies the patch call shows, across its pages. */
    promptPatchChars: 12000,
    /** Open threads the writer's prompt lists, the newest ones. */
    promptThreads: 40,
    /** The scene text the writer's prompt holds. */
    promptSceneChars: 2000,
    /** Messages before a window that the writer's prompt shows as context, and the text kept of each. */
    contextMessages: 3,
    contextMessageChars: 1000,
} as const;

/**
 * How long a section may grow by default for its page type, in `body.length`, before a change gets
 * the writer's compaction call. These are starting values, with no setting. A scene field is rewritten
 * whole and clamped, so its budget is that clamp and nothing compacts it.
 */
export const MEMORY_SECTION_BUDGETS = {
    character: 1600,
    location: 1200,
    faction: 1200,
    item: 800,
    concept: 1200,
    scene: STRUCTURED_MEMORY_LIMITS.sceneFieldChars,
    note: 1600,
} as const satisfies Record<MemoryPageType, number>;

/** Character slots with tighter compaction budgets than their page type, in `body.length`. */
export const MEMORY_CHARACTER_SLOT_BUDGETS = {
    knowledge: 1000,
    relationships: 1200,
} as const satisfies Partial<Record<CharacterSectionSlot, number>>;

/** The slot's budget on a character page, or the page type's budget for every other section. */
export function memorySectionBudget(type: MemoryPageType, heading: string): number {
    if (type === "character" && Object.hasOwn(MEMORY_CHARACTER_SLOT_BUDGETS, heading)) {
        return MEMORY_CHARACTER_SLOT_BUDGETS[heading as keyof typeof MEMORY_CHARACTER_SLOT_BUDGETS];
    }
    return MEMORY_SECTION_BUDGETS[type];
}

/** Whether `body`, a section of a page of `type` with `heading`, is past its budget. */
export function memorySectionOverBudget(type: MemoryPageType, heading: string, body: string): boolean {
    return body.length > memorySectionBudget(type, heading);
}

/** A message a record cites, as it was when the record was written. */
export interface MemoryAnchoredSource {
    messageId: string;
    /** SHA-256 of the stored message's role and `data`, never `generationInfo`, which changes without the text. */
    hash: string;
    /** The message's position in the chat. */
    index: number;
}

/**
 * A message cited by an adopted summary that was already gone: its anchor was never known, so nothing
 * can check it, and it forces its event `stale`.
 */
export interface MemoryUnanchoredSource {
    messageId: string;
    hash: null;
    index: null;
}

/** A source whose message disappears later stays anchored, keeping its original hash and index. */
export type MemorySource = MemoryAnchoredSource | MemoryUnanchoredSource;

/** The model's scores for a record, each 0 to `STRUCTURED_MEMORY_LIMITS.axisMax`; code computes grades from them. */
export interface MemoryAxes {
    persistence: number;
    change: number;
    reach: number;
}

/** The user's marks on a record, re-applied after a re-record so it cannot lose them. */
export interface MemoryTrustFlags {
    pinned?: boolean;
    suppressed?: boolean;
    userCorrected?: boolean;
}

/** One fact as the writer returns it; it carries no grade because code owns grades. */
export interface MemoryKnowledgeDraft {
    pageId: string;
    fact: string;
    stance: MemoryKnowledgeStance;
    /** Verbatim text of the window that supports the fact. */
    quote: string;
    /** Ids of the pages that know a secret; absent on common knowledge. */
    knowers?: string[];
    axes?: MemoryAxes;
}

/** The event fields the writer returns. */
export interface MemoryEventDraft {
    title: string;
    summary: string;
    /** Page ids. */
    participants: string[];
    /** Time inside the story, never a wall clock; `ordinal` orders events when the text cannot. */
    storyTime: { text: string; ordinal?: number };
    /** Verbatim lines from the window. */
    keyLines: { speaker: string; text: string }[];
    stateChanges: { pageId: string; section: string; before: string; after: string; quote: string }[];
    knowledge: MemoryKnowledgeDraft[];
    /** Directed from one page id to another. */
    relationshipShifts: { from: string; to: string; direction: string; note: string }[];
    openThreads: {
        add: { title: string; who: string[] }[];
        /** Thread ids. */
        close: string[];
        transitions: { threadId: string; to: MemoryThreadState }[];
    };
    axes?: MemoryAxes;
}

/** A stored knowledge item. */
export interface MemoryKnowledge extends MemoryKnowledgeDraft {
    /** 0 to `STRUCTURED_MEMORY_LIMITS.gradeMax`, computed by code. */
    grade?: number;
}

/**
 * A page the writer proposes to touch: an existing one by id, or a new one to create. The confidence
 * decides whether a create is admitted or left for the user.
 */
export type MemoryPageCandidate = { reason: string; confidence: number } & (
    | { targetId: string; create?: never }
    | { create: { type: MemoryPageType; title: string; aliases: string[] }; targetId?: never }
);

/** The scene as the writer returns it: a blank field, or an empty list, keeps what the scene page says. */
export interface MemorySceneDraft {
    /** Page ids. */
    participants: string[];
    place: string;
    time: string;
    state: string;
}

/** The writer's output as parsed, before admission and deduplication. */
export interface MemoryAnalysisResult {
    event: MemoryEventDraft;
    pageCandidates: MemoryPageCandidate[];
    /** Null when nothing about the scene changed; absent on a run stored before the writer read one. */
    scene?: MemorySceneDraft | null;
}

/** One change to one section, as the patch call returns it. */
export interface MemoryPatch {
    pageId: string;
    heading: string;
    op: MemoryPatchOp;
    /** The section's whole new text, on an upsert. */
    body?: string;
    conflict?: MemoryPatchConflict;
    /** The value a superseding upsert replaces. */
    was?: string;
    /** How sure a contradiction is, 0 to 1; absent counts as 0. */
    confidence?: number;
}

/** A recorded event. */
export interface MemoryEvent extends Omit<MemoryEventDraft, "knowledge">, MemoryTrustFlags {
    knowledge: MemoryKnowledge[];
    id: string;
    sources: MemorySource[];
    status: MemoryEventStatus;
    /** Set while `status` is `stale`, for the badge and the repair choices. */
    staleReason?: MemoryStaleReason;
    /**
     * What a person accepted with "keep": the event's `memoryAnchorState` at that moment. The event stands
     * only while that state does, so a later change of its sources shows again.
     */
    keptState?: string;
    /** A person's repair or an edit of a cited message asked for a re-record that has not committed yet. */
    rerecord?: boolean;
    /** The id of the run that first wrote it, or `ADOPTED_WRITER_RUN`, which names none. */
    writerRun: string;
    /** The chat's memory revision that committed it. */
    createdRevision: number;
    /** 0 to `STRUCTURED_MEMORY_LIMITS.gradeMax`, computed by code. */
    grade?: number;
    /** In group chats, the page id of the character whose turn this was. */
    speakerId?: string;
    /** How many near-identical events were merged into this one. */
    repeatCount?: number;
    /**
     * A rebuild made it over messages an adopted summary cites, so the chat's stored HypaV3 summaries are
     * still the ones a reset empties. It passes on through later rebuilds.
     */
    adoptedSummaries?: boolean;
}

/** What a revert restores together, so a body never returns with its replacement's evidence. */
export interface MemorySectionContent {
    body: string;
    /** The ids of the events the body comes from. */
    provenance: string[];
    sources: MemorySource[];
}

/** One section of a page. */
export interface MemorySection extends MemoryTrustFlags, MemorySectionContent {
    /** The slot key on a character page (`CHARACTER_SECTION_SLOTS`), a free heading elsewhere. */
    heading: string;
    /** A locked section is never changed by the writer: the guarantee against unreviewed change. */
    locked: boolean;
    /** `Date.now()` of the last change. */
    updatedAt: number;
    /**
     * The evidence does not answer for the body: each event in `provenance` was retracted or stayed out of
     * this copied chat, or the body holds a change from after a branch point that the page's history could
     * not rewind. Flagged for review, never reverted automatically.
     */
    unsupported?: boolean;
    /** The body holds two conflicting values because a contradiction fell below the confidence threshold. */
    disputed?: boolean;
}

/**
 * What a history entry keeps of a section: its content and the marks that were on it, each only while it
 * was set, so a revert gives the section back as it stood. An `edit` entry keeps the content alone.
 */
export type MemoryHistorySnapshot = MemorySectionContent &
    MemoryTrustFlags &
    Pick<MemorySection, "unsupported" | "disputed">;

/**
 * A replaced version of a section or page. The state after an entry is the next entry's `before` or
 * the live section, so no `after` is stored.
 */
export interface MemoryPageHistoryEntry {
    /** What a receipt's `historyId` addresses. */
    id: string;
    /** The section; null when the entry concerns the whole page. */
    heading: string | null;
    /** The content replaced; null when nothing was replaced. */
    before: MemoryHistorySnapshot | null;
    kind: MemoryHistoryChangeKind;
    /** Code asked a person to look at this writer's change; a person's own entries never are. */
    highlighted: boolean;
    /** Set when the user undid the change, so the writer does not propose it again. */
    revertedBy?: "user";
    /** The event that made the change; absent on a change the user made. */
    eventId?: string;
    /** `Date.now()` of the change. */
    at: number;
}

/** What is currently true of one subject. */
export interface MemoryPage {
    id: string;
    type: MemoryPageType;
    title: string;
    aliases: string[];
    contextMode: MemoryContextMode;
    sections: MemorySection[];
    /** Page ids. */
    links: string[];
    /** 0 to `STRUCTURED_MEMORY_LIMITS.gradeMax`. */
    grade?: number;
    /** The user set `grade`, which then outranks the one code computes. */
    gradeByUser?: boolean;
    retrieval: {
        keywords: string[];
        /** `Date.now()` of the last send that used the page. */
        lastUsed?: number;
    };
    /** Bounded by `STRUCTURED_MEMORY_LIMITS.pageHistoryEntries`, oldest first. */
    history: MemoryPageHistoryEntry[];
    /** The scene page's attendance: the page ids present, which drive retrieval and the speaker rules. */
    participants?: string[];
    /**
     * `Date.now()` of the page's move to the trash. A trashed page keeps its type and everything on it,
     * leaves every reader's list of the chat's pages, and is read by id alone, until a person restores
     * it or deletes it for good. The scene page is never trashed.
     */
    trashedAt?: number;
    /**
     * A person merged another page into this one or split it: what it holds is their arrangement, which
     * no history entry can be trusted to rewind, so a rebuild seeds the page whole and a branch leaves it
     * as it is. It outlives the bounded history.
     */
    reshaped?: true;
}

/** An open promise, foreshadowing, or question. */
export interface MemoryThread {
    id: string;
    title: string;
    /** Page ids. */
    who: string[];
    state: MemoryThreadState;
    /** The event that opened it; absent on a thread the user added. */
    openedBy?: string;
    /** The event that closed it. */
    closedBy?: string;
}

/** What one window's recording did, kept so its changes can be inspected. */
export interface MemoryReceipt {
    state: MemoryReceiptState;
    /** Why it was skipped, failed, or is not recording automatically. */
    reason?: string;
    runId?: string;
    eventId?: string;
    pages: {
        pageId: string;
        /** The page's title then, at most `labelChars`; absent on a receipt from before this was kept. */
        title?: string;
        created: boolean;
        /** Present only on a created page whose `create` entry was highlighted. */
        highlighted?: MemoryHistoryChangeKind;
        sections: {
            heading: string;
            beforeHash?: string;
            afterHash?: string;
            /** The page history entry a revert from the receipt addresses. */
            historyId?: string;
            /** The change's kind, present only on a change that was highlighted. */
            highlighted?: MemoryHistoryChangeKind;
        }[];
    }[];
    /** Candidates code turned down; `lowConfidence` ones are the unresolved mentions. */
    refused: { candidate: MemoryPageCandidate; refusal: string }[];
    /**
     * Items whose quote was not found in the window, or that name no page: kept out of the records and
     * listed here, never dropped.
     */
    unverified: { kind: string; text: string; reason?: string }[];
    warnings: { kind: string; pageId?: string; heading?: string; detail?: string }[];
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    /** The preset's own prompt replaced the default one for this recording. */
    customPrompt?: boolean;
    /**
     * A failed run's bounded, redacted error, kept on the receipt only under `customPrompt`, so the field or
     * slot a custom prompt lost is named where the person reads first, not only in the Log.
     */
    error?: string;
}

/** One writer run. */
export interface MemoryRun {
    id: string;
    /** The messages the run recorded. */
    window: MemoryAnchoredSource[];
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    result: MemoryRunResult;
    /** Why it was skipped. */
    reason?: string;
    error?: string;
    /**
     * The exact input, so a retry replays the same call; absent when no model call was made. Kept only
     * while a retry can use it: a commit that settles a run strips it from every run but the newest
     * failed or skipped one and any pending one, so a recorded run and a superseded failure hold none.
     */
    input?: string;
    /** `input`'s settings (`memorySettingsFingerprint`): a retry under other settings builds a new input. */
    settingsFingerprint?: string;
    /** The extraction as parsed; `eventId` is what was committed from it. */
    analysis?: MemoryAnalysisResult;
    /**
     * The patch call's exact input; absent when no such call was made, and stripped with `input` once no
     * retry can use it. A dry run's captured run keeps it, which is how the test run reports its call.
     */
    patchInput?: string;
    /** The patch call's answer as parsed. */
    patches?: MemoryPatch[];
    /**
     * The answer a failed run could not read, as the model wrote it, redacted and cut to `runAnswerChars`,
     * so a person can see what broke; absent on any other run.
     */
    answer?: string;
    eventId?: string;
    receipt?: MemoryReceipt;
    /** The preset's own prompt replaced the default one for this run. */
    customPrompt?: boolean;
    /** The language the run wrote in; absent on a run from before this was kept. */
    language?: string;
}

/** The writer's settings, kept in the memory preset (`normalizeStructuredMemorySettings`). */
export interface StructuredMemorySettings {
    /** The language the writer records in; `""` follows the UI language. */
    language: string;
    cadence: StructuredMemoryCadence;
    /** `everyK`: the confirmed turns between recordings; an integer >= 1. */
    cadenceTurns: number;
    /** `tokens` cadence under a `tokens` budget mode: the threshold; an integer >= 1. */
    cadenceTokens: number;
    /**
     * `tokens` cadence under a `ratio` budget mode: the threshold as a share of the max context, in
     * (0, 1). Each budget mode keeps the other's field, so switching back restores it.
     */
    cadenceRatio: number;
    /** The assistant turns a send keeps raw; an integer >= 1. */
    windowTurns: number;
    /** The latest events a send lists in the flow lane; an integer >= 0. */
    flowEvents: number;
    /** Each lane's token target; integers >= 0. */
    laneTargets: { pages: number; events: number; evidence: number; threads: number };
    /** The tokens the required lane may take before the send fails; an integer >= 1. */
    requiredCap: number;
    /** Reply screening: the texts that mark a message `excluded`, as a refusal or as a format failure. */
    screening: { refusal: string[]; format: string[] };
    /** Free text added to the writer's default prompt. */
    instructions: string;
    /** `analysisPrompt` and `patchPrompt` replace the default prompts. */
    fineTuning: boolean;
    /** ChatML of the analysis call under `fineTuning`. */
    analysisPrompt: string;
    /** ChatML of the patch call under `fineTuning`. */
    patchPrompt: string;
    /** The highlight mode of a chat without its own `structuredMemoryHighlight`. */
    highlightMode: StructuredMemoryHighlightMode;
    /** What the `important` mode highlights; empty highlights nothing. */
    highlightKinds: StructuredMemoryHighlightKind[];
    /** The grade from which a listed `change` is highlighted, 0 to `STRUCTURED_MEMORY_LIMITS.gradeMax`. */
    highlightChangeGrade: number;
    /** The memory card's volatile part goes right before the latest user message, the stable part stays. */
    volatileBeforeLastUser: boolean;
}

/** The kinds of record the read routes address by id. */
export const MEMORY_RECORD_KINDS = ["pages", "events", "threads", "runs"] as const;
export type StructuredMemoryRecordKind = (typeof MEMORY_RECORD_KINDS)[number];

/** The record each kind addresses. */
export type StructuredMemoryRecordOf = {
    pages: MemoryPage;
    events: MemoryEvent;
    threads: MemoryThread;
    runs: MemoryRun;
};

/** A table-of-contents row: the record's listed fields and the size of its stored text in bytes. */
type StructuredMemoryContentsRow<T, Field extends keyof T> = Pick<T, Field> & { bytes: number };

/**
 * A chat's records without their bodies, each list in storage order. `pages` lists the live pages alone;
 * a page in the trash is listed in `trash`, with no type, since its row carries none.
 */
export type StructuredMemoryContents = {
    revision: string;
    pages: StructuredMemoryContentsRow<MemoryPage, "id" | "type" | "title">[];
    trash: StructuredMemoryContentsRow<MemoryPage, "id" | "title">[];
    events: StructuredMemoryContentsRow<MemoryEvent, "id" | "title" | "status">[];
    threads: StructuredMemoryContentsRow<MemoryThread, "id" | "title" | "state">[];
    runs: StructuredMemoryContentsRow<MemoryRun, "id" | "result">[];
};

/**
 * What the memory panel offers for a chat's HypaV3 summaries, as the server sees them: the routes decide
 * from what is stored, so a tab's mirror never does. `adoptable` is the events a chat that waits for a
 * person's choice would adopt, 0 for one that does not wait. `declined` is that person's lasting no.
 * `resettable` says a reset would empty the stored summaries of an adopted chat.
 */
export type StructuredMemoryAdoption = { adoptable: number; declined: boolean; resettable: boolean };

/**
 * A chat's rebuild or backfill, which goes on until a swap or a person abandons it: `done` of `total`
 * windows, and why it last stopped, when it did for a reason. `resumable` falls for good when the whole
 * chat was replaced after it began, since that may have changed every message, and only abandoning is left.
 */
export type StructuredMemoryRebuild = {
    mode: StructuredMemoryRebuildMode;
    done: number;
    total: number;
    reason?: string;
    error?: string;
    resumable: boolean;
};

/**
 * What the health routes read of a chat's live records, with no message read: whether automatic
 * recording is paused (`writerPaused`), the events stored `stale`, the events not retracted that wait for
 * a re-record, and on the pages out of the trash the sections flagged `unsupported` and the sections past
 * their budget (`memorySectionOverBudget`).
 */
export type StructuredMemoryHealthFacts = {
    paused: boolean;
    storedStale: number;
    pendingRepairs: number;
    unsupportedSections: number;
    overBudgetSections: number;
};

/** A chat's health facts, or an entry whose stored byte charge exceeds the per-chat cap. */
export type StructuredMemoryHealthEntry = StructuredMemoryHealthFacts | "unavailable";

/** The most chats one request of the health route names. */
export const MEMORY_HEALTH_CHATS_MAX = 64;

/** The stored bytes of live pages, events, and runs one health request may scan, also the per-chat cap. */
export const MEMORY_HEALTH_ROUND_BYTES = 16 * 1024 * 1024;

/**
 * The health route's answer: a prefix of the request, in its order, each entry the chat's facts,
 * `"unavailable"` for a chat whose live pages, events, and runs exceed `MEMORY_HEALTH_ROUND_BYTES`, or
 * null for a chat that does not exist. Unavailable chats are not scanned or charged. After at least one
 * entry, the prefix stops before a chat whose charge would take the scan past that budget; the rest
 * goes in another request.
 */
export type StructuredMemoryHealthAnswer = { health: (StructuredMemoryHealthEntry | null)[] };

/**
 * The states of the memory health badge, worst first. The badge shows the first that holds:
 * `writerPaused` from the runs, `gap` and `staleEvents` from the last send's report and the stored
 * events, `unsupportedSections` and `pageOverBudget` from the live pages, `requiredOverCap` from the
 * last send's failure, and `unavailable` when the chat is too large to check. Known problems outrank
 * unavailable health. A custom writer prompt is not a health state: the run receipts show it.
 */
export const MEMORY_HEALTH_STATES = [
    "writerPaused",
    "gap",
    "staleEvents",
    "unsupportedSections",
    "requiredOverCap",
    "pageOverBudget",
    "unavailable",
] as const;
export type MemoryHealthState = (typeof MEMORY_HEALTH_STATES)[number];

/** The worst of the states that hold, or null when none does. */
export function memoryHealthState(holds: Readonly<Record<MemoryHealthState, boolean>>): MemoryHealthState | null {
    return MEMORY_HEALTH_STATES.find((state) => holds[state]) ?? null;
}

/**
 * The contents route's answer: a chat's records without their bodies, what the panel offers for its
 * summaries, its rebuild, the language of its newest recorded run, null with none or from before runs
 * kept one, its health entry, and the current tab-bound writer reason when its binding resolves.
 */
export type StructuredMemoryContentsAnswer = StructuredMemoryContents & {
    adoption: StructuredMemoryAdoption;
    rebuild: StructuredMemoryRebuild | null;
    recordedLanguage: string | null;
    health: StructuredMemoryHealthEntry;
    writerBlockingReason?: "pluginModel" | "requestTrigger" | null;
};

/** The abandon route's answer: the chat's memory revision, which it left alone, and whether a run went. */
export type StructuredMemoryAbandonAnswer = { revision: string; abandoned: boolean };

/** What a cost preview prices: a rebuild, a backfill, or a press of record now. */
export type StructuredMemoryCostMode = StructuredMemoryRebuildMode | "record";

/**
 * The cost route's answer. `calls` are the windows, one analysis call each, and so the least: a window may
 * add a patch call and compaction calls. `messages` are the messages those windows hold, and
 * `estimatedTokens` the input of the analysis calls alone (`memoryCostTokens`).
 */
export type StructuredMemoryCostAnswer = { calls: number; messages: number; estimatedTokens: number };

/**
 * What one analysis call costs past its window's messages, in tokens: the frame, the cast, the scene, the
 * threads, and the context messages. On the scripted 1,000-turn fixtures of 2026-11-03 it measured about 2,100
 * per call in English and 2,800-3,700 in Korean, growing with the cast (docs/audit/structured-memory-2026-11-03.md).
 * It is set high on purpose because a preview is better high than low (owner, 2026-11-08).
 */
export const MEMORY_CALL_OVERHEAD_TOKENS = 3000;

/**
 * One writer call's default prompt as the default-prompts route answers it: the ChatML frame as stored,
 * with its slots in place and no preset text, and the texts of its `format` and `rules` slots, which
 * carry the fields the validator checks.
 */
export type StructuredMemoryDefaultPrompt = { frame: string; format: string; rules: string };

/** The default-prompts route's answer: the analysis call's and the patch call's defaults. */
export type StructuredMemoryDefaultPromptsAnswer = {
    analysis: StructuredMemoryDefaultPrompt;
    patch: StructuredMemoryDefaultPrompt;
};

/**
 * What a test run says of one custom frame's slots: the call's default slots it does not quote, and the
 * names it quotes that are no slot of the call, which stay literal in the prompt. Both are warnings, not
 * failures; a missing required slot fails the run instead.
 */
export type StructuredMemorySlotWarnings = { unquoted: string[]; unknown: string[] };

/**
 * The `memoryTest` command's `done.result`: one run of the writer over the chat's last window, with
 * nothing saved. `outcome` is the writer's, or `none` when the chat has no window to test, in which case
 * `messageIds` is empty. `analysis` and `patches` are the model's answers as parsed, `patchCalled` says
 * the patch call ran, and the lists are what the run's receipt would have listed. `slots` is empty in
 * both calls while the preset's prompts do not replace the defaults.
 */
export type StructuredMemoryTestResult = {
    kind: "memoryTest";
    customPrompt: boolean;
    slots: { analysis: StructuredMemorySlotWarnings; patch: StructuredMemorySlotWarnings };
    messageIds: string[];
    outcome: "recorded" | "failed" | "skipped" | "none";
    reason?: string;
    error?: string;
    analysis?: MemoryAnalysisResult;
    patches?: MemoryPatch[];
    patchCalled: boolean;
    warnings: MemoryReceipt["warnings"];
    unverified: MemoryReceipt["unverified"];
    refused: MemoryReceipt["refused"];
    model?: string;
    inputTokens: number;
    outputTokens: number;
};

/**
 * The input tokens of `calls` analysis calls over windows of `windowBytes` UTF-8 bytes. An estimate at three
 * bytes a token, because a route has no job scope to reach a real tokenizer.
 */
export function memoryCostTokens(windowBytes: number, calls: number): number {
    return Math.ceil(windowBytes / 3) + calls * MEMORY_CALL_OVERHEAD_TOKENS;
}

/** The record route's answer: one record as stored. */
export type StructuredMemoryRecordAnswer<K extends StructuredMemoryRecordKind = StructuredMemoryRecordKind> = {
    revision: string;
    data: StructuredMemoryRecordOf[K];
};

/**
 * One round of the package route. `next` is the position to continue from in the list of the chat's
 * pages followed by its events, or null when the list is done.
 */
export type StructuredMemoryPackageRound = {
    revision: string;
    pages: MemoryPage[];
    events: MemoryEvent[];
    next: number | null;
};

/** An event as the coverage route lists it: what it says of its messages, with no text but its title. */
export type StructuredMemoryCoverageEvent = Pick<
    MemoryEvent,
    "id" | "title" | "status" | "staleReason" | "suppressed" | "keptState" | "rerecord"
> & {
    messageIds: string[];
    /** The smallest position its anchored sources stored, for an event none of whose messages is left. */
    sourceIndex: number | null;
    /** Its sources as `storedMemorySources` reads them, for the tab's own reconciliation. */
    sources: MemorySource[];
};

/**
 * A run that is not `recorded` as the coverage route lists it. `reason` is the run's own, else its
 * receipt's: a failed run keeps its code only on the receipt.
 */
export type StructuredMemoryCoverageRun = Pick<MemoryRun, "id" | "result" | "reason"> & { messageIds: string[] };

/**
 * One round of the coverage route: record facts, never a message's text or a run's error. `next` is the
 * position to continue from in the list of the chat's events followed by its runs that are not
 * `recorded`, or null when the list is done.
 */
export type StructuredMemoryCoverageRound = {
    revision: string;
    events: StructuredMemoryCoverageEvent[];
    runs: StructuredMemoryCoverageRun[];
    next: number | null;
};

/**
 * What a person can change of a chat's memory, one change per request. The tab never sends a record:
 * this closed union is all an edit can say, so history, provenance, a page's type, and ids cannot be
 * forged. A `page` edit names at least one of its fields, and a null `grade` clears the grade. An
 * `event` edit is a repair of a stale event, and `keep` names the `memoryAnchorState` the person saw.
 */
export type StructuredMemoryEdit =
    | { kind: "section"; pageId: string; heading: string; body: string }
    | { kind: "sectionLock"; pageId: string; heading: string; locked: boolean }
    | { kind: "page"; pageId: string; contextMode?: MemoryContextMode; grade?: number | null }
    | { kind: "thread"; threadId: string; state: MemoryThreadState }
    | { kind: "event"; eventId: string; repair: "rerecord" | "retract" }
    | { kind: "event"; eventId: string; repair: "keep"; state: string };

/** The edit route's answer: the record as it now stands, with the revision the next edit names. */
export type StructuredMemoryEditAnswer = { revision: string } & (
    | { kind: "pages"; data: MemoryPage }
    | { kind: "threads"; data: MemoryThread }
    | { kind: "events"; data: MemoryEvent }
);

/**
 * The revert route's answer: the page as it now stands, with the revision the next edit names, whether this
 * call undid the change, and how many events recorded after it stay. A change a person already undid answers
 * `reverted: false`, which is what a repeat finds.
 */
export type StructuredMemoryRevertAnswer = {
    revision: string;
    data: MemoryPage;
    reverted: boolean;
    laterEvents: number;
};

/**
 * What a person can do to a page as a whole, one tool per request (`structured/pages.ts`). The tab names
 * pages, headings, and aliases, never a record. `trash` keeps the page by id with everything on it, out of
 * every list; `untrash` brings it back; `purge` removes a trashed page for good. `merge` folds `sourceId`
 * into `targetId`, a live page of the same type, and trashes the source; `split` moves `headings`, a strict
 * subset of the page's, and `aliases`, a subset of its own, to a new page of its type titled `title`. The
 * scene page takes none of them.
 */
export type StructuredMemoryPageTool =
    | { kind: "trash"; pageId: string }
    | { kind: "untrash"; pageId: string }
    | { kind: "purge"; pageId: string }
    | { kind: "merge"; sourceId: string; targetId: string }
    | { kind: "split"; pageId: string; headings: string[]; title: string; aliases: string[] };

/**
 * The page tools route's answer: the revision the next edit names, and the page the tab shows now: the
 * trashed, restored, or merged-into page, a split's new page, or null after a purge.
 */
export type StructuredMemoryPageToolAnswer = { revision: string; data: MemoryPage | null };

/** The version the package's `timeline.md` and `threads.md` name; a package before `threads.md` is 1. */
export const MEMORY_PACKAGE_VERSION = 2;

/** One file of a Markdown package as the import route takes it: its path in the zip, and its text. */
export type StructuredMemoryImportFile = { path: string; text: string };

/**
 * Why a package file, or one event of the timeline, stays out of an import. `missingThreads` is the one
 * notice: a package before `threads.md` imports with its events' thread references dropped.
 */
export const MEMORY_IMPORT_REFUSALS = [
    "unknownFile",
    "unreadable",
    "newerVersion",
    "shape",
    "invalidId",
    "duplicateId",
    "secondScene",
    "tooLarge",
    "missingThreads",
] as const;
export type MemoryImportRefusalReason = (typeof MEMORY_IMPORT_REFUSALS)[number];

/** One refused file, `timeline.md#<event id>` for one event of the timeline, with what it got wrong. */
export type StructuredMemoryImportRefusal = { file: string; reason: MemoryImportRefusalReason; detail?: string };

/**
 * The import route's answer: the chat's memory revision, what one write took, or false when nothing was
 * written because the chat holds a row of any kind, waits for a person's choice on its HypaV3 summaries,
 * or the files hold no record, and what each refused file got wrong, in either case.
 */
export type StructuredMemoryImportAnswer = {
    revision: string;
    imported: { pages: number; events: number; threads: number } | false;
    refusals: StructuredMemoryImportRefusal[];
};

/**
 * The inherit route's answer: the new chat's memory revision, and whether records crossed from the source
 * chat in this call. None did when the new chat already holds a row, which is what a repeat finds, when
 * the source chat holds no page, event, or thread, or when the new chat's messages support none of them.
 * A decline can still have crossed.
 */
export type StructuredMemoryInheritAnswer = { revision: string; inherited: boolean };

/**
 * The adopt route's answer: the chat's memory revision, the events this call wrote, and how many of them
 * it stored stale. Both are 0 when the chat already holds a record, which is what a repeat finds, when it
 * declined, or when nothing is adoptable.
 */
export type StructuredMemoryAdoptAnswer = { revision: string; adopted: number; stale: number };

/**
 * The decline route's answer: the chat's memory revision, and whether this call declined. Only a chat that
 * waits for that choice does, so a repeat answers false.
 */
export type StructuredMemoryDeclineAnswer = { revision: string; declined: boolean };

/**
 * The reset route's answer: the chat's revision, not its memory revision, because a reset writes the chat,
 * and whether this call emptied its stored summaries.
 */
export type StructuredMemoryResetAnswer = { chatRevision: string; reset: boolean };

/**
 * One round of the threads route, which a chat file reads beside the package rounds, in ascending storage
 * seq order. Cursor is the inclusive starting seq (0 starts the list). `next` is the first unserved seq,
 * or null when the list is done.
 */
export type StructuredMemoryThreadsRound = {
    revision: string;
    threads: MemoryThread[];
    next: number | null;
};

/** What a chat file holds of a chat's memory. Never a run: a run holds a whole prompt, and a file can be passed on. */
export type StructuredMemoryFileRecords = { pages: MemoryPage[]; events: MemoryEvent[]; threads: MemoryThread[] };

/**
 * One chat's entry in the optional `structuredMemory` list of an exported `risuChat` or `risuAllChats` file.
 * The list sits beside the file's `data`, not in a chat, so a build that does not know it ignores it and no
 * chat stores it. `chatId` is the chat's id in the file. A chat with no page, event, or thread has no entry.
 */
export type StructuredMemoryFileEntry = StructuredMemoryFileRecords & { chatId: string };

/** The default body cap of the restore route: a stored record alone may reach one read round. */
export const MEMORY_RESTORE_BODY_BYTES = 2 * MAX_READ_RESPONSE_BYTES;

/**
 * The restore route's answer: the chat's memory revision, and whether this call wrote the records. It did
 * not when the chat already holds a row of any kind, or when the request held no record.
 */
export type StructuredMemoryRestoreAnswer = { revision: string; restored: boolean };

/** The most runs one round of the runs route holds, however small they are. */
export const MEMORY_RUNS_ROUND_ROWS = 50;

/** The most chats one request of the revisions route names. */
export const MEMORY_REVISION_CHATS_MAX = 2000;

/** The most projections one plugin read fetches, one after another (`src/ts/plugins/apiV3/v3.svelte.ts`). */
export const MEMORY_PROJECTIONS_PER_READ = 8;

/** The bound of one plugin read's refresh, which the read waits for: `authFetch` has none of its own. */
export const MEMORY_REFRESH_DEADLINE_MS = 5000;

/**
 * How long a chat's check stands from its answer, failed or not: a read inside it takes what is held. A
 * `display` handler reads on every rendered row and streamed render, and these requests count against a
 * rate limit the whole app shares.
 */
export const MEMORY_RECHECK_WINDOW_MS = 2000;

/**
 * The revisions route's answer, in the order the request named the chats: each chat's memory revision, or
 * null for a chat a whole read leaves as stored, so that it holds no projection.
 */
export type StructuredMemoryRevisionsAnswer = { revisions: (string | null)[] };

/**
 * A `hypaV3Data` that carries a seal (`sealHypaV3Data`). `structuredMemoryRevision` is the memory revision
 * the value was read at, on any value a read answers, so a whole read gives a tab its own baseline.
 * The tab keeps no independent memory token: `src/ts/storage/chatStore.svelte.ts` reads it from this value.
 */
export type SealedHypaV3Data = SerializableHypaV3Data & {
    structuredMemoryProjection: string;
    structuredMemoryRevision?: string;
};

/**
 * The projection route's answer: the chat's memory revision and its projection, as a whole read would
 * overlay it. `hypaV3Data` is null for a chat that read leaves as stored. Both are null under another
 * algorithm, which reads no memory table.
 */
export type StructuredMemoryProjectionAnswer = { revision: string | null; hypaV3Data: SealedHypaV3Data | null };

/** A run as the runs route answers it: the record without what only a retry reads. */
export type StructuredMemoryLogRun = Omit<MemoryRun, "input" | "settingsFingerprint">;

/**
 * One round of the runs route, newest first. Cursor 0 starts at the newest run; otherwise it is the
 * inclusive starting storage seq, descending. `total` counts the chat's runs, and `next` is the first
 * unserved older seq, or null when the list is done.
 */
export type StructuredMemoryRunsRound = {
    revision: string;
    total: number;
    runs: StructuredMemoryLogRun[];
    next: number | null;
};

/** One record a send included. */
export interface MemoryManifestItem {
    id: string;
    kind: MemoryManifestItemKind;
    lane: MemoryManifestLane;
    /** Why the lane selected it. */
    reason: string;
    tokens: number;
    /** An entry that held the item's tag after scripts and `editRequest` is in the final prompt. */
    verified: boolean;
}

/** The records one send included; candidates it left out are kept apart and are not items. */
export interface MemoryManifest {
    items: readonly MemoryManifestItem[];
}

/**
 * `String.prototype.toWellFormed`, which the server's `es2023` lib does not declare: under `u` a pair
 * reads as one code point, so only a lone surrogate matches.
 */
const wellFormed = (text: string) => text.replace(/\p{Cs}/gu, "�");

/**
 * An item's tag in the memory card, which is how a send finds the item's entries before taking it out.
 * A valid resource id can hold spaces, brackets, and lone surrogates, on which `encodeURIComponent`
 * would throw, so the tag holds the id encoded; a UUID is unchanged.
 */
export function itemTag({ lane, id }: Pick<MemoryManifestItem, "lane" | "id">): string {
    const encoded = encodeURIComponent(wellFormed(id));
    return lane === "flow" ? `[m:flow:${encoded}]` : `[m:${encoded}]`;
}

/**
 * The events as `hypaV3Data`, for readers that know only that shape: each active event, in the given
 * order, as one summary. Retracted and stale events are left out, as they are of the prompt. A summary
 * is important when its event is pinned or graded `importantEventGrade` or above.
 *
 * `metrics` come from `manifest` and are absent without one. They count only the events the send
 * verifiably used, by position in the returned `summaries`: `flow` as recent, `events` as similar, and
 * an event in both lanes in both lists. `lastImportantSummaries` and `lastRandomSummaries` stay empty:
 * a metric records why the send selected a record, no lane selects by importance, and a pin set after
 * the send must not rewrite that. No lane selects at random either; `lastDeferredSummaries` is absent.
 */
export function projectHypaV3Data(
    events: readonly MemoryEvent[],
    manifest?: MemoryManifest | null,
): SerializableHypaV3Data {
    const flowIds = new Set<string>();
    const eventsLaneIds = new Set<string>();
    for (const item of manifest?.items ?? []) {
        if (item.kind !== "event" || !item.verified) {
            continue;
        }
        if (item.lane === "flow") {
            flowIds.add(item.id);
        } else if (item.lane === "events") {
            eventsLaneIds.add(item.id);
        }
    }

    const summaries: SerializableSummary[] = [];
    const lastRecentSummaries: number[] = [];
    const lastSimilarSummaries: number[] = [];
    for (const event of events) {
        if (event.status !== "active") {
            continue;
        }
        if (flowIds.has(event.id)) {
            lastRecentSummaries.push(summaries.length);
        }
        if (eventsLaneIds.has(event.id)) {
            lastSimilarSummaries.push(summaries.length);
        }
        summaries.push({
            text: event.summary,
            chatMemos: event.sources.map((source) => source.messageId),
            isImportant:
                event.pinned === true ||
                (event.grade !== undefined && event.grade >= STRUCTURED_MEMORY_LIMITS.importantEventGrade),
        });
    }

    if (!manifest) {
        return { summaries };
    }
    return {
        summaries,
        metrics: {
            lastImportantSummaries: [],
            lastRecentSummaries,
            lastSimilarSummaries,
            lastRandomSummaries: [],
        },
    };
}

/**
 * Whether a stored `hypaV3Data` owns the field: it holds a summary. An empty value says nothing of a
 * chat's memory: opening the HypaV3 modal stores one, and its Reset leaves one
 * (`src/lib/Others/HypaV3Modal.svelte`). A chat's records take over from an empty value as if the field
 * were absent. The structured memory reset in `server/src/routes/structuredMemory.ts` unsets the field.
 */
export function hypaV3DataHoldsSummaries(value: unknown): boolean {
    return isPlainObject(value) && Array.isArray(value.summaries) && value.summaries.length > 0;
}

/** A 53-bit cyrb hash of `text`, in base 36: it tells values apart, and proves nothing about who wrote one. */
function stringDigest(text: string): string {
    let high = 0xdeadbeef;
    let low = 0x41c6ce57;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        high = Math.imul(high ^ unit, 2654435761);
        low = Math.imul(low ^ unit, 1597334677);
    }
    high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
    low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
    return (4294967296 * (2097151 & low) + (high >>> 0)).toString(36);
}

/** `value` as JSON with every object's keys sorted, so rebuilding an object in another order changes nothing. */
function sortedJson(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) =>
        isPlainObject(entry)
            ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : entry,
    );
}

/** The seal of a `hypaV3Data` value: its version and the digest of the whole value but the seal itself. */
function hypaV3Seal(value: Record<string, unknown>): string {
    const { structuredMemoryProjection: _seal, ...fields } = value;
    return `1:${stringDigest(sortedJson(fields))}`;
}

/**
 * `value` with a seal, which tells a tab it holds a projection, and with the memory `revision` it was read
 * at, when the caller gives one. The digest covers every field but the seal, the revision included, so a
 * change to any of them shows, whichever field it is. Only here does a value gain a revision: a projection
 * as such, which the upstream export writes, holds none.
 */
export function sealHypaV3Data(value: SerializableHypaV3Data, revision?: string): SealedHypaV3Data {
    const fields = revision === undefined ? value : { ...value, structuredMemoryRevision: revision };
    return { ...fields, structuredMemoryProjection: hypaV3Seal({ ...fields }) };
}

/** Whether `value` carries a seal, intact or not: such a value is a projection and is never stored. */
export function isSealedHypaV3Data(value: unknown): boolean {
    return isPlainObject(value) && Object.hasOwn(value, "structuredMemoryProjection");
}

/** The memory revision a sealed `value` was read at, undefined for a value that holds none. */
export function sealedHypaV3DataRevision(value: unknown): string | undefined {
    if (!isSealedHypaV3Data(value)) {
        return undefined;
    }
    const { structuredMemoryRevision: revision } = value as Record<string, unknown>;
    return typeof revision === "string" ? revision : undefined;
}

/** Whether `value` is a projection as a read answered it: sealed, with nothing changed since. */
export function sealedHypaV3DataIntact(value: unknown): boolean {
    return (
        isSealedHypaV3Data(value) &&
        (value as Record<string, unknown>).structuredMemoryProjection === hypaV3Seal(value as Record<string, unknown>)
    );
}

/** A record's grade: the sum of its axes, none without them. */
export function memoryGrade(axes: MemoryAxes | undefined): number | undefined {
    return axes ? axes.persistence + axes.change + axes.reach : undefined;
}

/**
 * Whether a thread in `state` is ended (`done` or `cancelled`). The writer gives it no more transitions
 * (`endedThread` in `server/src/prompt/memory/structured/analysis.ts`); only a person's edit through
 * `applyThreadEdit` in `server/src/prompt/memory/structured/edits.ts` can reopen it.
 */
export function memoryThreadEnded(state: MemoryThreadState): boolean {
    return state === "done" || state === "cancelled";
}

/** How many runs at the end of `runs` failed, recorded ones ending the count; others say nothing. */
function trailingFailures(runs: readonly Pick<MemoryRun, "result">[]): number {
    let failures = 0;
    for (let index = runs.length - 1; index >= 0 && runs[index].result !== "recorded"; index--) {
        if (runs[index].result === "failed") {
            failures++;
        }
    }
    return failures;
}

/** Whether automatic recording is paused: `consecutiveFailures` failed runs at the end of `runs`. */
export function writerPaused(runs: readonly Pick<MemoryRun, "result">[]): boolean {
    return trailingFailures(runs) >= STRUCTURED_MEMORY_LIMITS.consecutiveFailures;
}

/** Why the preset's screening keeps a reply out of the writer's windows; the Coverage view's reason codes. */
export type MemoryScreenReason = "screenedRefusal" | "screenedFormat";

/**
 * Whether `screening` keeps `message` out of everything the writer records, and as what: a reply whose
 * stored text holds one of the `refusal` texts, else one of the `format` texts, compared without case.
 * Only a reply is screened, and nothing is stored: each read decides again from the lists and the text
 * as they stand, so a list change takes effect on the next read. The raw text stays in the prompt.
 */
export function memoryScreenReason(
    message: Pick<Message, "role" | "data">,
    screening: StructuredMemorySettings["screening"],
): MemoryScreenReason | null {
    if (message.role !== "char" || (screening.refusal.length === 0 && screening.format.length === 0)) {
        return null;
    }
    const text = message.data.toLowerCase();
    const holds = (needle: string) => needle !== "" && text.includes(needle.toLowerCase());
    if (screening.refusal.some(holds)) {
        return "screenedRefusal";
    }
    return screening.format.some(holds) ? "screenedFormat" : null;
}

/**
 * One prompt history entry; a send lists them oldest first, from the greeting on, so no example or
 * new-chat marker is among them, and results address them by index.
 *
 * `role` is the stored message's, because assembly rewrites a prompt entry's role in a group chat and
 * under `sendName`; undefined means no stored message stands behind the entry. `messageId` is the
 * message's `chatId`, undefined on the greeting too. `text` is the entry's processed content, so
 * evidence quotes what the prompt would have shown, with a user's scripts applied.
 *
 * A stored message absent from the list (disabled, or before an `allBefore`) is just not in this send.
 */
export type ReadEntry = { messageId: string | undefined; role: Message["role"] | undefined; text: string };

/** The entries from `start` on stay raw; `dropped` holds the indices before it that an event covers. */
export type RawWindow = { start: number; dropped: ReadonlySet<number> };

/** Whether an event stands in for the messages it cites: a retracted, stale, or suppressed one never does. */
export function memoryEventCovers({ status, suppressed }: Pick<MemoryEvent, "status" | "suppressed">): boolean {
    return status === "active" && !suppressed;
}

/**
 * The ids of the messages that may leave the prompt: cited by an event that is active and not
 * suppressed, so a retracted or stale event never stands in for its messages.
 */
export function coveredMessages(events: readonly MemoryEvent[]): Set<string> {
    const covered = new Set<string>();
    for (const event of events) {
        if (memoryEventCovers(event)) {
            for (const source of event.sources) {
                covered.add(source.messageId);
            }
        }
    }
    return covered;
}

/**
 * The raw window over `entries`. Walking back, the assistant message past the last `windowTurns` closes
 * the window at the entry after it; with no such message, every entry stays. A `char` entry counts only
 * with text, and the role is the stored message's.
 */
export function rawWindow(
    entries: readonly ReadEntry[],
    { windowTurns, covered }: Pick<StructuredMemorySettings, "windowTurns"> & { covered: ReadonlySet<string> },
): RawWindow {
    let start = 0;
    let turns = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
        const { role, text } = entries[index];
        if (role === "char" && text.trim() !== "" && ++turns > windowTurns) {
            start = index + 1;
            break;
        }
    }
    const dropped = new Set<number>();
    for (let index = 0; index < start; index++) {
        const { messageId } = entries[index];
        if (messageId !== undefined && covered.has(messageId)) {
            dropped.add(index);
        }
    }
    return { start, dropped };
}

/** The group member attributed to a memory source; an absent or empty `saying` names no member. */
export function memorySourceSpeaker(message: { saying?: unknown }): string | null {
    return typeof message.saying === "string" && message.saying !== "" ? message.saying : null;
}

/** An HTML comment, or a tag: `<` then a letter, `/` or `!`, up to the next `>` with no `<` between. */
const MEMORY_SOURCE_MARKUP = /<!--[\s\S]*?-->|<[A-Za-z/!][^<>]*>/g;

/**
 * A message's `data` as memory reads it: HTML tags and comments removed with their inner text kept,
 * runs of blank lines collapsed to one, and the ends trimmed, so display markup a plugin adds (an
 * illustration block) neither changes a source's hash nor reaches the writer's prompt. A `<` not
 * followed by a letter, `/` or `!`, or with no `>` after it, stays (`a < b`). One regular expression,
 * so it is deterministic and linear in practice; it does not parse HTML: text shaped like a tag, such
 * as `<Name>`, is removed too, `<br>` joins its lines, and a `>` inside a quoted attribute ends the tag
 * early. Entities and CBS outside tags stay as written.
 */
export function memorySourceText(data: string): string {
    return data
        .replace(MEMORY_SOURCE_MARKUP, "")
        .replace(/\n(?:[ \t\r]*\n){2,}/g, "\n\n")
        .trim();
}

/** A source hash's version: what memory reads of a message under it. */
export type MemorySourceHashVersion = 1 | 2 | 3;

/** New hashes use version 3; a stored `v2:` hash keeps version 2, and one without a recognized prefix version 1. */
export function memorySourceHashVersion(hash?: string): MemorySourceHashVersion {
    if (typeof hash !== "string" || hash.startsWith("v3:")) {
        return 3;
    }
    return hash.startsWith("v2:") ? 2 : 1;
}

/**
 * What a source hash of `version` reads of a message, as the JSON array both hashers digest: version 1
 * role and `data`, version 2 also the normalized speaker, version 3 the speaker and `memorySourceText`
 * of `data` in place of the raw text.
 */
export function memorySourceHashFields(
    message: { role: unknown; data: string; saying?: unknown },
    version: MemorySourceHashVersion,
): string {
    const fields =
        version === 1
            ? [message.role, message.data]
            : [
                  message.role,
                  version === 2 ? message.data : memorySourceText(message.data),
                  memorySourceSpeaker(message),
              ];
    return JSON.stringify(fields);
}

/** A digest under `version` with its prefix: version 1 hashes are bare. */
export function memorySourceHashOf(hex: string, version: MemorySourceHashVersion): string {
    return version === 1 ? hex : `v${version}:${hex}`;
}

/**
 * A stored source list as sources, because the store does not check a record's shape. What is not an
 * object with a string `messageId` is no source, as the coverage route reads it, and a source without
 * a whole anchor reads as unanchored, so it forces its event `stale` rather than passing unchecked.
 */
export function storedMemorySources(stored: unknown): MemorySource[] {
    if (!Array.isArray(stored)) {
        return [];
    }
    return stored.flatMap((source): MemorySource[] => {
        if (!isPlainObject(source) || typeof source.messageId !== "string") {
            return [];
        }
        const { messageId, hash, index } = source;
        return typeof hash === "string" && Number.isSafeInteger(index)
            ? [{ messageId, hash, index: index as number }]
            : [{ messageId, hash: null, index: null }];
    });
}

/** What the anchor rules read of a chat: its messages, where each id sits, and the caller's hash. */
type MessageAnchors<M> = {
    messages: readonly M[];
    positions: ReadonlyMap<string, number>;
    hashOf: (message: M, like?: string) => string;
};

/** Built once for a list of events, so a long chat's lookups stay cheap. */
function messageAnchors<M extends Pick<Message, "chatId">>(
    messages: readonly M[],
    hashOf: (message: M, like?: string) => string,
): MessageAnchors<M> {
    const positions = new Map<string, number>();
    messages.forEach(({ chatId }, index) => {
        if (chatId !== undefined) {
            positions.set(chatId, index);
        }
    });
    return { messages, positions, hashOf };
}

const isAnchored = (source: MemorySource): source is MemoryAnchoredSource => source.hash !== null;

/**
 * Why `sources` no longer read from `messages`, or null when they do. The two sides hash a message
 * differently, so each passes its own `hashOf`.
 *
 * The first that holds: `missing`, a source is unanchored or its message is not in the list; `changed`,
 * a source's hash is not its message's. Then the sources in list order, which is append order (a repeat
 * appends sources captured at a later time, so a stored `index` says nothing of their order), each id
 * once, each against the one before it: `moved`, its position is lower; `inserted`, the gap is larger
 * than the stored gap, which counts only above 0.
 *
 * What moves every source alike is not stale: a message deleted or inserted before the event, or a
 * whole block moved. Neither is a smaller gap, which a removed message between them leaves, a disabled
 * source, which is still there with its hash, or a single source moved. The evidence is intact, and
 * every view uses current positions.
 */
function staleReasonOf<M>(
    sources: readonly MemorySource[],
    { messages, positions, hashOf }: MessageAnchors<M>,
): MemoryStaleReason | null {
    const anchored = sources.filter(isAnchored);
    if (anchored.length < sources.length || anchored.some(({ messageId }) => !positions.has(messageId))) {
        return "missing";
    }
    if (anchored.some(({ messageId, hash }) => hashOf(messages[positions.get(messageId)!], hash) !== hash)) {
        return "changed";
    }
    const seen = new Set<string>();
    let previous: { position: number; index: number } | undefined;
    for (const { messageId, index } of anchored) {
        if (seen.has(messageId)) {
            continue;
        }
        seen.add(messageId);
        const position = positions.get(messageId)!;
        if (previous) {
            const storedGap = index - previous.index;
            if (position < previous.position) {
                return "moved";
            }
            if (storedGap > 0 && position - previous.position > storedGap) {
                return "inserted";
            }
        }
        previous = { position, index };
    }
    return null;
}

function anchorStateOf<M>(sources: readonly MemorySource[], anchors: MessageAnchors<M>): string {
    let first: number | undefined;
    const parts = sources.map(({ messageId, hash }) => {
        const position = anchors.positions.get(messageId);
        if (position === undefined) {
            return [messageId];
        }
        first ??= position;
        return [messageId, anchors.hashOf(anchors.messages[position], hash ?? undefined), position - first];
    });
    return JSON.stringify(parts);
}

/**
 * What a person looks at when they keep an event, as one string: for each source in order, its id, its
 * message's hash under its stored source's version when there, and its position relative to the first
 * source present. An unanchored source uses the current hash version.
 * Hashes never read `generationInfo` and the position is relative, so a receipt or a shift of the whole
 * event leaves it alone.
 */
export function memoryAnchorState<M extends Pick<Message, "chatId">>(
    sources: unknown,
    messages: readonly M[],
    hashOf: (message: M, like?: string) => string,
): string {
    return anchorStateOf(storedMemorySources(sources), messageAnchors(messages, hashOf));
}

/**
 * `events` as `messages` leave them, on a copy: nothing is stored, and neither list is changed. An active
 * event with a stale reason (`staleReasonOf`) becomes a copy with `status: "stale"` and `staleReason`,
 * unless a person kept it in exactly the state it is in now (`keptState`). A retracted event, and one
 * stored `stale`, stay as they are, and so does every unaffected event: the same object.
 */
export function reconcileMemoryEvents<
    E extends Pick<MemoryEvent, "status" | "sources" | "keptState">,
    M extends Pick<Message, "chatId">,
>(events: readonly E[], messages: readonly M[], hashOf: (message: M, like?: string) => string): E[] {
    const anchors = messageAnchors(messages, hashOf);
    return events.map((event) => {
        if (event.status !== "active") {
            return event;
        }
        const sources = storedMemorySources(event.sources);
        const staleReason = staleReasonOf(sources, anchors);
        if (
            staleReason === null ||
            (event.keptState !== undefined && event.keptState === anchorStateOf(sources, anchors))
        ) {
            return event;
        }
        return { ...event, status: "stale", staleReason };
    });
}

/**
 * The message a re-record of `sources` is confirmed through: the id of the newest of them, by current
 * position, that a send reads (`eligibleHistory`), when that message is `char`. Null otherwise, also with
 * none left, so an event with nothing to record from cannot offer it.
 */
export function memoryRerecordTarget(
    sources: unknown,
    messages: readonly Pick<Message, "chatId" | "role" | "disabled">[],
): string | null {
    const cited = new Set(storedMemorySources(sources).map(({ messageId }) => messageId));
    const newest = eligibleHistory(messages).messages.findLast(
        ({ chatId }) => chatId !== undefined && cited.has(chatId),
    );
    return newest?.role === "char" ? newest.chatId! : null;
}

/** `value` when it is a member of `list`, else `undefined`. */
function memberOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
    return (list as readonly unknown[]).includes(value) ? (value as T) : undefined;
}

/** `value` when it is an integer in [`min`, `max`], else `fallback`. */
function integerIn(value: unknown, fallback: number, min: number, max = Infinity): number {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** The non-empty strings of `value`; empty when it is not an array. */
function textList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry !== "") : [];
}

/**
 * Writer settings with every field filled: each is checked on its own, an invalid one takes its
 * default, and unknown keys are dropped. The result shares nothing with `input` or with another
 * result.
 */
export function normalizeStructuredMemorySettings(input: unknown): StructuredMemorySettings {
    const source = isPlainObject(input) ? input : {};
    const laneTargets = isPlainObject(source.laneTargets) ? source.laneTargets : {};
    const screening = isPlainObject(source.screening) ? source.screening : {};
    const ratio = source.cadenceRatio;
    return {
        language: typeof source.language === "string" ? source.language : "",
        cadence: memberOf(STRUCTURED_MEMORY_CADENCES, source.cadence) ?? "everyTurn",
        cadenceTurns: integerIn(source.cadenceTurns, 5, 1),
        cadenceTokens: integerIn(source.cadenceTokens, 4000, 1),
        cadenceRatio: typeof ratio === "number" && ratio > 0 && ratio < 1 ? ratio : 0.1,
        windowTurns: integerIn(source.windowTurns, 3, 1),
        flowEvents: integerIn(source.flowEvents, 8, 0),
        laneTargets: {
            pages: integerIn(laneTargets.pages, 2000, 0),
            events: integerIn(laneTargets.events, 1500, 0),
            evidence: integerIn(laneTargets.evidence, 700, 0),
            threads: integerIn(laneTargets.threads, 300, 0),
        },
        requiredCap: integerIn(source.requiredCap, 1500, 1),
        screening: { refusal: textList(screening.refusal), format: textList(screening.format) },
        instructions: typeof source.instructions === "string" ? source.instructions : "",
        fineTuning: typeof source.fineTuning === "boolean" ? source.fineTuning : false,
        analysisPrompt: typeof source.analysisPrompt === "string" ? source.analysisPrompt : "",
        patchPrompt: typeof source.patchPrompt === "string" ? source.patchPrompt : "",
        highlightMode: memberOf(STRUCTURED_MEMORY_HIGHLIGHT_MODES, source.highlightMode) ?? "important",
        highlightKinds: Array.isArray(source.highlightKinds)
            ? [
                  ...new Set(
                      source.highlightKinds.flatMap((kind) => memberOf(STRUCTURED_MEMORY_HIGHLIGHT_KINDS, kind) ?? []),
                  ),
              ]
            : ["create", "contradiction", "delete"],
        highlightChangeGrade: integerIn(source.highlightChangeGrade, 5, 0, STRUCTURED_MEMORY_LIMITS.gradeMax),
        volatileBeforeLastUser:
            typeof source.volatileBeforeLastUser === "boolean" ? source.volatileBeforeLastUser : false,
    };
}

/** A chat's or its owner's writer language (`structuredMemoryLanguage`): a stored non-empty string, else none. */
export function structuredMemoryLanguageOverride(
    record: { structuredMemoryLanguage?: unknown } | undefined,
): string | undefined {
    const value = record?.structuredMemoryLanguage;
    return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The language the writer records a chat in: the chat's override, its owner's, the preset's, then the
 * app's. The writer and the panel's comparison with what a chat was recorded in read this one rule.
 */
export function structuredMemoryWriterLanguage(
    chat: { structuredMemoryLanguage?: unknown } | undefined,
    owner: { structuredMemoryLanguage?: unknown } | undefined,
    presetLanguage: string,
    appLanguage: string,
): string {
    return (
        structuredMemoryLanguageOverride(chat) ??
        structuredMemoryLanguageOverride(owner) ??
        (presetLanguage || appLanguage)
    );
}

/** A chat's highlight mode (`structuredMemoryHighlight`): a stored mode, else none. */
export function structuredMemoryHighlightOverride(
    chat: { structuredMemoryHighlight?: unknown } | undefined,
): StructuredMemoryHighlightMode | undefined {
    return memberOf(STRUCTURED_MEMORY_HIGHLIGHT_MODES, chat?.structuredMemoryHighlight);
}
