import { Sha256 } from "@aws-crypto/sha256-js";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
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
    MEMORY_HEALTH_CHATS_MAX,
    MEMORY_PACKAGE_VERSION,
    MEMORY_PAGE_TYPES,
    MEMORY_RESTORE_BODY_BYTES,
    memoryEventCovers,
    memoryScreenReason,
    rawWindow,
    reconcileMemoryEvents,
    sealedHypaV3DataIntact,
    sealedHypaV3DataRevision,
    STRUCTURED_MEMORY_PATH,
    STRUCTURED_MEMORY_REBUILD_MODES,
    type MemoryEvent,
    type MemoryManifestItem,
    type MemoryManifestItemKind,
    type MemoryPage,
    type MemoryPageHistoryEntry,
    type MemoryPageType,
    type MemoryThread,
    type ReadEntry,
    type StructuredMemoryAbandonAnswer,
    type StructuredMemoryAdoptAnswer,
    type StructuredMemoryAdoption,
    type StructuredMemoryCadence,
    type StructuredMemoryContentsAnswer,
    type StructuredMemoryCostAnswer,
    type StructuredMemoryCostMode,
    type StructuredMemoryCoverageEvent,
    type StructuredMemoryCoverageRound,
    type StructuredMemoryCoverageRun,
    type StructuredMemoryDeclineAnswer,
    type StructuredMemoryDefaultPromptsAnswer,
    type StructuredMemoryEdit,
    type StructuredMemoryEditAnswer,
    type StructuredMemoryFileEntry,
    type StructuredMemoryFileRecords,
    type StructuredMemoryHealthAnswer,
    type StructuredMemoryHealthFacts,
    type StructuredMemoryImportAnswer,
    type StructuredMemoryImportFile,
    type StructuredMemoryInheritAnswer,
    type StructuredMemoryLogRun,
    type StructuredMemoryPackageRound,
    type StructuredMemoryPageTool,
    type StructuredMemoryPageToolAnswer,
    type StructuredMemoryProjectionAnswer,
    type StructuredMemoryRebuild,
    type StructuredMemoryRecordAnswer,
    type StructuredMemoryRecordKind,
    type StructuredMemoryResetAnswer,
    type StructuredMemoryRestoreAnswer,
    type StructuredMemoryRevertAnswer,
    type StructuredMemoryRevisionsAnswer,
    type StructuredMemoryRunsRound,
    type StructuredMemorySettings,
    type StructuredMemorySlotWarnings,
    type StructuredMemoryTestResult,
    type StructuredMemoryThreadsRound,
} from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { ChatRef } from "../storage/chatStore.svelte";
import { readWithDeadline } from "../storage/readDeadline";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { authFetch } from "../storage/serverAuth";

/**
 * The tab's reads of a chat's structured memory (`server/src/routes/structuredMemory.ts`), a person's
 * edits of it (`editStructuredMemory`), reverts of what the writer changed
 * (`revertStructuredMemoryChange`), and tools over a page as a whole (`structuredMemoryPageTool`), a new
 * chat's inheritance (`inheritStructuredMemory`) or restore from a chat file (`restoreStructuredMemory`),
 * the adoption of a chat's HypaV3 summaries (`adoptStructuredMemory`), the decline of it
 * (`declineStructuredMemory`), the reset of the summaries (`resetStructuredMemorySummaries`), what a
 * rebuild or a press would cost (`readStructuredMemoryCost`), the abandon of a rebuild
 * (`abandonStructuredMemoryRebuild`), the writer's default prompts (`readStructuredMemoryDefaultPrompts`),
 * and the downloadable package built from the reads: a zip of Markdown with one file per page, one
 * timeline of the events, and one file of the threads. The same zip imports into an empty chat
 * (`importStructuredMemoryPackage`): the tab unzips it and sends the Markdown, which the server reads
 * back.
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
 * `memoryReceiptView` turns a message's stored receipt into what its receipt line shows, and
 * `memoryTestResultView` a test run's `done.result` into what the settings page shows of it.
 *
 * The memory panel's data is here too. `joinMemoryCoverage` and `memoryTimelineRows` join the held
 * messages with the record facts the coverage route answers, because the tab holds the chat's whole
 * message list and a route has no job scope. `reconcileMemoryCoverage` brings those facts up to the held
 * messages first, with the same rule a send uses, so an edit shows at once and with no request.
 * `memoryRunView` turns a stored run into what a Log row shows, `memoryPageTree` and
 * `memoryPageHistoryView` a page into its rows, and `memoryWriterNotice` the current state into the
 * panel's writer line. A receipt's link reaches a panel that is not there yet through
 * `requestMemoryPanelTarget`, which the panel takes as it mounts.
 *
 * What a send reported is read here too: `memoryStatusWord` for the context meter's line,
 * `memoryItemsUsed` for the panel's badges, and `memoryBlockEntries` for a preview's block.
 *
 * This module imports no alert or language module: the caller shows the notices for the outcomes the
 * reads and edits return. It counts no tokens either, so it stays free of the tokenizer: the panel does
 * that.
 */

