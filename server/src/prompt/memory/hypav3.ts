import type { Chat, character, groupChat } from "../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import type {
    HypaV3Data,
    HypaV3Preset,
    HypaV3Settings,
    SerializableHypaV3Data,
    Summary,
} from "../../../../shared/memory.ts";
import type { OpenAIChat } from "../../../../shared/openai.ts";
import { type BatchResult, TaskRateLimiter } from "../../../../shared/taskRateLimiter.ts";
import { DEFAULT_REGEX_DEADLINE_MS } from "../../scripts/workerPool.ts";
import {
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
    readonly ledger: HypaV3Ledger;
}

/** A prepared step, or the settings error the step returns before reading anything. */
export type HypaV3PrepareOutcome = { ok: true; prepared: HypaV3Prepared } | { ok: false; result: HypaV3Result };

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
 * `queryChatCount` tail left and the prompt fits; the next window would go under the target while
 * the prompt fits; or one of the two errors (the tail left and the prompt over the context; a window
 * that scans nothing).
 */
export type HypaV3StopReason =
    "notNeeded" | "targetReached" | "tailReached" | "nextWindowOvershoots" | "cannotSummarizeFurther" | "noProgress";

/** The windows a step expects to summarize. A prediction: never the cursor after a failure. */
export interface HypaV3Plan {
    readonly windows: readonly HypaV3PlannedWindow[];
    /** The windows that need a summary request. */
    readonly llmCalls: number;
    readonly stopReason: HypaV3StopReason;
    /** The ledger's count after every planned window, subtracted one window at a time. */
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
    /** The windows that ended successfully, in plan order (experimental may list some past a failure). */
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
}

/** What a plan's execution made. Selection reads its cursor, count, and data from here. */
export type HypaV3ExecutionResult = HypaV3ExecutionState &
    (
        | { endReason: "complete" }
        | {
              endReason: "providerFailed";
              /** The first failed window's index in `plan.windows`. */
              failedWindow: number;
              error: string;
          }
    );

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
    if (!settings.preserveOrphanedMemory) {
        cleanOrphanedSummary(chats, data);
    }

    // Determine starting index
    let startIdx = 0;
    let prefixTokens = 0;

    if (data.summaries.length > 0) {
        const lastSummary = data.summaries.at(-1)!;
        const lastChatIndex = chats.findIndex((chat) => chat.memo === [...lastSummary.chatMemos].at(-1));

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
export async function planHypaV3Summaries(prepared: HypaV3Prepared): Promise<HypaV3Plan> {
    const { settings, chats, maxContextTokens, tokenizer } = prepared;
    const windows: HypaV3PlannedWindow[] = [];
    let currentTokens = prepared.ledger.current;
    let startIdx = prepared.startIdx;

    const finish = (stopReason: HypaV3StopReason, error?: string): HypaV3Plan => ({
        windows,
        llmCalls: windows.filter((window) => window.needsLlm).length,
        stopReason,
        predictedTokens: currentTokens,
        ...(error === undefined ? {} : { error }),
    });

    // If summarization is needed
    const summarizationMode = currentTokens > maxContextTokens;
    const targetTokens = maxContextTokens * (1 - settings.extraSummarizationRatio);

    if (!summarizationMode) {
        return finish("notNeeded");
    }

    while (true) {
        if (currentTokens <= targetTokens) {
            return finish("targetReached");
        }

        if (chats.length - startIdx <= settings.queryChatCount) {
            if (currentTokens <= maxContextTokens) {
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
 * first window.
 */
export async function executeHypaV3Plan(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    plan: HypaV3Plan,
): Promise<HypaV3ExecutionResult> {
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

    // Note:
    // We can't save some successful summaries to the DB temporarily
    // because don't know the actual summarization model name.
    // It is possible that the user can change the summarization model.
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

/**
 * Selects from an execution's summaries (important, recent, similar, random, as each main does),
 * releases the reservation for the actual card, and returns the prompt history from the
 * execution's cursor with the card. Records the selection in the returned memory's `metrics`
 * without changing the execution.
 */
export async function selectHypaV3(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    execution: HypaV3ExecutionResult,
): Promise<HypaV3Result> {
    if (prepared.implementation === "experimental") {
        return selectExperimental(host, prepared, execution);
    }
    return selectStandard(host, prepared, execution);
}

async function selectStandard(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    execution: HypaV3ExecutionResult,
): Promise<HypaV3Result> {
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

            if (settings.enableSimilarityCorrection && recentChats.length > 1) {
                // Raw + Summarized recent chat search
                // Summarizing is meaningful when there are more than 2 recent chats

                // Attempt summarization

                try {
                    const summarizeResult = await summarize(host, recentChats);

                    queries.push(summarizeResult);
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

    if (currentTokens > maxContextTokens) {
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
        ...chats.slice(startIdx),
    ];

    return {
        currentTokens,
        chats: newChats,
        memory: toSerializableHypaV3Data(data),
    };
}

async function selectExperimental(
    host: MemoryHost,
    prepared: HypaV3Prepared,
    execution: HypaV3ExecutionResult,
): Promise<HypaV3Result> {
    const { settings, chats, maxContextTokens, tokenizer } = prepared;
    // The metrics go on a copy, so an execution can be selected from again.
    const data: HypaV3Data = { ...execution.data };
    const startIdx = execution.cursor;
    let currentTokens = execution.currentTokens;
    let availableMemoryTokens = prepared.ledger.availableMemoryTokens;

    // Early return if no summaries
    if (data.summaries.length === 0) {
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

    if (currentTokens > maxContextTokens) {
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
        ...chats.slice(startIdx),
    ];

    return {
        currentTokens,
        chats: newChats,
        memory: toSerializableHypaV3Data(data),
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

        const cacheKeyFor = (text: string, groupTexts: string[]) => {
            return `${text}${provider.getCacheKeySuffix(groupTexts)}`;
        };

        const summaryGroups = new Map<Summary, SummaryChunk[]>();
        for (const chunk of chunks) {
            const group = summaryGroups.get(chunk.summary) || [];
            group.push(chunk);
            summaryGroups.set(chunk.summary, group);
        }

        const groupsToEmbed: SummaryChunk[][] = [];
        const cachedVectors = new Map<string, memoryVector>();
        const chunkKeys = new Map<SummaryChunk, string>();

        for (const [, group] of summaryGroups) {
            const groupTexts = group.map((c) => c.text);
            let allCached = true;
            const groupCache = new Map<string, memoryVector>();

            for (const chunk of group) {
                const cacheKey = cacheKeyFor(chunk.text, groupTexts);
                chunkKeys.set(chunk, cacheKey);
                const cached = this.cached(cacheKey, chunk.text);
                if (cached) {
                    groupCache.set(cacheKey, cached);
                } else {
                    allCached = false;
                }
            }

            if (allCached) {
                for (const [cacheKey, vector] of groupCache) {
                    cachedVectors.set(cacheKey, vector);
                }
            } else {
                groupsToEmbed.push(group);
            }
        }

        if (groupsToEmbed.length > 0) {
            const groups = groupsToEmbed.map((group) => group.map((chunk) => chunk.text));

            const results = await provider.embedDocumentGroups(groups);

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
                    cachedVectors.set(cacheKey, vector);
                }
            }
        }

        for (const chunk of chunks) {
            const vector = cachedVectors.get(chunkKeys.get(chunk)!);
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
