import { Sha256 } from "@aws-crypto/sha256-js";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
    eligibleHistory,
    parseContextReport,
    type ContextMemoryWriter,
    type ContextReport,
} from "../../../shared/contextReport.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    isSealedHypaV3Data,
    itemTag,
    MEMORY_PAGE_TYPES,
    memoryEventCovers,
    rawWindow,
    reconcileMemoryEvents,
    sealedHypaV3DataIntact,
    sealedHypaV3DataRevision,
    STRUCTURED_MEMORY_PATH,
    type MemoryEvent,
    type MemoryManifestItem,
    type MemoryManifestItemKind,
    type MemoryPage,
    type MemoryPageHistoryEntry,
    type MemoryPageType,
    type MemoryThread,
    type ReadEntry,
    type StructuredMemoryAdoptAnswer,
    type StructuredMemoryAdoption,
    type StructuredMemoryCadence,
    type StructuredMemoryContentsAnswer,
    type StructuredMemoryCoverageEvent,
    type StructuredMemoryCoverageRound,
    type StructuredMemoryCoverageRun,
    type StructuredMemoryDeclineAnswer,
    type StructuredMemoryEdit,
    type StructuredMemoryEditAnswer,
    type StructuredMemoryFileEntry,
    type StructuredMemoryFileRecords,
    type StructuredMemoryInheritAnswer,
    type StructuredMemoryLogRun,
    type StructuredMemoryPackageRound,
    type StructuredMemoryProjectionAnswer,
    type StructuredMemoryRecordAnswer,
    type StructuredMemoryRecordKind,
    type StructuredMemoryResetAnswer,
    type StructuredMemoryRestoreAnswer,
    type StructuredMemoryRevisionsAnswer,
    type StructuredMemoryRunsRound,
    type StructuredMemoryThreadsRound,
} from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { ChatRef } from "../storage/chatStore.svelte";
import { readWithDeadline } from "../storage/readDeadline";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { authFetch } from "../storage/serverAuth";

/**
 * The tab's reads of a chat's structured memory (`server/src/routes/structuredMemory.ts`), a person's
 * edits of it (`editStructuredMemory`), a new chat's inheritance (`inheritStructuredMemory`) or restore
 * from a chat file (`restoreStructuredMemory`), the adoption of a chat's HypaV3 summaries
 * (`adoptStructuredMemory`), the decline of it (`declineStructuredMemory`), the reset of the summaries
 * (`resetStructuredMemorySummaries`), and the downloadable package built from the reads: a zip of
 * Markdown with one file per page and one timeline of the events.
 *
 * What a chat file takes of the records is read here too (`readStructuredMemoryFile`), and
 * `exportChatMemory` applies that read to the chat copy an export writes. So are the two reads a plugin's
 * read of a loaded chat makes first (`readStructuredMemoryRevisions`, `readStructuredMemoryProjection`);
 * what it does with them is the plugin API's and the chat module's.
 *
 * In the package Markdown is display and the metadata lines are the authority. A metadata value is JSON
 * on one line, which is also valid YAML, and `bodyLines` and `summaryLines` count the lines of the text
 * they describe, so a body holding `## x` or `---` can still be split exactly.
 *
 * `memoryReceiptView` turns a message's stored receipt into what its receipt line shows.
 *
 * The memory panel's data is here too. `joinMemoryCoverage` and `memoryTimelineRows` join the held
 * messages with the record facts the coverage route answers, because the tab holds the chat's whole
 * message list and a route has no job scope. `reconcileMemoryCoverage` brings those facts up to the held
 * messages first, with the same rule a send uses, so an edit shows at once and with no request.
 * `memoryRunView` turns a stored run into what a Log row shows, `memoryPageTree` and
 * `memoryPageHistoryView` a page into its rows, and `memoryWriterNotice` the current state into the
 * panel's writer line.
 *
 * What a send reported is read here too: `memoryStatusWord` for the context meter's line,
 * `memoryItemsUsed` for the panel's badges, and `memoryBlockEntries` for a preview's block.
 *
 * This module imports no alert or language module: the caller shows the notices for the outcomes the
 * reads and edits return. It counts no tokens either, so it stays free of the tokenizer: the panel does
 * that.
 */

/**
 * Why a read, an edit, an inherit, a restore, an adoption, a decline, or a reset did not answer: the chat
 * or record is gone, the database was replaced, its memory moved on, or, for a write, something that can
 * write it holds the chat. A restore can also be `tooLarge`, when its records are over the route's body
 * cap, and so can a projection, when the chat's events are over a read round.
 */
export type StructuredMemoryRefusal = "chatGone" | "recordGone" | "epoch" | "changed" | "fenced" | "tooLarge";

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

