import type { Database } from "../../../../shared/database.ts";
import type { OpenAIChat } from "../../../../shared/openai.ts";
import type { requestDataResponse } from "../../llm/request.ts";
import type { RegexOp, RegexOpResult } from "../../scripts/worker.ts";
import type { EmbeddingEnv } from "../embeddings.ts";

/**
 * The boundary of the server's memory algorithms: they read settings, make requests, embed, and count
 * only through these types. A job's host is built by the runner (`server/src/prompt/runner.ts`), a
 * detached memory task's by `createMemoryTaskHost` (`memoryTaskHost.ts`). The stored memory key
 * (`supaMemoryKey`) is used behind it, and a provider's text passes `redact` before an algorithm
 * puts it into an error.
 */

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
     * stored memory key, as `{ ok, data }`. An answer whose body is not JSON is a failure (`ok: false`
     * with the text), and a successful answer that carries the stored key in any form is refused
     * (`ok: false`), as the browser path's proxy refuses it; the job's host (`server/src/prompt/runner.ts`)
     * does both. A detached task's host has none.
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
    /** Discards a tracked local-model refusal when the algorithm recovers from the failure and continues. */
    recoverLocalModelFailure?(): void;
    /** A user regex on a script worker, under a per-task deadline and the run's abort signal. */
    regex(op: RegexOp, opts?: { deadlineMs?: number }): Promise<RegexOpResult>;
    /** HypaV3's summary separator limits; absent, the production ones (tests lengthen them). */
    separatorLimits?: HypaV3SeparatorLimits;
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

/**
 * HypaV3's summary separator limits: the cumulative chunking budget of one memory step
 * (`SEPARATOR_BUDGET_MS`, 5,000 ms) and the most one split may take (`DEFAULT_REGEX_DEADLINE_MS`,
 * 1,000 ms; less when less of the budget is left).
 */
export type HypaV3SeparatorLimits = { budgetMs: number; regexDeadlineMs: number };

/** `ChatTokenizer.tokenizeChat` (the job's `ChatTokenCounter`). */
export type MemoryTokenizer = {
    tokenizeChat(chat: OpenAIChat): Promise<number>;
};
