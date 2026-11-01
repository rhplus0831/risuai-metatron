import { strToU8, zipSync, type Zippable } from "fflate";
import { eligibleHistory } from "../../../shared/contextReport.ts";
import type { Message } from "../../../shared/database.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    memoryEventCovers,
    rawWindow,
    STRUCTURED_MEMORY_PATH,
    type MemoryEvent,
    type MemoryPage,
    type ReadEntry,
    type StructuredMemoryContentsAnswer,
    type StructuredMemoryCoverageEvent,
    type StructuredMemoryCoverageRound,
    type StructuredMemoryCoverageRun,
    type StructuredMemoryLogRun,
    type StructuredMemoryPackageRound,
    type StructuredMemoryRecordAnswer,
    type StructuredMemoryRecordKind,
    type StructuredMemoryRunsRound,
} from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { ChatRef } from "../storage/chatStore.svelte";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { authFetch } from "../storage/serverAuth";

/**
 * The tab's reads of a chat's structured memory (`server/src/routes/structuredMemory.ts`), and the
 * downloadable package built from them: a zip of Markdown with one file per page and one timeline of
 * the events.
 *
 * In the package Markdown is display and the metadata lines are the authority. A metadata value is JSON
 * on one line, which is also valid YAML, and `bodyLines` and `summaryLines` count the lines of the text
 * they describe, so a body holding `## x` or `---` can still be split exactly.
 *
 * `memoryReceiptView` turns a message's stored receipt into what its receipt line shows.
 *
 * The memory panel's data is here too. `joinMemoryCoverage` joins the held messages with the record
 * facts the coverage route answers, because the tab holds the chat's whole message list and a route
 * has no job scope. `memoryRunView` turns a stored run into what a Log row shows.
 *
 * This module imports no alert or language module: the caller shows the notices for the outcomes the
 * reads return. It counts no tokens either, so it stays free of the tokenizer: the panel does that.
 */

/** Why a read did not answer: the chat or record is gone, the database was replaced, or its memory kept changing. */
export type StructuredMemoryRefusal = "chatGone" | "recordGone" | "epoch" | "changed";

export type StructuredMemoryResult<T> =
    | { outcome: "ok"; value: T }
    | { outcome: "refused"; reason: StructuredMemoryRefusal }
    | { outcome: "failed"; error: string };

type Unanswered = Exclude<StructuredMemoryResult<never>, { outcome: "ok" }>;

type AnswerBody = Record<string, unknown>;

/** The rounds of one package read, kept together once all of them answered at one revision. */
type PackageRead = { revision: string; pages: MemoryPage[]; events: MemoryEvent[] };

/** The chat's memory as the coverage route lists it, every round read at one revision. */
export type StructuredMemoryCoverage = Omit<StructuredMemoryCoverageRound, "next">;

/** Whole reads in all, the first included, before a chat whose memory keeps changing is refused. */
const WHOLE_READ_ATTEMPTS = 3;

const PACKAGE_VERSION = 1;

const LOG_VERSION = 1;

/** The most code points of a title in a page's file name. */
const FILE_TITLE_CODE_POINTS = 60;

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function readBody(response: Response): Promise<AnswerBody> {
    try {
        const parsed: unknown = await response.json();
        return parsed && typeof parsed === "object" ? (parsed as AnswerBody) : {};
    } catch {
        return {};
    }
}

/** The refusal or failure of a route's non-2xx answer (a 412 halts saving). */
function refusalOf(response: Response, body: AnswerBody): Unanswered {
    if (response.status === 412 && body.error === "EpochMismatch") {
        epochMismatch(typeof body.epoch === "string" ? body.epoch : "");
        return { outcome: "refused", reason: "epoch" };
    }
    if (response.status === 404 && (body.reason === "chatGone" || body.reason === "recordGone")) {
        return { outcome: "refused", reason: body.reason };
    }
    return {
        outcome: "failed",
        error: typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    };
}

/** A round's refusal: a 409 means the memory moved on since the revision the read named. */
function roundRefusalOf(response: Response, body: AnswerBody): Unanswered {
    return response.status === 409 ? { outcome: "refused", reason: "changed" } : refusalOf(response, body);
}

