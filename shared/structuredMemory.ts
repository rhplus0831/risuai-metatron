import type { SerializableHypaV3Data, SerializableSummary } from "./memory.ts";
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

/** The per-chat read routes (`server/src/routes/structuredMemory.ts`). */
export const STRUCTURED_MEMORY_PATH = "/api/memory/structured";

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

/** What a page history entry records; code derives "important" highlighting from it, never a model score. */
export const MEMORY_HISTORY_CHANGE_KINDS = [
    "create",
    "change",
    "contradiction",
    "delete",
    "retract",
    "compact",
    "edit",
] as const;
export type MemoryHistoryChangeKind = (typeof MEMORY_HISTORY_CHANGE_KINDS)[number];

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

/** Which recorded changes are highlighted: none, the kinds the preset lists, or every one. */
export const STRUCTURED_MEMORY_HIGHLIGHT_MODES = ["none", "important", "all"] as const;
export type StructuredMemoryHighlightMode = (typeof STRUCTURED_MEMORY_HIGHLIGHT_MODES)[number];

/** The change kinds the `important` highlight mode can list; a `change` counts from a grade up. */
export const STRUCTURED_MEMORY_HIGHLIGHT_KINDS = [
    "create",
    "contradiction",
    "delete",
    "retract",
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
    /** Entries each page keeps; the oldest go first. */
    pageHistoryEntries: 60,
    /** Pages the writer's prompt lists. */
    promptPages: 40,
    /** Open threads the writer's prompt lists, the newest ones. */
    promptThreads: 40,
    /** The scene text the writer's prompt holds. */
    promptSceneChars: 2000,
    /** Messages before a window that the writer's prompt shows as context, and the text kept of each. */
    contextMessages: 3,
    contextMessageChars: 1000,
} as const;

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

/** The writer's output as parsed, before admission and deduplication. */
export interface MemoryAnalysisResult {
    event: MemoryEventDraft;
    pageCandidates: MemoryPageCandidate[];
}

/** A recorded event. */
export interface MemoryEvent extends Omit<MemoryEventDraft, "knowledge">, MemoryTrustFlags {
    knowledge: MemoryKnowledge[];
    id: string;
    sources: MemorySource[];
    status: MemoryEventStatus;
    /** Set while `status` is `stale`, for the badge and the repair choices. */
    staleReason?: MemoryStaleReason;
    /** The id of the run that wrote it. */
    writerRun: string;
    /** The chat's memory revision that committed it. */
    createdRevision: number;
    /** 0 to `STRUCTURED_MEMORY_LIMITS.gradeMax`, computed by code. */
    grade?: number;
    /** In group chats, the page id of the character whose turn this was. */
    speakerId?: string;
    /** How many near-identical events were merged into this one. */
    repeatCount?: number;
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
    /** Every event in `provenance` was retracted; flagged for review, never reverted automatically. */
    unsupported?: boolean;
    /** The body holds two conflicting values because a contradiction fell below the confidence threshold. */
    disputed?: boolean;
}

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
    before: MemorySectionContent | null;
    kind: MemoryHistoryChangeKind;
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

/** What one window's recording did, kept so every change can be seen and undone. */
export interface MemoryReceipt {
    state: MemoryReceiptState;
    /** Why it was skipped, failed, or is not recording automatically. */
    reason?: string;
    runId?: string;
    eventId?: string;
    pages: {
        pageId: string;
        created: boolean;
        sections: {
            heading: string;
            beforeHash?: string;
            afterHash?: string;
            /** The page history entry a revert from the receipt addresses. */
            historyId?: string;
        }[];
    }[];
    /** Candidates code turned down. */
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
    /** The exact input, so a retry replays the same call; absent when no model call was made. */
    input?: string;
    /** `input`'s settings (`memorySettingsFingerprint`): a retry under other settings builds a new input. */
    settingsFingerprint?: string;
    /** The extraction as parsed; `eventId` is what was committed from it. */
    analysis?: MemoryAnalysisResult;
    eventId?: string;
    receipt?: MemoryReceipt;
    /** The preset's own prompt replaced the default one for this run. */
    customPrompt?: boolean;
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

/** The contents route's answer: a chat's records without their bodies, each list in storage order. */
export type StructuredMemoryContentsAnswer = {
    revision: string;
    pages: StructuredMemoryContentsRow<MemoryPage, "id" | "type" | "title">[];
    events: StructuredMemoryContentsRow<MemoryEvent, "id" | "title" | "status">[];
    threads: StructuredMemoryContentsRow<MemoryThread, "id" | "title" | "state">[];
    runs: StructuredMemoryContentsRow<MemoryRun, "id" | "result">[];
};

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

/** One record a send included. */
export interface MemoryManifestItem {
    id: string;
    kind: MemoryManifestItemKind;
    lane: MemoryManifestLane;
    /** Why the lane selected it. */
    reason: string;
    tokens: number;
    /** The item's tag was found in the final prompt, after scripts and `editRequest`. */
    verified: boolean;
}

/** The records one send included; candidates it left out are kept apart and are not items. */
export interface MemoryManifest {
    items: readonly MemoryManifestItem[];
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
 * the send must not rewrite that.
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

/** A record's grade: the sum of its axes, none without them. */
export function memoryGrade(axes: MemoryAxes | undefined): number | undefined {
    return axes ? axes.persistence + axes.change + axes.reach : undefined;
}

/** Whether a thread in `state` is over: it takes no more transitions. */
export function memoryThreadEnded(state: MemoryThreadState): boolean {
    return state === "done" || state === "cancelled";
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
            : ["create", "contradiction", "delete", "retract"],
        highlightChangeGrade: integerIn(source.highlightChangeGrade, 5, 0, STRUCTURED_MEMORY_LIMITS.gradeMax),
    };
}

/** A chat's or its owner's writer language (`structuredMemoryLanguage`): a stored non-empty string, else none. */
export function structuredMemoryLanguageOverride(
    record: { structuredMemoryLanguage?: unknown } | undefined,
): string | undefined {
    const value = record?.structuredMemoryLanguage;
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** A chat's highlight mode (`structuredMemoryHighlight`): a stored mode, else none. */
export function structuredMemoryHighlightOverride(
    chat: { structuredMemoryHighlight?: unknown } | undefined,
): StructuredMemoryHighlightMode | undefined {
    return memberOf(STRUCTURED_MEMORY_HIGHLIGHT_MODES, chat?.structuredMemoryHighlight);
}
