import { LRUMap } from "mnemonist";
import type { LLMTokenizer } from "../../../shared/llm.ts";
import { selectTokenizer, tokenizerIdentityKey, type TabTokenScope } from "../../../shared/tokenizerChoice.ts";
import type { Tokenizers } from "./tokenizers/index.ts";

/**
 * The server's token counter for jobs and tab-supplied scopes (`/api/tokens/count` and LLM requests).
 * The routing is the shared `selectTokenizer`, the families are the server's tokenizers, and with
 * `useTokenizerCaching` the results stay in an LRU of 1,500, keyed by the captured scope including
 * the model's `internalID`. Browser ids are a frozen reference captured from the former client
 * tokenizer (`server/src/tests/fixtures/tokens/browser-ids.json`).
 *
 * - A legacy plugin provider's `custom` tokenizer (`tokenizerFunc`) is never called; the text is
 *   counted with `cl100k_base`, including counts requested by the tab.
 * - Google's `countTokens` uses the server's `llmSecrets.google.accessToken`, with an LRU of 1,500;
 *   a count rejects after 30 s.
 */
export const TOKEN_CACHE_SIZE = 1500;
export const GOOGLE_COUNT_TIMEOUT_MS = 30_000;
export const GOOGLE_COUNT_MAX_CONCURRENT = 8;

export type TokenCountScope = {
    /** The main slot's derived `aiModel` and its profile's `currentPluginProvider`. */
    aiModel: string;
    currentPluginProvider: string;
    /** The catalogue entry of `aiModel`: its family, and the model id Google counts with. */
    model: { tokenizer: LLMTokenizer; internalID?: string };
    /** The legacy plugin provider's declared `tokenizer` option, or `"none"`. */
    pluginTokenizer: string;
    /** The main profile's tokenizer override (`openrouter` and `reverse_proxy`). */
    customTokenizer: string;
    /** Global provider behavior. */
    googleClaudeTokenizing: boolean;
    useTokenizerCaching: boolean;
    /** `llmSecrets.google.accessToken`, for `googleClaudeTokenizing`. */
    googleAccessToken?: string;
};

/** The tab's scope with the stored Google key, shared by LLM requests and token counts. */
export function tokenScopeFromTab(tokenizer: TabTokenScope, googleAccessToken: string | undefined): TokenCountScope {
    return {
        aiModel: tokenizer.aiModel,
        currentPluginProvider: tokenizer.currentPluginProvider,
        model: {
            tokenizer: tokenizer.modelTokenizer,
            ...(tokenizer.modelInternalID !== undefined ? { internalID: tokenizer.modelInternalID } : {}),
        },
        pluginTokenizer: tokenizer.pluginTokenizer,
        customTokenizer: tokenizer.customTokenizer,
        googleClaudeTokenizing: tokenizer.googleClaudeTokenizing,
        useTokenizerCaching: tokenizer.useTokenizerCaching,
        googleAccessToken,
    };
}

/** Tiktoken refuses special tokens in ordinary text; loader and service failures are not refusals. */
export function isTokenizerTextRefusal(error: unknown): error is Error {
    return (
        error instanceof Error && error.message.startsWith("The text contains a special token that is not allowed: ")
    );
}

type Encoded = ArrayLike<number>;

type PendingGoogleCount = {
    controller: AbortController;
    promise: Promise<Encoded>;
    callers: number;
};

export type TokenCounter = ReturnType<typeof createTokenCounter>;

