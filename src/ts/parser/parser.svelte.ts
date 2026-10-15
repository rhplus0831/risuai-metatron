import { untrack } from "svelte";
import { type AnyClientCharacter, characterList, selectedCharacter } from "../storage/characterStore.svelte";
import { type ChatRef, currentChatRef, withCompatChats } from "../storage/chatStore.svelte";
import { chatDisplayIds } from "../storage/chatBinding.svelte";
import { isRecordWrapper } from "../storage/records.svelte";
import {
    isForwardedPresetRoot,
    scopedPresetRoot,
    readSettingsRoot,
    settings,
    type SettingsRootKey,
} from "../storage/settingsViews.svelte";
import DOMPurify from "dompurify";
import markdownit from "markdown-it";
import {
    appVer,
    type character,
    type customscript,
    type groupChat,
    type triggerscript,
} from "../storage/database.svelte";
import { CurrentTriggerIdStore } from "../stores.svelte";
import { aiWatermarkingLawApplies, getFileSrc } from "../globalApi.svelte";
import {
    getChatVar,
    getChatVarOf,
    setChatVar,
    setChatVarOf,
    getGlobalChatVar,
    getGlobalChatVarOf,
} from "./chatVar.svelte";
import { type CapturedTransform, captureTransform, serverProcessScript } from "./transformClient";
import { get } from "svelte/store";
import { selectedIndex } from "../storage/selection.svelte";
import css, { type CssAtRuleAST } from "@adobe/css-tools";
import { calcString } from "../process/infunctions";
import { findCharacterbyId, getPersonaPrompt, getUserIcon, getUserName, pickHashRand, replaceAsync } from "../util";
import { PluginTargetGoneError } from "../plugins/apiV3/pluginContext";
import { getInlayMedia, getInlayObjectUrl } from "../process/files/inlays";
import { getModuleAssets, getModuleLorebooks, getModules } from "../process/modules";
import hljs from "highlight.js/lib/core";
import "highlight.js/styles/atom-one-dark.min.css";
import { language } from "src/lang";
import katex from "katex";
import { getModelInfo } from "../model/modellist";
import {
    createCbsEvaluator,
    risuEscape,
    risuUnescape,
    type CbsEvaluator,
    type CbsHost,
    type CbsParseArg,
} from "../../../shared/cbs/evaluator.ts";
import type { CbsConditions, CbsDatabase } from "../../../shared/cbs/types.ts";
import { maxContextOverrideOf } from "../../../shared/sections.ts";
import cssSelectorParser from "postcss-selector-parser";

const markdownItOptions = {
    html: true,
    breaks: true,
    linkify: false,
    typographer: true,
    quotes: "\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}", //placeholder characters to convert to real quotes
};

const md = markdownit(markdownItOptions);
const mdHighlight = markdownit({
    highlight: function (str, lang) {
        if (lang) {
            return `<pre-hljs-placeholder lang="${lang}">` + str + "</pre-hljs-placeholder>";
        }
        return "";
    },
    ...markdownItOptions,
});

md.disable(["code"]);
mdHighlight.disable(["code"]);

DOMPurify.addHook("uponSanitizeElement", (node: HTMLElement, data) => {
    if (data.tagName === "iframe") {
        const src = node.getAttribute("src") || "";
        if (!src.startsWith("https://www.youtube.com/embed/")) {
            return node.parentNode.removeChild(node);
        }
    }
    if (data.tagName === "img") {
        // Hide external images when hideAllImages is enabled
        if (settings.ui.hideAllImages) {
            const src = node.getAttribute("src") || "";
            // Replace with placeholder if it's an external/loaded image
            if (src && !src.startsWith("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP")) {
                node.setAttribute("src", "/none.webp");
                node.setAttribute("alt", "?");
            }
            return;
        }

        const loading = node.getAttribute("loading");
        if (!loading) {
            node.setAttribute("loading", "lazy");
        }
        const decoding = node.getAttribute("decoding");
        if (!decoding) {
            node.setAttribute("decoding", "async");
        }
    }
});

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    switch (data.attrName) {
        case "style": {
            // Remove background-image URLs when hideAllImages is enabled
            if (settings.ui.hideAllImages && data.attrValue) {
                // Remove background-image property from inline styles
                data.attrValue = data.attrValue.replace(/background(-image)?:\s*url\([^)]*\);?/gi, "");
                // Also remove background property if it contains url()
                data.attrValue = data.attrValue.replace(/background:\s*[^;]*url\([^)]*\)[^;]*;?/gi, "");
            }
            break;
        }
        case "class": {
            if (data.attrValue) {
                data.attrValue = data.attrValue
                    .split(" ")
                    .map((v) => {
                        if (v.startsWith("hljs")) {
                            return v;
                        }
                        if (v.startsWith("x-risu-")) {
                            return v;
                        }
                        return "x-risu-" + v;
                    })
                    .join(" ");
            }
            break;
        }
        case "href": {
            if (data.attrValue.startsWith("http://") || data.attrValue.startsWith("https://")) {
                node.setAttribute("target", "_blank");
                break;
            }
            data.attrValue = "";
            break;
        }
    }
});

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    if (["IMG", "SOURCE", "VIDEO", "AUDIO", "STYLE"].includes(node.nodeName) && data.attrName === "src") {
        if (data.attrValue.startsWith("blob:")) {
            data.forceKeepAttr = true;
        }
    }
});

export { risuEscape, risuUnescape };

