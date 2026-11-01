import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { Message } from "../../../../../shared/database.ts";
import {
    MEMORY_KNOWLEDGE_STANCES,
    MEMORY_PAGE_TYPES,
    MEMORY_THREAD_STATES,
    type MemoryAnalysisResult,
    type MemoryAxes,
    type MemoryEvent,
    type MemoryEventDraft,
    memoryGrade,
    type MemoryKnowledge,
    type MemoryKnowledgeDraft,
    type MemoryPageCandidate,
    type MemoryReceipt,
    type MemorySceneDraft,
    type MemoryThread,
    type MemoryThreadState,
    memoryThreadEnded,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import { type MemoryEventWrite, messageSourceHash } from "../../../data/memoryStore.ts";
import { nameKey, SCENE_SECTIONS, type Warning } from "./pages.ts";
import type { WriterWindow } from "./window.ts";

/**
 * What the writer keeps of a model's answer, without any I/O: `parseAnalysis` turns the text into a
 * bounded draft, and `admitAnalysis` turns the draft into records against the state it is given.
 *
 * The model's output is never trusted for what code owns. Ids, grades, status, and sources are code's;
 * a quote must be found in the window's raw messages, a page or thread id must exist, and whatever
 * fails is listed in the receipt and kept out of the records, never dropped silently.
 */

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
    /** This recording repeats the last stored event: `event` is that event. */
    repeated: boolean;
    /** The scene with its participants checked; null when the answer changes nothing about it. */
    scene: MemorySceneDraft | null;
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
export function readList<T>(
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

/** A finite number clamped to 0..1; undefined for anything else, as `1e999` parses to Infinity. */
export function readConfidence(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : undefined;
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

/** A candidate needs a confidence and either a `targetId` or a `create` of a known type with a title. */
function readCandidate(value: unknown, warnings: Warning[]): MemoryPageCandidate | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const { targetId, create, reason } = value;
    const confidence = readConfidence(value.confidence);
    if (confidence === undefined) {
        return undefined;
    }
    const fields = { reason: typeof reason === "string" ? clampText(reason, LIMITS.factChars) : "", confidence };
    if (typeof targetId === "string" && targetId !== "") {
        return { ...fields, targetId: clampText(targetId, LIMITS.idChars) };
    }
    const type = isPlainObject(create) ? MEMORY_PAGE_TYPES.find((entry) => entry === create.type) : undefined;
    if (!type || !isPlainObject(create) || typeof create.title !== "string" || create.title.trim() === "") {
        return undefined;
    }
    const aliases = readList(
        "pageCandidates.aliases",
        Array.isArray(create.aliases) ? create.aliases : [],
        LIMITS.aliasesPerPage,
        (alias) => (typeof alias === "string" ? clampText(alias, LIMITS.labelChars) : undefined),
        warnings,
    );
    return { ...fields, create: { type, title: clampText(create.title.trim(), LIMITS.labelChars), aliases } };
}

/** The answer's candidates, which may be missing; a value that is no list is counted as one malformed. */
function readCandidates({ pageCandidates }: Record<string, unknown>, warnings: Warning[]): MemoryPageCandidate[] {
    if (pageCandidates !== undefined && pageCandidates !== null && !Array.isArray(pageCandidates)) {
        warnings.push({ kind: "malformed", detail: "pageCandidates: 1" });
        return [];
    }
    const read = (value: unknown) => readCandidate(value, warnings);
    return readList("pageCandidates", pageCandidates ?? [], LIMITS.pageCandidates, read, warnings);
}

/** The answer's scene as a bounded draft: missing fields are blank, and anything of another type is no scene. */
function readScene({ scene }: Record<string, unknown>, warnings: Warning[]): MemorySceneDraft | null {
    if (scene === undefined || scene === null) {
        return null;
    }
    const fields = isPlainObject(scene) ? SCENE_SECTIONS.map((field) => scene[field] ?? "") : [];
    const participants = isPlainObject(scene) ? (scene.participants ?? []) : undefined;
    if (!Array.isArray(participants) || fields.some((field) => typeof field !== "string")) {
        warnings.push({ kind: "malformed", detail: "scene: 1" });
        return null;
    }
    const [place, time, state] = (fields as string[]).map((field) => clampText(field, LIMITS.sceneFieldChars));
    return { participants: readIds("scene.participants", participants, warnings), place, time, state };
}

/**
 * The JSON of a model's answer; undefined when it holds none. Thoughts go first; then the text from the
 * first brace to the last is the JSON, which leaves a Markdown fence and any words around the object
 * behind.
 */
export function answerJson(text: string): unknown {
    const answer = text.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, "");
    try {
        return JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
    } catch {
        return undefined;
    }
}

/**
 * A model's answer as a bounded draft (`answerJson`). The event may stand at the top level or under
 * `event`; page candidates and the scene are read from the top level either way, and both may be
 * missing, as `storyTime` may. A required field that is missing or mistyped fails the whole answer,
 * naming the field; a malformed list element is left out and counted.
 */
export function parseAnalysis(text: string): ParsedAnalysis {
    const parsed = answerJson(text);
    if (parsed === undefined) {
        return { ok: false, reason: "invalidJson", error: "The model's answer is not valid JSON" };
    }
    const root = isPlainObject(parsed) && isPlainObject(parsed.event) ? parsed.event : parsed;
    if (!isPlainObject(parsed) || !isPlainObject(root)) {
        return { ok: false, reason: "invalidJson", error: "The model's answer is not a JSON object" };
    }
    const warnings: Warning[] = [];
    try {
        const event = readDraft(root, warnings);
        const pageCandidates = readCandidates(parsed, warnings);
        return { ok: true, analysis: { event, pageCandidates, scene: readScene(parsed, warnings) }, warnings };
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
 * - Pages: a page reference is a page's id, or the title of a create it accepted (`created`). A
 *   participant, `who`, or knower that names neither is removed and a knowledge, state, or relationship
 *   item that names neither is left out, each listed, and `scene.participants` reads the same way.
 * - Threads: `add` makes a thread; `close` and `transitions`, in that order, move only a thread that
 *   exists and has not ended, and any other id is a warning. A thread named twice is written once, the
 *   last naming winning.
 * - A repeat of the last stored event (`repeatsEvent`) makes no new event: that event counts it and
 *   cites the window, or the window would stay open forever, and the thread changes name it. Everything
 *   else on it stays, pins included, and `speakerId` does not reach it.
 */
export function admitAnalysis(arg: {
    draft: MemoryEventDraft;
    /** What bounding the draft cut. */
    warnings: readonly Warning[];
    window: WriterWindow;
    runId: string;
    /** The ids of the chat's pages. */
    pages: ReadonlySet<string>;
    /** A page id by the name key of the title a create gave it (`PagePlan.names`). */
    created?: ReadonlyMap<string, string>;
    /** The scene as parsed. */
    scene?: MemorySceneDraft | null;
    /** The page of the group member whose turn this was. */
    speakerId?: string;
    /** The chat's threads the draft moves, as stored, by id. */
    threads: ReadonlyMap<string, MemoryThread>;
    /** The chat's last stored event. */
    lastEvent: MemoryEvent | null;
    /** The chat's stored messages. */
    messages: readonly Message[];
    newId: () => string;
}): Admission {
    const { draft, window, pages, threads, lastEvent, newId, speakerId } = arg;
    const warnings = [...arg.warnings];
    const unverified: MemoryReceipt["unverified"] = [];

    /** The page a reference names. */
    const pageOf = (reference: string) => (pages.has(reference) ? reference : arg.created?.get(nameKey(reference)));
    const named = (reference: string, field: string) => {
        if (pageOf(reference) === undefined) {
            warnings.push({ kind: "unknownPage", pageId: reference, detail: field });
            return false;
        }
        return true;
    };
    const existingPages = (ids: readonly string[], field: string) => [
        ...new Set(
            [...new Set(ids)].filter((reference) => named(reference, field)).map((reference) => pageOf(reference)!),
        ),
    ];
    /** Whether an item stands: its quote is in the window and the page it names, if any, exists. */
    const verified = (kind: string, quote: string, pageId?: string) => {
        const quoted = quote.trim() !== "" && window.messages.some(({ data }) => data.includes(quote));
        const reason = !quoted
            ? "quoteNotFound"
            : pageId !== undefined && pageOf(pageId) === undefined
              ? "unknownPage"
              : undefined;
        if (reason) {
            unverified.push({ kind, text: quote, reason });
        }
        return reason === undefined;
    };

    const participants = existingPages(draft.participants, "participants");
    const keyLines = draft.keyLines.filter(({ text }) => verified("keyLine", text));
    const stateChanges = draft.stateChanges
        .filter(({ quote, pageId }) => verified("stateChange", quote, pageId))
        .map((item) => ({ ...item, pageId: pageOf(item.pageId)! }));
    const knowledge = draft.knowledge
        .filter(({ quote, pageId }) => verified("knowledge", quote, pageId))
        .map((item): MemoryKnowledge => {
            const grade = memoryGrade(item.axes);
            return {
                ...item,
                pageId: pageOf(item.pageId)!,
                ...(item.knowers ? { knowers: existingPages(item.knowers, "knowledge.knowers") } : {}),
                ...(grade !== undefined ? { grade } : {}),
            };
        });
    const relationshipShifts = draft.relationshipShifts.flatMap((shift) => {
        const references = [...new Set([shift.from, shift.to])];
        return references.filter((reference) => named(reference, "relationshipShifts")).length === references.length
            ? [{ ...shift, from: pageOf(shift.from)!, to: pageOf(shift.to)! }]
            : [];
    });
    const scene = arg.scene
        ? { ...arg.scene, participants: existingPages(arg.scene.participants, "scene.participants") }
        : null;

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
              ...(speakerId !== undefined ? { speakerId } : {}),
          };
    return { event, threads: writtenThreads, unverified, warnings, repeated: repeated !== null, scene };
}
