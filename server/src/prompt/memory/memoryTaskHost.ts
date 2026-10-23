import { randomUUID } from "node:crypto";
import { createCbsEvaluator } from "../../../../shared/cbs/evaluator.ts";
import { CbsLimitError } from "../../../../shared/cbs/limits.ts";
import type { MemoryTaskInput } from "../../../../shared/jobs.ts";
import type { RequestArgs } from "../../../../shared/llm/request.ts";
import { ChatTokenCounter } from "../../../../shared/prompt/chatTokens.ts";
import { createJobCbsHost, serverCbsLimits, type ServerCbsTimeLimits } from "../../jobs/cbsHost.ts";
import type { JobChannel } from "../../jobs/channel.ts";
import type { JobScope } from "../../jobs/jobScope.ts";
import { untilAborted } from "../../jobs/runSetup.ts";
import { requestChatDataOuter } from "../../llm/outer.ts";
import { collectSecrets, createRedactor } from "../../llm/redact.ts";
import type { requestDataResponse } from "../../llm/request.ts";
import type { JobRequestSpec, LlmRequests } from "../../llm/requests.ts";
import type { ScriptWorkerPool } from "../../scripts/workerPool.ts";
import type { EmbeddingsService } from "../embeddings.ts";
import type { TokenCounter, TokenCountScope } from "../tokens.ts";
import { parseChatML } from "../triggers.ts";
import type { HypaV3SeparatorLimits, MemoryHost, MemoryTokenizer } from "./host.ts";

/**
 * A fatal failure of a memory task host's work: the request layer ended the run (`endJob`: a barrier
 * failure, a timeout) or the task's CBS budget ran out. It aborts the host's signal, but the task
 * failed (it was not cancelled). The message is redacted.
 */
export class MemoryHostFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemoryHostFailure";
    }
}

/**
 * The channel of a memory task's requests: no tab is attached, so every callback is `unregistered`
 * (no `bodyIntercepter` runs, and a plugin provider model fails as one that is not registered).
 */
const DETACHED_MEMORY_CHANNEL: JobChannel = {
    notice() {},
    ask: async () => ({ outcome: "aborted", error: "A memory task asks nothing" }),
    callback: async () => ({
        outcome: "refused",
        refusal: "unregistered",
        error: "A memory task runs without a tab",
    }),
};

export type MemoryTaskHostDeps = {
    llm: Pick<LlmRequests, "runInJob">;
    embeddings: EmbeddingsService;
    scriptWorkers: Pick<ScriptWorkerPool, "regex">;
    tokens: Pick<TokenCounter, "encode" | "count">;
    rootDir: string;
    /** The CBS wall times of the task (`serverCbsLimits`; default the production ones, tests lengthen them). */
    cbsTimeLimits?: ServerCbsTimeLimits;
    /** HypaV3's summary separator limits (`MemoryHost.separatorLimits`; default the production ones). */
    separatorLimits?: HypaV3SeparatorLimits;
};

/**
 * The `MemoryHost` a detached HypaV3 memory task runs on, and the `MemoryTokenizer` of the job that
 * handed the input off.
 *
 * - `scope`: the task's fresh `loadJobScope` at its start. The caller loads it with the input's
 *   effective preset and model preset ids, the admitted persona, `presetChain` semantics only when
 *   `input.effective.fromChain`, and `speakerChaId: input.speakerId` (so the request projection names
 *   a group speaker as the job's runner does); it checks the admission binding itself. The host never
 *   changes the scope. `host.db` is the scope's `db` with `maxResponse` from `input.maxResponse`, so the
 *   response correction matches the job's captured `currentTokens`.
 * - Counting: the tokenizer is the runner's `ChatTokenCounter` rebuilt from `input.tokenPolicy`
 *   (`memoryTokenPolicy`), with the Google key of the fresh scope (the policy carries no credential).
 *   Plain-text `tokenize` and the requests' own counting use the same captured scope, so a Plugin main
 *   model the job admitted still counts as it did in the job.
 * - Requests: `requestChatDataOuter` (retries, `banCharacterset`) → `llm.runInJob` with the fresh
 *   request settings (the `memory` slot and its credentials), one synthetic job id, mode and source
 *   `"memory"`, the input's chat, and a stub channel. No `request` trigger, no plugin replacers, no
 *   tools, no inlays. A failure's text is redacted.
 * - CBS: one write-disabled evaluator with one task-wide budget (summarization prompts, stop strings).
 *   A reached limit ends the host (`MemoryHostFailure`).
 * - The end: `signal` (the task's) and `fence` (the task's own check, which throws once the task ended
 *   or must stop) are checked before and after every awaited call of the host. The host's `signal`
 *   also aborts on a `MemoryHostFailure` or a thrown `fence` error. Work a worker or a provider already
 *   runs (a regex, a Google count) is not interrupted: the host stops waiting for it. A regex settles
 *   on its own deadline; the underlying Google request still settles on its own, and the caller's
 *   drain must allow for it.
 * - `redact` covers the request credentials and the embedding keys. The caller redacts what it
 *   publishes (an execution's error, a warming failure) with it.
 * - `completions` and `summarizer` are unavailable (HypaV3 uses neither); `progress` notices go
 *   nowhere (no tab); `random` is `Math.random`.
 */
