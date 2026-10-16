import type { Chat, character, groupChat } from "../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import type { HypaV3Data, HypaV3Preset, SerializableHypaV3Data, Summary } from "../../../../shared/memory.ts";
import type { OpenAIChat } from "../../../../shared/openai.ts";
import { TaskRateLimiter } from "../../../../shared/taskRateLimiter.ts";
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
    const remaining = SEPARATOR_BUDGET_MS - (performance.now() - chunkingStartedAt);
    if (remaining <= 0) {
        throw new Error(`Summary chunk separator timed out: ${SEPARATOR_BUDGET_MS} ms chunking budget exhausted`);
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
        { deadlineMs: Math.min(DEFAULT_REGEX_DEADLINE_MS, remaining) },
    );
    host.fence();
    if ("error" in result) {
        throw new Error(result.error);
    }
    return result.value as string[];
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
    const settings = getCurrentHypaV3Preset(host).settings;

    try {
        if (settings.useExperimentalImpl) {
            return await hypaMemoryV3MainExp(host, chats, currentTokens, maxContextTokens, room, char, tokenizer);
        }

        return await hypaMemoryV3Main(host, chats, currentTokens, maxContextTokens, room, char, tokenizer);
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

async function hypaMemoryV3MainExp(
    host: MemoryHost,
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character | groupChat,
    tokenizer: MemoryTokenizer,
): Promise<HypaV3Result> {
    const db = host.db;
    const settings = getCurrentHypaV3Preset(host).settings;

    // Validate settings
    if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
        return {
            currentTokens,
            chats,
            error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
        };
    }

    // Initial token correction
    currentTokens -= db.maxResponse;

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

    if (data.summaries.length > 0) {
        const lastSummary = data.summaries.at(-1)!;
        const lastChatIndex = chats.findIndex((chat) => chat.memo === [...lastSummary.chatMemos].at(-1));

        if (lastChatIndex !== -1) {
            startIdx = lastChatIndex + 1;

            // Exclude tokens from summarized chats
            const summarizedChats = chats.slice(0, lastChatIndex + 1);
            for (const chat of summarizedChats) {
                currentTokens -= await tokenizer.tokenizeChat(chat);
            }
        }
    }

    // Reserve memory tokens
    const emptyMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: wrapWithXml(memoryPromptTag, ""),
    });
    const memoryTokens = Math.floor(maxContextTokens * settings.memoryTokensRatio);
    const shouldReserveMemoryTokens = data.summaries.length > 0 || currentTokens > maxContextTokens;
    let availableMemoryTokens = shouldReserveMemoryTokens ? memoryTokens - emptyMemoryTokens : 0;

    if (shouldReserveMemoryTokens) {
        currentTokens += memoryTokens;
    }

    // If summarization is needed
    const summarizationMode = currentTokens > maxContextTokens;
    const targetTokens = maxContextTokens * (1 - settings.extraSummarizationRatio);
    const toSummarizeArray: OpenAIChat[][] = [];

    while (summarizationMode) {
        if (currentTokens <= targetTokens) {
            break;
        }

        if (chats.length - startIdx <= settings.queryChatCount) {
            if (currentTokens <= maxContextTokens) {
                break;
            } else {
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
        }

        const toSummarize: OpenAIChat[] = [];
        let toSummarizeTokens = 0;
        let currentIndex = startIdx;

        while (
            toSummarize.length < settings.maxChatsPerSummary &&
            currentIndex < chats.length - settings.queryChatCount
        ) {
            const chat = chats[currentIndex];
            const chatTokens = await tokenizer.tokenizeChat(chat);

            toSummarizeTokens += chatTokens;

            let shouldSummarize = true;

            if (chat.name === "example_user" || chat.name === "example_assistant" || chat.memo === "NewChatExample") {
                shouldSummarize = false;
            }

            if (chat.memo === "NewChat") {
                shouldSummarize = false;
            }

            if (chat.content.trim().length === 0) {
                shouldSummarize = false;
            }

            if (settings.doNotSummarizeUserMessage && chat.role === "user") {
                shouldSummarize = false;
            }

            if (shouldSummarize) {
                toSummarize.push(chat);
            }

            currentIndex++;
        }

        if (currentIndex <= startIdx) {
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Summarization made no progress at start index ${startIdx} with maxChatsPerSummary ${settings.maxChatsPerSummary}.`,
                memory: toSerializableHypaV3Data(data),
            };
        }

        // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
        if (currentTokens <= maxContextTokens && currentTokens - toSummarizeTokens < targetTokens) {
            break;
        }

        // Collect summarization batch
        if (toSummarize.length > 0) {
            toSummarizeArray.push([...toSummarize]);
        }

        currentTokens -= toSummarizeTokens;
        startIdx = currentIndex;
    }

    // Process all collected summarization tasks
    if (toSummarizeArray.length > 0) {
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

        const summarizationTasks = toSummarizeArray.map((item) => () => summarize(host, item));

        // An abort of the job ends the summaries still waiting (one may wait a minute for the rate window).
        const onAbort = () => rateLimiter.cancelPendingTasks("request aborted");
        host.signal.addEventListener("abort", onAbort, { once: true });
        let batchResult: Awaited<ReturnType<typeof rateLimiter.executeBatch<string>>>;
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

        // Note:
        // We can't save some successful summaries to the DB temporarily
        // because don't know the actual summarization model name.
        // It is possible that the user can change the summarization model.
        for (let i = 0; i < batchResult.results.length; i++) {
            const result = batchResult.results[i];

            // Push consecutive successes
            if (!result.success || !result.data) {
                const errorMessage = !result.success ? result.error : "Empty summary returned";

                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Summarization failed: ${errorMessage}`,
                    memory: toSerializableHypaV3Data(data),
                };
            }

            const summaryText = result.data;

            data.summaries.push({
                text: summaryText,
                chatMemos: new Set(toSummarizeArray[i].map((chat) => chat.memo as string)),
                isImportant: false,
                categoryId: undefined,
                tags: [],
            });
        }
    }

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
    if (shouldReserveMemoryTokens) {
        currentTokens -= memoryTokens;
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

async function hypaMemoryV3Main(
    host: MemoryHost,
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character | groupChat,
    tokenizer: MemoryTokenizer,
): Promise<HypaV3Result> {
    const db = host.db;
    const settings = getCurrentHypaV3Preset(host).settings;

    // Validate settings
    if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) {
        return {
            currentTokens,
            chats,
            error: `${logPrefix} The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.`,
        };
    }

    // Initial token correction
    currentTokens -= db.maxResponse;

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

    if (data.summaries.length > 0) {
        const lastSummary = data.summaries.at(-1)!;
        const lastChatIndex = chats.findIndex((chat) => chat.memo === [...lastSummary.chatMemos].at(-1));

        if (lastChatIndex !== -1) {
            startIdx = lastChatIndex + 1;

            // Exclude tokens from summarized chats
            const summarizedChats = chats.slice(0, lastChatIndex + 1);
            for (const chat of summarizedChats) {
                currentTokens -= await tokenizer.tokenizeChat(chat);
            }
        }
    }

    // Reserve memory tokens
    const emptyMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: wrapWithXml(memoryPromptTag, ""),
    });
    const memoryTokens = Math.floor(maxContextTokens * settings.memoryTokensRatio);
    const shouldReserveEmptyMemoryTokens =
        data.summaries.length === 0 && currentTokens + emptyMemoryTokens <= maxContextTokens;
    let availableMemoryTokens = shouldReserveEmptyMemoryTokens ? 0 : memoryTokens - emptyMemoryTokens;

    if (shouldReserveEmptyMemoryTokens) {
        currentTokens += emptyMemoryTokens;
    } else {
        currentTokens += memoryTokens;
    }

    // If summarization is needed
    const summarizationMode = currentTokens > maxContextTokens;
    const targetTokens = maxContextTokens * (1 - settings.extraSummarizationRatio);

    while (summarizationMode) {
        if (currentTokens <= targetTokens) {
            break;
        }

        if (chats.length - startIdx <= settings.queryChatCount) {
            if (currentTokens <= maxContextTokens) {
                break;
            } else {
                return {
                    currentTokens,
                    chats,
                    error: `${logPrefix} Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
                    memory: toSerializableHypaV3Data(data),
                };
            }
        }

        const toSummarize: OpenAIChat[] = [];
        const endIdx = Math.min(startIdx + settings.maxChatsPerSummary, chats.length - settings.queryChatCount);
        let toSummarizeTokens = 0;

        for (let i = startIdx; i < endIdx; i++) {
            const chat = chats[i];
            const chatTokens = await tokenizer.tokenizeChat(chat);

            toSummarizeTokens += chatTokens;

            if (chat.name === "example_user" || chat.name === "example_assistant" || chat.memo === "NewChatExample") {
                continue;
            }

            if (chat.memo === "NewChat") {
                continue;
            }

            if (chat.content.trim().length === 0) {
                continue;
            }

            if (settings.doNotSummarizeUserMessage && chat.role === "user") {
                continue;
            }

            toSummarize.push(chat);
        }

        if (endIdx <= startIdx) {
            return {
                currentTokens,
                chats,
                error: `${logPrefix} Summarization made no progress at start index ${startIdx} with maxChatsPerSummary ${settings.maxChatsPerSummary}.`,
                memory: toSerializableHypaV3Data(data),
            };
        }

        // Stop summarization if further reduction would go below target tokens (unless we're over max tokens)
        if (currentTokens <= maxContextTokens && currentTokens - toSummarizeTokens < targetTokens) {
            break;
        }

        // Attempt summarization
        if (toSummarize.length > 0) {
            try {
                const summarizeResult = await summarize(host, toSummarize);

                data.summaries.push({
                    text: summarizeResult,
                    chatMemos: new Set(toSummarize.map((chat) => chat.memo as string)),
                    isImportant: false,
                    categoryId: undefined,
                    tags: [],
                });
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

        currentTokens -= toSummarizeTokens;
        startIdx = endIdx;
    }

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
    if (shouldReserveEmptyMemoryTokens) {
        currentTokens -= emptyMemoryTokens;
    } else {
        currentTokens -= memoryTokens;
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
    oaiMessages: OpenAIChat[],
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
