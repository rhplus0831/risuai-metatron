import { getModelInfoForMode } from "../model/modellist";
import { type AnyClientCharacter, selectedCharacter } from "../storage/characterStore.svelte";
import { settings, activePreset, readPresetFieldOf } from "../storage/settingsViews.svelte";
import { get } from "svelte/store";
import { type character, type customscript, type groupChat } from "../storage/database.svelte";
import { getCurrentTranslatorPresetFromState, type TranslatorPreset } from "./presets";
import type { TranslatorStep } from "../../../shared/settings.ts";
import { runTranslatorPipeline, translatorPipelineSignature } from "../../../shared/translation/pipeline.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { globalFetch } from "../globalApi.svelte";
import { alertError } from "../alert";
import { requestChatData } from "../process/request/request";
import { doingChat } from "../process/index.svelte";
import { applyMarkdownToNode, risuChatParser, type simpleCharacterArgument } from "../parser/parser.svelte";
import { getModuleRegexScripts } from "../process/modules";
import { getNodetextToSentence, sleep } from "../util";
import { type CapturedTransform, captureTransform, serverProcessScript } from "../parser/transformClient";
import localforage from "localforage";
import sendSound from "../../etc/send.mp3";

let cache = {
    origin: [""],
    trans: [""],
};

let bergamotTranslate: (text: string, from: string, to: string, html?: boolean) => Promise<string> | null = null;

export const LLMCacheStorage = localforage.createInstance({
    name: "LLMTranslateCache",
});

let waitTrans = 0;

export function getCurrentTranslatorPreset(): TranslatorPreset {
    return getCurrentTranslatorPresetFromState({
        translatorPresets: settings.translatorPresets.items,
        translatorPresetId: settings.translatorPresets.selectedId,
    });
}

/**
 * The in-memory cache below is keyed by the text alone, so the LLM translator skips it: its results
 * depend on the preset and are cached by `translateLLM` under the pipeline's key.
 */
function usesMemoryCache(): boolean {
    return settings.memoryTranslateMedia.translatorType !== "llm";
}

export async function translate(text: string, reverse: boolean) {
    if (usesMemoryCache()) {
        const ind = reverse ? cache.trans.indexOf(text) : cache.origin.indexOf(text);
        if (ind !== -1) {
            return reverse ? cache.origin[ind] : cache.trans[ind];
        }
    }

    return runTranslator(
        text,
        reverse,
        settings.memoryTranslateMedia.translator,
        getModelInfoForMode("model").id.startsWith("novellist") ? "ja" : "en",
    );
}

export async function runTranslator(
    text: string,
    reverse: boolean,
    from: string,
    target: string,
    exarg?: { translatorNote?: string },
) {
    // Whether the result may enter the memory cache, decided now: a translator switched meanwhile
    // must not put an LLM result there.
    const memoryCache = usesMemoryCache();
    const arg = {
        from: reverse ? from : target,

        to: reverse ? target : from,

        host: "translate.googleapis.com",

        translatorNote: exarg?.translatorNote,
    };
    const texts = text.split("\n");
    let chunks: [string, boolean][] = [["", true]];

    for (let i = 0; i < texts.length; i++) {
        if (
            texts[i].startsWith("{{img") ||
            texts[i].startsWith("{{raw") ||
            texts[i].startsWith("{{video") ||
            (texts[i].startsWith("{{audio") && texts[i].endsWith("}}")) ||
            texts[i].length === 0
        ) {
            chunks.push([texts[i], false]);
            chunks.push(["", true]);
        } else {
            chunks[chunks.length - 1][0] += texts[i];
        }
    }

    let fullResult: string[] = [];

    for (const chunk of chunks) {
        if (chunk[1]) {
            const trimed = chunk[0].trim();
            if (trimed.length === 0) {
                fullResult.push(chunk[0]);
                continue;
            }
            const result = await translateMain(trimed, arg);

            if (result.startsWith("ERR::")) {
                alertError(result);
                return text;
            }

            fullResult.push(result.trim());
        } else {
            fullResult.push(chunk[0]);
        }
    }

    const result = fullResult.join("\n").trim();

    if (memoryCache && usesMemoryCache()) {
        cache.origin.push(reverse ? result : text);

        cache.trans.push(reverse ? text : result);
    }

    return result;
}