/** GETs `path` and turns its answer into a result: `parse` answers null for a body of the wrong shape. */
async function readAnswer<T>(
    path: string,
    parse: (body: AnswerBody) => T | null,
    refuse: (response: Response, body: AnswerBody) => Unanswered = refusalOf,
): Promise<StructuredMemoryResult<T>> {
    try {
        const response = await authFetch(path, {
            cache: "no-store",
            headers: { [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
        });
        const body = await readBody(response);
        if (!response.ok) {
            return refuse(response, body);
        }
        const value = parse(body);
        return value === null ? { outcome: "failed", error: "Unexpected answer" } : { outcome: "ok", value };
    } catch (error) {
        return { outcome: "failed", error: errorText(error) };
    }
}

/** What a receipt line shows: a stored outcome, or what the chat is doing when a row has none. */
export type MemoryReceiptViewKind =
    "recorded" | "failed" | "notAutomatic" | "paused" | "skipped" | "working" | "none" | "hidden";

export type MemoryReceiptView = {
    kind: MemoryReceiptViewKind;
    /** The stored reason code. */
    reason?: string;
    /** Events, pages, refused candidates, and unverified items the receipt lists. */
    counts: { events: number; pages: number; refused: number; unverified: number };
    /** The items behind the counts, as plain text, and what the recording cost. */
    warnings: { kind: string; detail?: string }[];
    unverified: { kind: string; text: string; reason?: string }[];
    refused: { candidate: string; refusal: string }[];
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    /** What the line's button does: record through this message, or resume recording. */
    action: "record" | "resume" | null;
};

const NO_RECEIPT_ITEMS = {
    counts: { events: 0, pages: 0, refused: 0, unverified: 0 },
    warnings: [],
    unverified: [],
    refused: [],
} satisfies Partial<MemoryReceiptView>;

/** The object entries of a stored list. */
function storedItems(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

const storedText = (value: unknown) => (typeof value === "string" ? value : undefined);

const storedCount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** `{ [key]: value }`, or nothing for a value the receipt does not hold. */
const present = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** A refused candidate as text: the title it would have created, else the page it named. */
function candidateText(candidate: unknown): string {
    const { create, targetId } = isPlainObject(candidate) ? candidate : {};
    return storedText(isPlainObject(create) ? create.title : undefined) ?? storedText(targetId) ?? "";
}

/** What a row without an outcome shows: only the chat's newest assistant message shows anything. */
function noOutcomeView(context: { newest: boolean; taskLive: boolean }): MemoryReceiptView {
    if (!context.newest) {
        return { ...NO_RECEIPT_ITEMS, kind: "hidden", action: null };
    }
    return { ...NO_RECEIPT_ITEMS, kind: context.taskLive ? "working" : "none", action: "record" };
}

/**
 * What a message's receipt line shows. `receipt` is stored data and read as such: a list of another
 * shape counts as empty, and a state this code does not know hides the line.
 *
 * Nothing stored says a turn is pending, and a message without a receipt is no proof that nothing was
 * recorded: a checkpoint load restores older rows while the memory tables survive, and a whole-row
 * write replaces the field. So such a row says nothing, except the chat's `newest` assistant message,
 * which is where the writer's next word lands: it reads as the writer working while the chat's task is
 * live (`taskLive`, about the chat, not this row), else as having no receipt yet.
 */
export function memoryReceiptView(
    receipt: unknown,
    context: { newest: boolean; taskLive: boolean },
): MemoryReceiptView {
    if (receipt === undefined || receipt === null) {
        return noOutcomeView(context);
    }
    if (!isPlainObject(receipt)) {
        return { ...NO_RECEIPT_ITEMS, kind: "hidden", action: null };
    }
    const reason = storedText(receipt.reason);
    const refused = storedItems(receipt.refused);
    const unverified = storedItems(receipt.unverified);
    const stored = {
        ...present("reason", reason),
        counts: {
            events: storedText(receipt.eventId) ? 1 : 0,
            pages: storedItems(receipt.pages).length,
            refused: refused.length,
            unverified: unverified.length,
        },
        warnings: storedItems(receipt.warnings).map(({ kind, detail }) => ({
            kind: storedText(kind) ?? "",
            ...present("detail", storedText(detail)),
        })),
        unverified: unverified.map((item) => ({
            kind: storedText(item.kind) ?? "",
            text: storedText(item.text) ?? "",
            ...present("reason", storedText(item.reason)),
        })),
        refused: refused.map((item) => ({
            candidate: candidateText(item.candidate),
            refusal: storedText(item.refusal) ?? "",
        })),
        ...present("model", storedText(receipt.model) || undefined),
        ...present("inputTokens", storedCount(receipt.inputTokens)),
        ...present("outputTokens", storedCount(receipt.outputTokens)),
    };
    switch (receipt.state) {
        case "recorded":
            return { ...stored, kind: "recorded", action: null };
        case "failed":
            return { ...stored, kind: "failed", action: "record" };
        case "notAutomatic":
            return { ...stored, kind: "notAutomatic", action: reason === "localSummarization" ? null : "record" };
        case "skipped":
            return reason === "writerPaused"
                ? { ...stored, kind: "paused", action: "resume" }
                : { ...stored, kind: "skipped", action: "record" };
        case "pending":
            return noOutcomeView(context);
        default:
            return { ...NO_RECEIPT_ITEMS, kind: "hidden", action: null };
    }
}

/**
 * The id of the newest assistant message a send reads (`eligibleHistory`, from the end so a long chat
 * costs nothing), or undefined with none.
 */
export function newestAssistantMessageId(messages: readonly DeepReadonly<Message>[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const { disabled, role, chatId } = messages[index];
        if (disabled === "allBefore") {
            return undefined;
        }
        if (disabled !== true && role === "char") {
            return chatId;
        }
    }
    return undefined;
}

function chatPath(ref: ChatRef): string {
    return `${STRUCTURED_MEMORY_PATH}/${encodeURIComponent(ref.chaId)}/${encodeURIComponent(ref.chatId)}`;
}

function parseContents(body: AnswerBody): StructuredMemoryContentsAnswer | null {
    const { revision, pages, events, threads, runs } = body;
    return typeof revision === "string" && [pages, events, threads, runs].every((list) => Array.isArray(list))
        ? (body as StructuredMemoryContentsAnswer)
        : null;
}

/** A round that cannot end the read's loop by moving forward is as wrong as a missing field. */
function isForward(next: unknown, cursor: number): boolean {
    return next === null || (Number.isSafeInteger(next) && (next as number) > cursor);
}

function parseRound(body: AnswerBody, cursor: number): StructuredMemoryPackageRound | null {
    const { revision, pages, events, next } = body;
    return typeof revision === "string" && Array.isArray(pages) && Array.isArray(events) && isForward(next, cursor)
        ? (body as StructuredMemoryPackageRound)
        : null;
}

function parseCoverageRound(body: AnswerBody, cursor: number): StructuredMemoryCoverageRound | null {
    const { revision, events, runs, next } = body;
    return typeof revision === "string" && Array.isArray(events) && Array.isArray(runs) && isForward(next, cursor)
        ? (body as StructuredMemoryCoverageRound)
        : null;
}

function parseRunsRound(body: AnswerBody, cursor: number): StructuredMemoryRunsRound | null {
    const { revision, total, runs, next } = body;
    return typeof revision === "string" &&
        storedCount(total) !== undefined &&
        Array.isArray(runs) &&
        isForward(next, cursor)
        ? (body as StructuredMemoryRunsRound)
        : null;
}

/** The chat's table of contents, read without any record's body. */
export function readStructuredMemoryContents(
    ref: ChatRef,
): Promise<StructuredMemoryResult<StructuredMemoryContentsAnswer>> {
    return readAnswer(chatPath(ref), parseContents);
}

/** One record of the chat by id, as stored. */
export function readStructuredMemoryRecord<K extends StructuredMemoryRecordKind>(
    ref: ChatRef,
    kind: K,
    id: string,
): Promise<StructuredMemoryResult<StructuredMemoryRecordAnswer<K>>> {
    return readAnswer(`${chatPath(ref)}/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, (body) =>
        typeof body.revision === "string" && isPlainObject(body.data)
            ? (body as StructuredMemoryRecordAnswer<K>)
            : null,
    );
}

/**
 * One whole read of a route's rounds: the rounds after the first name the first's revision, each goes
 * through `take`, and the answer is that revision.
 */
async function readRounds<Round extends { revision: string; next: number | null }>(
    path: string,
    parse: (body: AnswerBody, cursor: number) => Round | null,
    take: (round: Round) => void,
): Promise<StructuredMemoryResult<string>> {
    let revision: string | undefined;
    let cursor = 0;
    for (;;) {
        const position = cursor;
        const query = revision === undefined ? "" : `?cursor=${position}&revision=${encodeURIComponent(revision)}`;
        const round = await readAnswer(`${path}${query}`, (body) => parse(body, position), roundRefusalOf);
        if (round.outcome !== "ok") {
            return round;
        }
        take(round.value);
        revision ??= round.value.revision;
        if (round.value.next === null) {
            return { outcome: "ok", value: revision };
        }
        cursor = round.value.next;
    }
}

/**
 * Runs `read`, which reads the chat's memory whole and keeps nothing between calls, until it answers
 * something other than `changed`, `WHOLE_READ_ATTEMPTS` times at most: a chat that keeps changing is
 * refused `changed`. What `read` throws is a failure.
 */
async function readAtOneRevision<T>(
    read: () => Promise<StructuredMemoryResult<T>>,
): Promise<StructuredMemoryResult<T>> {
    try {
        for (let attempt = 0; attempt < WHOLE_READ_ATTEMPTS; attempt += 1) {
            const result = await read();
            if (result.outcome !== "refused" || result.reason !== "changed") {
                return result;
            }
        }
    } catch (error) {
        return { outcome: "failed", error: errorText(error) };
    }
    return { outcome: "refused", reason: "changed" };
}

/** Every page and event of the chat at one revision. */
async function readPackage(ref: ChatRef): Promise<StructuredMemoryResult<PackageRead>> {
    const pages: MemoryPage[] = [];
    const events: MemoryEvent[] = [];
    const read = await readRounds(`${chatPath(ref)}/package`, parseRound, (round) => {
        for (const page of round.pages) {
            pages.push(page);
        }
        for (const event of round.events) {
            events.push(event);
        }
    });
    return read.outcome === "ok" ? { outcome: "ok", value: { revision: read.value, pages, events } } : read;
}

/**
 * What the chat's events and unrecorded runs say of its messages, read whole at one revision. A change
 * of the chat's memory during the read restarts it with nothing kept, and a chat that keeps changing is
 * refused `changed`.
 */
export function readStructuredMemoryCoverage(ref: ChatRef): Promise<StructuredMemoryResult<StructuredMemoryCoverage>> {
    return readAtOneRevision(async () => {
        const events: StructuredMemoryCoverageEvent[] = [];
        const runs: StructuredMemoryCoverageRun[] = [];
        const read = await readRounds(`${chatPath(ref)}/coverage`, parseCoverageRound, (round) => {
            for (const event of round.events) {
                events.push(event);
            }
            for (const run of round.runs) {
                runs.push(run);
            }
        });
        return read.outcome === "ok" ? { outcome: "ok", value: { revision: read.value, events, runs } } : read;
    });
}

/**
 * One round of the chat's runs, newest first, from position `cursor`. `revision` ties a later round to
 * the first's: refused `changed` when the memory moved on, which restarts the list from the top.
 */
export function readStructuredMemoryRuns(
    ref: ChatRef,
    cursor = 0,
    revision?: string,
): Promise<StructuredMemoryResult<StructuredMemoryRunsRound>> {
    const tied = revision === undefined ? "" : `&revision=${encodeURIComponent(revision)}`;
    return readAnswer(
        `${chatPath(ref)}/runs?cursor=${cursor}${tied}`,
        (body) => parseRunsRound(body, cursor),
        roundRefusalOf,
    );
}

/** A metadata value on one line, or undefined for a value JSON has no text for. */
function metadataValue(value: unknown): string | undefined {
    return (JSON.stringify(value) as string | undefined)?.replace(
        /[\u007f-\u009f\u2028\u2029\ufeff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

/** One metadata line per field of `record`, in the record's order, leaving out `skipped`. */
function metadataLines(record: object, skipped: readonly string[]): string[] {
    return Object.entries(record).flatMap(([key, value]) => {
        const text = skipped.includes(key) ? undefined : metadataValue(value);
        return text === undefined ? [] : [`${key}: ${text}`];
    });
}

function collapsed(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function lineCount(text: string): number {
    return text.split("\n").length;
}

/** `lines` as a file's text, each one ended by a newline. */
function fileText(lines: readonly string[]): string {
    return `${lines.join("\n")}\n`;
}

/**
 * Where a page's file sits in the package. Only the id part makes the path unique, and the id is encoded
 * because a resource id may hold `/`.
 */
export function memoryPagePath(page: MemoryPage): string {
    const safeTitle = collapsed(page.title.replace(/[\\/:*?"<>|[\]\u0000-\u001f\u007f]/g, "_"));
    const title = [...safeTitle].slice(0, FILE_TITLE_CODE_POINTS).join("").trim() || "untitled";
    const id = encodeURIComponent(page.id).replace(/\*/g, "%2A");
    return `pages/${page.type}/${title} [${id}].md`;
}

/** A page's file: its fields as frontmatter, then each section under its heading with the body verbatim. */
export function renderMemoryPage(page: MemoryPage): string {
    const sections = page.sections.map(({ body, ...section }) => ({ ...section, bodyLines: lineCount(body) }));
    const lines = [
        "---",
        ...metadataLines(page, ["history", "sections"]),
        `sections: ${metadataValue(sections)}`,
        "---",
        "",
    ];
    for (const { heading, body } of page.sections) {
        lines.push(`## ${collapsed(heading)}`, "", body, "");
    }
    return fileText(lines);
}

/** The event's earliest anchored message position; Infinity without an anchored source. */
function firstSourceIndex(event: MemoryEvent): number {
    let first = Infinity;
    for (const { index } of event.sources) {
        if (index !== null && index < first) {
            first = index;
        }
    }
    return first;
}

/**
 * The timeline file: the events in message order (an event with no anchored source last, ties in the
 * given order), each with its fields in a YAML fence, its summary verbatim, and its key lines.
 */
export function renderMemoryTimeline(events: readonly MemoryEvent[], revision: string): string {
    const ordered = events
        .map((event) => ({ event, first: firstSourceIndex(event) }))
        .sort((a, b) => (a.first === b.first ? 0 : a.first - b.first));
    const lines = ["---", `packageVersion: ${PACKAGE_VERSION}`, `revision: ${metadataValue(revision)}`, "---", ""];
    for (const { event } of ordered) {
        lines.push(
            `## ${collapsed(event.title)}`,
            "",
            "```yaml",
            ...metadataLines(event, ["summary"]),
            `summaryLines: ${lineCount(event.summary)}`,
            "```",
            "",
            event.summary,
            "",
        );
        for (const { speaker, text } of event.keyLines) {
            lines.push(`> ${collapsed(speaker)}: ${collapsed(text)}`);
        }
        if (event.keyLines.length > 0) {
            lines.push("");
        }
    }
    return fileText(lines);
}

/** A chat's id as a file name's part: a resource id may hold what a file name cannot. */
function chatFilePart(ref: ChatRef): string {
    return encodeURIComponent(ref.chatId).replace(/%/g, "_");
}

function zipPackage(ref: ChatRef, { revision, pages, events }: PackageRead): { name: string; bytes: Uint8Array } {
    const files: Zippable = { "timeline.md": strToU8(renderMemoryTimeline(events, revision)) };
    for (const page of pages) {
        files[memoryPagePath(page)] = strToU8(renderMemoryPage(page));
    }
    return { name: `structured-memory-${chatFilePart(ref)}.zip`, bytes: zipSync(files) };
}

/**
 * The chat's pages and events as a zip for `downloadFile`. A change of the chat's memory during the read
 * restarts it with nothing kept, and a chat that keeps changing is refused `changed`.
 */
export function buildStructuredMemoryPackage(
    ref: ChatRef,
): Promise<StructuredMemoryResult<{ name: string; bytes: Uint8Array }>> {
    return readAtOneRevision(async () => {
        const read = await readPackage(ref);
        return read.outcome === "ok" ? { outcome: "ok", value: zipPackage(ref, read.value) } : read;
    });
}

/**
 * The chat's runs, newest first, as a JSON file for `downloadFile`: `{ logVersion, revision, runs }`.
 * A change of the chat's memory during the read restarts it with nothing kept, and a chat that keeps
 * changing is refused `changed`.
 */
export function buildStructuredMemoryLog(
    ref: ChatRef,
): Promise<StructuredMemoryResult<{ name: string; bytes: Uint8Array }>> {
    return readAtOneRevision(async () => {
        const runs: StructuredMemoryLogRun[] = [];
        const read = await readRounds(`${chatPath(ref)}/runs`, parseRunsRound, (round) => {
            for (const run of round.runs) {
                runs.push(run);
            }
        });
        if (read.outcome !== "ok") {
            return read;
        }
        const log = { logVersion: LOG_VERSION, revision: read.value, runs };
        return {
            outcome: "ok",
            value: {
                name: `structured-memory-log-${chatFilePart(ref)}.json`,
                bytes: strToU8(JSON.stringify(log, null, 2)),
            },
        };
    });
}

/** What the memory panel says of a stored message. */
export const MEMORY_COVERAGE_STATES = ["covered", "pending", "failed", "skipped", "excluded", "stale"] as const;
export type MemoryCoverageState = (typeof MEMORY_COVERAGE_STATES)[number];

/** One stored message in the Coverage view. */
export type MemoryCoverageRow = {
    id: string | undefined;
    /** The message's place in the chat, which is the row's as well. */
    index: number;
    role: Message["role"];
    state: MemoryCoverageState;
    /** The event that decided the state. */
    eventId?: string;
    /** The run that decided the state. */
    runId?: string;
    /** The stored reason code: `disabled`, `suppressed`, `retracted`, or a stale, run, or receipt code. */
    reason?: string;
};

export type MemoryCoverageJoin = {
    /** One row per stored message, in order. */
    rows: MemoryCoverageRow[];
    counts: Record<MemoryCoverageState, number>;
    /** Row indices: eligible messages older than the window that no covering event cites. */
    gap: number[];
    /** Row indices: covered messages older than the window, which leave the prompt. */
    leaving: number[];
};

/** A row's fields that the join decides. */
type CoverageDecision = Pick<MemoryCoverageRow, "state" | "eventId" | "runId" | "reason">;

/** What an event says of a message it cites. A higher `rank` wins, and a later event among equals. */
type Citation = Pick<MemoryCoverageRow, "state" | "reason"> & { eventId: string; rank: number };

function citationOf(event: StructuredMemoryCoverageEvent): Citation {
    const { id: eventId, status, staleReason } = event;
    if (memoryEventCovers(event)) {
        return { eventId, rank: 3, state: "covered" };
    }
    if (status === "stale") {
        return { eventId, rank: 2, state: "stale", reason: staleReason };
    }
    return status === "active"
        ? { eventId, rank: 1, state: "excluded", reason: "suppressed" }
        : { eventId, rank: 0, state: "excluded", reason: "retracted" };
}

/** The state a non-recorded run leaves on the messages it names. */
function runState({ result }: StructuredMemoryCoverageRun): MemoryCoverageState {
    return result === "failed" ? "failed" : result === "skipped" ? "skipped" : "pending";
}

/**
 * The Coverage view of a chat: `messages` as held, joined with the `facts` of its memory.
 *
 * A row's state comes from the first of these that holds. A message a send does not read
 * (`eligibleHistory`) is `excluded`. Then the events that cite it: `covered` by one that covers it,
 * else `stale`, else `excluded` by a suppressed event, else by a retracted one. Then the newest
 * non-recorded run that names it. Then its own stored receipt when that is a notice no run row stands
 * behind (`notAutomatic`, `skipped`), read as `skipped`. Anything else is `pending`: a missing receipt
 * proves nothing, so the newest reply reads `pending` too.
 *
 * `gap` and `leaving` come from `rawWindow` over the eligible stored messages, so they are a reading of
 * the stored text and not a send's prediction: a send works from processed text with the greeting, and
 * can also trim uncovered history that no longer fits. A send of a chat with `memoryOn` false runs no
 * memory, so nothing leaves.
 */
export function joinMemoryCoverage(
    messages: readonly DeepReadonly<Message>[],
    facts: Pick<StructuredMemoryCoverage, "events" | "runs">,
    { windowTurns, memoryOn }: { windowTurns: number; memoryOn: boolean },
): MemoryCoverageJoin {
    const citations = new Map<string, Citation>();
    const covered = new Set<string>();
    for (const event of facts.events) {
        const citation = citationOf(event);
        for (const id of event.messageIds) {
            if (citation.rank >= (citations.get(id)?.rank ?? 0)) {
                citations.set(id, citation);
            }
            if (citation.state === "covered") {
                covered.add(id);
            }
        }
    }
    // Storage order, so the newest run that names a message is the one left in the map.
    const runs = new Map<string, StructuredMemoryCoverageRun>();
    for (const run of facts.runs) {
        for (const id of run.messageIds) {
            runs.set(id, run);
        }
    }

    const eligible = eligibleHistory(messages.map(({ disabled }, index) => ({ disabled, index }))).messages;
    const read = new Set(eligible.map(({ index }) => index));
    const decide = ({ chatId: id, generationInfo }: DeepReadonly<Message>, index: number): CoverageDecision => {
        if (!read.has(index)) {
            return { state: "excluded", reason: "disabled" };
        }
        const citation = id === undefined ? undefined : citations.get(id);
        if (citation) {
            const { state, eventId, reason } = citation;
            return { state, eventId, ...present("reason", reason) };
        }
        const run = id === undefined ? undefined : runs.get(id);
        if (run) {
            return { state: runState(run), runId: run.id, ...present("reason", storedText(run.reason)) };
        }
        const { kind, reason } = memoryReceiptView(generationInfo?.memory, { newest: false, taskLive: false });
        return kind === "notAutomatic" || kind === "paused" || kind === "skipped"
            ? { state: "skipped", ...present("reason", reason) }
            : { state: "pending" };
    };
    const counts: MemoryCoverageJoin["counts"] = {
        covered: 0,
        pending: 0,
        failed: 0,
        skipped: 0,
        excluded: 0,
        stale: 0,
    };
    const rows = messages.map((message, index): MemoryCoverageRow => {
        const decision = decide(message, index);
        counts[decision.state] += 1;
        return { id: message.chatId, index, role: message.role, ...decision };
    });

    const entries = eligible.map(({ index }): ReadEntry => {
        const { chatId, role, data } = messages[index];
        return { messageId: chatId, role, text: data };
    });
    const { start, dropped } = rawWindow(entries, { windowTurns, covered });
    const gap: number[] = [];
    const leaving: number[] = [];
    for (let position = 0; position < start; position++) {
        if (!dropped.has(position)) {
            gap.push(eligible[position].index);
        } else if (memoryOn) {
            leaving.push(eligible[position].index);
        }
    }
    return { rows, counts, gap, leaving };
}

/** A run of consecutive rows in one state: `rows.slice(start, end)`. */
export type MemoryCoverageGroup = { state: MemoryCoverageState; start: number; end: number };

/** `rows` as runs of one state, which is what keeps a long chat's view cheap. */
export function groupMemoryCoverage(rows: readonly MemoryCoverageRow[]): MemoryCoverageGroup[] {
    const groups: MemoryCoverageGroup[] = [];
    rows.forEach(({ state }, index) => {
        const last = groups.at(-1);
        if (last?.state === state) {
            last.end = index + 1;
        } else {
            groups.push({ state, start: index, end: index + 1 });
        }
    });
    return groups;
}

/** The most code points of a message a Coverage row shows. */
const EXCERPT_CODE_POINTS = 120;

/** A stored message as one line of plain text. */
export function memoryMessageExcerpt(text: string): string {
    // UTF-16 units first, so a message of any size costs the same.
    const points = [...collapsed(text.slice(0, EXCERPT_CODE_POINTS * 4))];
    return points.length > EXCERPT_CODE_POINTS ? `${points.slice(0, EXCERPT_CODE_POINTS).join("")}…` : points.join("");
}

/** What a Log row's expanded view shows of the event a run extracted. */
export type MemoryRunEventView = {
    title: string;
    summary: string;
    storyTime: { text: string; ordinal?: number };
    participants: string[];
    keyLines: { speaker: string; text: string; unverified: boolean }[];
    stateChanges: {
        pageId: string;
        section: string;
        before: string;
        after: string;
        quote: string;
        unverified: boolean;
    }[];
    knowledge: {
        pageId: string;
        fact: string;
        stance: string;
        quote: string;
        knowers: string[];
        unverified: boolean;
    }[];
    relationshipShifts: { from: string; to: string; direction: string; note: string }[];
    threads: {
        added: { title: string; who: string[] }[];
        closed: string[];
        moved: { threadId: string; to: string }[];
    };
};

/** What a Log row shows of a run. */
export type MemoryRunView = {
    id: string;
    /** The positions the run's window held, first to last, and how many messages it held. */
    range: { first: number; last: number; count: number } | null;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    /** The stored result; a code this tab does not know stays as it is. */
    result: string;
    /** The run's stored reason code, else its receipt's. */
    reason?: string;
    error?: string;
    /** Null for a run with no extraction. */
    event: MemoryRunEventView | null;
    candidates: {
        title: string;
        pageType?: string;
        created: boolean;
        reason: string;
        confidence?: number;
    }[];
    unverified: MemoryReceiptView["unverified"];
    warnings: MemoryReceiptView["warnings"];
};

const quoteKey = (kind: string, text: string) => `${kind}\u0000${text}`;

const storedTexts = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function runEventView(event: Record<string, unknown>, unverified: ReadonlySet<string>): MemoryRunEventView {
    const text = (value: unknown) => storedText(value) ?? "";
    const threads = isPlainObject(event.openThreads) ? event.openThreads : {};
    const storyTime = isPlainObject(event.storyTime) ? event.storyTime : {};
    return {
        title: text(event.title),
        summary: text(event.summary),
        storyTime: { text: text(storyTime.text), ...present("ordinal", storedCount(storyTime.ordinal)) },
        participants: storedTexts(event.participants),
        keyLines: storedItems(event.keyLines).map((line) => ({
            speaker: text(line.speaker),
            text: text(line.text),
            unverified: unverified.has(quoteKey("keyLine", text(line.text))),
        })),
        stateChanges: storedItems(event.stateChanges).map((change) => ({
            pageId: text(change.pageId),
            section: text(change.section),
            before: text(change.before),
            after: text(change.after),
            quote: text(change.quote),
            unverified: unverified.has(quoteKey("stateChange", text(change.quote))),
        })),
        knowledge: storedItems(event.knowledge).map((item) => ({
            pageId: text(item.pageId),
            fact: text(item.fact),
            stance: text(item.stance),
            quote: text(item.quote),
            knowers: storedTexts(item.knowers),
            unverified: unverified.has(quoteKey("knowledge", text(item.quote))),
        })),
        relationshipShifts: storedItems(event.relationshipShifts).map((shift) => ({
            from: text(shift.from),
            to: text(shift.to),
            direction: text(shift.direction),
            note: text(shift.note),
        })),
        threads: {
            added: storedItems(threads.add).map((thread) => ({
                title: text(thread.title),
                who: storedTexts(thread.who),
            })),
            closed: storedTexts(threads.close),
            moved: storedItems(threads.transitions).map((move) => ({
                threadId: text(move.threadId),
                to: text(move.to),
            })),
        },
    };
}

/**
 * What a Log row shows of `run`, which is stored data and read as such: a field of another shape counts
 * as missing. A quote the receipt's `unverified` lists is marked; that list names items by kind and
 * text, so of two equal quotes both are marked.
 */
export function memoryRunView(run: unknown): MemoryRunView {
    const stored = isPlainObject(run) ? run : {};
    const receipt = isPlainObject(stored.receipt) ? stored.receipt : {};
    const analysis = isPlainObject(stored.analysis) ? stored.analysis : {};
    const window = storedItems(stored.window);
    const positions = window.flatMap(({ index }) => storedCount(index) ?? []);
    const { unverified, warnings } = memoryReceiptView(stored.receipt, { newest: false, taskLive: false });
    const quotes = new Set(unverified.map(({ kind, text }) => quoteKey(kind, text)));
    return {
        id: storedText(stored.id) ?? "",
        range:
            positions.length > 0
                ? { first: positions[0], last: positions[positions.length - 1], count: window.length }
                : null,
        ...present("model", storedText(stored.model) || undefined),
        ...present("inputTokens", storedCount(stored.inputTokens)),
        ...present("outputTokens", storedCount(stored.outputTokens)),
        ...present("durationMs", storedCount(stored.durationMs)),
        result: storedText(stored.result) ?? "",
        ...present("reason", storedText(stored.reason) ?? storedText(receipt.reason)),
        ...present("error", storedText(stored.error)),
        event: isPlainObject(analysis.event) ? runEventView(analysis.event, quotes) : null,
        candidates: storedItems(analysis.pageCandidates).map((candidate) => {
            const { create, reason, confidence } = candidate;
            return {
                title: candidateText(candidate),
                ...present("pageType", storedText(isPlainObject(create) ? create.type : undefined)),
                created: isPlainObject(create),
                reason: storedText(reason) ?? "",
                ...present("confidence", storedCount(confidence)),
            };
        }),
        unverified,
        warnings,
    };
}
