import { type AnyClientCharacter, selectedCharacter } from "./storage/characterStore.svelte";
import {
    activeMainProfile,
    readSettingsRoot,
    scopedPresetRoot,
    settings,
    type PresetScope,
} from "./storage/settingsViews.svelte";
import type { character, Chat, DeepReadonly } from "./storage/database.svelte";
import type { OpenAIChat } from "./process/index.svelte";
import { supportsInlayImage } from "./process/files/inlays";
import { risuChatParser } from "./parser/parser.svelte";
import { getModelInfoForMode, type LLMModel } from "./model/modellist";
import { pluginHooks } from "./plugins/pluginHooks";
import { authFetch } from "./storage/serverAuth";
import { LRUMap } from "mnemonist";
import { tokenizerIdentityKey, type TabTokenScope } from "../../shared/tokenizerChoice.ts";
import { ChatTokenCounter } from "../../shared/prompt/chatTokens.ts";

const MAX_CACHE_SIZE = 1500;
const MAX_BATCH_TEXTS = 256;
const MAX_BATCH_TEXT_BYTES = 1024 * 1024;
const countCache = new LRUMap<string, number>(MAX_CACHE_SIZE);
const textEncoder = new TextEncoder();

type PendingCount = {
    text: string;
    cacheKey: string;
    resolve: (count: number) => void;
    reject: (error: unknown) => void;
};

type PendingBatch = { scope: TabTokenScope; entries: PendingCount[] };
const pendingBatches = new Map<string, PendingBatch>();

/** The main model's tokenizer scope, captured before any request or queued count yields. */
export function tabTokenScope(presetScope?: PresetScope, mainModel?: LLMModel): TabTokenScope {
    const model = mainModel ?? getModelInfoForMode("model", presetScope);
    const aiModel =
        ((presetScope ? scopedPresetRoot(presetScope, "aiModel") : readSettingsRoot("aiModel")) as
            string | undefined) ?? "";
    const currentPluginProvider =
        ((presetScope
            ? scopedPresetRoot(presetScope, "currentPluginProvider")
            : activeMainProfile.currentPluginProvider) as string | undefined) ?? "";
    const customTokenizer =
        ((presetScope ? scopedPresetRoot(presetScope, "customTokenizer") : activeMainProfile.customTokenizer) as
            string | undefined) ?? "";
    return {
        aiModel,
        currentPluginProvider,
        modelTokenizer: model.tokenizer,
        ...(model.internalID !== undefined ? { modelInternalID: model.internalID } : {}),
        pluginTokenizer: pluginHooks.providerOptions.get(currentPluginProvider)?.tokenizer ?? "none",
        customTokenizer,
        googleClaudeTokenizing: !!settings.providers.googleClaudeTokenizing,
        useTokenizerCaching: !!settings.providers.useTokenizerCaching,
    };
}

/**
 * The scope a server job counts with (`tokenScopeFor` in `server/src/llm/settings.ts`): the tab's,
 * without the plugin provider's tokenizer, which never counts on the server.
 */
export function jobTokenScope(presetScope?: PresetScope): TabTokenScope {
    return { ...tabTokenScope(presetScope), pluginTokenizer: "none" };
}

export function tokenScopeKey(captured: TabTokenScope = tabTokenScope()): string {
    return tokenizerIdentityKey({
        ...captured,
        model: { tokenizer: captured.modelTokenizer, internalID: captured.modelInternalID },
    });
}

async function requestTokenJson(path: string, payload: unknown, signal?: AbortSignal) {
    let response: Response;
    try {
        response = await authFetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
        });
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason;
        }
        throw new Error(`Token request failed (status unavailable): ${path}`, { cause: error });
    }
    if (!response.ok) {
        throw new Error(`Token request failed (status ${response.status}): ${path}`);
    }
    try {
        return { body: (await response.json()) as unknown, status: response.status };
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason;
        }
        throw new Error(`Malformed token response (status ${response.status}): ${path}`, { cause: error });
    }
}

function isTokenNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function requestTokenCounts(scope: TabTokenScope, texts: string[], signal?: AbortSignal) {
    const { body, status } = await requestTokenJson("/api/tokens/count", { scope, texts }, signal);
    if (
        !body ||
        typeof body !== "object" ||
        !("counts" in body) ||
        !Array.isArray(body.counts) ||
        body.counts.length !== texts.length ||
        !body.counts.every((count) => count === null || isTokenNumber(count))
    ) {
        throw new Error(`Malformed token counts (status ${status})`);
    }
    return body.counts as (number | null)[];
}

/** Each request settles its own entries, including when another chunk fails. */
async function dispatchCounts(scope: TabTokenScope, entries: PendingCount[], signal?: AbortSignal) {
    try {
        const counts = await requestTokenCounts(
            scope,
            entries.map((entry) => entry.text),
            signal,
        );
        entries.forEach((entry, index) => {
            const count = counts[index];
            if (count === null) {
                entry.reject(new Error("The server tokenizer refused the text"));
                return;
            }
            if (scope.useTokenizerCaching) {
                countCache.set(entry.cacheKey, count);
            }
            entry.resolve(count);
        });
    } catch (error) {
        entries.forEach((entry) => entry.reject(error));
    }
}