async function translateMain(text: string, arg: { from: string; to: string; host: string; translatorNote?: string }) {
    if (settings.memoryTranslateMedia.translatorType === "llm") {
        const tr = arg.to || "en";
        return translateLLM(
            text,
            llmTranslationContext({ to: tr, from: arg.from, translatorNote: arg.translatorNote }),
        );
    }
    if (settings.memoryTranslateMedia.translatorType === "deepl") {
        const body = {
            text: [text],
            target_lang: arg.to.toLocaleUpperCase(),
        };
        let url = settings.secrets.deeplOptions.freeApi
            ? "https://api-free.deepl.com/v2/translate"
            : "https://api.deepl.com/v2/translate";
        const f = await globalFetch(url, {
            headers: {
                Authorization: "DeepL-Auth-Key " + settings.secrets.deeplOptions.key,
                "Content-Type": "application/json",
            },
            body: body,
        });

        if (!f.ok) {
            return "ERR::DeepL API Error" + (await f.data);
        }
        return f.data.translations[0].text;
    }
    if (settings.memoryTranslateMedia.translatorType === "deeplX") {
        if (!settings.memoryTranslateMedia.noWaitForTranslate) {
            if (waitTrans - Date.now() > 0) {
                const waitTime = waitTrans - Date.now();
                waitTrans = Date.now() + 3000;
                await sleep(waitTime);
            }
        }

        let url = settings.secrets.deeplXOptions.url ?? "http://localhost:1188";

        if (url.endsWith("/")) {
            url = url.slice(0, -1);
        }

        if (!url.endsWith("/translate")) {
            url += "/translate";
        }

        let headers = { "Content-Type": "application/json" };

        const body = { text: text, target_lang: arg.to.toLocaleUpperCase(), source_lang: arg.from.toLocaleUpperCase() };

        if (settings.secrets.deeplXOptions.token.trim() !== "") {
            headers["Authorization"] = "Bearer " + settings.secrets.deeplXOptions.token;
        }

        //Since the DeepLX API is non-CORS restricted, we can use the plain fetch function
        const f = await globalFetch(url, { method: "POST", headers: headers, body: body, plainFetchForce: true });

        if (!f.ok) {
            return "ERR::DeepLX API Error" + (await f.data);
        }

        return f.data.data;
    }
    if (settings.memoryTranslateMedia.translatorType == "bergamot") {
        if (!bergamotTranslate) {
            const bergamotTranslator = await import("./bergamotTranslator");
            bergamotTranslate = bergamotTranslator.bergamotTranslate;
        }

        return bergamotTranslate(text, arg.from, arg.to, false);
    }
    if (settings.memoryTranslateMedia.useExperimentalGoogleTranslator) {
        try {
            const ua = navigator.userAgent;
            const d = await globalFetch(
                `https://translate.google.com/m?tl=${arg.to}&sl=${arg.from}&q=${encodeURIComponent(text)}`,
                {
                    headers: {
                        "User-Agent": ua,
                        Accept: "*/*",
                    },
                    method: "GET",
                },
            );
            const parser = new DOMParser();
            const dom = parser.parseFromString(d.data, "text/html");
            const result = dom.querySelector(".result-container")?.textContent?.trim();
            if (result) {
                return result;
            }
        } catch (error) {}
    }

    const url =
        `https://${arg.host}/translate_a/single?client=gtx&dt=t&sl=${settings.memoryTranslateMedia.translatorInputLanguage}&tl=${arg.to}&q=` +
        encodeURIComponent(text);

    const f = await fetch(url, {
        method: "GET",
    });

    const res = await f.json();

    if (typeof res === "string") {
        return res as unknown as string;
    }

    if (!res[0] || res[0].length === 0) {
        return text;
    }

    const result = (
        res[0]
            .map((s) => s[0])
            .filter(Boolean)
            .join("") as string
    )
        .replace(/\* ([^*]+)\*/g, "*$1*")
        .replace(/\*([^*]+) \*/g, "*$1*");
    return result;
}

export async function translateVox(text: string) {
    return jaTrans(text);
}

async function jaTrans(text: string) {
    return await runTranslator(text, true, "en", "ja");
}

export function isExpTranslator() {
    return (
        settings.memoryTranslateMedia.translatorType === "llm" ||
        settings.memoryTranslateMedia.translatorType === "deepl" ||
        settings.memoryTranslateMedia.translatorType === "deeplX"
    );
}

