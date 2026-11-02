import {
    type ContextMemoryExcluded,
    type ContextMemoryStage,
    type ContextMemoryWriter,
    reportedMemoryExclusions,
} from "../../../../../shared/contextReport.ts";
import type { Message } from "../../../../../shared/database.ts";
import type { HypaV3BudgetReduction } from "../../../../../shared/hypaV3Presets.ts";
import type { HypaV3Settings } from "../../../../../shared/memory.ts";
import type { OpenAIChat } from "../../../../../shared/openai.ts";
import {
    type MemoryEvent,
    type MemoryManifestItem,
    type MemoryPage,
    type MemoryReceipt,
    type MemoryThread,
    memoryThreadEnded,
    normalizeStructuredMemorySettings,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryContents } from "../../../data/memoryStore.ts";
import type { ResourceStore } from "../../../data/resourceStore.ts";
import type { MemoryHost, MemoryTokenizer } from "../host.ts";
import { trimHistoryToContext } from "../hypav3.ts";
import { buildMemoryCard, type MemoryCard } from "./card.ts";
import {
    coveredMessages,
    type ExcludedItem,
    type LaneSpend,
    rawWindow,
    type RawWindow,
    readBudget,
    type ReadEntry,
} from "./lanes.ts";
import { reconcileEvents } from "./reconcile.ts";
import { retrieveLanes } from "./retrieve.ts";
import { chatAdoptionHold, writerPaused } from "./writer.ts";

/**
 * A send's read of Structured Memory: which stored records it sees, what of its history leaves the
 * prompt, and the memory card's entries. Nothing here writes, so a preview runs all of it;
 * `structuredMemoryStep` in `assemble.ts` owns what concerns the job, the gap question and the hand-off.
 *
 * - Two sets come from the same events and answer different questions: `coveredMessages` (active and
 *   not suppressed) says what may leave the prompt, `recordedMessages` (any status) what the writer must
 *   not record again. History cited only by a stale or retracted event is recorded but not covered, so
 *   it stays raw with no work left to offer.
 * - A selection reconciles the events it is given against the stored messages (`reconcileEvents`), on a
 *   copy, before it reads them: an event whose source changed stands in for nothing in this send, and
 *   the report says why. `recordedMessages` reads the events as stored.
 * - History before the window leaves where an event covers it. The message a continue extends stays,
 *   out of the evidence too. What remains trims oldest first as HypaV3's select-only path does. The
 *   window and that message are never dropped, and the final recheck never removes them.
 * - A card with no item adds no entry, so it costs nothing. The volatile part goes into the card's
 *   entry, or under `volatileBeforeLastUser` stays out of the history altogether: there a chat range
 *   could cut it, and a `memory` prompt card would pull it away from the latest user message.
 * - Required pages that do not fit end the send naming them, whatever `inlayErrorResponse` says: only a
 *   person can shorten or demote a page, so no reply may stand in for that.
 */

/** The English text of `language.structuredMemory.requiredOverCap`, which the server cannot import. */
function requiredOverCap(tokens: number, limit: number, pages: string): string {
    return `Error: The required memory pages need ${tokens} tokens, over the limit of ${limit}: ${pages}. Shorten a page, or set it to auto.`;
}

/** What a send reads of a chat's records. */
export type MemoryRecords = {
    /** Every event, in any status. */
    events: MemoryEvent[];
    /** The threads not ended. */
    threads: MemoryThread[];
    /** Every page, in stored order. */
    pages: MemoryPage[];
    /** The page ids the scene page has present; empty with no scene page. */
    stage: string[];
    /** The run rows, never a run's body: that holds a whole prompt. */
    runs: MemoryContents["runs"];
    /** Whether automatic recording is paused (`writerPaused`). */
    paused: boolean;
    /** The chat waits for a person to adopt or decline its HypaV3 summaries (`chatAdoptionHold`). */
    adoptionHeld?: true;
};

/** What a selection reads besides the records, which is the same on a second pass. */
export type MemorySelectionInput = {
    host: Pick<MemoryHost, "db" | "embeddings" | "fence">;
    settings: HypaV3Settings;
    tokenizer: MemoryTokenizer;
    /** The prompt's history side before the step: examples, the new-chat marker, then the entries. */
    chats: readonly OpenAIChat[];
    /** Where the entries start in `chats`. */
    historyStart: number;
    /** One per entry of `chats` from `historyStart` on. */
    entries: readonly ReadEntry[];
    /** The chat's messages as stored, whole: what an event's sources are checked against. */
    messages: readonly Message[];
    /** The count with `chats` in it, the response budget included. */
    currentTokens: number;
    maxContextTokens: number;
    /** The message a continue extends. */
    continueMessageId: string | undefined;
    /** The text a protected tail over the context fails with. */
    tooMuchToken: string;
};

