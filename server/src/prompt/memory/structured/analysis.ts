import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { Message } from "../../../../../shared/database.ts";
import {
    MEMORY_KNOWLEDGE_STANCES,
    MEMORY_THREAD_STATES,
    type MemoryAnalysisResult,
    type MemoryAxes,
    type MemoryEvent,
    type MemoryEventDraft,
    memoryGrade,
    type MemoryKnowledge,
    type MemoryKnowledgeDraft,
    type MemoryReceipt,
    type MemoryThread,
    type MemoryThreadState,
    memoryThreadEnded,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import { type MemoryEventWrite, messageSourceHash } from "../../../data/memoryStore.ts";
import type { WriterWindow } from "./window.ts";

/**
 * What the writer keeps of a model's answer, without any I/O: `parseAnalysis` turns the text into a
 * bounded draft, and `admitAnalysis` turns the draft into records against the state it is given.
 *
 * The model's output is never trusted for what code owns. Ids, grades, status, and sources are code's;
 * a quote must be found in the window's raw messages, a page or thread id must exist, and whatever
 * fails is listed in the receipt and kept out of the records, never dropped silently.
 */

type Warning = MemoryReceipt["warnings"][number];

/** The draft and what bounding it cut, or why the answer cannot be used. */
export type ParsedAnalysis =
    | { ok: true; analysis: MemoryAnalysisResult; warnings: Warning[] }
    | { ok: false; reason: "invalidJson" | "invalidField"; error: string };

/** What one recording stores, and what the receipt lists about it. */
export type Admission = {
    /** A new event, or the last stored one with this recording merged into it. */
    event: MemoryEventWrite;
    threads: MemoryThread[];
    unverified: MemoryReceipt["unverified"];
    warnings: Warning[];
};

/** A required field that is missing or of the wrong type. */
class InvalidField extends Error {}

const requiredText = (record: Record<string, unknown>, field: string, limit: number): string => {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidField(field);
    }
    return clampText(value, limit);
};

const requiredList = (record: Record<string, unknown>, field: string, label = field): unknown[] => {
    const value = record[field];
    if (!Array.isArray(value)) {
        throw new InvalidField(label);
    }
    return value;
};

/** `value`'s named strings, each cut to its limit; undefined when it lacks one. */
function readStrings<K extends string>(value: unknown, limits: Record<K, number>): Record<K, string> | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const read = {} as Record<K, string>;
    for (const key of Object.keys(limits) as K[]) {
        const field = value[key];
        if (typeof field !== "string") {
            return undefined;
        }
        read[key] = clampText(field, limits[key]);
    }
    return read;
}

/**
 * What `read` accepts of `list`, at most `cap`. One warning per field counts the elements turned down
 * and one those past the cap, which are not read at all, so a long answer cannot grow the receipt.
 */
function readList<T>(
    field: string,
    list: readonly unknown[],
    cap: number,
    read: (value: unknown) => T | undefined,
    warnings: Warning[],
): T[] {
    const kept: T[] = [];
    let index = 0;
    for (; index < list.length && kept.length < cap; index++) {
        const element = read(list[index]);
        if (element !== undefined) {
            kept.push(element);
        }
    }
    const malformed = index - kept.length;
    if (malformed > 0) {
        warnings.push({ kind: "malformed", detail: `${field}: ${malformed}` });
    }
    if (index < list.length) {
        warnings.push({ kind: "capped", detail: `${field}: ${list.length - index}` });
    }
    return kept;
}

const readIds = (field: string, list: readonly unknown[], warnings: Warning[]): string[] =>
    readList(
        field,
        list,
        LIMITS.pageRefsPerItem,
        (value) => (typeof value === "string" ? clampText(value, LIMITS.idChars) : undefined),
        warnings,
    );

/** Scores rounded and clamped; an object that lacks a number is no axes at all. */
function readAxes(value: unknown): MemoryAxes | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const { persistence, change, reach } = value;
    if (typeof persistence !== "number" || typeof change !== "number" || typeof reach !== "number") {
        return undefined;
    }
    const axis = (score: number) => Math.min(Math.max(Math.round(score), 0), LIMITS.axisMax);
    return { persistence: axis(persistence), change: axis(change), reach: axis(reach) };
}