/**
 * What an export takes of the chat's memory, read at one revision. `rows` says whether the chat holds a
 * row of any kind, which the lists alone cannot: a chat with only failed runs can hold paused receipts.
 */
export type StructuredMemoryFileRead = StructuredMemoryFileRecords & { rows: boolean };

/** Whole reads in all, the first included, before a chat whose memory keeps changing is refused. */
const WHOLE_READ_ATTEMPTS = 3;

/**
 * The bound of one chat's whole file read, every round included (`readWithDeadline`): `authFetch` has
 * none of its own, and an export needs no server until this read asks it.
 */
const FILE_READ_DEADLINE_MS = 60_000;

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

/** An edit's refusal: a 409 says what holds the chat, or that the memory moved on since its revision. */
function editRefusalOf(response: Response, body: AnswerBody): Unanswered {
    return response.status === 409
        ? { outcome: "refused", reason: body.reason === "fenced" ? "fenced" : "changed" }
        : refusalOf(response, body);
}

/** A restore's refusal: an edit's, and a 413 for records over the route's body cap. */
function restoreRefusalOf(response: Response, body: AnswerBody): Unanswered {
    return response.status === 413 ? { outcome: "refused", reason: "tooLarge" } : editRefusalOf(response, body);
}

/** A projection's refusal: a 413 for events over a read round. */
function projectionRefusalOf(response: Response, body: AnswerBody): Unanswered {
    return response.status === 413 ? { outcome: "refused", reason: "tooLarge" } : refusalOf(response, body);
}