/** A selection's prompt part and what its report says. */
export type MemorySelected = {
    type: "selected";
    /** The card, when it has an item, then the entries left, by identity. */
    chats: OpenAIChat[];
    currentTokens: number;
    /** The window and an older continue target: the final recheck removes neither. */
    protectedEntries: OpenAIChat[];
    /** The card's volatile part when it stays out of `chats`; assembly places it. */
    volatile: OpenAIChat | null;
    /** The tokens of the history the trim dropped. */
    gapTokens: number;
    /** What the report says of the history that left the prompt. */
    coverage: "covered" | "gap";
    budget: { maximum: number; reduced: readonly HypaV3BudgetReduction[] };
    items: MemoryManifestItem[];
    excluded: ExcludedItem[];
    lanes: LaneSpend[];
    lanesStage: "filled" | "empty" | "similarityFailed";
};

/**
 * A selection that does not fit fails the send: `error` names the tokens it needs. `error` is what a send
 * shows its own way, into the chat under `inlayErrorResponse`, and `alert` always ends it with a `SendError`.
 */
export type MemorySelection = MemorySelected | { type: "error"; error: string } | { type: "alert"; error: string };

/** A send's manifest as the step knows it. `buildContextReport` adds what only the final prompt can say. */
export type MemorySendManifest = {
    /** None verified yet. */
    items: readonly MemoryManifestItem[];
    excluded: readonly ContextMemoryExcluded[];
    excludedTotal: number;
    lanes: readonly LaneSpend[];
    confirmedThrough?: string;
    writer: ContextMemoryWriter;
    /** The ledger's stages before the card's. */
    stages: readonly ContextMemoryStage[];
    /** The writer stage's reason, on an input job with a memory task service. */
    writerStage?: string;
};

/**
 * The chat's records in one synchronous read, so a send reads every event and page once. Empty for a
 * missing chat.
 */
export function readMemoryRecords(
    store: Pick<ResourceStore, "memory" | "chatMeta">,
    chaId: string,
    chatId: string,
): MemoryRecords {
    const contents = store.memory.readContents(chaId, chatId);
    const runs = contents?.runs ?? [];
    const events = contents?.events ?? [];
    const threads = (contents?.threads ?? []).filter(({ state }) => !memoryThreadEnded(state));
    const pages = (contents?.pages ?? []).flatMap(
        ({ id }) => store.memory.readRecord(chaId, chatId, "pages", id)?.data ?? [],
    );
    return {
        events: events.flatMap(({ id }) => store.memory.readRecord(chaId, chatId, "events", id)?.data ?? []),
        threads: threads.flatMap(({ id }) => store.memory.readRecord(chaId, chatId, "threads", id)?.data ?? []),
        pages,
        stage: pages.find(({ type }) => type === "scene")?.participants ?? [],
        runs,
        paused: writerPaused(runs),
        ...(contents && chatAdoptionHold(store, chaId, chatId, contents) > 0 ? { adoptionHeld: true as const } : {}),
    };
}

/**
 * One `ReadEntry` per entry of `history`, the greeting (when the send has one) and then one entry for
 * each of `messages`, which built them. The greeting has no stored message behind it.
 */
export function readEntries(history: readonly OpenAIChat[], messages: readonly Message[]): ReadEntry[] {
    const first = history.length - messages.length;
    return history.map(({ content }, index) => {
        const message = index < first ? undefined : messages[index - first];
        return { messageId: message?.chatId, role: message?.role, text: content };
    });
}

/** A history entry with nothing to send: blank text and no media. Formatting drops it. */
export function blankEntry({ content, multimodals }: Pick<OpenAIChat, "content" | "multimodals">): boolean {
    return content.trim() === "" && !(multimodals && multimodals.length > 0);
}

/** `rawWindow` without the entry at `continued` among what leaves the prompt. */
function sendWindow(
    entries: readonly ReadEntry[],
    continued: number,
    options: Parameters<typeof rawWindow>[1],
): RawWindow {
    const { start, dropped } = rawWindow(entries, options);
    const left = new Set(dropped);
    left.delete(continued);
    return { start, dropped: left };
}

/** The card as prompt entries: `apart` keeps a volatile part out of the card's own. */
function cardEntries(
    { stable, volatile, items }: MemoryCard,
    apart: boolean,
): { card: OpenAIChat | null; volatile: OpenAIChat | null } {
    if (items.length === 0) {
        return { card: null, volatile: null };
    }
    const entry = (content: string): OpenAIChat => ({ role: "system", memo: "supaMemory", content });
    if (volatile === "") {
        return { card: entry(stable), volatile: null };
    }
    return apart
        ? { card: entry(stable), volatile: entry(volatile) }
        : { card: entry(`${stable}\n\n${volatile}`), volatile: null };
}

/**
 * What `records` make of the send's history. Every step counts with the job's tokenizer: the entries
 * that leave come off the count, the card's entries go on it, then the trim runs over what is left.
 * `input` and `records` are not changed, and every entry `chats` keeps is the same object, so a second
 * pass after the records changed starts over from it, and reconciles what it is given again.
 *
 * `coverage` is `gap` when the trim dropped history, or when covered history with something to send
 * left and the card that stands in for it is empty: the events cover it, but the model does not see
 * them. Only `gapTokens` drives the gap question, so that second case asks nothing.
 */