function readStoryTime(value: unknown): MemoryEventDraft["storyTime"] {
    if (!isPlainObject(value)) {
        return { text: "" };
    }
    const { text, ordinal } = value;
    return {
        text: typeof text === "string" ? clampText(text, LIMITS.labelChars) : "",
        // Finite: a store refuses anything else, and `1e999` parses to Infinity.
        ...(typeof ordinal === "number" && Number.isFinite(ordinal) ? { ordinal } : {}),
    };
}

function readKnowledge(value: unknown, warnings: Warning[]): MemoryKnowledgeDraft | undefined {
    const strings = readStrings(value, { pageId: LIMITS.idChars, fact: LIMITS.factChars, quote: LIMITS.keyLineChars });
    if (!strings || !isPlainObject(value)) {
        return undefined;
    }
    const stance = MEMORY_KNOWLEDGE_STANCES.find((entry) => entry === value.stance);
    const { knowers } = value;
    // Absent `knowers` mean common knowledge, so a secret must not read as that for a bad list.
    if (!stance || (knowers != null && !Array.isArray(knowers))) {
        return undefined;
    }
    const axes = readAxes(value.axes);
    return {
        ...strings,
        stance,
        ...(Array.isArray(knowers) ? { knowers: readIds("knowledge.knowers", knowers, warnings) } : {}),
        ...(axes ? { axes } : {}),
    };
}

function readAddedThread(
    value: unknown,
    warnings: Warning[],
): MemoryEventDraft["openThreads"]["add"][number] | undefined {
    const strings = readStrings(value, { title: LIMITS.threadTitleChars });
    if (!strings || !isPlainObject(value) || !Array.isArray(value.who)) {
        return undefined;
    }
    return { ...strings, who: readIds("openThreads.add.who", value.who, warnings) };
}

function readTransition(value: unknown): MemoryEventDraft["openThreads"]["transitions"][number] | undefined {
    const strings = readStrings(value, { threadId: LIMITS.idChars });
    if (!strings || !isPlainObject(value)) {
        return undefined;
    }
    const to = MEMORY_THREAD_STATES.find((entry) => entry === value.to);
    return to ? { ...strings, to } : undefined;
}

/** The bounded draft of `root`, or `InvalidField`. */
function readDraft(root: Record<string, unknown>, warnings: Warning[]): MemoryEventDraft {
    const title = requiredText(root, "title", LIMITS.eventTitleChars);
    const summary = requiredText(root, "summary", LIMITS.eventSummaryChars);
    const participants = requiredList(root, "participants");
    const keyLines = requiredList(root, "keyLines");
    const stateChanges = requiredList(root, "stateChanges");
    const knowledge = requiredList(root, "knowledge");
    const relationshipShifts = requiredList(root, "relationshipShifts");
    const { openThreads } = root;
    if (!isPlainObject(openThreads)) {
        throw new InvalidField("openThreads");
    }
    const added = requiredList(openThreads, "add", "openThreads.add");
    const closed = requiredList(openThreads, "close", "openThreads.close");
    const transitions = requiredList(openThreads, "transitions", "openThreads.transitions");
    const axes = readAxes(root.axes);
    return {
        title,
        summary,
        participants: readIds("participants", participants, warnings),
        storyTime: readStoryTime(root.storyTime),
        keyLines: readList(
            "keyLines",
            keyLines,
            LIMITS.keyLinesPerEvent,
            (value) => readStrings(value, { speaker: LIMITS.labelChars, text: LIMITS.keyLineChars }),
            warnings,
        ),
        stateChanges: readList(
            "stateChanges",
            stateChanges,
            LIMITS.stateChangesPerEvent,
            (value) =>
                readStrings(value, {
                    pageId: LIMITS.idChars,
                    section: LIMITS.labelChars,
                    before: LIMITS.factChars,
                    after: LIMITS.factChars,
                    quote: LIMITS.keyLineChars,
                }),
            warnings,
        ),
        knowledge: readList(
            "knowledge",
            knowledge,
            LIMITS.knowledgePerEvent,
            (value) => readKnowledge(value, warnings),
            warnings,
        ),
        relationshipShifts: readList(
            "relationshipShifts",
            relationshipShifts,
            LIMITS.relationshipShiftsPerEvent,
            (value) =>
                readStrings(value, {
                    from: LIMITS.idChars,
                    to: LIMITS.idChars,
                    direction: LIMITS.labelChars,
                    note: LIMITS.factChars,
                }),
            warnings,
        ),
        openThreads: {
            add: readList(
                "openThreads.add",
                added,
                LIMITS.threadsPerEvent,
                (value) => readAddedThread(value, warnings),
                warnings,
            ),
            close: readList(
                "openThreads.close",
                closed,
                LIMITS.threadsPerEvent,
                (value) => (typeof value === "string" ? clampText(value, LIMITS.idChars) : undefined),
                warnings,
            ),
            transitions: readList(
                "openThreads.transitions",
                transitions,
                LIMITS.threadsPerEvent,
                readTransition,
                warnings,
            ),
        },
        ...(axes ? { axes } : {}),
    };
}