/** Asks `path` and turns its answer into a result: `parse` answers null for a body of the wrong shape. */
async function readAnswer<T>(
    path: string,
    parse: (body: AnswerBody) => T | null,
    refuse: (response: Response, body: AnswerBody) => Unanswered = refusalOf,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<StructuredMemoryResult<T>> {
    try {
        const response = await authFetch(path, {
            ...init,
            cache: "no-store",
            headers: { ...init.headers, [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
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
            return {
                ...stored,
                kind: "notAutomatic",
                action: reason === "localSummarization" || reason === "awaitingAdoption" ? null : "record",
            };
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

/** The newest assistant message a send reads (`eligibleHistory`, from the end so a long chat costs nothing). */
function newestAssistantMessage(messages: readonly DeepReadonly<Message>[]): DeepReadonly<Message> | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.disabled === "allBefore") {
            return undefined;
        }
        if (message.disabled !== true && message.role === "char") {
            return message;
        }
    }
    return undefined;
}

/** The id of the newest assistant message a send reads, or undefined with none. */
export function newestAssistantMessageId(messages: readonly DeepReadonly<Message>[]): string | undefined {
    return newestAssistantMessage(messages)?.chatId;
}

/** The receipt stored on the newest assistant message a send reads, as data of any shape. */
export function newestMemoryReceipt(messages: readonly DeepReadonly<Message>[]): unknown {
    return newestAssistantMessage(messages)?.generationInfo?.memory;
}

/** What the panel's writer line says; `kind` is null when recording needs no word. */
export type MemoryWriterNotice = {
    kind: "memoryOff" | "paused" | "notAutomatic" | null;
    /** Why recording is not automatic: a stored reason code, or `manual` for the preset's cadence. */
    reason?: string;
    /** What the line's button does. */
    action: MemoryReceiptView["action"];
};

/** Whether stored `receipt` is one a send left while the chat waited for its adoption choice. */
function awaitedAdoption(receipt: unknown): boolean {
    return isPlainObject(receipt) && receipt.state === "notAutomatic" && receipt.reason === "awaitingAdoption";
}

/**
 * The panel's writer line, decided from the current state: a receipt is a display copy of its moment,
 * so `paused` is the chat's runs as they stand now, and a newest receipt only adds to it. The first of
 * these holds. With memory off the command refuses, so there is no action. A chat held for its adoption
 * choice (`adoptionHeld`, as the server last said) says so, and its choice is the only thing to press.
 * Paused, by the runs or by `receipt`, offers resume. A `notAutomatic` receipt gives its reason, and a
 * `manual` cadence its own. Past those, and in the `manual` case, the action is `memoryReceiptView`'s for
 * the newest message. `receipt` is `newestMemoryReceipt`, stored data of any shape; one from while the
 * chat was held reads as no receipt once it is not, or it would hide record now after the choice.
 */
export function memoryWriterNotice({
    memoryOn,
    cadence,
    paused,
    adoptionHeld,
    receipt,
    taskLive,
}: {
    memoryOn: boolean;
    cadence: StructuredMemoryCadence;
    paused: boolean;
    adoptionHeld: boolean;
    receipt: unknown;
    taskLive: boolean;
}): MemoryWriterNotice {
    if (!memoryOn) {
        return { kind: "memoryOff", action: null };
    }
    if (adoptionHeld) {
        return { kind: "notAutomatic", reason: "awaitingAdoption", action: null };
    }
    const { kind, reason, action } = memoryReceiptView(awaitedAdoption(receipt) ? undefined : receipt, {
        newest: true,
        taskLive,
    });
    if (paused || kind === "paused") {
        return { kind: "paused", action: "resume" };
    }
    if (kind === "notAutomatic") {
        return { kind, ...present("reason", reason), action };
    }
    return cadence === "manual" ? { kind: "notAutomatic", reason: "manual", action } : { kind: null, action };
}

function chatPath(ref: ChatRef): string {
    return `${STRUCTURED_MEMORY_PATH}/${encodeURIComponent(ref.chaId)}/${encodeURIComponent(ref.chatId)}`;
}

/** What contents without an `adoption` say: nothing to offer, which every press leaves to the server anyway. */
const NO_ADOPTION: StructuredMemoryAdoption = { adoptable: 0, declined: false, resettable: false };

function isAdoption(value: unknown): value is StructuredMemoryAdoption {
    return (
        isPlainObject(value) &&
        storedCount(value.adoptable) !== undefined &&
        typeof value.declined === "boolean" &&
        typeof value.resettable === "boolean"
    );
}

/** A reader of the lists does not fail over `adoption`, which only the panel reads; a malformed one is refused. */
function parseContents(body: AnswerBody): StructuredMemoryContentsAnswer | null {
    const { revision, pages, events, threads, runs, adoption = NO_ADOPTION } = body;
    return typeof revision === "string" &&
        [pages, events, threads, runs].every((list) => Array.isArray(list)) &&
        isAdoption(adoption)
        ? ({ ...body, adoption } as StructuredMemoryContentsAnswer)
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

function parseThreadsRound(body: AnswerBody, cursor: number): StructuredMemoryThreadsRound | null {
    const { revision, threads, next } = body;
    return typeof revision === "string" && Array.isArray(threads) && isForward(next, cursor)
        ? (body as StructuredMemoryThreadsRound)
        : null;
}

function parseEditAnswer(body: AnswerBody): StructuredMemoryEditAnswer | null {
    const { revision, kind, data } = body;
    return typeof revision === "string" &&
        (kind === "pages" || kind === "threads" || kind === "events") &&
        isPlainObject(data)
        ? (body as StructuredMemoryEditAnswer)
        : null;
}

function parseInheritAnswer(body: AnswerBody): StructuredMemoryInheritAnswer | null {
    const { revision, inherited } = body;
    return typeof revision === "string" && typeof inherited === "boolean"
        ? (body as StructuredMemoryInheritAnswer)
        : null;
}

function parseRestoreAnswer(body: AnswerBody): StructuredMemoryRestoreAnswer | null {
    const { revision, restored } = body;
    return typeof revision === "string" && typeof restored === "boolean"
        ? (body as StructuredMemoryRestoreAnswer)
        : null;
}

function parseAdoptAnswer(body: AnswerBody): StructuredMemoryAdoptAnswer | null {
    const { revision, adopted, stale } = body;
    return typeof revision === "string" && typeof adopted === "number" && typeof stale === "number"
        ? (body as StructuredMemoryAdoptAnswer)
        : null;
}

function parseDeclineAnswer(body: AnswerBody): StructuredMemoryDeclineAnswer | null {
    const { revision, declined } = body;
    return typeof revision === "string" && typeof declined === "boolean"
        ? (body as StructuredMemoryDeclineAnswer)
        : null;
}

function parseResetAnswer(body: AnswerBody): StructuredMemoryResetAnswer | null {
    const { chatRevision, reset } = body;
    return typeof chatRevision === "string" && typeof reset === "boolean"
        ? (body as StructuredMemoryResetAnswer)
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

/** A list of another `length` than the request's says nothing of the chats it named, by position. */
function parseRevisions(body: AnswerBody, length: number): StructuredMemoryRevisionsAnswer | null {
    const { revisions } = body;
    return Array.isArray(revisions) &&
        revisions.length === length &&
        revisions.every((revision) => revision === null || typeof revision === "string")
        ? (body as StructuredMemoryRevisionsAnswer)
        : null;
}

/** No value is an answer too; a value is a whole one, sealed at the revision the answer names. */
function parseProjection(body: AnswerBody): StructuredMemoryProjectionAnswer | null {
    const { revision, hypaV3Data } = body;
    const answered =
        hypaV3Data === null
            ? revision === null || typeof revision === "string"
            : typeof revision === "string" &&
              sealedHypaV3DataIntact(hypaV3Data) &&
              sealedHypaV3DataRevision(hypaV3Data) === revision;
    return answered ? (body as StructuredMemoryProjectionAnswer) : null;
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
 * Sends one person's edit, made on the copy read at `revision`. The answer's revision is what the next
 * edit names. The caller shows the notice for a refusal.
 */
export function editStructuredMemory(
    ref: ChatRef,
    revision: string,
    edit: StructuredMemoryEdit,
): Promise<StructuredMemoryResult<StructuredMemoryEditAnswer>> {
    return readAnswer(`${chatPath(ref)}/edits`, parseEditAnswer, editRefusalOf, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, edit }),
    });
}

/**
 * Asks the server to give `ref`, a chat just copied or branched, the records of `sourceChatId`, the
 * character's chat it came from. The server builds them from what it holds of both chats, so a 404
 * `chatGone` says the new chat has not reached it, and a repeat answers `inherited: false`. The caller
 * shows the notice for a refusal.
 */
export function inheritStructuredMemory(
    ref: ChatRef,
    sourceChatId: string,
): Promise<StructuredMemoryResult<StructuredMemoryInheritAnswer>> {
    return readAnswer(`${chatPath(ref)}/inherit`, parseInheritAnswer, editRefusalOf, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceChatId }),
    });
}

/**
 * Gives `ref`, a chat just imported, the records its file held. The server takes them only for a chat with
 * no rows, so a 404 `chatGone` says the chat has not reached it, and a chat a send reached first answers
 * `restored: false`. The caller shows the notice for a refusal.
 */
export function restoreStructuredMemory(
    ref: ChatRef,
    { pages, events, threads }: StructuredMemoryFileRecords,
): Promise<StructuredMemoryResult<StructuredMemoryRestoreAnswer>> {
    return readAnswer(`${chatPath(ref)}/restore`, parseRestoreAnswer, restoreRefusalOf, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages, events, threads }),
    });
}

