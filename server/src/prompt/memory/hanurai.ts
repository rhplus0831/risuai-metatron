import type { OpenAIChat } from "../../../../shared/openai.ts";
import { HypaProcesser } from "../embeddings.ts";
import type { MemoryHost, MemoryTokenizer } from "./host.ts";

const maxRecentChatQuery = 4;
const searchDocumentPrefix = "search_document: ";
const prefixLength = searchDocumentPrefix.length;

/**
 * `hanuraiMemory` of the former `src/ts/process/memory/hanuraiMemory.ts`, statement for statement, on a
 * `MemoryHost`. Where the client alerts and returns `false` (no chat left to drop), this returns the
 * alert's text as `alert`: the caller ends the send with it, without the inlay error message.
 * Two deliberate departures from the former client: the `search_document: ` prefix is cut by its own
 * length, and a retrieved document that is still among the kept chats' texts is skipped.
 */
export async function hanuraiMemory(
    host: MemoryHost,
    chats: OpenAIChat[],
    arg: {
        currentTokens: number;
        maxContextTokens: number;
        tokenizer: MemoryTokenizer;
        /** `language.errors.toomuchtoken`. */
        tooMuchToken: string;
    },
): Promise<{ tokens: number; chats: OpenAIChat[] } | { alert: string }> {
    const db = host.db;
    const tokenizer = arg.tokenizer;
    const processer = new HypaProcesser(host.embeddings);
    let addTexts: string[] = [];
    const queryStartIndex = chats.length - maxRecentChatQuery;
    chats.map((chat, index) => {
        if (queryStartIndex < index) {
            return;
        }
        if (!chat?.content?.trim()) {
            return;
        }
        if (db.hanuraiSplit) {
            const splited = chat.content.split("\n\n");
            for (const split of splited) {
                if (!split.trim()) {
                    continue;
                }
                addTexts.push(searchDocumentPrefix + split.trim());
            }
        } else {
            addTexts.push(searchDocumentPrefix + chat.content?.trim());
        }
    });
    await processer.addText(addTexts);
    host.fence();

    let scoredResults: { [key: string]: number } = {};
    for (let i = 1; i < maxRecentChatQuery; i++) {
        const chat = chats[chats.length - i];
        if (!chat?.content) {
            continue;
        }
        const scoredArray = (await processer.similaritySearchScored("search_query: " + chat.content)).map((result) => {
            return [result[0], result[1] / i] as [string, number];
        });
        host.fence();
        for (const scored of scoredArray) {
            if (scoredResults[scored[0]]) {
                scoredResults[scored[0]] += scored[1];
            } else {
                scoredResults[scored[0]] = scored[1];
            }
        }
    }
    const vectorResult = Object.entries(scoredResults).sort((a, b) => b[1] - a[1]);

    let tokens = arg.currentTokens + db.hanuraiTokens;

    while (tokens > arg.maxContextTokens) {
        const poped = chats.shift();
        if (!poped) {
            return { alert: arg.tooMuchToken + "\n\nRequired Tokens: " + tokens };
        }
        tokens -= await tokenizer.tokenizeChat(poped);
    }

    const keptDocumentTexts = new Set<string>();
    for (const chat of chats) {
        if (!chat?.content?.trim()) {
            continue;
        }
        const texts = db.hanuraiSplit ? chat.content.split("\n\n") : [chat.content];
        for (const text of texts) {
            if (text.trim()) {
                keptDocumentTexts.add(text.trim());
            }
        }
    }

    tokens -= db.hanuraiTokens;

    let resultTexts: string[] = [];
    for (const vector of vectorResult) {
        if (keptDocumentTexts.has(vector[0].substring(prefixLength))) {
            continue;
        }
        const tokenized =
            (await tokenizer.tokenizeChat({
                role: "system",
                memo: "supaMemory",
                content: vector[0].substring(prefixLength),
            })) + 2;
        tokens += tokenized;
        if (tokens >= arg.maxContextTokens) {
            tokens -= tokenized;
            break;
        }
        resultTexts.push(vector[0].substring(prefixLength));
    }
    chats.unshift({
        role: "system",
        memo: "supaMemory",
        content: resultTexts.join("\n\n"),
    });
    return {
        tokens,
        chats,
    };
}
