import { LLMTokenizer } from "./llm.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * Which tokenizer counts a model's text on the server. The tab captures `tabTokenScope`
 * (`src/ts/tokenizer.ts`) for `/api/tokens/count` and LLM requests; shared routing keeps those
 * choices aligned.
 *
 * The families are the server's (`server/src/prompt/tokenizers/`): `gemma` is the Transformers.js
 * Gemma tokenizer over `llama3.json`, `gemmaSentencePiece` the web tokenizer over
 * `gemma/tokenizer.model`. Their browser ids are a frozen reference captured from the former
 * client tokenizer (`server/src/tests/fixtures/tokens/browser-ids.json`).
 */
export type TokenizerFamily =
    | "cl100k_base"
    | "o200k_base"
    | "novellist"
    | "claude"
    | "novelai"
    | "llama"
    | "mistral"
    | "llama3"
    | "gemma"
    | "gemmaSentencePiece"
    | "cohere"
    | "DeepSeek"
    | "DeepSeekV4"
    | "GLM4"
    | "GLM5";

export type TokenizerChoice =
    | { kind: "family"; family: TokenizerFamily }
    /** Google's `countTokens` endpoint (`googleClaudeTokenizing`); `gemmaSentencePiece` when it fails. */
    | { kind: "googleCloud" }
    /** A legacy provider's `custom` tokenizer: `tokenizerFunc` is never called; counts use `cl100k_base`. */
    | { kind: "pluginFunction" };

export type TokenizerSettings = {
    /** The selected preset's `aiModel`. */
    aiModel: string;
    /** `providers.customTokenizer`, for `openrouter` and `reverse_proxy`. */
    customTokenizer: string;
    /** The legacy plugin provider's declared `tokenizer` option, or `"none"`. */
    pluginTokenizer: string;
    /** The model's catalogue family (`LLMModel.tokenizer`). */
    modelTokenizer: LLMTokenizer;
    /** `providers.googleClaudeTokenizing`. */
    googleClaudeTokenizing: boolean;
};

/** The tokenizer-selecting fields used by the server encode, tab count, and strong-ban cache keys. */
export type TokenizerIdentity = {
    aiModel: string;
    customTokenizer: string;
    currentPluginProvider: string;
    googleClaudeTokenizing: boolean;
    model: { tokenizer: LLMTokenizer; internalID?: string };
    pluginTokenizer: string;
};

export function tokenizerIdentityKey(scope: TokenizerIdentity): string {
    return JSON.stringify([
        scope.aiModel,
        scope.customTokenizer,
        scope.currentPluginProvider,
        scope.googleClaudeTokenizing,
        scope.model.tokenizer,
        scope.model.internalID ?? null,
        scope.pluginTokenizer,
    ]);
}

/** The tab's tokenizer scope, sent to the LLM request and token count routes. */
export type TabTokenScope = {
    aiModel: string;
    currentPluginProvider: string;
    modelTokenizer: LLMTokenizer;
    modelInternalID?: string;
    /** The legacy plugin provider's declared tokenizer, or "none". */
    pluginTokenizer: string;
    customTokenizer: string;
    googleClaudeTokenizing: boolean;
    useTokenizerCaching: boolean;
};

export function isTabTokenScope(value: unknown): value is TabTokenScope {
    return (
        isPlainObject(value) &&
        typeof value.aiModel === "string" &&
        typeof value.currentPluginProvider === "string" &&
        typeof value.modelTokenizer === "number" &&
        (value.modelInternalID === undefined || typeof value.modelInternalID === "string") &&
        typeof value.pluginTokenizer === "string" &&
        typeof value.customTokenizer === "string" &&
        typeof value.googleClaudeTokenizing === "boolean" &&
        typeof value.useTokenizerCaching === "boolean"
    );
}

/** The tab's `encodeWithTokenizer` names; unlike model overrides, `llama3` uses its own family. */
export function playgroundFamily(name: string): TokenizerFamily {
    switch (name) {
        case "mistral":
        case "novelai":
        case "claude":
        case "llama":
        case "llama3":
        case "novellist":
        case "gemma":
        case "cohere":
            return name;
        case "deepseek":
            return "DeepSeek";
        case "deepseek-v4":
            return "DeepSeekV4";
        case "glm4":
            return "GLM4";
        case "glm5":
            return "GLM5";
        default:
            return "cl100k_base";
    }
}

const family = (name: TokenizerFamily): TokenizerChoice => ({ kind: "family", family: name });

/** A `customTokenizer` or plugin `tokenizer` name; `llama3` counts with the `llama` model. */
function byName(name: string): TokenizerChoice | null {
    switch (name) {
        case "mistral":
            return family("mistral");
        case "llama":
        case "llama3":
            return family("llama");
        case "novelai":
            return family("novelai");
        case "claude":
            return family("claude");
        case "novellist":
            return family("novellist");
        case "gemma":
            return family("gemma");
        case "cohere":
            return family("cohere");
        case "deepseek":
            return family("DeepSeek");
        case "deepseek-v4":
            return family("DeepSeekV4");
        case "glm4":
            return family("GLM4");
        case "glm5":
            return family("GLM5");
        default:
            return null;
    }
}

export function selectTokenizer(settings: TokenizerSettings): TokenizerChoice {
    if (settings.aiModel === "openrouter" || settings.aiModel === "reverse_proxy") {
        return byName(settings.customTokenizer) ?? family("o200k_base");
    }
    // The plugin option defaults to "none", so a `custom` model always takes this branch.
    if (settings.aiModel === "custom" && settings.pluginTokenizer) {
        switch (settings.pluginTokenizer) {
            case "o200k_base":
                return family("o200k_base");
            case "cl100k_base":
                return family("cl100k_base");
            case "custom":
                return { kind: "pluginFunction" };
            default:
                return byName(settings.pluginTokenizer) ?? family("o200k_base");
        }
    }
    switch (settings.modelTokenizer) {
        case LLMTokenizer.NovelList:
            return family("novellist");
        case LLMTokenizer.Claude:
            return family("claude");
        case LLMTokenizer.NovelAI:
            return family("novelai");
        case LLMTokenizer.Mistral:
            return family("mistral");
        case LLMTokenizer.Llama:
            return family("llama");
        case LLMTokenizer.tiktokenO200Base:
            return family("o200k_base");
        case LLMTokenizer.GoogleCloud:
            return settings.googleClaudeTokenizing ? { kind: "googleCloud" } : family("gemma");
        case LLMTokenizer.Gemma:
            return family("gemma");
        case LLMTokenizer.DeepSeek:
            return family("DeepSeek");
        case LLMTokenizer.DeepSeekV4:
            return family("DeepSeekV4");
        case LLMTokenizer.GLM4:
            return family("GLM4");
        case LLMTokenizer.GLM5:
            return family("GLM5");
        case LLMTokenizer.Cohere:
            return family("cohere");
        default:
            // `Unknown`, `tiktokenCl100kBase`, `Llama3`, `Local`.
            return family("cl100k_base");
    }
}