/**
 * Asks the server to make each HypaV3 summary of `ref`, a chat with no records, a stored event. The server
 * reads the summaries from what it stores, calls no model, and leaves them as they are; a repeat answers
 * `adopted: 0`. The caller shows the notice for a refusal.
 */
export function adoptStructuredMemory(ref: ChatRef): Promise<StructuredMemoryResult<StructuredMemoryAdoptAnswer>> {
    return readAnswer(`${chatPath(ref)}/adopt`, parseAdoptAnswer, editRefusalOf, { method: "POST" });
}

/**
 * Tells the server a person will not adopt the HypaV3 summaries of `ref`, so the writer starts from the
 * oldest turn and the chat is not offered them again, which cannot be undone. Only a chat that waits for
 * that choice takes it: any other answers `declined: false`. The caller shows the notice for a refusal.
 */
export function declineStructuredMemory(ref: ChatRef): Promise<StructuredMemoryResult<StructuredMemoryDeclineAnswer>> {
    return readAnswer(`${chatPath(ref)}/decline`, parseDeclineAnswer, editRefusalOf, { method: "POST" });
}

/**
 * Asks the server to empty the stored HypaV3 summaries of `ref`, an adopted chat. The server decides from
 * what it stores, and writes the chat itself: the tab sends no chat write, and takes the change with a
 * read, because only a whole read replaces what it holds. Any other chat answers `reset: false`. The
 * caller shows the notice for a refusal, and reads the chat after a reset.
 */
export function resetStructuredMemorySummaries(
    ref: ChatRef,
): Promise<StructuredMemoryResult<StructuredMemoryResetAnswer>> {
    return readAnswer(`${chatPath(ref)}/reset-summaries`, parseResetAnswer, editRefusalOf, { method: "POST" });
}

/**
 * The memory revision of each of `refs`, by position, in one request (`MEMORY_REVISION_CHATS_MAX` at most),
 * reading no message. A null entry is an answer: the chat holds no projection.
 */
export function readStructuredMemoryRevisions(
    refs: readonly ChatRef[],
    signal?: AbortSignal,
): Promise<StructuredMemoryResult<StructuredMemoryRevisionsAnswer>> {
    return readAnswer(`${STRUCTURED_MEMORY_PATH}/revisions`, (body) => parseRevisions(body, refs.length), refusalOf, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chats: refs.map(({ chaId, chatId }) => ({ characterId: chaId, chatId })) }),
        signal,
    });
}

/**
 * The chat's projection as a whole read would overlay it. A null `hypaV3Data` is an answer: the chat holds
 * no projection.
 */
export function readStructuredMemoryProjection(
    ref: ChatRef,
    signal?: AbortSignal,
): Promise<StructuredMemoryResult<StructuredMemoryProjectionAnswer>> {
    return readAnswer(`${chatPath(ref)}/projection`, parseProjection, projectionRefusalOf, { signal });
}

/** What ties a route's rounds to a read beyond them. */
type RoundsOptions = {
    /** The revision every round must name, the first one included. */
    revision?: string;
    signal?: AbortSignal;
};

/**
 * One whole read of a route's rounds: every round names `options.revision`, or without one the rounds
 * after the first name the first's, each goes through `take`, and the answer is that revision.
 */