export async function selectMemory(
    input: MemorySelectionInput,
    records: Pick<MemoryRecords, "events" | "threads" | "pages" | "stage">,
): Promise<MemorySelection> {
    const { host, settings, tokenizer, chats, historyStart, entries, maxContextTokens, continueMessageId } = input;
    const structured = normalizeStructuredMemorySettings(settings.structured);
    const events = reconcileEvents(records.events, input.messages);
    const continued =
        continueMessageId === undefined ? -1 : entries.findIndex(({ messageId }) => messageId === continueMessageId);
    const window = sendWindow(entries, continued, {
        windowTurns: structured.windowTurns,
        covered: coveredMessages(events),
    });

    const retrieved = await retrieveLanes(host, {
        events,
        threads: records.threads,
        pages: records.pages,
        entries,
        window,
        stage: records.stage,
        settings: structured,
    });
    const { maximum, reduced } = readBudget(settings, maxContextTokens, host.db.maxResponse);
    const card = await buildMemoryCard(tokenizer, { maximum, lanes: retrieved.lanes });
    if (card.type === "requiredOverLimit") {
        const titles = new Map(records.pages.map(({ id, title }) => [id, title]));
        const pages = card.pages.map(({ id, tokens }) => `${titles.get(id) ?? id} (${tokens})`);
        return { type: "alert", error: requiredOverCap(card.tokens, card.limit, pages.join(", ")) };
    }
    const placed = cardEntries(card, structured.volatileBeforeLastUser);

    const history = chats.slice(historyStart);
    let currentTokens = input.currentTokens;
    for (const index of window.dropped) {
        currentTokens -= await tokenizer.tokenizeChat(history[index]);
    }
    for (const entry of [placed.card, placed.volatile]) {
        if (entry) {
            currentTokens += await tokenizer.tokenizeChat(entry);
        }
    }

    const raw = [...chats.slice(0, historyStart), ...history.filter((_, index) => !window.dropped.has(index))];
    // Nothing from the window on left, so the tail is as long in `raw` as in `history`.
    const protectedStart = raw.length - (history.length - window.start);
    const pinned = new Set(continued !== -1 && continued < window.start ? [history[continued]] : []);
    const trimmed = await trimHistoryToContext({
        raw,
        protectedStart,
        pinned,
        maxContextTokens,
        currentTokens,
        tokenizer,
    });
    if (!trimmed.fits) {
        return { type: "error", error: `${input.tooMuchToken}\n\nRequired Tokens: ${trimmed.currentTokens}` };
    }
    const unseen = card.items.length === 0 && [...window.dropped].some((index) => !blankEntry(history[index]));
    return {
        type: "selected",
        chats: placed.card ? [placed.card, ...trimmed.history] : trimmed.history,
        currentTokens: trimmed.currentTokens,
        protectedEntries: [...raw.slice(protectedStart), ...pinned],
        volatile: placed.volatile,
        gapTokens: trimmed.gap.tokens,
        coverage: trimmed.gap.tokens > 0 || unseen ? "gap" : "covered",
        // The preset's headroom and extra are the summarizer's: this budget spends neither.
        budget: { maximum, reduced: reduced.filter(({ field }) => field === "memory") },
        items: card.items,
        excluded: [...retrieved.excluded, ...card.excluded],
        lanes: card.spend,
        lanesStage: retrieved.similarity === "failed" ? "similarityFailed" : card.items.length > 0 ? "filled" : "empty",
    };
}

/**
 * The writer's state at a send: what `notice` says, else whether its newest finished run failed, else
 * whether the newest confirmed reply (`through`) is recorded. A skipped run says nothing about the writer.
 */
export function writerState(
    notice: Pick<MemoryReceipt, "state" | "reason"> | undefined,
    runs: MemoryRecords["runs"],
    through: string | undefined,
    recorded: ReadonlySet<string>,
): ContextMemoryWriter {
    if (notice) {
        return {
            state: notice.state === "notAutomatic" ? "notAutomatic" : "paused",
            ...(notice.reason !== undefined ? { reason: notice.reason } : {}),
        };
    }
    if (runs.findLast(({ result }) => result === "recorded" || result === "failed")?.result === "failed") {
        return { state: "failed" };
    }
    return { state: through !== undefined && !recorded.has(through) ? "pending" : "recorded" };
}

/** The manifest of a send that ended up with `selected`: `gap` is the gap stage's reason when there was a gap. */
export function sendManifest(
    selected: MemorySelected,
    arg: { confirmedThrough: string | undefined; writer: ContextMemoryWriter; gap?: string; writerStage?: string },
): MemorySendManifest {
    const { confirmedThrough, writer, gap, writerStage } = arg;
    return {
        items: selected.items,
        excluded: reportedMemoryExclusions(selected.excluded),
        excludedTotal: selected.excluded.length,
        lanes: selected.lanes,
        ...(confirmedThrough !== undefined ? { confirmedThrough } : {}),
        writer,
        stages: [
            { stage: "window", reason: "chosen" },
            { stage: "lanes", reason: selected.lanesStage },
            ...(gap !== undefined ? [{ stage: "gap" as const, reason: gap }] : []),
        ],
        ...(writerStage !== undefined ? { writerStage } : {}),
    };
}
