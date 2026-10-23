import { createHash } from "node:crypto";
import type { Chat, character, groupChat, Message } from "../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import {
    type HypaV3Data,
    type HypaV3Preset,
    type HypaV3Settings,
    mergeHypaV3Write,
    remapHypaV3MetricsByIdentity,
    type SerializableHypaV3Data,
    type Summary,
} from "../../../../shared/memory.ts";
import type { OpenAIChat } from "../../../../shared/openai.ts";
import { type BatchResult, type TaskResult, TaskRateLimiter } from "../../../../shared/taskRateLimiter.ts";
import { DEFAULT_REGEX_DEADLINE_MS } from "../../scripts/workerPool.ts";
import {
    contextualChunkCacheKey,
    ContextualEmbeddingCountError,
    type EmbeddingResult,
    type EmbeddingText,
    getContextProvider,
    HypaProcesser,
    HypaProcessorV2,
    isContextModel,
    type memoryVector,
    similarity,
} from "../embeddings.ts";
import type { MemoryHost, MemoryTokenizer } from "./host.ts";

// `hypaMemoryV3` of `src/ts/process/memory/hypav3.ts` (the standard and the experimental
// implementation), statement for statement, on a `MemoryHost`.
//
// - The summaries come from the job's `memory` request. A preset whose summarization model is one of
//   the browser's WebLLM models cannot run here: the summary fails with an explicit error where the
//   client would call the engine, so a send that needs no new summary still works.
// - The progress store's writes are `progress` notices to the job's tab.
// - The random selection's shuffle draws from the host's random source.
// - `summaryChunkSeparator` is the owner's setting; valid regular expressions run on script workers
//   with per-task deadlines and a cumulative chunking budget. Invalid patterns keep the tab's fallback.
// - The mains are split into parts: `prepareHypaV3` (the stored data and the token ledger),
//   `planHypaV3Summaries` (the summary windows, without a request), `executeHypaV3Plan` (the
//   summaries), and `selectHypaV3` (the memory card). `hypaMemoryV3` composes them with the mains'
//   requests, progress, results, and error positions. The planner tokenizes every window before the
//   first summary request, where the standard main tokenized each window just before summarizing it.
// - Beyond that composition, the parts take options and hooks the composition never passes: a
//   prepare without the orphan cleanup, lookahead planning, an execution that validates and saves
//   each summary as it is made and can stop between windows, a selection that trims the history no
//   summary covers instead of summarizing it, and the warming of the new summaries' vectors.

interface SummaryChunk {
    text: string;
    summary: Summary;
}

export interface HypaV3Result {
    currentTokens: number;
    chats: OpenAIChat[];
    error?: string;
    memory?: SerializableHypaV3Data;
}

const logPrefix = "[HypaV3]";
/** `inlayTokenRegex` of `src/ts/util/inlayTokens.ts`. */
const inlayTokenRegex = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;
/** The error of a local (WebLLM) summarization model, which the server cannot run. */
export const LOCAL_SUMMARIZATION_UNSUPPORTED = "Local summarization models are unsupported on the server";
const memoryPromptTag = "Past Events Summary";
const summarySeparator = "\n\n";
const SEPARATOR_BUDGET_MS = 5000;

async function splitBySeparator(
    host: MemoryHost,
    text: string,
    separator: string,
    chunkingStartedAt: number,
): Promise<string[]> {
    const budgetMs = host.separatorLimits?.budgetMs ?? SEPARATOR_BUDGET_MS;
    const regexDeadlineMs = host.separatorLimits?.regexDeadlineMs ?? DEFAULT_REGEX_DEADLINE_MS;
    const remaining = budgetMs - (performance.now() - chunkingStartedAt);
    if (remaining <= 0) {
        throw new Error(`Summary chunk separator timed out: ${budgetMs} ms chunking budget exhausted`);
    }
    let pattern = separator;
    let flags = "";
    try {
        const regexMatch = separator.match(/^\/(.+)\/([gimuy]*)$/);
        if (regexMatch) {
            [, pattern, flags] = regexMatch;
        }
        new RegExp(pattern, flags);
    } catch {
        return text.split("\n\n");
    }
    const result = await host.regex(
        { op: "split", pattern, flags, input: text },
        { deadlineMs: Math.min(regexDeadlineMs, remaining) },
    );
    host.fence();
    if (performance.now() - chunkingStartedAt >= budgetMs) {
        throw new Error(`Summary chunk separator timed out: ${budgetMs} ms chunking budget exhausted`);
    }
    if ("error" in result) {
        throw new Error(result.error);
    }
    return result.value as string[];
}

/** Which main the selected preset runs (`useExperimentalImpl`). */
export type HypaV3Implementation = "standard" | "experimental";

/**
 * The base token accounting of one V3 step. `current` is the count the window scan starts from,
 * computed in the mains' statement order: the incoming count, minus the response correction, minus
 * each summarized-prefix message, plus the reservation. The other fields keep each item apart.
 */
export interface HypaV3Ledger {
    /** The count passed in. */
    readonly incoming: number;
    /** `db.maxResponse`, subtracted once. */
    readonly responseCorrection: number;
    /** The summarized prefix's `tokenizeChat` total, subtracted once. */
    readonly prefixTokens: number;
    /** The empty `<Past Events Summary>` card. */
    readonly emptyMemoryTokens: number;
    /** The full memory budget, `floor(maxContextTokens × memoryTokensRatio)`. */
    readonly memoryTokens: number;
    /**
     * What `current` holds for the memory card until selection releases it: standard reserves the
     * empty card (no summaries and it fits) or the full budget; experimental the full budget only
     * when there are summaries or the prompt is over the context, else nothing.
     */
    readonly reservation: { readonly kind: "emptyCard" | "fullBudget" | "none"; readonly tokens: number };
    /** The selection's budget for summaries (the full budget less the empty card, or 0). */
    readonly availableMemoryTokens: number;
    readonly current: number;
}

/**
 * The input of a V3 step and its base accounting. Nothing after `prepareHypaV3` changes it: the
 * executor and the selection work on their own copies of `data`, sharing its summary objects.
 */
export interface HypaV3Prepared {
    readonly implementation: HypaV3Implementation;
    readonly settings: Readonly<HypaV3Settings>;
    /** The processed history as passed in (returned as it is on the error paths). */
    readonly chats: OpenAIChat[];
    readonly maxContextTokens: number;
    readonly tokenizer: MemoryTokenizer;
    /**
     * An independent copy of the stored value exactly as read (a stored `null` stays `null`), before
     * the orphan cleanup: the value `mergeHypaV3Write` compares the stored one with.
     */
    readonly snapshot: SerializableHypaV3Data | null | undefined;
    /** The stored summaries after the orphan cleanup (unless `preserveOrphanedMemory`). */
    readonly data: HypaV3Data;
    /** The summarized-prefix cursor: the history index after the last summary's last message. */
    readonly startIdx: number;
    /**
     * Whether there are summaries and the last one's last message is absent from the history in
     * `chats`. Preparation with options then leaves `startIdx` at 0; no-option calls keep the
     * legacy memo lookup, which can also match examples.
     */
    readonly coverageAhead: boolean;
    readonly ledger: HypaV3Ledger;
}

/** A prepared step, or the settings error the step returns before reading anything. */
export type HypaV3PrepareOutcome = { ok: true; prepared: HypaV3Prepared } | { ok: false; result: HypaV3Result };

export interface HypaV3PrepareOptions {
    /**
     * False: no orphan cleanup, whatever `preserveOrphanedMemory` says (a writer whose history may
     * be older than the stored summaries never removes one). Default true.
     */
    cleanup?: boolean;
}

/** The share of the context a lookahead plan keeps free: it plans from `C × (1 − h)`. */
export const HYPAV3_LOOKAHEAD_HEADROOM = 0.15;

export interface HypaV3PlanOptions {
    /**
     * Plan the summaries the next sends will need before the prompt reaches the context: trigger
     * above `C × (1 − h)`, target `max(0, C × (1 − h − extraSummarizationRatio))`, with the full
     * memory budget counted as a planning cost even without stored summaries. The capacity checks
     * stay at `C`, and only the protected tail left is a normal stop even over `C`.
     */
    lookahead?: boolean;
}

/** One summary window: the history interval it scans and the messages its summary covers. */
export interface HypaV3PlannedWindow {
    readonly scanStart: number;
    readonly scanEnd: number;
    /** The memos of every scanned message, in order (the greeting's is `undefined`). */
    readonly scannedIds: readonly (string | undefined)[];
    /** The scanned messages the summary covers (examples, the new-chat marker, blanks, and user messages under `doNotSummarizeUserMessage` excluded). */
    readonly included: readonly OpenAIChat[];
    readonly includedMemos: readonly (string | undefined)[];
    /** Every scanned message's `tokenizeChat` total: what the prompt loses with the window. */
    readonly removedTokens: number;
    /** Whether the window has messages to summarize; a window without any only moves the cursor. */
    readonly needsLlm: boolean;
}

/**
 * Why the window scan stopped: summarization not needed; at or under the target; only the
 * `queryChatCount` tail left (the prompt must fit unless using lookahead); the next window would
 * go under the target while the prompt fits; or one of the two errors (the tail left and the prompt
 * over the context without lookahead; a window that scans nothing).
 */
export type HypaV3StopReason =
    "notNeeded" | "targetReached" | "tailReached" | "nextWindowOvershoots" | "cannotSummarizeFurther" | "noProgress";

/** The windows a step expects to summarize. A prediction: never the cursor after a failure. */
export interface HypaV3Plan {
    readonly windows: readonly HypaV3PlannedWindow[];
    /** The windows that need a summary request. */
    readonly llmCalls: number;
    readonly stopReason: HypaV3StopReason;
    /**
     * The ledger's count after every planned window, subtracted one window at a time (a lookahead
     * plan's count holds the full memory budget as its planning cost, not the ledger's reservation).
     */
    readonly predictedTokens: number;
    /** The message of `cannotSummarizeFurther` and `noProgress`. */
    readonly error?: string;
}