async function readRounds<Round extends { revision: string; next: number | null }>(
    path: string,
    parse: (body: AnswerBody, cursor: number) => Round | null,
    take: (round: Round) => void,
    options: RoundsOptions = {},
): Promise<StructuredMemoryResult<string>> {
    const { signal } = options;
    let { revision } = options;
    let cursor = 0;
    for (;;) {
        const position = cursor;
        const query = revision === undefined ? "" : `?cursor=${position}&revision=${encodeURIComponent(revision)}`;
        const round = await readAnswer(`${path}${query}`, (body) => parse(body, position), roundRefusalOf, { signal });
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
async function readPackage(ref: ChatRef, options?: RoundsOptions): Promise<StructuredMemoryResult<PackageRead>> {
    const pages: MemoryPage[] = [];
    const events: MemoryEvent[] = [];
    const read = await readRounds(
        `${chatPath(ref)}/package`,
        parseRound,
        (round) => {
            for (const page of round.pages) {
                pages.push(page);
            }
            for (const event of round.events) {
                events.push(event);
            }
        },
        options,
    );
    return read.outcome === "ok" ? { outcome: "ok", value: { revision: read.value, pages, events } } : read;
}

/** Every thread of the chat at the revision `options` names. */
async function readThreads(ref: ChatRef, options: RoundsOptions): Promise<StructuredMemoryResult<MemoryThread[]>> {
    const threads: MemoryThread[] = [];
    const read = await readRounds(
        `${chatPath(ref)}/threads`,
        parseThreadsRound,
        (round) => {
            for (const thread of round.threads) {
                threads.push(thread);
            }
        },
        options,
    );
    return read.outcome === "ok" ? { outcome: "ok", value: threads } : read;
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
 * What an export takes of the chat's memory, read whole at one revision, in `FILE_READ_DEADLINE_MS` at
 * most, whose passing is a failure. The contents come first, so a chat with no rows costs one request,
 * and a chat that holds only runs no more; every other round names the contents' revision. A change of the
 * chat's memory during the read restarts it with nothing kept, and a chat that keeps changing is refused
 * `changed`.
 *
 * A chat the server does not hold has no records, because an export can come ahead of its save, or in
 * place of it: `RefusedDataBanner` exports what the server refused. That holds only until the contents
 * have shown records: past that `chatGone` is a refusal.
 */
export async function readStructuredMemoryFile(
    ref: ChatRef,
): Promise<StructuredMemoryResult<StructuredMemoryFileRead>> {
    let showedRecords = false;
    try {
        return await readWithDeadline(FILE_READ_DEADLINE_MS, "The memory read timed out", (signal) =>
            readAtOneRevision(async () => {
                const contents = await readAnswer(chatPath(ref), parseContents, refusalOf, { signal });
                if (contents.outcome === "refused" && contents.reason === "chatGone" && !showedRecords) {
                    return { outcome: "ok", value: { rows: false, pages: [], events: [], threads: [] } };
                }
                if (contents.outcome !== "ok") {
                    return contents;
                }
                const { revision, pages, events, threads, runs } = contents.value;
                if (pages.length + events.length + threads.length === 0) {
                    return { outcome: "ok", value: { rows: runs.length > 0, pages: [], events: [], threads: [] } };
                }
                showedRecords = true;
                const packaged = await readPackage(ref, { revision, signal });
                if (packaged.outcome !== "ok") {
                    return packaged;
                }
                const threaded = await readThreads(ref, { revision, signal });
                if (threaded.outcome !== "ok") {
                    return threaded;
                }
                return {
                    outcome: "ok",
                    value: {
                        rows: true,
                        pages: packaged.value.pages,
                        events: packaged.value.events,
                        threads: threaded.value,
                    },
                };
            }),
        );
    } catch (error) {
        return { outcome: "failed", error: errorText(error) };
    }
}

/**
 * What an export does with `read`, the answer of `readStructuredMemoryFile`, to `chat`, the copy it writes:
 * `entry` is the chat's line in the file's `structuredMemory`, null with no records, and `failed` says the
 * read did not answer, which takes every record out of the file, so a file never holds part of a chat's
 * memory.
 *
 * A sealed `hypaV3Data` goes whatever the read answered: a tab's read can carry a projection, also after
 * another algorithm was selected, and the seal, not the algorithm, tells it from real summaries. Those stay,
 * beside records too, because a chat can hold both. With a row of any kind the receipts go too
 * (`generationInfo.memory`, the rest stays): a receipt is a display copy of a run, runs stay out of the
 * file, and it would offer Resume on an empty Log or say `recorded` of a restore that failed. Hashes do
 * not read it.
 */
export function exportChatMemory(
    chat: Chat,
    read: StructuredMemoryResult<StructuredMemoryFileRead>,
): { entry: StructuredMemoryFileEntry | null; failed: boolean } {
    if (isSealedHypaV3Data(chat.hypaV3Data)) {
        delete chat.hypaV3Data;
    }
    if (read.outcome !== "ok") {
        return { entry: null, failed: true };
    }
    const { rows, pages, events, threads } = read.value;
    const records = pages.length + events.length + threads.length > 0;
    if (rows) {
        for (const { generationInfo } of chat.message) {
            delete generationInfo?.memory;
        }
    }
    return { entry: records ? { chatId: chat.id, pages, events, threads } : null, failed: false };
}

/**
 * A chat file's `structuredMemory` list by the chat ids it names: anything but a list names none, and
 * of two entries for one id the first stands. The records are the file's, unread: the route checks them.
 */
export function chatFileMemory(list: unknown): ReadonlyMap<string, StructuredMemoryFileEntry> {
    const entries = new Map<string, StructuredMemoryFileEntry>();
    for (const entry of Array.isArray(list) ? list : []) {
        if (isPlainObject(entry) && typeof entry.chatId === "string" && !entries.has(entry.chatId)) {
            entries.set(entry.chatId, entry as StructuredMemoryFileEntry);
        }
    }
    return entries;
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

/** What a panel tab can send the panel to: an event in Timeline or a page in Pages. */
export type MemoryPanelTarget = { tab: "timeline" | "pages"; id: string };

/** What the panel hands every tab. */
export type MemoryPanelTabProps = {
    chatRef: ChatRef;
    readOnly: boolean;
    refresh: number;
    /** What to show after a jump from another tab, or null. */
    focus: MemoryPanelTarget | null;
    open: (target: MemoryPanelTarget) => void;
    /** Leaves the panel for this message in the chat. */
    jump: (messageId: string) => void;
};

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

/** What the join reads of the coverage route's facts. */
type CoverageFacts = {
    events: readonly Omit<StructuredMemoryCoverageEvent, "sourceIndex" | "sources">[];
    runs: readonly StructuredMemoryCoverageRun[];
};

/** What the tab hashes of a message. */
type HashedMessage = DeepReadonly<Pick<Message, "chatId" | "role" | "data">>;

/**
 * The hash a source keeps of `message`, exactly as `messageSourceHash` takes it on the server. It is pure
 * JavaScript because `crypto.subtle` is absent outside a secure context, and JSON leaves no lone
 * surrogate for the UTF-8 encoding to replace.
 */
export function memoryMessageHash({ role, data }: Pick<HashedMessage, "role" | "data">): string {
    const hash = new Sha256();
    hash.update(JSON.stringify([role, data]));
    return Array.from(hash.digestSync(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A `memoryMessageHash` that hashes a message again only when its `role` or `data` changed, for a tab to
 * hold while it lives: the rows follow every change of the held messages, and most of them change
 * nothing an event cites.
 */
export function memoryMessageHasher(): (message: HashedMessage) => string {
    const memo = new Map<string, { role: Message["role"]; data: string; hash: string }>();
    return (message) => {
        const { chatId, role, data } = message;
        const held = chatId === undefined ? undefined : memo.get(chatId);
        if (held?.role === role && held.data === data) {
            return held.hash;
        }
        const hash = memoryMessageHash(message);
        if (chatId !== undefined) {
            memo.set(chatId, { role, data, hash });
        }
        return hash;
    };
}

/**
 * `facts` with their events as `messages` leave them, by the rule a send uses (`reconcileMemoryEvents`),
 * so an event that stopped reading from its messages shows `stale` at once. Everything derived from the
 * answer reads it, the join included, and nothing is stored or asked for.
 */
export function reconcileMemoryCoverage(
    facts: StructuredMemoryCoverage,
    messages: readonly HashedMessage[],
    hashOf: (message: HashedMessage) => string,
): StructuredMemoryCoverage {
    return { ...facts, events: reconcileMemoryEvents(facts.events, messages, hashOf) };
}

/** A row's fields that the join decides. */
type CoverageDecision = Pick<MemoryCoverageRow, "state" | "eventId" | "runId" | "reason">;

/** What an event says of a message it cites. A higher `rank` wins, and a later event among equals. */
type Citation = Pick<MemoryCoverageRow, "state" | "reason"> & { eventId: string; rank: number };

function citationOf(event: CoverageFacts["events"][number]): Citation {
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
    facts: CoverageFacts,
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

/** Each held message's position by id, built once so a long chat's lookups stay cheap. */
export function memoryMessageIndexes(
    messages: readonly DeepReadonly<Pick<Message, "chatId">>[],
): ReadonlyMap<string, number> {
    const indexes = new Map<string, number>();
    messages.forEach(({ chatId }, index) => {
        if (chatId !== undefined) {
            indexes.set(chatId, index);
        }
    });
    return indexes;
}

/** One event in the Timeline. */
export type MemoryTimelineRow<E = StructuredMemoryCoverageEvent> = {
    event: E;
    /** Where it sorts; Infinity when nothing says. */
    position: number;
    /** As a send's flow lane counts it, or null with none of its messages left. */
    turnsAgo: number | null;
};

/**
 * The Timeline of a chat: `events` in the order of `messages` as held. A row sorts by its first message
 * still present, else by the position its sources stored, else last, ties in the given order. It ages
 * from its newest message still present, as the flow lane ages an event: the `char` messages with text
 * at or after it that a send reads (`eligibleHistory`), at least 1.
 */
export function memoryTimelineRows<E extends Pick<StructuredMemoryCoverageEvent, "messageIds" | "sourceIndex">>(
    events: readonly E[],
    messages: readonly DeepReadonly<Message>[],
): MemoryTimelineRow<E>[] {
    const indexes = memoryMessageIndexes(messages);
    const read = eligibleHistory(messages.map(({ disabled }, index) => ({ disabled, index }))).messages;
    const eligible = new Set(read.map(({ index }) => index));
    const turnsFrom = new Array<number>(messages.length);
    for (let index = messages.length - 1, turns = 0; index >= 0; index--) {
        const { role, data } = messages[index];
        if (eligible.has(index) && role === "char" && data.trim() !== "") {
            turns++;
        }
        turnsFrom[index] = turns;
    }
    const rows = events.map((event): MemoryTimelineRow<E> => {
        let first = Infinity;
        let newest = -1;
        for (const id of event.messageIds) {
            const index = indexes.get(id);
            if (index !== undefined) {
                first = Math.min(first, index);
                newest = Math.max(newest, index);
            }
        }
        return newest < 0
            ? { event, position: event.sourceIndex ?? Infinity, turnsAgo: null }
            : { event, position: first, turnsAgo: Math.max(1, turnsFrom[newest]) };
    });
    return rows.sort((a, b) => (a.position === b.position ? 0 : a.position - b.position));
}

/** One type's rows in the Pages tree. */
export type MemoryPageGroup<Row> = { type: MemoryPageType; rows: Row[] };

/** Contents rows by type: the scene first, then `MEMORY_PAGE_TYPES`' order, each group in the given order. */
export function memoryPageTree<Row extends { type: MemoryPageType }>(rows: readonly Row[]): MemoryPageGroup<Row>[] {
    const types: MemoryPageType[] = ["scene", ...MEMORY_PAGE_TYPES.filter((type) => type !== "scene")];
    return types.flatMap((type) => {
        const grouped = rows.filter((row) => row.type === type);
        return grouped.length > 0 ? [{ type, rows: grouped }] : [];
    });
}

/** One page history entry as the Pages tab lists it. */
export type MemoryPageHistoryRow = Pick<MemoryPageHistoryEntry, "id" | "heading" | "kind" | "at"> & {
    /** The section's text before and after the change; null where it had none. */
    before: string | null;
    after: string | null;
};

/**
 * `page`'s history, newest first. No `after` is stored: the state after an entry is the next entry's of
 * the same section, or the live section past the last one. An entry that concerns the whole page
 * (`heading: null`) holds no text to compare.
 */
export function memoryPageHistoryView({
    sections,
    history,
}: Pick<MemoryPage, "sections" | "history">): MemoryPageHistoryRow[] {
    const states = new Map<string, string | null>(sections.map(({ heading, body }) => [heading, body]));
    return [...history].reverse().map(({ id, heading, kind, at, before }) => {
        if (heading === null) {
            return { id, heading, kind, at, before: null, after: null };
        }
        const after = states.get(heading) ?? null;
        states.set(heading, before?.body ?? null);
        return { id, heading, kind, at, before: before?.body ?? null, after };
    });
}

/** One run of a diff, which the tab renders as a span. */
export type MemoryDiffPart = { change: "same" | "added" | "removed"; text: string };

/** `before` to `after`, word by word. `diff` loads here, when the first history entry opens. */
export async function memoryTextDiff(before: string, after: string): Promise<MemoryDiffPart[]> {
    const { diffWordsWithSpace } = await import("diff");
    return diffWordsWithSpace(before, after).map(({ added, removed, value }) => ({
        change: added ? "added" : removed ? "removed" : "same",
        text: value,
    }));
}

/** The most code points of a message a Coverage row shows. */
const EXCERPT_CODE_POINTS = 120;

/** A stored message as one line of plain text. */
export function memoryMessageExcerpt(text: string): string {
    // UTF-16 units first, so a message of any size costs the same.
    const points = [...collapsed(text.slice(0, EXCERPT_CODE_POINTS * 4))];
    return points.length > EXCERPT_CODE_POINTS ? `${points.slice(0, EXCERPT_CODE_POINTS).join("")}…` : points.join("");
}

/** A report's memory field. */
type ReportedMemory = NonNullable<ContextReport["memory"]>;

/** The word the context meter's line shows for a Structured Memory report. */
export type MemoryStatusWord = "gap" | "unknown" | ContextMemoryWriter["state"] | "memoryOn";

/**
 * The worst of what the report says: a coverage that is not `covered`, `gap` first, then the writer's
 * state, `memoryOn` for a report without one.
 */
export function memoryStatusWord({ coverage, writer }: Pick<ReportedMemory, "coverage" | "writer">): MemoryStatusWord {
    return coverage === "covered" ? (writer?.state ?? "memoryOn") : coverage;
}

/**
 * The ids of the records of `itemKind` the last send verifiably used. The last send is the newest valid
 * report in `messages`, found as the context meter finds its own, so a report of another kind means
 * nothing was used and an older one is never reached. It reads only each scanned message's
 * `generationInfo`, never `data`, so streaming text does not rerun it.
 */
export function memoryItemsUsed(
    messages: readonly DeepReadonly<Pick<Message, "generationInfo">>[],
    itemKind: MemoryManifestItemKind,
): ReadonlySet<string> {
    for (let index = messages.length - 1; index >= 0; index--) {
        const report = parseContextReport(messages[index].generationInfo?.context);
        if (report) {
            const items = report.memory?.kind === "structuredMemory" ? (report.memory.items ?? []) : [];
            return new Set(items.flatMap(({ id, kind, verified }) => (kind === itemKind && verified ? [id] : [])));
        }
    }
    return new Set();
}

/** The `start` of each of `groups` with a row whose event is in `used`: one pass, however many rows they hold. */
export function usedMemoryCoverageGroups(
    rows: readonly MemoryCoverageRow[],
    groups: readonly MemoryCoverageGroup[],
    used: ReadonlySet<string>,
): ReadonlySet<number> {
    const starts = new Set<number>();
    if (used.size === 0) {
        return starts;
    }
    for (const { start, end } of groups) {
        for (let index = start; index < end; index++) {
            const { eventId } = rows[index];
            if (eventId !== undefined && used.has(eventId)) {
                starts.add(start);
                break;
            }
        }
    }
    return starts;
}

/** A manifest row's key in `memoryItemTitles`: records of two kinds can share an id. */
export function memoryItemKey({ kind, id }: Pick<MemoryManifestItem, "kind" | "id">): string {
    return `${kind}\u0000${id}`;
}

/** The titles of a chat's records by `memoryItemKey`. An `evidence` row has none: it names a message. */
export function memoryItemTitles({
    pages,
    events,
    threads,
}: Pick<StructuredMemoryContentsAnswer, "pages" | "events" | "threads">): ReadonlyMap<string, string> {
    const titles = new Map<string, string>();
    const take = (kind: MemoryManifestItem["kind"], rows: readonly { id: string; title: string }[]) => {
        for (const { id, title } of rows) {
            titles.set(memoryItemKey({ kind, id }), title);
        }
    };
    take("page", pages);
    take("event", events);
    take("thread", threads);
    return titles;
}

/**
 * The prompt's memory block: the `messages` that hold an item's tag, in order. Tags find it, not the
 * entries' `memo`, which `editRequest` can rebuild them without.
 */
export function memoryBlockEntries<T extends Pick<OpenAIChat, "content">>(
    messages: readonly T[],
    items: readonly Pick<MemoryManifestItem, "lane" | "id">[],
): T[] {
    const tags = items.map((item) => itemTag(item));
    return messages.filter(({ content }) => tags.some((tag) => content.includes(tag)));
}

/** What a Log row's expanded view shows of the event a run extracted. */
export type MemoryRunEventView = {
    /** What a stored event names as its writer; a run's own event has none. */
    writerRun?: string;
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
    /** The event the run committed, which can differ from what it extracted. */
    eventId?: string;
    /** Null for a run with no extraction. */
    event: MemoryRunEventView | null;
    candidates: {
        title: string;
        pageType?: string;
        created: boolean;
        reason: string;
        confidence?: number;
    }[];
    refused: MemoryReceiptView["refused"];
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

/** What Timeline shows of a stored event, read as an extraction is: as data of any shape. */
export function memoryEventView(event: unknown): MemoryRunEventView {
    const stored = isPlainObject(event) ? event : {};
    return { ...runEventView(stored, new Set()), ...present("writerRun", storedText(stored.writerRun)) };
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
    const { refused, unverified, warnings } = memoryReceiptView(stored.receipt, { newest: false, taskLive: false });
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
        ...present("eventId", storedText(stored.eventId)),
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
        refused,
        unverified,
        warnings,
    };
}