/**
 * Why a read, an edit, a revert, a page tool, an inherit, a restore, an import, an adoption, a decline, a
 * reset, or an abandon did not answer: the chat or record is gone, the database was replaced, its memory
 * moved on, or, for a write, something that can write it holds the chat. A revert can also be
 * `superseded`, when something later stands on the change. A restore and an import can also be `tooLarge`,
 * when their records are over the route's body cap, and so can a projection, when the chat's events are
 * over a read round.
 */
export type StructuredMemoryRefusal =
    "chatGone" | "recordGone" | "epoch" | "changed" | "fenced" | "superseded" | "tooLarge";

export type StructuredMemoryResult<T> =
    | { outcome: "ok"; value: T }
    | { outcome: "refused"; reason: StructuredMemoryRefusal }
    | { outcome: "failed"; error: string };

type Unanswered = Exclude<StructuredMemoryResult<never>, { outcome: "ok" }>;

type AnswerBody = Record<string, unknown>;

/** The rounds of one package read, kept together once all of them answered at one revision. */
type PackageRead = { revision: string; pages: MemoryPage[]; events: MemoryEvent[] };

/** What a zip holds that an import sends: the package's Markdown files, in the zip's order. */
type ImportFiles = { files: StructuredMemoryImportFile[] };

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