export function createTokenCounter(options: { tokenizers: Tokenizers; fetchImpl?: typeof fetch }) {
    const { tokenizers } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const encodeCache = new LRUMap<string, Encoded>(TOKEN_CACHE_SIZE);
    const googleCache = new LRUMap<string, number>(TOKEN_CACHE_SIZE);
    const googleInFlight = new Map<string, PendingGoogleCount>();
    const googleQueue = new Set<() => void>();
    let googleActive = 0;

    // Google counts are represented as `totalTokens` zeros, or the Gemma
    // SentencePiece ids when the endpoint answers anything but 200.
    async function requestGoogleCount(
        text: string,
        scope: TokenCountScope,
        cacheKey: string,
        controller: AbortController,
    ): Promise<Encoded> {
        const timer = setTimeout(
            () => controller.abort(new Error("The Google token count timed out after 30 seconds")),
            GOOGLE_COUNT_TIMEOUT_MS,
        );
        try {
            const res = await fetchImpl(
                `https://generativelanguage.googleapis.com/v1beta/models/${scope.model.internalID}:countTokens?key=${scope.googleAccessToken}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
                    signal: controller.signal,
                },
            );
            if (res.status === 200) {
                const json = (await res.json()) as { totalTokens: number };
                controller.signal.throwIfAborted();
                googleCache.set(cacheKey, json.totalTokens);
                return new Uint32Array(json.totalTokens);
            }
        } finally {
            clearTimeout(timer);
        }
        controller.signal.throwIfAborted();
        return await tokenizers.encode("gemmaSentencePiece", text);
    }

    function pumpGoogleQueue(): void {
        for (const start of googleQueue) {
            if (googleActive >= GOOGLE_COUNT_MAX_CONCURRENT) {
                break;
            }
            googleQueue.delete(start);
            start();
        }
    }

    function scheduleGoogleCount(
        text: string,
        scope: TokenCountScope,
        cacheKey: string,
        controller: AbortController,
    ): Promise<Encoded> {
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                if (googleQueue.delete(start)) {
                    reject(controller.signal.reason);
                }
            };
            const start = () => {
                controller.signal.removeEventListener("abort", onAbort);
                googleActive++;
                void requestGoogleCount(text, scope, cacheKey, controller)
                    .then(resolve, reject)
                    .finally(() => {
                        googleActive--;
                        pumpGoogleQueue();
                    });
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            googleQueue.add(start);
            pumpGoogleQueue();
        });
    }

    async function countWithGoogle(text: string, scope: TokenCountScope, signal?: AbortSignal): Promise<Encoded> {
        signal?.throwIfAborted();
        const cacheKey = text + scope.model.internalID;
        const cached = googleCache.get(cacheKey);
        if (cached !== undefined) {
            return new Uint32Array(cached);
        }
        let pending = googleInFlight.get(cacheKey);
        if (!pending) {
            const controller = new AbortController();
            const request: PendingGoogleCount = {
                controller,
                callers: 0,
                promise: scheduleGoogleCount(text, scope, cacheKey, controller).finally(() => {
                    if (googleInFlight.get(cacheKey) === request) {
                        googleInFlight.delete(cacheKey);
                    }
                }),
            };
            googleInFlight.set(cacheKey, request);
            pending = request;
        }
        const request = pending;
        request.callers++;
        let attached = true;
        const detach = () => {
            if (attached) {
                attached = false;
                request.callers--;
            }
        };
        let onAbort: (() => void) | undefined;
        try {
            if (!signal) {
                return await request.promise;
            }
            return await new Promise<Encoded>((resolve, reject) => {
                onAbort = () => {
                    detach();
                    // The shared request lives until its last caller leaves.
                    if (request.callers === 0) {
                        if (googleInFlight.get(cacheKey) === request) {
                            googleInFlight.delete(cacheKey);
                        }
                        request.controller.abort(signal.reason);
                    }
                    reject(signal.reason);
                };
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) {
                    onAbort();
                }
                void request.promise.then(resolve, reject);
            });
        } finally {
            if (onAbort) {
                signal!.removeEventListener("abort", onAbort);
            }
            detach();
        }
    }

    async function encode(text: string, scope: TokenCountScope, signal?: AbortSignal): Promise<Encoded> {
        signal?.throwIfAborted();
        let cacheKey = "";
        if (scope.useTokenizerCaching) {
            // The shared identity includes the model's `internalID`: two scopes may resolve one `aiModel`
            // to different models, and Google counts by `internalID`.
            cacheKey = JSON.stringify([text, tokenizerIdentityKey(scope)]);
            const cached = encodeCache.get(cacheKey);
            if (cached !== undefined) {
                return cached;
            }
        }
        const choice = selectTokenizer({
            aiModel: scope.aiModel,
            customTokenizer: scope.customTokenizer,
            pluginTokenizer: scope.pluginTokenizer,
            modelTokenizer: scope.model.tokenizer,
            googleClaudeTokenizing: scope.googleClaudeTokenizing,
        });
        let result: Encoded;
        switch (choice.kind) {
            case "googleCloud":
                result = await countWithGoogle(text, scope, signal);
                break;
            case "pluginFunction":
                result = await tokenizers.encode("cl100k_base", text);
                break;
            case "family":
                result = await tokenizers.encode(choice.family, text);
                break;
        }
        if (scope.useTokenizerCaching) {
            encodeCache.set(cacheKey, result);
        }
        return result;
    }

    return {
        encode,
        count: async (text: string, scope: TokenCountScope, signal?: AbortSignal): Promise<number> =>
            (await encode(text, scope, signal)).length,
    };
}
