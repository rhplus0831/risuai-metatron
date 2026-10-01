import { loadGemmaTokenizer } from "./gemma.ts";
import { loadTiktoken } from "./tiktoken.ts";
import { loadWebTokenizer } from "./webTokenizers.ts";

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
 * One loader per tokenizer the client's `tokenizer.ts` can pick, under the client's names, with the
 * payload it fetches. `gemma` is `gemmaTokenize`; `gemmaSentencePiece` is the `gemma` case of
 * `tokenizeWebTokenizers`, the fallback of a failed Google count. `gemma/tokenizer.json` is unused.
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
} satisfies Record<string, Loader>;

export type TokenizerFamily = keyof typeof LOADERS;
export const TOKENIZER_FAMILIES = Object.keys(LOADERS) as TokenizerFamily[];

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
