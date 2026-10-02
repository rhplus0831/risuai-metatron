import type { Chat, character, groupChat } from "../../../../shared/database.ts";
import type { HypaV2Data, SerializableHypaV2Data } from "../../../../shared/memory.ts";
import type { OpenAIChat } from "../../../../shared/openai.ts";
import { HypaProcesser } from "../embeddings.ts";
import type { MemoryHost, MemoryTokenizer } from "./host.ts";

// `hypaMemoryV2` of `src/ts/process/memory/hypav2.ts`, statement for statement, on a `MemoryHost`.
// A provider's answer in an error text is redacted.

async function summary(host: MemoryHost, stringlizedChat: string): Promise<{ success: boolean; data: string }> {
    const db = host.db;

    if (db.supaModelType === "distilbart") {
        try {
            const sum = await host.summarizer(stringlizedChat);
            return { success: true, data: sum };
        } catch (error) {
            host.fence();
            return {
                success: false,
                data: "SupaMemory: Summarizer: " + `${error}`,
            };
        }
    }

    const supaPrompt =
        db.supaMemoryPrompt === ""
            ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]\n"
            : db.supaMemoryPrompt;
    let result = "";

    if (db.supaModelType !== "subModel") {
        const promptbody = stringlizedChat + "\n\n" + supaPrompt + "\n\nOutput:";

        const da = await host.completions({
            model:
                db.supaModelType === "curie"
                    ? "text-curie-001"
                    : db.supaModelType === "instruct35"
                      ? "gpt-3.5-turbo-instruct"
                      : "text-davinci-003",
            prompt: promptbody,
            max_tokens: 600,
            temperature: 0,
        });

        try {
            if (!da.ok) {
                return {
                    success: false,
                    data: "SupaMemory: HTTP: " + host.redact(JSON.stringify(da)),
                };
            }

            result = (await da.data)?.choices[0]?.text?.trim();

            if (!result) {
                return {
                    success: false,
                    data: "SupaMemory: HTTP: " + host.redact(JSON.stringify(da)),
                };
            }

            return { success: true, data: result };
        } catch (error) {
            return {
                success: false,
                data: "SupaMemory: HTTP: " + host.redact(`${error}`),
            };
        }
    } else {
        const parsedPrompt = host.parseChatML(supaPrompt.replaceAll("{{slot}}", stringlizedChat));

        const promptbody: OpenAIChat[] = (
            parsedPrompt ?? [
                {
                    role: "user",
                    content: stringlizedChat,
                },
                {
                    role: "system",
                    content: supaPrompt,
                },
            ]
        ).map((message) => ({
            ...message,
            memo: "supaPrompt",
        }));
        const da = await host.request(promptbody);
        if (da.type === "fail" || da.type === "streaming" || da.type === "multiline") {
            return {
                success: false,
                data: "SupaMemory: HTTP: " + da.result,
            };
        }
        result = da.result;
    }
    return { success: true, data: result };
} // No, I am not going to touch any http API calls.

// Helper function start
export interface OldHypaV2Data {
    chunks: {
        text: string;
        targetId: string;
    }[];
    mainChunks: {
        text: string;
        targetId: string;
    }[];
}

function isSubset<T>(subset: Set<T>, superset: Set<T>): boolean {
    for (const item of subset) {
        if (!superset.has(item)) {
            return false;
        }
    }
    return true;
}
function isOldHypaV2Data(obj: any): obj is OldHypaV2Data {
    return (
        typeof obj === "object" &&
        obj !== null &&
        Array.isArray(obj.chunks) &&
        Array.isArray(obj.mainChunks) &&
        obj.chunks.every(
            (chunk: any) =>
                typeof chunk === "object" &&
                chunk !== null &&
                typeof chunk.text === "string" &&
                typeof chunk.targetId === "string",
        ) &&
        obj.mainChunks.every(
            (mainChunk: any) =>
                typeof mainChunk === "object" &&
                mainChunk !== null &&
                typeof mainChunk.text === "string" &&
                typeof mainChunk.targetId === "string",
        )
    );
}
// Helper function end

