import type { Database } from "../../../../shared/database.ts";
import type { OpenAIChat } from "../../../../shared/openai.ts";
import type { requestDataResponse } from "../../llm/request.ts";
import type { RegexOp, RegexOpResult } from "../../scripts/worker.ts";
import type { EmbeddingEnv } from "../embeddings.ts";

/**
 * What the server's memory algorithms (`supaMemory.ts`, `hypav2.ts`, `hypav3.ts`,
 * `hanurai.ts` here) read and call outside their arguments. The client equivalents are module state
 * (`getDatabase`, `requestChatData`, `runSummarizer`, the LocalForage vectors, `parseChatML`,
 * `getUserName`, `hypaV3ProgressStore`, `Math.random`); on the server one host is bound to one run
 * of one job.
 *
 * The ports keep the client's statements, order, and texts. What they leave out is the client's
 * console output (it prints the chat) and the WebLLM engine of HypaV3's local summarization models.
 */
export type MemoryHost = {
    /** The job's projection, read where the client reads `getDatabase()`. */
    db: Database;
    /** `tokenize(text)` of `src/ts/tokenizer.ts`: the main model's count of a plain text. */
    tokenize(text: string): Promise<number>;
    /**
     * `requestChatData({ formated, bias: {}, useStreaming: false, noMultiGen: true }, "memory")` of
     * the job (its `request` trigger, its fallback models, the job's chat as the request's chat).
     */
    request(formated: OpenAIChat[]): Promise<requestDataResponse>;
    /**
     * The client's `auxFetchJson("openai-completions", ...)`: OpenAI's `/v1/completions` with the
     * stored memory key, as `{ ok, data }`.
     */
    completions(body: {
        model: string;
        prompt: string;
        max_tokens: number;
        temperature: number;
    }): Promise<{ ok: boolean; data: any }>;
    /** `runSummarizer` (the local `distilbart` model). */
    summarizer(text: string): Promise<string>;
    /** The job's embeddings, for `new HypaProcesser(...)` and `new HypaProcessorV2(...)`. */
    embeddings: EmbeddingEnv;
    /** A user regex on a script worker, under a per-task deadline and the run's abort signal. */
    regex(op: RegexOp, opts?: { deadlineMs?: number }): Promise<RegexOpResult>;
    /** `parseChatML` with the job's CBS (the job's chat and its owner). */
    parseChatML(text: string): OpenAIChat[] | null;
    /** `getUserName()`: the job's effective persona. */
    userName(): string;
    /** `hypaV3ProgressStore.set(...)`: a `progress` notice to the job's tab. */
    progress(payload: { open: boolean; miniMsg: string; msg: string; subMsg: string }): void;
    /** `Math.random` (HypaV3's random selection): the runner's random source. */
    random(): number;
    /** Removes the memory credentials from a provider's text before it becomes an error. */
    redact(text: string): string;
    /** Raises after an abort or a latched failure (after every await that ran outside work). */
    fence(): void;
    /** The run's signal: a rate limiter's waiting tasks end with it. */
    signal: AbortSignal;
};

/** `ChatTokenizer.tokenizeChat` (the job's `ChatTokenCounter`). */
export type MemoryTokenizer = {
    tokenizeChat(chat: OpenAIChat): Promise<number>;
};
