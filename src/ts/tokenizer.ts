import { type AnyClientCharacter, selectedCharacter } from "./storage/characterStore.svelte";
import { activeMainProfile, readSettingsRoot, settings, activePreset } from "./storage/settingsViews.svelte";
import type { Tiktoken } from "@dqbd/tiktoken";
import type { Tokenizer } from "@mlc-ai/web-tokenizers";
import { type groupChat, type character, type Chat, type DeepReadonly } from "./storage/database.svelte";
import type { MultiModal, OpenAIChat } from "./process/index.svelte";
import { supportsInlayImage } from "./process/files/inlays";
import { risuChatParser } from "./parser/parser.svelte";
import { globalFetch } from "./globalApi.svelte";
import { getModelInfoForMode, LLMTokenizer, type LLMModel } from "./model/modellist";
import { pluginHooks } from "./plugins/pluginHooks";
import type { GemmaTokenizer } from "@huggingface/transformers";
import { LRUMap } from "mnemonist";
import { selectTokenizer, type TokenizerFamily } from "../../shared/tokenizerChoice.ts";
import { ChatTokenCounter } from "../../shared/prompt/chatTokens.ts";

const MAX_CACHE_SIZE = 1500;

const encodeCache = new LRUMap<string, number[] | Uint32Array | Int32Array>(MAX_CACHE_SIZE);

function getHash(
    data: string,
    aiModel: string,
    customTokenizer: string,
    currentPluginProvider: string,
    googleClaudeTokenizing: boolean,
    modelInfo: LLMModel,
    pluginTokenizer: string,
): string {
    const combined = `${data}::${aiModel}::${customTokenizer}::${currentPluginProvider}::${googleClaudeTokenizing ? "1" : "0"}::${modelInfo.tokenizer}::${pluginTokenizer}`;
    return combined;
}

export const tokenizerList = [
    ["tik", "Tiktoken (OpenAI)"],
    ["mistral", "Mistral"],
    ["novelai", "NovelAI"],
    ["claude", "Claude"],
    ["llama", "Llama"],
    ["llama3", "Llama3"],
    ["novellist", "Novellist"],
    ["gemma", "Gemma"],
    ["cohere", "Cohere"],
    ["deepseek", "DeepSeek"],
    ["deepseek-v4", "DeepSeek V4"],
    ["glm4", "GLM4"],
    ["glm5", "GLM5"],
] as const;

export async function encodeWithTokenizer(
    data: string,
    tokenizerType: string,
): Promise<number[] | Uint32Array | Int32Array> {
    switch (tokenizerType) {
        case "tik":
            return await tikJS(data, "cl100k_base");
        case "mistral":
            return await tokenizeWebTokenizers(data, "mistral");
        case "novelai":
            return await tokenizeWebTokenizers(data, "novelai");
        case "claude":
            return await tokenizeWebTokenizers(data, "claude");
        case "llama":
            return await tokenizeWebTokenizers(data, "llama");
        case "llama3":
            return await tokenizeWebTokenizers(data, "llama3");
        case "novellist":
            return await tokenizeWebTokenizers(data, "novellist");
        case "gemma":
            return await gemmaTokenize(data);
        case "cohere":
            return await tokenizeWebTokenizers(data, "cohere");
        case "deepseek":
            return await tokenizeWebTokenizers(data, "DeepSeek");
        case "deepseek-v4":
            return await tokenizeWebTokenizers(data, "DeepSeekV4");
        case "glm4":
            return await tokenizeWebTokenizers(data, "GLM4");
        case "glm5":
            return await tokenizeWebTokenizers(data, "GLM5");
        default:
            return await tikJS(data, "cl100k_base");
    }
}