function convertOldToNewHypaV2Data(oldData: OldHypaV2Data, chats: OpenAIChat[]): HypaV2Data {
    const oldMainChunks = oldData.mainChunks.slice().reverse(); // Inversed order, old mainchunk is done by unshift instead of push
    const oldChunks = oldData.chunks.slice();
    const newData: HypaV2Data = {
        lastMainChunkID: 0,
        mainChunks: [],
        chunks: [],
    };

    const mainChunkTargetIds = new Set<string>();
    for (const mc of oldMainChunks) {
        if (mc.targetId) {
            mainChunkTargetIds.add(mc.targetId);
        }
    }

    // map chat memo to index, efficiency issues
    const chatMemoToIndex = new Map<string, number>();
    for (const tid of mainChunkTargetIds) {
        const idx = chats.findIndex((c) => c.memo === tid);
        if (idx !== -1) {
            chatMemoToIndex.set(tid, idx);
        } else {
            chatMemoToIndex.set(tid, -1);
        }
    }

    for (let i = 0; i < oldMainChunks.length; i++) {
        const oldMainChunk = oldMainChunks[i];
        const targetId = oldMainChunk.targetId;
        const mainChunkText = oldMainChunk.text;

        const previousMainChunk = i > 0 ? oldMainChunks[i - 1] : null;
        const previousMainChunkTarget = previousMainChunk ? previousMainChunk.targetId : null;

        let chatMemos = new Set<string>();

        if (previousMainChunkTarget && targetId) {
            const startIndex = chatMemoToIndex.get(previousMainChunkTarget) ?? -1;
            const endIndex = chatMemoToIndex.get(targetId) ?? -1;

            if (startIndex !== -1 && endIndex !== -1) {
                const lowerIndex = Math.min(startIndex, endIndex);
                const upperIndex = Math.max(startIndex, endIndex);

                for (let j = lowerIndex; j <= upperIndex; j++) {
                    chatMemos.add(chats[j].memo as string);
                }
            } else {
                // Can't identify the chats correctly, so discard this main chunk at all
                continue; // Technically, if this is the case Previous HypaV2Data is bugged. Discussion opened for changing it to break;
            }
        } else {
            // No previous chunk, so we gather all chats from index 0 up to the targetId's index
            if (targetId) {
                const targetIndex = chatMemoToIndex.get(targetId) ?? -1;
                if (targetIndex !== -1) {
                    // Include all memos from 0 up to targetIndex
                    for (let j = 0; j <= targetIndex; j++) {
                        chatMemos.add(chats[j].memo as string);
                    }
                } else {
                    continue; // Invalid MainChunk.
                }
            }
        }
        const newMainChunk = {
            id: newData.lastMainChunkID,
            text: mainChunkText,
            chatMemos: chatMemos,
            lastChatMemo: targetId,
        };
        newData.mainChunks.push(newMainChunk);
        newData.lastMainChunkID++;
        // Adding chunks accordingly, matching MainChunkID by leveraging same targetId
        const matchingOldChunks = oldChunks.filter((oldChunk) => oldChunk.targetId === targetId);
        for (const oldChunk of matchingOldChunks) {
            newData.chunks.push({
                mainChunkID: newMainChunk.id,
                text: oldChunk.text,
            });
        }
    }

    return newData; // updated HypaV2Data
}

function cleanInvalidChunks(chats: OpenAIChat[], data: HypaV2Data): void {
    const currentChatMemos = new Set(chats.map((chat) => chat.memo));

    // mainChunks filtering
    data.mainChunks = data.mainChunks.filter((mainChunk) => {
        return isSubset(mainChunk.chatMemos, currentChatMemos);
    });

    // chunk filtering based on mainChunk's id
    const validMainChunkIds = new Set(data.mainChunks.map((mainChunk) => mainChunk.id));
    data.chunks = data.chunks.filter((chunk) => validMainChunkIds.has(chunk.mainChunkID));
    // Update lastMainChunkID
    if (data.mainChunks.length > 0) {
        data.lastMainChunkID = data.mainChunks[data.mainChunks.length - 1].id;
    } else {
        data.lastMainChunkID = 0;
    }
}

function toSerializableHypaV2Data(data: HypaV2Data): SerializableHypaV2Data {
    return {
        ...data,
        mainChunks: data.mainChunks.map((mainChunk) => ({
            ...mainChunk,
            chatMemos: Array.from(mainChunk.chatMemos),
        })),
    };
}

function toHypaV2Data(data: SerializableHypaV2Data): HypaV2Data {
    // Handle corrupted data due to invalid json serialization
    data.mainChunks.forEach((mainChunk) => {
        if (!Array.isArray(mainChunk.chatMemos)) {
            mainChunk.chatMemos = [];
        }
    });

    return {
        ...data,
        mainChunks: data.mainChunks.map((mainChunk) => ({
            ...mainChunk,
            chatMemos: new Set(mainChunk.chatMemos),
        })),
    };
}