export async function translateHTML(
    html: string,
    reverse: boolean,
    charArg: simpleCharacterArgument | string = "",
    chatID: number,
    regenerate = false,
    /** A render that captured its transform context earlier (`ChatBody`); null: no context (the script stage is skipped). */
    capturedTransform?: CapturedTransform | null,
): Promise<string> {
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
    if (get(doingChat) && isExpTranslator()) {
        cached = llmContext ? await readLLMCacheEntry(llmCacheKeyPrefix(llmContext) + html) : null;
        if (cached === null) {
            return html;
        }
    }
    if (llmContext) {
        const r = cached !== null && !regenerate ? cached : await translateLLM(html, llmContext, regenerate);
        if (settings.memoryTranslateMedia.playMessageOnTranslateEnd) {
            const audio = new Audio(sendSound);
            audio.play().catch(() => {});
        }

        return applyEdittransRegex(r, charArg, alwaysExistChar, chatID, transform);
    }
    if (settings.memoryTranslateMedia.translatorType == "bergamot" && settings.memoryTranslateMedia.htmlTranslation) {
        const from = getModelInfoForMode("model", transform?.context).id.startsWith("novellist") ? "ja" : "en";
        const to = settings.memoryTranslateMedia.translator || "en";

        if (!bergamotTranslate) {
            const bergamotTranslator = await import("./bergamotTranslator");
            bergamotTranslate = bergamotTranslator.bergamotTranslate;
        }

        return applyEdittransRegex(
            await bergamotTranslate(html, from, to, true),
            charArg,
            alwaysExistChar,
            chatID,
            transform,
        );
    }
    const dom = new DOMParser().parseFromString(html, "text/html");
    console.log(html);

    let promises: Promise<void>[] = [];
    let translationChunks: {
        chunks: string[];
        resolvers: ((text: string) => void)[];
    }[] = [
        {
            chunks: [],
            resolvers: [],
        },
    ];

    async function translateTranslationChunks(force: boolean = false, additionalChunkLength = 0) {
        if (translationChunks.length === 0 || !needSuperChunkedTranslate()) {
            return;
        }

        const currentChunk = translationChunks[translationChunks.length - 1];
        const text: string = currentChunk.chunks.join("\n■\n");

        if (!force && text.length + additionalChunkLength < 5000) {
            return;
        }

        translationChunks.push({
            chunks: [],
            resolvers: [],
        });

        if (!text) {
            return;
        }

        const translated = await translate(text, reverse);

        const split = translated.split("■");

        console.log(split.length, currentChunk.chunks.length);

        if (split.length !== currentChunk.chunks.length) {
            //try translating one by one
            for (let i = 0; i < currentChunk.chunks.length; i++) {
                currentChunk.resolvers[i](await translate(currentChunk.chunks[i], reverse));
            }
        }

        for (let i = 0; i < split.length; i++) {
            console.log(split[i]);
            currentChunk.resolvers[i](split[i]);
        }
    }

    async function translateNodeText(node: Node, reprocessDisplayScript: boolean = false) {
        if (node.textContent.trim().length !== 0) {
            if (needSuperChunkedTranslate()) {
                const prm = new Promise<string>((resolve) => {
                    translateTranslationChunks(false, node.textContent.length);
                    translationChunks[translationChunks.length - 1].resolvers.push(resolve);
                    translationChunks[translationChunks.length - 1].chunks.push(node.textContent);
                });

                node.textContent = await prm;
                return;
            }

            const translateChunks = (node.textContent || "").split(/\n\n+/g);
            let translatedChunksPromises: Promise<string>[] = [];
            for (const chunk of translateChunks) {
                const translatedPromise = translate(chunk, reverse);
                translatedChunksPromises.push(translatedPromise);
            }

            const translatedChunks = await Promise.all(translatedChunksPromises);
            let translated = translatedChunks.join("\n\n");
            if (!reprocessDisplayScript) {
                node.textContent = translated;
                return;
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
                  )
                : { data: translated };
            // If the translation is the same, don't replace the node
            if (translated == processedTranslated) {
                node.textContent = processedTranslated;
                applyMarkdownToNode(node);
                return;
            }

            // Replace the old node with the new one
            const newNode = document.createElement(node.nodeType === Node.TEXT_NODE ? "span" : node.nodeName);
            newNode.innerHTML = processedTranslated;
            node.parentNode.replaceChild(newNode, node);
            applyMarkdownToNode(newNode);
        }
    }

    // Recursive function to translate all text nodes
    async function translateNode(node: Node, parent?: Node): Promise<void> {
        if (node.nodeType === Node.TEXT_NODE) {
            // Translate the text content of the node
            if (node.textContent && parent) {
                const parentName = parent.nodeName.toLowerCase();
                if (parentName === "script" || parentName === "style") {
                    return;
                }
                if (promises.length > 10) {
                    await Promise.all(promises);
                    promises = [];
                }
                promises.push(translateNodeText(node));
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
                const children = Array.from(node.childNodes);
                const blacklist = ["img", "iframe", "script", "style", "div", "button", "audio", "video"];
                const hasBlacklistChild = children.some((child) => blacklist.includes(child.nodeName.toLowerCase()));
                if (!hasBlacklistChild && (node as Element)?.getAttribute("translate") !== "no") {
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
                            await translateNodeText(newNode, true);
                            node.appendChild(document.createElement("br"));
                        }
                    } else {
                        // Single sentence
                        node.innerHTML = sentences[0];
                        await translateNodeText(node, true);
                    }
                    return;
                }
            }

            for (const child of Array.from(node.childNodes)) {
                if (node.nodeType === Node.ELEMENT_NODE && (node as Element)?.getAttribute("translate") === "no") {
                    continue;
                }
                await translateNode(child, node);
            }
        }
    }

    // Start translation from the body element
    await translateNode(dom.body);

    await translateTranslationChunks(true, 0);

    await Promise.all(promises);
    // Serialize the DOM back to HTML
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
    to: string;
    from: string;
    translatorNote: string;
}