export function createMemoryTaskHost(arg: {
    scope: JobScope;
    input: MemoryTaskInput;
    deps: MemoryTaskHostDeps;
    signal: AbortSignal;
    fence: () => void;
}): { host: MemoryHost; tokenizer: MemoryTokenizer } {
    const { scope, input, deps } = arg;
    const policy = input.tokenPolicy;
    const requestDb = scope.request.db;
    const chatRef = { chaId: input.chatRef.chaId, chatId: input.chatRef.chatId };
    const ended = new AbortController();
    const signal = AbortSignal.any([arg.signal, ended.signal]);

    const live = () => {
        if (signal.aborted) {
            throw signal.reason;
        }
        try {
            arg.fence();
        } catch (error) {
            if (!ended.signal.aborted) {
                ended.abort(error);
            }
            throw signal.reason;
        }
    };
    /** Runs `work` between two checks of the host's end. */
    const fenced = async <T>(work: () => Promise<T>): Promise<T> => {
        live();
        try {
            return await work();
        } finally {
            live();
        }
    };

    const embeddingEnv = deps.embeddings.forJob({
        db: scope.db,
        // The write-only memory key is in the request projection, never in the scope's `db`.
        supaMemoryKey: requestDb.supaMemoryKey ?? "",
        signal,
    });
    const requestRedactor = createRedactor(collectSecrets(requestDb));
    const redact = (text: string) => embeddingEnv.redact(requestRedactor.text(text));
    const fail = (message: string): MemoryHostFailure => {
        const failure = new MemoryHostFailure(redact(message));
        ended.abort(failure);
        return failure;
    };

    // One CBS budget for the whole task (every summary, request, and retry); a chat variable is never
    // written.
    const evaluator = createCbsEvaluator(
        createJobCbsHost(scope, {
            rootDir: deps.rootDir,
            setChatVar: () => false,
            limits: serverCbsLimits({ usedMs: 0 }, deps.cbsTimeLimits),
        }),
    );
    const parse = (text: string, ref?: { chaId: string; chatId: string } | null) => {
        live();
        try {
            return evaluator.risuChatParser(text, { chatRef: ref ?? chatRef });
        } catch (error) {
            if (error instanceof CbsLimitError) {
                throw fail(error.message);
            }
            throw error;
        }
    };

    // The job's token scope as the policy captured it, with the fresh scope's Google key.
    const tokenScope: TokenCountScope = {
        ...policy.tokenizer,
        model: { ...policy.tokenizer.model },
        googleAccessToken: requestDb.google?.accessToken,
    };
    const counter = new ChatTokenCounter(policy.chatAdditionalTokens, policy.useName, {
        count: (text) => deps.tokens.count(text, tokenScope),
        supportsInlayImage: () => policy.supportsInlayImage,
        mainModel: () => policy.mainModel,
        requestModel: () => policy.requestModel,
        gptVisionQuality: () => policy.gptVisionQuality,
    });
    const tokenizer: MemoryTokenizer = {
        tokenizeChat: (chat) => fenced(() => untilAborted(counter.tokenizeChat(chat), signal)),
    };

    const jobId = `memory-${randomUUID()}`;
    const unavailable = (name: string) => async (): Promise<never> => {
        live();
        throw new Error(`${name} is not available to a memory task`);
    };
    const noInlay = async (): Promise<never> => {
        throw new Error("A memory task stores no inlay");
    };
    const spec = (attemptArg: RequestArgs): JobRequestSpec => ({
        jobId,
        loaded: scope.request,
        mode: "memory",
        arg: attemptArg,
        source: "memory",
        chatRef,
        messageId: null,
        tokenScope,
        mainModelImageInput: policy.supportsInlayImage,
        channel: DETACHED_MEMORY_CHANNEL,
        parseCbs: parse,
        inlays: { saveSignature: noInlay, writeImage: noInlay, setAsset: noInlay },
        alertError: () => {},
        endJob: (text) => {
            fail(text);
        },
        tools: {
            descriptors: [],
            charge: () => false,
            limit: 0,
            call: async () => {
                throw new Error("A memory task calls no tools");
            },
        },
        toolCalls: { read: () => undefined, write: () => {} },
        signal,
    });

    const host: MemoryHost = {
        db: { ...scope.db, maxResponse: input.maxResponse },
        tokenize: (text) => fenced(() => untilAborted(deps.tokens.count(text, tokenScope), signal)),
        request: (formated) =>
            fenced(async (): Promise<requestDataResponse> => {
                const response = await requestChatDataOuter(
                    { formated, bias: {}, useStreaming: false, noMultiGen: true, chatRef },
                    "memory",
                    {
                        db: requestDb,
                        signal,
                        attempt: async (attemptArg) => {
                            // The outer loop yields a turn before each attempt; check the task after it.
                            live();
                            return deps.llm.runInJob(spec(attemptArg));
                        },
                    },
                );
                if (response.type === "streaming") {
                    await response.result.cancel().catch(() => {});
                }
                return response.type === "fail" ? { ...response, result: redact(response.result) } : response;
            }),
        completions: unavailable("openai-completions"),
        summarizer: unavailable("The local summarizer"),
        embeddings: embeddingEnv,
        regex: (op, opts) => fenced(() => untilAborted(deps.scriptWorkers.regex(op, opts), signal)),
        ...(deps.separatorLimits ? { separatorLimits: deps.separatorLimits } : {}),
        parseChatML: (text) => {
            live();
            return parseChatML(text, (part) => parse(part));
        },
        userName: () => scope.effectivePersona.name,
        progress: () => {},
        random: Math.random,
        redact,
        fence: live,
        signal,
    };
    return { host, tokenizer };
}