/** A window that ended successfully: with its summary, or `undefined` when it had nothing to summarize. */
export interface HypaV3ExecutedWindow {
    readonly window: HypaV3PlannedWindow;
    readonly summary: Summary | undefined;
}

interface HypaV3ExecutionState {
    /**
     * The windows that ended successfully, in plan order. Experimental's batch without hooks also
     * lists the successes past a failure; with hooks the list is the accepted windows.
     */
    completed: HypaV3ExecutedWindow[];
    /** How many windows from the plan's first completed one after another: `data` holds their summaries. */
    accepted: number;
    /** The accepted windows' `removedTokens` total. */
    tokenDelta: number;
    /** The ledger's count less each accepted window, one at a time (the reservation still held). */
    currentTokens: number;
    /** The history index after the last accepted window: where the selection's raw history starts. */
    cursor: number;
    /** The prepared data with the accepted summaries appended (a copy; the summary objects shared). */
    data: HypaV3Data;
    /**
     * The value the next memory write starts from: the candidate of the last committed checkpoint
     * (an independent copy), else `prepared.snapshot`. Never the merged stored value.
     */
    baseline: SerializableHypaV3Data | null | undefined;
}

/**
 * What a plan's execution made. Selection reads its cursor, count, and data from here. Without hooks
 * the end is `complete` or `providerFailed`; with hooks also `stopped` (`shouldStop` before a
 * window), `writeSkipped` (a checkpoint refused: the window is not accepted), and `sourceInvalid`
 * (a window failed validation: it and every later window are dropped). An abort is never an end
 * reason: it is thrown through `host.fence()`.
 */
export type HypaV3ExecutionResult = HypaV3ExecutionState &
    (
        | { endReason: "complete" }
        | { endReason: "stopped" }
        | {
              endReason: "writeSkipped" | "sourceInvalid";
              /** The window's index in `plan.windows`. */
              window: number;
          }
        | {
              endReason: "providerFailed";
              /** The first failed window's index in `plan.windows`. */
              failedWindow: number;
              error: string;
          }
    );

/**
 * One summary save of an execution with hooks. `merge` places `candidate` onto the value stored at
 * the write (`mergeHypaV3Write(baseline, candidate, stored, false)`, a stored or baseline `null`
 * compared as today's job write compares it); it captures this checkpoint's baseline and candidate.
 * The hook must not change either.
 */
export interface HypaV3Checkpoint {
    /**
     * The cumulative algorithm data: the prepared data, the accepted summaries, and this window's,
     * with the metrics read moved to the same summaries after the orphan cleanup.
     */
    readonly candidate: SerializableHypaV3Data;
    /** The candidate of the last committed checkpoint, or the prepared snapshot. */
    readonly baseline: SerializableHypaV3Data | null | undefined;
    merge(stored: SerializableHypaV3Data | null | undefined): SerializableHypaV3Data | null;
}

/** What an execution with hooks calls. Every hook is optional; `sequential` defaults to false. */
export interface HypaV3ExecutionHooks {
    /** After the start (`0`) and after each accepted summary: accepted summaries out of the plan's requests. */
    progress?(done: number, total: number): void;
    /**
     * Saves a window's summary, synchronously. Only `"committed"` makes the candidate the next
     * baseline; `"skipped"` ends the execution with `writeSkipped`.
     */
    checkpoint?(write: HypaV3Checkpoint): "committed" | "skipped";
    /** Rechecks the accepted prefix and current window before acceptance (token-only windows too). */
    validate?(window: HypaV3PlannedWindow): boolean;
    /** Checked before each window starts and before a queued request starts: true ends with `stopped`. */
    shouldStop?(): boolean;
    /** Experimental: one summary request at a time, each window saved before the next starts. */
    sequential?: boolean;
}

export async function hypaMemoryV3(
    host: MemoryHost,
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character | groupChat,
    tokenizer: MemoryTokenizer,
): Promise<HypaV3Result> {
    // A missing preset is thrown without the algorithm's prefix.
    getCurrentHypaV3Preset(host);

    try {
        const outcome = await prepareHypaV3(host, chats, currentTokens, maxContextTokens, room, tokenizer);
        if (!outcome.ok) {
            return outcome.result;
        }
        const prepared = outcome.prepared;
        const plan = await planHypaV3Summaries(prepared);

        // The experimental implementation reports a planning error before summarizing anything.
        if (plan.error !== undefined && prepared.implementation === "experimental") {
            return {
                currentTokens: plan.predictedTokens,
                chats,
                error: plan.error,
                memory: toSerializableHypaV3Data(prepared.data),
            };
        }

        const execution = await executeHypaV3Plan(host, prepared, plan);

        if (execution.endReason === "providerFailed") {
            return {
                // Experimental subtracted every planned window before its batch ran.
                currentTokens:
                    prepared.implementation === "experimental" ? plan.predictedTokens : execution.currentTokens,
                chats,
                error: execution.error,
                memory: toSerializableHypaV3Data(execution.data),
            };
        }

        // The standard implementation reports it after summarizing the windows before it.
        if (plan.error !== undefined) {
            return {
                currentTokens: plan.predictedTokens,
                chats,
                error: plan.error,
                memory: toSerializableHypaV3Data(execution.data),
            };
        }

        return await selectHypaV3(host, prepared, execution);
    } catch (error) {
        // The job's own end (an abort, a latched failure) is not the algorithm's error.
        host.fence();
        if (error instanceof Error) {
            // Standard Error instance
            error.message = `${logPrefix} ${error.message}`;
            throw error;
        }

        // Fallback for non-Error object
        let errorMessage: string;

        try {
            errorMessage = JSON.stringify(error);
        } catch {
            errorMessage = String(error);
        }

        throw new Error(`${logPrefix} ${errorMessage}`);
    }
}

/**
 * The common start of both mains: the settings check, the stored data with the orphan cleanup, the
 * summarized-prefix cursor, and the token ledger with each main's reservation.
 */
export async function prepareHypaV3(
    host: MemoryHost,
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    tokenizer: MemoryTokenizer,
    options?: HypaV3PrepareOptions,
): Promise<HypaV3PrepareOutcome> {
    const db = host.db;
    const settings = getCurrentHypaV3Preset(host).settings;
    const implementation: HypaV3Implementation = settings.useExperimentalImpl ? "experimental" : "standard";
    const incoming = currentTokens;

    // Validate settings
    if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
        return {
            ok: false,
            result: {
                currentTokens,
                chats,
                error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
            },
        };
    }

    // Initial token correction
    currentTokens -= db.maxResponse;

    const snapshot = structuredClone(room.hypaV3Data);

    // Load existing hypa data if available
    const data: HypaV3Data = room.hypaV3Data
        ? toHypaV3Data(room.hypaV3Data)
        : {
              summaries: [],
          };

    // Clean orphaned summaries
    if (!settings.preserveOrphanedMemory && options?.cleanup !== false) {
        cleanOrphanedSummary(chats, data);
    }

    // Determine starting index
    let startIdx = 0;
    let prefixTokens = 0;
    let coverageAhead = false;

    if (data.summaries.length > 0) {
        const lastSummary = data.summaries.at(-1)!;
        const lastMemo = [...lastSummary.chatMemos].at(-1);
        const lastHistoryIndex =
            lastSummary.chatMemos.size > 0
                ? chats.findIndex((chat) => isHistoryEntry(chat) && chat.memo === lastMemo)
                : -1;
        coverageAhead = lastHistoryIndex === -1;
        const lastChatIndex =
            options === undefined ? chats.findIndex((chat) => chat.memo === lastMemo) : lastHistoryIndex;

        if (lastChatIndex !== -1) {
            startIdx = lastChatIndex + 1;

            // Exclude tokens from summarized chats
            const summarizedChats = chats.slice(0, lastChatIndex + 1);
            for (const chat of summarizedChats) {
                const chatTokens = await tokenizer.tokenizeChat(chat);
                currentTokens -= chatTokens;
                prefixTokens += chatTokens;
            }
        }
    }

    // Reserve memory tokens
    const emptyMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: wrapWithXml(memoryPromptTag, ""),
    });
    const memoryTokens = Math.floor(maxContextTokens * settings.memoryTokensRatio);
    let reservation: HypaV3Ledger["reservation"];
    let availableMemoryTokens: number;

    if (implementation === "standard") {
        const shouldReserveEmptyMemoryTokens =
            data.summaries.length === 0 && currentTokens + emptyMemoryTokens <= maxContextTokens;
        availableMemoryTokens = shouldReserveEmptyMemoryTokens ? 0 : memoryTokens - emptyMemoryTokens;
        reservation = shouldReserveEmptyMemoryTokens
            ? { kind: "emptyCard", tokens: emptyMemoryTokens }
            : { kind: "fullBudget", tokens: memoryTokens };
    } else {
        const shouldReserveMemoryTokens = data.summaries.length > 0 || currentTokens > maxContextTokens;
        availableMemoryTokens = shouldReserveMemoryTokens ? memoryTokens - emptyMemoryTokens : 0;
        reservation = shouldReserveMemoryTokens
            ? { kind: "fullBudget", tokens: memoryTokens }
            : { kind: "none", tokens: 0 };
    }

    if (reservation.kind !== "none") {
        currentTokens += reservation.tokens;
    }

    return {
        ok: true,
        prepared: {
            implementation,
            settings,
            chats,
            maxContextTokens,
            tokenizer,
            snapshot,
            data,
            startIdx,
            coverageAhead,
            ledger: {
                incoming,
                responseCorrection: db.maxResponse,
                prefixTokens,
                emptyMemoryTokens,
                memoryTokens,
                reservation,
                availableMemoryTokens,
                current: currentTokens,
            },
        },
    };
}

