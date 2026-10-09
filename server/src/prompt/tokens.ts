import { LRUMap } from "mnemonist";
import type { LLMTokenizer } from "../../../shared/llm.ts";
import { selectTokenizer } from "../../../shared/tokenizerChoice.ts";
import type { Tokenizers } from "./tokenizers/index.ts";

/**
 * The server's token counter: the client's `encode` (`src/ts/tokenizer.ts`) with the settings of
 * one job instead of the tab's. The routing is the shared `selectTokenizer`, the families are the
 * server's tokenizers, and with `useTokenizerCaching` the results stay in an LRU of 1,500, keyed
 * by the client's fields plus the model's `internalID`.
 *
 * Differences from the client, recorded in `lore-templates-and-tokens.md`:
 * - a legacy plugin provider's `custom` tokenizer (`tokenizerFunc`) is never called; the text is
 *   counted with `cl100k_base` (the Safety Contract: plugin tokenizers are not used server-side);
 * - Google's `countTokens` uses the server's `llmSecrets.google.accessToken`, and its cache is an
 *   LRU of 1,500 instead of an unbounded map.
 */
export const TOKEN_CACHE_SIZE = 1500;

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

type Encoded = ArrayLike<number>;

export type TokenCounter = ReturnType<typeof createTokenCounter>;

export function createTokenCounter(options: { tokenizers: Tokenizers; fetchImpl?: typeof fetch }) {
    const { tokenizers } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const encodeCache = new LRUMap<string, Encoded>(TOKEN_CACHE_SIZE);
    const googleCache = new LRUMap<string, number>(TOKEN_CACHE_SIZE);

    // The client's `tokenizeGoogleCloud`: a count of `totalTokens` zeros, or the Gemma
    // SentencePiece ids when the endpoint answers anything but 200.
    async function countWithGoogle(text: string, scope: TokenCountScope): Promise<Encoded> {
        const cacheKey = text + scope.model.internalID;
        const cached = googleCache.get(cacheKey);
        if (cached !== undefined) {
            return new Uint32Array(cached);
        }
        const res = await fetchImpl(
            `https://generativelanguage.googleapis.com/v1beta/models/${scope.model.internalID}:countTokens?key=${scope.googleAccessToken}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
            },
        );
        if (res.status !== 200) {
            return await tokenizers.encode("gemmaSentencePiece", text);
        }
        const json = (await res.json()) as { totalTokens: number };
        googleCache.set(cacheKey, json.totalTokens);
        return new Uint32Array(json.totalTokens);
    }

    async function encode(text: string, scope: TokenCountScope): Promise<Encoded> {
        let cacheKey = "";
        if (scope.useTokenizerCaching) {
            // The client's key, plus the model's `internalID`: two scopes may resolve one `aiModel`
            // to different models, and Google counts by `internalID`.
            cacheKey = JSON.stringify([
                text,
                scope.aiModel,
                scope.customTokenizer,
                scope.currentPluginProvider,
                scope.googleClaudeTokenizing,
                scope.model.tokenizer,
                scope.model.internalID ?? null,
                scope.pluginTokenizer,
            ]);
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
                result = await countWithGoogle(text, scope);
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
        count: async (text: string, scope: TokenCountScope): Promise<number> => (await encode(text, scope)).length,
    };
}