/**
 * A model's answer as a bounded draft. Thoughts go first; then the text from the first brace to the
 * last is the JSON, which leaves a Markdown fence and any words around the object behind. The event
 * may stand at the top level or under `event`. A required field that is missing or mistyped fails the
 * whole answer, naming the field; a malformed list element is left out and counted; `storyTime` may be
 * missing. Page candidates are not read.
 */
export function parseAnalysis(text: string): ParsedAnalysis {
    const answer = text.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, "");
    let parsed: unknown;
    try {
        parsed = JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
    } catch {
        return { ok: false, reason: "invalidJson", error: "The model's answer is not valid JSON" };
    }
    const root = isPlainObject(parsed) && isPlainObject(parsed.event) ? parsed.event : parsed;
    if (!isPlainObject(root)) {
        return { ok: false, reason: "invalidJson", error: "The model's answer is not a JSON object" };
    }
    const warnings: Warning[] = [];
    try {
        return { ok: true, analysis: { event: readDraft(root, warnings), pageCandidates: [] }, warnings };
    } catch (error) {
        if (error instanceof InvalidField) {
            return {
                ok: false,
                reason: "invalidField",
                error: `The model's answer has no valid "${error.message}" field`,
            };
        }
        throw error;
    }
}

const bigramsOf = (text: string): Set<string> => {
    const characters = Array.from(text);
    return new Set(characters.slice(1).map((character, index) => characters[index] + character));
};

/** The Jaccard index of two texts' character bigrams. */
function bigramSimilarity(a: string, b: string): number {
    if (a === b) {
        return 1;
    }
    const left = bigramsOf(a);
    const right = bigramsOf(b);
    const shared = [...left].filter((bigram) => right.has(bigram)).length;
    const union = left.size + right.size - shared;
    return union === 0 ? 0 : shared / union;
}

/**
 * Whether a recording repeats `last`, the chat's last stored event: that event is active, names the
 * same participants, has a near-identical summary, and still reads from the chat as stored, since an
 * event whose evidence changed must not take on more.
 */
function repeatsEvent(
    last: MemoryEvent,
    summary: string,
    participants: readonly string[],
    messages: readonly Message[],
): boolean {
    const before = new Set(last.participants);
    if (
        last.status !== "active" ||
        before.size !== participants.length ||
        !participants.every((id) => before.has(id)) ||
        bigramSimilarity(last.summary, summary) < LIMITS.dedupeSimilarity
    ) {
        return false;
    }
    const stored = new Map(messages.map((message) => [message.chatId, message]));
    return last.sources.every((source) => {
        if (source.hash === null) {
            return true;
        }
        const message = stored.get(source.messageId);
        return message !== undefined && messageSourceHash(message) === source.hash;
    });
}

/**
 * The records a draft comes to against the state given, read fresh for each attempt.
 *
 * - Evidence: a key line's text and a knowledge or state item's `quote` must be a non-empty contiguous
 *   piece of a window message's raw `data`, never of a context message or of the text the prompt showed,
 *   so one that spans an `[Image]` fails. What fails goes to `unverified`.
 * - Pages: a participant, `who`, or knower that names no page is removed and a knowledge, state, or
 *   relationship item that names none is left out, each listed.
 * - Threads: `add` makes a thread; `close` and `transitions`, in that order, move only a thread that
 *   exists and has not ended, and any other id is a warning. A thread named twice is written once, the
 *   last naming winning.
 * - A repeat of the last stored event (`repeatsEvent`) makes no new event: that event counts it and
 *   cites the window, or the window would stay open forever, and the thread changes name it. Everything
 *   else on it stays, pins included.
 */