export async function hypaMemoryV2(
    host: MemoryHost,
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character | groupChat,
    tokenizer: MemoryTokenizer,
): Promise<{
    currentTokens: number;
    chats: OpenAIChat[];
    error?: string;
    memory?: SerializableHypaV2Data;
}> {
    const db = host.db;
    let data: HypaV2Data = {
        lastMainChunkID: 0,
        chunks: [],
        mainChunks: [],
    };

    // Subtract maxResponse from currentTokens to fix the token calculation issue.
    // This is not a fundamental solution but rather a temporary fix.
    // It is designed to minimize impact on other code.
    currentTokens -= db.maxResponse;

    if (room.hypaV2Data) {
        if (isOldHypaV2Data(room.hypaV2Data)) {
            data = convertOldToNewHypaV2Data(room.hypaV2Data, chats);
        } else {
            data = toHypaV2Data(room.hypaV2Data);
        }
    }

    // Clean invalid HypaV2 data
    cleanInvalidChunks(chats, data);

    let allocatedTokens = db.hypaAllocatedTokens;
    let chunkSize = db.hypaChunkSize;
    currentTokens += allocatedTokens; // WARNING: VIRTUAL VALUE. This token is NOT real. This is a placeholder appended to calculate the maximum amount of HypaV2 memory retrieved data.
    let mainPrompt = "";
    const lastTwoChats = chats.slice(-2);
    // Error handling for failed summarization
    let summarizationFailures = 0;
    const maxSummarizationFailures = 3;

    // Find the index to start summarizing from
    let idx = 0;
    if (data.mainChunks.length > 0) {
        const lastMainChunk = data.mainChunks[data.mainChunks.length - 1];
        const lastChatMemo = lastMainChunk.lastChatMemo;
        const lastChatIndex = chats.findIndex((chat) => chat.memo === lastChatMemo);
        if (lastChatIndex !== -1) {
            idx = lastChatIndex + 1;

            // Subtract tokens of summarized chats
            const summarizedChats = chats.slice(0, lastChatIndex + 1);
            for (const chat of summarizedChats) {
                currentTokens -= await tokenizer.tokenizeChat(chat);
            }
        }
    }
    // Starting chat index of new mainChunk to be generated

    // Token management loop (If current token usage exceeds allowed amount)
    while (currentTokens > maxContextTokens) {
        const halfData: OpenAIChat[] = [];
        let halfDataTokens = 0;

        const startIdx = idx;

        // Accumulate chats to summarize
        while (
            halfDataTokens < chunkSize &&
            idx < chats.length - 4 // keep the last two chats from summarizing(else, the roles will be fucked up)
        ) {
            const chat = chats[idx];
            const chatTokens = await tokenizer.tokenizeChat(chat);

            // Skip index 0 ([Start a new chat])
            if (idx === 0) {
                idx++;
                continue;
            }

            // Skip if the content of this chat is empty
            if (!chat.content.trim()) {
                idx++;
                continue;
            }

            // Check if adding this chat would exceed our chunkSize limit
            if (halfDataTokens + chatTokens > chunkSize) {
                // Can't add this chat without going over chunkSize
                // Break out, and summarize what we have so far.
                break;
            }

            // Add this chat to the halfData batch
            halfData.push(chat);
            halfDataTokens += chatTokens;
            idx++;
        }

        const endIdx = idx - 1;

        // If no chats were added, break to avoid infinite loop
        if (halfData.length === 0) {
            // Case 1: Can't summarize the last 4 chats
            if (idx >= chats.length - 4) {
                return {
                    currentTokens: currentTokens,
                    chats: chats,
                    error: `[HypaV2] Input tokens (${currentTokens}) exceeds max context size (${maxContextTokens}), but can't summarize last 4 messages. Please increase max context size to at least ${currentTokens}.`,
                };
            }

            // Case 2: Chat too large for chunk size
            const chatTokens = await tokenizer.tokenizeChat(chats[idx]);
            return {
                currentTokens: currentTokens,
                chats: chats,
                error: `[HypaV2] Message tokens (${chatTokens}) exceeds chunk size (${chunkSize}). Please increase chunk size to at least ${chatTokens}.`,
            };
        }

        const stringlizedChat = halfData.map((e) => `${e.role}: ${e.content}`).join("\n");

        // Summarize the accumulated chunk
        const summaryData = await summary(host, stringlizedChat);

        if (!summaryData.success) {
            summarizationFailures++;
            if (summarizationFailures >= maxSummarizationFailures) {
                return {
                    currentTokens: currentTokens,
                    chats: chats,
                    error: "[HypaV2] Summarization failed multiple times. Aborting to prevent infinite loop.",
                };
            }
            // If summarization fails, try again in next iteration
            continue;
        }

        summarizationFailures = 0; // Reset on success

        const summaryDataToken = await tokenizer.tokenizeChat({
            role: "system",
            content: summaryData.data,
        });

        // Update lastMainChunkID and create a new mainChunk
        data.lastMainChunkID++;
        const newMainChunkId = data.lastMainChunkID;

        const chatMemos = new Set(halfData.map((chat) => chat.memo as string));
        const lastChatMemo = halfData[halfData.length - 1].memo as string;

        data.mainChunks.push({
            id: newMainChunkId,
            text: summaryData.data,
            chatMemos: chatMemos,
            lastChatMemo: lastChatMemo,
        });

        // Split the summary into chunks
        const splitted = summaryData.data
            .split("\n\n")
            .map((e) => e.trim())
            .filter((e) => e.length > 0);

        data.chunks.push(
            ...splitted.map((e) => ({
                mainChunkID: newMainChunkId,
                text: e,
            })),
        );

        currentTokens -= halfDataTokens;
    }

    // Construct the mainPrompt from mainChunks
    mainPrompt = "";
    let mainPromptTokens = 0;
    for (const chunk of data.mainChunks) {
        const chunkTokens = await tokenizer.tokenizeChat({
            role: "system",
            content: chunk.text,
        });
        if (mainPromptTokens + chunkTokens > allocatedTokens / 2) break;
        mainPrompt += `\n\n${chunk.text}`;
        mainPromptTokens += chunkTokens;
    }

    // Fetch additional memory from chunks
    const processor = new HypaProcesser(host.embeddings, db.hypaModel);

    const searchDocumentPrefix = "search_document: ";
    const prefixLength = searchDocumentPrefix.length;

    // Add chunks to processor for similarity search
    await processor.addText(
        data.chunks.filter((v) => v.text.trim().length > 0).map((v) => searchDocumentPrefix + v.text.trim()), // sometimes this should not be used at all. Risuai does not support embedding model that this is meaningful, isn't it?
    );
    host.fence();

    let scoredResults: { [key: string]: number } = {};
    for (let i = 0; i < 3; i++) {
        // Should parameterize this, fixed length 3 is a magic number without explanation
        const pop = chats[chats.length - i - 1];
        if (!pop) break;
        const searched = await processor.similaritySearchScored(`search_query: ${pop.content}`);
        host.fence();
        for (const result of searched) {
            const score = result[1] / (i + 1);
            scoredResults[result[0]] = (scoredResults[result[0]] || 0) + score;
        }
    }

    const scoredArray = Object.entries(scoredResults).sort((a, b) => b[1] - a[1]);
    let chunkResultPrompts = "";
    let chunkResultTokens = 0;
    while (allocatedTokens - mainPromptTokens - chunkResultTokens > 0 && scoredArray.length > 0) {
        const [text] = scoredArray.shift()!;
        const content = text.substring(prefixLength);
        const tokenized = await tokenizer.tokenizeChat({
            role: "system",
            content: content,
        });
        if (tokenized > allocatedTokens - mainPromptTokens - chunkResultTokens) break;
        chunkResultPrompts += content + "\n\n";
        chunkResultTokens += tokenized;
    }

    const fullResult = `<Past Events Summary>${mainPrompt}</Past Events Summary>\n<Past Events Details>${chunkResultPrompts}</Past Events Details>`;
    const fullResultTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: fullResult,
    });
    currentTokens += fullResultTokens;

    // Filter out summarized chats and prepend the memory prompt
    const unsummarizedChats: OpenAIChat[] = [
        {
            role: "system",
            content: fullResult,
            memo: "supaMemory",
        },
        ...chats.slice(idx), // Use the idx to slice out the summarized chats
    ];

    // Remove this later, as this is already done by the index
    for (const chat of lastTwoChats) {
        if (!unsummarizedChats.find((c) => c.memo === chat.memo)) {
            unsummarizedChats.push(chat);
        }
    }

    currentTokens -= allocatedTokens; // Virtually added memory tokens got removed. Bad way, but had no choice.

    return {
        currentTokens: currentTokens,
        chats: unsummarizedChats,
        memory: toSerializableHypaV2Data(data),
    };
}