function flushCounts(key: string, batch: PendingBatch) {
    pendingBatches.delete(key);
    let entries: PendingCount[] = [];
    let bytes = 0;
    for (const entry of batch.entries) {
        // JSON escaping and UTF-8 both affect the wire size. The scope and envelope have
        // the remaining headroom below the server's 2 MiB body limit.
        const textBytes = textEncoder.encode(JSON.stringify(entry.text)).byteLength;
        if (entries.length && (entries.length >= MAX_BATCH_TEXTS || bytes + textBytes > MAX_BATCH_TEXT_BYTES)) {
            void dispatchCounts(batch.scope, entries);
            entries = [];
            bytes = 0;
        }
        entries.push(entry);
        bytes += textBytes;
    }
    if (entries.length) {
        void dispatchCounts(batch.scope, entries);
    }
}

/**
 * Counts with the captured main model's scope. Signal-less calls in one macrotask share batches;
 * a signal owns its request. Only the captured caching flag controls cache reads and writes.
 */
export async function countTokens(text: string, scope?: PresetScope, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) {
        throw signal.reason;
    }
    return countTokensInScope(text, tabTokenScope(scope), signal);
}

/** `countTokens` with an already captured scope (for example `jobTokenScope()`). */
export async function countTokensInScope(text: string, captured: TabTokenScope, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) {
        throw signal.reason;
    }
    const cacheKey = captured.useTokenizerCaching ? JSON.stringify([text, tokenScopeKey(captured)]) : "";
    if (captured.useTokenizerCaching) {
        const cached = countCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
    }
    return new Promise<number>((resolve, reject) => {
        const entry: PendingCount = { text, cacheKey, resolve, reject };
        if (signal) {
            void dispatchCounts(captured, [entry], signal);
            return;
        }
        const key = JSON.stringify(captured);
        let batch = pendingBatches.get(key);
        if (!batch) {
            batch = { scope: captured, entries: [] };
            pendingBatches.set(key, batch);
            const pending = batch;
            setTimeout(() => flushCounts(key, pending), 0);
        }
        batch.entries.push(entry);
    });
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

export async function encodeWithTokenizer(data: string, tokenizerType: string): Promise<number[]> {
    const { body, status } = await requestTokenJson("/api/tokens/encode", { tokenizer: tokenizerType, text: data });
    if (
        !body ||
        typeof body !== "object" ||
        !("ids" in body) ||
        !Array.isArray(body.ids) ||
        !body.ids.every(isTokenNumber)
    ) {
        throw new Error(`Malformed token ids (status ${status})`);
    }
    return body.ids;
}

export async function tokenizerChar(char: character) {
    return countTokens(char.name + "\n" + char.firstMessage + "\n" + char.desc);
}

/** The token count of `data` with the main model of the captured preset scope, or the tab's. */
export async function tokenize(data: string, scope?: PresetScope) {
    return countTokens(data, scope);
}

function expandTokenCountText(text: string, consistantChar?: boolean): string {
    return risuChatParser(text.replace("{{slot}}", ""), {
        tokenizeAccurate: true,
        consistantChar,
    });
}

export type TokenCountInput = { text: string; expanded: string; scope: string } | { text: string; error: unknown };

/** Reads count dependencies synchronously, carrying preparation failures to the delayed count. */
export function tokenCountInput(text: string): TokenCountInput {
    try {
        return { text, expanded: expandTokenCountText(text), scope: tokenScopeKey() };
    } catch (error) {
        return { text, error };
    }
}

export async function tokenizeAccurate(data: string, consistantChar?: boolean, signal?: AbortSignal) {
    return countTokens(expandTokenCountText(data, consistantChar), undefined, signal);
}

/** The shared token arithmetic (`shared/prompt/chatTokens.ts`) with the client's server-backed counts. */
export class ChatTokenizer extends ChatTokenCounter {
    constructor(chatAdditionalTokens: number, useName: "name" | "noName") {
        super(chatAdditionalTokens, useName, {
            count: (text) => countTokens(text),
            supportsInlayImage,
            mainModel: () => getModelInfoForMode("model"),
            requestModel: () => {
                const model = getModelInfoForMode("model");
                if (model.id === "openrouter") return activeMainProfile.openrouterRequestModel;
                if (model.id === "nanogpt") return activeMainProfile.nanogptRequestModel;
                return undefined;
            },
            gptVisionQuality: () => settings.providers.gptVisionQuality,
        });
    }
}

export async function getCharToken(char?: AnyClientCharacter | null) {
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

    const texts = [char.desc, char.personality ?? "", char.scenario ?? ""];
    for (const lore of char.globalLore) {
        const cont = lore.content
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
        texts.push(cont);
    }

    const counts = await Promise.all(texts.map(basicTokenize));
    const persistant = counts.slice(0, 3).reduce((sum, count) => sum + count, 0);
    const dynamic = counts.slice(3).reduce((sum, count) => sum + count, 0);
    return { persistant, dynamic };
}

/** The tokens of a chat's messages (0 for none: a selected chat that is still loading). */
export async function getChatToken(chat: DeepReadonly<Chat> | null) {
    if (!chat) {
        return 0;
    }

    const chatTokenizer = new ChatTokenizer(0, "name");
    const chatf = chat.message.map((d) => {
        return {
            role: d.role === "user" ? "user" : "assistant",
            content: d.data,
        } as OpenAIChat;
    });
    const counts = await Promise.all(chatf.map((message) => chatTokenizer.tokenizeChat(message)));
    return counts.reduce((sum, count) => sum + count, 0);
}