/** Whether a scanned message goes into its window's summary. */
function shouldSummarizeChat(chat: OpenAIChat, settings: Readonly<HypaV3Settings>): boolean {
    if (chat.name === "example_user" || chat.name === "example_assistant" || chat.memo === "NewChatExample") {
        return false;
    }

    if (chat.memo === "NewChat") {
        return false;
    }

    if (chat.content.trim().length === 0) {
        return false;
    }

    if (settings.doNotSummarizeUserMessage && chat.role === "user") {
        return false;
    }

    return true;
}

/**
 * The summary windows of a prepared step, without summarizing: the window scan of each main
 * (standard scans `maxChatsPerSummary` messages, experimental until it has that many to summarize)
 * with its stop rules. Tokenizes every scanned message, as the mains do.
 */
export async function planHypaV3Summaries(
    prepared: HypaV3Prepared,
    options: HypaV3PlanOptions = {},
): Promise<HypaV3Plan> {
    const { settings, chats, maxContextTokens, tokenizer, ledger } = prepared;
    const lookahead = options.lookahead === true;
    const windows: HypaV3PlannedWindow[] = [];
    // A lookahead plan counts the full memory budget in place of the ledger's reservation.
    let currentTokens = lookahead ? ledger.current - ledger.reservation.tokens + ledger.memoryTokens : ledger.current;
    let startIdx = prepared.startIdx;

    const finish = (stopReason: HypaV3StopReason, error?: string): HypaV3Plan => ({
        windows,
        llmCalls: windows.filter((window) => window.needsLlm).length,
        stopReason,
        predictedTokens: currentTokens,
        ...(error === undefined ? {} : { error }),
    });

    // If summarization is needed
    const summarizationMode = lookahead
        ? currentTokens > maxContextTokens * (1 - HYPAV3_LOOKAHEAD_HEADROOM)
        : currentTokens > maxContextTokens;
    const targetTokens = lookahead
        ? Math.max(0, maxContextTokens * (1 - HYPAV3_LOOKAHEAD_HEADROOM - settings.extraSummarizationRatio))
        : maxContextTokens * (1 - settings.extraSummarizationRatio);

    if (!summarizationMode) {
        return finish("notNeeded");
    }

    while (true) {
        if (currentTokens <= targetTokens) {
            return finish("targetReached");
        }

        if (chats.length - startIdx <= settings.queryChatCount) {
            // Lookahead: the protected tail is a normal end, even over the context.
            if (lookahead || currentTokens <= maxContextTokens) {
                return finish("tailReached");
            }
            return finish(
                "cannotSummarizeFurther",
                `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
            );
        }

        const included: OpenAIChat[] = [];
        let toSummarizeTokens = 0;
        let scanEnd: number;

        if (prepared.implementation === "standard") {
            scanEnd = Math.min(startIdx + settings.maxChatsPerSummary, chats.length - settings.queryChatCount);

            for (let i = startIdx; i < scanEnd; i++) {
                const chat = chats[i];
                toSummarizeTokens += await tokenizer.tokenizeChat(chat);

                if (shouldSummarizeChat(chat, settings)) {
                    included.push(chat);
                }
            }
        } else {
            let currentIndex = startIdx;

            while (
                included.length < settings.maxChatsPerSummary &&
                currentIndex < chats.length - settings.queryChatCount
            ) {
                const chat = chats[currentIndex];
                toSummarizeTokens += await tokenizer.tokenizeChat(chat);

                if (shouldSummarizeChat(chat, settings)) {
                    included.push(chat);
                }

                currentIndex++;
            }

            scanEnd = currentIndex;
        }

        if (scanEnd <= startIdx) {
            return finish(
                "noProgress",
                `${logPrefix} Summarization made no progress at start index ${startIdx} with maxChatsPerSummary ${settings.maxChatsPerSummary}.`,
            );
        }

        // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
        if (currentTokens <= maxContextTokens && currentTokens - toSummarizeTokens < targetTokens) {
            return finish("nextWindowOvershoots");
        }

        windows.push({
            scanStart: startIdx,
            scanEnd,
            scannedIds: chats.slice(startIdx, scanEnd).map((chat) => chat.memo),
            included,
            includedMemos: included.map((chat) => chat.memo),
            removedTokens: toSummarizeTokens,
            needsLlm: included.length > 0,
        });

        currentTokens -= toSummarizeTokens;
        startIdx = scanEnd;
    }
}

/** The execution state before any window: the prepared count, cursor, and a copy of its data. */
export function emptyHypaV3Execution(prepared: HypaV3Prepared): HypaV3ExecutionResult {
    return {
        endReason: "complete",
        completed: [],
        accepted: 0,
        tokenDelta: 0,
        currentTokens: prepared.ledger.current,
        cursor: prepared.startIdx,
        data: { ...prepared.data, summaries: [...prepared.data.summaries] },
        baseline: prepared.snapshot,
    };
}

function newSummary(window: HypaV3PlannedWindow, text: string): Summary {
    return {
        text,
        chatMemos: new Set(window.included.map((chat) => chat.memo as string)),
        isImportant: false,
        categoryId: undefined,
        tags: [],
    };
}

function acceptWindow(state: HypaV3ExecutionState, executed: HypaV3ExecutedWindow): void {
    state.accepted++;
    state.currentTokens -= executed.window.removedTokens;
    state.tokenDelta += executed.window.removedTokens;
    state.cursor = executed.window.scanEnd;
    if (executed.summary) {
        state.data.summaries.push(executed.summary);
    }
}

/**
 * Summarizes a plan's windows: standard one window after another, ending at the first failure;
 * experimental every window as one rate-limited batch, keeping the consecutive successes from the
 * first window. With `hooks`, each window is validated and its summary saved before it is accepted
 * (`executeWithHooks`).
 */
export async function executeHypaV3Plan(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    plan: HypaV3Plan,
    hooks?: HypaV3ExecutionHooks,
): Promise<HypaV3ExecutionResult> {
    if (hooks) {
        return executeWithHooks(host, prepared, plan, hooks);
    }
    if (prepared.implementation === "experimental") {
        return executeExperimental(host, prepared, plan);
    }

    const state = emptyHypaV3Execution(prepared);

    for (const [index, window] of plan.windows.entries()) {
        let summary: Summary | undefined;

        // Attempt summarization
        if (window.needsLlm) {
            try {
                const summarizeResult = await summarize(host, window.included);

                summary = newSummary(window, summarizeResult);
            } catch (error) {
                host.fence();
                return {
                    ...state,
                    endReason: "providerFailed",
                    failedWindow: index,
                    error: `${logPrefix} Summarization failed: ${error}`,
                };
            }
        }

        const executed = { window, summary };
        state.completed.push(executed);
        acceptWindow(state, executed);
    }

    return state;
}

async function executeExperimental(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    plan: HypaV3Plan,
): Promise<HypaV3ExecutionResult> {
    const settings = prepared.settings;
    const state = emptyHypaV3Execution(prepared);
    // The batch's task `i` summarizes `plan.windows[batchWindows[i]]`.
    const batchWindows = plan.windows.flatMap((window, index) => (window.needsLlm ? [index] : []));
    let batchResult: BatchResult<string> | undefined;

    // Process all collected summarization tasks
    if (batchWindows.length > 0) {
        // Initialize rate limiter
        // Local model must be processed sequentially
        const rateLimiter = new TaskRateLimiter({
            tasksPerMinute: settings.summarizationModel === "subModel" ? settings.summarizationRequestsPerMinute : 1000,
            maxConcurrentTasks: settings.summarizationModel === "subModel" ? settings.summarizationMaxConcurrent : 1,
        });

        rateLimiter.taskQueueChangeCallback = (queuedCount) => {
            host.progress({
                open: true,
                miniMsg: `${rateLimiter.queuedTaskCount}`,
                msg: `${logPrefix} Summarizing...`,
                subMsg: `${rateLimiter.queuedTaskCount} queued`,
            });
        };

        const summarizationTasks = batchWindows.map((index) => () => summarize(host, plan.windows[index].included));

        // An abort of the job ends the summaries still waiting (one may wait a minute for the rate window).
        const onAbort = () => rateLimiter.cancelPendingTasks("request aborted");
        host.signal.addEventListener("abort", onAbort, { once: true });
        try {
            batchResult = await rateLimiter.executeBatch<string>(summarizationTasks);
        } finally {
            host.signal.removeEventListener("abort", onAbort);
        }
        host.fence();

        host.progress({
            open: false,
            miniMsg: "",
            msg: "",
            subMsg: "",
        });
    }

    // The legacy batch deliberately defers acceptance until every request has settled.
    let batchIndex = 0;
    let failure: { failedWindow: number; error: string } | undefined;

    for (const [index, window] of plan.windows.entries()) {
        let summary: Summary | undefined;

        if (window.needsLlm) {
            const result = batchResult!.results[batchIndex++];

            // Push consecutive successes
            if (!result.success || !result.data) {
                if (!failure) {
                    const errorMessage = !result.success ? result.error : "Empty summary returned";
                    failure = { failedWindow: index, error: `${logPrefix} Summarization failed: ${errorMessage}` };
                }
                continue;
            }

            summary = newSummary(window, result.data);
        }

        const executed = { window, summary };
        state.completed.push(executed);
        if (!failure) {
            acceptWindow(state, executed);
        }
    }

    return failure ? { ...state, endReason: "providerFailed", ...failure } : state;
}

/** Where an execution with hooks ended before its plan did. */
type HypaV3EarlyEnd =
    | { endReason: "stopped" }
    | { endReason: "writeSkipped" | "sourceInvalid"; window: number }
    | { endReason: "providerFailed"; failedWindow: number; error: string };

/** A queued experimental request that did not start: the execution had stopped or ended. */
class RequestNotStarted extends Error {}

/** A queued control hook's exception, kept separate from provider failures. */
class RequestHookError extends Error {
    constructor(cause: unknown) {
        super("The pre-request hook failed", { cause });
    }
}

/**
 * A checkpoint's candidate: the prepared data with `summaries`, serialized and independent of the
 * prepared state. The metrics read with the snapshot index its summaries: they are moved to the same
 * summaries in the candidate, so a write of the candidate as it is never selects another summary.
 */
function checkpointCandidate(prepared: HypaV3Prepared, summaries: readonly Summary[]): SerializableHypaV3Data {
    const candidate = structuredClone(toSerializableHypaV3Data({ ...prepared.data, summaries: [...summaries] }));
    if (candidate.metrics) {
        candidate.metrics = remapHypaV3MetricsByIdentity(
            candidate.metrics,
            prepared.snapshot?.summaries ?? [],
            candidate.summaries,
        );
    }
    return candidate;
}

/**
 * `mergeHypaV3Write(baseline, candidate, stored, false)`, with a stored `null` (a chat without memory
 * data) compared as the job's write compares it: equal to a `null` baseline, else a skip.
 */
function mergeCheckpoint(
    baseline: SerializableHypaV3Data | null | undefined,
    candidate: SerializableHypaV3Data,
    stored: SerializableHypaV3Data | null | undefined,
): SerializableHypaV3Data | null {
    if (baseline === null || stored === null) {
        return baseline === stored ? candidate : null;
    }
    return mergeHypaV3Write(baseline, candidate, stored, false);
}

/**
 * Revalidates the accepted prefix and executed window and saves its summary: a failed validation ends with
 * `sourceInvalid`, a refused checkpoint with `writeSkipped`; otherwise the window is accepted (a
 * window without a summary needs no checkpoint) and the committed candidate is the next baseline.
 */
function settleWindow(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    state: HypaV3ExecutionState,
    hooks: HypaV3ExecutionHooks,
    progress: { saved: number; total: number },
    index: number,
    executed: HypaV3ExecutedWindow,
): HypaV3EarlyEnd | undefined {
    if (hooks.validate) {
        for (let i = 0; i <= state.completed.length; i++) {
            const valid = hooks.validate((state.completed[i] ?? executed).window);
            host.fence();
            if (!valid) {
                const retained = state.completed.slice(0, i);
                // Rewind whole windows, even an accepted token-only window or a committed window
                // whose trailing excluded entries changed. Storage remains the caller's; retain
                // its last committed baseline, but expose only the still-valid prefix as execution.
                Object.assign(state, emptyHypaV3Execution(prepared), { baseline: state.baseline });
                for (const prior of retained) {
                    state.completed.push(prior);
                    acceptWindow(state, prior);
                }
                return { endReason: "sourceInvalid", window: i };
            }
        }
    }
    if (executed.summary && hooks.checkpoint) {
        const candidate = checkpointCandidate(prepared, [...state.data.summaries, executed.summary]);
        const baseline = state.baseline;
        const outcome = hooks.checkpoint({
            candidate,
            baseline,
            merge: (stored) => mergeCheckpoint(baseline, candidate, stored),
        });
        if (outcome !== "committed") {
            return { endReason: "writeSkipped", window: index };
        }
        state.baseline = structuredClone(candidate);
    }
    state.completed.push(executed);
    acceptWindow(state, executed);
    if (executed.summary) {
        progress.saved++;
        hooks.progress?.(progress.saved, progress.total);
    }
    return undefined;
}

/**
 * The execution the job and the background task run: windows in plan order, each validated, saved,
 * and accepted before the next is accepted, ending at the first failure, refusal, invalid window,
 * or stop. Standard summarizes one window after another. Experimental keeps its rate limiter, its
 * queue notices, and its abort listener: its requests start together (one at a time with
 * `sequential`), their answers are taken in plan order, and when the accepted prefix ends the
 * queued requests are cancelled and the active ones finish unsaved. An abort is thrown through
 * `host.fence()` after every await.
 */
async function executeWithHooks(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    plan: HypaV3Plan,
    hooks: HypaV3ExecutionHooks,
): Promise<HypaV3ExecutionResult> {
    const state = emptyHypaV3Execution(prepared);
    const progress = { saved: 0, total: plan.llmCalls };
    host.fence();
    if (progress.total > 0) {
        hooks.progress?.(0, progress.total);
    }
    host.fence();
    const shouldStop = () => {
        host.fence();
        const stopped = hooks.shouldStop?.();
        host.fence();
        return stopped;
    };

    if (prepared.implementation === "standard" || plan.llmCalls === 0) {
        if (prepared.implementation === "experimental" && shouldStop()) {
            return { ...state, endReason: "stopped" };
        }
        for (const [index, window] of plan.windows.entries()) {
            if (shouldStop()) {
                return { ...state, endReason: "stopped" };
            }
            let summary: Summary | undefined;
            if (window.needsLlm) {
                let text: string;
                try {
                    text = await summarize(host, window.included);
                } catch (error) {
                    host.fence();
                    return {
                        ...state,
                        endReason: "providerFailed",
                        failedWindow: index,
                        error: `${logPrefix} Summarization failed: ${error}`,
                    };
                }
                host.fence();
                summary = newSummary(window, text);
            }
            const end = settleWindow(host, prepared, state, hooks, progress, index, { window, summary });
            host.fence();
            if (end) {
                return { ...state, ...end };
            }
        }
        host.fence();
        return state;
    }

    if (shouldStop()) {
        return { ...state, endReason: "stopped" };
    }
    const settings = prepared.settings;
    const rateLimiter = new TaskRateLimiter({
        tasksPerMinute: settings.summarizationModel === "subModel" ? settings.summarizationRequestsPerMinute : 1000,
        maxConcurrentTasks: settings.summarizationModel === "subModel" ? settings.summarizationMaxConcurrent : 1,
    });
    rateLimiter.taskQueueChangeCallback = () => {
        host.progress({
            open: true,
            miniMsg: `${rateLimiter.queuedTaskCount}`,
            msg: `${logPrefix} Summarizing...`,
            subMsg: `${rateLimiter.queuedTaskCount} queued`,
        });
    };
    let ended = false;
    const request = (window: HypaV3PlannedWindow) => async () => {
        // A queued request starts only while the execution goes on.
        host.fence();
        let stopped: boolean | undefined;
        try {
            stopped = ended || shouldStop();
        } catch (error) {
            throw new RequestHookError(error);
        }
        if (stopped) {
            throw new RequestNotStarted("The summarization stopped before this request started");
        }
        return summarize(host, window.included);
    };
    // The requests of the windows that need one, by window index (all at once unless sequential).
    const requests = new Map<number, Promise<TaskResult<string>>>();
    const onAbort = () => rateLimiter.cancelPendingTasks("request aborted");
    host.signal.addEventListener("abort", onAbort, { once: true });
    try {
        if (!hooks.sequential) {
            for (const [index, window] of plan.windows.entries()) {
                if (window.needsLlm) {
                    requests.set(index, rateLimiter.executeTask(request(window)));
                }
            }
        }
        for (const [index, window] of plan.windows.entries()) {
            if (shouldStop()) {
                return { ...state, endReason: "stopped" };
            }
            let summary: Summary | undefined;
            if (window.needsLlm) {
                const result = await (requests.get(index) ?? rateLimiter.executeTask(request(window)));
                host.fence();
                if (!result.success || !result.data) {
                    if (result.error instanceof RequestHookError) {
                        throw result.error.cause;
                    }
                    if (result.error instanceof RequestNotStarted) {
                        return { ...state, endReason: "stopped" };
                    }
                    const errorMessage = !result.success ? result.error : "Empty summary returned";
                    return {
                        ...state,
                        endReason: "providerFailed",
                        failedWindow: index,
                        error: `${logPrefix} Summarization failed: ${errorMessage}`,
                    };
                }
                summary = newSummary(window, result.data);
            }
            const end = settleWindow(host, prepared, state, hooks, progress, index, { window, summary });
            host.fence();
            if (end) {
                return { ...state, ...end };
            }
        }
        return state;
    } finally {
        // Whatever ended the execution (a hook's throw included): the queued requests never start,
        // and the active ones are awaited without being saved.
        ended = true;
        rateLimiter.cancelPendingTasks("summarization ended");
        await Promise.allSettled(requests.values());
        host.signal.removeEventListener("abort", onAbort);
        if (progress.total > 0) {
            host.progress({
                open: false,
                miniMsg: "",
                msg: "",
                subMsg: "",
            });
        }
        host.fence();
    }
}

export interface HypaV3SelectOptions {
    /**
     * Fit the prompt by dropping the history no summary covers instead of failing: the reservation
     * is settled against the actual card, then raw history from the execution's cursor is dropped
     * oldest first while the count is over the context, keeping the last `queryChatCount` history
     * entries. When those and the rest of the prompt still do not fit, the selection returns
     * `tooMuchToken` with the required count as its error.
     */
    trimUncovered?: { tooMuchToken: string };
    /** Standard: the similarity correction's query to use instead of a summary request. */
    correction?: string;
}

/** What the trimming of a selection with `trimUncovered` dropped and kept. */
export interface HypaV3Trim {
    /**
     * The dropped history (the greeting and messages; examples and the new-chat marker are dropped
     * without counting): their `tokenizeChat` total, count, and memos (the greeting's is `undefined`).
     */
    readonly gap: {
        readonly tokens: number;
        readonly messages: number;
        readonly memos: readonly (string | undefined)[];
    };
    /** The kept tail: the last `count` entries of the returned chats, with their memos. */
    readonly protected: { readonly count: number; readonly memos: readonly (string | undefined)[] };
}

/** A selection's result; `trim` and `correction` only when the selection got options. */
export interface HypaV3Selection extends HypaV3Result {
    trim?: HypaV3Trim;
    /** The similarity correction's query the selection used (standard), for a later selection to reuse. */
    correction?: string;
}

/**
 * Selects from an execution's summaries (important, recent, similar, random, as each main does),
 * releases the reservation for the actual card, and returns the prompt history from the
 * execution's cursor with the card. Records the selection in the returned memory's `metrics`
 * without changing the execution. Without `options`, the mains' selection exactly (an over-context
 * count throws; a no-summary return is not checked).
 */
export async function selectHypaV3(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    execution: HypaV3ExecutionResult,
    options?: HypaV3SelectOptions,
): Promise<HypaV3Selection> {
    if (prepared.implementation === "experimental") {
        return selectExperimental(host, prepared, execution, options);
    }
    return selectStandard(host, prepared, execution, options);
}

/** Whether a prompt entry is chat history: not an example message nor a new-chat marker. */
function isHistoryEntry(chat: OpenAIChat): boolean {
    return !(
        chat.name === "example_user" ||
        chat.name === "example_assistant" ||
        chat.memo === "NewChatExample" ||
        chat.memo === "NewChat"
    );
}

/**
 * The trimming of a selection with `trimUncovered`, from `currentTokens` (the count with the actual
 * card, the reservation released): raw history from `cursor` dropped oldest first while over the
 * context, never the last `queryChatCount` history entries. `fits` is false when the count is still
 * over the context with only those left.
 */
async function trimUncoveredHistory(
    prepared: HypaV3Prepared,
    cursor: number,
    currentTokens: number,
): Promise<{ fits: boolean; currentTokens: number; history: OpenAIChat[]; trim: HypaV3Trim }> {
    const { settings, chats, maxContextTokens, tokenizer } = prepared;
    const raw = chats.slice(cursor);
    let protectedStart = raw.length;
    for (let i = raw.length - 1, kept = 0; i >= 0 && kept < settings.queryChatCount; i--) {
        if (isHistoryEntry(raw[i])) {
            kept++;
            protectedStart = i;
        }
    }

    let dropped = 0;
    let gapTokens = 0;
    const gapMemos: (string | undefined)[] = [];
    while (currentTokens > maxContextTokens && dropped < protectedStart) {
        const entry = raw[dropped];
        const entryTokens = await tokenizer.tokenizeChat(entry);
        currentTokens -= entryTokens;
        if (isHistoryEntry(entry)) {
            gapTokens += entryTokens;
            gapMemos.push(entry.memo);
        }
        dropped++;
    }

    return {
        fits: currentTokens <= maxContextTokens,
        currentTokens,
        history: raw.slice(dropped),
        trim: {
            gap: { tokens: gapTokens, messages: gapMemos.length, memos: gapMemos },
            protected: {
                count: raw.length - protectedStart,
                memos: raw.slice(protectedStart).map((chat) => chat.memo),
            },
        },
    };
}

/** The error of a selection with `trimUncovered` whose protected entries do not fit. */
function trimmedTooManyTokens(
    prepared: HypaV3Prepared,
    trimUncovered: { tooMuchToken: string },
    currentTokens: number,
    data: HypaV3Data,
): HypaV3Selection {
    return {
        currentTokens,
        chats: prepared.chats,
        error: `${trimUncovered.tooMuchToken}\n\nRequired Tokens: ${currentTokens}`,
        memory: toSerializableHypaV3Data(data),
    };
}

async function selectStandard(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    execution: HypaV3ExecutionResult,
    options: HypaV3SelectOptions | undefined,
): Promise<HypaV3Selection> {
    const db = host.db;
    const { settings, chats, maxContextTokens, tokenizer } = prepared;
    // The metrics go on a copy, so an execution can be selected from again.
    const data: HypaV3Data = { ...execution.data };
    const startIdx = execution.cursor;
    let currentTokens = execution.currentTokens;
    let availableMemoryTokens = prepared.ledger.availableMemoryTokens;

    // Early return if no summaries
    if (data.summaries.length === 0) {
        // Generate final memory prompt
        const memory = wrapWithXml(memoryPromptTag, "");

        if (options?.trimUncovered) {
            // The empty card in place of the reservation.
            const trimmed = await trimUncoveredHistory(
                prepared,
                startIdx,
                currentTokens - prepared.ledger.reservation.tokens + prepared.ledger.emptyMemoryTokens,
            );
            if (!trimmed.fits) {
                return trimmedTooManyTokens(prepared, options.trimUncovered, trimmed.currentTokens, data);
            }
            return {
                currentTokens: trimmed.currentTokens,
                chats: [{ role: "system", content: memory, memo: "supaMemory" }, ...trimmed.history],
                memory: toSerializableHypaV3Data(data),
                trim: trimmed.trim,
            };
        }

        const newChats: OpenAIChat[] = [
            {
                role: "system",
                content: memory,
                memo: "supaMemory",
            },
            ...chats.slice(startIdx),
        ];

        return {
            currentTokens,
            chats: newChats,
            memory: toSerializableHypaV3Data(data),
        };
    }

    const selectedSummaries: Summary[] = [];
    const randomMemoryRatio = 1 - settings.recentMemoryRatio - settings.similarMemoryRatio;
    const selectedImportantSummaries: Summary[] = [];
    let correction: string | undefined;

    // Select important summaries
    {
        for (const summary of data.summaries) {
            if (summary.isImportant) {
                const summaryTokens = await tokenizer.tokenizeChat({
                    role: "system",
                    content: summary.text + summarySeparator,
                });

                if (summaryTokens > availableMemoryTokens) {
                    break;
                }

                selectedImportantSummaries.push(summary);

                availableMemoryTokens -= summaryTokens;
            }
        }

        selectedSummaries.push(...selectedImportantSummaries);
    }

    // Select recent summaries
    const reservedRecentMemoryTokens = Math.floor(availableMemoryTokens * settings.recentMemoryRatio);
    let consumedRecentMemoryTokens = 0;
    const selectedRecentSummaries: Summary[] = [];

    if (settings.recentMemoryRatio > 0) {
        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter((e) => !selectedSummaries.includes(e));

        // Add one by one from the end
        for (let i = unusedSummaries.length - 1; i >= 0; i--) {
            const summary = unusedSummaries[i];
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (summaryTokens + consumedRecentMemoryTokens > reservedRecentMemoryTokens) {
                break;
            }

            selectedRecentSummaries.push(summary);
            consumedRecentMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRecentSummaries);
    }

    // Select similar summaries
    let reservedSimilarMemoryTokens = Math.floor(availableMemoryTokens * settings.similarMemoryRatio);
    let consumedSimilarMemoryTokens = 0;
    const selectedSimilarSummaries: Summary[] = [];

    if (settings.similarMemoryRatio > 0) {
        // Utilize unused token space from recent selection
        if (randomMemoryRatio <= 0) {
            const unusedRecentTokens = reservedRecentMemoryTokens - consumedRecentMemoryTokens;

            reservedSimilarMemoryTokens += unusedRecentTokens;
        }

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter((e) => !selectedSummaries.includes(e));

        // Dynamically generate summary chunks
        const summaryChunks: SummaryChunk[] = [];
        const chunkingStartedAt = performance.now();
        try {
            for (const summary of unusedSummaries) {
                const splitted = (
                    await splitBySeparator(host, summary.text, settings.summaryChunkSeparator, chunkingStartedAt)
                ).filter((e) => e.trim().length > 0);

                summaryChunks.push(
                    ...splitted.map((e) => ({
                        text: e.trim(),
                        summary,
                    })),
                );
            }
        } catch (error) {
            host.fence();
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Summary chunk separator failed: ${error}`,
                memory: toSerializableHypaV3Data(data),
            };
        }

        // Initialize embedding processor
        const processor = new HypaProcesserEx(host.embeddings, db.hypaModel);

        // Add summaryChunks to processor for similarity search
        try {
            await processor.addSummaryChunks(summaryChunks);
        } catch (error) {
            host.fence();
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Similarity search failed: ${error}`,
                memory: toSerializableHypaV3Data(data),
            };
        }

        const recentChats = chats.slice(-settings.queryChatCount).filter((chat) => chat.content.trim().length > 0);

        if (recentChats.length > 0) {
            // Raw recent chat search
            const queries = recentChats.map((chat) => chat.content);

            if (settings.enableSimilarityCorrection && recentChats.length > 1 && options?.correction !== undefined) {
                // A correction query made for an earlier selection of the same history
                queries.push(options.correction);
                correction = options.correction;
            } else if (settings.enableSimilarityCorrection && recentChats.length > 1) {
                // Raw + Summarized recent chat search
                // Summarizing is meaningful when there are more than 2 recent chats

                // Attempt summarization

                try {
                    const summarizeResult = await summarize(host, recentChats);

                    queries.push(summarizeResult);
                    correction = summarizeResult;
                } catch (error) {
                    host.fence();
                    return {
                        currentTokens,
                        chats,
                        error: `${logPrefix} Summarization failed: ${error}`,
                        memory: toSerializableHypaV3Data(data),
                    };
                }
            }

            try {
                const scoredLists: [SummaryChunk, number][][] = [];

                for (let i = 0; i < queries.length; i++) {
                    const query = queries[i];
                    const scoredChunks = await processor.similaritySearchScoredEx(query);

                    scoredLists.push(scoredChunks);
                }

                const rankedChunks = simpleCC<SummaryChunk>(scoredLists, (listIndex, totalLists) => {
                    return (listIndex + 1) / ((totalLists * (totalLists + 1)) / 2);
                });

                const rankedSummaries = childToParentRRF<SummaryChunk, Summary>(rankedChunks, (chunk) => chunk.summary);

                while (rankedSummaries.length > 0) {
                    const summary = rankedSummaries.shift()!;
                    const summaryTokens = await tokenizer.tokenizeChat({
                        role: "system",
                        content: summary.text + summarySeparator,
                    });

                    if (summaryTokens + consumedSimilarMemoryTokens > reservedSimilarMemoryTokens) {
                        break;
                    }

                    selectedSimilarSummaries.push(summary);
                    consumedSimilarMemoryTokens += summaryTokens;
                }

                selectedSummaries.push(...selectedSimilarSummaries);
            } catch (error) {
                host.fence();
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Similarity search failed: ${error}`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
        }
    }

    // Select random summaries
    let reservedRandomMemoryTokens = Math.floor(availableMemoryTokens * randomMemoryRatio);
    let consumedRandomMemoryTokens = 0;
    const selectedRandomSummaries: Summary[] = [];

    if (randomMemoryRatio > 0) {
        // Utilize unused token space from recent and similar selection
        const unusedRecentTokens = reservedRecentMemoryTokens - consumedRecentMemoryTokens;
        const unusedSimilarTokens = reservedSimilarMemoryTokens - consumedSimilarMemoryTokens;

        reservedRandomMemoryTokens += unusedRecentTokens + unusedSimilarTokens;

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries
            .filter((e) => !selectedSummaries.includes(e))
            .sort(() => host.random() - 0.5); // Random shuffle

        for (const summary of unusedSummaries) {
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (summaryTokens + consumedRandomMemoryTokens > reservedRandomMemoryTokens) {
                // Trying to select more random memory
                continue;
            }

            selectedRandomSummaries.push(summary);
            consumedRandomMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRandomSummaries);
    }

    // Sort selected summaries chronologically (by index)
    selectedSummaries.sort((a, b) => data.summaries.indexOf(a) - data.summaries.indexOf(b));

    // Generate final memory prompt
    const memory = wrapWithXml(memoryPromptTag, selectedSummaries.map((e) => e.text).join(summarySeparator));
    const realMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: memory,
    });

    // Release reserved memory tokens
    currentTokens -= prepared.ledger.reservation.tokens;

    currentTokens += realMemoryTokens;

    let history = chats.slice(startIdx);
    let trim: HypaV3Trim | undefined;
    if (options?.trimUncovered) {
        const trimmed = await trimUncoveredHistory(prepared, startIdx, currentTokens);
        if (!trimmed.fits) {
            return trimmedTooManyTokens(prepared, options.trimUncovered, trimmed.currentTokens, data);
        }
        ({ currentTokens, history, trim } = trimmed);
    } else if (currentTokens > maxContextTokens) {
        throw new Error(
            `Unexpected error: input token count (${currentTokens}) exceeds max context size (${maxContextTokens})`,
        );
    }

    // Save last selected summaries
    data.metrics = {
        lastImportantSummaries: selectedImportantSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
        lastRecentSummaries: selectedRecentSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
        lastSimilarSummaries: selectedSimilarSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
        lastRandomSummaries: selectedRandomSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
    };

    const newChats: OpenAIChat[] = [
        {
            role: "system",
            content: memory,
            memo: "supaMemory",
        },
        ...history,
    ];

    return {
        currentTokens,
        chats: newChats,
        memory: toSerializableHypaV3Data(data),
        ...(trim ? { trim } : {}),
        ...(options && correction !== undefined ? { correction } : {}),
    };
}

