import type { TokenizerFamily } from "../../../../shared/tokenizerChoice.ts";
import { loadGemmaTokenizer } from "./gemma.ts";
import { loadTiktoken } from "./tiktoken.ts";
import { loadWebTokenizer } from "./webTokenizers.ts";

/**
 * Lazy registry of server tokenizer families selected by shared/tokenizerChoice.ts. Each registry coalesces loads
 * per family and retains successful encoders; failed loads are removed so a later call can retry. File-backed
 * families read through server/src/prompt/tokenizers/payloads.ts, while tiktoken uses its package data.
 *
 * Disposal is terminal and idempotent: pending loads settle before encoders are freed, and resumed acquisitions
 * refuse once disposal begins. Failed loads do not fail disposal; encoder cleanup errors are aggregated. The shared
 * instance created by server/src/app.ts serves request counts and token routes until server shutdown.
 */

type Encoder = { encode(text: string): ArrayLike<number>; dispose(): void };
type Loader = (rootDir: string) => Promise<Encoder>;

const tiktoken =
    (encoding: "cl100k_base" | "o200k_base"): Loader =>
    async () => {
        const tokenizer = await loadTiktoken(encoding);
        return { encode: (text) => tokenizer.encode(text), dispose: () => tokenizer.free() };
    };
const json =
    (relPath: string): Loader =>
    (rootDir) =>
        loadWebTokenizer(rootDir, "json", relPath);
const sentencePiece =
    (relPath: string): Loader =>
    (rootDir) =>
        loadWebTokenizer(rootDir, "sentencepiece", relPath);

/**
 * One loader per server tokenizer family. Names and payloads preserve the frozen browser-id
 * reference captured from the former client tokenizer (`server/src/tests/fixtures/tokens/browser-ids.json`).
 * `gemma` preserves its `gemmaTokenize`; `gemmaSentencePiece` is the SentencePiece fallback of a
 * failed Google count. `gemma/tokenizer.json` is unused.
 *
 * A row is `json` or `sentencePiece` over a `server/assets/token/` payload (`payloads.ts`, read through
 * `webTokenizers.ts`, or `gemma.ts` for `gemma`); the tiktoken families use the package's data (`tiktoken.ts`). Only
 * the tiktoken families refuse text with a special token; a new encoder that refuses must throw the message
 * `server/src/prompt/tokens.ts` `isTokenizerTextRefusal` matches, so the count route answers that text `null`.
 */
const LOADERS = {
    cl100k_base: tiktoken("cl100k_base"),
    o200k_base: tiktoken("o200k_base"),
    novellist: sentencePiece("trin/spiece.model"),
    claude: json("claude/claude.json"),
    novelai: sentencePiece("nai/nerdstash_v2.model"),
    llama: sentencePiece("llama/llama.model"),
    mistral: sentencePiece("mistral/tokenizer.model"),
    llama3: json("llama/llama3.json"),
    gemma: async (rootDir) => {
        const tokenizer = await loadGemmaTokenizer(rootDir);
        return { encode: (text) => tokenizer.encode(text), dispose: () => {} };
    },
    gemmaSentencePiece: sentencePiece("gemma/tokenizer.model"),
    cohere: json("cohere/tokenizer.json"),
    DeepSeek: json("deepseek/tokenizer.json"),
    DeepSeekV4: json("deepseek/v4/tokenizer.json"),
    GLM4: json("glm4/tokenizer.json"),
    GLM5: json("glm5/tokenizer.json"),
} satisfies Record<TokenizerFamily, Loader>;

// The families are the shared routing's (`shared/tokenizerChoice.ts`), no more and no fewer.
export type { TokenizerFamily };
/** The supported family names, in loader declaration order, matching shared/tokenizerChoice.ts. */
export const TOKENIZER_FAMILIES = Object.keys(LOADERS) as TokenizerFamily[];

/** Lazy family loading, encoding/counting, and terminal asynchronous disposal. */
export type Tokenizers = ReturnType<typeof createTokenizers>;

/**
 * The server's tokenizers. Each family loads on first use and stays loaded: counts are
 * deterministic, so one instance per family counts as the client's single replaced instance does.
 * A failed load is not cached. `dispose` is terminal: it refuses every later call, waits for the
 * loads already started, and frees each loaded family once. The owner (the server context) creates
 * one set and disposes it at shutdown.
 */
export function createTokenizers(options: { rootDir: string }) {
    const loaded = new Map<TokenizerFamily, Promise<Encoder>>();
    let disposal: Promise<void> | null = null;

    function load(family: TokenizerFamily): Promise<Encoder> {
        if (disposal) {
            return Promise.reject(new Error("The tokenizers are disposed"));
        }
        let encoder = loaded.get(family);
        if (!encoder) {
            encoder = LOADERS[family](options.rootDir).catch((error: unknown) => {
                loaded.delete(family);
                throw error;
            });
            loaded.set(family, encoder);
        }
        return encoder;
    }

    // An encode that resumes after `dispose` began must not touch an encoder it may free.
    async function acquire(family: TokenizerFamily): Promise<Encoder> {
        const encoder = await load(family);
        if (disposal) {
            throw new Error("The tokenizers are disposed");
        }
        return encoder;
    }

    async function disposeAll(): Promise<void> {
        const results = await Promise.allSettled(loaded.values());
        loaded.clear();
        const errors: unknown[] = [];
        for (const result of results) {
            if (result.status === "fulfilled") {
                try {
                    result.value.dispose();
                } catch (error) {
                    errors.push(error);
                }
            }
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "Some tokenizers failed to dispose");
        }
    }

    return {
        load: async (family: TokenizerFamily): Promise<void> => {
            await acquire(family);
        },
        encode: async (family: TokenizerFamily, text: string): Promise<ArrayLike<number>> =>
            (await acquire(family)).encode(text),
        count: async (family: TokenizerFamily, text: string): Promise<number> =>
            (await acquire(family)).encode(text).length,
        dispose: (): Promise<void> => (disposal ??= disposeAll()),
    };
}
