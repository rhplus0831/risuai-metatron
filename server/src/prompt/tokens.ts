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

export type TokenCounter = ReturnType<typeof createTokenCounter>;

export function createTokenCounter(options: { tokenizers: Tokenizers; fetchImpl?: typeof fetch }) {
    const { tokenizers } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const encodeCache = new LRUMap<string, Encoded>(TOKEN_CACHE_SIZE);
    const googleCache = new LRUMap<string, number>(TOKEN_CACHE_SIZE);

    // Google counts are represented as `totalTokens` zeros, or the Gemma
    // SentencePiece ids when the endpoint answers anything but 200.
    async function countWithGoogle(text: string, scope: TokenCountScope, signal?: AbortSignal): Promise<Encoded> {
        const cacheKey = text + scope.model.internalID;
        const cached = googleCache.get(cacheKey);
        if (cached !== undefined) {
            return new Uint32Array(cached);
        }
        const controller = new AbortController();
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
                    signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
                },
            );
            if (res.status === 200) {
                const json = (await res.json()) as { totalTokens: number };
                googleCache.set(cacheKey, json.totalTokens);
                return new Uint32Array(json.totalTokens);
            }
        } finally {
            clearTimeout(timer);
        }
        signal?.throwIfAborted();
        return await tokenizers.encode("gemmaSentencePiece", text);
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
