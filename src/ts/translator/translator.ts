import { getModelInfoForMode } from "../model/modellist";
import { type AnyClientCharacter, selectedCharacter } from "../storage/characterStore.svelte";
import {
    settings,
    activePersona,
    activePreset,
    activeModelPreset,
    readPresetFieldOf,
} from "../storage/settingsViews.svelte";
import type { ChatContextIds } from "../storage/chatBinding.svelte";
import { get } from "svelte/store";
import { type character, type customscript, type groupChat } from "../storage/database.svelte";
import type { TranslatorPreset } from "./presets";
import { currentTranslatorPreset, globalTranslatorPreset } from "./chatTranslation.svelte";
import type { TranslatorStep } from "../../../shared/settings.ts";
import {
    runTranslatorPipeline,
    stripTranslatorReasoning,
    translateProtectingLines,
    translatorPipelineSignature,
} from "../../../shared/translation/pipeline.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { globalFetch } from "../globalApi.svelte";
import { alertError } from "../alert";
import { requestChatData } from "../process/request/request";
import { anyLocalSend } from "../process/localSends";
import { applyMarkdownToNode, risuChatParser, type simpleCharacterArgument } from "../parser/parser.svelte";
import { getModuleRegexScripts } from "../process/modules";
import { getNodetextToSentence, sleep } from "../util";
import { type CapturedTransform, captureTransform, serverProcessScript } from "../parser/transformClient";
import { markTransient } from "../parser/renderErrors";
import localforage from "localforage";
import sendSound from "../../etc/send.mp3";

/**
 * Tab translation adapters: composer input uses `translate`, which owns the non-LLM pair cache
 * (`src/lib/ChatScreens/DefaultChatScreen.svelte` wires it to input translation). TTS (`translateVox`)
 * and the playground call `runTranslator` directly, bypassing that pair cache and shared producers.
 * The LLM adapter owns a separate context-keyed browser cache; stored message translations belong to
 * `src/ts/translator/storedTranslation.svelte.ts` and `server/src/translation/runner.ts`.
 * Rendered translation keeps its captured request/transform context across awaits; request
 * adaptation lives in `src/ts/process/request/request.ts`, prompt execution in
 * `shared/translation/pipeline.ts`.
 */

/**
 * The non-LLM translators' in-memory translations: a source and its translation, found from either side
 * (`translate`'s `reverse`). A message translated while it streams adds its growing last paragraph on
 * every frame, so the least recently used pairs across contexts leave once the strings plus a fixed overhead for
 * each pair's Set and two Map entries pass `MEMORY_CACHE_CHARS` (UTF-16 code units).
 */
type MemoryCacheEntry = { context: string; origin: string; trans: string };
const MEMORY_CACHE_CHARS = 4_000_000;
const MEMORY_CACHE_ENTRY_OVERHEAD = 64;
/** Every pair, least recently used first. */
const memoryCacheEntries = new Set<MemoryCacheEntry>();
const memoryCacheByOrigin = new Map<string, MemoryCacheEntry>();
const memoryCacheByTrans = new Map<string, MemoryCacheEntry>();
let memoryCacheChars = 0;

function readMemoryCache(context: string, text: string, reverse: boolean): string | undefined {
    const entry = (reverse ? memoryCacheByTrans : memoryCacheByOrigin).get(context + text);
    if (!entry) {
        return undefined;
    }
    memoryCacheEntries.delete(entry);
    memoryCacheEntries.add(entry);
    return reverse ? entry.origin : entry.trans;
}

function dropMemoryCacheEntry(entry: MemoryCacheEntry): void {
    memoryCacheEntries.delete(entry);
    if (memoryCacheByOrigin.get(entry.context + entry.origin) === entry) {
        memoryCacheByOrigin.delete(entry.context + entry.origin);
    }
    if (memoryCacheByTrans.get(entry.context + entry.trans) === entry) {
        memoryCacheByTrans.delete(entry.context + entry.trans);
    }
    memoryCacheChars -= entry.origin.length + entry.trans.length + MEMORY_CACHE_ENTRY_OVERHEAD;
}

/** Adds a pair, replacing one with the same origin: each origin maps to one pair, each translation to its newest. */
function writeMemoryCache(context: string, origin: string, trans: string): void {
    const byOrigin = memoryCacheByOrigin.get(context + origin);
    if (byOrigin) {
        dropMemoryCacheEntry(byOrigin);
    }
    const entry = { context, origin, trans };
    memoryCacheEntries.add(entry);
    memoryCacheByOrigin.set(context + origin, entry);
    memoryCacheByTrans.set(context + trans, entry);
    memoryCacheChars += origin.length + trans.length + MEMORY_CACHE_ENTRY_OVERHEAD;
    for (const oldest of memoryCacheEntries) {
        if (memoryCacheChars <= MEMORY_CACHE_CHARS) {
            break;
        }
        dropMemoryCacheEntry(oldest);
    }
}

/**
 * Browser-local LLM cache, independent of persisted `Message.translation`. Context lookups use
 * full `llm:<hash>:<source>` keys; use `llmTranslationCacheKey` rather than a bare source string.
 */
export const LLMCacheStorage = localforage.createInstance({
    name: "LLMTranslateCache",
});

let waitTrans = 0;

const MAX_TRANSLATION_WORKERS = 10;
let translationWorkers = 0;
const translationWaiters = new Set<() => void>();

function releaseTranslationSlot(): void {
    const next = translationWaiters.values().next().value;
    if (next) next();
    else translationWorkers -= 1;
}