/** A revert's refusal: an edit's, and a 409 that says a later change stands on this one. */
function revertRefusalOf(response: Response, body: AnswerBody): Unanswered {
    return response.status === 409 && body.reason === "superseded"
        ? { outcome: "refused", reason: "superseded" }
        : editRefusalOf(response, body);
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

/**
 * One thing a receipt says changed: a section, with the history entry that holds its diff, or a new page,
 * with neither. `title` is blank on a receipt from before they kept one, and `kind` is the change's kind,
 * set only on a highlighted change.
 */
export type MemoryReceiptChange = {
    pageId: string;
    title: string;
    heading?: string;
    historyId?: string;
    kind?: string;
};

/** The lists a receipt or a test run carries, each item as plain text. */
export type MemoryReceiptLists = {
    warnings: { kind: string; detail?: string }[];
    unverified: { kind: string; text: string; reason?: string }[];
    refused: { candidate: string; refusal: string }[];
};

/** A receipt display copy; `action` is a possible press, never evidence that a window is admitted or due. */
export type MemoryReceiptView = MemoryReceiptLists & {
    kind: MemoryReceiptViewKind;
    /** The stored reason code. */
    reason?: string;
    /** Events, pages, refused candidates, and unverified items the receipt lists. */
    counts: { events: number; pages: number; refused: number; unverified: number };
    /** What the recording changed, by page in the receipt's order, each new page ahead of its sections. */
    changes: MemoryReceiptChange[];
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    /** Fine-tuning was enabled, even if no custom frame ran. */
    customPrompt: boolean;
    /** A failed run's error, which a receipt keeps only under `customPrompt`. */
    error?: string;
    /** What the line's button does: record through this message, or resume recording. */
    action: "record" | "resume" | null;
};

const NO_RECEIPT_ITEMS = {
    counts: { events: 0, pages: 0, refused: 0, unverified: 0 },
    warnings: [],
    unverified: [],
    refused: [],
    changes: [],
    customPrompt: false,
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

/** The rows of a receipt's stored `pages`: a row with no page, or a section with no history entry, has none. */
function receiptChanges(pages: unknown): MemoryReceiptChange[] {
    return storedItems(pages).flatMap((page) => {
        const pageId = storedText(page.pageId);
        if (pageId === undefined) {
            return [];
        }
        const title = storedText(page.title) ?? "";
        const sections = storedItems(page.sections).flatMap((section): MemoryReceiptChange[] => {
            const heading = storedText(section.heading);
            const historyId = storedText(section.historyId);
            return heading === undefined || historyId === undefined
                ? []
                : [{ pageId, title, heading, historyId, ...present("kind", storedText(section.highlighted)) }];
        });
        return page.created === true ? [{ pageId, title }, ...sections] : sections;
    });
}

/** The lists of a stored receipt, or of anything that carries them, read as data of any shape. */
function receiptLists(stored: Record<string, unknown>): MemoryReceiptLists {
    return {
        warnings: storedItems(stored.warnings).map(({ kind, detail }) => ({
            kind: storedText(kind) ?? "",
            ...present("detail", storedText(detail)),
        })),
        unverified: storedItems(stored.unverified).map((item) => ({
            kind: storedText(item.kind) ?? "",
            text: storedText(item.text) ?? "",
            ...present("reason", storedText(item.reason)),
        })),
        refused: storedItems(stored.refused).map((item) => ({
            candidate: candidateText(item.candidate),
            refusal: storedText(item.refusal) ?? "",
        })),
    };
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
    const lists = receiptLists(receipt);
    const stored = {
        ...present("reason", reason),
        counts: {
            events: storedText(receipt.eventId) ? 1 : 0,
            pages: storedItems(receipt.pages).length,
            refused: lists.refused.length,
            unverified: lists.unverified.length,
        },
        ...lists,
        changes: receiptChanges(receipt.pages),
        ...present("model", storedText(receipt.model) || undefined),
        ...present("inputTokens", storedCount(receipt.inputTokens)),
        ...present("outputTokens", storedCount(receipt.outputTokens)),
        customPrompt: receipt.customPrompt === true,
        ...present("error", storedText(receipt.error)),
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
    kind: "memoryOff" | "paused" | "repair" | "notAutomatic" | null;
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
 * `manual` cadence its own. Under paused, a chat with an event waiting for a re-record (`pendingRepairs`,
 * as the server last said) says so, with the action the newest message would have. Past those, and in
 * the `manual` case, the action is `memoryReceiptView`'s for the newest message. `receipt` is
 * `newestMemoryReceipt`, stored data of any shape; one from while the chat was held reads as no receipt
 * once it is not, or it would hide record now after the choice.
 */
export function memoryWriterNotice({
    memoryOn,
    cadence,
    paused,
    pendingRepairs,
    adoptionHeld,
    receipt,
    taskLive,
}: {
    memoryOn: boolean;
    cadence: StructuredMemoryCadence;
    paused: boolean;
    pendingRepairs: number;
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
    if (pendingRepairs > 0) {
        return { kind: "repair", action };
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

function isRebuild(value: unknown): value is StructuredMemoryRebuild {
    return (
        isPlainObject(value) &&
        STRUCTURED_MEMORY_REBUILD_MODES.some((mode) => mode === value.mode) &&
        storedCount(value.done) !== undefined &&
        storedCount(value.total) !== undefined &&
        typeof value.resumable === "boolean" &&
        [value.reason, value.error].every((text) => text === undefined || typeof text === "string")
    );
}

/** What contents without `health` say: nothing to show, which the health route decides anyway. */
const NO_HEALTH: StructuredMemoryHealthFacts = {
    paused: false,
    storedStale: 0,
    pendingRepairs: 0,
    unsupportedSections: 0,
    overBudgetSections: 0,
};

function isHealthFacts(value: unknown): value is StructuredMemoryHealthFacts {
    return (
        isPlainObject(value) &&
        typeof value.paused === "boolean" &&
        [value.storedStale, value.pendingRepairs, value.unsupportedSections, value.overBudgetSections].every(
            (count) => storedCount(count) !== undefined,
        )
    );
}

/**
 * A reader of the lists does not fail over `adoption`, `rebuild`, `recordedLanguage`, or `health`, which
 * only the panel reads; a malformed one is refused. Contents without a `trash` list, from before pages
 * could be trashed, hold none.
 */
function parseContents(body: AnswerBody): StructuredMemoryContentsAnswer | null {
    const { revision, pages, events, threads, runs, trash = [], adoption = NO_ADOPTION } = body;
    const { rebuild = null, recordedLanguage = null, health = NO_HEALTH } = body;
    return typeof revision === "string" &&
        [pages, trash, events, threads, runs].every((list) => Array.isArray(list)) &&
        isAdoption(adoption) &&
        (rebuild === null || isRebuild(rebuild)) &&
        (recordedLanguage === null || typeof recordedLanguage === "string") &&
        isHealthFacts(health)
        ? ({ ...body, trash, adoption, rebuild, recordedLanguage, health } as StructuredMemoryContentsAnswer)
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

function parseRevertAnswer(body: AnswerBody): StructuredMemoryRevertAnswer | null {
    const { revision, data, reverted, laterEvents } = body;
    return typeof revision === "string" &&
        isPlainObject(data) &&
        typeof reverted === "boolean" &&
        storedCount(laterEvents) !== undefined
        ? (body as StructuredMemoryRevertAnswer)
        : null;
}

function parsePageToolAnswer(body: AnswerBody): StructuredMemoryPageToolAnswer | null {
    const { revision, data } = body;
    return typeof revision === "string" && (data === null || isPlainObject(data))
        ? (body as StructuredMemoryPageToolAnswer)
        : null;
}

function parseImportAnswer(body: AnswerBody): StructuredMemoryImportAnswer | null {
    const { revision, imported, refusals } = body;
    const counted =
        imported === false ||
        (isPlainObject(imported) &&
            [imported.pages, imported.events, imported.threads].every((count) => storedCount(count) !== undefined));
    return typeof revision === "string" && counted && Array.isArray(refusals)
        ? (body as StructuredMemoryImportAnswer)
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

function parseCostAnswer(body: AnswerBody): StructuredMemoryCostAnswer | null {
    const { calls, messages, estimatedTokens } = body;
    return [calls, messages, estimatedTokens].every((count) => storedCount(count) !== undefined)
        ? (body as StructuredMemoryCostAnswer)
        : null;
}

function parseAbandonAnswer(body: AnswerBody): StructuredMemoryAbandonAnswer | null {
    const { revision, abandoned } = body;
    return typeof revision === "string" && typeof abandoned === "boolean"
        ? (body as StructuredMemoryAbandonAnswer)
        : null;
}

function parseDefaultPrompts(body: AnswerBody): StructuredMemoryDefaultPromptsAnswer | null {
    const { analysis, patch } = body;
    const isPrompt = (value: unknown) =>
        isPlainObject(value) && [value.frame, value.format, value.rules].every((text) => typeof text === "string");
    return isPrompt(analysis) && isPrompt(patch) ? (body as StructuredMemoryDefaultPromptsAnswer) : null;
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

/**
 * The answer is a prefix of the request, by position: one to `length` entries for a request that named
 * any chat. An empty list, or one past the request, says nothing of the chats it named.
 */
function parseHealth(body: AnswerBody, length: number): StructuredMemoryHealthAnswer | null {
    const { health } = body;
    return Array.isArray(health) &&
        health.length >= Math.min(1, length) &&
        health.length <= length &&
        health.every((entry) => entry === null || isHealthFacts(entry))
        ? (body as StructuredMemoryHealthAnswer)
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
 * Undoes the writer's change `historyId` names on page `pageId`. The page's record gives the revision, so
 * a press names the memory as it stands now, and the server's refusals answer for what stands on the
 * change. The answer's revision is what the next edit names, and `laterEvents` what the notice counts.
 * The caller shows the notice, for a refusal as well.
 */
export async function revertStructuredMemoryChange(
    ref: ChatRef,
    pageId: string,
    historyId: string,
): Promise<StructuredMemoryResult<StructuredMemoryRevertAnswer>> {
    const record = await readStructuredMemoryRecord(ref, "pages", pageId);
    if (record.outcome !== "ok") {
        return record;
    }
    return readAnswer(`${chatPath(ref)}/revert`, parseRevertAnswer, revertRefusalOf, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: record.value.revision, pageId, historyId }),
    });
}

/**
 * Sends one person's tool over a page as a whole, named against the memory read at `revision`: to the
 * trash and back, deleted for good, merged into another page, or split. The answer's revision is what the
 * next edit names, and its `data` the page the tab shows next, null after a purge. The caller shows the
 * notice for a refusal; a 400's text says what the pages refused.
 */
export function structuredMemoryPageTool(
    ref: ChatRef,
    revision: string,
    tool: StructuredMemoryPageTool,
): Promise<StructuredMemoryResult<StructuredMemoryPageToolAnswer>> {
    return readAnswer(`${chatPath(ref)}/page-tools`, parsePageToolAnswer, editRefusalOf, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, tool }),
    });
}

/**
 * The `.md` entries of `zip`, a package as `buildStructuredMemoryPackage` wrote it, with their text, or `tooLarge` once
 * the entries' declared sizes pass `MEMORY_RESTORE_BODY_BYTES`. fflate's `unzipSync` filter adds each `.md` entry's
 * `originalSize` before inflating that entry; earlier entries may already be inflated when a later entry crosses the
 * cap. Directories and other files are left out: the server refuses what it does not know by name. Invalid UTF-8 bytes
 * become replacement characters; `server/src/prompt/memory/structured/importPackage.ts` checks grammar and record
 * shape, so replacements inside a valid body can be imported.
 */
function packageFiles(zip: Uint8Array): StructuredMemoryResult<ImportFiles> {
    let declared = 0;
    const over = new Error("over the import's size cap");
    try {
        const entries = unzipSync(zip, {
            filter: ({ name, originalSize }) => {
                if (name.endsWith("/") || !name.endsWith(".md")) {
                    return false;
                }
                declared += originalSize;
                if (declared > MEMORY_RESTORE_BODY_BYTES) {
                    throw over;
                }
                return true;
            },
        });
        const files = Object.entries(entries).map(([path, bytes]) => ({ path, text: strFromU8(bytes) }));
        return { outcome: "ok", value: { files } };
    } catch (error) {
        return error === over
            ? { outcome: "refused", reason: "tooLarge" }
            : { outcome: "failed", error: errorText(error) };
    }
}

/**
 * Gives `ref`, a chat with no records, the records of the package `zip` holds, against the memory read at
 * `revision`. The tab unzips here and sends the Markdown; the server reads it back and takes what stands,
 * and its answer lists what each refused file got wrong. A chat that holds a row of any kind answers
 * `imported: false`. The caller shows the notice for a refusal.
 */
export function importStructuredMemoryPackage(
    ref: ChatRef,
    revision: string,
    zip: Uint8Array,
): Promise<StructuredMemoryResult<StructuredMemoryImportAnswer>> {
    const unzipped = packageFiles(zip);
    if (unzipped.outcome !== "ok") {
        return Promise.resolve(unzipped);
    }
    return readAnswer(`${chatPath(ref)}/import`, parseImportAnswer, restoreRefusalOf, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, files: unzipped.value.files }),
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

/** The writer's default frames and slot texts: what the settings page shows, and what seeds a custom prompt. */
export function readStructuredMemoryDefaultPrompts(): Promise<
    StructuredMemoryResult<StructuredMemoryDefaultPromptsAnswer>
> {
    return readAnswer(`${STRUCTURED_MEMORY_PATH}/default-prompts`, parseDefaultPrompts);
}

/**
 * What a rebuild, a backfill, or a press of record now through `through` would cost, an estimate of the
 * analysis calls alone. `turns` is what the tab would ask for.
 */
export function readStructuredMemoryCost(
    ref: ChatRef,
    { mode, turns, through }: { mode: StructuredMemoryCostMode; turns: 1 | 2; through?: string },
): Promise<StructuredMemoryResult<StructuredMemoryCostAnswer>> {
    const query = new URLSearchParams({ mode, turns: String(turns) });
    if (through !== undefined) {
        query.set("through", through);
    }
    return readAnswer(`${chatPath(ref)}/cost?${query}`, parseCostAnswer);
}

/**
 * Ends the rebuild of `ref`: its task stops, and the run and what it staged go, with the chat's records and
 * memory revision left alone. A chat with no run answers `abandoned: false`. The caller shows the notice for
 * a refusal.
 */
export function abandonStructuredMemoryRebuild(
    ref: ChatRef,
): Promise<StructuredMemoryResult<StructuredMemoryAbandonAnswer>> {
    return readAnswer(`${chatPath(ref)}/rebuild/abandon`, parseAbandonAnswer, editRefusalOf, { method: "POST" });
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
 * The health facts of a prefix of `refs`, by position, in one request (`MEMORY_HEALTH_CHATS_MAX` at
 * most), reading no message: the server stops before the chat that would take its scan past
 * `MEMORY_HEALTH_ROUND_BYTES`, so a caller asks again from the first entry it did not get. A null entry
 * is an answer: the chat does not exist.
 */
export function readStructuredMemoryHealth(
    refs: readonly ChatRef[],
    signal?: AbortSignal,
): Promise<StructuredMemoryResult<StructuredMemoryHealthAnswer>> {
    return readAnswer(`${STRUCTURED_MEMORY_PATH}/health`, (body) => parseHealth(body, refs.length), refusalOf, {
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
                const { revision, pages, trash, events, threads, runs } = contents.value;
                if (pages.length + events.length + threads.length === 0) {
                    const rows = runs.length > 0 || trash.length > 0;
                    return { outcome: "ok", value: { rows, pages: [], events: [], threads: [] } };
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

/** The header of the timeline and the threads file: the package's version and the revision it was read at. */
function packageHeader(revision: string): string[] {
    return ["---", `packageVersion: ${MEMORY_PACKAGE_VERSION}`, `revision: ${metadataValue(revision)}`, "---", ""];
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
    const lines = [...packageHeader(revision)];
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

/** The threads file: each thread in the given order, with its fields in a YAML fence under its title. */
export function renderMemoryThreads(threads: readonly MemoryThread[], revision: string): string {
    const lines = [...packageHeader(revision)];
    for (const thread of threads) {
        lines.push(`## ${collapsed(thread.title)}`, "", "```yaml", ...metadataLines(thread, []), "```", "");
    }
    return fileText(lines);
}

/** A chat's id as a file name's part: a resource id may hold what a file name cannot. */
function chatFilePart(ref: ChatRef): string {
    return encodeURIComponent(ref.chatId).replace(/%/g, "_");
}

function zipPackage(
    ref: ChatRef,
    { revision, pages, events }: PackageRead,
    threads: readonly MemoryThread[],
): { name: string; bytes: Uint8Array } {
    const files: Zippable = {
        "timeline.md": strToU8(renderMemoryTimeline(events, revision)),
        "threads.md": strToU8(renderMemoryThreads(threads, revision)),
    };
    for (const page of pages) {
        files[memoryPagePath(page)] = strToU8(renderMemoryPage(page));
    }
    return { name: `structured-memory-${chatFilePart(ref)}.zip`, bytes: zipSync(files) };
}

/**
 * The chat's pages, events, and threads as a zip for `downloadFile`, all read at one revision. A change of
 * the chat's memory during the read restarts it with nothing kept, and a chat that keeps changing is
 * refused `changed`.
 */
export function buildStructuredMemoryPackage(
    ref: ChatRef,
): Promise<StructuredMemoryResult<{ name: string; bytes: Uint8Array }>> {
    return readAtOneRevision(async () => {
        const read = await readPackage(ref);
        if (read.outcome !== "ok") {
            return read;
        }
        const threads = await readThreads(ref, { revision: read.value.revision });
        return threads.outcome === "ok"
            ? { outcome: "ok", value: zipPackage(ref, read.value, threads.value) }
            : threads;
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

/**
 * What a panel tab can send the panel to: an event in Timeline or a page in Pages, where `historyId` opens
 * that entry's diff.
 */
export type MemoryPanelTarget = { tab: "timeline" | "pages"; id: string; historyId?: string };

/** What a press asked of a panel that was not mounted yet, for the chat it was pressed in. */
let pendingPanelTarget: { ref: ChatRef; target: MemoryPanelTarget } | null = null;

/**
 * Asks the next panel to mount for `ref` to show `target`. A panel that is not there can take no event, so
 * it asks here, as it mounts. Only a closed panel needs this: an open one covers the whole screen.
 */
export function requestMemoryPanelTarget(ref: ChatRef, target: MemoryPanelTarget): void {
    pendingPanelTarget = { ref, target };
}

/** What `requestMemoryPanelTarget` left for `ref`, once; what it left for another chat goes all the same. */
export function takeMemoryPanelTarget(ref: ChatRef | null): MemoryPanelTarget | null {
    const pending = pendingPanelTarget;
    pendingPanelTarget = null;
    return pending && ref && pending.ref.chaId === ref.chaId && pending.ref.chatId === ref.chatId
        ? pending.target
        : null;
}

/**
 * The panel/tab boundary: a tab exists only while selected. `refresh` requests a read; it is not a
 * signal to run Preview, whose local send itself moves refresh. `readOnly` disables controls before
 * server/src/routes/structuredMemory.ts enforces its write fence. `open` becomes the chosen tab's
 * `focus`; `jump` opens the chat before requesting the message and closing the panel.
 */
export type MemoryPanelTabProps = {
    chatRef: ChatRef;
    readOnly: boolean;
    refresh: number;
    /** What to show after a jump from another tab or a receipt, or null. */
    focus: MemoryPanelTarget | null;
    open: (target: MemoryPanelTarget) => void;
    /** Leaves the panel for this message in the chat. */
    jump: (messageId: string) => void;
};

/** What the memory panel says of a stored message. */
export const MEMORY_COVERAGE_STATES = ["covered", "pending", "failed", "skipped", "excluded", "stale"] as const;
/** A display state derived from current messages and record facts, never a persisted message outcome. */
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

/** Stored-text coverage and window indices for display; a send can differ after scripts, greeting, and trim. */
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
 * The route's stored `status`, `sources`, and `keptState` are inputs to the rule in
 * shared/structuredMemory.ts; carry `rerecord` through the returned copy for the repair views too.
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
 * else `stale`, else `excluded` by a suppressed event, else by a retracted one. Then a reply the
 * preset's `screening` keeps out of the writer's windows (`memoryScreenReason`) is `excluded` with its
 * screening reason. Then the newest non-recorded run that names it. Then its own stored receipt when
 * that is a notice no run row stands behind (`notAutomatic`, `skipped`), read as `skipped`. Anything
 * else is `pending`: a missing receipt proves nothing, so the newest reply reads `pending` too.
 *
 * `gap` and `leaving` come from `rawWindow` over the eligible stored messages, so they are a reading of
 * the stored text and not a send's prediction: a send works from processed text with the greeting, and
 * can also trim uncovered history that no longer fits. A screened reply is no gap, since nothing will
 * record it, though its raw text stays in the prompt as any uncovered message's does. A send of a chat
 * with `memoryOn` false runs no memory, so nothing leaves.
 */
export function joinMemoryCoverage(
    messages: readonly DeepReadonly<Message>[],
    facts: CoverageFacts,
    {
        windowTurns,
        memoryOn,
        screening,
    }: { windowTurns: number; memoryOn: boolean; screening: StructuredMemorySettings["screening"] },
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
    const decide = (message: DeepReadonly<Message>, index: number): CoverageDecision => {
        const { chatId: id, generationInfo } = message;
        if (!read.has(index)) {
            return { state: "excluded", reason: "disabled" };
        }
        const citation = id === undefined ? undefined : citations.get(id);
        if (citation) {
            const { state, eventId, reason } = citation;
            return { state, eventId, ...present("reason", reason) };
        }
        const screened = memoryScreenReason(message, screening);
        if (screened !== null) {
            return { state: "excluded", reason: screened };
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
        const { index } = eligible[position];
        if (!dropped.has(position)) {
            if (memoryScreenReason(messages[index], screening) === null) {
                gap.push(index);
            }
        } else if (memoryOn) {
            leaving.push(index);
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
export type MemoryPageHistoryRow = Pick<MemoryPageHistoryEntry, "id" | "heading" | "kind" | "at" | "highlighted"> & {
    /** The section's text before and after the change; null where it had none. */
    before: string | null;
    after: string | null;
    /** A person undid the change. */
    reverted: boolean;
    /** A writer's change of a section that is not undone yet. */
    revertable: boolean;
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
    return [...history].reverse().map(({ id, heading, kind, at, before, highlighted, revertedBy, eventId }) => {
        const reverted = revertedBy !== undefined;
        const row = { id, heading, kind, at, highlighted, reverted };
        if (heading === null) {
            return { ...row, before: null, after: null, revertable: false };
        }
        const after = states.get(heading) ?? null;
        states.set(heading, before?.body ?? null);
        const revertable = eventId !== undefined && kind !== "edit" && kind !== "revert" && !reverted;
        return { ...row, before: before?.body ?? null, after, revertable };
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
    /** The model's answer a failed run could not read. */
    answer?: string;
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
    /** The preset's own prompts stood in for the defaults. */
    customPrompt: boolean;
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
        ...present("answer", storedText(stored.answer)),
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
        customPrompt: stored.customPrompt === true,
    };
}

/** What the settings page shows of a test run: the shared result with its lists as plain text and its answers as data. */
export type MemoryTestResultView = MemoryReceiptLists &
    Omit<StructuredMemoryTestResult, "kind" | "analysis" | "patches" | keyof MemoryReceiptLists> & {
        /** The model's answers as parsed, shown as text; absent when the call did not get that far. */
        analysis?: unknown;
        patches?: unknown;
    };

const TEST_OUTCOMES: readonly StructuredMemoryTestResult["outcome"][] = ["recorded", "failed", "skipped", "none"];

/**
 * What a `memoryTest` job's `done.result` shows, read as data of any shape: null for a result of another
 * kind, which is what a retained terminal, stripped of its payload, or another job's terminal gives.
 */
export function memoryTestResultView(result: unknown): MemoryTestResultView | null {
    if (!isPlainObject(result) || result.kind !== "memoryTest") {
        return null;
    }
    const outcome = TEST_OUTCOMES.find((entry) => entry === result.outcome);
    if (outcome === undefined) {
        return null;
    }
    const slotWarnings = (value: unknown): StructuredMemorySlotWarnings => {
        const stored = isPlainObject(value) ? value : {};
        return { unquoted: storedTexts(stored.unquoted), unknown: storedTexts(stored.unknown) };
    };
    const slots = isPlainObject(result.slots) ? result.slots : {};
    return {
        customPrompt: result.customPrompt === true,
        slots: { analysis: slotWarnings(slots.analysis), patch: slotWarnings(slots.patch) },
        messageIds: storedTexts(result.messageIds),
        outcome,
        ...present("reason", storedText(result.reason)),
        ...present("error", storedText(result.error)),
        ...(isPlainObject(result.analysis) ? { analysis: result.analysis } : {}),
        ...(Array.isArray(result.patches) ? { patches: result.patches } : {}),
        patchCalled: result.patchCalled === true,
        ...receiptLists(result),
        ...present("model", storedText(result.model) || undefined),
        inputTokens: storedCount(result.inputTokens) ?? 0,
        outputTokens: storedCount(result.outputTokens) ?? 0,
    };
}