async function selectExperimental(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    execution: HypaV3ExecutionResult,
    options: HypaV3SelectOptions | undefined,
): Promise<HypaV3Selection> {
    const { settings, chats, maxContextTokens, tokenizer } = prepared;
    // The metrics go on a copy, so an execution can be selected from again.
    const data: HypaV3Data = { ...execution.data };
    const startIdx = execution.cursor;
    let currentTokens = execution.currentTokens;
    let availableMemoryTokens = prepared.ledger.availableMemoryTokens;

    // Early return if no summaries
    if (data.summaries.length === 0) {
        if (options?.trimUncovered) {
            // No card: the reservation is released.
            const trimmed = await trimUncoveredHistory(
                prepared,
                startIdx,
                currentTokens - prepared.ledger.reservation.tokens,
            );
            if (!trimmed.fits) {
                return trimmedTooManyTokens(prepared, options.trimUncovered, trimmed.currentTokens, data);
            }
            return {
                currentTokens: trimmed.currentTokens,
                chats: trimmed.history,
                memory: toSerializableHypaV3Data(data),
                trim: trimmed.trim,
            };
        }

        const newChats: OpenAIChat[] = chats.slice(startIdx);

        return {
            currentTokens,
            chats: newChats,
            memory: toSerializableHypaV3Data(data),
        };
    }

    const selectedSummaries: Summary[] = [];
    const randomMemoryRatio = 1 - settings.recentMemoryRatio - settings.similarMemoryRatio;
    const selectedImportantSummaries: Summary[] = [];

    // Select important summaries
    {
        for (const summary of data.summaries) {
            if (summary.isImportant) {
                const summaryTokens = await tokenizer.tokenizeChat({
                    role: "system",
                    content: summary.text + summarySeparator,
                });

                if (summaryTokens > availableMemoryTokens) {
                    break;
                }

                selectedImportantSummaries.push(summary);

                availableMemoryTokens -= summaryTokens;
            }
        }

        selectedSummaries.push(...selectedImportantSummaries);
    }

    // Select recent summaries
    const reservedRecentMemoryTokens = Math.floor(availableMemoryTokens * settings.recentMemoryRatio);
    let consumedRecentMemoryTokens = 0;
    const selectedRecentSummaries: Summary[] = [];

    if (settings.recentMemoryRatio > 0) {
        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter((e) => !selectedSummaries.includes(e));

        // Add one by one from the end
        for (let i = unusedSummaries.length - 1; i >= 0; i--) {
            const summary = unusedSummaries[i];
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (summaryTokens + consumedRecentMemoryTokens > reservedRecentMemoryTokens) {
                break;
            }

            selectedRecentSummaries.push(summary);
            consumedRecentMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRecentSummaries);
    }

    // Select similar summaries
    let reservedSimilarMemoryTokens = Math.floor(availableMemoryTokens * settings.similarMemoryRatio);
    let consumedSimilarMemoryTokens = 0;
    const selectedSimilarSummaries: Summary[] = [];

    if (settings.similarMemoryRatio > 0) {
        // Utilize unused token space from recent selection
        if (randomMemoryRatio <= 0) {
            const unusedRecentTokens = reservedRecentMemoryTokens - consumedRecentMemoryTokens;

            reservedSimilarMemoryTokens += unusedRecentTokens;
        }

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries.filter((e) => !selectedSummaries.includes(e));

        // Dynamically generate embedding texts
        const ebdTexts: EmbeddingText<Summary>[] = [];
        const chunkingStartedAt = performance.now();
        try {
            for (const [summaryIndex, summary] of unusedSummaries.entries()) {
                const splitted = (
                    await splitBySeparator(host, summary.text, settings.summaryChunkSeparator, chunkingStartedAt)
                ).filter((e) => e.trim().length > 0);

                ebdTexts.push(
                    ...splitted.map((chunk, chunkIndex) => ({
                        id: `${summaryIndex}-${chunkIndex}`,
                        content: chunk.trim(),
                        metadata: summary,
                    })),
                );
            }
        } catch (error) {
            host.fence();
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Summary chunk separator failed: ${error}`,
                memory: toSerializableHypaV3Data(data),
            };
        }

        // Initialize embedding processor
        const processor = new HypaProcessorV2<Summary>(host.embeddings, {
            rateLimiter: new TaskRateLimiter({
                tasksPerMinute: settings.embeddingRequestsPerMinute,
                maxConcurrentTasks: settings.embeddingMaxConcurrent,
            }),
        });

        processor.progressCallback = (queuedCount) => {
            host.progress({
                open: true,
                miniMsg: `${queuedCount}`,
                msg: `${logPrefix} Similarity searching...`,
                subMsg: `${queuedCount} queued`,
            });
        };

        try {
            // Add EmbeddingTexts to processor for similarity search
            await processor.addTexts(ebdTexts);
        } catch (error) {
            host.fence();
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Similarity search failed: ${error}`,
                memory: toSerializableHypaV3Data(data),
            };
        } finally {
            host.progress({
                open: false,
                miniMsg: "",
                msg: "",
                subMsg: "",
            });
        }

        const recentChats = chats.slice(-settings.queryChatCount).filter((chat) => chat.content.trim().length > 0);

        const queries = recentChats
            .map((chat, index) => {
                const subQueries = chat.content.split("\n\n").filter((e) => e.trim().length > 0);
                const weight = (index + 1) / ((recentChats.length * (recentChats.length + 1)) / 2) / subQueries.length;

                return subQueries.map((content) => ({
                    content,
                    weight,
                }));
            })
            .flat();

        if (queries.length > 0) {
            try {
                const batchScoredResults = await processor.similaritySearchScoredBatch(
                    queries.map((query) => query.content),
                );

                host.fence();

                const rankedChunks = simpleCC<EmbeddingResult<Summary>>(
                    batchScoredResults,
                    (listIndex) => queries[listIndex].weight,
                );

                const rankedSummaries = childToParentRRF<EmbeddingResult<Summary>, Summary>(
                    rankedChunks,
                    (chunk) => chunk.metadata as Summary,
                );

                while (rankedSummaries.length > 0) {
                    const summary = rankedSummaries.shift()!;
                    const summaryTokens = await tokenizer.tokenizeChat({
                        role: "system",
                        content: summary.text + summarySeparator,
                    });

                    if (summaryTokens + consumedSimilarMemoryTokens > reservedSimilarMemoryTokens) {
                        break;
                    }

                    selectedSimilarSummaries.push(summary);
                    consumedSimilarMemoryTokens += summaryTokens;
                }

                selectedSummaries.push(...selectedSimilarSummaries);
            } catch (error) {
                host.fence();
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Similarity search failed: ${error}`,
                    memory: toSerializableHypaV3Data(data),
                };
            } finally {
                host.progress({
                    open: false,
                    miniMsg: "",
                    msg: "",
                    subMsg: "",
                });
            }
        }
    }

    // Select random summaries
    let reservedRandomMemoryTokens = Math.floor(availableMemoryTokens * randomMemoryRatio);
    let consumedRandomMemoryTokens = 0;
    const selectedRandomSummaries: Summary[] = [];

    if (randomMemoryRatio > 0) {
        // Utilize unused token space from recent and similar selection
        const unusedRecentTokens = reservedRecentMemoryTokens - consumedRecentMemoryTokens;
        const unusedSimilarTokens = reservedSimilarMemoryTokens - consumedSimilarMemoryTokens;

        reservedRandomMemoryTokens += unusedRecentTokens + unusedSimilarTokens;

        // Target only summaries that haven't been selected yet
        const unusedSummaries = data.summaries
            .filter((e) => !selectedSummaries.includes(e))
            .sort(() => host.random() - 0.5); // Random shuffle

        for (const summary of unusedSummaries) {
            const summaryTokens = await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            });

            if (summaryTokens + consumedRandomMemoryTokens > reservedRandomMemoryTokens) {
                // Trying to select more random memory
                continue;
            }

            selectedRandomSummaries.push(summary);
            consumedRandomMemoryTokens += summaryTokens;
        }

        selectedSummaries.push(...selectedRandomSummaries);
    }

    // Sort selected summaries chronologically (by index)
    selectedSummaries.sort((a, b) => data.summaries.indexOf(a) - data.summaries.indexOf(b));

    // Generate final memory prompt
    const memory = wrapWithXml(memoryPromptTag, selectedSummaries.map((e) => e.text).join(summarySeparator));
    const realMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: memory,
    });

    // Release reserved memory tokens
    if (prepared.ledger.reservation.kind !== "none") {
        currentTokens -= prepared.ledger.reservation.tokens;
    }

    currentTokens += realMemoryTokens;

    let history = chats.slice(startIdx);
    let trim: HypaV3Trim | undefined;
    if (options?.trimUncovered) {
        const trimmed = await trimUncoveredHistory(prepared, startIdx, currentTokens);
        if (!trimmed.fits) {
            return trimmedTooManyTokens(prepared, options.trimUncovered, trimmed.currentTokens, data);
        }
        ({ currentTokens, history, trim } = trimmed);
    } else if (currentTokens > maxContextTokens) {
        throw new Error(
            `Unexpected error: input token count (${currentTokens}) exceeds max context size (${maxContextTokens})`,
        );
    }

    // Save last selected summaries
    data.metrics = {
        lastImportantSummaries: selectedImportantSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
        lastRecentSummaries: selectedRecentSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
        lastSimilarSummaries: selectedSimilarSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
        lastRandomSummaries: selectedRandomSummaries.map((selected) =>
            data.summaries.findIndex((sum) => sum === selected),
        ),
    };

    const newChats: OpenAIChat[] = [
        {
            role: "system",
            content: memory,
            memo: "supaMemory",
        },
        ...history,
    ];

    return {
        currentTokens,
        chats: newChats,
        memory: toSerializableHypaV3Data(data),
        ...(trim ? { trim } : {}),
    };
}

/**
 * Embeds the document vectors a selection with the same settings would embed for `summaries`, so
 * that selection finds them cached: the separator split, trim, and empty-chunk filter of the
 * selection, through the active implementation's processor (standard `HypaProcesserEx`, grouped
 * per summary for a contextual model; experimental `HypaProcessorV2`, whose ordinary requests use
 * its embedding rate limiter and whose contextual requests call the provider directly). Nothing
 * when the preset selects no similar summaries. Errors are thrown.
 */
export async function warmHypaV3Vectors(host: MemoryHost, summaries: readonly Summary[]): Promise<void> {
    const settings = getCurrentHypaV3Preset(host).settings;
    if (settings.similarMemoryRatio <= 0 || summaries.length === 0) {
        return;
    }
    const chunkingStartedAt = performance.now();
    const chunksOf = async (summary: Summary) =>
        (await splitBySeparator(host, summary.text, settings.summaryChunkSeparator, chunkingStartedAt))
            .filter((e) => e.trim().length > 0)
            .map((e) => e.trim());

    if (!settings.useExperimentalImpl) {
        const summaryChunks: SummaryChunk[] = [];
        for (const summary of summaries) {
            summaryChunks.push(...(await chunksOf(summary)).map((text) => ({ text, summary })));
        }
        if (summaryChunks.length === 0) {
            return;
        }
        const processor = new HypaProcesserEx(host.embeddings, host.db.hypaModel);
        await processor.addSummaryChunks(summaryChunks);
        host.fence();
        return;
    }

    const ebdTexts: EmbeddingText<Summary>[] = [];
    for (const [summaryIndex, summary] of summaries.entries()) {
        ebdTexts.push(
            ...(await chunksOf(summary)).map((content, chunkIndex) => ({
                id: `${summaryIndex}-${chunkIndex}`,
                content,
                metadata: summary,
            })),
        );
    }
    if (ebdTexts.length === 0) {
        return;
    }
    const processor = new HypaProcessorV2<Summary>(host.embeddings, {
        rateLimiter: new TaskRateLimiter({
            tasksPerMinute: settings.embeddingRequestsPerMinute,
            maxConcurrentTasks: settings.embeddingMaxConcurrent,
        }),
    });
    await processor.addTexts(ebdTexts);
    host.fence();
}

/**
 * Where an entry of the processed history came from, captured from the chat snapshot it was built
 * from (one per entry, aligned with the history the step prepares): a stored message with its id
 * and its stored text's hash, the greeting with the chat's `fmIndex` and the greeting text's hash,
 * or another entry (the example dialogue, the new-chat marker) with its captured memo, including
 * an explicit `undefined` for a memo-less example.
 */
export type HypaV3EntrySource =
    | { readonly kind: "message"; readonly id: string | undefined; readonly textHash: string }
    | { readonly kind: "greeting"; readonly fmIndex: Chat["fmIndex"]; readonly textHash: string }
    | { readonly kind: "other"; readonly memo: string | undefined };

/** The chat as stored now, for a window's validation. */
export interface HypaV3CurrentSource {
    readonly messages: readonly Pick<Message, "chatId" | "data" | "disabled">[];
    readonly fmIndex: Chat["fmIndex"];
    /** The stored text of the greeting `fmIndex` selects; `undefined` without one (a group). */
    readonly greeting: string | undefined;
}

/** The hash of a stored text that a window's validation compares. */
export function hypaV3SourceHash(text: string): string {
    return createHash("sha256").update(Buffer.from(text, "utf16le")).digest("base64url");
}

/**
 * A `validate` hook: whether a window's source is unchanged in the chat `readCurrent` reads (null:
 * the chat is gone). The chat's history is the prompt's (the greeting unless a message resets the
 * history, then the enabled messages after the last `allBefore`). The window's history entries,
 * after the history entry before the window (when there is one; else from the history's start),
 * must follow one another there with nothing between them, so a message inserted or re-enabled in
 * or right before the window fails; every scanned message needs an id and its captured text hash
 * (summarized or not: an edit can change whether it is), and a greeting the captured `fmIndex` and
 * text hash. Duplicate message ids fail.
 */
export function createHypaV3SourceValidator(
    sources: readonly HypaV3EntrySource[],
    readCurrent: () => HypaV3CurrentSource | null,
): (window: HypaV3PlannedWindow) => boolean {
    return (window) => {
        if (
            !Number.isInteger(window.scanStart) ||
            !Number.isInteger(window.scanEnd) ||
            window.scanStart < 0 ||
            window.scanEnd < window.scanStart ||
            window.scanEnd > sources.length ||
            window.scannedIds.length !== window.scanEnd - window.scanStart
        ) {
            return false;
        }
        const current = readCurrent();
        if (!current) {
            return false;
        }

        // `makeMs` of `assemblePrompt`: the enabled messages after the last reset.
        const active: Pick<Message, "chatId" | "data" | "disabled">[] = [];
        let reset = false;
        for (let i = current.messages.length - 1; i >= 0; i--) {
            const message = current.messages[i];
            if (message.disabled === true) {
                continue;
            }
            if (message.disabled === "allBefore") {
                reset = true;
                break;
            }
            active.push(message);
        }
        active.reverse();
        const greetingPosition = !reset && current.greeting !== undefined ? 0 : -1;
        const firstMessagePosition = greetingPosition + 1;
        const positionOf = new Map<string, number>();
        for (const [index, message] of active.entries()) {
            if (message.chatId === undefined) {
                continue;
            }
            if (positionOf.has(message.chatId)) {
                return false;
            }
            positionOf.set(message.chatId, firstMessagePosition + index);
        }
        const locate = (source: HypaV3EntrySource): number =>
            source.kind === "greeting"
                ? greetingPosition
                : source.kind === "message" && source.id !== undefined
                  ? (positionOf.get(source.id) ?? -1)
                  : -1;

        let expected = 0;
        for (let i = window.scanStart - 1; i >= 0; i--) {
            const anchor = sources[i];
            if (anchor.kind !== "other") {
                const position = locate(anchor);
                if (position === -1) {
                    return false;
                }
                expected = position + 1;
                break;
            }
        }

        for (let i = window.scanStart; i < window.scanEnd; i++) {
            const source = sources[i];
            const scannedId = window.scannedIds[i - window.scanStart];
            if (source.kind === "other") {
                if (!("memo" in source) || source.memo !== scannedId) {
                    return false;
                }
                continue;
            }
            if (
                source.kind === "greeting"
                    ? scannedId !== undefined
                    : source.id === undefined || source.id !== scannedId
            ) {
                return false;
            }
            const position = locate(source);
            if (position !== expected) {
                return false;
            }
            expected++;
            if (source.kind === "greeting") {
                if (current.fmIndex !== source.fmIndex || hypaV3SourceHash(current.greeting!) !== source.textHash) {
                    return false;
                }
            } else if (hypaV3SourceHash(active[position - firstMessagePosition].data) !== source.textHash) {
                return false;
            }
        }
        return true;
    };
}

function toHypaV3Data(serialData: SerializableHypaV3Data): HypaV3Data {
    // Remove legacy property
    const { lastSelectedSummaries, ...restData } = serialData;

    return {
        ...restData,
        summaries: serialData.summaries.map((summary) => ({
            ...summary,
            // Convert null back to undefined (JSON serialization converts undefined to null)
            chatMemos: new Set(summary.chatMemos.map((memo) => (memo === null ? undefined : memo))) as Set<string>,
        })),
    };
}

function toSerializableHypaV3Data(data: HypaV3Data): SerializableHypaV3Data {
    return {
        ...data,
        summaries: data.summaries.map((summary) => ({
            ...summary,
            chatMemos: [...summary.chatMemos],
        })),
    };
}

function cleanOrphanedSummary(chats: OpenAIChat[], data: HypaV3Data): void {
    // Collect all memos from current chats
    const currentChatMemos = new Set(chats.map((chat) => chat.memo)) as Set<string>;

    // Filter summaries - keep only those whose chatMemos are subset of current chat memos
    data.summaries = data.summaries.filter((summary) => {
        return isSubset(summary.chatMemos, currentChatMemos);
    });
}

function isSubset(subset: Set<string>, superset: Set<string>): boolean {
    for (const elem of subset) {
        if (!superset.has(elem)) {
            return false;
        }
    }

    return true;
}

function wrapWithXml(tag: string, content: string): string {
    return `<${tag}>\n${content}\n</${tag}>`;
}

function sanitizeSummaryContent(content: string): string {
    return content.replace(inlayTokenRegex, "[Image]");
}

export async function summarize(
    host: MemoryHost,
    oaiMessages: readonly OpenAIChat[],
    isResummarize: boolean = false,
): Promise<string> {
    const settings = getCurrentHypaV3Preset(host).settings;

    const strMessages = oaiMessages.map((chat) => `${chat.role}: ${sanitizeSummaryContent(chat.content)}`).join("\n");

    const summarizationPrompt = isResummarize
        ? settings.reSummarizationPrompt.trim() === ""
            ? "Re-summarize this summaries."
            : settings.reSummarizationPrompt
        : settings.summarizationPrompt.trim() === ""
          ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]"
          : settings.summarizationPrompt;

    const formated: OpenAIChat[] = host.parseChatML(summarizationPrompt.replaceAll("{{slot}}", strMessages)) ?? [
        {
            role: "user",
            content: strMessages,
        },
        {
            role: "system",
            content: summarizationPrompt,
        },
    ];

    // API
    if (settings.summarizationModel === "subModel") {
        const response = await host.request(formated);

        if (response.type === "streaming" || response.type === "multiline") {
            throw new Error("Unexpected response type");
        }

        if (response.type === "fail") {
            throw new Error(response.result);
        }

        if (!response.result || response.result.trim().length === 0) {
            throw new Error("Empty summary returned");
        }

        // Remove thoughts content for API
        const thoughtsRegex = /<Thoughts>[\s\S]*?<\/Thoughts>/g;
        const result = response.result.replace(thoughtsRegex, "").trim();

        if (result.length === 0) {
            throw new Error("Empty summary after removing thoughts content");
        }

        return result;
    }

    // Local: the WebLLM engine runs in a browser only.
    throw new Error(LOCAL_SUMMARIZATION_UNSUPPORTED);
}

export function getCurrentHypaV3Preset(host: MemoryHost): HypaV3Preset {
    const preset = selectedHypaV3Preset(host.db);

    if (!preset) {
        throw new Error("Preset not found. Please select a valid preset.");
    }

    return preset;
}

function simpleCC<T>(
    scoredLists: [T, number][][],
    weightFunc?: (listIndex: number, totalLists: number) => number,
): T[] {
    const scores = new Map<T, number>();

    for (let listIndex = 0; listIndex < scoredLists.length; listIndex++) {
        const list = scoredLists[listIndex];
        const weight = weightFunc ? weightFunc(listIndex, scoredLists.length) : 1 / scoredLists.length;

        for (const [item, score] of list) {
            scores.set(item, (scores.get(item) || 0) + score * weight);
        }
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([item]) => item);
}

function childToParentRRF<C, P>(rankedChildren: C[], parentFunc: (child: C) => P, k: number = 60): P[] {
    const scores = new Map<P, number>();

    for (let childIndex = 0; childIndex < rankedChildren.length; childIndex++) {
        const child = rankedChildren[childIndex];
        const parent = parentFunc(child);
        const rank = childIndex + 1;
        const rrfTerm = 1 / (k + rank);

        scores.set(parent, (scores.get(parent) || 0) + rrfTerm);
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([parent]) => parent);
}

interface SummaryChunkVector {
    chunk: SummaryChunk;
    vector: memoryVector;
}

class HypaProcesserEx extends HypaProcesser {
    // Maintain references to SummaryChunks and their associated memoryVectors
    summaryChunkVectors: SummaryChunkVector[] = [];

    async addSummaryChunks(chunks: SummaryChunk[]): Promise<void> {
        if (isContextModel(this.model)) {
            await this.addSummaryChunksContextual(chunks);
            return;
        }

        const texts = chunks.map((chunk) => chunk.text);
        await this.addText(texts);

        const newSummaryChunkVectors: SummaryChunkVector[] = [];
        for (const chunk of chunks) {
            const vector = this.vectors.find((v) => v.content === chunk.text);
            if (!vector) {
                throw new Error(`Failed to create vector for summary chunk:\n${chunk.text}`);
            }
            newSummaryChunkVectors.push({ chunk, vector });
        }

        this.summaryChunkVectors.push(...newSummaryChunkVectors);
    }

    private async addSummaryChunksContextual(chunks: SummaryChunk[]): Promise<void> {
        const provider = getContextProvider(this.env, this.model)!;

        const cacheKeyFor = (text: string, groupTexts: string[], index: number) => {
            return contextualChunkCacheKey(`${text}${provider.getCacheKeySuffix(groupTexts)}`, index);
        };

        const summaryGroups = new Map<Summary, SummaryChunk[]>();
        for (const chunk of chunks) {
            const group = summaryGroups.get(chunk.summary) || [];
            group.push(chunk);
            summaryGroups.set(chunk.summary, group);
        }

        const groupsToEmbed: SummaryChunk[][] = [];
        const cachedVectors = new Map<SummaryChunk, memoryVector>();
        const chunkKeys = new Map<SummaryChunk, string>();

        for (const [, group] of summaryGroups) {
            const groupTexts = group.map((c) => c.text);
            let allCached = true;
            const groupCache = new Map<SummaryChunk, memoryVector>();

            for (let index = 0; index < group.length; index++) {
                const chunk = group[index];
                const cacheKey = cacheKeyFor(chunk.text, groupTexts, index);
                chunkKeys.set(chunk, cacheKey);
                const cached = this.cached(cacheKey, chunk.text);
                if (cached) {
                    groupCache.set(chunk, cached);
                } else {
                    allCached = false;
                }
            }

            if (allCached) {
                for (const [chunk, vector] of groupCache) {
                    cachedVectors.set(chunk, vector);
                }
            } else {
                groupsToEmbed.push(group);
            }
        }

        if (groupsToEmbed.length > 0) {
            const groups = groupsToEmbed.map((group) => group.map((chunk) => chunk.text));

            const results = await provider.embedDocumentGroups(groups);

            // Validate the entire call before saving any of its vectors.
            if (results.length !== groups.length) {
                throw new ContextualEmbeddingCountError(groups.length, results.length);
            }
            for (let i = 0; i < groups.length; i++) {
                const received = results[i]?.length ?? 0;
                if (received !== groups[i].length) {
                    throw new ContextualEmbeddingCountError(groups[i].length, received);
                }
            }

            for (let i = 0; i < groupsToEmbed.length; i++) {
                const group = groupsToEmbed[i];
                const embeddings = results[i];

                for (let j = 0; j < group.length; j++) {
                    const chunk = group[j];
                    const embedding = embeddings[j];
                    const vector: memoryVector = {
                        content: chunk.text,
                        embedding,
                    };

                    const cacheKey = chunkKeys.get(chunk)!;
                    this.store(cacheKey, vector);
                    cachedVectors.set(chunk, vector);
                }
            }
        }

        for (const chunk of chunks) {
            const vector = cachedVectors.get(chunk);
            if (!vector) {
                throw new Error(`Failed to create vector for summary chunk:\n${chunk.text}`);
            }

            this.vectors.push(vector);
            this.summaryChunkVectors.push({ chunk, vector });
        }
    }

    async similaritySearchScoredEx(query: string): Promise<[SummaryChunk, number][]> {
        const queryVector = (await this.getEmbeds(query))[0];

        return this.summaryChunkVectors
            .map((scv) => ({
                chunk: scv.chunk,
                similarity: similarity(queryVector, scv.vector.embedding),
            }))
            .sort((a, b) => b.similarity - a.similarity)
            .map((result) => [result.chunk, result.similarity]);
    }
}