/** FIFO permits for rendered producers; admission is synchronous, and abort only withdraws a queued acquisition. */
function acquireTranslationSlot(onGranted: () => void, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (translationWorkers < MAX_TRANSLATION_WORKERS) {
        translationWorkers += 1;
        onGranted();
        return Promise.resolve(releaseTranslationSlot);
    }
    return new Promise((resolve, reject) => {
        let waiting = true;
        const remove = () => {
            if (!waiting) return false;
            waiting = false;
            translationWaiters.delete(grant);
            signal?.removeEventListener("abort", onAbort);
            return true;
        };
        const grant = () => {
            if (remove()) {
                onGranted();
                resolve(releaseTranslationSlot);
            }
        };
        const onAbort = () => {
            if (remove()) reject(signal!.reason);
        };
        translationWaiters.add(grant);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Cache hits and joins take no permit; a new rendered producer holds one until it settles. */
function translateWithSlot(
    text: string,
    reverse: boolean,
    signal?: AbortSignal,
    onFailure?: (error: unknown) => void,
): Promise<string> {
    return translateShared(text, reverse, true, signal, onFailure);
}

/**
 * The translator preset the tab translates with: the selected chat's own, else the global selection
 * (`resolveTranslatorPreset`).
 */
export function getCurrentTranslatorPreset(): TranslatorPreset {
    return currentTranslatorPreset();
}

/** Both directions of the input box share one detached provider configuration and one pair cache. */
function memoryTranslationContext() {
    const from = settings.memoryTranslateMedia.translator;
    const target = getModelInfoForMode("model").id.startsWith("novellist") ? "ja" : "en";
    const provider = {
        translatorType: settings.memoryTranslateMedia.translatorType,
        translatorInputLanguage: settings.memoryTranslateMedia.translatorInputLanguage,
        useExperimentalGoogleTranslator: settings.memoryTranslateMedia.useExperimentalGoogleTranslator,
        noWaitForTranslate: settings.memoryTranslateMedia.noWaitForTranslate,
        deeplOptions: {
            key: settings.secrets.deeplOptions?.key,
            freeApi: settings.secrets.deeplOptions?.freeApi,
        },
        deeplXOptions: {
            url: settings.secrets.deeplXOptions?.url,
            token: settings.secrets.deeplXOptions?.token,
        },
    };
    const key = JSON.stringify([
        from,
        target,
        provider.translatorType,
        provider.translatorInputLanguage,
        provider.useExperimentalGoogleTranslator,
        provider.deeplXOptions.url,
        provider.deeplOptions.freeApi,
    ]);
    return { from, target, key, provider };
}

type TranslationProviderConfig = ReturnType<typeof memoryTranslationContext>["provider"];

type MemoryTranslationFlight = {
    promise: Promise<string>;
    controller: AbortController;
    subscribers: Set<{ onFailure?: (error: unknown) => void }>;
    started: boolean;
};
const memoryInFlight = new Map<string, MemoryTranslationFlight>();

/** Composer calls share the pair cache and producers with renders, but start new work without a permit. */
export async function translate(text: string, reverse: boolean) {
    return translateShared(text, reverse, false);
}

/**
 * Owns the non-LLM pair cache and flights by configuration, direction and exact text. A queued
 * flight leaves when its last caller aborts; admitted producers finish without caller signals.
 * Producer failures notify subscribed callbacks synchronously before releasing the permit, so
 * failed render attempts can withdraw their queued flights before another producer is admitted.
 * Provider configuration is read once per producer; only successful results populate its cache. Direct
 * `runTranslator` calls bypass both maps; LLM calls retain their separate cache and flights.
 */
async function translateShared(
    text: string,
    reverse: boolean,
    rendered: boolean,
    signal?: AbortSignal,
    onFailure?: (error: unknown) => void,
): Promise<string> {
    signal?.throwIfAborted();
    const context = memoryTranslationContext();
    // LLM translations use their own pipeline-aware cache in `translateLLM`.
    const memoryCache = context.provider.translatorType !== "llm";
    if (memoryCache) {
        const cached = readMemoryCache(context.key, text, reverse);
        if (cached !== undefined) {
            return cached;
        }
    }

    const key = JSON.stringify([context.key, reverse, text]);
    let flight = memoryCache ? memoryInFlight.get(key) : undefined;
    if (!flight) {
        let resolve: (value: string) => void;
        let reject: (error: unknown) => void;
        const created: MemoryTranslationFlight = {
            promise: new Promise<string>((res, rej) => {
                resolve = res;
                reject = rej;
            }),
            controller: new AbortController(),
            subscribers: new Set(),
            started: !rendered,
        };
        // Register before admission so callers can also join while all permits are occupied.
        if (memoryCache) memoryInFlight.set(key, created);
        const produce = async () => {
            let release: (() => void) | undefined;
            try {
                if (rendered) {
                    release = await acquireTranslationSlot(() => {
                        created.started = true;
                    }, created.controller.signal);
                    const cached = memoryCache ? readMemoryCache(context.key, text, reverse) : undefined;
                    if (cached !== undefined) return cached;
                }
                const failure = { failed: false };
                const result = await runTranslator(text, reverse, context.from, context.target, {
                    failure,
                    provider: context.provider,
                });
                // The cache key and every chunk's result come from the same provider snapshot.
                if (memoryCache && !failure.failed) {
                    writeMemoryCache(context.key, reverse ? result : text, reverse ? text : result);
                }
                return result;
            } catch (error) {
                for (const subscriber of created.subscribers) subscriber.onFailure?.(error);
                throw error;
            } finally {
                if (memoryInFlight.get(key) === created) memoryInFlight.delete(key);
                release?.();
            }
        };
        void produce().then(resolve, reject);
        flight = created;
    }
    const shared = flight;
    const subscriber = { onFailure };
    shared.subscribers.add(subscriber);
    return new Promise((resolve, reject) => {
        let subscribed = true;
        const leave = () => {
            if (!subscribed) return false;
            subscribed = false;
            signal?.removeEventListener("abort", onAbort);
            shared.subscribers.delete(subscriber);
            return true;
        };
        const onAbort = () => {
            if (!leave()) return;
            if (!shared.started && shared.subscribers.size === 0) {
                if (memoryInFlight.get(key) === shared) memoryInFlight.delete(key);
                shared.controller.abort();
            }
            reject(signal!.reason);
        };
        shared.promise.then(
            (value) => {
                if (leave()) resolve(value);
            },
            (error) => {
                if (leave()) reject(error);
            },
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

/**
 * Provider configuration is read once per call, unless the caller supplies its producer's snapshot.
 * Captures one detached preset and prompt/model/persona request ids for all chunks, so switching
 * chats or deleting a preset during the run cannot change their preset or request identity.
 * Send Text As-Is bypasses `shared/translation/pipeline.ts`'s line protection; its pipeline result
 * is returned without further processing (the pipeline still strips reasoning from step outputs).
 * Otherwise Exclude Chain-of-Thought strips the whole source once before cutting: prepared chunks
 * must not be stripped again (the strip is not idempotent), and use distinct cache keys. A reported
 * failure in those chunks restores the original whole input, including its reasoning blocks.
 * `exarg.signal` reaches provider requests and LLM steps; an observed abort rejects without a
 * translator alert. As-Is can still resolve if aborted during the final cache write. DeepLX's
 * reserved-slot wait checks the signal again before dispatch.
 */
export async function runTranslator(
    text: string,
    reverse: boolean,
    from: string,
    target: string,
    /** `globalPreset`: translate with the global translator preset, not the selected chat's (the playground). */
    exarg?: {
        translatorNote?: string;
        globalPreset?: boolean;
        failure?: { failed: boolean };
        signal?: AbortSignal;
        provider?: TranslationProviderConfig;
    },
) {
    exarg?.signal?.throwIfAborted();
    const provider = exarg?.provider ?? memoryTranslationContext().provider;
    const arg = {
        from: reverse ? from : target,

        to: reverse ? target : from,

        host: "translate.googleapis.com",

        translatorNote: exarg?.translatorNote,
        signal: exarg?.signal,
        provider,

        // The LLM translator's preset, read once for every chunk of this call: a plain copy, since the
        // record view resolves by id on each read and throws once the preset is deleted meanwhile.
        preset: JSON.parse(
            JSON.stringify(exarg?.globalPreset ? globalTranslatorPreset() : getCurrentTranslatorPreset()),
        ) as TranslatorPreset,
        // The LLM requests' ids, read once too, so a chat switch between chunks moves none of them.
        requestIds: chatlessRequestIds(),
    };
    // Send Text As-Is: the LLM translator takes the whole text in one pipeline run and its reply is
    // returned as it is (a failure already alerted and returned the text).
    const llm = provider.translatorType === "llm";
    if (llm && arg.preset.sendTextAsIs === true) {
        return await translateMain(text, arg);
    }
    // Exclude Chain-of-Thought: the reasoning blocks leave the whole text before it is cut
    // into lines (a block may span several), and the chunks go out as prepared, not stripped again.
    // A chunk's failure (alerted by `translateLLM`) returns the text as it was given, not the
    // stripped text.
    const excludeThoughts = llm && arg.preset.excludeThoughts === true;
    const source = excludeThoughts ? stripTranslatorReasoning(text) : text;
    const failure = exarg?.failure ?? { failed: false };
    const chunkArg = excludeThoughts ? { ...arg, inputPrepared: true, failure } : arg;
    // The server's rule (`translateProtectingLines`): the lines between two protected lines go out as
    // one chunk joined with `\n`. A failure stops at the chunk that failed.
    const stopped = Symbol("stopped");
    try {
        return await translateProtectingLines(source, async (chunk) => {
            const result = await translateMain(chunk, chunkArg);
            arg.signal?.throwIfAborted();
            if (failure.failed) {
                throw stopped;
            }
            if (result.startsWith("ERR::")) {
                failure.failed = true;
                alertError(result);
                throw stopped;
            }
            return result;
        });
    } catch (error) {
        if (error === stopped) {
            return text;
        }
        throw error;
    }
}

/**
 * DeepLX's wait is shared by all tab callers: unless no-wait is enabled, each request reserves the
 * next three-second slot before awaiting, so concurrent calls cannot choose the same slot.
 */
async function translateMain(
    text: string,
    arg: {
        from: string;
        to: string;
        host: string;
        translatorNote?: string;
        signal?: AbortSignal;
        preset: TranslatorPreset;
        requestIds: ChatContextIds;
        provider: TranslationProviderConfig;
        /** The text is already stripped of its reasoning blocks (`runTranslator`'s chunks). */
        inputPrepared?: boolean;
        /** Set when the LLM translator failed (it alerted and returned the text). */
        failure?: { failed: boolean };
    },
) {
    arg.signal?.throwIfAborted();
    const { provider } = arg;
    if (provider.translatorType === "llm") {
        const tr = arg.to || "en";
        return translateLLM(
            text,
            llmTranslationContext({
                to: tr,
                from: arg.from,
                translatorNote: arg.translatorNote,
                preset: arg.preset,
                requestIds: arg.requestIds,
                inputPrepared: arg.inputPrepared,
            }),
            false,
            arg.failure,
            arg.signal,
        );
    }
    if (provider.translatorType === "deepl") {
        const body = {
            text: [text],
            target_lang: arg.to.toLocaleUpperCase(),
        };
        let url = provider.deeplOptions.freeApi
            ? "https://api-free.deepl.com/v2/translate"
            : "https://api.deepl.com/v2/translate";
        const f = await globalFetch(url, {
            abortSignal: arg.signal,
            headers: {
                Authorization: "DeepL-Auth-Key " + provider.deeplOptions.key,
                "Content-Type": "application/json",
            },
            body: body,
        });

        if (!f.ok) {
            return "ERR::DeepL API Error" + (await f.data);
        }
        return f.data.translations[0].text;
    }
    if (provider.translatorType === "deeplX") {
        if (!provider.noWaitForTranslate) {
            // Each request takes the next free slot, 3 s after the one before it.
            const now = Date.now();
            const slot = Math.max(now, waitTrans);
            waitTrans = slot + 3000;
            if (slot > now) {
                await sleep(slot - now);
            }
        }
        arg.signal?.throwIfAborted();

        let url = provider.deeplXOptions.url ?? "http://localhost:1188";

        if (url.endsWith("/")) {
            url = url.slice(0, -1);
        }

        if (!url.endsWith("/translate")) {
            url += "/translate";
        }

        let headers = { "Content-Type": "application/json" };

        const body = { text: text, target_lang: arg.to.toLocaleUpperCase(), source_lang: arg.from.toLocaleUpperCase() };

        if (provider.deeplXOptions.token.trim() !== "") {
            headers["Authorization"] = "Bearer " + provider.deeplXOptions.token;
        }

        //Since the DeepLX API is non-CORS restricted, we can use the plain fetch function
        const f = await globalFetch(url, {
            abortSignal: arg.signal,
            method: "POST",
            headers: headers,
            body: body,
            plainFetchForce: true,
        });

        if (!f.ok) {
            return "ERR::DeepLX API Error" + (await f.data);
        }

        return f.data.data;
    }
    if (provider.useExperimentalGoogleTranslator) {
        try {
            const ua = navigator.userAgent;
            const d = await globalFetch(
                `https://translate.google.com/m?tl=${arg.to}&sl=${arg.from}&q=${encodeURIComponent(text)}`,
                {
                    abortSignal: arg.signal,
                    headers: {
                        "User-Agent": ua,
                        Accept: "*/*",
                    },
                    method: "GET",
                    rawResponse: true,
                },
            );
            arg.signal?.throwIfAborted();
            if (!d.ok) {
                throw markTransient(new Error(`Google Translate returned HTTP ${d.status}`), arg.signal);
            }
            const parser = new DOMParser();
            const dom = parser.parseFromString(new TextDecoder().decode(d.data), "text/html");
            const result = dom.querySelector(".result-container")?.textContent?.trim();
            if (result) {
                return result;
            }
        } catch (error) {
            arg.signal?.throwIfAborted();
        }
    }

    const url =
        `https://${arg.host}/translate_a/single?client=gtx&dt=t&sl=${provider.translatorInputLanguage}&tl=${arg.to}&q=` +
        encodeURIComponent(text);

    let f: Response;
    try {
        f = await fetch(url, {
            signal: arg.signal,
            method: "GET",
        });
    } catch (error) {
        throw markTransient(error, arg.signal);
    }

    arg.signal?.throwIfAborted();
    if (!f.ok) {
        throw markTransient(new Error(`Google Translate returned HTTP ${f.status}`), arg.signal);
    }
    let res: unknown;
    try {
        res = await f.json();
    } catch (error) {
        throw markTransient(error, arg.signal);
    }
    arg.signal?.throwIfAborted();
    const translations: string[] =
        Array.isArray(res) && Array.isArray(res[0])
            ? res[0].flatMap((segment: unknown) =>
                  Array.isArray(segment) && typeof segment[0] === "string" ? [segment[0]] : [],
              )
            : [];
    // Blank input never reaches this adapter: `translateProtectingLines` keeps it locally.
    if (translations.length === 0) {
        throw markTransient(new Error("Google Translate returned an unexpected response"), arg.signal);
    }

    const result = translations
        .join("")
        .replace(/\* ([^*]+)\*/g, "*$1*")
        .replace(/\*([^*]+) \*/g, "*$1*");
    return result;
}

/** TTS's English-to-Japanese adapter; bypasses the pair cache and forwards cancellation to `runTranslator`. */
export async function translateVox(text: string, signal?: AbortSignal) {
    return jaTrans(text, signal);
}

async function jaTrans(text: string, signal?: AbortSignal) {
    return await runTranslator(text, true, "en", "ja", { signal });
}

/**
 * Provider gate for `translateHTML` while a local send is active, and for composer input translation
 * in `src/ts/process/inputTranslation.svelte.ts`, wired by `src/lib/ChatScreens/DefaultChatScreen.svelte`.
 */
export function isExpTranslator() {
    return (
        settings.memoryTranslateMedia.translatorType === "llm" ||
        settings.memoryTranslateMedia.translatorType === "deepl" ||
        settings.memoryTranslateMedia.translatorType === "deeplX"
    );
}

/**
 * Rendered-path entrypoint for `src/lib/ChatScreens/ChatBody.svelte`; captures the transform and
 * LLM context before awaiting, sharing the latter between the active-send cache probe and the run.
 * The non-LLM traversal skips script/style elements and `translate=no` subtrees it visits. With
 * combineTranslation, paragraphs with a blacklisted or `translate=no` descendant at any depth take
 * the per-node path. Other eligible paragraphs are flattened by `getNodetextToSentence` in
 * `src/ts/util.ts`, and their inline markup can be replaced. The LLM path has no DOM skip traversal.
 * During a local send, DeepL/DeepLX return the input unchanged. LLM needs a cache hit to proceed,
 * but `regenerate` still issues a request after a hit; a miss returns the input.
 * DOM jobs must all be collected before dispatch, so traversal cannot await an unflushed batch.
 * DeepLX keeps nodes intact in sequential `■` batches with a 5,000-character target (one oversized
 * node may exceed it), flushes the final partial batch, and retries jobs individually if the reply's
 * separator count disagrees. Cache hits and joins take no permit. New chunk producers share
 * `MAX_TRANSLATION_WORKERS` slots (10), including each DeepLX batch and fallback call. Flights are
 * joinable by configuration, direction and exact text, even while queued; the last caller leaving
 * withdraws a queued flight. Admitted producers keep their permit until settlement and warm the
 * pair cache even after all callers leave. Each signal aborts only its caller's await. On a worker
 * attempt's first failure, its workers take no new job or chunk and its subscriptions leave before
 * the failed producer releases its permit; queued flights with no remaining caller are withdrawn.
 * The attempt rejects with that same error, and a retry can join admitted producers or read their cache.
 * Both DOM dispatch modes share result application: combined paragraph jobs may rerun editdisplay
 * through `src/ts/parser/transformClient.ts`, then Markdown, before the final edittrans pass. The
 * LLM path goes straight to edittrans. A missing transform skips the server display-script stage.
 * The signal also reaches each job's display-script step and is checked before serialization.
 * Ordinary LLM calls share an in-flight request by cache key; each caller aborts its own await, and
 * only the last departure aborts the shared controller and removes the joinable entry. Regeneration
 * neither joins nor can be joined. Producers claim a per-key generation at regeneration or an ordinary
 * cache miss; a newer producer fences older writes even if it fails. Cache hits claim none, and generation state
 * is released when the key has no outstanding producers. Other LLM callers and editor writes are unchanged.
 */
export async function translateHTML(
    html: string,
    reverse: boolean,
    charArg: simpleCharacterArgument | string = "",
    chatID: number,
    regenerate = false,
    /**
     * A render's previously captured transform (`ChatBody`); null skips the script stage for lack of context.
     */
    capturedTransform?: CapturedTransform | null,
    signal?: AbortSignal,
): Promise<string> {
    signal?.throwIfAborted();
    if (!html) {
        return html;
    }
    // The server transform's context: the caller's, or captured before the first await.
    const transform = capturedTransform === undefined ? captureTransform(chatID) : capturedTransform;
    let alwaysExistChar: AnyClientCharacter | simpleCharacterArgument;
    if (charArg !== "") {
        if (typeof charArg === "string") {
            alwaysExistChar = selectedCharacter();
        } else {
            alwaysExistChar = charArg;
        }
    } else {
        alwaysExistChar = {
            type: "simple",
            customscript: [],
            emotionImages: [],
            chaId: "simple",
        };
    }
    // The LLM translator's context, read once: the cached-only check while generating and the
    // translation read the same cache entry.
    const llmContext = settings.memoryTranslateMedia.translatorType === "llm" ? llmTranslationContext() : null;
    let cached: string | null = null;
    if (get(anyLocalSend) && isExpTranslator()) {
        signal?.throwIfAborted();
        cached = llmContext ? await readLLMCacheEntry(llmCacheKeyPrefix(llmContext) + html) : null;
        signal?.throwIfAborted();
        if (cached === null) {
            return html;
        }
    }
    if (llmContext) {
        signal?.throwIfAborted();
        const r =
            cached !== null && !regenerate ? cached : await translateRenderedLLM(html, llmContext, regenerate, signal);
        signal?.throwIfAborted();
        if (settings.memoryTranslateMedia.playMessageOnTranslateEnd) {
            const audio = new Audio(sendSound);
            audio.play().catch(() => {});
        }

        return applyEdittransRegex(r, charArg, alwaysExistChar, chatID, transform);
    }
    const dom = new DOMParser().parseFromString(html, "text/html");

    const jobs: { node: Node; text: string; reprocessDisplayScript: boolean }[] = [];

    function collectNodeText(node: Node, reprocessDisplayScript = false) {
        const text = node.textContent || "";
        if (text.trim().length !== 0) {
            jobs.push({ node, text, reprocessDisplayScript });
        }
    }

    // Collect the entire DOM before dispatching: no traversal can wait on an unflushed batch.
    function collectNode(node: Node, parent?: Node): void {
        if (node.nodeType === Node.TEXT_NODE) {
            // Translate the text content of the node
            if (node.textContent && parent) {
                const parentName = parent.nodeName.toLowerCase();
                if (parentName === "script" || parentName === "style") {
                    return;
                }
                collectNodeText(node);
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Translate child nodes
            //skip if it's a script or style tag
            if (node.nodeName.toLowerCase() === "script" || node.nodeName.toLowerCase() === "style") {
                return;
            }
            // combineTranslation feature
            if (
                settings.memoryTranslateMedia.combineTranslation &&
                node.nodeName.toLowerCase() === "p" &&
                node instanceof HTMLElement
            ) {
                const blacklist = ["img", "iframe", "script", "style", "div", "button", "audio", "video"];
                const hasProtectedDescendant = node.querySelector(`${blacklist.join(", ")}, [translate="no"]`) !== null;
                if (!hasProtectedDescendant && (node as Element)?.getAttribute("translate") !== "no") {
                    const text = getNodetextToSentence(node);
                    const sentences = text.split("\n");
                    if (sentences.length > 1) {
                        // Multiple sentences seperated by <br> tags
                        // reconstruct the p tag
                        node.innerHTML = "";
                        for (const sentence of sentences) {
                            const newNode = document.createElement("span");
                            newNode.textContent = sentence;
                            node.appendChild(newNode);
                            collectNodeText(newNode, true);
                            node.appendChild(document.createElement("br"));
                        }
                    } else {
                        // Single sentence
                        node.textContent = sentences[0];
                        collectNodeText(node, true);
                    }
                    return;
                }
            }

            for (const child of Array.from(node.childNodes)) {
                if (node.nodeType === Node.ELEMENT_NODE && (node as Element)?.getAttribute("translate") === "no") {
                    continue;
                }
                collectNode(child, node);
            }
        }
    }

    collectNode(dom.body);

    signal?.throwIfAborted();
    const results: string[] = new Array(jobs.length);
    if (needSuperChunkedTranslate()) {
        // Keep each node intact; an oversized job forms a batch of its own.
        let batch: number[] = [];
        let batchLength = 0;
        async function translateBatch() {
            signal?.throwIfAborted();
            if (batch.length === 0) return;
            // The separator on its own line keeps each node's asset lines protected (`runTranslator`).
            const translated = await translateWithSlot(batch.map((i) => jobs[i].text).join("\n■\n"), reverse, signal);
            const split = translated.split("■");
            if (split.length !== batch.length) {
                // A provider can remove or add separators. Only use the individual results then.
                for (const i of batch) {
                    signal?.throwIfAborted();
                    results[i] = await translateWithSlot(jobs[i].text, reverse, signal);
                }
            } else {
                // `runTranslator` keeps the line breaks around each separator; drop them again.
                batch.forEach((i, index) => {
                    let text = split[index];
                    if (index > 0) text = text.replace(/^\n/, "");
                    if (index < split.length - 1) text = text.replace(/\n$/, "");
                    results[i] = text;
                });
            }
            batch = [];
            batchLength = 0;
        }
        for (let i = 0; i < jobs.length; i++) {
            if (batchLength + (batch.length ? 3 : 0) + jobs[i].text.length > 5000) {
                await translateBatch();
            }
            batchLength += (batch.length ? 3 : 0) + jobs[i].text.length;
            batch.push(i);
        }
        await translateBatch();
    } else {
        const attempt = new AbortController();
        const abortAttempt = (error: unknown) => attempt.abort(error);
        const onAbort = () => abortAttempt(signal!.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        let nextJob = 0;
        async function translateJobs() {
            try {
                while (nextJob < jobs.length) {
                    attempt.signal.throwIfAborted();
                    const i = nextJob++;
                    const chunks: string[] = [];
                    for (const chunk of jobs[i].text.split(/\n\n+/g)) {
                        attempt.signal.throwIfAborted();
                        chunks.push(await translateWithSlot(chunk, reverse, attempt.signal, abortAttempt));
                    }
                    results[i] = chunks.join("\n\n");
                }
            } catch (error) {
                abortAttempt(error);
                throw attempt.signal.reason;
            }
        }
        try {
            await Promise.all(
                Array.from({ length: Math.min(MAX_TRANSLATION_WORKERS, jobs.length) }, () => translateJobs()),
            );
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }

    // Every provider uses the same display-script and Markdown application path.
    for (let i = 0; i < jobs.length; i++) {
        signal?.throwIfAborted();
        const { node, reprocessDisplayScript } = jobs[i];
        const translated = results[i];
        if (!reprocessDisplayScript) {
            node.textContent = translated;
            continue;
        }
        const { data: processedTranslated } = transform
            ? await serverProcessScript(
                  alwaysExistChar,
                  translated,
                  "editdisplay",
                  chatID,
                  {},
                  transform,
                  "translation",
                  signal,
              )
            : { data: translated };
        signal?.throwIfAborted();
        if (translated === processedTranslated) {
            node.textContent = processedTranslated;
            applyMarkdownToNode(node);
        } else {
            const newNode = document.createElement(node.nodeType === Node.TEXT_NODE ? "span" : node.nodeName);
            // Preserve the HTML produced by the editdisplay script.
            newNode.innerHTML = processedTranslated;
            node.parentNode.replaceChild(newNode, node);
            applyMarkdownToNode(newNode);
        }
    }
    // Serialize the DOM back to HTML
    signal?.throwIfAborted();
    const serializer = new XMLSerializer();
    let translatedHTML = serializer.serializeToString(dom);
    // Remove the outer <html|body|head> tags
    translatedHTML = translatedHTML.replace(/<\/?(html|body|head)[^>]*>/g, "");

    translatedHTML = applyEdittransRegex(translatedHTML, charArg, alwaysExistChar, chatID, transform);

    // console.log(html)
    // console.log(translatedHTML)
    // Return the translated HTML, excluding the outer <body> tags if needed
    return translatedHTML;
}

function needSuperChunkedTranslate() {
    return settings.memoryTranslateMedia.translatorType === "deeplX";
}

/** What an LLM translation depends on besides its source text: read once, detached, before any await. */
interface LLMTranslationContext {
    steps: TranslatorStep[];
    /** The preset's Send Text As-Is: no `<risu-style>` placeholders, the reply kept as it is. */
    sendTextAsIs: boolean;
    /** The preset's Exclude Chain-of-Thought: part of the cache key. */
    excludeThoughts: boolean;
    /** Whether `translateLLM` strips the reasoning blocks of its text (on, unless the caller did). */
    stripInput: boolean;
    to: string;
    from: string;
    translatorNote: string;
    /**
     * The presets and persona every step's request runs with (`requestIds`), as a request without a
     * chat would read them now, so a selection change during the run does not move the later steps.
     */
    requestIds: ChatContextIds;
}

function resolveTranslatorNote(explicit: string | undefined): string {
    if (explicit) {
        return explicit;
    }
    const currentChar = selectedCharacter();
    return currentChar?.type === "character" ? (currentChar.translatorNote ?? "") : "";
}

/**
 * The preset's steps (`arg.preset`, else the selected chat's preset or the global one; a plain copy:
 * an edit or a conflict reload during the requests changes neither the run nor its cache key) and the
 * languages and translator note, each from `arg` when it names one and otherwise as `translateHTML`
 * resolves it: the language settings and the selected character's note. The request ids are
 * `arg.requestIds` (a caller's capture for several calls), else the settings views' (the selected
 * chat's bound ids where they exist, else the tab's selection).
 */
function llmTranslationContext(
    arg: {
        to?: string;
        from?: string;
        translatorNote?: string;
        preset?: TranslatorPreset;
        requestIds?: ChatContextIds;
        inputPrepared?: boolean;
    } = {},
): LLMTranslationContext {
    const preset = arg.preset ?? getCurrentTranslatorPreset();
    const excludeThoughts = preset.excludeThoughts === true;
    return {
        steps: JSON.parse(JSON.stringify(preset.steps)) as TranslatorStep[],
        sendTextAsIs: preset.sendTextAsIs === true,
        excludeThoughts,
        stripInput: excludeThoughts && arg.inputPrepared !== true,
        to: arg.to ?? (settings.memoryTranslateMedia.translator || "en"),
        from: arg.from ?? settings.memoryTranslateMedia.translatorInputLanguage,
        translatorNote: resolveTranslatorNote(arg.translatorNote),
        requestIds: arg.requestIds ?? chatlessRequestIds(),
    };
}

/** The ids a request without a chat reads now (`requestIds`): the settings views' presets and persona. */
function chatlessRequestIds(): ChatContextIds {
    return {
        presetId: activePreset.id ?? "",
        modelPresetId: activeModelPreset.id ?? "",
        personaId: activePersona.id ?? "",
    };
}

/**
 * The `LLMTranslateCache` key prefix of a context: a hash of the pipeline signature, the languages,
 * the note, and Send Text As-Is and Exclude Chain-of-Thought each when it is on (so the keys of a
 * preset without them are those from before the two options), plus `inputPrepared` for a text the
 * caller stripped. Captured request ids are not part of this signature.
 * Entries are distinguished by these hashed execution inputs; preset and step ids or names alone
 * do not separate them (`translatorPipelineSignature` in `shared/translation/pipeline.ts`).
 * The key's text is the caller's, before any reasoning strip. Entries from before the pipeline,
 * keyed by the bare source, are never read again.
 */
function llmCacheKeyPrefix(context: LLMTranslationContext): string {
    const signature = JSON.stringify({
        pipeline: translatorPipelineSignature(context.steps),
        to: context.to,
        from: context.from,
        translatorNote: context.translatorNote,
        ...(context.sendTextAsIs ? { sendTextAsIs: true } : {}),
        ...(context.excludeThoughts ? { excludeThoughts: true } : {}),
        // A prepared text (already stripped) is sent as it is, so it never shares an entry with the
        // same raw text, which would be stripped first (the strip is not idempotent).
        ...(context.excludeThoughts && !context.stripInput ? { inputPrepared: true } : {}),
    });
    return `llm:${translationSourceHash(signature)}:`;
}

/**
 * The full `LLMTranslateCache` key of `text` as `translateHTML` translates it now. A caller that
 * reads an entry and writes it back later (the translation editors) keeps this key, so the edit
 * lands on the entry it read even if the preset or languages changed meanwhile.
 */
export function llmTranslationCacheKey(text: string): string {
    return llmCacheKeyPrefix(llmTranslationContext()) + text;
}

/** Reads a full captured cache key; null is a miss, while an empty string is a cached translation. */
export async function readLLMCacheEntry(key: string): Promise<string | null> {
    try {
        return await LLMCacheStorage.getItem<string>(key);
    } catch (error) {
        throw markTransient(error);
    }
}

/** Writes the full key captured by an editor, without resolving the current preset or languages again. */
export async function writeLLMCacheEntry(key: string, value: string): Promise<void> {
    await LLMCacheStorage.setItem(key, value);
}

type LLMFlight = {
    promise: Promise<string>;
    controller: AbortController;
    subscribers: number;
};
const llmInFlight = new Map<string, LLMFlight>();
const llmGenerations = new Map<string, { newest: number; active: number }>();
let nextLLMGeneration = 0;

function translateRenderedLLM(
    text: string,
    context: LLMTranslationContext,
    regenerate: boolean,
    signal?: AbortSignal,
): Promise<string> {
    signal?.throwIfAborted();
    const key = llmCacheKeyPrefix(context) + text;
    const produce = (requestSignal: AbortSignal | undefined) => {
        let generationState: { newest: number; active: number } | undefined;
        const claim = () => {
            const state = llmGenerations.get(key) ?? { newest: 0, active: 0 };
            const generation = ++nextLLMGeneration;
            state.newest = generation;
            state.active += 1;
            llmGenerations.set(key, state);
            generationState = state;
            return () => state.newest === generation;
        };
        return translateLLM(text, context, regenerate, undefined, requestSignal, claim).finally(() => {
            if (generationState && --generationState.active === 0 && llmGenerations.get(key) === generationState) {
                llmGenerations.delete(key);
            }
        });
    };
    if (regenerate) return produce(signal);
    let flight = llmInFlight.get(key);
    if (!flight) {
        const controller = new AbortController();
        const created: LLMFlight = {
            controller,
            subscribers: 0,
            promise: produce(controller.signal).finally(() => {
                if (llmInFlight.get(key) === created) llmInFlight.delete(key);
            }),
        };
        llmInFlight.set(key, created);
        // The last subscriber may leave before the abandoned request rejects.
        void created.promise.catch(() => {});
        flight = created;
    }
    const shared = flight;
    shared.subscribers += 1;
    return new Promise((resolve, reject) => {
        let subscribed = true;
        const leave = () => {
            if (!subscribed) return false;
            subscribed = false;
            signal?.removeEventListener("abort", onAbort);
            shared.subscribers -= 1;
            return true;
        };
        const onAbort = () => {
            if (!leave()) return;
            if (shared.subscribers === 0) {
                if (llmInFlight.get(key) === shared) llmInFlight.delete(key);
                shared.controller.abort();
            }
            reject(signal!.reason);
        };
        shared.promise.then(
            (value) => {
                if (leave()) resolve(value);
            },
            (error) => {
                if (leave()) reject(error);
            },
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

/**
 * Uses the detached context captured before the caller's first await. Cache lookup precedes input
 * reasoning removal, which precedes style placeholders; blank stripped input caches "" without a
 * request. Send Text As-Is bypasses placeholders. Otherwise each `<risu-style>…</risu-style>` regex
 * match becomes an indexed `<style-data>` placeholder; `(.+?)` can span an empty block into the next.
 * Reply placeholders are replaced with captured inner text only; the matched outer wrapper is not restored.
 * Steps use `src/ts/process/request/request.ts` in translate mode: explicit profiles use profileId,
 * inherited steps the translate slot, all with the captured request ids. A step failure alerts,
 * marks `failure` and returns the caller's original text. An observed abort rejects without that
 * alert; the final cache write has no subsequent signal check, so an abort during it can still resolve.
 * Rendered producers optionally claim publication after a cache miss (regeneration immediately),
 * then check that generation synchronously before either cache write.
 */
async function translateLLM(
    text: string,
    context: LLMTranslationContext,
    regenerate = false,
    /** Set to failed when a step fails (the alert is shown and the text returned). */
    failure?: { failed: boolean },
    signal?: AbortSignal,
    claim?: () => () => boolean,
): Promise<string> {
    signal?.throwIfAborted();
    const cacheKey = llmCacheKeyPrefix(context) + text;
    if (!regenerate) {
        const cacheMatch = await readLLMCacheEntry(cacheKey);
        signal?.throwIfAborted();
        if (cacheMatch !== null) {
            return cacheMatch;
        }
    }
    const isNewest = claim?.();
    // Exclude Chain-of-Thought: the reasoning blocks leave the text before anything else;
    // a text left blank is an empty translation, cached without a request. A failure below still
    // returns the text as it was given.
    const requestText = context.stripInput ? stripTranslatorReasoning(text) : text;
    if (context.stripInput && requestText.trim() === "") {
        if (!isNewest || isNewest()) await writeLLMCacheEntry(cacheKey, "");
        return "";
    }
    // Without Send Text As-Is, each regex match becomes an indexed placeholder; reply substitutions
    // restore the captured inner text without the matched outer `<risu-style>` wrapper.
    const styleDecodeRegex = /\<risu-style\>(.+?)\<\/risu-style\>/gms;
    let styleDecodes: string[] = [];
    const sourceText = context.sendTextAsIs
        ? requestText
        : requestText.replace(styleDecodeRegex, (match, p1) => {
              styleDecodes.push(p1);
              return `<style-data style-index="${styleDecodes.length - 1}"></style-data>`;
          });

    let output: string;
    try {
        output = await runTranslatorPipeline(
            {
                steps: context.steps,
                sourceText,
                to: context.to,
                from: context.from,
                translatorNote: context.translatorNote,
            },
            async ({ messages, maxResponse, model }) => {
                signal?.throwIfAborted();
                // A step on a profile runs on that profile, an inheriting step on the `translate` slot.
                const rq = await requestChatData(
                    {
                        formated: messages,
                        bias: {},
                        useStreaming: false,
                        noMultiGen: true,
                        maxTokens: maxResponse,
                        requestIds: context.requestIds,
                        ...(model.mode === "profile" ? { profileId: model.profileId } : {}),
                    },
                    "translate",
                    signal,
                );
                signal?.throwIfAborted();
                if (rq.type === "fail") {
                    throw new Error(rq.result);
                }
                if (rq.type === "streaming" || rq.type === "multiline") {
                    throw new Error("Unexpected response type");
                }
                return rq.result;
            },
        );
        signal?.throwIfAborted();
    } catch (error) {
        signal?.throwIfAborted();
        alertError(error instanceof Error ? error.message : String(error));
        if (failure) {
            failure.failed = true;
        }
        return text;
    }
    const result = context.sendTextAsIs
        ? output
        : output
              .replace(/<style-data style-index="(\d+)" ?\/?>/g, (match, p1) => {
                  return styleDecodes[parseInt(p1)] ?? "";
              })
              .replace(/<\/style-data>/g, "");
    if (!isNewest || isNewest()) await writeLLMCacheEntry(cacheKey, result);
    return result;
}

/** The cached translation of `text` as `translateHTML` translates it now (`llmTranslationCacheKey`). */
export async function getLLMCache(text: string): Promise<string | null> {
    return await readLLMCacheEntry(llmTranslationCacheKey(text));
}

/**
 * The cached translations, as `translateHTML` translates now, whose source contains `partialKey`;
 * each `key` is the source text (plugin API v3 `searchTranslationCache`).
 */
export async function searchLLMCache(partialKey: string): Promise<{ key: string; value: string }[]> {
    const prefix = llmCacheKeyPrefix(llmTranslationContext());
    const results: { key: string; value: string }[] = [];
    await LLMCacheStorage.iterate<string, void>((value, key) => {
        if (key.startsWith(prefix) && key.slice(prefix.length).includes(partialKey)) {
            results.push({ key: key.slice(prefix.length), value });
        }
    });
    return results;
}

/** Exports all contexts with their full storage keys, including legacy entries that current lookups ignore. */
export async function exportLLMCacheAsJSON(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await LLMCacheStorage.iterate<string, void>((value, key) => {
        result[key] = value;
    });
    return result;
}

/**
 * Merges full storage keys without clearing other entries or migrating legacy keys. Writes are
 * independent: a failed entry is counted and later entries are still tried. The caller validates data.
 */
export async function importLLMCacheFromJSON(data: Record<string, string>): Promise<{ count: number; failed: number }> {
    let count = 0;
    let failed = 0;
    for (const [key, value] of Object.entries(data)) {
        try {
            await LLMCacheStorage.setItem(key, value);
            count++;
        } catch {
            failed++;
        }
    }
    return { count, failed };
}

/** Clears the browser LLM cache across contexts; stored message translations and the memory pair cache are separate. */
export async function clearLLMCache(): Promise<void> {
    await LLMCacheStorage.clear();
}

interface pEdittransScript {
    script: customscript;
    flag: string;
    order: number;
    actions: string[];
}

/**
 * Applies the `edittrans` scripts to a stored translation before it is rendered, as the
 * `translateBeforeHTMLFormatting` path applies them to its translated text: the character as
 * `translateHTML` resolves it.
 */
export function applyEdittransToStoredTranslation(
    text: string,
    charArg: simpleCharacterArgument | string,
    chatID: number,
    transform: CapturedTransform | null,
): string {
    if (charArg === "") {
        return text;
    }
    const alwaysExistChar = typeof charArg === "string" ? selectedCharacter() : charArg;
    return applyEdittransRegex(text, charArg, alwaysExistChar, chatID, transform);
}

/**
 * Applies the `edittrans` scripts. With `transform` (a render that captured its chat before its
 * awaits), the preset's and the modules' scripts and their CBS are that chat's (its display ids);
 * without one, the selected chat's.
 */
export function applyEdittransRegex(
    text: string,
    charArg: simpleCharacterArgument | string,
    alwaysExistChar: AnyClientCharacter | simpleCharacterArgument,
    chatID = -1,
    transform?: CapturedTransform | null,
): string {
    if (charArg === "") return text;

    const chatRef = transform?.chatRef;
    const presetRegex = transform
        ? ((readPresetFieldOf(transform.context, "presetRegex") as customscript[] | undefined) ?? [])
        : (activePreset.regex ?? []);
    let scripts: customscript[] = [];
    scripts = presetRegex.concat(getModuleRegexScripts(chatRef) ?? []).concat(alwaysExistChar?.customscript ?? []);

    const parsedScripts: pEdittransScript[] = [];
    let orderChanged = false;

    for (const script of scripts) {
        if (script.type !== "edittrans") {
            continue;
        }
        if (!script.in) {
            continue;
        }

        let flag = "g";
        if (script.ableFlag) {
            flag = script.flag || "g";
        }

        let order = 0;
        const actions: string[] = [];

        //parse custom flags, same as processScriptFull
        flag = flag.replace(/<(.+?)>/g, (v: string, p1: string) => {
            const meta = p1.split(",").map((v) => v.trim());
            for (const m of meta) {
                if (m.startsWith("order ")) {
                    order = parseInt(m.substring(6));
                    orderChanged = true;
                } else {
                    actions.push(m);
                }
            }

            return "";
        });

        if (actions.includes("move_top") || actions.includes("move_bottom")) {
            flag = flag.replace("g", ""); //temperary fix
        }

        //remove unsupported flag
        flag = flag.trim().replace(/[^dgimsuvy]/g, "");

        //remove repeated flags
        flag = flag
            .split("")
            .filter((v, i, a) => a.indexOf(v) === i)
            .join("");

        if (flag.length === 0) {
            flag = "u";
        }

        parsedScripts.push({ script, flag, order, actions });
    }

    if (orderChanged) {
        parsedScripts.sort((a, b) => b.order - a.order); //sort by order
    }

    for (const pscript of parsedScripts) {
        try {
            const script = pscript.script;

            let input = script.in;
            if (pscript.actions.includes("cbs")) {
                input = risuChatParser(input, { chatID: chatID, ...(chatRef ? { chatRef } : {}) });
            }

            const reg = new RegExp(input, pscript.flag);
            const outScript = script.out.replaceAll("$n", "\n");

            if (pscript.actions.includes("move_top") || pscript.actions.includes("move_bottom")) {
                const isGlobal = pscript.flag.includes("g");
                const matchAll = isGlobal ? text.matchAll(reg) : [text.match(reg)];
                text = text.replace(reg, "");
                for (const matched of matchAll) {
                    if (matched) {
                        const inData = matched[0];
                        const out = outScript
                            .replace(/(?<!\$)\$[0-9]+/g, (v) => {
                                const index = parseInt(v.substring(1));
                                if (index < matched.length) {
                                    return matched[index];
                                }
                                return v;
                            })
                            .replace(/\$\&/g, inData)
                            //kept identical to processScriptFull, where parseInt on a group name never resolves
                            .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                                const groupName = parseInt(v.substring(2, v.length - 1));
                                if (matched.groups && matched.groups[groupName]) {
                                    return matched.groups[groupName];
                                }
                                return v;
                            });
                        if (pscript.actions.includes("move_top")) {
                            text = out + "\n" + text;
                        } else {
                            text = text + "\n" + out;
                        }
                    }
                }
            } else {
                text = text.replace(reg, outScript);
            }
        } catch (error) {
            console.error(error);
        }
    }
    return text;
}