function renderMarkdown(md: markdownit, data: string) {
    let quotes = ["“", "”", "‘", "’"];
    if (settings.ui.customQuotes) {
        quotes = settings.ui.customQuotesData ?? quotes;
    }
    data = data.replace(/\$\$(.*?)\$\$/gs, (match: string, content: string) => {
        try {
            content = content
                .replace(/\uE9b8/gu, "{")
                .replace(/\uE9b9/gu, "}")
                .replace(/\uE9ba/gu, "(")
                .replace(/\uE9bb/gu, ")");
            const rendered = katex.renderToString(content, {
                displayMode: false,
                throwOnError: true,
                output: "mathml",
            });
            return rendered;
        } catch (error) {
            console.error("KaTeX render error:", error);
            return match;
        }
    });
    let text = risuUnescape(md.render(data.replace(/“|”/g, '"').replace(/‘|’/g, "'")));

    if (settings.ui.unformatQuotes) {
        text = text.replace(/\uE9b0/gu, quotes[0]).replace(/\uE9b1/gu, quotes[1]);
        text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3]);
    } else if (settings.ui.blockquoteStyling) {
        text = text
            .replace(/\uE9b0(.+?)\uE9b1/gmu, (full, content) => {
                content = content
                    .replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2])
                    .replace(/\uE9b3/gu, quotes[3] + "</mark>");
                return `<br><br><mark risu-mark="blockquote2">${quotes[0]}${content}${quotes[1]}</mark><br><br>`;
            })
            .replace(/\uE9b2(.+?)\uE9b3/gmu, (full, content) => {
                return `<br><br><mark risu-mark="blockquote1">${quotes[2]}${content}${quotes[3]}</mark><br><br>`;
            });

        //clean up any unmatched quote marks
        text = text.replace(/\uE9b0/gu, quotes[0]).replace(/\uE9b1/gu, quotes[1]);
        text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3]);
    } else {
        text = text
            .replace(/\uE9b0/gu, '<mark risu-mark="quote2">' + quotes[0])
            .replace(/\uE9b1/gu, quotes[1] + "</mark>");
        text = text
            .replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2])
            .replace(/\uE9b3/gu, quotes[3] + "</mark>");
    }

    return text;
}

async function renderHighlightableMarkdown(data: string) {
    let rendered = renderMarkdown(mdHighlight, data);
    const highlightPlaceholders = rendered.match(/<pre-hljs-placeholder lang="(.+?)">(.+?)<\/pre-hljs-placeholder>/gms);
    if (!highlightPlaceholders) {
        return rendered;
    }

    for (const placeholder of highlightPlaceholders) {
        try {
            let lang = placeholder.match(/lang="(.+?)"/)?.[1];
            const code = placeholder.match(/<pre-hljs-placeholder lang=".+?">(.+?)<\/pre-hljs-placeholder>/ms)?.[1];
            if (!lang || !code) {
                continue;
            }
            //import language if not already loaded
            //we do not refactor this to a function because we want to keep vite to only import the languages that are needed
            let languageModule: typeof import("highlight.js/lib/languages/*") | null = null;
            let fileExt = "";

            switch (lang) {
                case "bash": {
                    fileExt = "sh";
                    lang = "bash";
                    if (!hljs.getLanguage("bash")) {
                        languageModule = await import("highlight.js/lib/languages/bash");
                    }
                    break;
                }
                case "c":
                case "cpp": {
                    fileExt = lang;
                    lang = "cpp";
                    if (!hljs.getLanguage("cpp")) {
                        languageModule = await import("highlight.js/lib/languages/cpp");
                    }
                    break;
                }
                case "cs":
                case "csharp": {
                    fileExt = "cs";
                    lang = "csharp";
                    if (!hljs.getLanguage("csharp")) {
                        languageModule = await import("highlight.js/lib/languages/csharp");
                    }
                    break;
                }
                case "css": {
                    fileExt = "css";
                    lang = "css";
                    if (!hljs.getLanguage("css")) {
                        languageModule = await import("highlight.js/lib/languages/css");
                    }
                    break;
                }
                case "dart": {
                    fileExt = "dart";
                    lang = "dart";
                    if (!hljs.getLanguage("dart")) {
                        languageModule = await import("highlight.js/lib/languages/dart");
                    }
                    break;
                }
                case "html":
                case "svg":
                case "xml": {
                    fileExt = lang;
                    lang = "xml";
                    if (!hljs.getLanguage("xml")) {
                        languageModule = await import("highlight.js/lib/languages/xml");
                    }
                    break;
                }
                case "java": {
                    fileExt = "java";
                    lang = "java";
                    if (!hljs.getLanguage("java")) {
                        languageModule = await import("highlight.js/lib/languages/java");
                    }
                    break;
                }
                case "js":
                case "jsx":
                case "javascript": {
                    fileExt = "js";
                    lang = "javascript";
                    if (!hljs.getLanguage("javascript")) {
                        languageModule = await import("highlight.js/lib/languages/javascript");
                    }
                    break;
                }
                case "json": {
                    fileExt = "json";
                    lang = "json";
                    if (!hljs.getLanguage("json")) {
                        languageModule = await import("highlight.js/lib/languages/json");
                    }
                    break;
                }
                case "lua": {
                    fileExt = "lua";
                    lang = "lua";
                    if (!hljs.getLanguage("lua")) {
                        languageModule = await import("highlight.js/lib/languages/lua");
                    }
                    break;
                }
                case "markdown":
                case "md": {
                    fileExt = "md";
                    lang = "markdown";
                    if (!hljs.getLanguage("markdown")) {
                        languageModule = await import("highlight.js/lib/languages/markdown");
                    }
                    break;
                }
                case "py":
                case "python": {
                    fileExt = "py";
                    lang = "python";
                    if (!hljs.getLanguage("python")) {
                        languageModule = await import("highlight.js/lib/languages/python");
                    }
                    break;
                }
                case "rust": {
                    fileExt = "rs";
                    lang = "rust";
                    if (!hljs.getLanguage("rust")) {
                        languageModule = await import("highlight.js/lib/languages/rust");
                    }
                    break;
                }
                case "shell": {
                    fileExt = "sh";
                    lang = "shell";
                    if (!hljs.getLanguage("shell")) {
                        languageModule = await import("highlight.js/lib/languages/shell");
                    }
                    break;
                }
                case "ts":
                case "tsx":
                case "typescript": {
                    fileExt = "ts";
                    lang = "typescript";
                    if (!hljs.getLanguage("typescript")) {
                        languageModule = await import("highlight.js/lib/languages/typescript");
                    }
                    break;
                }
                case "txt":
                case "vtt": {
                    fileExt = lang;
                    lang = "plaintext";
                    if (!hljs.getLanguage("plaintext")) {
                        languageModule = await import("highlight.js/lib/languages/plaintext");
                    }
                    break;
                }
                case "yaml": {
                    fileExt = "yml";
                    lang = "yaml";
                    if (!hljs.getLanguage("yaml")) {
                        languageModule = await import("highlight.js/lib/languages/yaml");
                    }
                    break;
                }
                case "risuerror": {
                    lang = "error";
                    fileExt = "error";
                    break;
                }
                default: {
                    lang = "none";
                    fileExt = "none";
                }
            }
            if (languageModule) {
                hljs.registerLanguage(lang, languageModule.default);
            }
            if (lang === "none") {
                rendered = rendered.replace(placeholder, `<pre><code>${md.utils.escapeHtml(code)}</code></pre>`);
            } else if (lang === "error") {
                rendered = rendered.replace(
                    placeholder,
                    `<div class="risu-error"><h1>${language.error}</h1>${md.utils.escapeHtml(code)}</div>`,
                );
            } else {
                const highlighted = hljs.highlight(code, {
                    language: lang,
                    ignoreIllegals: true,
                }).value;
                rendered = rendered.replace(
                    placeholder,
                    `<pre class="hljs" x-hl-lang="${fileExt}"><code>${highlighted}</code></pre>`,
                );
            }
        } catch (error) {}
    }

    return rendered;
}