function resolveTranslatorNote(explicit: string | undefined): string {
    if (explicit) {
        return explicit;
    }
    const currentChar = selectedCharacter();
    return currentChar?.type === "character" ? (currentChar.translatorNote ?? "") : "";
}

/**
 * The selected preset's steps (a plain copy: an edit or a conflict reload during the requests changes
 * neither the run nor its cache key) and the languages and translator note, each from `arg` when it
 * names one and otherwise as `translateHTML` resolves it: the language settings and the selected
 * character's note.
 */
function llmTranslationContext(
    arg: { to?: string; from?: string; translatorNote?: string } = {},
): LLMTranslationContext {
    return {
        steps: JSON.parse(JSON.stringify(getCurrentTranslatorPreset().steps)) as TranslatorStep[],
        to: arg.to ?? (settings.memoryTranslateMedia.translator || "en"),
        from: arg.from ?? settings.memoryTranslateMedia.translatorInputLanguage,
        translatorNote: resolveTranslatorNote(arg.translatorNote),
    };
}

/**
 * The `LLMTranslateCache` key prefix of a context: a hash of the pipeline signature, the languages,
 * and the note. Another preset, prompt, or language reads and writes other entries; entries from
 * before the pipeline (keyed by the bare source) are never read again.
 */
function llmCacheKeyPrefix(context: LLMTranslationContext): string {
    const signature = JSON.stringify({
        pipeline: translatorPipelineSignature(context.steps),
        to: context.to,
        from: context.from,
        translatorNote: context.translatorNote,
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

export async function readLLMCacheEntry(key: string): Promise<string | null> {
    return await LLMCacheStorage.getItem<string>(key);
}

export async function writeLLMCacheEntry(key: string, value: string): Promise<void> {
    await LLMCacheStorage.setItem(key, value);
}

/** `text` translated by the pipeline of `context` (`llmTranslationContext`, read before the caller's first await). */
async function translateLLM(text: string, context: LLMTranslationContext, regenerate = false): Promise<string> {
    const cacheKey = llmCacheKeyPrefix(context) + text;
    if (!regenerate) {
        const cacheMatch = await readLLMCacheEntry(cacheKey);
        if (cacheMatch !== null) {
            return cacheMatch;
        }
    }
    const styleDecodeRegex = /\<risu-style\>(.+?)\<\/risu-style\>/gms;
    let styleDecodes: string[] = [];
    const sourceText = text.replace(styleDecodeRegex, (match, p1) => {
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
            async ({ messages, maxResponse }) => {
                // Every step runs on the `translate` slot until steps name their model (translation slice 3.1).
                const rq = await requestChatData(
                    {
                        formated: messages,
                        bias: {},
                        useStreaming: false,
                        noMultiGen: true,
                        maxTokens: maxResponse,
                    },
                    "translate",
                );
                if (rq.type === "fail") {
                    throw new Error(rq.result);
                }
                if (rq.type === "streaming" || rq.type === "multiline") {
                    throw new Error("Unexpected response type");
                }
                return rq.result;
            },
        );
    } catch (error) {
        alertError(error instanceof Error ? error.message : String(error));
        return text;
    }
    const result = output
        .replace(/<style-data style-index="(\d+)" ?\/?>/g, (match, p1) => {
            return styleDecodes[parseInt(p1)] ?? "";
        })
        .replace(/<\/style-data>/g, "");
    await writeLLMCacheEntry(cacheKey, result);
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

export async function exportLLMCacheAsJSON(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await LLMCacheStorage.iterate<string, void>((value, key) => {
        result[key] = value;
    });
    return result;
}

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
 * Applies the `edittrans` scripts to a stored translation (`docs/plan/translation.md` slice 1.4)
 * before it is rendered, as the `translateBeforeHTMLFormatting` path applies them to its translated
 * text: the character as `translateHTML` resolves it.
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