export async function encode(data: string): Promise<number[] | Uint32Array | Int32Array> {
    const modelInfo = getModelInfoForMode("model");
    const aiModel = readSettingsRoot("aiModel") as string;
    const { currentPluginProvider, customTokenizer } = activeMainProfile;
    const pluginTokenizer = pluginHooks.providerOptions.get(currentPluginProvider)?.tokenizer ?? "none";

    let cacheKey = "";
    if (settings.providers.useTokenizerCaching) {
        cacheKey = getHash(
            data,
            aiModel,
            customTokenizer,
            currentPluginProvider,
            settings.providers.googleClaudeTokenizing,
            modelInfo,
            pluginTokenizer,
        );
        const cachedResult = encodeCache.get(cacheKey);
        if (cachedResult !== undefined) {
            return cachedResult;
        }
    }

    let result: number[] | Uint32Array | Int32Array;

    // The routing is shared with the server counter (`shared/tokenizerChoice.ts`).
    const choice = selectTokenizer({
        aiModel,
        customTokenizer,
        pluginTokenizer,
        modelTokenizer: modelInfo.tokenizer,
        googleClaudeTokenizing: settings.providers.googleClaudeTokenizing,
    });
    switch (choice.kind) {
        case "googleCloud":
            result = await tokenizeGoogleCloud(data);
            break;
        case "pluginFunction":
            result = (await pluginHooks.providerOptions.get(currentPluginProvider)?.tokenizerFunc?.(data)) ?? [0];
            break;
        case "family":
            result = await encodeFamily(data, choice.family);
            break;
    }
    if (settings.providers.useTokenizerCaching) {
        encodeCache.set(cacheKey, result);
    }

    return result;
}

async function encodeFamily(data: string, family: TokenizerFamily): Promise<number[] | Uint32Array | Int32Array> {
    switch (family) {
        case "cl100k_base":
        case "o200k_base":
            return await tikJS(data, family);
        case "gemma":
            return await gemmaTokenize(data);
        case "gemmaSentencePiece":
            return await tokenizeWebTokenizers(data, "gemma");
        default:
            return await tokenizeWebTokenizers(data, family);
    }
}

type tokenizerType =
    | "novellist"
    | "claude"
    | "novelai"
    | "llama"
    | "mistral"
    | "llama3"
    | "gemma"
    | "cohere"
    | "googleCloud"
    | "DeepSeek"
    | "DeepSeekV4"
    | "GLM4"
    | "GLM5";

let tikParser: Tiktoken = null;
let tokenizersTokenizer: Tokenizer = null;
let tokenizersType: tokenizerType = null;
let lastTikModel = "cl100k_base";

let googleCloudTokenizedCache = new Map<string, number>();

async function tokenizeGoogleCloud(text: string) {
    const model = getModelInfoForMode("model");
    const cacheKey = text + model.internalID;

    if (googleCloudTokenizedCache.has(cacheKey)) {
        const count = googleCloudTokenizedCache.get(cacheKey) ?? 0;
        return new Uint32Array(count);
    }

    // With the stored Google key, on the server (`auxFetch`, Phase 5 slice 7b); loaded on first use,
    // as this module is imported nearly everywhere.
    const { auxFetch } = await import("./network/auxFetch");
    const res = await auxFetch(
        "google-count-tokens",
        `https://generativelanguage.googleapis.com/v1beta/models/${model.internalID}:countTokens`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [
                            {
                                text: text,
                            },
                        ],
                    },
                ],
            }),
        },
    );

    if (res.status !== 200) {
        return await tokenizeWebTokenizers(text, "gemma");
    }

    const json = await res.json();
    googleCloudTokenizedCache.set(cacheKey, json.totalTokens as number);
    const count = json.totalTokens as number;

    return new Uint32Array(count);
}

let gemmaTokenizer: GemmaTokenizer = null;
async function gemmaTokenize(text: string) {
    if (!gemmaTokenizer) {
        const { GemmaTokenizer } = await import("@huggingface/transformers");
        gemmaTokenizer = new GemmaTokenizer(await (await fetch("/token/llama/llama3.json")).json(), {});
    }
    return gemmaTokenizer.encode(text);
}

async function tikJS(text: string, model = "cl100k_base") {
    if (!tikParser || lastTikModel !== model) {
        tikParser?.free();
        if (model === "cl100k_base") {
            const { Tiktoken } = await import("@dqbd/tiktoken");
            const cl100k_base = await import("@dqbd/tiktoken/encoders/cl100k_base.json");
            lastTikModel = model;

            tikParser = new Tiktoken(cl100k_base.bpe_ranks, cl100k_base.special_tokens, cl100k_base.pat_str);
        }
        if (model === "o200k_base") {
            const { Tiktoken } = await import("@dqbd/tiktoken");
            const o200k_base = await import("src/etc/o200k_base.json");
            lastTikModel = model;
            tikParser = new Tiktoken(o200k_base.bpe_ranks, o200k_base.special_tokens, o200k_base.pat_str);
        }
    }
    return tikParser.encode(text);
}