export function admitAnalysis(arg: {
    draft: MemoryEventDraft;
    /** What bounding the draft cut. */
    warnings: readonly Warning[];
    window: WriterWindow;
    runId: string;
    /** The ids of the chat's pages. */
    pages: ReadonlySet<string>;
    /** The chat's threads the draft moves, as stored, by id. */
    threads: ReadonlyMap<string, MemoryThread>;
    /** The chat's last stored event. */
    lastEvent: MemoryEvent | null;
    /** The chat's stored messages. */
    messages: readonly Message[];
    newId: () => string;
}): Admission {
    const { draft, window, pages, threads, lastEvent, newId } = arg;
    const warnings = [...arg.warnings];
    const unverified: MemoryReceipt["unverified"] = [];

    const existingPages = (ids: readonly string[], field: string) =>
        [...new Set(ids)].filter((id) => {
            if (!pages.has(id)) {
                warnings.push({ kind: "unknownPage", pageId: id, detail: field });
            }
            return pages.has(id);
        });
    /** Whether an item stands: its quote is in the window and the page it names, if any, exists. */
    const verified = (kind: string, quote: string, pageId?: string) => {
        const quoted = quote.trim() !== "" && window.messages.some(({ data }) => data.includes(quote));
        const reason = !quoted
            ? "quoteNotFound"
            : pageId !== undefined && !pages.has(pageId)
              ? "unknownPage"
              : undefined;
        if (reason) {
            unverified.push({ kind, text: quote, reason });
        }
        return reason === undefined;
    };

    const participants = existingPages(draft.participants, "participants");
    const keyLines = draft.keyLines.filter(({ text }) => verified("keyLine", text));
    const stateChanges = draft.stateChanges.filter(({ quote, pageId }) => verified("stateChange", quote, pageId));
    const knowledge = draft.knowledge
        .filter(({ quote, pageId }) => verified("knowledge", quote, pageId))
        .map((item): MemoryKnowledge => {
            const grade = memoryGrade(item.axes);
            return {
                ...item,
                ...(item.knowers ? { knowers: existingPages(item.knowers, "knowledge.knowers") } : {}),
                ...(grade !== undefined ? { grade } : {}),
            };
        });
    const relationshipShifts = draft.relationshipShifts.filter(({ from, to }) => {
        const named = new Set([from, to]);
        return existingPages([...named], "relationshipShifts").length === named.size;
    });

    const repeated = lastEvent && repeatsEvent(lastEvent, draft.summary, participants, arg.messages) ? lastEvent : null;
    const eventId = repeated ? repeated.id : newId();

    const added = draft.openThreads.add.map(({ title, who }) => ({
        title,
        who: existingPages(who, "openThreads.add.who"),
    }));
    const moved = new Map<string, MemoryThreadState>();
    const move = (id: string, state: MemoryThreadState) => {
        const thread = threads.get(id);
        if (thread && !memoryThreadEnded(thread.state)) {
            moved.set(id, state);
        } else {
            warnings.push({ kind: thread ? "endedThread" : "unknownThread", detail: id });
        }
    };
    for (const id of draft.openThreads.close) {
        move(id, "done");
    }
    for (const { threadId, to } of draft.openThreads.transitions) {
        move(threadId, to);
    }
    const writtenThreads: MemoryThread[] = [
        ...added.map(({ title, who }): MemoryThread => ({ id: newId(), title, who, state: "open", openedBy: eventId })),
        ...[...moved].map(([id, state]): MemoryThread => ({
            ...threads.get(id)!,
            state,
            ...(memoryThreadEnded(state) ? { closedBy: eventId } : {}),
        })),
    ];

    const grade = memoryGrade(draft.axes);
    const event: MemoryEventWrite = repeated
        ? {
              ...repeated,
              repeatCount: (repeated.repeatCount ?? 0) + 1,
              sources: [...repeated.sources, ...window.sources],
          }
        : {
              ...draft,
              participants,
              keyLines,
              stateChanges,
              knowledge,
              relationshipShifts,
              openThreads: {
                  add: added,
                  close: [...moved].flatMap(([id, state]) => (state === "done" ? [id] : [])),
                  transitions: [...moved].flatMap(([threadId, to]) => (to === "done" ? [] : [{ threadId, to }])),
              },
              id: eventId,
              sources: window.sources,
              status: "active",
              writerRun: arg.runId,
              ...(grade !== undefined ? { grade } : {}),
          };
    return { event, threads: writtenThreads, unverified, warnings };
}
