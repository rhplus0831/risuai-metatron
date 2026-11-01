import { strToU8, zipSync, type Zippable } from "fflate";
import type { Message } from "../../../shared/database.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    STRUCTURED_MEMORY_PATH,
    type MemoryEvent,
    type MemoryPage,
    type StructuredMemoryContentsAnswer,
    type StructuredMemoryPackageRound,
    type StructuredMemoryRecordAnswer,
    type StructuredMemoryRecordKind,
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
 * This module imports no alert or language module: the caller shows the notices for the outcomes the
 * reads return.
 */

/** Why a read did not answer: the chat or record is gone, the database was replaced, or the package kept changing. */
export type StructuredMemoryRefusal = "chatGone" | "recordGone" | "epoch" | "changed";

export type StructuredMemoryResult<T> =
    | { outcome: "ok"; value: T }
    | { outcome: "refused"; reason: StructuredMemoryRefusal }
    | { outcome: "failed"; error: string };

type Unanswered = Exclude<StructuredMemoryResult<never>, { outcome: "ok" }>;

type AnswerBody = Record<string, unknown>;

/** The rounds of one package read, kept together once all of them answered at one revision. */
type PackageRead = { revision: string; pages: MemoryPage[]; events: MemoryEvent[] };

/** Package reads in all, the first included, before a chat whose memory keeps changing is refused. */
const PACKAGE_READ_ATTEMPTS = 3;

const PACKAGE_VERSION = 1;

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

/** A package round's refusal: a 409 means the memory moved on since the read's first round. */
function packageRefusalOf(response: Response, body: AnswerBody): Unanswered {
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
function parseRound(body: AnswerBody, cursor: number): StructuredMemoryPackageRound | null {
    const { revision, pages, events, next } = body;
    const forward = next === null || (Number.isSafeInteger(next) && (next as number) > cursor);
    return typeof revision === "string" && Array.isArray(pages) && Array.isArray(events) && forward
        ? (body as StructuredMemoryPackageRound)
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

/** Every page and event of the chat at one revision: the rounds after the first name the first's. */
async function readPackage(ref: ChatRef): Promise<StructuredMemoryResult<PackageRead>> {
    const pages: MemoryPage[] = [];
    const events: MemoryEvent[] = [];
    let revision: string | undefined;
    let cursor = 0;
    for (;;) {
        const position = cursor;
        const query = revision === undefined ? "" : `?cursor=${position}&revision=${encodeURIComponent(revision)}`;
        const round = await readAnswer(
            `${chatPath(ref)}/package${query}`,
            (body) => parseRound(body, position),
            packageRefusalOf,
        );
        if (round.outcome !== "ok") {
            return round;
        }
        for (const page of round.value.pages) {
            pages.push(page);
        }
        for (const event of round.value.events) {
            events.push(event);
        }
        revision ??= round.value.revision;
        if (round.value.next === null) {
            return { outcome: "ok", value: { revision, pages, events } };
        }
        cursor = round.value.next;
    }
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

function zipPackage(ref: ChatRef, { revision, pages, events }: PackageRead): { name: string; bytes: Uint8Array } {
    const files: Zippable = { "timeline.md": strToU8(renderMemoryTimeline(events, revision)) };
    for (const page of pages) {
        files[memoryPagePath(page)] = strToU8(renderMemoryPage(page));
    }
    return {
        name: `structured-memory-${encodeURIComponent(ref.chatId).replace(/%/g, "_")}.zip`,
        bytes: zipSync(files),
    };
}

/**
 * The chat's pages and events as a zip for `downloadFile`. A change of the chat's memory during the read
 * restarts it with nothing kept, and a chat that keeps changing is refused `changed`.
 */
export async function buildStructuredMemoryPackage(
    ref: ChatRef,
): Promise<StructuredMemoryResult<{ name: string; bytes: Uint8Array }>> {
    for (let attempt = 0; attempt < PACKAGE_READ_ATTEMPTS; attempt += 1) {
        const read = await readPackage(ref);
        if (read.outcome === "refused" && read.reason === "changed") {
            continue;
        }
        if (read.outcome !== "ok") {
            return read;
        }
        try {
            return { outcome: "ok", value: zipPackage(ref, read.value) };
        } catch (error) {
            return { outcome: "failed", error: errorText(error) };
        }
    }
    return { outcome: "refused", reason: "changed" };
}