async function tokenizeWebTokenizers(text: string, type: tokenizerType) {
    if (type !== tokenizersType || !tokenizersTokenizer) {
        const webTokenizer = await import("@mlc-ai/web-tokenizers");
        switch (type) {
            case "novellist":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/trin/spiece.model")).arrayBuffer(),
                );
                break;
            case "claude":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/claude/claude.json")).arrayBuffer(),
                );
                break;
            case "llama3":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/llama/llama3.json")).arrayBuffer(),
                );
                break;
            case "cohere":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/cohere/tokenizer.json")).arrayBuffer(),
                );
                break;
            case "novelai":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/nai/nerdstash_v2.model")).arrayBuffer(),
                );

                break;
            case "llama":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/llama/llama.model")).arrayBuffer(),
                );
                break;
            case "mistral":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/mistral/tokenizer.model")).arrayBuffer(),
                );
                break;
            case "gemma":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/gemma/tokenizer.model")).arrayBuffer(),
                );
                break;
            case "DeepSeek":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/deepseek/tokenizer.json")).arrayBuffer(),
                );
                break;
            case "DeepSeekV4":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/deepseek/v4/tokenizer.json")).arrayBuffer(),
                );
                break;
            case "GLM4":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/glm4/tokenizer.json")).arrayBuffer(),
                );
                break;
            case "GLM5":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/glm5/tokenizer.json")).arrayBuffer(),
                );
                break;
        }
        tokenizersType = type;
    }
    return tokenizersTokenizer.encode(text);
}

export async function tokenizerChar(char: character) {
    const encoded = await encode(char.name + "\n" + char.firstMessage + "\n" + char.desc);
    return encoded.length;
}

export async function tokenize(data: string) {
    const encoded = await encode(data);
    return encoded.length;
}

export async function tokenizeAccurate(data: string, consistantChar?: boolean) {
    data = risuChatParser(data.replace("{{slot}}", ""), {
        tokenizeAccurate: true,
        consistantChar: consistantChar,
    });
    const encoded = await encode(data);
    return encoded.length;
}

/** The shared token arithmetic (`shared/prompt/chatTokens.ts`) with the client's encoder. */
export class ChatTokenizer extends ChatTokenCounter {
    constructor(chatAdditionalTokens: number, useName: "name" | "noName") {
        super(chatAdditionalTokens, useName, {
            encode,
            supportsInlayImage,
            gptVisionQuality: () => settings.providers.gptVisionQuality,
        });
    }
}

export async function getCharToken(char?: AnyClientCharacter | null) {
    let persistant = 0;
    let dynamic = 0;

    if (!char) {
        const c = selectedCharacter();
        char = c;
    }
    if (char.type === "group") {
        return { persistant: 0, dynamic: 0 };
    }

    const basicTokenize = async (data: string) => {
        data = data.replace(/{{char}}/g, char.name).replace(/<char>/g, char.name);
        return await tokenize(data);
    };

    persistant += await basicTokenize(char.desc);
    persistant += await basicTokenize(char.personality ?? "");
    persistant += await basicTokenize(char.scenario ?? "");
    for (const lore of char.globalLore) {
        let cont = lore.content
            .split("\n")
            .filter((line) => {
                if (line.startsWith("@@")) {
                    return false;
                }
                if (line === "") {
                    return false;
                }
                return true;
            })
            .join("\n");
        dynamic += await basicTokenize(cont);
    }

    return { persistant, dynamic };
}

/** The tokens of a chat's messages (0 for none: a selected chat that is still loading). */
export async function getChatToken(chat: DeepReadonly<Chat> | null) {
    let persistant = 0;
    if (!chat) {
        return persistant;
    }

    const chatTokenizer = new ChatTokenizer(0, "name");
    const chatf = chat.message.map((d) => {
        return {
            role: d.role === "user" ? "user" : "assistant",
            content: d.data,
        } as OpenAIChat;
    });
    for (const chat of chatf) {
        persistant += await chatTokenizer.tokenizeChat(chat);
    }

    return persistant;
}