export const assetRegex = /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)}}/gms;

function getAssetSrc(assetArr: string[][], assetPaths: AssetPaths) {
    for (const asset of assetArr) {
        const key = asset[0].toLocaleLowerCase();
        assetPaths[key] ??= {
            srcPaths: [],
            ext: asset[2],
        };
        if (assetPaths[key].ext === asset[2]) {
            assetPaths[key].srcPaths.push(asset[1]);
        }
    }
}

function getEmoSrc(emoArr: string[][], emoPaths: AssetPaths) {
    for (const emo of emoArr) {
        emoPaths[emo[0].toLocaleLowerCase()] = {
            srcPaths: [emo[1]],
        };
    }
}

const fileSrcCache = new Map<string, string>();

async function getFileSrcCached(path: string) {
    let cached = fileSrcCache.get(path);
    if (cached) {
        return cached;
    }
    const src = await getFileSrc(path);
    fileSrcCache.set(path, src);
    return src;
}

type AssetPaths = {
    [key: string]: {
        srcPaths: string[];
        ext?: string;
    };
};

let assetsCache: AssetPaths | null = null;
let emoAssetsCache: AssetPaths | null = null;

/** A character asset prepared for `getClosestMatch`: its lower-cased name and `trimmer` of it. */
type FuzzyAsset = { trimmed: string; path: string; ext: string };
/** The closest asset to one trimmed reference and its distance; null when there is no asset. */
type FuzzyMatch = { path: string; ext: string; dist: number } | null;
type FuzzyIndex = {
    assets: FuzzyAsset[];
    /** Trimmed name -> the first asset with it: a distance-0 match without the scan. */
    exact: Map<string, FuzzyAsset>;
    /** Trimmed reference -> its closest asset, hits and misses alike (the threshold applies at read). */
    results: Map<string, FuzzyMatch>;
};

/** `getClosestMatch`'s index of one asset list, built again when the list or an asset in it changes. */
class FuzzyIndexSource {
    #assets: [string, string, string][];
    readonly index: FuzzyIndex = $derived.by(() => buildFuzzyIndex(this.#assets));

    constructor(assets: [string, string, string][]) {
        this.#assets = assets;
    }
}

/**
 * The index source per character record's asset list (the list keeps its wrapper). The module root
 * below creates each one: a derived stops updating once the effect it was created in is destroyed,
 * and it keeps the component context it was created in, so a rendering message must not own it.
 */
const fuzzyIndexes = new WeakMap<object, FuzzyIndexSource>();
/** Lists a lookup found without a source, with the index it built meanwhile (untracked). */
let pendingFuzzyLists = new Map<object, FuzzyIndex>();
let pendingFuzzyVersion = $state(0);
/** Bumped once the pending lists have their sources; a lookup that found none reads it. */
let fuzzySourcesVersion = $state(0);
/** Clears a list's cached results past this many distinct references. */
const FUZZY_RESULT_LIMIT = 10000;

$effect.root(() => {
    $effect(() => {
        pendingFuzzyVersion;
        untrack(() => {
            if (pendingFuzzyLists.size === 0) {
                return;
            }
            for (const assets of pendingFuzzyLists.keys()) {
                if (!fuzzyIndexes.has(assets)) {
                    fuzzyIndexes.set(assets, new FuzzyIndexSource(assets as [string, string, string][]));
                }
            }
            pendingFuzzyLists = new Map();
            fuzzySourcesVersion++;
        });
    });
});

export function resetAssetsCache(charAssets: string[][], emoAssets: string[][], moduleAssets: string[][]) {
    const assetPaths: AssetPaths = {};
    const charEmoPaths: AssetPaths = {};

    getAssetSrc(charAssets, assetPaths);
    getAssetSrc(moduleAssets, assetPaths);
    getEmoSrc(emoAssets, charEmoPaths);

    assetsCache = assetPaths;
    emoAssetsCache = charEmoPaths;
}

$effect.root(() => {
    $effect(() => {
        const char = selectedCharacter();
        if (!char || char.type !== "character") {
            return;
        }

        const charAssets = char.additionalAssets ?? [];
        const emoAssets = char.emotionImages ?? [];
        const moduleAssets = getModuleAssets();

        resetAssetsCache(charAssets, emoAssets, moduleAssets);
    });
});

const imageCBS = ["img", "image", "emotion", "asset", "bg", "raw", "path"];
const videoExtensions = ["mp4", "webm", "avi", "m4p", "m4v"];

async function parseAdditionalAssets(
    data: string,
    char: simpleCharacterArgument | character | AnyClientCharacter,
    mode: "normal" | "back",
    /** `chatRef`: the chat the render captured (its persona's icon), else the selected chat's. */
    arg: { ch: number; chatRef?: ChatRef | null },
) {
    // Read before the first await (the selected chat can change meanwhile), untracked as the read
    // after the awaits was: a render must not rerun on a persona change elsewhere.
    const userIcon = untrack(() => getUserIcon(arg.chatRef));
    const assetWidthString =
        (settings.ui.assetWidth && settings.ui.assetWidth !== -1) || settings.ui.assetWidth === 0
            ? `max-width:${settings.ui.assetWidth}rem;`
            : "";

    if (char.type === "character" && (!assetsCache || !emoAssetsCache)) {
        resetAssetsCache(char.additionalAssets ?? [], char.emotionImages, getModuleAssets());
    }

    const assetPaths = assetsCache ?? {};
    const emoPaths = emoAssetsCache ?? {};

    let needsSourceAccess = false;
    let cx: number | null = null;

    data = await replaceAsync(data, assetRegex, async (full: string, type: string, name: string) => {
        name = name.toLocaleLowerCase();

        // Skip image-related assets when hideAllImages is enabled
        // raw and path are also included as they're used in CSS background-image
        if (settings.ui.hideAllImages && imageCBS.includes(type)) {
            return ""; // Hide the image asset
        }

        if (type === "emotion") {
            const srcPath = emoPaths?.[name]?.srcPaths?.[0];
            const path = srcPath ? await getFileSrcCached(srcPath) : null;
            if (!path) {
                return "";
            }
            return `<img src="${path}" alt="${path}" style="${assetWidthString} "/>`;
        }

        if (type === "source") {
            needsSourceAccess = true;
            switch (name) {
                case "char": {
                    return "\uE9b4CHAR\uE9b4";
                }
                case "user": {
                    return "\uE9b4USER\uE9b4";
                }
            }
        }

        let match = assetPaths?.[name];

        if (!match) {
            if (settings.ui.legacyMediaFindings) {
                return "";
            }

            match = getClosestMatch(char, name);

            if (!match) {
                return "";
            }
        }

        let pSrc = match.srcPaths[0];

        if (match.srcPaths.length > 1) {
            if (cx === null) {
                const chatID = arg.ch;
                cx = pickHashRand(chatID, (char.chaId || "global") + chatID);
            }
            const selIndex = Math.floor(cx * match.srcPaths.length);
            pSrc = match.srcPaths[selIndex];
        }

        const p = await getFileSrcCached(pSrc);
        switch (type) {
            case "raw":
            case "path":
                return p;
            case "img":
                return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>`;
            case "image":
                return `<div class="risu-inlay-image"><img src="${p}" alt="${p}" style="${assetWidthString}"/></div>\n`;
            case "video":
                return `<video controls autoplay loop><source src="${p}" type="video/mp4"></video>\n`;
            case "video-img":
                return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`;
            case "audio":
                return `<audio controls autoplay loop><source src="${p}" type="audio/mpeg"></audio>\n`;
            case "bg":
                if (mode === "back") {
                    return `<div style="width:100%;height:100%;background: linear-gradient(rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.8)),url(${p}); background-size: cover;"></div>`;
                }
                break;
            case "asset": {
                if (match.ext && videoExtensions.includes(match.ext)) {
                    return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`;
                }
                return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>\n`;
            }
            case "bgm":
                return `<div risu-ctrl="bgm___auto___${p}" style="display:none;"></div>\n`;
        }
        return "";
    });

    if (needsSourceAccess) {
        const chara = selectedCharacter();
        if (chara.image) {
        }
        data = data.replace(/\uE9b4CHAR\uE9b4/g, chara.image ? await getFileSrc(chara.image) : "");

        data = data.replace(/\uE9b4USER\uE9b4/g, userIcon ? await getFileSrc(userIcon) : "");
    }

    return data;
}

/**
 * The character asset closest to `name` (lower-cased) by `getDistance` of the trimmed names, the
 * first one on a tie; null past `assetMaxDifference`. The result per trimmed name, a miss included,
 * is cached on the asset list's index, which a change of the list replaces (and a render that read
 * it reruns).
 */
function getClosestMatch(
    char: simpleCharacterArgument | character | AnyClientCharacter,
    name: string,
): AssetPaths[string] | null {
    const assets = char.additionalAssets;
    if (!assets) return null;

    const index = fuzzyIndexOf(assets);
    const trimmedName = trimmer(name);
    let best = index.results.get(trimmedName);
    if (best === undefined) {
        best = closestAsset(index, trimmedName);
        if (index.results.size >= FUZZY_RESULT_LIMIT) {
            index.results.clear();
        }
        index.results.set(trimmedName, best);
    }

    if (!best || best.dist > settings.ui.assetMaxDifference) {
        return null;
    }
    return { srcPaths: [best.path], ext: best.ext };
}

/**
 * A record list's index: its source's, else (until the module root creates the source) one built
 * untracked, with a dependency that reruns the render once the source exists. Any other list is
 * built per lookup, tracked (a `$state` array's edit reruns the render).
 */
function fuzzyIndexOf(assets: [string, string, string][]): FuzzyIndex {
    if (!isRecordWrapper(assets)) {
        return buildFuzzyIndex(assets);
    }
    const source = fuzzyIndexes.get(assets);
    if (source) {
        return source.index;
    }
    fuzzySourcesVersion;
    let index = pendingFuzzyLists.get(assets);
    if (!index) {
        index = untrack(() => buildFuzzyIndex(assets));
        if (pendingFuzzyLists.size === 0) {
            // Not from here: a lookup runs inside a render's derived, which must not write state.
            queueMicrotask(() => pendingFuzzyVersion++);
        }
        pendingFuzzyLists.set(assets, index);
    }
    return index;
}

function buildFuzzyIndex(assets: [string, string, string][]): FuzzyIndex {
    const index: FuzzyIndex = { assets: [], exact: new Map(), results: new Map() };
    for (const asset of assets) {
        const entry: FuzzyAsset = { trimmed: trimmer(asset[0].toLocaleLowerCase()), path: asset[1], ext: asset[2] };
        index.assets.push(entry);
        if (!index.exact.has(entry.trimmed)) {
            index.exact.set(entry.trimmed, entry);
        }
    }
    return index;
}

function closestAsset(index: FuzzyIndex, trimmedName: string): FuzzyMatch {
    const exact = index.exact.get(trimmedName);
    if (exact) {
        return { path: exact.path, ext: exact.ext, dist: 0 };
    }
    let best: FuzzyMatch = null;
    for (const asset of index.assets) {
        const dist = getDistance(trimmedName, asset.trimmed);
        if (!best || dist < best.dist) {
            best = { path: asset.path, ext: asset.ext, dist };
        }
    }
    return best;
}

//Levenshtein distance, new with 1d array
export function getDistance(a: string, b: string) {
    const h = a.length + 1;
    const w = b.length + 1;
    let d = new Int16Array(h * w);
    for (let i = 0; i < h; i++) {
        d[i * w] = i;
    }
    for (let i = 0; i < w; i++) {
        d[i] = i;
    }
    for (let i = 1; i < h; i++) {
        for (let j = 1; j < w; j++) {
            d[i * w + j] = Math.min(
                d[(i - 1) * w + j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1),
                d[(i - 1) * w + j] + 1,
                d[i * w + j - 1] + 1,
            );
        }
    }
    return d[h * w - 1];
}

function trimmer(str: string) {
    const ext = ["webp", "png", "jpg", "jpeg", "gif", "mp4", "webm", "avi", "m4p", "m4v", "mp3", "wav", "ogg"];
    for (const e of ext) {
        if (str.endsWith("." + e)) {
            str = str.substring(0, str.length - e.length - 1);
        }
    }

    return str.trim().replace(/[_ -.]/g, "");
}

async function parseInlayAssets(data: string) {
    const inlayMatch = data.match(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g);
    if (inlayMatch) {
        for (const inlay of inlayMatch) {
            const inlayType = inlay.startsWith("{{inlayed") ? "inlayed" : "inlay";
            const id = inlay.substring(inlay.indexOf("::") + 2, inlay.length - 2);
            let prefix = inlayType !== "inlay" ? `<div class="risu-inlay-image">` : "";
            let postfix = inlayType !== "inlay" ? `</div>\n\n` : "";

            // URLs that stay the same on every render and are never revoked, so a cached render or
            // translation never holds a dead one: images through the asset URL path (service worker),
            // audio and video as typed object URLs per asset key.
            const media = await getInlayMedia(id);
            const url = !media
                ? ""
                : media.type === "image"
                  ? await getFileSrc(media.asset)
                  : ((await getInlayObjectUrl(id)) ?? "");
            if (!url) {
                continue;
            }
            switch (media.type) {
                case "image":
                    // Hide inlay images when hideAllImages is enabled
                    if (settings.ui.hideAllImages) {
                        data = data.replace(inlay, "");
                        break;
                    }
                    data = data.replace(inlay, `${prefix}<img src="${url}"/>${postfix}`);
                    break;
                case "video":
                    data = data.replace(
                        inlay,
                        `${prefix}<video controls><source src="${url}" type="video/mp4"></video>${postfix}`,
                    );
                    break;
                case "audio":
                    data = data.replace(
                        inlay,
                        `${prefix}<audio controls><source src="${url}" type="audio/mpeg"></audio>${postfix}`,
                    );
                    break;
            }
        }
    }
    return data;
}

export interface simpleCharacterArgument {
    type: "simple";
    additionalAssets?: [string, string, string][];
    customscript: customscript[];
    chaId: string;
    emotionImages?: [string, string][];
    triggerscript?: triggerscript[];
}

function parseThoughtsAndTools(data: string) {
    let result = "",
        i = 0;
    while (i < data.length) {
        if (data.slice(i, i + 10) === "<Thoughts>") {
            let j = i + 10,
                depth = 1;
            while (j < data.length && depth > 0) {
                if (data.slice(j, j + 10) === "<Thoughts>") depth++;
                if (data.slice(j, j + 11) === "</Thoughts>") depth--;
                j++;
            }
            if (depth === 0) {
                result += `<details><summary>${language.cot}</summary>${data.substring(i + 10, j - 1)}</details>`;
                i = j + 10;
                continue;
            }
        }
        result += data[i++];
    }
    return result.replace(/<tool_call>(.+?)<\/tool_call>/gms, (full, txt: string) => {
        return `<div class="x-risu-tool-call">🛠️ ${language.toolCalled.replace("{{tool}}", txt.split("\uf100")?.[1] ?? "unknown")}</div>\n\n`;
    });
}

export async function ParseMarkdown(
    data: string,
    charArg: character | simpleCharacterArgument | groupChat | AnyClientCharacter | string = null,
    mode: "normal" | "back" | "pretranslate" | "notrim" = "normal",
    chatID = -1,
    cbsConditions: CbsConditions = {},
    /** A render that captured its transform context earlier (`ChatBody`); null: no context (the script stage is skipped). */
    capturedTransform?: CapturedTransform | null,
) {
    let firstParsed = "";
    const additionalAssetMode = mode === "back" ? "back" : "normal";
    let char = typeof charArg === "string" ? findCharacterbyId(charArg) : charArg;
    // The server transform's context: the caller's, or captured before the first await.
    const transform = char ? (capturedTransform === undefined ? captureTransform(chatID) : capturedTransform) : null;
    // The chat this render is for, also when the server path does not apply (no transform).
    const renderRef = transform?.chatRef ?? untrack(() => currentChatRef());

    if (char && char.type !== "group") {
        data = await parseAdditionalAssets(data, char, additionalAssetMode, {
            ch: chatID,
            chatRef: renderRef,
        });
        firstParsed = data;
    }

    // Without a context the script stage is skipped (Phase 5 cutover): the text stays as it is.
    if (char && transform) {
        data = (
            await serverProcessScript(
                char,
                data,
                "editdisplay",
                chatID,
                cbsConditions,
                transform,
                mode === "back" ? "background" : "message",
            )
        ).data;
    }

    if (firstParsed !== data && char && char.type !== "group") {
        data = await parseAdditionalAssets(data, char, additionalAssetMode, {
            ch: chatID,
            chatRef: renderRef,
        });
    }

    data = await parseInlayAssets(data ?? "");

    data = parseThoughtsAndTools(data);

    data = encodeStyle(data);
    if (mode === "normal" || mode === "notrim") {
        data = await renderHighlightableMarkdown(data);

        if (mode === "notrim") {
            return data;
        }
    }
    return trimMarkdown(data);
}

const trimPurifyConfig = {
    ADD_TAGS: [
        "iframe",
        "style",
        "risu-style",
        "x-em",
        "annotation",
        "semantics",
        "mrow",
        "mi",
        "mo",
        "mn",
        "msup",
        "msub",
        "mfrac",
        "msqrt",
    ],
    ADD_ATTR: [
        "allow",
        "allowfullscreen",
        "frameborder",
        "scrolling",
        "risu-ctrl",
        "risu-btn",
        "risu-trigger",
        "risu-mark",
        "risu-id",
        "x-hl-lang",
        "x-hl-text",
    ],
};

export function trimMarkdown(data: string) {
    if (!data) {
        return "";
    }

    // Without a <risu-style> there is nothing to decode, so the plain string
    // result is already final. Note the tag itself is not trusted input:
    // risu-style is in ADD_TAGS, so cards, model output and user scripts can
    // author one directly. Only its position in the parsed tree is relied on.
    if (!data.includes("<risu-style")) {
        return DOMPurify.sanitize(data, trimPurifyConfig);
    }

    // Decoded CSS must never be handed back to the HTML sanitizer as <style>
    // text: DOMPurify drops style nodes whose CSS contains '<' (SAFE_FOR_XML),
    // which silently deletes svg data-uris and markup-like content strings.
    // Take the DOM out of the sanitize we already run and swap the elements in
    // place instead, so the CSS never re-enters the HTML parser at all.
    // RETURN_DOM hands back the sanitized <body>, typed as Node. It is null only
    // for empty input, which the guard above already excludes.
    const root = DOMPurify.sanitize(data, {
        ...trimPurifyConfig,
        RETURN_DOM: true,
    }) as HTMLElement | null;
    if (!root) {
        return "";
    }

    // Only real <risu-style> elements are decoded. A <risu-style> that survived
    // inside an attribute value is not an element, so it is left as inert text
    // and a <style> tag can never be restored into an attribute context.
    for (const el of Array.from(root.querySelectorAll("risu-style"))) {
        const decoded = decodeStyleContent(el.textContent ?? "");
        if (decoded.css === undefined) {
            el.replaceWith(root.ownerDocument.createTextNode(decoded.fallback ?? ""));
            continue;
        }
        const style = root.ownerDocument.createElement("style");
        // <style> is RAWTEXT, so '</style' is the only sequence that can end the
        // block early and leak the rest of the CSS as markup once this string is
        // parsed again ('\/' is still '/' inside CSS).
        style.textContent = decoded.css.replaceAll(/<\/(?=style)/gi, "<\\/");
        el.replaceWith(style);
    }

    return root.innerHTML;
}

const metaCodes = [
    "\u200B", //zero width space
    "\u200C", //zero width non-joiner
    "\u200D", //zero width joiner
    "\uFEFF", //zero width no-break space
    "\u2060", //word joiner
    "\u180E", //mongolian vowel separator
];

const encodedMetadataCache = new Map<string, string>();

function encodeMetadata(modelShortName: string) {
    const metadata = "{" + ["risuai", modelShortName.toLocaleLowerCase().replace(/[^a-z]/g, "")].join("|") + "}";

    const cached = encodedMetadataCache.get(metadata);
    if (cached !== undefined) {
        return cached;
    }

    let encodedMetaCode = "";
    for (let i = 0; i < metadata.length; i++) {
        let byte = (metadata.charCodeAt(i) - 97).toString(6).padStart(2, "0");
        for (let j = 0; j < byte.length; j++) {
            switch (byte.charAt(j)) {
                case "0": {
                    encodedMetaCode += metaCodes[0];
                    break;
                }
                case "1": {
                    encodedMetaCode += metaCodes[1];
                    break;
                }
                case "2": {
                    encodedMetaCode += metaCodes[2];
                    break;
                }
                case "3": {
                    encodedMetaCode += metaCodes[3];
                    break;
                }
                case "4": {
                    encodedMetaCode += metaCodes[4];
                    break;
                }
                case "5": {
                    encodedMetaCode += metaCodes[5];
                    break;
                }
            }
        }
    }

    encodedMetadataCache.set(metadata, encodedMetaCode);
    return encodedMetaCode;
}

export function addMetadataToElement(data: string, modelShortName: string) {
    if (!aiWatermarkingLawApplies()) {
        return data;
    }

    const encodedMetaCode = encodeMetadata(modelShortName);
    console.log("Encoded metadata:", encodedMetaCode.length, "characters");
    console.log("This requires at least", Math.ceil(encodedMetaCode.length / 32), "<p> tags to store");

    let d = data.replace(/\<p\>/g, (v) => {
        return "<p>" + encodedMetaCode;
    });

    return d + encodedMetaCode;
}

export async function postTranslationParse(data: string) {
    let lines = data.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const trimed = lines[i].trim();
        if (trimed.startsWith("<")) {
            lines[i] = trimed;
        }
    }

    data = await renderHighlightableMarkdown(lines.join("\n"));
    return data;
}

export function parseMarkdownSafe(
    data: string,
    arg: {
        forbidTags?: string[];
    } = {},
) {
    return DOMPurify.sanitize(renderMarkdown(md, data), {
        FORBID_TAGS: ["a", "style", ...(arg.forbidTags || [])],
        FORBID_ATTR: ["style", "href", "class"],
    });
}

const styleRegex = /\<style\>(.+?)\<\/style\>/gms;
function encodeStyle(txt: string) {
    return txt.replaceAll(styleRegex, (f, c1) => {
        return "<risu-style>" + Buffer.from(c1).toString("hex") + "</risu-style>";
    });
}

function decodeStyleRule(rule: CssAtRuleAST) {
    if (rule.type === "rule") {
        if (rule.selectors) {
            for (let i = 0; i < rule.selectors.length; i++) {
                let slt: string = rule.selectors[i];
                if (slt) {
                    const parser = cssSelectorParser((root) => {
                        root.walkClasses((classes) => {
                            if (classes.type === "class" && !classes.value.startsWith("x-risu-")) {
                                classes.value = "x-risu-" + classes.value;
                            }
                        });
                    });

                    slt = parser.processSync(slt);

                    rule.selectors[i] = ".chattext " + slt;
                }
            }
        }
    }
    if (
        rule.type === "media" ||
        rule.type === "supports" ||
        rule.type === "document" ||
        rule.type === "host" ||
        rule.type === "container"
    ) {
        for (let i = 0; i < rule.rules.length; i++) {
            rule.rules[i] = decodeStyleRule(rule.rules[i]);
        }
    }
    if (rule.type === "import") {
        if (rule.import.startsWith("data:")) {
            rule.import = "data:,";
        }
    }
    return rule;
}

/**
 * Decodes one <risu-style> body into scoped CSS. Returns the CSS on its own so
 * the caller can put it into a real <style> element instead of a markup string.
 * On a CSS parse error the style is dropped and `fallback` holds the text that
 * takes its place.
 */
function decodeStyleContent(hexText: string): { css?: string; fallback?: string } {
    try {
        let text = Buffer.from(hexText, "hex").toString("utf-8");
        text = risuChatParser(text);
        const ast = css.parse(text);
        const rules = ast?.stylesheet?.rules;
        if (rules) {
            for (let i = 0; i < rules.length; i++) {
                rules[i] = decodeStyleRule(rules[i]);
            }
            ast.stylesheet.rules = rules;
        }
        return {
            css: css.stringify(ast, {
                indent: "",
                compress: true,
            }),
        };
    } catch (error) {
        if (settings.ui.returnCSSError) {
            return { fallback: `CSS ERROR: ${error}` };
        }
        return { fallback: "" };
    }
}

export async function hasher(data: Uint8Array) {
    return Buffer.from(await crypto.subtle.digest("SHA-256", data as any)).toString("hex");
}

export type { CbsConditions };

// The evaluator and the registry moved to `shared/cbs/` (Phase 5), so the server runs the same
// code; the client supplies its host here.
let cbsEvaluator: CbsEvaluator | null = null;

function clientCbsEvaluator(): CbsEvaluator {
    cbsEvaluator ??= createCbsEvaluator(clientCbsHost());
    return cbsEvaluator;
}

/** The settings shared CBS reads (`CbsDatabase`), by their root names. */
const CBS_SETTING_KEYS = [
    "aiModel",
    "subModel",
    "maxContext",
    "promptTemplate",
    "mainPrompt",
    "jailbreak",
    "jailbreakToggle",
    "globalNote",
    "language",
] as const satisfies readonly (keyof CbsDatabase)[];

/**
 * The tab's CBS database (Phase 6 slice 10): getters over the records, read when the evaluator reads
 * them. Each setting reads its view by root name (`readSettingsRoot`: a preset field from the selected
 * preset, else its section), or, with `presetField`, a preset field from that function. `characters`
 * is the character list, whose wrappers carry the chat module's compatibility `chats`/`chatPage`
 * view (`setCharacterChatView`), the shape shared CBS reads; the client type has no chats, hence
 * the cast. `maxContext` is the main model's effective size, the prompt preset's override applied
 * as the server's job database has it (`forwardPresetRoots`); the settings root stays the profile's.
 */
function cbsDatabase(presetField?: (rootKey: string) => unknown): CbsDatabase {
    const read = (key: SettingsRootKey) =>
        presetField !== undefined && isForwardedPresetRoot(key) ? presetField(key) : readSettingsRoot(key);
    const view = {};
    for (const key of CBS_SETTING_KEYS) {
        Object.defineProperty(view, key, {
            enumerable: true,
            get:
                key === "maxContext"
                    ? () =>
                          maxContextOverrideOf({
                              maxContextOverride: read("maxContextOverride"),
                              maxContextOverrideSize: read("maxContextOverrideSize"),
                          }) ?? read(key)
                    : () => read(key),
        });
    }
    Object.defineProperty(view, "characters", {
        enumerable: true,
        get: () => characterList() as unknown as CbsDatabase["characters"],
    });
    return Object.freeze(view) as CbsDatabase;
}

const tabCbsDatabase = cbsDatabase();

function clientCbsHost(): CbsHost {
    return {
        getDatabase: () => tabCbsDatabase,
        getUserName: getUserName,
        getPersonaPrompt: getPersonaPrompt,
        safeStructuredClone: safeStructuredClone,
        // A parse with a `chatRef` reads and writes that chat's variables, not the selected chat's.
        getChatVar: (key, chatRef) => (chatRef ? getChatVarOf(chatRef, key) : getChatVar(key)),
        setChatVar: (key, value, chatRef) => {
            if (chatRef) {
                setChatVarOf(chatRef, key, value);
            } else {
                setChatVar(key, value);
            }
        },
        getGlobalChatVar: (key, chatRef) => (chatRef ? getGlobalChatVarOf(chatRef, key) : getGlobalChatVar(key)),
        calcString: calcString,
        getModules: getModules,
        getModuleLorebooks: getModuleLorebooks,
        pickHashRand: pickHashRand,
        // Untracked, as the index store it replaces was: a parse inside a `$derived` does not rerun on a selection.
        getSelectedCharID: () => untrack(() => selectedIndex()),
        getModelInfo: getModelInfo,
        callInternalFunction: function (args: string[]): string {
            return "";
        },
        isMobile: false,
        appVer: appVer,
        getTriggerId: () => get(CurrentTriggerIdStore),
        getViewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
        getBrowserLanguage: () => navigator.language,
        // The shared evaluator reads the legacy shape (its chats) until `aggregate-removal`.
        findCharacterById: (id) => withCompatChats(findCharacterbyId(id)) as character,
    };
}

/** `CbsParseArg` as the client passes it: `chara` may be a chat-free client character (Phase 6 slice 9a). */
export type ClientCbsParseArg = Omit<CbsParseArg, "chara"> & {
    chara?: CbsParseArg["chara"] | AnyClientCharacter | null;
};

/** The argument the shared evaluator gets: a character in the legacy shape it reads (`withCompatChats`). */
function sharedParseArg(arg: ClientCbsParseArg): CbsParseArg {
    if (!arg.chara || typeof arg.chara !== "object") {
        return arg as CbsParseArg;
    }
    return { ...arg, chara: withCompatChats(arg.chara) as character | groupChat };
}

/**
 * Parses CBS for the tab. A parse for a chat (`arg.chatRef`) reads that chat's display ids
 * (`chatDisplayIds`: each bound record that exists, else the tab's selection) for its preset fields
 * and persona, not the settings views, which follow the selected chat (`docs/plan/chat-binding.md`,
 * slice 4): a caller that captured its chat before an await parses for that chat.
 */
export function risuChatParser(da: string, arg: ClientCbsParseArg = {}): string {
    if (arg.chatRef) {
        const ids = chatDisplayIds(arg.chatRef);
        if (ids.presetId && ids.modelPresetId && ids.personaId) {
            return risuChatParserScoped(da, arg, ids);
        }
    }
    return clientCbsEvaluator().risuChatParser(da, sharedParseArg(arg));
}

const scopedEvaluators = new Map<string, CbsEvaluator>();

/**
 * `risuChatParser` for a frozen plugin call context (Phase 4's hook context; Phase 5 slice 7a): the
 * preset fields read the context's prompt or model preset (whichever owns the field), as do the
 * preset-owned variable defaults and module integration, and `{{user}}` and the persona prompt read
 * the context's persona (the effective one when the context was taken: the chat's bound persona,
 * else the selected one), instead of the settings views at parse time. Everything else is the
 * tab's, as `risuChatParser` reads it. A context preset, model preset, or persona that no longer exists fails the parse
 * (`PluginTargetGoneError`), as a hook's other target-bound calls do.
 */
export function risuChatParserScoped(
    da: string,
    arg: ClientCbsParseArg,
    scope: { presetId: string; modelPresetId: string; personaId: string },
): string {
    // Every captured id is part of the key: the cached evaluator closes over its scope.
    const key = JSON.stringify([scope.presetId, scope.modelPresetId, scope.personaId]);
    let evaluator = scopedEvaluators.get(key);
    if (!evaluator) {
        const base = clientCbsHost();
        const personaOf = () => {
            const persona = settings.personas?.find((entry) => entry?.id === scope.personaId);
            if (!persona) {
                throw new PluginTargetGoneError("persona");
            }
            return persona;
        };
        const recordOf = (list: unknown, id: string, target: string) => {
            const record = (list as Record<string, unknown>[] | undefined)?.find((entry) => entry?.id === id);
            if (!record) {
                throw new PluginTargetGoneError(target);
            }
            return record;
        };
        // Every target is checked on every parse, before any text is evaluated (a gone one fails the
        // parse); the preset fields then read the context's owning preset as it is now. `{{user}}` and
        // the persona prompt come from the host functions below, not from the database.
        const scopedDb = () => {
            recordOf(settings.presets, scope.presetId, "preset");
            recordOf(settings.modelPresets, scope.modelPresetId, "model preset");
            personaOf();
            return cbsDatabase((rootKey) => scopedPresetRoot(scope, rootKey as SettingsRootKey));
        };
        evaluator = createCbsEvaluator({
            ...base,
            getDatabase: scopedDb,
            // The preset-owned reads (variable defaults, module integration) are the scope's too;
            // stored chat variables stay the parse's chat's.
            getChatVar: (key, chatRef) => (chatRef ? getChatVarOf(chatRef, key, scope) : getChatVar(key, scope)),
            getModules: (chatRef) => getModules(chatRef, scope),
            getModuleLorebooks: (chatRef) => getModuleLorebooks(chatRef, scope),
            getModelInfo: (id) => getModelInfo(id, scope),
            getUserName: () => personaOf().name,
            getPersonaPrompt: () => personaOf().personaPrompt,
        });
        if (scopedEvaluators.size >= 16) {
            scopedEvaluators.delete(scopedEvaluators.keys().next().value!);
        }
        scopedEvaluators.set(key, evaluator);
    }
    return evaluator.risuChatParser(da, sharedParseArg(arg));
}

export function applyMarkdownToNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text) {
            let markdown = renderMarkdown(md, text);
            if (markdown !== text) {
                const span = document.createElement("span");
                span.innerHTML = markdown;

                // inherit inline style from the parent node
                const parentStyle = (node.parentNode as HTMLElement)?.style;
                if (parentStyle) {
                    for (let i = 0; i < parentStyle.length; i++) {
                        span.style.setProperty(parentStyle[i], parentStyle.getPropertyValue(parentStyle[i]));
                    }
                }
                (node as Element)?.replaceWith(span);
                return;
            }
        }
    } else {
        for (const child of node.childNodes) {
            applyMarkdownToNode(child);
        }
    }
}
